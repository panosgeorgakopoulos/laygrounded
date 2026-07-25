// Provider-agnostic inbound-email parsing for the SoF ingestion gateway.
//
// Inbound-email providers (SendGrid Inbound Parse, Mailgun Routes, Postmark,
// Cloudflare Email Workers) each POST a received email in their own field
// names and either multipart/form-data or JSON. The route normalises the
// payload into a flat record; these pure helpers pull the sender, subject and
// body out of it, and route the message to a tenant by the plus-addressed
// recipient (sof+<companyId>@…). Pure and unit-tested — the route owns the I/O.

export interface InboundEmail {
  fromEmail: string;
  recipient: string;
  subject: string;
  text: string;
}

// The address a real email client renders as "Name <user@host>", or bare.
export function extractEmailAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const angle = raw.match(/<([^>]+)>/);
  const candidate = (angle ? angle[1] : raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null;
}

// A LayGrounded tenant inbox is plus-addressed with the company id:
//   sof+<uuid>@ingest.laygrounded.com  → routes to that company.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export function companyIdFromRecipient(recipient: unknown): string | null {
  if (typeof recipient !== "string") return null;
  const plus = recipient.match(/\+([^@]+)@/);
  const inPlus = plus ? plus[1].match(UUID_RE) : null;
  if (inPlus) return inPlus[0].toLowerCase();
  // Fall back to any UUID in the address (some providers strip the +tag).
  const anywhere = recipient.match(UUID_RE);
  return anywhere ? anywhere[0].toLowerCase() : null;
}

const FROM_KEYS = ["from", "sender", "From", "Sender"];
const TO_KEYS = ["to", "recipient", "To", "Recipient", "envelope_to"];
const SUBJECT_KEYS = ["subject", "Subject"];
// Prefer plain text; fall back through the common stripped/body variants.
const TEXT_KEYS = ["text", "body-plain", "stripped-text", "TextBody", "plain", "body"];

function first(record: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = record[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/**
 * Normalises a provider's inbound-email payload (already flattened to a record)
 * into { fromEmail, recipient, subject, text }. Returns null when the sender or
 * a usable body can't be read — the route then rejects rather than guessing.
 */
export function parseInboundEmail(record: Record<string, unknown>): InboundEmail | null {
  const fromEmail = extractEmailAddress(first(record, FROM_KEYS));
  const recipient = first(record, TO_KEYS)?.trim() ?? "";
  const subject = first(record, SUBJECT_KEYS)?.trim() ?? "";
  const text = first(record, TEXT_KEYS)?.trim() ?? "";
  if (!fromEmail || text.length < 20) return null;
  return { fromEmail, recipient, subject, text };
}
