import { describe, test, expect } from "bun:test";
import {
  sha256,
  generateAuthCode,
  generateAccessToken,
  generateClientId,
  generateClientSecret,
  safeEqualHex,
  isValidCodeVerifier,
  isValidCodeChallenge,
  deriveS256Challenge,
  verifyPkce,
  parseScope,
  serialiseScope,
  narrowScope,
  AUTH_CODE_PREFIX,
  ACCESS_TOKEN_PREFIX,
  CLIENT_ID_PREFIX,
} from "./tokens";

describe("credential generation", () => {
  test("tokens carry their type prefix and a stored hash, never the plaintext", () => {
    const code = generateAuthCode();
    expect(code.plaintext.startsWith(AUTH_CODE_PREFIX)).toBe(true);
    expect(code.hash).toBe(sha256(code.plaintext));
    expect(code.hash).not.toContain(code.plaintext);
    expect(generateAccessToken().plaintext.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);
  });

  test("every credential is unique across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateAuthCode().plaintext);
    expect(seen.size).toBe(500);
  });

  test("client id is a public identifier with no secret material", () => {
    expect(generateClientId().startsWith(CLIENT_ID_PREFIX)).toBe(true);
  });

  test("a client secret round-trips through its hash", () => {
    const s = generateClientSecret();
    expect(sha256(s.plaintext)).toBe(s.hash);
  });
});

describe("safeEqualHex", () => {
  test("true only for identical strings", () => {
    expect(safeEqualHex("deadbeef", "deadbeef")).toBe(true);
    expect(safeEqualHex("deadbeef", "deadbee0")).toBe(false);
  });
  test("length mismatch is false, not a throw", () => {
    expect(safeEqualHex("abc", "abcd")).toBe(false);
  });
});

describe("PKCE (RFC 7636)", () => {
  // A real 43-char verifier and its true S256 challenge.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

  test("derives the S256 challenge as base64url of the SHA-256 digest", () => {
    const challenge = deriveS256Challenge(verifier);
    expect(isValidCodeChallenge(challenge)).toBe(true);
    // Deterministic: the same verifier always yields the same challenge.
    expect(deriveS256Challenge(verifier)).toBe(challenge);
  });

  test("the matching verifier proves the challenge", () => {
    const challenge = deriveS256Challenge(verifier);
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  test("a different verifier does NOT — the core PKCE guarantee", () => {
    const challenge = deriveS256Challenge(verifier);
    const attacker = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(verifyPkce(attacker, challenge)).toBe(false);
  });

  test("a malformed verifier is rejected before any compare", () => {
    expect(isValidCodeVerifier("too-short")).toBe(false);
    expect(isValidCodeVerifier("a".repeat(129))).toBe(false);
    expect(isValidCodeVerifier("has spaces in it that are not allowed here xx")).toBe(false);
    expect(isValidCodeVerifier("A".repeat(43))).toBe(true);
    expect(verifyPkce("too-short", deriveS256Challenge(verifier))).toBe(false);
  });

  test("rejects a challenge that is not a well-formed S256 output", () => {
    expect(isValidCodeChallenge("plain-looking-value")).toBe(false);
    expect(isValidCodeChallenge("a".repeat(43))).toBe(true);
    expect(isValidCodeChallenge("a".repeat(42))).toBe(false);
  });

  test("the plain-PKCE trap: verifier used AS the challenge never verifies under S256", () => {
    // If someone tried to pass the verifier as the challenge (plain mode),
    // S256 verification correctly fails — the downgrade earns nothing.
    expect(verifyPkce(verifier, verifier)).toBe(false);
  });
});

describe("scope", () => {
  test("parse de-duplicates and drops blanks", () => {
    expect(parseScope("claims:read  claims:read   analysis:read")).toEqual([
      "claims:read",
      "analysis:read",
    ]);
    expect(parseScope("")).toEqual([]);
    expect(parseScope(null)).toEqual([]);
  });

  test("narrowScope returns the intersection, never widens", () => {
    // A client asking for more than it holds gets only what it holds.
    expect(narrowScope(["claims:read", "claims:write"], ["claims:read"])).toEqual(["claims:read"]);
    // Order follows the requester.
    expect(narrowScope(["analysis:read", "claims:read"], ["claims:read", "analysis:read"])).toEqual([
      "analysis:read",
      "claims:read",
    ]);
    // A request for something never granted yields nothing, not an error.
    expect(narrowScope(["admin:everything"], ["claims:read"])).toEqual([]);
  });

  test("serialise is the inverse of parse for a clean set", () => {
    expect(serialiseScope(parseScope("claims:read analysis:read"))).toBe(
      "claims:read analysis:read"
    );
  });
});
