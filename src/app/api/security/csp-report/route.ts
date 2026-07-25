import { NextRequest, NextResponse } from "next/server";

// CSP violation collector.
//
// A Content-Security-Policy that blocks something the app genuinely needs
// fails silently from the server's side: the browser refuses the resource and
// the user sees an empty panel. This endpoint is how that becomes visible.
//
// Deliberately unauthenticated — browsers post violation reports without
// credentials, and a report that required a session would never arrive for the
// sign-in page, which is exactly where a broken policy hurts most. That makes
// it a public write endpoint, so it is treated as hostile input:
//   - the body is size-capped before parsing,
//   - only known fields are read, each truncated,
//   - nothing is persisted or echoed back,
//   - the response is always 204 with no body, so it is useless as an oracle.
// The per-IP rate limit in src/proxy.ts applies here as it does to every /api
// route.

// Reports are small; anything larger is not a real one.
const MAX_BODY_BYTES = 8 * 1024;

function truncate(value: unknown, max = 300): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 204 });

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Browsers send either the legacy {"csp-report": {…}} shape (report-uri)
    // or an array of Reporting-API entries (report-to). Accept both.
    const reports: Record<string, unknown>[] = Array.isArray(parsed)
      ? parsed.map((r) => ((r as Record<string, unknown>)?.body ?? r) as Record<string, unknown>)
      : [(parsed["csp-report"] as Record<string, unknown>) ?? parsed];

    for (const r of reports) {
      if (!r) continue;
      const directive = truncate(r["effective-directive"] ?? r["effectiveDirective"] ?? r["violated-directive"], 60);
      const blocked = truncate(r["blocked-uri"] ?? r["blockedURL"]);
      const doc = truncate(r["document-uri"] ?? r["documentURL"]);
      if (!directive && !blocked) continue;
      // One line per violation, greppable in the server log. The directive is
      // the actionable part: it names which allowlist is too narrow.
      console.warn(`[csp] ${directive} blocked ${blocked || "(inline)"} on ${doc}`);
    }
  } catch {
    // Malformed report — nothing to learn, nothing to say.
  }

  // 204 regardless: the browser has nowhere to put an error, and a status that
  // varied with the payload would leak whether parsing succeeded.
  return new NextResponse(null, { status: 204 });
}
