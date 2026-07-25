// Inbound-SMS parsing + Twilio request authentication for the SoF ingestion
// gateway (F3 ingestion channel, SMS variant of inbound-email.ts).
//
// Twilio POSTs a received SMS as application/x-www-form-urlencoded (From, To,
// Body, NumMedia, MediaUrl0…). Authenticity is proven by the X-Twilio-Signature
// header — an HMAC-SHA1 the caller cannot forge without the account auth token —
// so there is no shared secret to leak. These helpers are pure and unit-tested;
// the route owns the I/O and the tenant routing.
//
// https://www.twilio.com/docs/usage/security#validating-requests

import { createHmac, timingSafeEqual } from "node:crypto";

export interface InboundSms {
  fromPhone: string; // digits only (E.164 without punctuation)
  body: string;
  mediaUrls: string[];
}

/**
 * The canonical string Twilio signs: the exact request URL, followed by every
 * POST parameter appended in sorted key order as `key + value`, no separators.
 */
export function twilioSignatureBase(url: string, params: Record<string, string>): string {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return data;
}

/** HMAC-SHA1 of the canonical base, base64 — the value Twilio puts in the header. */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>
): string {
  return createHmac("sha1", authToken).update(twilioSignatureBase(url, params), "utf8").digest("base64");
}

/** Constant-time check of an incoming X-Twilio-Signature. */
export function validateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | null | undefined
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(computeTwilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Reduce a phone number to comparable digits; null if implausibly short. */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

/**
 * Normalises a Twilio SMS payload (already flattened to a string record) into
 * { fromPhone, body, mediaUrls }. Returns null when the sender or a usable body
 * can't be read — the route then rejects rather than guessing.
 */
export function parseInboundSms(record: Record<string, string>): InboundSms | null {
  const fromPhone = normalizePhone(record.From ?? record.from);
  const body = (record.Body ?? record.body ?? "").trim();
  if (!fromPhone || body.length < 20) return null;

  const mediaUrls: string[] = [];
  const numMedia = parseInt(record.NumMedia ?? "0", 10) || 0;
  for (let i = 0; i < numMedia; i++) {
    const u = record[`MediaUrl${i}`];
    if (typeof u === "string" && u) mediaUrls.push(u);
  }
  return { fromPhone, body, mediaUrls };
}
