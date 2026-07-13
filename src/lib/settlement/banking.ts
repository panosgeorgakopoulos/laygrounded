// Banking provider for the settlement clearinghouse.
//
// Template for a real B2B payments integration (Stripe Treasury / Plaid
// Transfer shaped): a signed webhook initiates the transfer, the provider's
// reference comes back in the response. With no provider configured the
// clearing is SIMULATED in-process and labeled as such — the mock never
// pretends money moved (AD-006 in docs/build-memory/LEDGER.md).
//
// Env: SETTLEMENT_PROVIDER_URL (webhook endpoint), SETTLEMENT_WEBHOOK_SECRET
// (HMAC-SHA256 signing key — required when a URL is set).

import { createHmac, randomUUID } from "crypto";

export interface ClearingRequest {
  idempotencyKey: string;
  claimId: string;
  voyageRef: string;
  amount: number;
  currency: string;
  direction: "collect" | "pay";
  counterpartyName: string | null;
}

export interface ClearingResult {
  status: "cleared" | "failed";
  provider: string;
  providerRef: string | null;
  simulated: boolean;
  error: string | null;
}

const PROVIDER_TIMEOUT_MS = 10_000;

export function signSettlementPayload(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export async function clearFunds(request: ClearingRequest): Promise<ClearingResult> {
  const url = process.env.SETTLEMENT_PROVIDER_URL;
  const secret = process.env.SETTLEMENT_WEBHOOK_SECRET;

  if (!url) {
    return {
      status: "cleared",
      provider: "MOCK_BANK",
      providerRef: `sim_${randomUUID()}`,
      simulated: true,
      error: null,
    };
  }
  if (!secret) {
    return {
      status: "failed",
      provider: "SETTLEMENT_PROVIDER",
      providerRef: null,
      simulated: false,
      error: "SETTLEMENT_WEBHOOK_SECRET not configured — refusing to send an unsigned transfer instruction",
    };
  }

  const body = JSON.stringify({
    type: "demurrage_settlement.initiate",
    idempotency_key: request.idempotencyKey,
    amount: request.amount,
    currency: request.currency,
    direction: request.direction,
    claim: {
      id: request.claimId,
      voyage_ref: request.voyageRef,
      counterparty: request.counterpartyName,
    },
    initiated_at: new Date().toISOString(),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-laygrounded-signature": signSettlementPayload(body, secret),
        "idempotency-key": request.idempotencyKey,
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        status: "failed",
        provider: "SETTLEMENT_PROVIDER",
        providerRef: null,
        simulated: false,
        error: `provider responded ${res.status}`,
      };
    }
    const json = (await res.json().catch(() => ({}))) as { reference?: string };
    return {
      status: "cleared",
      provider: "SETTLEMENT_PROVIDER",
      providerRef: json.reference ?? null,
      simulated: false,
      error: null,
    };
  } catch (e) {
    return {
      status: "failed",
      provider: "SETTLEMENT_PROVIDER",
      providerRef: null,
      simulated: false,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}
