// Abstract ERP adapter: the resilient HTTP core every provider shares.
//
// The transport layer handles what integration code always gets wrong —
// timeouts, rate limits (honoring Retry-After), transient 5xx retries with
// jittered exponential backoff, and a hard distinction between retriable and
// non-retriable failures — so concrete adapters only describe payload shapes.
//
// Two things beyond transport live here because getting them wrong is silent:
//   * `mode` — live vs mock, and the production refusal (see `assertModeAllowed`);
//   * `capabilities` — what the provider can actually do, declared up front so
//     an impossible job is rejected at enqueue rather than dead-lettered.

import { createHmac, timingSafeEqual } from "crypto";
import {
  AdapterCapabilities,
  ErpMode,
  InboundEvent,
  IntegrationAuthError,
  IntegrationRequestError,
  IntegrationRow,
  IntegrationUnsupportedError,
  NormalizedInvoice,
  NormalizedSchedule,
  NormalizedVoyage,
  NormalizedVoyagePnl,
  PushResult,
} from "./types";
import { evaluateMockPolicy, parseMockAllowlist } from "./mock-policy";
import { parseXml, XmlNode } from "./xml";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1_000;
const MAX_RETRY_AFTER_S = 60;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH";
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RawRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH";
  /** Pre-serialized body (an XML envelope), sent verbatim. */
  rawBody?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export abstract class ErpAdapter {
  constructor(protected readonly integration: IntegrationRow) {}

  // --- Provider surface ---
  abstract get capabilities(): AdapterCapabilities;
  abstract pullVoyages(sinceISO: string | null): Promise<NormalizedVoyage[]>;
  abstract pushInvoice(invoice: NormalizedInvoice): Promise<PushResult>;
  abstract pushLedger(invoice: NormalizedInvoice): Promise<PushResult>;
  // Parses a verified inbound webhook body into a provider-neutral event.
  abstract parseInboundEvent(payload: unknown): InboundEvent;

  /**
   * Forward vessel schedules. Optional: most legacy ERPs expose a voyage
   * record, fewer expose a forward schedule with an ETA.
   *
   * The base implementation throws rather than returning `[]`. An empty array
   * means "the ERP has no scheduled calls", which is a fact about the fleet; a
   * provider that cannot answer must not be able to impersonate that fact.
   */
  async pullSchedules(_sinceISO: string | null): Promise<NormalizedSchedule[]> {
    throw new IntegrationUnsupportedError(
      `${this.integration.provider} does not support schedule pulls`
    );
  }

  /** Voyage P&L push. Optional for the same reason as `pullSchedules`. */
  async pushVoyagePnl(_pnl: NormalizedVoyagePnl): Promise<PushResult> {
    throw new IntegrationUnsupportedError(
      `${this.integration.provider} does not support voyage P&L pushes`
    );
  }

  // --- Provenance ---

  /**
   * Live or mock, and never inferred.
   *
   * Mock is opt-in through `config.mode === "mock"` ONLY. The tempting
   * alternative — "no credentials configured, so serve fixtures" — is the exact
   * shape of failure `AIS_CONGESTION_PROVIDER` was designed against: an
   * integration that looks connected, invents voyages, and books invoices
   * against vessels that were never fixed. A misconfigured integration must
   * fail loudly, not fall back quietly.
   */
  get mode(): ErpMode {
    return this.integration.config.mode === "mock" ? "mock" : "live";
  }

  /** Human-readable provenance for the UI and for `webhook_logs`. */
  get sourceLabel(): string {
    return this.mode === "mock"
      ? `${this.integration.provider} (deterministic mock — not ERP data)`
      : this.integration.provider;
  }

  /**
   * Refuses mock data in production unless THIS integration is allowlisted.
   *
   * Called by every adapter before it serves a fixture. Scoped per integration
   * rather than per deployment: a global switch permitted every mock-mode
   * integration at once, so a live partner's integration accidentally set to
   * `mode: "mock"` would have been served synthetic voyages. See
   * `mock-policy.ts` for why a per-PROVIDER allowlist would not fix that.
   */
  protected assertModeAllowed(): void {
    if (this.mode !== "mock") return;

    const verdict = evaluateMockPolicy({
      integrationId: this.integration.id,
      companyId: this.integration.company_id,
      nodeEnv: process.env.NODE_ENV,
      allowlist: parseMockAllowlist(process.env.ALLOWED_MOCK_INTEGRATIONS),
    });
    if (verdict.allowed) return;

    throw new IntegrationRequestError(verdict.message);
  }

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

  // --- Config helper ---

  /** A tenant-overridable string from `integrations.config`. */
  protected cfg(key: string, fallback: string): string {
    const v = this.integration.config[key];
    return typeof v === "string" && v ? v : fallback;
  }

  // --- Resilient HTTP core ---

  protected async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const text = await this.send(path, {
      method: options.method,
      rawBody: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      contentType: "application/json",
      headers: options.headers,
    });
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new IntegrationRequestError(
        `ERP returned a non-JSON body: ${text.slice(0, 200)}`
      );
    }
  }

  /** Sends a pre-built XML envelope and parses the XML response. */
  protected async requestXml(path: string, options: RawRequestOptions = {}): Promise<XmlNode> {
    const text = await this.send(path, {
      ...options,
      contentType: options.contentType ?? "text/xml; charset=utf-8",
    });
    return parseXml(text);
  }

  private async send(path: string, options: RawRequestOptions): Promise<string> {
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
            "Content-Type": options.contentType ?? "application/json",
            ...(this.integration.auth.api_token
              ? { Authorization: `Bearer ${this.integration.auth.api_token}` }
              : {}),
            ...options.headers,
          },
          body: options.rawBody,
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
      return await res.text();
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
