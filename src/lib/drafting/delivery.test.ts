import { describe, expect, test, afterEach } from "bun:test";
import { deliverDemandLetter, deliveryConfigured, isValidRecipient } from "./delivery";

const REQ = {
  to: "claims@charterer.example",
  subject: "Demurrage claim",
  bodyText: "body",
  pdf: { filename: "letter.pdf", bytes: new Uint8Array([1, 2, 3]) },
};

const ENV_KEYS = ["EMAIL_PROVIDER_API_KEY", "EMAIL_FROM_ADDRESS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("isValidRecipient", () => {
  test("accepts ordinary addresses", () => {
    expect(isValidRecipient("claims@charterer.example")).toBe(true);
    expect(isValidRecipient("a.b-c+tag@sub.domain.co.uk")).toBe(true);
  });

  test("rejects malformed addresses and list injection", () => {
    for (const bad of ["", "nope", "a@b", "a@@b.com", "a b@c.com", "a@b.com, b@c.com", "a@b.com;c@d.com"]) {
      expect(isValidRecipient(bad)).toBe(false);
    }
  });
});

describe("deliverDemandLetter", () => {
  test("refuses an invalid recipient before touching a provider", async () => {
    const r = await deliverDemandLetter({ ...REQ, to: "not-an-address" });
    expect(r.sent).toBe(false);
    expect(r).toMatchObject({ reason: "provider_error" });
  });

  // The load-bearing guarantee of this whole module: with nothing configured
  // it must report NOT sent. A false "sent" would tell an operator the
  // charterer has their letter while a time bar runs down.
  test("reports not-sent when no provider is configured, never a simulated success", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(deliveryConfigured()).toBe(false);
    const r = await deliverDemandLetter(REQ);
    expect(r.sent).toBe(false);
    expect(r).toMatchObject({ reason: "not_configured" });
    if (!r.sent) expect(r.detail).toContain("nothing was sent");
  });

  test("still reports not-sent when credentials exist but no transport is implemented", async () => {
    process.env.EMAIL_PROVIDER_API_KEY = "key";
    process.env.EMAIL_FROM_ADDRESS = "claims@owner.example";
    expect(deliveryConfigured()).toBe(true);
    const r = await deliverDemandLetter(REQ);
    expect(r.sent).toBe(false);
    if (!r.sent) expect(r.detail).toContain("Nothing was sent");
  });

  test("half-configured credentials do not count as configured", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.EMAIL_PROVIDER_API_KEY = "key";
    expect(deliveryConfigured()).toBe(false);
  });
});
