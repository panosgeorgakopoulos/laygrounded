import { NextRequest, NextResponse } from "next/server";
import { searchKnowledge } from "@/lib/knowledge/query";

// Public, unauthenticated full-text search over the Legal Knowledge Graph.
// Returns only public reference content; cached briefly at the edge. Rate
// limiting is the proxy's per-IP app bucket (/api).
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 200);
  const cpForm = url.searchParams.get("cp_form") || undefined;
  const hits = await searchKnowledge(q, { cpForm });
  return NextResponse.json(
    { query: q, count: hits.length, hits },
    { headers: { "Cache-Control": "public, max-age=300" } }
  );
}
