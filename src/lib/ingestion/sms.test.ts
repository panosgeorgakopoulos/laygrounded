/// <reference types="bun-types" />
// Run with: bun test src/lib/ingestion/sms.test.ts

import { describe, it, expect } from "bun:test";
import {
  computeTwilioSignature,
  validateTwilioSignature,
  normalizePhone,
  parseInboundSms,
} from "./sms";

// Twilio's documented worked example (docs "Validating Signatures"): the exact
// URL + POST params + auth token, and the HMAC-SHA1/base64 they produce. Locked
// in as a regression vector so a change to the base-string construction (sort
// order, concatenation, URL handling) fails loudly rather than silently causing
// production 401s.
const TWILIO_EXAMPLE = {
  url: "https://mycompany.com/myapp.php?foo=1&bar=2",
  token: "12345",
  params: {
    Digits: "1234",
    To: "+18005551212",
    From: "+14158675310",
    Caller: "+14158675310",
    CallSid: "CA1234567890ABCDE",
  },
  signature: "GvWf1cFY/Q7PnoempGyD5oXAezc=",
};

describe("Twilio signature", () => {
  it("computes the documented example signature", () => {
    const { url, token, params, signature } = TWILIO_EXAMPLE;
    expect(computeTwilioSignature(token, url, params)).toBe(signature);
  });

  it("accepts a valid signature and is order-independent in the params", () => {
    const { url, token, params, signature } = TWILIO_EXAMPLE;
    const reordered = { CallSid: params.CallSid, To: params.To, Digits: params.Digits, From: params.From, Caller: params.Caller };
    expect(validateTwilioSignature(token, url, reordered, signature)).toBe(true);
  });

  it("rejects a tampered parameter, a tampered signature, and a missing header", () => {
    const { url, token, params, signature } = TWILIO_EXAMPLE;
    expect(validateTwilioSignature(token, url, { ...params, Digits: "9999" }, signature)).toBe(false);
    expect(validateTwilioSignature(token, url, params, "AAAA")).toBe(false);
    expect(validateTwilioSignature(token, url, params, null)).toBe(false);
    expect(validateTwilioSignature("wrong-token", url, params, signature)).toBe(false);
  });
});

describe("normalizePhone", () => {
  it("reduces to comparable digits and rejects the implausibly short", () => {
    expect(normalizePhone("+1 (415) 867-5310")).toBe("14158675310");
    expect(normalizePhone("447700900123")).toBe("447700900123");
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone(42 as unknown)).toBeNull();
  });
});

describe("parseInboundSms", () => {
  const body = "NOR tendered 2026-01-05 08:00 LT; all fast 2026-01-05 11:30 LT.";

  it("reads sender and body from a Twilio payload", () => {
    const r = parseInboundSms({ From: "+14158675310", Body: body, NumMedia: "0" });
    expect(r).toEqual({ fromPhone: "14158675310", body, mediaUrls: [] });
  });

  it("collects MMS media URLs", () => {
    const r = parseInboundSms({
      From: "+14158675310",
      Body: body,
      NumMedia: "2",
      MediaUrl0: "https://api.twilio.com/m0.jpg",
      MediaUrl1: "https://api.twilio.com/m1.jpg",
    });
    expect(r?.mediaUrls).toEqual(["https://api.twilio.com/m0.jpg", "https://api.twilio.com/m1.jpg"]);
  });

  it("rejects a too-short body or a missing sender", () => {
    expect(parseInboundSms({ From: "+14158675310", Body: "hi" })).toBeNull();
    expect(parseInboundSms({ Body: body })).toBeNull();
  });
});
