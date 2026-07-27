import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { normalizePortKey } from "@/lib/laytime/port-calendar-server";

const KNOWN = { CALENDAR_NOT_FOUND: 404 } as const;

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

// Customer-supplied import. `source` is mandatory and non-empty: a calendar
// decides whether real money counts, so every entry has to say where it came
// from. Days arrive `confirmed` because the customer is asserting them —
// unlike days inferred from statements of facts, which land `pending`.
const ImportSchema = z.object({
  port: z.string().min(2).max(160),
  timezone: z.string().max(64).optional(),
  source: z.string().min(1).max(300),
  notes: z.string().max(2000).optional(),
  days: z
    .array(
      z.union([
        DateStr,
        z.object({
          date: DateStr,
          label: z.string().max(200).optional(),
          kind: z.enum(["holiday", "non_working"]).default("holiday"),
        }),
      ]),
    )
    .max(2000),
});

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();
    const port = req.nextUrl.searchParams.get("port");

    let query = supabase
      .from("port_calendars")
      .select(
        "id, port_key, port_label, timezone, source, source_kind, notes, created_at, " +
          "port_calendar_days(id, calendar_date, kind, label, status, observed_claim_id)",
      )
      .eq("company_id", auth.companyId)
      .order("port_label", { ascending: true });

    if (port) query = query.eq("port_key", normalizePortKey(port));

    const { data, error } = await query;
    if (error) throw error;

    const rows = (data ?? []) as unknown as Array<Record<string, any>>;
    return NextResponse.json({
      calendars: rows.map((c) => {
        const days = (c.port_calendar_days ?? []) as Array<Record<string, any>>;
        return {
          id: c.id,
          port: c.port_label,
          portKey: c.port_key,
          timezone: c.timezone,
          source: c.source,
          sourceKind: c.source_kind,
          notes: c.notes,
          createdAt: c.created_at,
          // Split by status so a reviewer sees what is actually in force versus
          // what is merely proposed — only confirmed days reach the engine.
          confirmed: days
            .filter((d) => d.status === "confirmed")
            .map((d) => ({ id: d.id, date: d.calendar_date, kind: d.kind, label: d.label })),
          pending: days
            .filter((d) => d.status === "pending")
            .map((d) => ({
              id: d.id,
              date: d.calendar_date,
              kind: d.kind,
              label: d.label,
              observedClaimId: d.observed_claim_id,
            })),
        };
      }),
    });
  } catch (e) {
    return apiError(e, "port-calendars/GET", KNOWN);
  }
}

// Remove a calendar entirely, or individual days from it. Deleting the last
// confirmed day leaves the calendar loading as ABSENT rather than as an empty
// calendar, so a port is never asserted to have no holidays.
export async function DELETE(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();
    const calendarId = req.nextUrl.searchParams.get("calendarId");
    const dayIds = req.nextUrl.searchParams.get("dayIds");

    if (dayIds) {
      const ids = dayIds.split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) {
        return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 });
      }
      // RLS scopes this to the caller's company through the calendar join.
      const { data, error } = await supabase
        .from("port_calendar_days")
        .delete()
        .in("id", ids)
        .select("id");
      if (error) throw error;
      return NextResponse.json({ deletedDays: data?.length ?? 0 });
    }

    if (!calendarId) {
      return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("port_calendars")
      .delete()
      .eq("id", calendarId)
      .eq("company_id", auth.companyId)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) throw new Error("CALENDAR_NOT_FOUND");

    return NextResponse.json({ deletedCalendar: calendarId });
  } catch (e) {
    return apiError(e, "port-calendars/DELETE", KNOWN);
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const parsed = ImportSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const input = parsed.data;
    const supabase = await createClient();

    // Upsert the calendar itself. One per port per tenant, so re-importing
    // updates provenance rather than forking a second calendar the engine would
    // then have to choose between.
    const { data: calendar, error: calErr } = await supabase
      .from("port_calendars")
      .upsert(
        {
          company_id: auth.companyId,
          port_key: normalizePortKey(input.port),
          port_label: input.port.trim(),
          timezone: input.timezone ?? null,
          source: input.source,
          source_kind: "customer_supplied",
          notes: input.notes ?? null,
          created_by: auth.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "company_id,port_key" },
      )
      .select("id")
      .single();

    if (calErr) throw calErr;

    const normalized = input.days.map((d) =>
      typeof d === "string" ? { date: d, label: undefined, kind: "holiday" as const } : d,
    );

    // De-duplicate within the payload: the unique index would reject the whole
    // batch on a repeated date, and a customer's spreadsheet listing a day twice
    // is not an error worth failing an import over.
    const byDate = new Map<string, (typeof normalized)[number]>();
    for (const d of normalized) byDate.set(d.date, d);

    let imported = 0;
    if (byDate.size > 0) {
      const { error: daysErr } = await supabase.from("port_calendar_days").upsert(
        [...byDate.values()].map((d) => ({
          calendar_id: calendar.id,
          calendar_date: d.date,
          kind: d.kind,
          label: d.label ?? null,
          status: "confirmed",
          confirmed_by: auth.userId,
          confirmed_at: new Date().toISOString(),
        })),
        { onConflict: "calendar_id,calendar_date" },
      );
      if (daysErr) throw daysErr;
      imported = byDate.size;
    }

    return NextResponse.json(
      {
        calendarId: calendar.id,
        imported,
        duplicatesCollapsed: normalized.length - byDate.size,
      },
      { status: 201 },
    );
  } catch (e) {
    return apiError(e, "port-calendars/POST", KNOWN);
  }
}
