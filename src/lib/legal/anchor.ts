// Independent timestamp anchoring for Merkle roots.
//
// WHY THIS EXISTS. The notary in prosecution.ts proves record *integrity*:
// alter any event, clause or computed hour and the root changes. What it does
// NOT prove is *when*. The snapshot's `asOf` is asserted by LayGrounded
// itself, so an auditor must trust our clock and our good faith — nothing in
// the ledger stops a root being written with a backdated asOf. Anchoring
// closes exactly that gap: a third party attests that this root existed
// before a moment they timestamped, which is the one fact we cannot
// self-certify.
//
// PROVIDERS.
//   * rfc3161 — a Time-Stamp Authority (RFC 3161). This is the path that
//     actually works: set TSA_URL and every root gets a real, signed
//     timestamp token. From a QTSP under eIDAS a qualified electronic time
//     stamp carries a legal presumption as to its date and time across the
//     EU, which is stronger evidence in a charterparty dispute than an
//     unqualified chain entry — and it needs no onboarding.
//   * ebsi — deliberately NOT implemented. EBSI is a permissioned network:
//     writing to it requires being an onboarded participant with a DID
//     registered in its registries and accreditation through the EU's
//     process. We hold no such credentials, and inventing an endpoint shape
//     would produce a fake anchor. A fabricated "anchored on EBSI" claim is
//     fabricated legal evidence — the worst possible failure for this
//     product. It refuses, loudly, and says what onboarding requires.
//
// Nothing here ever reports an anchor it did not obtain. An unanchored root
// is still a perfectly good integrity proof; it is simply not independently
// timestamped, and the dossier says so in those words.

import { createHash, randomBytes } from "node:crypto";

export type AnchorProvider = "rfc3161" | "ebsi";

export type AnchorOutcome =
  | {
      anchored: true;
      provider: AnchorProvider;
      // Base64 RFC 3161 TimeStampToken (a CMS SignedData). Kept verbatim so
      // an auditor can verify it offline with `openssl ts -verify` against
      // the TSA's own certificate — verification never routes through us.
      token: string;
      tsaUrl: string;
      requestedAt: string;
      // PKIStatus: 0 granted, 1 grantedWithMods.
      status: number;
    }
  | { anchored: false; reason: "not_configured" | "unsupported" | "provider_error"; detail: string };

// === Minimal DER (no ASN.1 dependency in this repo) ===
//
// Only what RFC 3161 needs: build a TimeStampReq, and read the status off a
// TimeStampResp. We deliberately do NOT parse the token's TSTInfo to extract
// genTime — that means parsing CMS SignedData, and a half-right parser would
// let us *assert* a signed time we hadn't actually verified. The token is
// stored whole; its time is whatever the TSA signed, provable with openssl.

function encodeLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function tlv(tag: number, content: number[]): number[] {
  return [tag, ...encodeLength(content.length), ...content];
}

// DER INTEGER: minimal big-endian two's complement; pad when the top bit is
// set so a positive value is never read as negative.
function derInteger(n: number | Uint8Array): number[] {
  let bytes: number[];
  if (typeof n === "number") {
    if (n === 0) return tlv(0x02, [0]);
    bytes = [];
    let v = n;
    while (v > 0) {
      bytes.unshift(v & 0xff);
      v = Math.floor(v / 256);
    }
  } else {
    bytes = [...n];
    while (bytes.length > 1 && bytes[0] === 0) bytes.shift();
  }
  if (bytes[0] & 0x80) bytes.unshift(0x00);
  return tlv(0x02, bytes);
}

// OID 2.16.840.1.101.3.4.2.1 (sha-256), pre-encoded.
const OID_SHA256 = [0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
const DER_NULL = [0x05, 0x00];

export function encodeTimeStampReq(
  hashHex: string,
  opts: { nonce?: Uint8Array; certReq?: boolean } = {}
): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hashHex)) {
    throw new Error("ANCHOR_BAD_HASH: expected a 64-char hex SHA-256 digest");
  }
  const digest = [...Buffer.from(hashHex, "hex")];

  const algId = tlv(0x30, [...OID_SHA256, ...DER_NULL]);
  const messageImprint = tlv(0x30, [...algId, ...tlv(0x04, digest)]);

  const body: number[] = [
    ...derInteger(1), // version v1
    ...messageImprint,
  ];
  // Nonce: the TSA must echo it, which is what stops a replayed response
  // being passed off as a fresh timestamp.
  if (opts.nonce) body.push(...derInteger(opts.nonce));
  // certReq TRUE → the TSA includes its certificate, so the token verifies
  // standalone without us shipping the chain separately.
  if (opts.certReq !== false) body.push(...tlv(0x01, [0xff]));

  return Uint8Array.from(tlv(0x30, body));
}

interface DerNode {
  tag: number;
  contentStart: number;
  contentEnd: number;
  end: number;
}

function readTlv(buf: Uint8Array, offset: number): DerNode {
  if (offset + 2 > buf.length) throw new Error("ANCHOR_BAD_RESPONSE: truncated DER");
  const tag = buf[offset];
  let p = offset + 1;
  let len = buf[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("ANCHOR_BAD_RESPONSE: unsupported DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
  }
  const contentStart = p;
  const contentEnd = p + len;
  if (contentEnd > buf.length) throw new Error("ANCHOR_BAD_RESPONSE: DER length overruns buffer");
  return { tag, contentStart, contentEnd, end: contentEnd };
}

export const PKI_STATUS_TEXT: Record<number, string> = {
  0: "granted",
  1: "grantedWithMods",
  2: "rejection",
  3: "waiting",
  4: "revocationWarning",
  5: "revocationNotification",
};

export interface TimeStampRespParts {
  status: number;
  statusText: string;
  // Raw DER of the TimeStampToken, when the TSA granted one.
  token: Uint8Array | null;
}

// Reads PKIStatusInfo and slices out the token. TimeStampResp ::= SEQUENCE {
// status PKIStatusInfo, timeStampToken TimeStampToken OPTIONAL }.
export function parseTimeStampResp(der: Uint8Array): TimeStampRespParts {
  const outer = readTlv(der, 0);
  if (outer.tag !== 0x30) throw new Error("ANCHOR_BAD_RESPONSE: expected SEQUENCE");

  const statusInfo = readTlv(der, outer.contentStart);
  if (statusInfo.tag !== 0x30) throw new Error("ANCHOR_BAD_RESPONSE: expected PKIStatusInfo");

  const statusInt = readTlv(der, statusInfo.contentStart);
  if (statusInt.tag !== 0x02) throw new Error("ANCHOR_BAD_RESPONSE: expected status INTEGER");
  let status = 0;
  for (let i = statusInt.contentStart; i < statusInt.contentEnd; i++) status = status * 256 + der[i];

  const token =
    statusInfo.end < outer.contentEnd ? der.slice(statusInfo.end, outer.contentEnd) : null;

  return { status, statusText: PKI_STATUS_TEXT[status] ?? `unknown(${status})`, token };
}

// === Providers ===

const ANCHOR_TIMEOUT_MS = 15_000;

export function anchorProvider(): AnchorProvider | null {
  const p = (process.env.ANCHOR_PROVIDER ?? "").toLowerCase();
  if (p === "rfc3161" || p === "ebsi") return p;
  // Configuring a TSA is enough to mean "anchor with it".
  return process.env.TSA_URL ? "rfc3161" : null;
}

export const EBSI_UNAVAILABLE_DETAIL =
  "EBSI anchoring is not implemented. EBSI is a permissioned network: writing to it requires onboarding as a participant, a DID registered in the EBSI DID registry, and accreditation through the European Blockchain Partnership's process. LayGrounded holds no such credentials, and no anchor is claimed. Use ANCHOR_PROVIDER=rfc3161 with a TSA_URL — an eIDAS-qualified timestamp carries a legal presumption as to date and time across the EU and requires no onboarding.";

async function anchorRfc3161(rootHex: string): Promise<AnchorOutcome> {
  const tsaUrl = process.env.TSA_URL;
  if (!tsaUrl) {
    return {
      anchored: false,
      reason: "not_configured",
      detail:
        "No TSA_URL configured, so this root was not independently timestamped. It remains a valid integrity proof; its as-of time is asserted by LayGrounded alone.",
    };
  }

  // The root is already a SHA-256 digest, but a TSA timestamps whatever
  // digest it is handed — so hash the root itself. What the token then
  // attests is "this exact root existed", which is the claim we want.
  const imprint = createHash("sha256").update(rootHex, "utf8").digest("hex");
  const nonce = randomBytes(8);
  const requestedAt = new Date().toISOString();

  try {
    const res = await fetch(tsaUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/timestamp-query",
        ...(process.env.TSA_AUTH_HEADER ? { Authorization: process.env.TSA_AUTH_HEADER } : {}),
      },
      body: Buffer.from(encodeTimeStampReq(imprint, { nonce })),
      signal: AbortSignal.timeout(ANCHOR_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        anchored: false,
        reason: "provider_error",
        detail: `TSA returned HTTP ${res.status}; root not anchored.`,
      };
    }

    const der = new Uint8Array(await res.arrayBuffer());
    const parsed = parseTimeStampResp(der);
    // Only granted / grantedWithMods are a timestamp. Anything else is the
    // TSA declining, and must not be recorded as an anchor.
    if (parsed.status !== 0 && parsed.status !== 1) {
      return {
        anchored: false,
        reason: "provider_error",
        detail: `TSA declined: ${parsed.statusText}; root not anchored.`,
      };
    }
    if (!parsed.token) {
      return {
        anchored: false,
        reason: "provider_error",
        detail: `TSA reported ${parsed.statusText} but returned no timestamp token; root not anchored.`,
      };
    }

    return {
      anchored: true,
      provider: "rfc3161",
      token: Buffer.from(parsed.token).toString("base64"),
      tsaUrl,
      requestedAt,
      status: parsed.status,
    };
  } catch (e) {
    return {
      anchored: false,
      reason: "provider_error",
      detail: `TSA request failed (${e instanceof Error ? e.message : String(e)}); root not anchored.`,
    };
  }
}

// Anchors a Merkle root with the configured provider. Never throws, never
// invents: an unanchored root comes back anchored:false with the reason, and
// the caller ledgers that fact rather than a fiction.
export async function anchorMerkleRoot(rootHex: string): Promise<AnchorOutcome> {
  const provider = anchorProvider();
  if (!provider) {
    return {
      anchored: false,
      reason: "not_configured",
      detail:
        "No anchor provider configured (set ANCHOR_PROVIDER=rfc3161 and TSA_URL). The root is a valid integrity proof but is not independently timestamped: its as-of time rests on LayGrounded's own clock.",
    };
  }
  if (provider === "ebsi") {
    return { anchored: false, reason: "unsupported", detail: EBSI_UNAVAILABLE_DETAIL };
  }
  return anchorRfc3161(rootHex);
}
