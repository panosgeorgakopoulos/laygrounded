// Outbound webhook signature tests.
//
// These are the guarantees we ask a logistics partner to rely on, so the
// negative cases matter more than the positive one. The forgery case in
// particular is why the timestamp is signed rather than merely sent.

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  DEFAULT_TOLERANCE_S,
  signBody,
  signWithTimestamp,
  signatureHeaders,
  verifySignatureV2,
} from "./signing";

const SECRET = "whsec_test_0123456789abcdef";
const BODY = JSON.stringify({ event: "hinterland.delay_forecast", delayHoursP90: 41.5 });
const NOW = new Date("2026-08-01T12:00:00Z");
const UNIX = Math.floor(NOW.getTime() / 1000);

describe("v1 — body-only HMAC", () => {
  test("matches an independently computed HMAC", () => {
    const expected = `sha256=${createHmac("sha256", SECRET).update(BODY).digest("hex")}`;
    expect(signBody(BODY, SECRET)).toBe(expected);
  });

  test("any body change changes the signature", () => {
    expect(signBody(BODY, SECRET)).not.toBe(signBody(BODY.replace("41.5", "41.6"), SECRET));
  });

  test("any secret change changes the signature", () => {
    expect(signBody(BODY, SECRET)).not.toBe(signBody(BODY, SECRET + "x"));
  });
});

describe("v2 — timestamped HMAC", () => {
  test("signs '<t>.<body>', not the body alone", () => {
    const expected = createHmac("sha256", SECRET).update(`${UNIX}.${BODY}`).digest("hex");
    expect(signWithTimestamp(BODY, SECRET, UNIX)).toBe(`t=${UNIX},v1=${expected}`);
  });

  test("the separator prevents timestamp/body confusion", () => {
    // Without the '.', t=1 + body "23X" and t=123 + body "X" sign the same
    // string, so an attacker who can influence the body forges a new timestamp
    // for an existing signature.
    const a = signWithTimestamp("23X", SECRET, 1).split("v1=")[1];
    const b = signWithTimestamp("X", SECRET, 123).split("v1=")[1];
    expect(a).not.toBe(b);
  });

  test("round-trips through verification", () => {
    const header = signWithTimestamp(BODY, SECRET, UNIX);
    expect(verifySignatureV2(BODY, header, SECRET, { now: NOW })).toEqual({ valid: true });
  });
});

describe("v2 verification rejects", () => {
  const header = signWithTimestamp(BODY, SECRET, UNIX);

  test("a tampered body", () => {
    const r = verifySignatureV2(BODY.replace("41.5", "9999"), header, SECRET, { now: NOW });
    expect(r).toEqual({ valid: false, reason: "mismatch" });
  });

  test("the wrong secret", () => {
    expect(verifySignatureV2(BODY, header, "whsec_wrong", { now: NOW })).toEqual({
      valid: false,
      reason: "mismatch",
    });
  });

  test("a replay outside the tolerance window", () => {
    // The signature is still cryptographically valid — this is exactly the
    // attack v1 cannot see.
    const later = new Date(NOW.getTime() + (DEFAULT_TOLERANCE_S + 60) * 1000);
    expect(verifySignatureV2(BODY, header, SECRET, { now: later })).toEqual({
      valid: false,
      reason: "stale",
    });
  });

  test("a future timestamp beyond tolerance (clock-skew abuse)", () => {
    const earlier = new Date(NOW.getTime() - (DEFAULT_TOLERANCE_S + 60) * 1000);
    expect(verifySignatureV2(BODY, header, SECRET, { now: earlier })).toEqual({
      valid: false,
      reason: "stale",
    });
  });

  test("staleness is reported before mismatch", () => {
    // An old delivery with a broken signature is more usefully described as
    // stale: it sends the integrator to their queue, not to their HMAC code.
    const old = signWithTimestamp(BODY, SECRET, UNIX - 100_000);
    const tampered = old.replace(/v1=.*/, `v1=${"0".repeat(64)}`);
    expect(verifySignatureV2(BODY, tampered, SECRET, { now: NOW }).reason).toBe("stale");
  });

  const malformed = [
    { name: "null header", header: null },
    { name: "empty header", header: "" },
    { name: "missing v1", header: `t=${UNIX}` },
    { name: "missing t", header: `v1=${"a".repeat(64)}` },
    { name: "non-numeric t", header: `t=yesterday,v1=${"a".repeat(64)}` },
    { name: "no key=value structure", header: "garbage" },
  ];
  for (const c of malformed) {
    test(`malformed: ${c.name}`, () => {
      expect(verifySignatureV2(BODY, c.header, SECRET, { now: NOW }).reason).toBe("malformed");
    });
  }

  test("fails closed when the secret is unconfigured", () => {
    expect(verifySignatureV2(BODY, header, "", { now: NOW })).toEqual({
      valid: false,
      reason: "unconfigured",
    });
  });

  test("a truncated digest is a mismatch, not a crash", () => {
    const truncated = header.replace(/v1=(.*)/, (_m, d: string) => `v1=${d.slice(0, 63)}`);
    expect(verifySignatureV2(BODY, truncated, SECRET, { now: NOW })).toEqual({
      valid: false,
      reason: "mismatch",
    });
  });

  test("tolerance boundary is inclusive", () => {
    const edge = new Date(NOW.getTime() + DEFAULT_TOLERANCE_S * 1000);
    expect(verifySignatureV2(BODY, header, SECRET, { now: edge }).valid).toBe(true);
    const past = new Date(NOW.getTime() + (DEFAULT_TOLERANCE_S + 1) * 1000);
    expect(verifySignatureV2(BODY, header, SECRET, { now: past }).valid).toBe(false);
  });
});

describe("delivery headers", () => {
  const headers = signatureHeaders(BODY, SECRET, "hinterland.delay_forecast", NOW);

  test("carries BOTH schemes so existing consumers keep working", () => {
    // Removing v1 is a breaking change for someone else's production system.
    expect(headers["x-laygrounded-signature"]).toBe(signBody(BODY, SECRET));
    expect(headers["x-laygrounded-signature-v2"]).toBe(signWithTimestamp(BODY, SECRET, UNIX));
  });

  test("names the event and the timestamp", () => {
    expect(headers["x-laygrounded-event"]).toBe("hinterland.delay_forecast");
    expect(headers["x-laygrounded-timestamp"]).toBe(String(UNIX));
    expect(headers["content-type"]).toBe("application/json");
  });

  test("the sent timestamp header agrees with the signed one", () => {
    // If these ever diverge, a partner validating against the header rather
    // than the parsed `t=` would reject every delivery.
    const signedT = headers["x-laygrounded-signature-v2"].split(",")[0].replace("t=", "");
    expect(signedT).toBe(headers["x-laygrounded-timestamp"]);
  });
});
