import { describe, expect, test } from "bun:test";
import {
  API_KEY_PREFIX,
  API_SCOPES,
  apiKeyPrefix,
  bearerToken,
  generateApiKey,
  hasScope,
  hashApiKey,
  isApiScope,
  looksLikeApiKey,
  rateLimitWindow,
  safeHashEqual,
} from "./keys";

describe("generateApiKey", () => {
  test("mints a prefixed, high-entropy key with its hash and display prefix", () => {
    const k = generateApiKey();
    expect(k.plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(k.hash).toBe(hashApiKey(k.plaintext));
    expect(k.prefix).toBe(apiKeyPrefix(k.plaintext));
    // The display prefix must not be enough to reconstruct the key.
    expect(k.plaintext.length).toBeGreaterThan(k.prefix.length + 16);
  });

  test("never repeats", () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateApiKey().plaintext));
    expect(keys.size).toBe(500);
  });

  test("produces url/header-safe keys", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateApiKey().plaintext).toMatch(/^lga_[A-Za-z0-9_-]+$/);
    }
  });
});

describe("looksLikeApiKey", () => {
  test("accepts a freshly minted key", () => {
    expect(looksLikeApiKey(generateApiKey().plaintext)).toBe(true);
  });

  test("rejects junk without touching the database", () => {
    for (const bad of [
      "",
      "lga_",
      "lga_short",
      "nope_abcdefghijklmnopqrstuvwx",
      "lgk_abcdefghijklmnopqrstuvwx", // the insurer oracle's scheme, not ours
      "lga_" + "a".repeat(200),
      "lga_has spaces here xx",
      "lga_semi;colon;injection",
    ]) {
      expect(looksLikeApiKey(bad)).toBe(false);
    }
  });
});

describe("bearerToken", () => {
  test("extracts a Bearer token, case-insensitively on the scheme", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("bearer abc123")).toBe("abc123");
    expect(bearerToken("  Bearer   abc123  ")).toBe("abc123");
  });

  test("refuses anything that is not a Bearer credential", () => {
    for (const bad of [null, "", "abc123", "Basic abc123", "Bearer", "Bearer a b"]) {
      expect(bearerToken(bad as string | null)).toBeNull();
    }
  });
});

describe("safeHashEqual", () => {
  test("compares equal and unequal digests correctly", () => {
    const a = hashApiKey("x");
    expect(safeHashEqual(a, a)).toBe(true);
    expect(safeHashEqual(a, hashApiKey("y"))).toBe(false);
  });

  test("returns false on length mismatch rather than throwing", () => {
    // timingSafeEqual throws on unequal lengths; the guard must catch it.
    expect(safeHashEqual("abc", "abcd")).toBe(false);
    expect(safeHashEqual("", "a")).toBe(false);
  });
});

describe("scopes", () => {
  test("recognises exactly the documented scopes", () => {
    for (const s of API_SCOPES) expect(isApiScope(s)).toBe(true);
    for (const s of ["", "admin", "voyages:read", "*", "voyages:write "]) {
      expect(isApiScope(s)).toBe(false);
    }
  });

  test("grants nothing by default and does not honour wildcards", () => {
    expect(hasScope([], "calculations:read")).toBe(false);
    // A key holding one scope must not thereby hold another.
    expect(hasScope(["disputes:read"], "calculations:read")).toBe(false);
    expect(hasScope(["*"], "calculations:read")).toBe(false);
    expect(hasScope(["calculations:read"], "calculations:read")).toBe(true);
  });
});

describe("rateLimitWindow", () => {
  test("truncates to the minute", () => {
    expect(rateLimitWindow(new Date("2026-07-15T10:00:59.999Z")).toISOString()).toBe(
      "2026-07-15T10:00:00.000Z"
    );
    expect(rateLimitWindow(new Date("2026-07-15T10:01:00.000Z")).toISOString()).toBe(
      "2026-07-15T10:01:00.000Z"
    );
  });

  test("two instants in the same minute share a window; adjacent minutes do not", () => {
    const a = rateLimitWindow(new Date("2026-07-15T10:00:01Z"));
    const b = rateLimitWindow(new Date("2026-07-15T10:00:58Z"));
    const c = rateLimitWindow(new Date("2026-07-15T10:01:01Z"));
    expect(a.getTime()).toBe(b.getTime());
    expect(a.getTime()).not.toBe(c.getTime());
  });

  test("does not mutate its argument", () => {
    const t = new Date("2026-07-15T10:00:30Z");
    rateLimitWindow(t);
    expect(t.toISOString()).toBe("2026-07-15T10:00:30.000Z");
  });
});
