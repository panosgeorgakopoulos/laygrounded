// The counterparty statement, as JSON and as CSV.
//
// A DEDICATED ROUTE, not a mode on the room API. The two surfaces return
// genuinely different projections — the room carries proposals and a live
// redline, this carries an allowlisted evidence view — and a single endpoint
// branching on the token's mode is one `if` away from returning the wrong one.
// Separate routes make the mismatch a 404 instead of a leak.
//
// GET ?format=csv returns the spreadsheet a claims department will actually
// work in. Same projection either way: the CSV is built from the same
// `StatementView`, so it cannot contain a field the JSON does not.

import { NextRequest, NextResponse } from "next/server";
import { resolveShareForMode } from "@/lib/rooms";
import { loadStatementView } from "@/lib/sharing/statement-view-server";
import { claimToCsv, csvFileBody, csvFilename } from "@/lib/export-csv";
import { apiError } from "@/lib/api-errors";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;

    // READONLY ONLY. A negotiation-room token presented here resolves to null
    // and 404s, exactly as an unknown or revoked one does — the holder is never
    // told that their token is real but pointed at the wrong surface.
    const resolved = await resolveShareForMode(token, "readonly");
    if (!resolved) {
      return NextResponse.json({ error: "SHARE_NOT_FOUND" }, { status: 404 });
    }

    const view = await loadStatementView(resolved);

    if (req.nextUrl.searchParams.get("format") === "csv") {
      const csv = claimToCsv({
        header: {
          vessel: view.claim.vessel,
          voyageRef: view.claim.voyageRef,
          port: view.claim.port,
          cargo: view.claim.cargo,
          cpForm: view.claim.cpForm,
          engineVersion: view.verifier.engineVersion,
          // Only when it is real. An empty root is left empty rather than
          // rendered as a plausible-looking blank that reads as "verified".
          conformanceRoot: view.verifier.available ? view.verifier.conformanceRoot : null,
          generatedAt: view.generatedAt,
        },
        totals: view.calculation?.totals ?? null,
        breakdown: view.calculation?.breakdown ?? [],
        events: view.events,
      });

      return new NextResponse(csvFileBody(csv), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${csvFilename(
            [view.claim.vessel, view.claim.voyageRef],
            "laytime-statement"
          )}"`,
          // A share link is a credential in a URL. Nothing behind it may be
          // cached by an intermediary or indexed.
          "Cache-Control": "no-store, private",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    }

    return NextResponse.json(view, {
      headers: { "Cache-Control": "no-store, private", "X-Robots-Tag": "noindex, nofollow" },
    });
  } catch (e) {
    return apiError(e, "share/claim/GET", { SHARE_NOT_FOUND: 404 });
  }
}
