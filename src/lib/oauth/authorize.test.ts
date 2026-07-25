import { describe, test, expect } from "bun:test";
import { validateAuthorizeRequest, buildRedirect } from "./authorize";
import { deriveS256Challenge } from "./tokens";

const CHALLENGE = deriveS256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
const ALLOWLIST = ["https://client.example/cb"];

const base = {
  response_type: "code",
  client_id: "lgmcp_abc",
  redirect_uri: "https://client.example/cb",
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
  scope: "claims:read analysis:read",
  state: "xyz",
};

describe("validateAuthorizeRequest — fatal (must NOT redirect)", () => {
  test("unknown client is fatal", () => {
    const v = validateAuthorizeRequest(base, null);
    expect(v.kind).toBe("fatal");
    if (v.kind === "fatal") expect(v.error).toBe("invalid_client");
  });

  test("a redirect_uri not on the allowlist is fatal — the core anti-open-redirect rule", () => {
    const v = validateAuthorizeRequest(
      { ...base, redirect_uri: "https://attacker.example/steal" },
      ALLOWLIST
    );
    expect(v.kind).toBe("fatal");
  });

  test("substring/prefix of an allowed URI is still rejected (exact match only)", () => {
    const v = validateAuthorizeRequest(
      { ...base, redirect_uri: "https://client.example/cb/../evil" },
      ALLOWLIST
    );
    expect(v.kind).toBe("fatal");
  });

  test("missing client_id or redirect_uri is fatal", () => {
    expect(validateAuthorizeRequest({ ...base, client_id: null }, null).kind).toBe("fatal");
    expect(validateAuthorizeRequest({ ...base, redirect_uri: null }, ALLOWLIST).kind).toBe("fatal");
  });
});

describe("validateAuthorizeRequest — redirectable (target already trusted)", () => {
  test("an implicit-flow response_type redirects back with an error, carrying state", () => {
    const v = validateAuthorizeRequest({ ...base, response_type: "token" }, ALLOWLIST);
    expect(v.kind).toBe("redirect");
    if (v.kind === "redirect") {
      expect(v.error).toBe("unsupported_response_type");
      expect(v.state).toBe("xyz");
    }
  });

  test("missing PKCE challenge is refused — PKCE is mandatory", () => {
    const v = validateAuthorizeRequest({ ...base, code_challenge: null }, ALLOWLIST);
    expect(v.kind).toBe("redirect");
    if (v.kind === "redirect") expect(v.error).toBe("invalid_request");
  });

  test("a non-S256 challenge method is refused, never silently upgraded", () => {
    const v = validateAuthorizeRequest({ ...base, code_challenge_method: "plain" }, ALLOWLIST);
    expect(v.kind).toBe("redirect");
  });

  test("a malformed challenge is refused", () => {
    const v = validateAuthorizeRequest({ ...base, code_challenge: "too-short" }, ALLOWLIST);
    expect(v.kind).toBe("redirect");
  });

  test("an unknown scope is refused, not silently dropped", () => {
    const v = validateAuthorizeRequest({ ...base, scope: "claims:read admin:all" }, ALLOWLIST);
    expect(v.kind).toBe("redirect");
    if (v.kind === "redirect") expect(v.error).toBe("invalid_scope");
  });
});

describe("validateAuthorizeRequest — success", () => {
  test("a well-formed request validates and parses its scopes", () => {
    const v = validateAuthorizeRequest(base, ALLOWLIST);
    expect(v.kind).toBe("ok");
    if (v.kind === "ok") {
      expect(v.request.scope).toEqual(["claims:read", "analysis:read"]);
      expect(v.request.codeChallenge).toBe(CHALLENGE);
      expect(v.request.state).toBe("xyz");
    }
  });

  test("empty scope is allowed and means no scopes", () => {
    const v = validateAuthorizeRequest({ ...base, scope: "" }, ALLOWLIST);
    expect(v.kind).toBe("ok");
    if (v.kind === "ok") expect(v.request.scope).toEqual([]);
  });

  test("the resource parameter (RFC 8707) is carried through", () => {
    const v = validateAuthorizeRequest(
      { ...base, resource: "https://app.example/api/mcp" },
      ALLOWLIST
    );
    if (v.kind === "ok") expect(v.request.resource).toBe("https://app.example/api/mcp");
  });
});

describe("buildRedirect", () => {
  test("appends params without dropping an existing query", () => {
    const url = buildRedirect("https://client.example/cb?foo=1", { code: "abc", state: "xyz" });
    const u = new URL(url);
    expect(u.searchParams.get("foo")).toBe("1");
    expect(u.searchParams.get("code")).toBe("abc");
    expect(u.searchParams.get("state")).toBe("xyz");
  });

  test("skips null/undefined values", () => {
    const url = buildRedirect("https://client.example/cb", { code: "abc", state: null });
    expect(new URL(url).searchParams.has("state")).toBe(false);
  });
});
