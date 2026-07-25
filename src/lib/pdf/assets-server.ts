// Where pdf.js finds its runtime assets — the Node half. See assets.ts for
// why these parameters must be set at all.
//
// The two environments resolve differently and are NOT interchangeable:
//   - Browser: DOMBinaryDataFactory fetches over HTTP  → a URL path.
//   - Node:    NodeBinaryDataFactory calls fs.readFile → a FILESYSTEM path.
// Handing the server a URL string fails at read time, which is why this is a
// separate function rather than a shared constant.

import { existsSync } from "node:fs";
import path from "node:path";
import { PDFJS_PUBLIC_SUBPATH, type PdfjsAssetOptions } from "./assets";

/**
 * Absolute filesystem paths to the pdf.js asset tree, or null when it is not
 * present.
 *
 * Resolution order matters because the process runs from three different
 * places: the repo root in development, `.next/standalone` for a local
 * production run, and /app in the container (where the Dockerfile copies
 * public/ next to server.js). node_modules is the last resort — Next's
 * standalone tracing follows imports, so it does not necessarily carry a
 * package's non-JS asset directories.
 */
export function pdfjsServerAssets(): PdfjsAssetOptions | null {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, "public", PDFJS_PUBLIC_SUBPATH),
    path.join(cwd, ".next", "standalone", "public", PDFJS_PUBLIC_SUBPATH),
    path.join(cwd, "node_modules", "pdfjs-dist"),
  ];

  for (const base of candidates) {
    if (existsSync(path.join(base, "wasm"))) {
      // Forward slash, not path.sep: pdf.js validates the trailing separator
      // as "/" and fs accepts forward slashes on every platform this runs on.
      const asDir = (name: string) => `${path.join(base, name)}/`;
      return {
        cMapUrl: asDir("cmaps"),
        cMapPacked: true,
        standardFontDataUrl: asDir("standard_fonts"),
        wasmUrl: asDir("wasm"),
      };
    }
  }

  // Returning null rather than a wrong path: the caller spreads this into
  // getDocument, so a missing tree leaves pdf.js exactly as it was before —
  // text PDFs keep working — instead of failing every document with an
  // unreadable ENOENT. The warning is how the gap gets noticed.
  console.warn(
    "[pdfjs] asset tree not found — scanned (JBIG2/JPEG2000) and CJK PDFs will fail to decode. " +
      "Run: bun scripts/sync-pdfjs-assets.ts"
  );
  return null;
}
