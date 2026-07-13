// Insurance data oracle: evaluates policies against the deterministic
// engine's stored breakdowns and emits signed parametric-trigger webhooks.
//
// Neutrality is the product: the payload contains only what the engine and
// the evidence layer already persisted — this module computes nothing new
// beyond the continuous-delay window (detect.ts, pure and unit-tested).
// The UNIQUE idempotency key on insurance_triggers guarantees a delay window
// fires at most once per policy no matter how often the sweep runs.

import { createHmac, randomBytes, createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BreakdownRow } from "@/lib/laytime/types";
import { detectParametricTrigger } from "./detect";

export const DEFAULT_THRESHOLD_HOURS = 120; // 5 consecutive weather days

const WEBHOOK_TIMEOUT_MS = 10_000;

export function generateInsurerApiKey(): string {
  return `lgk_${randomBytes(24).toString("base64url")}`;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// Same signature scheme as every other outbound webhook in this codebase:
// sha256 HMAC of the raw body in x-laygrounded-signature.
function signPayload(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export interface InsuranceSweepReport {
  policiesEvaluated: number;
  claimsScanned: number;
  triggersCreated: number;
  webhooksDelivered: number;
  errors: Array<{ policyId: string; claimId: string; error: string }>;
}

interface PolicyRow {
  id: string;
  company_id: string;
  insurer_label: string;
  webhook_url: string;
  webhook_secret: string;
  threshold_hours: number;
}

export async function evaluateInsuranceTriggers(
  supabase: SupabaseClient,
  opts: { companyId?: string; claimId?: string; limit?: number } = {}
): Promise<InsuranceSweepReport> {
  const report: InsuranceSweepReport = {
    policiesEvaluated: 0,
    claimsScanned: 0,
    triggersCreated: 0,
    webhooksDelivered: 0,
    errors: [],
  };

  let policyQuery = supabase
    .from("insurance_policies")
    .select("id, company_id, insurer_label, webhook_url, webhook_secret, threshold_hours")
    .eq("status", "active");
  if (opts.companyId) policyQuery = policyQuery.eq("company_id", opts.companyId);
  const { data: policies, error: polErr } = await policyQuery;
  if (polErr) throw new Error(`SWEEP_QUERY_FAILED: ${polErr.message}`);
  if (!policies || policies.length === 0) return report;

  const policiesByCompany = new Map<string, PolicyRow[]>();
  for (const p of policies as PolicyRow[]) {
    const list = policiesByCompany.get(p.company_id) ?? [];
    list.push(p);
    policiesByCompany.set(p.company_id, list);
  }
  report.policiesEvaluated = policies.length;

  // Candidate claims: companies that hold a policy, newest activity first.
  let claimQuery = supabase
    .from("claims")
    .select(
      "id, company_id, vessel, vessel_imo, voyage_ref, port, laytime_calculations!inner(id, breakdown, used_hours, allowed_hours, computed_at)"
    )
    .in("company_id", [...policiesByCompany.keys()])
    .order("updated_at", { ascending: false })
    .limit(opts.limit ?? 50);
  if (opts.claimId) claimQuery = claimQuery.eq("id", opts.claimId);
  const { data: claims, error: claimErr } = await claimQuery;
  if (claimErr) throw new Error(`SWEEP_QUERY_FAILED: ${claimErr.message}`);

  for (const claim of claims ?? []) {
    report.claimsScanned += 1;
    const calc = Array.isArray(claim.laytime_calculations)
      ? claim.laytime_calculations[0]
      : claim.laytime_calculations;
    if (!calc) continue;
    const breakdown = (Array.isArray(calc.breakdown) ? calc.breakdown : []) as BreakdownRow[];

    for (const policy of policiesByCompany.get(claim.company_id) ?? []) {
      try {
        const delay = detectParametricTrigger(breakdown, policy.threshold_hours);
        if (!delay) continue;

        const idempotencyKey = `${policy.id}:${claim.id}:${delay.start}:${delay.end}`;
        const payload = {
          type: "parametric.weather_delay.triggered",
          idempotency_key: idempotencyKey,
          policy_id: policy.id,
          claim: {
            id: claim.id,
            vessel: claim.vessel,
            vessel_imo: claim.vessel_imo ?? null,
            voyage_ref: claim.voyage_ref,
            port: claim.port,
          },
          delay: {
            hours: delay.hours,
            window_start: delay.start,
            window_end: delay.end,
            threshold_hours: policy.threshold_hours,
          },
          calculation: {
            id: calc.id,
            computed_at: calc.computed_at,
            used_hours: calc.used_hours,
            allowed_hours: calc.allowed_hours,
          },
          emitted_at: new Date().toISOString(),
        };

        const { data: inserted, error: insErr } = await supabase
          .from("insurance_triggers")
          .upsert(
            {
              policy_id: policy.id,
              claim_id: claim.id,
              calculation_id: calc.id,
              trigger_type: "continuous_weather_delay",
              delay_hours: delay.hours,
              window_start: delay.start,
              window_end: delay.end,
              threshold_hours: policy.threshold_hours,
              payload,
              idempotency_key: idempotencyKey,
            },
            { onConflict: "idempotency_key", ignoreDuplicates: true }
          )
          .select("id");
        if (insErr) throw new Error(`TRIGGER_PERSIST_FAILED: ${insErr.message}`);
        const trigger = (inserted ?? [])[0];
        if (!trigger) continue; // window already emitted on a prior sweep

        report.triggersCreated += 1;
        const delivery = await deliverWebhook(policy, payload);
        await supabase
          .from("insurance_triggers")
          .update({
            delivery_status: delivery.status,
            delivered_at: delivery.status === "delivered" ? new Date().toISOString() : null,
            last_error: delivery.error,
          })
          .eq("id", trigger.id);
        if (delivery.status === "delivered") report.webhooksDelivered += 1;
      } catch (e) {
        report.errors.push({
          policyId: policy.id,
          claimId: claim.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return report;
}

async function deliverWebhook(
  policy: PolicyRow,
  payload: Record<string, unknown>
): Promise<{ status: "pending" | "delivered" | "failed"; error: string | null }> {
  // No URL configured = a polling insurer; the trigger stays 'pending' and
  // is served by the read-only oracle endpoint.
  if (!policy.webhook_url) return { status: "pending", error: null };

  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(policy.webhook_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-laygrounded-signature": signPayload(body, policy.webhook_secret),
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) return { status: "failed", error: `insurer endpoint responded ${res.status}` };
    return { status: "delivered", error: null };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
