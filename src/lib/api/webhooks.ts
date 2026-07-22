// Time-bar webhook delivery for the Audit Trail API.
//
// The event that matters to an ERP is a claim crossing INTO a time-bar band
// (ok → warning → critical → expired). Miss the bar and the claim is gone
// regardless of merit, so this is the one alert worth pushing rather than
// waiting to be polled.
//
// At-most-once per crossing, not per sweep. The idempotency key is
// (claim, event_type, deadline): re-running the sweep every hour cannot
// re-alert the same crossing, but a genuinely NEW deadline — the claim's
// events changed, so the bar moved — is a different key and does alert
// again. A unique index decides races, so two concurrent sweeps cannot both
// deliver.

import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeTimeBar, type TimeBarState } from "@/lib/time-bar";

export const TIME_BAR_EVENTS = [
  "time_bar.warning",
  "time_bar.critical",
  "time_bar.expired",
] as const;

export type TimeBarEvent = (typeof TIME_BAR_EVENTS)[number];

export function isTimeBarEvent(s: string): s is TimeBarEvent {
  return (TIME_BAR_EVENTS as readonly string[]).includes(s);
}

// Only these three states are worth waking an ERP for; 'ok' and 'no_anchor'
// are the absence of news.
export function eventForState(state: TimeBarState): TimeBarEvent | null {
  if (state === "warning") return "time_bar.warning";
  if (state === "critical") return "time_bar.critical";
  if (state === "expired") return "time_bar.expired";
  return null;
}

// Same signature scheme as every other outbound webhook in this codebase.
export function signPayload(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function idempotencyKeyFor(claimId: string, event: TimeBarEvent, deadline: string): string {
  return `${claimId}|${event}|${deadline}`;
}

export interface WebhookRow {
  id: string;
  company_id: string;
  url: string;
  secret: string;
  event_types: string[];
  status: string;
}

export interface TimeBarSweepReport {
  webhooksActive: number;
  claimsScanned: number;
  alertsCreated: number;
  delivered: number;
  failed: number;
  skippedDuplicate: number;
}

const DELIVERY_TIMEOUT_MS = 10_000;

async function deliver(
  supabase: SupabaseClient,
  webhook: WebhookRow,
  deliveryId: string,
  payload: unknown
): Promise<boolean> {
  const body = JSON.stringify(payload);
  try {
    const res = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-laygrounded-signature": signPayload(body, webhook.secret),
        "x-laygrounded-event": (payload as { event: string }).event,
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    await supabase
      .from("api_webhook_deliveries")
      .update({
        status: res.ok ? "delivered" : "failed",
        attempts: 1,
        response_status: res.status,
        last_error: res.ok ? null : `HTTP ${res.status}`,
        delivered_at: res.ok ? new Date().toISOString() : null,
      })
      .eq("id", deliveryId);
    return res.ok;
  } catch (e) {
    await supabase
      .from("api_webhook_deliveries")
      .update({
        status: "failed",
        attempts: 1,
        last_error: e instanceof Error ? e.message : String(e),
      })
      .eq("id", deliveryId);
    return false;
  }
}

export async function sweepTimeBarWebhooks(opts: {
  client: SupabaseClient;
  companyId?: string;
  now?: Date;
}): Promise<TimeBarSweepReport> {
  const now = opts.now ?? new Date();
  const report: TimeBarSweepReport = {
    webhooksActive: 0,
    claimsScanned: 0,
    alertsCreated: 0,
    delivered: 0,
    failed: 0,
    skippedDuplicate: 0,
  };

  let wq = opts.client
    .from("api_webhooks")
    .select("id, company_id, url, secret, event_types, status")
    .eq("status", "active");
  if (opts.companyId) wq = wq.eq("company_id", opts.companyId);
  const { data: webhooks } = await wq;
  const active = (webhooks ?? []) as WebhookRow[];
  report.webhooksActive = active.length;
  if (active.length === 0) return report;

  const byCompany = new Map<string, WebhookRow[]>();
  for (const w of active) {
    byCompany.set(w.company_id, [...(byCompany.get(w.company_id) ?? []), w]);
  }

  for (const [companyId, hooks] of byCompany) {
    // Settled claims have no live deadline.
    const { data: claims } = await opts.client
      .from("claims")
      .select("id, vessel, voyage_ref, external_ref, time_bar_days")
      .eq("company_id", companyId)
      .is("settled_at", null);

    for (const claim of claims ?? []) {
      report.claimsScanned++;

      const [{ data: events }, { data: calc }, { data: docs }] = await Promise.all([
        opts.client
          .from("sof_events")
          .select("event_type, occurred_at")
          .eq("claim_id", claim.id)
          .in("status", ["accepted", "edited"]),
        opts.client
          .from("laytime_calculations")
          .select("demurrage_amount, currency")
          .eq("claim_id", claim.id)
          .maybeSingle(),
        opts.client.from("documents").select("id").eq("claim_id", claim.id).limit(1),
      ]);

      const tb = computeTimeBar({
        timeBarDays: claim.time_bar_days ?? 90,
        events: events ?? [],
        hasSofDocument: (docs?.length ?? 0) > 0,
        hasValidCpTerms: true,
        hasCalculation: Boolean(calc),
        now,
      });
      const event = eventForState(tb.state);
      if (!event || !tb.deadline) continue;

      for (const hook of hooks) {
        if (!hook.event_types.includes(event)) continue;

        const payload = {
          event,
          claimId: claim.id,
          externalRef: claim.external_ref,
          vessel: claim.vessel,
          voyageRef: claim.voyage_ref,
          deadline: tb.deadline,
          daysRemaining: tb.daysRemaining,
          state: tb.state,
          packComplete: tb.complete,
          valueAtRisk: calc?.demurrage_amount ?? null,
          currency: calc?.currency ?? null,
          firedAt: now.toISOString(),
        };

        // Insert first: the unique (webhook_id, idempotency_key) is what makes
        // this at-most-once. A duplicate insert failing means another sweep
        // already owns this crossing, so we must NOT also deliver it.
        const { data: delivery, error } = await opts.client
          .from("api_webhook_deliveries")
          .insert({
            webhook_id: hook.id,
            claim_id: claim.id,
            event_type: event,
            idempotency_key: idempotencyKeyFor(claim.id, event, tb.deadline),
            payload,
          })
          .select("id")
          .single();

        if (error || !delivery) {
          report.skippedDuplicate++;
          continue;
        }
        report.alertsCreated++;
        const ok = await deliver(opts.client, hook, delivery.id, payload);
        if (ok) report.delivered++;
        else report.failed++;
      }
    }
  }

  return report;
}
