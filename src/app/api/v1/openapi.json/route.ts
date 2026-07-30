import { NextRequest, NextResponse } from "next/server";
import { buildOpenApiSpec } from "@/lib/api/openapi";

// GET /api/v1/openapi.json — the machine-readable contract.
//
// Public and unauthenticated on purpose: an integrator needs to read the spec
// and generate a client BEFORE they have a key, and the document describes
// only the shape of the API, never any tenant's data.
export async function GET(req: NextRequest) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin;
  return NextResponse.json(buildOpenApiSpec(baseUrl), {
    headers: {
      // Cacheable: it changes only when the API does.
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
