// Tamper-evident tenant audit trail.
//
// Every sensitive act in LayGrounded — handing a counterparty a room link,
// clearing settlement funds, minting an API key, amending a confirmed event —
// writes an entry here. Two properties make the trail worth having in a
// dispute, and both are structural rather than promised:
//
//  1. A tenant CANNOT write it. security_events has RLS on with a SELECT
//     policy and no INSERT/UPDATE/DELETE policy at all, so the only writer is
//     the service role, through append_security_event(). Neither a logged-in
//     user nor a leaked anon key can forge or erase an entry via PostgREST.
//
//  2. Editing it is DETECTABLE. Entries are hash-chained per company: each
//     row commits to the one before it, so altering any stored field, or
//     removing a row from the middle, breaks every hash after it. verifyChain
//     recomputes the whole chain from the stored columns and says where it
//     broke.
//
// Honest limit: a chain proves nothing about entries removed from its END —
// truncation leaves a shorter but internally consistent chain. That is what
// headHash is for: pin it externally (the Merkle notary in src/lib/legal/
// already anchors fingerprints to an RFC-3161 timestamp) and truncation stops
// being silent too.
//
// Division of labour with SQL. All formatting — timestamps, JSON, nulls —
// happens HERE, in tested code, and the canonical body is passed to Postgres
// as text. The function only prepends the two values it alone can assign
// atomically (seq, prev_hash) and hashes. So the SQL/TypeScript agreement
// surface is two unambiguous fields, not a dozen format-sensitive ones.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/supabase/server";

// Field separator: a control character that cannot occur unescaped in any of
// the values we join, so no value can impersonate a field boundary.
const US = "\u001F"; // ASCII unit separator (0x1F); chr(31) on the SQL side
const PAYLOAD_VERSION = "v1";

// The prev_hash of the first entry in a company's chain.
export const GENESIS_HASH = "0".repeat(64);

// The catalogue of audited acts. A closed list rather than free text: an audit
// trail you cannot query by action is an archive, not a control.
export const SECURITY_ACTIONS = [
  "share.created", // a counterparty was granted room access
  "share.revoked",
  "settlement.cleared", // funds moved
  "api_key.created", // a machine credential was issued
  "api_key.revoked",
  "webhook.registered", // data was pointed at an external endpoint
  "webhook.deleted",
  "member.invited", // the tenant's user set changed
  "member.removed",
  "member.role_changed", // someone's authority inside the tenant changed
  // A role that was not high enough for what was attempted. Recorded because
  // the denied half of an audit trail is the half that shows intent, and an
  // RBAC model nobody can prove was enforced is a claim rather than a control.
  "capability.denied",
  "proposal.accepted", // a counterparty amendment was written into the record
  "proposal.rejected",
  "event.amended", // a confirmed event was edited directly by the owner
  "draft.sent", // a legal position left the building
  "claim.access_denied", // someone reached for a claim that is not theirs
] as const;
export type SecurityAction = (typeof SECURITY_ACTIONS)[number];

export const ACTOR_TYPES = ["user", "api_key", "guest", "system", "cron"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export type Outcome = "allowed" | "denied" | "error";

export type Metadata = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Canonicalisation
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted at every depth, no incidental
 * whitespace. Two structurally equal objects always produce the same string,
 * whatever order they were built in — required, because the metadata comes
 * back from Postgres as jsonb, which does not preserve key order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Metadata)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// Audit logs are a classic place for secrets to leak: someone logs "the
// request body" and a webhook secret is now in a table half the company can
// read. Values under a sensitive-looking key are replaced before storage.
const SENSITIVE_KEY = /(secret|password|passwd|credential|authorization|api_?key|private|bearer|token)/i;
// …except the deliberately non-secret identifiers built for exactly this use.
const SAFE_SUFFIX = /(prefix|_id|Id|hash|count|type|status)$/;

export function scrubMetadata(meta: Metadata | undefined | null): Metadata {
  const out: Metadata = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (v === undefined) continue;
    if (SENSITIVE_KEY.test(k) && !SAFE_SUFFIX.test(k)) {
      out[k] = "[redacted]";
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = scrubMetadata(v as Metadata);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function metadataHash(meta: Metadata | undefined | null): string {
  return sha256Hex(canonicalJson(meta ?? {}));
}

/** The part of an entry the application knows: everything but seq/prev_hash. */
export interface EntryBody {
  occurredAt: string; // ISO-8601, millisecond precision, UTC
  companyId: string;
  actorType: ActorType;
  actorId: string; // "" when the actor has no user id
  actorLabel: string;
  action: SecurityAction;
  resourceType: string;
  resourceId: string;
  outcome: Outcome;
  metadataHash: string;
}

/**
 * The canonical body string. Field order is part of the format; changing it
 * (or the version tag) invalidates every existing chain, so a future format
 * must be a NEW version emitted alongside, not an edit of this one.
 */
export function entryBody(b: EntryBody): string {
  return [
    PAYLOAD_VERSION,
    b.occurredAt,
    b.companyId,
    b.actorType,
    b.actorId,
    b.actorLabel,
    b.action,
    b.resourceType,
    b.resourceId,
    b.outcome,
    b.metadataHash,
  ].join(US);
}

/** Must mirror append_security_event() exactly. See the migration. */
export function entryHash(seq: number, prevHash: string, body: string): string {
  return sha256Hex(`${seq}${US}${prevHash}${US}${body}`);
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface StoredSecurityEvent {
  id: string;
  seq: number;
  occurredAt: string;
  companyId: string;
  actorType: ActorType;
  actorId: string | null;
  actorLabel: string;
  action: SecurityAction;
  resourceType: string;
  resourceId: string;
  outcome: Outcome;
  metadata: Metadata;
  metadataHash: string;
  prevHash: string;
  entryHash: string;
}

export type BreakReason =
  | "hash_mismatch" // a stored field was edited
  | "prev_hash_mismatch" // an entry was removed, replaced or reordered
  | "sequence_gap" // an entry was deleted outright
  | "metadata_mismatch"; // the jsonb payload no longer matches its digest

export interface ChainBreak {
  seq: number;
  id: string;
  reason: BreakReason;
  detail: string;
}

export interface ChainVerdict {
  ok: boolean;
  checked: number;
  /** True when the window starts at seq 1, so the chain is verified from its
   *  genesis. A window that starts later proves only its own internal
   *  consistency — it cannot vouch for the entries before it. */
  anchored: boolean;
  firstSeq: number | null;
  lastSeq: number | null;
  /** Hash of the newest entry: the value to pin externally so that removing
   *  entries from the end of the chain is detectable too. */
  headHash: string | null;
  breaks: ChainBreak[];
}

/**
 * Recomputes the chain from the stored columns. Pure: give it the rows, it
 * tells you whether they are the rows that were written.
 */
export function verifyChain(rows: StoredSecurityEvent[]): ChainVerdict {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const breaks: ChainBreak[] = [];

  let previous: StoredSecurityEvent | null = null;
  for (const row of sorted) {
    // Metadata is checked against its own digest rather than folded into the
    // entry hash directly, so that a jsonb round-trip difference could never
    // be mistaken for a broken chain: the two failures are reported apart.
    if (metadataHash(row.metadata) !== row.metadataHash) {
      breaks.push({
        seq: row.seq,
        id: row.id,
        reason: "metadata_mismatch",
        detail: "Stored metadata does not match the digest recorded with the entry.",
      });
    }

    const body = entryBody({
      occurredAt: normaliseTimestamp(row.occurredAt),
      companyId: row.companyId,
      actorType: row.actorType,
      actorId: row.actorId ?? "",
      actorLabel: row.actorLabel,
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      outcome: row.outcome,
      metadataHash: row.metadataHash,
    });

    if (entryHash(row.seq, row.prevHash, body) !== row.entryHash) {
      breaks.push({
        seq: row.seq,
        id: row.id,
        reason: "hash_mismatch",
        detail: "Entry contents do not match the hash recorded for this entry.",
      });
    }

    if (previous === null) {
      if (row.seq === 1 && row.prevHash !== GENESIS_HASH) {
        breaks.push({
          seq: row.seq,
          id: row.id,
          reason: "prev_hash_mismatch",
          detail: "First entry in the chain does not link to the genesis hash.",
        });
      }
    } else {
      if (row.seq !== previous.seq + 1) {
        breaks.push({
          seq: row.seq,
          id: row.id,
          reason: "sequence_gap",
          detail: `Expected sequence ${previous.seq + 1}, found ${row.seq} — ${row.seq - previous.seq - 1} entr${row.seq - previous.seq - 1 === 1 ? "y" : "ies"} missing.`,
        });
      }
      if (row.prevHash !== previous.entryHash) {
        breaks.push({
          seq: row.seq,
          id: row.id,
          reason: "prev_hash_mismatch",
          detail: "Entry does not link to the hash of the preceding entry.",
        });
      }
    }
    previous = row;
  }

  return {
    ok: breaks.length === 0,
    checked: sorted.length,
    anchored: sorted.length > 0 && sorted[0].seq === 1,
    firstSeq: sorted.length ? sorted[0].seq : null,
    lastSeq: previous ? previous.seq : null,
    headHash: previous ? previous.entryHash : null,
    breaks,
  };
}

/**
 * Postgres returns timestamptz as "…+00:00"; the writer always sends
 * `Date.toISOString()` ("…Z", millisecond precision). Re-emitting through Date
 * reproduces exactly what was hashed, whichever spelling came back.
 */
export function normaliseTimestamp(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface RecordSecurityEventInput {
  companyId: string;
  action: SecurityAction;
  actorType?: ActorType;
  actorId?: string | null;
  actorLabel?: string;
  resourceType?: string;
  resourceId?: string;
  outcome?: Outcome;
  metadata?: Metadata;
  /**
   * Fail the caller if the entry cannot be written. Off by default: for most
   * actions, refusing to do the work because the log is unavailable is worse
   * than the missing line. Turn it ON where the record is part of the point —
   * moving money, issuing a credential — so the act cannot happen unlogged.
   */
  critical?: boolean;
  ip?: string | null;
  userAgent?: string | null;
}

export class AuditWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditWriteError";
  }
}

/**
 * Appends one entry. Awaited rather than fired-and-forgotten: a floating
 * promise in a serverless function is not guaranteed to run after the response
 * is returned, and an audit line that only sometimes survives is not evidence.
 *
 * Throws AUDIT_WRITE_FAILED only when `critical` is set.
 */
export async function recordSecurityEvent(
  input: RecordSecurityEventInput,
  client?: SupabaseClient
): Promise<{ seq: number; entryHash: string } | null> {
  const occurredAt = new Date().toISOString();
  const metadata = scrubMetadata(input.metadata);
  const mHash = metadataHash(metadata);

  const body = entryBody({
    occurredAt,
    companyId: input.companyId,
    actorType: input.actorType ?? "user",
    actorId: input.actorId ?? "",
    actorLabel: input.actorLabel ?? "",
    action: input.action,
    resourceType: input.resourceType ?? "",
    resourceId: input.resourceId ?? "",
    outcome: input.outcome ?? "allowed",
    metadataHash: mHash,
  });

  try {
    // Service role by design: this table has no INSERT policy, so a
    // user-scoped client cannot write it — which is the property that makes
    // the trail trustworthy in the first place.
    const supabase = client ?? createServiceRoleClient();
    const { data, error } = await supabase
      .rpc("append_security_event", {
        p_company_id: input.companyId,
        p_occurred_at: occurredAt,
        p_actor_type: input.actorType ?? "user",
        p_actor_id: input.actorId ?? null,
        p_actor_label: input.actorLabel ?? "",
        p_action: input.action,
        p_resource_type: input.resourceType ?? "",
        p_resource_id: input.resourceId ?? "",
        p_outcome: input.outcome ?? "allowed",
        p_metadata: metadata,
        p_metadata_hash: mHash,
        p_body: body,
        p_ip: input.ip ?? null,
        p_user_agent: input.userAgent ?? null,
      });

    if (error) throw new Error(error.message);
    // A plpgsql function with OUT parameters is RETURNS record: PostgREST
    // renders it as a bare object, but a set-returning shape would arrive as a
    // one-element array. Accept either rather than depending on which.
    const row = (Array.isArray(data) ? data[0] : data) as
      | { event_seq: number; event_hash: string }
      | undefined;
    if (!row) throw new Error("append_security_event returned no row");
    return { seq: Number(row.event_seq), entryHash: row.event_hash };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Always leave a trace in the server log, even when we swallow.
    console.error(`[audit] failed to record ${input.action}: ${message}`);
    if (input.critical) throw new AuditWriteError("AUDIT_WRITE_FAILED");
    return null;
  }
}

/** Request attribution, best effort — behind a trusted proxy (see src/proxy.ts). */
export function requestAttribution(req: { headers: Headers }): { ip: string | null; userAgent: string | null } {
  const h = req.headers;
  const ip = h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  return { ip, userAgent: h.get("user-agent")?.slice(0, 300) ?? null };
}
