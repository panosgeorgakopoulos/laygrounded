import type { NextConfig } from "next";

// App-wide security response headers.
//
// The non-CSP set is the uncontroversial defence-in-depth layer:
//   - HSTS: force https for a year (ignored on plain-http localhost).
//   - X-Frame-Options: clickjacking defence for pre-CSP user agents; the
//     modern equivalent, frame-ancestors, is in the policy below.
//   - X-Content-Type-Options: no MIME sniffing.
//   - Referrer-Policy: never leak full URLs (they carry claim ids and room
//     tokens) to cross-origin destinations.
//   - Permissions-Policy: deny powerful features the app never uses.
//
// The CSP is assembled below from what the app actually loads, verified by
// reading the code rather than guessed:
//   - next/font/google self-hosts its fonts at build time, so no Google Fonts
//     origin is needed — font-src 'self' is enough.
//   - @vercel/analytics loads /_vercel/insights/script.js (SAME-ORIGIN) in
//     production and only reaches va.vercel-scripts.com in development.
//   - Supabase is contacted for auth, PostgREST and Storage over https. No
//     Realtime channel is ever opened (no .channel() call exists), so no
//     wss: origin is required.
//   - src/components/laygrounded/document-viewer.tsx renders a NON-PDF
//     document straight from its Supabase signed URL (<img src={documentUrl}>),
//     so the Supabase origin must be in img-src too — omitting it silently
//     breaks viewing every uploaded JPEG/PNG SoF.
//   - The same viewer rasterises PDFs to canvas and displays them as
//     data: URLs, and drives pdf.js through a same-origin worker at
//     /pdf.worker.min.mjs → img-src data: and worker-src 'self' blob:.
//   - Draft PDFs are downloaded via URL.createObjectURL → blob:.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
// Origin only: a CSP source must not carry a path, and a trailing slash makes
// some user agents reject the whole directive.
const supabaseOrigin = (() => {
  try {
    return SUPABASE_URL ? new URL(SUPABASE_URL).origin : "";
  } catch {
    return "";
  }
})();

const isDev = process.env.NODE_ENV !== "production";

function buildCsp(): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],

    // The honest limit of this policy. Next.js ships hydration state in inline
    // <script> tags, and this app is largely statically prerendered — a
    // per-request nonce would force every page into dynamic rendering, so
    // 'unsafe-inline' stays for now. What this directive still buys, and it is
    // not nothing: no script from any other origin can execute, which closes
    // CDN compromise and most injected-<script src> vectors. Tightening it
    // further is a real change (force-dynamic root layout + nonce plumbing),
    // not a header edit — see the note at the bottom of this file.
    //
    // 'wasm-unsafe-eval' is required, and was found by measuring rather than
    // predicting: a violation report showed WebAssembly being refused on the
    // claim workspace. pdf.js decodes scanned pages with WASM codecs
    // (jbig2.wasm, openjpeg.wasm) — precisely the formats a scanned Statement
    // of Facts arrives in — so without it, text-layer PDFs would render and
    // scanned ones would silently fail. It permits WebAssembly compilation
    // ONLY; it does not re-enable eval() or new Function() for JavaScript,
    // which is why it is used here in preference to 'unsafe-eval'.
    "script-src": ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"],

    // Next.js inlines critical CSS and CSS-module styles; Tailwind and the
    // component styles both set style attributes at runtime.
    "style-src": ["'self'", "'unsafe-inline'"],

    // data: — PDF pages rasterised to canvas; blob: — object URLs.
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'"],
    "worker-src": ["'self'", "blob:"],
    "media-src": ["'self'"],
    "manifest-src": ["'self'"],

    // The app embeds nothing and is embedded by nobody.
    "frame-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "object-src": ["'none'"],

    // Credentials and claim data must not be POSTable to another origin, and
    // a <base> tag must not be able to re-point every relative URL.
    "form-action": ["'self'"],
    "base-uri": ["'self'"],
  };

  if (supabaseOrigin) {
    // Auth, PostgREST and Storage fetches (incl. fetching a signed SoF URL).
    directives["connect-src"].push(supabaseOrigin);
    // Non-PDF documents are rendered directly from their signed URL.
    directives["img-src"].push(supabaseOrigin);
  }

  if (isDev) {
    // React Refresh compiles modules with eval, the dev overlay uses inline
    // workers, and HMR runs over a websocket. None of this reaches production.
    directives["script-src"].push("'unsafe-eval'", "https://va.vercel-scripts.com");
    directives["connect-src"].push("ws:", "wss:", "https://va.vercel-scripts.com");
  }

  // Opt-in: upgrade-insecure-requests breaks the plain-http docker stack
  // (Caddy serves http://localhost:81), so it is off unless asked for. Turn it
  // on once the deployment terminates TLS.
  if (process.env.CSP_UPGRADE_INSECURE === "1") {
    return [serialise(directives), "upgrade-insecure-requests"].join("; ");
  }
  return serialise(directives);
}

function serialise(directives: Record<string, string[]>): string {
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

// Rollout switch. A CSP that breaks a page fails SILENTLY from the server's
// point of view — the browser simply refuses to load something and the user
// sees a blank panel. Setting CSP_REPORT_ONLY=1 sends the identical policy as
// Content-Security-Policy-Report-Only: violations are reported to
// /api/security/csp-report and nothing is blocked. Run that way first in a new
// environment, watch the log, then unset it.
const CSP_HEADER_NAME =
  process.env.CSP_REPORT_ONLY === "1"
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";

const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  {
    key: CSP_HEADER_NAME,
    value: `${buildCsp()}; report-uri /api/security/csp-report`,
  },
];

const nextConfig: NextConfig = {
  output: "standalone",

  reactStrictMode: true,

  // The pure engine lives in an in-repo workspace package (open-sourced as
  // @laygrounded/laytime-core). It ships TypeScript source, so transpile it.
  transpilePackages: ["@laygrounded/laytime-core"],

  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;

// Next step for script-src, recorded so it is a decision rather than an
// oversight: drop 'unsafe-inline' by generating a nonce per request in
// src/proxy.ts, forwarding it on the request so Next stamps its inline
// scripts, and adding 'strict-dynamic'. That requires the root layout to opt
// out of static prerendering, since a prerendered page cannot carry a
// per-request nonce — pages would render server-side on every request. Worth
// doing, but it is an architecture change to measure, not a header tweak.
