// Webhook delivery with retries.
//
// Before this module, `api_webhook_deliveries` was a ledger of ONE attempt:
// `deliver()` set `attempts: 1`, recorded the outcome, and never tried again.
// A logistics partner whose endpoint blipped for ten seconds simply never
// learned that their trucks were about to idle. That is not an acceptable
// failure mode for a message whose whole value is arriving early.
//
// The shape is deliberately the same as `sync_jobs`: enqueue a row, claim it
// with an optimistic compare-and-set, jittered exponential backoff, dead-letter
// at a ceiling. Two queues that behave identically are one thing to understand.
//
// Idempotency is the UNIQUE (webhook_id, idempotency_key) index, so enqueueing
// the same logical notification twice is a no-op rather than a double-page to
// somebody's operations desk.

import type { SupabaseClient } from "@supabase/supabase-js";
import { signatureHeaders } from "./signing";
import { logStructured, newTraceId } from "@/lib/observability/log";

const DELIVERY_TIMEOUT_MS = 10_000;
export const MAX_DELIVERY_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 2_000;

export interface WebhookSubscription {
  id: string;
  company_id: string;
  url: string;
  secret: string;
  event_types: string[];
  status: string;
  config: Record<string, unknown> | null;
}

export const SUBSCRIPTION_COLUMNS =
  "id, company_id, url, secret, event_types, status, config";

export interface EnqueueResult {
  deliveryId: string | null;
  deduped: boolean;
}

/**
 * Queues a notification. Does NOT send it.
 *
 * Separating enqueue from send is what makes the outbox consumer fast and
 * idempotent: it decides *that* a partner should be told, commits that
 * decision, and lets the delivery sweep own the network.
 */
export async function enqueueDelivery(
  db: SupabaseClient,
  subscription: WebhookSubscription,
  opts: {
    eventType: string;
    idempotencyKey: string;
    payload: unknown;
    claimId?: string | null;
  }
): Promise<EnqueueResult> {
  const { data, error } = await db
    .from("api_webhook_deliveries")
    .insert({
      webhook_id: subscription.id,
      claim_id: opts.claimId ?? null,
      event_type: opts.eventType,
      idempotency_key: opts.idempotencyKey,
      payload: opts.payload,
      status: "pending",
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // 23505 on (webhook_id, idempotency_key): this notification is already
    // queued or already delivered. That is the contract, not a failure.
    if (error.code === "23505") return { deliveryId: null, deduped: true };
    throw new Error(`WEBHOOK_ENQUEUE_FAILED: ${error.message}`);
  }
  return { deliveryId: data?.id ?? null, deduped: false };
}

export interface DeliverySweepReport {
  claimed: number;
  delivered: number;
  retrying: number;
  dead: number;
}

/**
 * Sends what is queued and due.
 *
 * Failures are classified before they are retried. A 4xx that is not 408/429
 * means the partner's endpoint rejected the payload itself — retrying an
 * unchanged body against a deterministic rejection just burns attempts and
 * delays the dead-letter that a human needs to see.
 */
export async function runPendingDeliveries(
  db: SupabaseClient,
  limit = 25,
  now: Date = new Date()
): Promise<DeliverySweepReport> {
  const report: DeliverySweepReport = { claimed: 0, delivered: 0, retrying: 0, dead: 0 };
  const traceId = newTraceId();

  const { data: due } = await db
    .from("api_webhook_deliveries")
    .select("id")
    .eq("status", "pending")
    .lte("next_attempt_at", now.toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(limit);

  for (const candidate of due ?? []) {
    // Optimistic claim: only one sweep wins pending → failed-in-flight. Using
    // 'failed' as the in-flight marker means a worker that dies mid-request
    // leaves a row a human can see, rather than one silently stuck 'pending'
    // and redelivered forever.
    const { data: claimedRows } = await db
      .from("api_webhook_deliveries")
      .update({ status: "failed" })
      .eq("id", candidate.id)
      .eq("status", "pending")
      .select("id, webhook_id, event_type, payload, attempts");
    const delivery = claimedRows?.[0];
    if (!delivery) continue;
    report.claimed++;

    const { data: hook } = await db
      .from("api_webhooks")
      .select(SUBSCRIPTION_COLUMNS)
      .eq("id", delivery.webhook_id)
      .maybeSingle();

    const attempts = (delivery.attempts ?? 0) + 1;

    if (!hook || hook.status !== "active") {
      await db
        .from("api_webhook_deliveries")
        .update({ status: "dead", attempts, last_error: "subscription missing or paused" })
        .eq("id", delivery.id);
      report.dead++;
      continue;
    }

    const outcome = await attemptDelivery(hook as WebhookSubscription, delivery.payload, delivery.event_type, now);

    if (outcome.ok) {
      await db
        .from("api_webhook_deliveries")
        .update({
          status: "delivered",
          attempts,
          response_status: outcome.status ?? null,
          last_error: null,
          delivered_at: new Date().toISOString(),
        })
        .eq("id", delivery.id);
      report.delivered++;
      continue;
    }

    const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;
    const giveUp = exhausted || !outcome.retriable;
    const nextAttemptAt = new Date(now.getTime() + backoffMs(attempts)).toISOString();

    await db
      .from("api_webhook_deliveries")
      .update({
        status: giveUp ? "dead" : "pending",
        attempts,
        response_status: outcome.status ?? null,
        last_error: outcome.error.slice(0, 1000),
        next_attempt_at: nextAttemptAt,
      })
      .eq("id", delivery.id);

    if (giveUp) report.dead++;
    else report.retrying++;

    logStructured(giveUp ? "error" : "warn", "webhook-delivery", `delivery failed: ${outcome.error}`, {
      trace_id: traceId,
      delivery_id: delivery.id,
      webhook_id: delivery.webhook_id,
      event_type: delivery.event_type,
      attempts,
      max_attempts: MAX_DELIVERY_ATTEMPTS,
      response_status: outcome.status ?? null,
      retry_strategy: giveUp
        ? exhausted
          ? "none — dead-lettered after max attempts"
          : "none — endpoint rejected the payload (non-retriable status)"
        : `automatic jittered backoff; next attempt at ${nextAttemptAt}`,
      user_action_required: giveUp
        ? "Inspect last_error on api_webhook_deliveries, confirm the partner endpoint accepts the payload, then re-enqueue."
        : null,
    });
  }

  return report;
}

interface AttemptOutcome {
  ok: boolean;
  status?: number;
  retriable: boolean;
  error: string;
}

async function attemptDelivery(
  hook: WebhookSubscription,
  payload: unknown,
  eventType: string,
  now: Date
): Promise<AttemptOutcome> {
  const body = JSON.stringify(payload);
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: signatureHeaders(body, hook.secret, eventType, now),
      body,
      // The URL passed the SSRF guard at registration, but a 3xx could still
      // redirect this signed delivery to an internal address. Refuse to follow.
      redirect: "error",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    if (res.ok) return { ok: true, status: res.status, retriable: false, error: "" };

    // 408/429 and 5xx are the partner being temporarily unable; other 4xx are
    // the partner refusing this payload, which will not change on a retry.
    const retriable = res.status >= 500 || res.status === 408 || res.status === 429;
    return { ok: false, status: res.status, retriable, error: `HTTP ${res.status}` };
  } catch (e) {
    // Network error, DNS failure, timeout, or a refused redirect — all worth
    // another go.
    return { ok: false, retriable: true, error: e instanceof Error ? e.message : String(e) };
  }
}

export function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt + Math.random() * BASE_BACKOFF_MS, 15 * 60_000);
}
