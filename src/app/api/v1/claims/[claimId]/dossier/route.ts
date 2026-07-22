import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { buildAuditDossier } from "@/lib/legal/prosecution";
import { proofAsOf } from "@/lib/legal/notary-server";

// Third-party auditor export: the claim's proven state at a given instant.
//
//   GET ?asOf=2026-03-04T14:00:00Z        → the proof in force at 14:00
//   GET                                    → the current proof
//   GET ?format=markdown                   → the dossier document
//
// Because the sweep only writes a proof when the root changed, the proof in
// force at an instant is the latest one recorded at or before it — the
// previous proof stands until something actually changed. That is what makes
// "the exact state at 14:00" answerable without a proof for every hour.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const auth = await requireAuth();
    const supabase = await createClient();

    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id, vessel, voyage_ref, port")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");

    const asOfRaw = req.nextUrl.searchParams.get("asOf");
    const at = asOfRaw ? new Date(asOfRaw) : new Date();
    if (Number.isNaN(at.getTime())) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: "asOf must be an ISO 8601 timestamp" },
        { status: 400 }
      );
    }

    const proof = await proofAsOf(supabase, claimId, at);
    // No proof at or before that instant means the record was not yet
    // notarized then. Say so — do not fall forward to a later proof, which
    // would attest to a state that did not exist at the time asked about.
    if (!proof) throw new Error("NO_PROOF_AS_OF");

    const anchor = proof.anchor;
    const independentlyTimestamped = anchor?.anchored === true;

    if (req.nextUrl.searchParams.get("format") === "markdown") {
      const base = buildAuditDossier(
        {
          claimId,
          algo: proof.algo as "sha256-merkle-v1",
          asOf: proof.asOf,
          merkleRoot: proof.merkleRoot,
          leafCount: proof.leaves.length,
          leaves: proof.leaves,
        },
        { vessel: claim.vessel, voyageRef: claim.voyage_ref, port: claim.port }
      );

      // The dossier must be explicit about what the timestamp rests on.
      // Without an anchor, `asOf` is LayGrounded's own assertion — an auditor
      // is entitled to know that before relying on it.
      const timestampSection = independentlyTimestamped
        ? `## Independent timestamp

This fingerprint was submitted to a Time-Stamp Authority (RFC 3161) at
${anchor.requestedAt} and returned a signed timestamp token
(status: ${anchor.status === 0 ? "granted" : "grantedWithMods"}, TSA: ${anchor.tsaUrl}).

The token is attached to this proof as base64 (\`details.anchor.token\`). It
proves the fingerprint above existed at the time the TSA signed it —
independently of LayGrounded's clock. Verify it without us:

\`\`\`
base64 -d token.b64 > token.tsr
openssl ts -reply -in token.tsr -token_in -text     # read the signed time
openssl ts -verify -in token.tsr -token_in \\
  -digest <sha256 of the Merkle root string above> \\
  -CAfile <the TSA's CA certificate>
\`\`\`
`
        : `## Independent timestamp — NONE

This fingerprint was NOT independently timestamped${anchor?.detail ? `: ${anchor.detail}` : "."}

The proof therefore establishes the **integrity** of the record — any change to
a timestamp, clause or computed hour alters the fingerprint — but NOT the time
at which it was taken. The as-of time above is asserted by LayGrounded, and a
party relying on it is trusting LayGrounded's clock and good faith. To obtain
an independent time, anchor future proofs to a Time-Stamp Authority
(\`ANCHOR_PROVIDER=rfc3161\`, \`TSA_URL\`).
`;

      return new NextResponse(`${base}\n\n${timestampSection}`, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="dossier-${claim.voyage_ref}-${proof.asOf.slice(0, 10)}.md"`,
        },
      });
    }

    return NextResponse.json({
      claimId,
      queriedAt: at.toISOString(),
      proof: {
        id: proof.id,
        merkleRoot: proof.merkleRoot,
        algo: proof.algo,
        asOf: proof.asOf,
        recordedAt: proof.recordedAt,
        leafCount: proof.leaves.length,
        leaves: proof.leaves,
      },
      anchor,
      // Stated as a field, not left for the reader to infer from anchor===null.
      independentlyTimestamped,
      integrityOnlyNotice: independentlyTimestamped
        ? null
        : "This proof establishes record integrity but not time: its as-of is asserted by LayGrounded, not by an independent authority.",
    });
  } catch (e) {
    return apiError(e, "v1/claims/dossier/GET", { NO_PROOF_AS_OF: 404 });
  }
}
