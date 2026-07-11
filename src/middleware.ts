import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Basic in-memory rate limiting (Note: in production Vercel/serverless environments, this map resets often. Upstash Redis is recommended for true global rate limiting).
const rateLimitMap = new Map<string, { count: number; lastReset: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS = 100; // per minute

export function middleware(request: NextRequest) {
  // CORS Configuration (SEC-M3)
  const origin = request.headers.get('origin');
  
  // Rate Limiting (SEC-M1)
  const ip = request.headers.get('x-forwarded-for') || 
             request.headers.get('x-real-ip') || 
             'anonymous';
             
  const now = Date.now();
  
  if (request.nextUrl.pathname.startsWith('/api')) {
    const record = rateLimitMap.get(ip) || { count: 0, lastReset: now };
    
    if (now - record.lastReset > RATE_LIMIT_WINDOW) {
      record.count = 1;
      record.lastReset = now;
    } else {
      record.count++;
    }
    
    rateLimitMap.set(ip, record);
    
    if (record.count > MAX_REQUESTS) {
      return new NextResponse(
        JSON.stringify({ error: "TOO_MANY_REQUESTS" }), 
        { 
          status: 429, 
          headers: { 'Content-Type': 'application/json' } 
        }
      );
    }
  }

  // Authentication Redirect Logic
  const hasAuthCookie = request.cookies.getAll().some(c => c.name.startsWith('sb-') && c.name.endsWith('-auth-token'));
  
  if (hasAuthCookie) {
    const path = request.nextUrl.pathname;
    if (path === '/' || path === '/sign-in' || path === '/sign-up') {
      return NextResponse.redirect(new URL('/claims', request.url));
    }
  }

  // Next.js Response with CORS headers
  const response = NextResponse.next();
  
  // Add basic CORS headers
  if (origin) {
    response.headers.set('Access-Control-Allow-Origin', origin);
  }
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-init-secret');
  
  return response;
}

export const config = {
  matcher: ['/', '/sign-in', '/sign-up', '/api/:path*'],
};
