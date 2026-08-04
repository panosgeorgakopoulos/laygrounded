// The notifications consumer: domain events → somebody's inbox.
//
// The FOURTH consumer of `domain_events`, and the one that would have broken
// the other three before `domain_event_consumptions` existed. Its own cursor,
// its own retries, its own dead letters.
//
// IDEMPOTENCY IS NOT OPTIONAL HERE. Outbox delivery is at-least-once, so this
// runs again on any crash between the insert and the ack. Every write goes
// through the `(user_id, dedupe_key)` unique constraint with duplicates
// ignored, so a redelivery is a no-op rather than a second copy of the same
// alert. Two of the same notification is not a cosmetic issue: it is the
// fastest way to teach people to ignore the bell.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONSUMERS,
  MAX_ATTEMPTS,
  markFailedBy,
  markProcessedBy,
  readUnprocessedFor,
  type DomainEvent,
} from "@/lib/events/outbox";
import { can, roleOf } from "@/lib/auth/roles";
import { logStructured, newTraceId } from "@/lib/observability/log";
import { draftFor, type NotificationDraft } from "./rules";

export interface NotificationDispatchReport {
  read: number;
  /** Rows actually inserted (excludes duplicates suppressed by the constraint). */
  created: number;
  /** Events that produced a draft nobody in the tenant could act on. */
  noRecipients: number;
  /** Events no rule cares about — the overwhelming majority. */
  skipped: number;
  failed: number;
  deadLettered: number;
}

interface MemberRow {
  user_id: string;
  role: string | null;
}

/**
 * The people in a company who could act on `capability`.
 *
 * Resolved through the Phase 14 ladder rather than by matching a role name, so
 * an admin — who outranks every other role — is never accidentally excluded
 * from a notification addressed to "the finance manager".
 */
function recipientsFor(members: MemberRow[], draft: NotificationDraft): string[] {
  return members.filter((m) => can(roleOf(m.role), draft.capability)).map((m) => m.user_id);
}

export async function dispatchNotifications(
  db: SupabaseClient,
  { limit = 100, now = new Date() }: { limit?: number; now?: Date } = {}
): Promise<NotificationDispatchReport> {
  const report: NotificationDispatchReport = {
    read: 0,
    created: 0,
    noRecipients: 0,
    skipped: 0,
    failed: 0,
    deadLettered: 0,
  };
  const traceId = newTraceId();

  const events = await readUnprocessedFor(db, CONSUMERS.NOTIFICATIONS, { limit });
  report.read = events.length;

  // One membership read per company per run, not per event. A batch is
  // routinely many events for one tenant, and the roster does not change
  // mid-sweep in any way worth chasing.
  const rosters = new Map<string, MemberRow[]>();

  for (const event of events) {
    if (event.attempts >= MAX_ATTEMPTS) {
      report.deadLettered++;
      continue;
    }

    try {
      const draft = draftFor(event);
      if (!draft) {
        await markProcessedBy(db, event.id, CONSUMERS.NOTIFICATIONS);
        report.skipped++;
        continue;
      }

      let members = rosters.get(event.companyId);
      if (!members) {
        const { data, error } = await db
          .from("company_members")
          .select("user_id, role")
          .eq("company_id", event.companyId);
        if (error) throw new Error(`ROSTER_READ_FAILED: ${error.message}`);
        members = (data ?? []) as MemberRow[];
        rosters.set(event.companyId, members);
      }

      const userIds = recipientsFor(members, draft);
      if (userIds.length === 0) {
        // Acked, not retried. A tenant whose only members are viewers will
        // never grow a recipient for this event, and leaving it outstanding
        // would put a permanently stuck row at the head of the queue.
        await markProcessedBy(db, event.id, CONSUMERS.NOTIFICATIONS);
        report.noRecipients++;
        logStructured("info", "notification-dispatch", "no recipient holds the capability", {
          trace_id: traceId,
          event_id: event.id,
          company_id: event.companyId,
          kind: draft.kind,
          capability: draft.capability,
          user_action_required:
            "If this tenant should receive these, give somebody a role that clears the capability.",
        });
        continue;
      }

      const rows = userIds.map((userId) => ({
        company_id: event.companyId,
        user_id: userId,
        event_id: event.id,
        kind: draft.kind,
        severity: draft.severity,
        title: draft.title,
        body: draft.body,
        href: draft.href,
        subject_type: draft.subjectType,
        subject_id: draft.subjectId,
        dedupe_key: draft.dedupeKey,
        created_at: now.toISOString(),
      }));

      // ignoreDuplicates: a redelivery must not resurrect a notification the
      // recipient has already read and dismissed. `upsert` with merge would do
      // exactly that by overwriting read_at back to null.
      const { data: inserted, error } = await db
        .from("notifications")
        .upsert(rows, { onConflict: "user_id,dedupe_key", ignoreDuplicates: true })
        .select("id");
      if (error) throw new Error(`NOTIFICATION_WRITE_FAILED: ${error.message}`);

      report.created += inserted?.length ?? 0;

      // Acked only after the write committed — the ordering that makes
      // at-least-once safe. Acking first would turn a crash here into an alert
      // nobody ever receives.
      await markProcessedBy(db, event.id, CONSUMERS.NOTIFICATIONS);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      report.failed++;
      logStructured("warn", "notification-dispatch", `notification fan-out failed: ${message}`, {
        trace_id: traceId,
        event_id: event.id,
        company_id: event.companyId,
        event_type: event.eventType,
        attempts: event.attempts + 1,
        max_attempts: MAX_ATTEMPTS,
        retry_strategy: "automatic on the next dispatch sweep",
        user_action_required: null,
      });
      await markFailedBy(db, event.id, CONSUMERS.NOTIFICATIONS, e, event.attempts);
    }
  }

  return report;
}

/** Exported for tests: the routing decision, without the I/O around it. */
export const __testing = { recipientsFor };
export type { DomainEvent };
