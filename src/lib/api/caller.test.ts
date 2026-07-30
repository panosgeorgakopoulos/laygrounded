import { describe, expect, test, mock, afterEach } from "bun:test";
import { isApiKeyRequest, callerRateLimitHeaders, type ResolvedCaller } from "./caller";
import { API_SCOPES } from "./keys";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/api/v1/claims/x/calculate", {
    method: "POST",
    headers,
  });
}

describe("isApiKeyRequest — mechanism selection", () => {
  test("no Authorization header is a session request", () => {
    expect(isApiKeyRequest(req())).toBe(false);
  });

  test("any Authorization header selects the API-key path", () => {
    expect(isApiKeyRequest(req({ authorization: "Bearer lga_abc" }))).toBe(true);
  });

  // THE boundary. A browser sends its session cookie on every fetch, so an
  // integrator testing a key from a logged-in tab presents BOTH. If a bad key
  // could fall through to the session, it would silently succeed with the
  // user's full privileges and the key's scope and quota would never apply —
  // and it would look like the API working.
  test("a MALFORMED key still selects the API-key path — it never falls back to the session", () => {
    expect(isApiKeyRequest(req({ authorization: "Bearer not-a-real-key" }))).toBe(true);
  });

  test("an empty Bearer value still selects the API-key path", () => {
    expect(isApiKeyRequest(req({ authorization: "Bearer " }))).toBe(true);
  });

  test("a non-Bearer Authorization scheme still selects the API-key path", () => {
    // Basic auth is not supported, and must fail as a key rather than quietly
    // becoming a session request.
    expect(isApiKeyRequest(req({ authorization: "Basic dXNlcjpwYXNz" }))).toBe(true);
  });

  test("whitespace-only Authorization is treated as absent", () => {
    expect(isApiKeyRequest(req({ authorization: "   " }))).toBe(false);
  });
});

describe("callerRateLimitHeaders", () => {
  const apiCaller: ResolvedCaller = {
    kind: "api_key",
    companyId: "co-1",
    companyName: "Test Co",
    userId: null,
    scopes: ["calculations:read"],
    keyId: "key-1",
    rateLimitPerMinute: 120,
    client: {} as never,
  };

  test("an API-key caller gets limit and reset headers", () => {
    const h = callerRateLimitHeaders(apiCaller, new Date("2026-03-01T12:00:30Z"));
    expect(h["X-RateLimit-Limit"]).toBe("120");
    // Window is the clock minute, so reset is 12:01:00.
    expect(h["X-RateLimit-Reset"]).toBe(String(Math.floor(Date.UTC(2026, 2, 1, 12, 1, 0) / 1000)));
  });

  test("a session caller gets NO quota headers", () => {
    // Emitting zeros would tell an integrator their key was throttled when no
    // key was used at all.
    const session: ResolvedCaller = {
      ...apiCaller,
      kind: "session",
      userId: "user-1",
      scopes: null,
      keyId: null,
      rateLimitPerMinute: null,
    };
    expect(callerRateLimitHeaders(session)).toEqual({});
  });
});

describe("scope surface", () => {
  test("every scope the routes reference exists in API_SCOPES", () => {
    const used = [
      "voyages:write",
      "calculations:read",
      "calculations:write",
      "disputes:read",
      "pnl:read",
      "documents:read",
      "compliance:read",
      "webhooks:manage",
    ];
    for (const s of used) expect(API_SCOPES).toContain(s as never);
  });

  // Key management must never be reachable with a key: one leaked credential
  // would otherwise mint its own replacements, and revocation would stop
  // being a remedy.
  test("there is no scope that grants key management", () => {
    for (const s of API_SCOPES) {
      expect(s.startsWith("keys:")).toBe(false);
    }
  });
});
