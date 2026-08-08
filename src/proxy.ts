import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Basic in-memory rate limiting. NOTE: in serverless/multi-instance
// deployments this map is per-instance and resets on cold start — it is a
// coarse safety net, not a global limiter. A shared store (Upstash Redis /
// Vercel KV) is tracked separately as the real fix.
const rateLimitMap = new Map<string, { count: number; lastReset: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS = 100; // per minute

// The Audit Trail API carries its own per-KEY quota, counted in Postgres so
// it holds across instances (src/lib/api/authenticate.ts). This IP ceiling
// must therefore sit well above it, or the contract a key is sold is a lie:
// at 100/min per IP, a key licensed for 1000/min gets 100, and several
// tenants behind one corporate NAT would share a single budget — the exact
// reasons quotas here are keyed by API key rather than by address.
//
// It stays in place as a crude anti-flood net for the unauthenticated case
// (bad keys are rejected on shape before touching the database, so they are
// cheap — but not free).
const V1_API_PREFIX = '/api/v1';
const MAX_REQUESTS_V1 = 2000; // per minute, per IP — DoS floor, not a quota
const PUBLIC_TOOLS_PREFIX = '/api/tools';
// Well under the app ceiling: unauthenticated, and every call costs an upstream
// geocode plus an archive fetch.
const MAX_REQUESTS_PUBLIC_TOOLS = 20;

// The OAuth 2.1 endpoints (/oauth/*) live OUTSIDE /api, so the ceilings above
// never saw them. They are unauthenticated by necessity — there is no API key
// to meter against — which makes a per-IP limit the only floor under a flood.
// Dynamic client registration (RFC 7591) is the sharp edge: a public, unauth'd
// write that inserts a row, with no server-side cap on how many (registerClient
// does not enforce one), so it gets its own, tighter bucket. The rest of the
// surface (authorize page loads, token exchange, refresh, revoke) is a handful
// of requests per real client, so a moderate ceiling clears legitimate use
// while still stopping a flood.
const OAUTH_PREFIX = '/oauth';
const OAUTH_REGISTER_PATH = '/oauth/register';
const CONGESTION_PATH = '/congestion';
const MAX_REQUESTS_OAUTH = 60; // per minute, per IP — the interactive auth dance
const MAX_REQUESTS_OAUTH_REGISTER = 15; // per minute, per IP — public write endpoint

// Which per-IP bucket (key prefix + ceiling) a request path falls into, or null
// if it is not rate-limited here. Separate prefixes so one surface's traffic
// never eats another's budget (audit keys carry their own Postgres-counted
// quota; the app and OAuth buckets are pure anti-flood).
function rateBucket(pathname: string): { prefix: string; ceiling: number } | null {
  if (pathname === OAUTH_REGISTER_PATH) {
    return { prefix: 'oauth-reg:', ceiling: MAX_REQUESTS_OAUTH_REGISTER };
  }
  if (pathname === OAUTH_PREFIX || pathname.startsWith(OAUTH_PREFIX + '/')) {
    return { prefix: 'oauth:', ceiling: MAX_REQUESTS_OAUTH };
  }
  // The public marketing tools are unauthenticated and each call costs upstream
  // requests, so they get their own tight ceiling well below the app's. This is
  // the anti-flood floor only — the real "3 per day" promise is counted in
  // Postgres (lib/tools/public-tools.ts), because an in-memory limiter cannot
  // hold a daily quota across a serverless fleet.
  if (pathname.startsWith(PUBLIC_TOOLS_PREFIX)) {
    return { prefix: 'tools:', ceiling: MAX_REQUESTS_PUBLIC_TOOLS };
  }
  if (pathname.startsWith('/api')) {
    return pathname.startsWith(V1_API_PREFIX)
      ? { prefix: 'v1:', ceiling: MAX_REQUESTS_V1 }
      : { prefix: 'app:', ceiling: MAX_REQUESTS };
  }
  return null;
}

// CORS allowlist. Cross-origin API access is denied by default; add trusted
// external origins via ALLOWED_ORIGINS (comma-separated). Same-origin requests
// from the app itself never need an Access-Control-Allow-Origin header, so the
// first-party frontend keeps working with an empty allowlist.
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
);

function isAllowedOrigin(origin: string | null): origin is string {
  return !!origin && ALLOWED_ORIGINS.has(origin);
}

function applyCorsHeaders(response: NextResponse, origin: string) {
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Vary', 'Origin');
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-init-secret');
  response.headers.set('Access-Control-Max-Age', '86400');
}

// Prefer the proxy-set x-real-ip (harder to spoof than the client-controllable
// x-forwarded-for chain). Falls back to the first forwarded hop, then a
// constant. Assumes deployment behind a trusted proxy.
function clientKey(request: NextRequest): string {
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return 'anonymous';
}

export function proxy(request: NextRequest) {
  const origin = request.headers.get('origin');
  const isApi = request.nextUrl.pathname.startsWith('/api');

  // Publication gate for the public congestion index.
  //
  // Enforced here rather than with notFound() in the page: by the time the page
  // body runs, response headers have already been flushed, so notFound() renders
  // the 404 view but still returns HTTP 200 — a soft 404 that search engines
  // index and that reads ambiguously for a switch governing whether
  // customer-derived data is published at all. Returning here makes the status
  // truthful, and keeps the flag a runtime decision rather than a build-time one.
  if (
    request.nextUrl.pathname === CONGESTION_PATH &&
    process.env.PUBLIC_CONGESTION_INDEX !== '1'
  ) {
    return new NextResponse(null, { status: 404 });
  }

  // API preflight: answer here, only granting CORS to allowlisted origins. The
  // /oauth routes answer their own OPTIONS (public discovery CORS), so they are
  // left to fall through.
  if (request.method === 'OPTIONS' && isApi) {
    const res = new NextResponse(null, { status: 204 });
    if (isAllowedOrigin(origin)) applyCorsHeaders(res, origin);
    return res;
  }

  // Per-IP rate limiting, per surface. Preflight is never counted — it reaches
  // no handler and costs nothing to answer.
  //
  // The E2E suite is exempt, and ONLY outside production. A single browser
  // walking the golden path loads a workspace with a dozen panels four times
  // over, which clears 100 requests/minute from one IP long before the run
  // finishes — the tests then failed on a 429 that surfaced as "Claim not
  // found", which looks exactly like a product bug and is not one.
  //
  // Gated the same way the synthetic AIS track is: opt-in AND non-production,
  // because a limiter that any environment variable can switch off is not a
  // limiter. In production this branch cannot be reached whatever is set.
  const e2eExempt =
    process.env.E2E_DISABLE_RATE_LIMIT === '1' && process.env.NODE_ENV !== 'production';
  const bucket =
    request.method === 'OPTIONS' || e2eExempt ? null : rateBucket(request.nextUrl.pathname);
  if (bucket) {
    const key = `${bucket.prefix}${clientKey(request)}`;
    const now = Date.now();
    const record = rateLimitMap.get(key) || { count: 0, lastReset: now };

    if (now - record.lastReset > RATE_LIMIT_WINDOW) {
      record.count = 1;
      record.lastReset = now;
    } else {
      record.count++;
    }
    rateLimitMap.set(key, record);

    if (record.count > bucket.ceiling) {
      const res = new NextResponse(JSON.stringify({ error: 'TOO_MANY_REQUESTS' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
      });
      if (isAllowedOrigin(origin)) applyCorsHeaders(res, origin);
      return res;
    }
  }

  // Authentication redirect logic.
  const hasAuthCookie = request.cookies
    .getAll()
    .some((c) => c.name.startsWith('sb-') && c.name.endsWith('-auth-token'));

  if (hasAuthCookie) {
    const path = request.nextUrl.pathname;
    if (path === '/' || path === '/sign-in' || path === '/sign-up') {
      // A signed-in user asking for the sign-in page usually wants the app, so
      // /claims is the right default. But `?next=` means they were sent here to
      // reach somewhere specific — and the case that matters is an invitation:
      // someone already signed in clicks an invite link, gets bounced here for
      // authentication they already have, and this redirect would then throw
      // the destination away and drop them on /claims. The invitation is never
      // accepted and the link looks broken.
      //
      // Same-site path destinations only, mirroring `safeNext()` in the
      // sign-in form: an absolute URL here would turn a proxy redirect into an
      // open redirect off the back of nothing but an auth cookie.
      const next = request.nextUrl.searchParams.get('next');
      const safeNext =
        next && next.startsWith('/') && !next.startsWith('//') ? next : '/claims';
      return NextResponse.redirect(new URL(safeNext, request.url));
    }
  }

  const response = NextResponse.next();
  // Only echo CORS for explicitly allowlisted cross-origin callers.
  if (isAllowedOrigin(origin)) applyCorsHeaders(response, origin);
  return response;
}

export const config = {
  matcher: ['/', '/sign-in', '/sign-up', '/congestion', '/api/:path*', '/oauth/:path*'],
};
