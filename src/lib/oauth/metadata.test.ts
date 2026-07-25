import { describe, test, expect } from "bun:test";
import {
  normaliseIssuer,
  resolveIssuer,
  buildProtectedResourceMetadata,
  buildAuthorizationServerMetadata,
  OAUTH_SCOPES,
  MCP_ENDPOINT_PATH,
} from "./metadata";

describe("normaliseIssuer", () => {
  test("reduces a URL to scheme + host", () => {
    expect(normaliseIssuer("https://app.example.com/some/path?x=1")).toBe("https://app.example.com");
    expect(normaliseIssuer("https://app.example.com/")).toBe("https://app.example.com");
    expect(normaliseIssuer("http://localhost:3000")).toBe("http://localhost:3000");
  });

  test("keeps a non-default port, which is part of the identity", () => {
    expect(normaliseIssuer("https://app.example.com:8443/x")).toBe("https://app.example.com:8443");
  });

  test("rejects anything that is not an http(s) URL", () => {
    // An issuer is compared by exact string by every client; junk here would
    // publish a document nobody can match.
    expect(normaliseIssuer("javascript:alert(1)")).toBeNull();
    expect(normaliseIssuer("not a url")).toBeNull();
    expect(normaliseIssuer("")).toBeNull();
  });
});

describe("resolveIssuer", () => {
  test("configuration wins over the request", () => {
    const issuer = resolveIssuer("https://attacker.test/.well-known/oauth-authorization-server", {
      OAUTH_ISSUER_URL: "https://app.laygrounded.com",
    });
    expect(issuer).toBe("https://app.laygrounded.com");
  });

  test("a forged Host cannot redirect clients to another authorization server", () => {
    // The attack this prevents: publish metadata whose authorization_endpoint
    // points at a server the attacker controls, and any client that follows
    // discovery sends its user there to log in.
    const honest = resolveIssuer("https://evil.test/.well-known/oauth-authorization-server", {
      NEXTAUTH_URL: "https://app.laygrounded.com",
    });
    expect(buildAuthorizationServerMetadata(honest).authorization_endpoint).toBe(
      "https://app.laygrounded.com/oauth/authorize"
    );
  });

  test("prefers OAUTH_ISSUER_URL over NEXTAUTH_URL", () => {
    expect(
      resolveIssuer("http://localhost:3000/x", {
        OAUTH_ISSUER_URL: "https://a.example.com",
        NEXTAUTH_URL: "https://b.example.com",
      })
    ).toBe("https://a.example.com");
  });

  test("falls back to the request origin only when nothing is configured", () => {
    expect(resolveIssuer("http://localhost:3000/.well-known/x", {})).toBe("http://localhost:3000");
  });

  test("ignores a configured value that is not a usable URL", () => {
    expect(resolveIssuer("http://localhost:3000/x", { OAUTH_ISSUER_URL: "garbage" })).toBe(
      "http://localhost:3000"
    );
  });
});

describe("protected resource metadata (RFC 9728)", () => {
  const md = buildProtectedResourceMetadata("https://app.laygrounded.com");

  test("names the MCP endpoint as the resource identifier", () => {
    // This exact string is what a client must echo as the RFC 8707 `resource`
    // parameter and what the token endpoint stamps as the audience.
    expect(md.resource).toBe(`https://app.laygrounded.com${MCP_ENDPOINT_PATH}`);
  });

  test("points at this deployment as its own authorization server", () => {
    expect(md.authorization_servers).toEqual(["https://app.laygrounded.com"]);
  });

  test("accepts bearer tokens in the header only", () => {
    // A token in a query string ends up in access logs, Referer headers and
    // browser history.
    expect(md.bearer_methods_supported).toEqual(["header"]);
  });
});

describe("authorization server metadata (RFC 8414)", () => {
  const md = buildAuthorizationServerMetadata("https://app.laygrounded.com");

  test("advertises S256 PKCE and nothing else", () => {
    // Offering "plain" would let a client downgrade to a challenge that is
    // the verifier, which protects against nothing.
    expect(md.code_challenge_methods_supported).toEqual(["S256"]);
  });

  test("offers no grant type that OAuth 2.1 removed", () => {
    expect(md.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(md.grant_types_supported).not.toContain("implicit");
    expect(md.grant_types_supported).not.toContain("password");
    // Every token here acts as a specific human inside one company, so there
    // is no user-less flow.
    expect(md.grant_types_supported).not.toContain("client_credentials");
  });

  test("offers no response type that returns credentials in a URL fragment", () => {
    expect(md.response_types_supported).toEqual(["code"]);
    expect(md.response_types_supported).not.toContain("token");
  });

  test("lets a public client authenticate with none — PKCE is the binding", () => {
    expect(md.token_endpoint_auth_methods_supported).toContain("none");
  });

  test("every advertised endpoint is absolute and on the issuer", () => {
    for (const url of [
      md.authorization_endpoint,
      md.token_endpoint,
      md.registration_endpoint,
      md.revocation_endpoint,
    ]) {
      expect(url.startsWith("https://app.laygrounded.com/")).toBe(true);
    }
    expect(md.issuer).toBe("https://app.laygrounded.com");
  });

  test("the two documents advertise the same scopes", () => {
    expect(md.scopes_supported).toEqual([...OAUTH_SCOPES]);
    expect(buildProtectedResourceMetadata("https://x.test").scopes_supported).toEqual([
      ...OAUTH_SCOPES,
    ]);
  });

  test("scopes are least-privilege split, not one god scope", () => {
    expect(OAUTH_SCOPES).toContain("claims:read");
    expect(OAUTH_SCOPES).toContain("claims:write");
    // A client that only reads must be grantable read-only.
    expect(OAUTH_SCOPES.filter((s) => s.endsWith(":read")).length).toBeGreaterThan(0);
  });
});
