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
const AUDIT_API_PREFIX = '/api/v1/audit';
const MAX_REQUESTS_AUDIT = 2000; // per minute, per IP — DoS floor, not a quota

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

  // Preflight: answer here, only granting CORS to allowlisted origins.
  if (request.method === 'OPTIONS' && isApi) {
    const res = new NextResponse(null, { status: 204 });
    if (isAllowedOrigin(origin)) applyCorsHeaders(res, origin);
    return res;
  }

  // Rate limiting (API only).
  if (isApi) {
    const isAuditApi = request.nextUrl.pathname.startsWith(AUDIT_API_PREFIX);
    const ceiling = isAuditApi ? MAX_REQUESTS_AUDIT : MAX_REQUESTS;
    // Separate bucket: audit traffic must not consume the app's IP budget,
    // and vice versa.
    const key = `${isAuditApi ? 'audit:' : 'app:'}${clientKey(request)}`;
    const now = Date.now();
    const record = rateLimitMap.get(key) || { count: 0, lastReset: now };

    if (now - record.lastReset > RATE_LIMIT_WINDOW) {
      record.count = 1;
      record.lastReset = now;
    } else {
      record.count++;
    }
    rateLimitMap.set(key, record);

    if (record.count > ceiling) {
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
      return NextResponse.redirect(new URL('/claims', request.url));
    }
  }

  const response = NextResponse.next();
  // Only echo CORS for explicitly allowlisted cross-origin callers.
  if (isAllowedOrigin(origin)) applyCorsHeaders(response, origin);
  return response;
}

export const config = {
  matcher: ['/', '/sign-in', '/sign-up', '/api/:path*'],
};
