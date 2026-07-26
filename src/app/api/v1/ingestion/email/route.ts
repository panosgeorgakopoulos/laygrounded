import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { extractSofTimeline } from "@/lib/ingestion/multimodal";
import { DEFAULT_CP_TERMS } from "@/lib/laytime/types";
import { parseInboundEmail, companyIdFromRecipient } from "@/lib/ingestion/inbound-email";

// Inbound-email SoF gateway (F3 ingestion channel). An email provider's
// inbound-parse webhook (SendGrid / Mailgun / Postmark) POSTs a received SoF
// email here; the deterministic text extractor turns the body into a timeline
// of 'suggested' events on a new claim, routed to the tenant by the plus-
// addressed recipient (sof+<companyId>@…).
//
// Trust model, in order:
//   1. Shared secret (x-ingestion-secret == INGESTION_INBOUND_SECRET). Unset →
//      503: the channel is off, not silently open. Mismatch → 401.
//   2. Recipient carries a real company id.
//   3. Sender is a member of that company — an outside email cannot inject
//      events into someone else's book.
// Events land as 'suggested' (same as every ingestion path): zero-touch entry,
// not zero-touch trust — a human still confirms them in the workspace.
export async function POST(req: NextRequest) {
  try {
    const secret = process.env.INGESTION_INBOUND_SECRET;
    if (!secret) {
      return NextResponse.json(
        { error: "INGESTION_UNAVAILABLE", message: "Inbound email ingestion is not configured." },
        { status: 503 }
      );
    }
    if (req.headers.get("x-ingestion-secret") !== secret) {
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }

    // Providers send either multipart/form-data or JSON — normalise to a record.
    const contentType = req.headers.get("content-type") ?? "";
    let record: Record<string, unknown>;
    if (contentType.includes("multipart/form-data") || contentType.includes("x-www-form-urlencoded")) {
      const form = await req.formData();
      record = Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
    } else {
      record = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    }

    const email = parseInboundEmail(record);
    if (!email) {
      return NextResponse.json(
        { error: "EMAIL_UNPARSEABLE", message: "Could not read a sender and body from the email." },
        { status: 422 }
      );
    }

    const companyId = companyIdFromRecipient(email.recipient);
    if (!companyId) {
      return NextResponse.json(
        { error: "UNROUTABLE", message: "Recipient address carries no company id (expected sof+<companyId>@…)." },
        { status: 422 }
      );
    }

    const supabase = createServiceRoleClient();

    // The sender must be a confirmed member of the target company: resolve the
    // sender's user id, then check membership. An outside email is rejected.
    const { data: senderUserId, error: lookupErr } = await supabase.rpc("get_user_id_by_email", {
      email_addr: email.fromEmail,
    });
    // Distinguish "lookup broke" from "sender is a stranger". Both used to
    // collapse into the 403 below, so a missing RPC silently rejected every
    // inbound message as an outsider instead of reporting a server fault.
    if (lookupErr) {
      console.error("[ingestion/email/POST] sender lookup failed:", lookupErr);
      return NextResponse.json({ error: "SENDER_LOOKUP_FAILED" }, { status: 503 });
    }
    if (!senderUserId) {
      return NextResponse.json(
        { error: "SENDER_NOT_A_MEMBER", message: "Sender has no LayGrounded account." },
        { status: 403 }
      );
    }
    const { data: member } = await supabase
      .from("company_members")
      .select("user_id")
      .eq("company_id", companyId)
      .eq("user_id", senderUserId)
      .maybeSingle();
    if (!member) {
      return NextResponse.json(
        { error: "SENDER_NOT_A_MEMBER", message: "Sender is not a member of the recipient company." },
        { status: 403 }
      );
    }

    const extraction = extractSofTimeline(email.text, {});
    if (extraction.events.length === 0) {
      return NextResponse.json(
        { error: "SOF_UNPARSEABLE", warnings: extraction.warnings },
        { status: 422 }
      );
    }

    // Fresh claim from the email. Vessel/voyage are best-effort from the
    // subject; the operator refines them in the workspace.
    const { data: claim, error: claimErr } = await supabase
      .from("claims")
      .insert({
        company_id: companyId,
        vessel: email.subject.slice(0, 120) || "TBN",
        voyage_ref: `EMAIL-${Date.now()}`,
        port: "TBC",
        cargo: "TBC",
        cp_form: "GENCON94",
        cp_terms: DEFAULT_CP_TERMS,
        status: "draft",
        created_by: senderUserId,
      })
      .select("id")
      .single();
    if (claimErr || !claim) throw new Error(`PERSIST_FAILED: ${claimErr?.message}`);

    const { data: doc, error: docErr } = await supabase
      .from("documents")
      .insert({
        claim_id: claim.id,
        storage_path: `multimodal/${claim.id}`,
        mime: "multimodal",
        original_filename: `Inbound email from ${email.fromEmail}`,
        extraction_status: "extracted",
      })
      .select("id")
      .single();
    if (docErr || !doc) throw new Error(`PERSIST_FAILED: ${docErr?.message}`);

    const { data: inserted, error: eventsErr } = await supabase
      .from("sof_events")
      .insert(
        extraction.events.map((e) => ({
          claim_id: claim.id,
          document_id: doc.id,
          occurred_at: e.occurred_at,
          event_type: e.event_type,
          raw_text: e.raw_text,
          page: 1,
          bbox: { x: 0, y: 0, width: 0, height: 0 },
          confidence: 0.9,
          source: "multimodal",
          status: "suggested",
        }))
      )
      .select("id");
    if (eventsErr || !inserted) throw new Error(`PERSIST_FAILED: ${eventsErr?.message}`);

    return NextResponse.json(
      { claimId: claim.id, eventsInserted: inserted.length, warnings: extraction.warnings },
      { status: 201 }
    );
  } catch (e) {
    return apiError(e, "v1/ingestion/email/POST");
  }
}
