// Demand-letter delivery.
//
// Deliberately unwired: no email provider is configured in this repo, and a
// demand letter is an outward-facing legal act against a real counterparty —
// the one kind of side effect that must never happen by accident, and never
// be *reported* as having happened when it didn't.
//
// So this module has the full shape of a sender (recipient validation, the
// confirmation gate, an audit record of intent) but stops at the wire and
// says so. It does NOT follow the settlement/banking.ts precedent of a
// "simulated" success: a simulated clearing is a useful demo, whereas a
// simulated *send* would tell an operator their letter is with the charterer
// when it is sitting in nobody's inbox — and time bars run on that belief.
//
// Wiring a provider means implementing `transport` below and setting the env
// vars; nothing else in the route or UI needs to change.

export type DeliveryOutcome =
  | { sent: true; provider: string; messageId: string; to: string }
  | { sent: false; reason: "not_configured"; detail: string }
  | { sent: false; reason: "provider_error"; detail: string };

export interface DeliveryRequest {
  to: string;
  subject: string;
  bodyText: string;
  pdf: { filename: string; bytes: Uint8Array };
}

// RFC-5322-shaped enough to catch typos without rejecting valid addresses.
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

export function isValidRecipient(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

export function deliveryConfigured(): boolean {
  return Boolean(process.env.EMAIL_PROVIDER_API_KEY && process.env.EMAIL_FROM_ADDRESS);
}

export async function deliverDemandLetter(req: DeliveryRequest): Promise<DeliveryOutcome> {
  if (!isValidRecipient(req.to)) {
    return { sent: false, reason: "provider_error", detail: `"${req.to}" is not a valid email address.` };
  }
  if (!deliveryConfigured()) {
    return {
      sent: false,
      reason: "not_configured",
      detail:
        "No email provider is configured, so nothing was sent. Set EMAIL_PROVIDER_API_KEY and EMAIL_FROM_ADDRESS to enable delivery. The signed PDF is available to download and send through your own channel in the meantime.",
    };
  }
  // Intentionally unreachable until a provider is chosen. Left as a single
  // seam rather than a half-written integration guessing at an API shape.
  return {
    sent: false,
    reason: "not_configured",
    detail:
      "Email credentials are set, but no provider transport is implemented yet — implement transport() in src/lib/drafting/delivery.ts. Nothing was sent.",
  };
}
