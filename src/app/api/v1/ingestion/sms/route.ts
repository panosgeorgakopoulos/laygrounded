import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { extractSofTimeline } from "@/lib/ingestion/multimodal";
import { DEFAULT_CP_TERMS } from "@/lib/laytime/types";
import { parseInboundSms, validateTwilioSignature } from "@/lib/ingestion/sms";

// Inbound-SMS SoF gateway (F3 ingestion channel, SMS variant of the email one).
// A Twilio Messaging webhook POSTs a received SMS here; the deterministic text
// extractor turns the body into a timeline of 'suggested' events on a new claim.
//
// Trust model, in order:
//   1. TWILIO_AUTH_TOKEN must be set. Unset → 503: the channel is off, not
//      silently open.
//   2. X-Twilio-Signature must validate against the exact public URL Twilio
//      called (TWILIO_WEBHOOK_URL, or the request URL). An HMAC-SHA1 the caller
//      cannot forge — no custom shared secret, per the plan's decision.
//   3. The SENDER's phone must belong to a LayGrounded user, and that user to a
//      company. Tenancy is one-company-per-user, so the sender alone routes the
//      message — an SMS from an unknown number cannot inject events anywhere.
// Events land as 'suggested' (every ingestion path does): zero-touch entry, not
// zero-touch trust — a human confirms them in the workspace.
export async function POST(req: NextRequest) {
  try {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
      return NextResponse.json(
        { error: "INGESTION_UNAVAILABLE", message: "SMS ingestion is not configured." },
        { status: 503 }
      );
    }

    // Twilio always sends application/x-www-form-urlencoded.
    const form = await req.formData();
    const record: Record<string, string> = Object.fromEntries(
      [...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""])
    );

    // Validate over the exact URL Twilio signed. Behind a proxy the request URL
    // is not the public one, so a configured override wins.
    const url = process.env.TWILIO_WEBHOOK_URL || req.url;
    if (!validateTwilioSignature(authToken, url, record, req.headers.get("x-twilio-signature"))) {
      return NextResponse.json(
        { error: "UNAUTHORIZED", message: "Invalid Twilio signature." },
        { status: 401 }
      );
    }

    const sms = parseInboundSms(record);
    if (!sms) {
      return NextResponse.json(
        { error: "SMS_UNPARSEABLE", message: "Could not read a sender and body from the message." },
        { status: 422 }
      );
    }

    const supabase = createServiceRoleClient();

    // Sender phone → user → company (one company per user).
    const { data: senderUserId } = await supabase.rpc("get_user_id_by_phone", {
      phone_number: sms.fromPhone,
    });
    if (!senderUserId) {
      return NextResponse.json(
        { error: "SENDER_NOT_A_MEMBER", message: "No LayGrounded account has this phone number." },
        { status: 403 }
      );
    }
    const { data: member } = await supabase
      .from("company_members")
      .select("company_id")
      .eq("user_id", senderUserId)
      .limit(1)
      .maybeSingle();
    if (!member) {
      return NextResponse.json(
        { error: "SENDER_NOT_A_MEMBER", message: "Sender is not a member of any company." },
        { status: 403 }
      );
    }
    const companyId = member.company_id;

    const extraction = extractSofTimeline(sms.body, {});
    if (extraction.events.length === 0) {
      return NextResponse.json(
        { error: "SOF_UNPARSEABLE", warnings: extraction.warnings },
        { status: 422 }
      );
    }

    // Fresh claim from the message. Particulars are best-effort; the operator
    // refines them in the workspace.
    const { data: claim, error: claimErr } = await supabase
      .from("claims")
      .insert({
        company_id: companyId,
        vessel: "TBN",
        voyage_ref: `SMS-${Date.now()}`,
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
        original_filename: `Inbound SMS from ${sms.fromPhone}`,
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
    return apiError(e, "v1/ingestion/sms/POST");
  }
}
