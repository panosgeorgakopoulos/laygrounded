import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { redeemGrant } from "@/lib/finance/grants-server";
import { buildVerificationPackage } from "@/lib/finance/verification-package";
import { loadClaimComputationInputs } from "@/lib/laytime/recompute-server";
import { proofAsOf } from "@/lib/legal/notary-server";
import { readVerifierManifest } from "@/lib/finance/verifier-manifest";
import { bearerToken } from "@/lib/api/keys";

// The bank's endpoint: redeem a claim-scoped grant for an offline-verifiable
// package.
//
// AUTHORISATION SHAPE — the part that matters:
//
//   The claim is read FROM THE GRANT. The `claimId` in the path is treated as
//   an assertion to check for equality, never as a selector. A valid token
//   presented against a different claim is refused and ledgered as a traversal
//   attempt.
//
// This route deliberately does NOT use `resolveCaller`. A grant is not an API
// key and must not be usable as one: it opens a single claim, not a tenant.
// Keeping the two resolvers apart is what stops a leaked grant being replayed
// against the rest of the book.
//
// Every refusal returns the same opaque 404. Distinguishing "revoked" from
// "wrong claim" from "no such token" would tell a probing holder which of those
// it is, and a bank with a legitimately live token never sees any of them.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  const NOT_FOUND = NextResponse.json(
    {
      error: "NOT_FOUND",
      message:
        "No verification package is available for this token. It may have been revoked, expired, exhausted, or issued for a different claim.",
    },
    { status: 404 }
  );

  try {
    const { claimId } = await params;
    const token = bearerToken(req.headers.get("authorization")) ?? "";

    // Service role: a bank holds no Supabase session, so RLS cannot scope this.
    // The grant is the entire authorisation, which is why it is resolved before
    // anything else is read.
    const service = createServiceRoleClient();

    const redeemed = await redeemGrant(service, token, claimId, {
      userAgent: req.headers.get("user-agent"),
    });
    if (!redeemed.ok) return NOT_FOUND;

    const grant = redeemed.grant;

    // From here the claim id comes from the grant, not the URL. They are known
    // equal — redeemGrant refused otherwise — but using the grant's copy means
    // a future change to the path cannot reintroduce traversal.
    const { claim, cpTerms, sofInputs } = await loadClaimComputationInputs(
      grant.claimId,
      service
    );

    // Exactly the columns that exist. `time_on_demurrage_hours` and
    // `time_saved_hours` are NOT persisted, which is why the package publishes
    // a named subset rather than a whole LaytimeResult.
    const { data: calc } = await service
      .from("laytime_calculations")
      .select("breakdown, allowed_hours, used_hours, demurrage_amount, despatch_amount, currency")
      .eq("claim_id", grant.claimId)
      .maybeSingle();

    const publishedFigures = calc
      ? {
          allowedHours: calc.allowed_hours,
          usedHours: calc.used_hours,
          demurrageAmount: calc.demurrage_amount ?? 0,
          despatchAmount: calc.despatch_amount ?? 0,
          currency: calc.currency ?? "USD",
          breakdown: Array.isArray(calc.breakdown) ? calc.breakdown : [],
        }
      : null;

    const proof = await proofAsOf(service, grant.claimId, new Date());

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
            // The Merkle root over the claim's state at the time it was sealed —
            // what an RFC-3161 authority actually timestamped.
            digest: proof.merkleRoot,
            algorithm: proof.algo,
            anchoredAt: proof.recordedAt,
            authority: proof.anchor?.anchored ? proof.anchor.tsaUrl : null,
          }
        : null,
      verifier: readVerifierManifest(),
      grant: {
        institutionLabel: grant.institutionLabel,
        purpose: grant.purpose,
        expiresAt: grant.expiresAt,
        accessCount: grant.accessCount,
      },
    });

    return NextResponse.json(pkg, {
      headers: {
        // A verification package is a point-in-time artefact; caching one would
        // let a revoked grant keep serving from an intermediary.
        "Cache-Control": "no-store, private",
      },
    });
  } catch {
    // Any failure past redemption is still opaque to the holder: they learn
    // nothing about whether the claim exists.
    return NOT_FOUND;
  }
}
