// Loading a port's calendar for a calculation.
//
// The DB half of the `port_calendar` input on CpTerms; the engine itself stays
// pure and simply receives the holidays.
//
// One rule governs everything here: ONLY `confirmed` days reach the engine.
// Days inferred from statements of facts land as `pending` and stay out of every
// calculation until a person accepts them, because an inference is a hypothesis
// about why a port was quiet and acting on it would silently move real money.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PortCalendar } from "@/lib/laytime/types";

export function normalizePortKey(port: string): string {
  return port.trim().toLowerCase();
}

/**
 * The confirmed calendar for one company's port, or undefined when there is
 * none.
 *
 * Undefined is meaningful: it is exactly the "no calendar known" case, which
 * reproduces the engine's pre-calendar behaviour. A calendar that exists but has
 * no confirmed days also returns undefined rather than an empty calendar, so a
 * half-reviewed import cannot quietly assert "this port has no holidays".
 */
export async function loadPortCalendar(
  db: SupabaseClient,
  companyId: string,
  port: string | null | undefined,
): Promise<PortCalendar | undefined> {
  if (!port || !port.trim()) return undefined;

  const { data: calendar, error } = await db
    .from("port_calendars")
    .select("id, source, port_label")
    .eq("company_id", companyId)
    .eq("port_key", normalizePortKey(port))
    .maybeSingle();

  // A calendar lookup must never break a recompute: a claim without one is the
  // normal case, so a failure here degrades to "no calendar" rather than
  // failing the calculation.
  if (error || !calendar) return undefined;

  const { data: days } = await db
    .from("port_calendar_days")
    .select("calendar_date")
    .eq("calendar_id", calendar.id)
    .eq("status", "confirmed")
    .order("calendar_date", { ascending: true });

  const holidays = (days ?? []).map((d) => String(d.calendar_date));
  if (holidays.length === 0) return undefined;

  return { holidays, source: calendar.source };
}

/**
 * Attaches the calendar to a claim's terms, if one exists.
 *
 * Returns the terms unchanged when there is no calendar, so callers can apply
 * this unconditionally without changing behaviour for the vast majority of
 * claims that have none.
 */
export async function withPortCalendar<T extends { port_calendar?: PortCalendar }>(
  db: SupabaseClient,
  cpTerms: T,
  companyId: string,
  port: string | null | undefined,
): Promise<T> {
  // An explicit calendar already on the terms wins: a caller running a
  // counterfactual ("what if this port kept no holidays?") must not have the
  // stored calendar silently reimposed on top.
  if (cpTerms.port_calendar) return cpTerms;

  const calendar = await loadPortCalendar(db, companyId, port);
  return calendar ? { ...cpTerms, port_calendar: calendar } : cpTerms;
}
