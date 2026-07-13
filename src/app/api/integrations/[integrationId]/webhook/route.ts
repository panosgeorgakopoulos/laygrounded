import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getAdapter } from "@/lib/integrations/registry";
import { upsertVoyageClaim } from "@/lib/integrations/sync";
import { IntegrationRow } from "@/lib/integrations/types";
import { logStructured, newTraceId } from "@/lib/observability/log";

// Inbound ERP webhook receiver.
//
// Public endpoint (the ERP has no Supabase session), authenticated by the
// integration's HMAC webhook secret over the raw body, idempotent via the
// unique (integration, direction, key) index on webhook_logs:
//   1st delivery  → row inserted, event processed
//   redelivery    → unique violation → 200 {status: "skipped_duplicate"}
// Always 2xx on duplicates so well-behaved ERPs stop retrying.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ integrationId: string }> }
) {
  const { integrationId } = await params;
  const supabase = createServiceRoleClient();

  const { data: integration } = await supabase
    .from("integrations")
    .select("*")
    .eq("id", integrationId)
    .maybeSingle();
  // Unknown id and bad signature return the same 404 — don't confirm which.
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

  const event = adapter.parseInboundEvent(payload);
  if (!event.eventId) {
    return NextResponse.json({ error: "MISSING_EVENT_ID" }, { status: 400 });
  }

  // Idempotency gate: the insert IS the lock.
  const { data: log, error: insertErr } = await supabase
    .from("webhook_logs")
    .insert({
      integration_id: integrationId,
      direction: "inbound",
      event_type: event.type,
      idempotency_key: event.eventId,
      payload,
    })
    .select("id")
    .maybeSingle();

  if (insertErr) {
    if (insertErr.code === "23505") {
      return NextResponse.json({ status: "skipped_duplicate" });
    }
    logStructured("error", "erp-webhook", `idempotency ledger insert failed: ${insertErr.message}`, {
      trace_id: newTraceId(),
      integration_id: integrationId,
      event_type: event.type,
      idempotency_key: event.eventId,
      user_action_required:
        "webhook_logs insert failed for a non-duplicate reason — check database availability/constraints; the event was NOT processed.",
      retry_strategy: "ERP receives 500 and will redeliver; no ledger row was written, so the retry is clean.",
    });
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }

  try {
    let claimId: string | null = null;
    if ((event.type === "voyage.created" || event.type === "voyage.updated") && event.voyage) {
      claimId = await upsertVoyageClaim(supabase, integration as IntegrationRow, event.voyage);
    }
    await supabase
      .from("webhook_logs")
      .update({ status: "processed", processed_at: new Date().toISOString() })
      .eq("id", log!.id);
    return NextResponse.json({ status: "processed", claimId });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await supabase
      .from("webhook_logs")
      .update({ status: "failed", error: message.slice(0, 1000) })
      .eq("id", log!.id);
    logStructured("error", "erp-webhook", `inbound event processing failed: ${message}`, {
      trace_id: newTraceId(),
      integration_id: integrationId,
      event_type: event.type,
      idempotency_key: event.eventId,
      user_action_required:
        "If the ERP's redelivery also fails, inspect the voyage payload for schema drift against the adapter's parseInboundEvent mapping.",
      retry_strategy:
        "ERP receives 500 and will redeliver; the failed ledger row is deleted so the retry re-enters cleanly.",
    });
    // 500 → the ERP retries; the retry dedupes against this failed row only
    // if we delete it, so clear the key for a clean retry.
    await supabase.from("webhook_logs").delete().eq("id", log!.id);
    return NextResponse.json({ error: "PROCESSING_FAILED" }, { status: 500 });
  }
}
