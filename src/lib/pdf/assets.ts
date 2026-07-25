// Where pdf.js finds its runtime assets — the browser half.
//
// pdf.js fetches character maps, standard fonts and its WASM image decoders at
// runtime from URLs the caller provides. All three parameters default to null,
// and pdf.js only complains when a document actually needs one — so a text PDF
// renders and a scanned or CJK one throws. Both call sites (the workspace
// viewer and the server-side extraction pipeline) configure them from this
// module pair so they cannot drift apart.
//
// This file is imported by a client component and therefore must stay free of
// node: imports; the filesystem half lives in assets-server.ts, following the
// same -server suffix convention as recompute-server.ts and friends.
//
// pdf.js requires a trailing slash on each path — it concatenates the filename
// directly and throws "Invalid factory url" without one.
//
// Assets are produced by scripts/sync-pdfjs-assets.ts, which runs from
// `bun run dev` and `bun run build`.

export interface PdfjsAssetOptions {
  cMapUrl: string;
  // pdfjs-dist ships its cmaps pre-compressed; without this flag they are
  // parsed as raw and every CJK glyph comes out wrong.
  cMapPacked: true;
  standardFontDataUrl: string;
  wasmUrl: string;
}

export const PDFJS_PUBLIC_SUBPATH = "pdfjs";

/** Browser-side: URL paths served out of public/. */
export function pdfjsClientAssets(): PdfjsAssetOptions {
  return {
    cMapUrl: `/${PDFJS_PUBLIC_SUBPATH}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `/${PDFJS_PUBLIC_SUBPATH}/standard_fonts/`,
    wasmUrl: `/${PDFJS_PUBLIC_SUBPATH}/wasm/`,
  };
}
