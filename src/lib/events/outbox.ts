// The domain event log — types, and the contract a consumer must honour.
//
// Events are produced by the `emit_domain_event()` trigger, in the same
// transaction as the state change that caused them. Nothing in application
// code publishes an event, and nothing should start: a post-commit publish is
// exactly the "settled but never notified" failure this table exists to make
// impossible.
//
// This module is the READ side plus the shapes. It stays pure apart from the
// two explicitly server-only functions at the bottom, which take a client.

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Event types, as a closed set.
 *
 * Facts in the past tense, `aggregate.verb`, matching the CHECK constraint on
 * the column. A name in the imperative ("recompute_claim") would be a command,
 * and a command has exactly one legitimate consumer — at which point the queue
 * is an RPC with worse failure modes.
 */
export const EVENT_TYPES = {
  CLAIM_RECOMPUTED: "claim.recomputed",
  RISK_ASSESSED: "risk.assessed",
  SETTLEMENT_CHANGED: "settlement.changed",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export interface DomainEvent<P = Record<string, unknown>> {
  id: number;
  companyId: string;
  aggregate: string;
  /**
   * The subject's id. NOT a foreign key — an event outlives its aggregate, so
   * a consumer that reads the row must handle "it is gone now" rather than
   * assuming the event implies a live record.
   */
  aggregateId: string;
  eventType: EventType | string;
  payload: P;
  idempotencyKey: string;
  occurredAt: string;
  processedAt: string | null;
  attempts: number;
  lastError: string | null;
}

export interface ClaimRecomputedPayload {
  claim_id: string;
  demurrage_amount: number | null;
  despatch_amount: number | null;
  currency: string | null;
  used_hours: number;
  allowed_hours: number;
}

export interface RiskAssessedPayload {
  risk_id: string;
  claim_id: string | null;
  decision_grade: boolean;
  demurrage_probability: number;
  expected_exposure: number;
  currency: string;
  inputs_digest: string;
}

export interface SettlementChangedPayload {
  settlement_id: string;
  claim_id: string;
  status: string;
  amount: number | null;
  currency: string | null;
}

const COLUMNS =
  "id, company_id, aggregate, aggregate_id, event_type, payload, idempotency_key, occurred_at, processed_at, attempts, last_error";

interface Row {
  id: number;
  company_id: string;
  aggregate: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  occurred_at: string;
  processed_at: string | null;
  attempts: number;
  last_error: string | null;
}

function toEvent(r: Row): DomainEvent {
  return {
    id: r.id,
    companyId: r.company_id,
    aggregate: r.aggregate,
    aggregateId: r.aggregate_id,
    eventType: r.event_type,
    payload: r.payload,
    idempotencyKey: r.idempotency_key,
    occurredAt: r.occurred_at,
    processedAt: r.processed_at,
    attempts: r.attempts,
    lastError: r.last_error,
  };
}

/**
 * Reads outstanding events in order.
 *
 * `afterId` is a cursor, and ids are **monotonic with gaps**: the sequence
 * advances even when the trigger's `ON CONFLICT DO NOTHING` suppresses a
 * duplicate, so a consumer must never assume ids are contiguous or infer a
 * dropped event from a missing number.
 *
 * Service-role only in practice — `domain_events` has a SELECT policy for
 * company members, but a worker has no session and must pass its own client.
 */
export async function readUnprocessed(
  db: SupabaseClient,
  { limit = 100, afterId = 0, eventType }: { limit?: number; afterId?: number; eventType?: EventType } = {}
): Promise<DomainEvent[]> {
  let q = db
    .from("domain_events")
    .select(COLUMNS)
    .is("processed_at", null)
    .gt("id", afterId)
    .order("id", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 1000));

  if (eventType) q = q.eq("event_type", eventType);

  const { data, error } = await q;
  if (error) throw new Error(`OUTBOX_READ_FAILED: ${error.message}`);
  return (data as unknown as Row[]).map(toEvent);
}

/** Events for one aggregate, newest first — the audit read. */
export async function readForAggregate(
  db: SupabaseClient,
  aggregate: string,
  aggregateId: string,
  limit = 50
): Promise<DomainEvent[]> {
  const { data, error } = await db
    .from("domain_events")
    .select(COLUMNS)
    .eq("aggregate", aggregate)
    .eq("aggregate_id", aggregateId)
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`OUTBOX_READ_FAILED: ${error.message}`);
  return (data as unknown as Row[]).map(toEvent);
}

/**
 * Marks an event handled.
 *
 * Call this AFTER the consumer's own work has committed, never before. The
 * ordering is what makes at-least-once delivery safe: a crash between the work
 * and this call redelivers, and redelivery is harmless because every consumer
 * is required to be idempotent on `idempotencyKey`. Marking first would turn
 * the same crash into silent data loss.
 */
export async function markProcessed(db: SupabaseClient, id: number): Promise<void> {
  const { error } = await db
    .from("domain_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`OUTBOX_ACK_FAILED: ${error.message}`);
}

/** Records a failed attempt, leaving the event outstanding for retry. */
export async function markFailed(
  db: SupabaseClient,
  id: number,
  error: unknown,
  currentAttempts: number
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const { error: updateErr } = await db
    .from("domain_events")
    .update({ attempts: currentAttempts + 1, last_error: message.slice(0, 2000) })
    .eq("id", id);
  if (updateErr) throw new Error(`OUTBOX_FAIL_RECORD_FAILED: ${updateErr.message}`);
}

/**
 * Exponential backoff with a dead-letter threshold.
 *
 * Pure, so the retry policy is testable without a queue. A consumer that has
 * failed `maxAttempts` times is not retried again — it is left outstanding with
 * its `last_error` for a human, because a poison event retried forever is a
 * denial-of-service against every event behind it.
 */
export const MAX_ATTEMPTS = 8;

export function nextRetryDelayMs(attempts: number, baseMs = 1000): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return baseMs * 2 ** attempts;
}

export function isDeadLettered(event: Pick<DomainEvent, "attempts">): boolean {
  return event.attempts >= MAX_ATTEMPTS;
}
