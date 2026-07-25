import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";
import { verifyChain } from "@/lib/audit/security-log";
import { EVENT_COLUMNS, serializeEvent } from "@/lib/audit/query";

// Chain integrity check: recompute every hash in this company's audit trail
// from the stored columns and report whether the rows are the rows that were
// written.
//
// GET, not POST: it changes nothing. It is deliberately something any member
// of the tenant can run for themselves, unannounced — a verification you have
// to ask the vendor to perform proves considerably less.

// Page size for the walk. The chain must be read in full and in order to be
// verified, so this is a fetch loop, not a filter.
const PAGE = 1000;
// Ceiling on one verification pass. A tenant with a longer trail gets an
// honest `truncated: true` rather than a request that quietly times out.
const MAX_ENTRIES = 20_000;

export async function GET() {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const rows: Record<string, unknown>[] = [];
    let afterSeq = 0;
    let truncated = false;

    for (;;) {
      const { data, error } = await supabase
        .from("security_events")
        .select(EVENT_COLUMNS)
        .eq("company_id", auth.companyId)
        .gt("seq", afterSeq)
        .order("seq", { ascending: true })
        .limit(PAGE);

      if (error) {
        console.error("[security/verify/GET] query failed", error);
        throw new Error("AUDIT_UNAVAILABLE");
      }
      if (!data || data.length === 0) break;

      const page = data as unknown as Record<string, unknown>[];
      rows.push(...page);
      afterSeq = Number(page[page.length - 1].seq);

      if (page.length < PAGE) break;
      if (rows.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
    }

    const verdict = verifyChain(rows.map(serializeEvent));

    return NextResponse.json({
      verification: {
        ...verdict,
        truncated,
        // Spelled out because "ok: true" over a partial window would otherwise
        // be read as a stronger statement than it is.
        statement: describe(verdict.ok, verdict.anchored, truncated, verdict.checked),
      },
    });
  } catch (e) {
    return apiError(e, "security/verify/GET", { AUDIT_UNAVAILABLE: 503 });
  }
}

function describe(ok: boolean, anchored: boolean, truncated: boolean, checked: number): string {
  if (checked === 0) return "No audit entries have been recorded for this company yet.";
  if (!ok) {
    return `Chain verification FAILED over ${checked} entr${checked === 1 ? "y" : "ies"}. At least one entry has been altered or removed since it was written.`;
  }
  const scope = anchored
    ? `all ${checked} entr${checked === 1 ? "y" : "ies"} from the start of the chain`
    : `${checked} entr${checked === 1 ? "y" : "ies"}`;
  const caveat = truncated
    ? " Verification stopped at the page limit, so later entries were not checked."
    : anchored
      ? " Entries removed from the end of the chain cannot be detected from within it; pin the head hash externally to close that gap."
      : " This window does not start at the beginning of the chain, so it vouches only for itself.";
  return `Chain intact across ${scope}.${caveat}`;
}
