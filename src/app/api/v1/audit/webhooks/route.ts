import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { authenticateApiRequest } from "@/lib/api/authenticate";
import { apiAuthFailure, apiFail, apiOk } from "@/lib/api/respond";
import { TIME_BAR_EVENTS } from "@/lib/api/webhooks";

const RegisterSchema = z.object({
  url: z.string().url().max(2000),
  eventTypes: z.array(z.enum(TIME_BAR_EVENTS)).min(1),
});

// POST /api/v1/audit/webhooks — register a time-bar alert webhook.
// The signing secret is returned exactly once, here. Same rule as the ERP
// integration secrets and the insurer keys: it is never readable again.
export async function POST(req: NextRequest) {
  let caller;
  try {
    caller = await authenticateApiRequest(req, "webhooks:manage");
  } catch (e) {
    return apiAuthFailure(e, "v1/audit/webhooks/POST:auth");
  }

  try {
    const parsed = RegisterSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return apiFail(400, "VALIDATION_ERROR", "Request body failed validation.", parsed.error.flatten());
    }

    // Deliveries carry claim references and money; https only, and no
    // loopback/internal hosts — a webhook URL is a server-side fetch we
    // perform on the caller's say-so, which is an SSRF primitive if left open.
    const url = new URL(parsed.data.url);
    if (url.protocol !== "https:") {
      return apiFail(400, "INSECURE_WEBHOOK_URL", "Webhook URLs must use https.");
    }
    if (isPrivateHost(url.hostname)) {
      return apiFail(400, "INSECURE_WEBHOOK_URL", "Webhook URLs must not point at private or loopback addresses.");
    }

    const secret = randomBytes(32).toString("base64url");
    const { data, error } = await caller.client
      .from("api_webhooks")
      .insert({
        company_id: caller.companyId,
        url: parsed.data.url,
        secret,
        event_types: parsed.data.eventTypes,
      })
      .select("id, url, event_types, status, created_at")
      .single();
    if (error || !data) throw new Error(`WEBHOOK_CREATE_FAILED: ${error?.message}`);

    return apiOk(
      {
        id: data.id,
        url: data.url,
        eventTypes: data.event_types,
        status: data.status,
        createdAt: data.created_at,
        secret,
        secretNotice:
          "Store this secret now — it is not retrievable again. Every delivery is signed with it: x-laygrounded-signature: sha256=HMAC-SHA256(raw body, secret). Verify it before trusting a payload.",
      },
      caller,
      { status: 201 }
    );
  } catch (e) {
    return apiAuthFailure(e, "v1/audit/webhooks/POST");
  }
}

// GET /api/v1/audit/webhooks — list registrations (never the secrets).
export async function GET(req: NextRequest) {
  let caller;
  try {
    caller = await authenticateApiRequest(req, "webhooks:manage");
  } catch (e) {
    return apiAuthFailure(e, "v1/audit/webhooks/GET:auth");
  }

  try {
    const { data, error } = await caller.client
      .from("api_webhooks")
      .select("id, url, event_types, status, last_error, created_at")
      .eq("company_id", caller.companyId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`QUERY_FAILED: ${error.message}`);

    return apiOk(
      {
        webhooks: (data ?? []).map((w) => ({
          id: w.id,
          url: w.url,
          eventTypes: w.event_types,
          status: w.status,
          lastError: w.last_error,
          createdAt: w.created_at,
        })),
      },
      caller
    );
  } catch (e) {
    return apiAuthFailure(e, "v1/audit/webhooks/GET");
  }
}

// Blocks the obvious SSRF targets. Not a substitute for egress controls —
// DNS can still resolve a public name to a private address — but it stops
// the direct attempt.
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) {
    return true;
  }
  if (/^(\[|::1|0\.0\.0\.0)/.test(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
  }
  return false;
}
