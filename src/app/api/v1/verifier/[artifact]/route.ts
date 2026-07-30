import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { readVerifierManifest } from "@/lib/finance/verifier-manifest";

// Serves the offline verifier so a bank can check a claim without us.
//
// PUBLIC AND UNAUTHENTICATED, on purpose. These are build artefacts of an
// Apache-2.0 engine, identical for every tenant, and they contain no customer
// data. Requiring a credential to download the thing that lets you distrust us
// would defeat the point: a verifier you can only obtain from the party being
// verified is not independent. The digests in the manifest are what make the
// download trustworthy, not the access control on it.
//
// The allowlist is a fixed map rather than a path join on user input — the one
// place a filename parameter reaching the filesystem would be a traversal bug.
const ARTIFACTS: Record<string, { file: string; type: string }> = {
  "laygrounded-verify.wasm": {
    file: "laygrounded-verify.wasm",
    type: "application/wasm",
  },
  "laygrounded-verify.mjs": {
    file: "laygrounded-verify.mjs",
    type: "text/javascript; charset=utf-8",
  },
  "conformance.json": { file: "conformance.json", type: "application/json" },
  "manifest.json": { file: "manifest.json", type: "application/json" },
};

const DIST = join(process.cwd(), "packages", "laytime-verify", "dist");

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ artifact: string }> }
) {
  const { artifact } = await params;
  const entry = ARTIFACTS[artifact];
  if (!entry) {
    return NextResponse.json(
      { error: "NOT_FOUND", available: Object.keys(ARTIFACTS) },
      { status: 404 }
    );
  }

  let body: Buffer;
  try {
    body = readFileSync(join(DIST, entry.file));
  } catch {
    return NextResponse.json(
      {
        error: "VERIFIER_UNAVAILABLE",
        message: "The verifier artefacts are not present in this deployment. Run `bun run verify:build`.",
      },
      { status: 503 }
    );
  }

  const manifest = readVerifierManifest();
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": entry.type,
      "Content-Length": String(body.byteLength),
      // Immutable per build: the version and digest are in the headers so a
      // downloader can pin what they got without parsing the payload.
      "Cache-Control": "public, max-age=3600, immutable",
      "X-Verifier-Version": manifest.version,
      "X-Verifier-Wasm-Sha256": manifest.wasmSha256,
    },
  });
}
