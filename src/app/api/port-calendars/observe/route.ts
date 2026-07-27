import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { observeNonWorkingDays } from "@/lib/laytime/calendar-observation";
import { normalizePortKey } from "@/lib/laytime/port-calendar-server";
import type { SofEventInput } from "@/lib/laytime/types";

const KNOWN = { CLAIM_NOT_FOUND: 404 } as const;

const ObserveSchema = z.object({
  // Absent = sweep the company's whole book.
  claimId: z.string().uuid().optional(),
});

const ReviewSchema = z.object({
  dayIds: z.array(z.string().uuid()).min(1).max(500),
  decision: z.enum(["confirmed", "rejected"]),
});

/**
 * Proposes non-working days from real statements of facts.
 *
 * Everything written here lands as `pending` and is excluded from every
 * calculation until a person accepts it in the PATCH below. A quiet day may be a
 * holiday, a breakdown, congestion, or a gap in the paperwork, and the inference
 * cannot tell those apart — so it proposes rather than asserts.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const parsed = ObserveSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const supabase = await createClient();

    let claimQuery = supabase
      .from("claims")
      .select("id, port, cp_terms")
      .eq("company_id", auth.companyId)
      .not("port", "is", null);
    if (parsed.data.claimId) claimQuery = claimQuery.eq("id", parsed.data.claimId);

    const { data: claims, error } = await claimQuery;
    if (error) throw error;
    if (parsed.data.claimId && (!claims || claims.length === 0)) {
      throw new Error("CLAIM_NOT_FOUND");
    }

    let proposed = 0;
    let scanned = 0;
    const perPort = new Map<string, number>();

    for (const claim of claims ?? []) {
      const { data: events } = await supabase
        .from("sof_events")
        .select("id, occurred_at, event_type")
        .eq("claim_id", claim.id)
        .in("status", ["accepted", "edited"])
        .order("occurred_at", { ascending: true });

      const inputs: SofEventInput[] = (events ?? []).map((e) => ({
        id: e.id,
        occurred_at: e.occurred_at,
        event_type: e.event_type as SofEventInput["event_type"],
      }));
      if (inputs.length === 0) continue;
      scanned++;

      const tz = (claim.cp_terms as Record<string, unknown>)?.port_timezone;
      const candidates = observeNonWorkingDays(inputs, typeof tz === "string" ? tz : "UTC");
      if (candidates.length === 0) continue;

      // The calendar is created on first observation so proposals have somewhere
      // to live, but it is marked observed_from_sof and holds only pending days,
      // so its existence alone changes no calculation.
      const { data: calendar, error: calErr } = await supabase
        .from("port_calendars")
        .upsert(
          {
            company_id: auth.companyId,
            port_key: normalizePortKey(claim.port),
            port_label: claim.port.trim(),
            source: "Observed from statements of facts",
            source_kind: "observed_from_sof",
            created_by: auth.userId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "company_id,port_key", ignoreDuplicates: false },
        )
        .select("id")
        .single();
      if (calErr || !calendar) continue;

      // ignoreDuplicates so a re-sweep never resurrects a day the operator has
      // already rejected, nor downgrades one they confirmed back to pending.
      const { data: inserted } = await supabase
        .from("port_calendar_days")
        .upsert(
          candidates.map((c) => ({
            calendar_id: calendar.id,
            calendar_date: c.date,
            kind: "non_working",
            label: c.rationale,
            status: "pending",
            observed_claim_id: claim.id,
          })),
          { onConflict: "calendar_id,calendar_date", ignoreDuplicates: true },
        )
        .select("id");

      const added = inserted?.length ?? 0;
      proposed += added;
      if (added > 0) perPort.set(claim.port, (perPort.get(claim.port) ?? 0) + added);
    }

    return NextResponse.json({
      scannedClaims: scanned,
      proposed,
      byPort: Object.fromEntries(perPort),
      note:
        "Proposed days are pending and do NOT affect any calculation until confirmed. " +
        "A quiet day may be a holiday, a breakdown, congestion, or missing paperwork.",
    });
  } catch (e) {
    return apiError(e, "port-calendars/observe/POST", KNOWN);
  }
}

/**
 * The pending review queue.
 *
 * `?claimId=` narrows to the days observed on one voyage, which is what the
 * inline banner in the claim workspace shows. Without it, the whole book — the
 * dashboard widget's count and the master-data table.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();
    const claimId = req.nextUrl.searchParams.get("claimId");

    let query = supabase
      .from("port_calendar_days")
      .select(
        "id, calendar_date, kind, label, status, observed_claim_id, " +
          "port_calendars!inner(id, port_label, port_key, company_id)",
      )
      .eq("status", "pending")
      .eq("port_calendars.company_id", auth.companyId)
      .order("calendar_date", { ascending: true });

    if (claimId) query = query.eq("observed_claim_id", claimId);

    const { data, error } = await query;
    if (error) throw error;

    const rows = (data ?? []) as unknown as Array<Record<string, any>>;
    const days = rows.map((d) => {
      const cal = Array.isArray(d.port_calendars) ? d.port_calendars[0] : d.port_calendars;
      return {
        id: d.id,
        date: d.calendar_date,
        kind: d.kind,
        rationale: d.label,
        port: cal?.port_label ?? "",
        portKey: cal?.port_key ?? "",
        observedClaimId: d.observed_claim_id,
      };
    });

    // Grouped for the widget, which reports "3 ports awaiting review" rather
    // than a flat count nobody can act on.
    const byPort = new Map<string, number>();
    for (const d of days) byPort.set(d.port, (byPort.get(d.port) ?? 0) + 1);

    return NextResponse.json({
      pending: days,
      total: days.length,
      byPort: Object.fromEntries(byPort),
    });
  } catch (e) {
    return apiError(e, "port-calendars/observe/GET", KNOWN);
  }
}

/** Accept or reject proposed days. Confirming is what lets them reach the engine. */
export async function PATCH(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const parsed = ReviewSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const supabase = await createClient();
    // RLS scopes these to the caller's company; the update is additionally
    // pinned to `pending` so a review action can never silently flip a day the
    // operator had already decided on.
    const { data, error } = await supabase
      .from("port_calendar_days")
      .update({
        status: parsed.data.decision,
        confirmed_by: auth.userId,
        confirmed_at: new Date().toISOString(),
      })
      .in("id", parsed.data.dayIds)
      .eq("status", "pending")
      .select("id");

    if (error) throw error;
    return NextResponse.json({ updated: data?.length ?? 0, decision: parsed.data.decision });
  } catch (e) {
    return apiError(e, "port-calendars/observe/PATCH", KNOWN);
  }
}
