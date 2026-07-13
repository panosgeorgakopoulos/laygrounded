// Abstract ERP adapter: the resilient HTTP core every provider shares.
//
// The transport layer handles what integration code always gets wrong —
// timeouts, rate limits (honoring Retry-After), transient 5xx retries with
// jittered exponential backoff, and a hard distinction between retriable and
// non-retriable failures — so concrete adapters only describe payload shapes.

import { createHmac, timingSafeEqual } from "crypto";
import {
  InboundEvent,
  IntegrationAuthError,
  IntegrationRequestError,
  IntegrationRow,
  NormalizedInvoice,
  NormalizedVoyage,
  PushResult,
} from "./types";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1_000;
const MAX_RETRY_AFTER_S = 60;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH";
  body?: unknown;
  headers?: Record<string, string>;
}

export abstract class ErpAdapter {
  constructor(protected readonly integration: IntegrationRow) {}

  // --- Provider surface ---
  abstract pullVoyages(sinceISO: string | null): Promise<NormalizedVoyage[]>;
  abstract pushInvoice(invoice: NormalizedInvoice): Promise<PushResult>;
  abstract pushLedger(invoice: NormalizedInvoice): Promise<PushResult>;
  // Parses a verified inbound webhook body into a provider-neutral event.
  abstract parseInboundEvent(payload: unknown): InboundEvent;

  // --- Webhook signature verification (HMAC-SHA256 over the raw body) ---
  // Providers differ only in header name; the scheme is shared. Constant-time
  // comparison, and an unconfigured secret always fails closed.
  verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
    const secret = this.integration.auth.webhook_secret;
    if (!secret || !signatureHeader) return false;
    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    const provided = signatureHeader.trim().replace(/^sha256=/, "");
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(provided, "utf8"));
  }

  // --- Resilient HTTP core ---
  protected async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(path, this.integration.base_url).toString();
    let lastError: Error = new IntegrationRequestError("request never attempted");

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleep(computeBackoffMs(attempt));
      }
      let res: Response;
      try {
        res = await fetch(url, {
          method: options.method ?? "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.integration.auth.api_token
              ? { Authorization: `Bearer ${this.integration.auth.api_token}` }
              : {}),
            ...options.headers,
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        // Network failure / timeout — retriable.
        lastError = new IntegrationRequestError(
          `network error: ${e instanceof Error ? e.message : e}`
        );
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        throw new IntegrationAuthError(`ERP rejected credentials (${res.status})`);
      }
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
        const waitS = isNaN(retryAfter)
          ? computeBackoffMs(attempt + 1) / 1000
          : Math.min(retryAfter, MAX_RETRY_AFTER_S);
        lastError = new IntegrationRequestError("rate limited (429)", 429);
        await sleep(waitS * 1000);
        continue;
      }
      if (res.status >= 500) {
        lastError = new IntegrationRequestError(`ERP server error (${res.status})`, res.status);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new IntegrationRequestError(
          `ERP request failed (${res.status}): ${text.slice(0, 300)}`,
          res.status
        );
      }
      return (await res.json()) as T;
    }

    throw lastError;
  }
}

export function computeBackoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt + Math.random() * BASE_BACKOFF_MS, 30_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
