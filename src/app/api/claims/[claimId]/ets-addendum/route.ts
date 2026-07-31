import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { buildCarbonCostOfDelay, type MarineFuel } from "@/lib/compliance/emissions";
import { resolveEeaPort } from "@/lib/compliance/eea-ports";
import { buildEtsAddendum } from "@/lib/compliance/ets-addendum";
import { renderEtsAddendumPdf } from "@/lib/compliance/ets-addendum-pdf";
import { fetchEuaPrice } from "@/lib/market/carbon-price";

// The EU-ETS carbon liability addendum for one claim.
//
// `?format=pdf` returns the document; otherwise JSON for the dashboard.
//
// EVERYTHING IS REGENERATED SERVER-SIDE FROM THE CLAIM. Nothing is rendered
// from figures a client posts back — the same rule as the weather report, and
// it matters more here because this document allocates a liability between two
// NAMED parties. A caller able to supply its own numbers could mint an
// official-looking LayGrounded demand for any amount against anyone.

async function build(
  claimId: string,
  companyId: string,
  companyName: string,
  userEmail: string
) {
  const supabase = await createClient();

  const { data: claim } = await supabase
    .from("claims")
    // Verified against the catalog: `claims` has ONE `counterparty_name`, not
    // separate charterer/owner columns. tsc cannot see a wrong column name in
    // supabase-js, so this list was checked rather than assumed.
    .select(
      "id, company_id, vessel, voyage_ref, port, cargo, counterparty_name, ets_applicable, has_bimco_ets_clause, tenant_role"
    )
    .eq("id", claimId)
    .maybeSingle();

  // Defense in depth alongside RLS, as every claim-scoped route does.
  if (!claim || claim.company_id !== companyId) throw new Error("CLAIM_NOT_FOUND");

  const { data: calc } = await supabase
    .from("laytime_calculations")
    .select("used_hours, allowed_hours, demurrage_amount, currency, computed_at")
    .eq("claim_id", claimId)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!calc) throw new Error("NO_CALCULATION");

  const delayHours = Math.max(0, (calc.used_hours ?? 0) - (calc.allowed_hours ?? 0));

  const resolved = resolveEeaPort(claim.port);
  const eeaPort = claim.ets_applicable ?? resolved.eeaPort;
  const etsScopeBasis =
    claim.ets_applicable != null ? "EU ETS applicability set explicitly on the claim." : resolved.reason;

  const nowISO = new Date().toISOString();
  const quote = await fetchEuaPrice(process.env, nowISO);

  const carbonCost = buildCarbonCostOfDelay({
    delayHours,
    eeaPort,
    // The delay's own year, not today's — phase-in is a property of when it
    // happened.
    year: new Date(calc.computed_at ?? nowISO).getUTCFullYear(),
    euaPriceEur: quote.priceEur,
    demurrageAmount: calc.demurrage_amount ?? undefined,
    currency: calc.currency ?? undefined,
  });

  // PARTY ROLES, now READ rather than inferred.
  //
  // `tenant_role` says which side this company is on, so the two named parties
  // follow from it instead of from the engine's money convention. When it is
  // unrecorded the addendum declines to give the amount a direction — the same
  // discipline as the clause flag, and the reason this column exists.
  const tenantRole = (claim.tenant_role ?? null) as "owner" | "charterer" | "trader" | null;
  const counterparty = claim.counterparty_name || null;
  const tenant = companyName || null;

  const owner = tenantRole === "charterer" ? counterparty : tenant;
  const charterer = tenantRole === "charterer" ? tenant : counterparty;

  const addendum = buildEtsAddendum({
    claim: {
      id: claim.id,
      vessel: claim.vessel,
      voyageRef: claim.voyage_ref,
      port: claim.port,
      cargo: claim.cargo,
      charterer,
      owner,
    },
    carbonCost,
    hasBimcoEtsClause: claim.has_bimco_ets_clause ?? null,
    tenantRole,
    euaPriceEur: quote.priceEur,
    euaPriceProvenance: quote.provenance,
    etsScopeBasis,
    issuedAtISO: nowISO,
  });

  return {
    claim,
    calc,
    carbonCost,
    addendum,
    quote,
    owner,
    charterer,
    tenantRole,
    requestedBy: userEmail,
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const auth = await requireAuth();
    const built = await build(
      claimId,
      auth.companyId,
      auth.companyName ?? "",
      auth.email ?? "unknown"
    );

    if (req.nextUrl.searchParams.get("format") === "pdf") {
      const bytes = await renderEtsAddendumPdf({
        addendum: built.addendum,
        claim: {
          vessel: built.claim.vessel,
          voyageRef: built.claim.voyage_ref,
          port: built.claim.port,
          cargo: built.claim.cargo,
          charterer: built.charterer,
          owner: built.owner,
        },
        requestedBy: built.requestedBy,
      });

      const safeVessel = String(built.claim.vessel ?? "claim")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .slice(0, 60);

      return new NextResponse(bytes as unknown as BodyInit, {
        headers: {
          "Content-Type": "application/pdf",
          // `attachment` rather than inline: a PDF rendered in-page from a
          // same-origin response is a needless script-execution surface.
          "Content-Disposition": `attachment; filename="ets-addendum-${safeVessel}.pdf"`,
          "Cache-Control": "no-store, private",
        },
      });
    }

    return NextResponse.json({
      addendum: built.addendum,
      carbonCost: built.carbonCost,
      euaPrice: {
        priceEur: built.quote.priceEur,
        quoteDate: built.quote.quoteDate,
        provenance: built.quote.provenance,
      },
      claim: {
        vessel: built.claim.vessel,
        voyageRef: built.claim.voyage_ref,
        port: built.claim.port,
        cargo: built.claim.cargo,
        charterer: built.charterer,
        owner: built.owner,
        hasBimcoEtsClause: built.claim.has_bimco_ets_clause ?? null,
        tenantRole: built.tenantRole,
      },
    });
  } catch (e) {
    return apiError(e, "claims/ets-addendum", { NO_CALCULATION: 409 });
  }
}

/** Records whether the charterparty carries an ETS clause. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const auth = await requireAuth();
    const body = await req.json().catch(() => ({}));

    // Both fields are optional; a request may set either or both.
    const hasClause = body?.hasBimcoEtsClause;
    const role = body?.tenantRole;
    const ROLES = ["owner", "charterer", "trader"];

    if (role !== undefined && role !== null && !ROLES.includes(role)) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: `tenantRole must be one of ${ROLES.join(", ")}, or null.` },
        { status: 400 }
      );
    }

    const value = hasClause;
    // Tri-state on purpose: null clears the record back to "not checked", which
    // is a different statement from "no clause".
    if (value !== undefined && value !== true && value !== false && value !== null) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "hasBimcoEtsClause must be true, false or null." },
        { status: 400 }
      );
    }
    if (value === undefined && role === undefined) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "Supply hasBimcoEtsClause, tenantRole, or both." },
        { status: 400 }
      );
    }

    const supabase = await createClient();
    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (value !== undefined) patch.has_bimco_ets_clause = value;
    if (role !== undefined) patch.tenant_role = role;

    const { error } = await supabase.from("claims").update(patch).eq("id", claimId);
    if (error) throw new Error(error.message);

    return NextResponse.json({ hasBimcoEtsClause: value ?? null, tenantRole: role ?? null });
  } catch (e) {
    return apiError(e, "claims/ets-addendum/PATCH");
  }
}
