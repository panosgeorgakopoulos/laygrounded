// The claim owner's view of what makes this claim independently checkable.
//
// The bank-facing twin is `/api/v1/claims/[claimId]/verify`, which is redeemed
// against a grant token and never sees a Supabase session. This one is the
// mirror: the tenant looking at their own claim, seeing exactly what a
// counterparty would be handed, and able to download it.
//
// TWO KINDS OF HASH LIVE HERE AND THEY MUST NOT BE CONFLATED.
//
//   * `verifier.conformanceRoot` fingerprints the ENGINE. It is a behavioural
//     digest of what the artifact computes across 500 published cases, and it
//     is the SAME for every claim on that rule set. It answers "is this the
//     engine you say it is".
//   * `notarization.digest` is the Merkle root over THIS CLAIM's sealed state,
//     and it is what an RFC-3161 authority actually timestamped. It answers
//     "has this claim changed since it was sealed".
//
// Presenting the conformance root as if it were a per-claim hash would be
// actively misleading: it does not move when the claim changes, so a reader who
// believed it did would conclude a tampered claim was intact.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";
import { buildVerificationPackage } from "@/lib/finance/verification-package";
import { readVerifierManifest } from "@/lib/finance/verifier-manifest";
import { loadClaimComputationInputs } from "@/lib/laytime/recompute-server";
import {
  CALCULATION_RESULT_COLUMNS,
  calculationRowToResult,
  type PersistedCalculationRow,
} from "@/lib/laytime/calculation-row";
import { proofAsOf } from "@/lib/legal/notary-server";
import { buildDerivationRecord } from "@/lib/legal/derivation";
import { canonicalEventOrder } from "@laygrounded/laytime-core/gencon94";
import { resolveClaimEngineVersion } from "@/lib/laytime/engine-version";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const supabase = await createClient();

    const { data: claimRow } = await supabase
      .from("claims")
      .select("id, company_id, engine_version")
      .eq("id", claimId)
      .maybeSingle();
    if (!claimRow || claimRow.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    const { claim, cpTerms, sofInputs } = await loadClaimComputationInputs(claimId, supabase);
    const engineVersion = resolveClaimEngineVersion(claimRow);

    const { data: calc } = await supabase
      .from("laytime_calculations")
      .select(CALCULATION_RESULT_COLUMNS)
      .eq("claim_id", claimId)
      .maybeSingle<PersistedCalculationRow>();
    const publishedFigures = calc ? calculationRowToResult(calc) : null;

    const proof = await proofAsOf(supabase, claimId, new Date());

    const pkg = buildVerificationPackage({
      claim: {
        id: claim.id,
        vessel: claim.vessel,
        voyageRef: claim.voyage_ref,
        port: claim.port,
        cargo: claim.cargo,
      },
      cpTerms,
      events: sofInputs,
      publishedFigures,
      notarization: proof
        ? {
            digest: proof.merkleRoot,
            algorithm: proof.algo,
            anchoredAt: proof.recordedAt,
            authority: proof.anchor?.anchored ? proof.anchor.tsaUrl : null,
          }
        : null,
      // Version-aware: each rule set has its own suite and root.
      verifier: readVerifierManifest(engineVersion),
      // No grant: the owner is not redeeming a token against their own claim.
      grant: null,
    });

    // The canonical bundle, byte-for-byte what a counterparty runs the verifier
    // against.
    if (new URL(req.url).searchParams.get("download") === "1") {
      const safeRef = (claim.voyage_ref || claim.id).replace(/[^A-Za-z0-9._-]/g, "-");
      return new NextResponse(JSON.stringify(pkg, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="laygrounded-verification-${safeRef}.json"`,
          "Cache-Control": "no-store, private",
        },
      });
    }

    return NextResponse.json(
      {
        engine: {
          // Which RULE SET computed this claim. Not the package version.
          version: engineVersion,
          // Behavioural fingerprint of the engine as a whole, from the
          // notarised derivation record — the same value the sealed proof
          // commits to.
          fingerprint: buildDerivationRecord(
            canonicalEventOrder(sofInputs),
            cpTerms.port_timezone,
            engineVersion
          ).engine,
        },
        verifier: pkg.verifier,
        notarization: pkg.notarization,
        published: publishedFigures,
        counts: {
          confirmedEvents: sofInputs.length,
        },
        caveats: pkg.caveats,
        howToVerify: pkg.howToVerify,
        // So the UI can say what the download will contain without fetching it.
        bundleBytes: JSON.stringify(pkg).length,
      },
      { headers: { "Cache-Control": "no-store, private" } }
    );
  } catch (e) {
    return apiError(e, "claims/verification/GET");
  }
}
