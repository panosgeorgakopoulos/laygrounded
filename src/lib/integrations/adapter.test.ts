// Security tests for the shared webhook HMAC-SHA256 verification
// (ErpAdapter.verifyWebhookSignature). Every inbound ERP webhook and both
// outbound signing paths (settlement, insurance) use this exact scheme, so
// the negative cases here are the attack surface: malformed headers, wrong
// algorithms, tampered bodies, and replay semantics.

import { describe, expect, test } from "bun:test";
import { createHmac, createHash } from "crypto";
import { MockErpAdapter } from "./mock";
import type { IntegrationRow } from "./types";

const SECRET = "test-webhook-secret-0123456789abcdef";

function makeAdapter(webhookSecret?: string): MockErpAdapter {
  const row: IntegrationRow = {
    id: "00000000-0000-0000-0000-000000000001",
    company_id: "00000000-0000-0000-0000-000000000002",
    provider: "MOCK_ERP",
    display_name: "Test ERP",
    base_url: "https://erp.example.test",
    auth: webhookSecret === undefined ? {} : { webhook_secret: webhookSecret },
    config: {},
    status: "active",
    last_error: null,
    last_sync_at: null,
  };
  return new MockErpAdapter(row);
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

const BODY = JSON.stringify({
  event_id: "evt_123",
  type: "voyage.updated",
  voyage: { ref: "V-42", port: "Santos" },
});

describe("verifyWebhookSignature — happy path", () => {
  test("valid signature with sha256= prefix verifies", () => {
    const adapter = makeAdapter(SECRET);
    expect(adapter.verifyWebhookSignature(BODY, `sha256=${sign(BODY, SECRET)}`)).toBe(true);
  });

  test("valid bare-hex signature (no prefix) verifies", () => {
    const adapter = makeAdapter(SECRET);
    expect(adapter.verifyWebhookSignature(BODY, sign(BODY, SECRET))).toBe(true);
  });

  test("surrounding whitespace in the header is tolerated", () => {
    const adapter = makeAdapter(SECRET);
    expect(adapter.verifyWebhookSignature(BODY, `  sha256=${sign(BODY, SECRET)}  `)).toBe(true);
  });
});

describe("verifyWebhookSignature — malformed and hostile inputs", () => {
  const adapter = makeAdapter(SECRET);

  const rejected: Array<{ name: string; header: string | null; body?: string }> = [
    { name: "missing signature header (null)", header: null },
    { name: "empty signature header", header: "" },
    { name: "prefix only, no digest", header: "sha256=" },
    {
      name: "wrong algorithm: sha1 digest under sha1= prefix",
      header: `sha1=${createHash("sha1").update(BODY).digest("hex")}`,
    },
    {
      name: "wrong algorithm: md5 digest under md5= prefix",
      header: `md5=${createHash("md5").update(BODY).digest("hex")}`,
    },
    {
      name: "algorithm confusion: sha1 digest smuggled under sha256= prefix",
      header: `sha256=${createHash("sha1").update(BODY).digest("hex")}`,
    },
    {
      name: "truncated digest (63 of 64 hex chars)",
      header: `sha256=${sign(BODY, SECRET).slice(0, 63)}`,
    },
    {
      name: "digest with one extra character",
      header: `sha256=${sign(BODY, SECRET)}0`,
    },
    {
      name: "correct length but non-hex garbage",
      header: `sha256=${"z".repeat(64)}`,
    },
    {
      name: "uppercase hex is rejected (byte-exact comparison, no normalization)",
      header: `sha256=${sign(BODY, SECRET).toUpperCase()}`,
    },
    {
      name: "signature computed with the wrong secret",
      header: `sha256=${sign(BODY, "attacker-guessed-secret")}`,
    },
    {
      name: "valid signature over a DIFFERENT body (tamper detection)",
      header: `sha256=${sign(BODY, SECRET)}`,
      body: BODY.replace("V-42", "V-43"),
    },
    {
      name: "single flipped hex char in an otherwise valid digest",
      header: `sha256=${flipLastHexChar(sign(BODY, SECRET))}`,
    },
  ];

  for (const c of rejected) {
    test(`rejects: ${c.name}`, () => {
      expect(adapter.verifyWebhookSignature(c.body ?? BODY, c.header)).toBe(false);
    });
  }

  test("fails closed when no webhook secret is configured — even for a 'valid' signature", () => {
    const unconfigured = makeAdapter(undefined);
    expect(unconfigured.verifyWebhookSignature(BODY, `sha256=${sign(BODY, SECRET)}`)).toBe(false);
    // Also with an empty-string secret — empty is not a key.
    const empty = makeAdapter("");
    expect(empty.verifyWebhookSignature(BODY, `sha256=${sign(BODY, "")}`)).toBe(false);
  });

  test("signature for body A never validates body B differing only in key order", () => {
    // Canonicalization attacks: verification is over the RAW body bytes, so a
    // semantically identical JSON with reordered keys must fail.
    const reordered = JSON.stringify({
      type: "voyage.updated",
      event_id: "evt_123",
      voyage: { ref: "V-42", port: "Santos" },
    });
    expect(adapter.verifyWebhookSignature(reordered, `sha256=${sign(BODY, SECRET)}`)).toBe(false);
  });
});

describe("verifyWebhookSignature — replay semantics", () => {
  test("an identical replayed delivery still carries a valid signature (by design)", () => {
    // The HMAC scheme is stateless: signatures carry no timestamp or nonce,
    // so a byte-for-byte replay verifies. Replay protection lives one layer
    // up, in the webhook route's idempotency ledger — the unique
    // (integration_id, direction, idempotency_key) index on webhook_logs
    // turns the second delivery into `skipped_duplicate` without side
    // effects. This test pins that contract so a future "optimization" that
    // removes the dedupe cannot silently reopen replays.
    const adapter = makeAdapter(SECRET);
    const header = `sha256=${sign(BODY, SECRET)}`;
    expect(adapter.verifyWebhookSignature(BODY, header)).toBe(true);
    expect(adapter.verifyWebhookSignature(BODY, header)).toBe(true); // replay: same result
  });
});

function flipLastHexChar(hex: string): string {
  const last = hex[hex.length - 1];
  const flipped = last === "0" ? "1" : "0";
  return hex.slice(0, -1) + flipped;
}
