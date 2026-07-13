import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getAdapter } from "@/lib/integrations/registry";
import { IntegrationRow } from "@/lib/integrations/types";
import { recomputeLaytimeServerFn } from "@/lib/laytime/recompute-server";
import { DEFAULT_CP_TERMS } from "@/lib/laytime/types";
import { TelemetryBatchSchema, telemetryToSofEventRows } from "@/lib/api/plg";

// Machine-to-machine telemetry ingest: permissioned IoT feeds (smart gantry
// cranes, autonomous vessel stacks) write timeline events directly, without
// a human-authored Statement of Facts.
//
// Trust model mirrors the ERP webhook receiver exactly:
//   * public endpoint, authenticated by the integration's HMAC secret over
//     the raw body (unknown id and bad signature both return 404);
//   * idempotent per delivery via the webhook_logs unique key — a batch_id
//     redelivery returns skipped_duplicate (readings inside a NEW batch are
//     at-least-once: senders must not re-batch old readings under new ids);
//   * claims resolve by (company_id, external_source='m2m', external_ref),
//     the same upsert identity that stops concurrent deliveries forking a
//     voyage into two claims.
export async function POST(req: NextRequest) {
  const supabase = createServiceRoleClient();

  const integrationId = req.headers.get("x-integration-id") ?? "";
  const { data: integration } = integrationId
    ? await supabase.from("integrations").select("*").eq("id", integrationId).maybeSingle()
    : { data: null };
  if (!integration || integration.status !== "active") {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const adapter = getAdapter(integration as IntegrationRow);
  const rawBody = await req.text();
  const signature =
    req.headers.get("x-laygrounded-signature") ?? req.headers.get("x-signature");
  if (!adapter.verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = TelemetryBatchSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const batch = parsed.data;

  // Idempotency gate: the insert IS the lock.
  const { data: log, error: insertErr } = await supabase
    .from("webhook_logs")
    .insert({
      integration_id: integration.id,
      direction: "inbound",
      event_type: "m2m.telemetry",
      idempotency_key: `m2m:${batch.batch_id}`,
      payload,
    })
    .select("id")
    .maybeSingle();
  if (insertErr) {
    if (insertErr.code === "23505") {
      return NextResponse.json({ status: "skipped_duplicate" });
    }
    console.error("[v1/m2m/telemetry] idempotency ledger insert failed", insertErr);
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }

  try {
    // Resolve-or-create the claim on its M2M identity.
    let { data: claim } = await supabase
      .from("claims")
      .select("id")
      .eq("company_id", integration.company_id)
      .eq("external_source", "m2m")
      .eq("external_ref", batch.external_ref)
      .maybeSingle();
    if (!claim) {
      const { data: created, error: createErr } = await supabase
        .from("claims")
        .insert({
          company_id: integration.company_id,
          vessel: batch.vessel ?? "TBN",
          voyage_ref: batch.external_ref,
          port: batch.port ?? "TBC",
          cargo: "TBC",
          cp_form: "GENCON94",
          cp_terms: DEFAULT_CP_TERMS,
          status: "draft",
          external_source: "m2m",
          external_ref: batch.external_ref,
        })
        .select("id")
        .single();
      if (createErr) {
        // Unique-index race with a concurrent delivery: the other one won.
        if (createErr.code !== "23505") throw new Error(createErr.message);
        const { data: winner } = await supabase
          .from("claims")
          .select("id")
          .eq("company_id", integration.company_id)
          .eq("external_source", "m2m")
          .eq("external_ref", batch.external_ref)
          .maybeSingle();
        if (!winner) throw new Error("CLAIM_RESOLUTION_RACE");
        claim = winner;
      } else {
        claim = created;
      }
    }

    // Stub document (same pattern as chain clones): telemetry events need a
    // parent row that lives and dies with the claim.
    let { data: doc } = await supabase
      .from("documents")
      .select("id")
      .eq("claim_id", claim!.id)
      .eq("mime", "m2m")
      .limit(1)
      .maybeSingle();
    if (!doc) {
      const { data: createdDoc, error: docErr } = await supabase
        .from("documents")
        .insert({
          claim_id: claim!.id,
          storage_path: `m2m/${claim!.id}`,
          mime: "m2m",
          original_filename: `M2M telemetry (${integration.name ?? "device feed"})`,
          extraction_status: "extracted",
        })
        .select("id")
        .single();
      if (docErr || !createdDoc) throw new Error(docErr?.message ?? "DOC_CREATE_FAILED");
      doc = createdDoc;
    }

    const rows = telemetryToSofEventRows(claim!.id, doc!.id, batch.readings);
    const { error: eventsErr } = await supabase.from("sof_events").insert(rows);
    if (eventsErr) throw new Error(eventsErr.message);

    // Best-effort recompute: a feed that has not yet delivered NOR/completion
    // simply leaves the claim uncomputed.
    let calcError: string | null = null;
    try {
      await recomputeLaytimeServerFn(claim!.id, supabase);
    } catch (e) {
      calcError = e instanceof Error ? e.message : String(e);
    }

    await supabase
      .from("webhook_logs")
      .update({ status: "processed", processed_at: new Date().toISOString() })
      .eq("id", log!.id);

    return NextResponse.json({
      status: "processed",
      claimId: claim!.id,
      eventsInserted: rows.length,
      calcError,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[v1/m2m/telemetry] processing failed", e);
    // Delete the ledger row so the sender's retry re-enters cleanly.
    await supabase.from("webhook_logs").delete().eq("id", log!.id);
    return NextResponse.json({ error: "PROCESSING_FAILED", detail: message.slice(0, 200) }, { status: 500 });
  }
}
