import { describe, it, expect } from "bun:test";
import {
  canonicalJson,
  scrubMetadata,
  metadataHash,
  entryBody,
  entryHash,
  verifyChain,
  normaliseTimestamp,
  GENESIS_HASH,
  type StoredSecurityEvent,
} from "./security-log";

// A helper that builds a VALID chain the same way append_security_event()
// does, so the tests tamper with something known-good rather than asserting
// against hand-written hashes.
function buildChain(
  entries: Array<Partial<StoredSecurityEvent> & { action: StoredSecurityEvent["action"] }>
): StoredSecurityEvent[] {
  const out: StoredSecurityEvent[] = [];
  let prevHash = GENESIS_HASH;
  entries.forEach((e, i) => {
    const seq = i + 1;
    const row: StoredSecurityEvent = {
      id: `id-${seq}`,
      seq,
      occurredAt: new Date(Date.UTC(2026, 6, 23, 10, 0, seq)).toISOString(),
      companyId: "11111111-1111-1111-1111-111111111111",
      actorType: "user",
      actorId: "22222222-2222-2222-2222-222222222222",
      actorLabel: "ops@owner.com",
      resourceType: "claim",
      resourceId: `claim-${seq}`,
      outcome: "allowed",
      metadata: { note: `entry ${seq}` },
      metadataHash: "",
      prevHash,
      entryHash: "",
      ...e,
    };
    row.metadataHash = metadataHash(row.metadata);
    row.prevHash = prevHash;
    row.entryHash = entryHash(
      row.seq,
      row.prevHash,
      entryBody({
        occurredAt: row.occurredAt,
        companyId: row.companyId,
        actorType: row.actorType,
        actorId: row.actorId ?? "",
        actorLabel: row.actorLabel,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        outcome: row.outcome,
        metadataHash: row.metadataHash,
      })
    );
    prevHash = row.entryHash;
    out.push(row);
  });
  return out;
}

describe("canonicalJson", () => {
  it("is independent of key insertion order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts nested keys too — jsonb does not preserve order at any depth", () => {
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it("preserves array order, which is semantic", () => {
    expect(canonicalJson({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it("handles null, empty and undefined-valued keys", () => {
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("distinguishes values that would collide under naive concatenation", () => {
    expect(canonicalJson({ a: "1,b:2" })).not.toBe(canonicalJson({ a: "1", b: "2" }));
  });
});

describe("scrubMetadata", () => {
  it("redacts secrets that should never reach an audit row", () => {
    const out = scrubMetadata({
      webhookSecret: "s3cret",
      password: "hunter2",
      apiKey: "lga_abc",
      authorization: "Bearer x",
      refreshToken: "rt_1",
    });
    expect(Object.values(out).every((v) => v === "[redacted]")).toBe(true);
  });

  it("keeps the non-secret identifiers built for exactly this purpose", () => {
    const out = scrubMetadata({ keyPrefix: "lga_ab12cd34", apiKeyId: "k1", key_hash: "deadbeef" });
    expect(out.keyPrefix).toBe("lga_ab12cd34");
    expect(out.apiKeyId).toBe("k1");
    expect(out.key_hash).toBe("deadbeef");
  });

  it("recurses into nested objects", () => {
    const out = scrubMetadata({ outer: { secret: "x", safe: 1 } }) as { outer: Record<string, unknown> };
    expect(out.outer.secret).toBe("[redacted]");
    expect(out.outer.safe).toBe(1);
  });

  it("drops undefined rather than hashing an absent key", () => {
    expect(metadataHash(scrubMetadata({ a: 1, b: undefined }))).toBe(metadataHash({ a: 1 }));
  });
});

describe("normaliseTimestamp", () => {
  it("reproduces the written form from the Postgres spelling", () => {
    expect(normaliseTimestamp("2026-07-23T10:00:00.123+00:00")).toBe("2026-07-23T10:00:00.123Z");
    expect(normaliseTimestamp("2026-07-23T10:00:00.123Z")).toBe("2026-07-23T10:00:00.123Z");
  });

  it("passes unparseable values through rather than inventing a time", () => {
    expect(normaliseTimestamp("not-a-date")).toBe("not-a-date");
  });
});

describe("verifyChain", () => {
  const chain = buildChain([
    { action: "share.created" },
    { action: "settlement.cleared" },
    { action: "api_key.created" },
  ]);

  it("accepts an untouched chain and reports it anchored at genesis", () => {
    const v = verifyChain(chain);
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(3);
    expect(v.anchored).toBe(true);
    expect(v.headHash).toBe(chain[2].entryHash);
    expect(v.breaks).toEqual([]);
  });

  it("verifies regardless of the order rows arrive in", () => {
    expect(verifyChain([...chain].reverse()).ok).toBe(true);
  });

  it("catches an edited field — the core tamper case", () => {
    const tampered = structuredClone(chain);
    tampered[1].action = "share.revoked"; // rewrite history: hide a settlement
    const v = verifyChain(tampered);
    expect(v.ok).toBe(false);
    expect(v.breaks[0]).toMatchObject({ seq: 2, reason: "hash_mismatch" });
  });

  it("catches an edited actor — 'someone else did it'", () => {
    const tampered = structuredClone(chain);
    tampered[0].actorLabel = "someone.else@owner.com";
    const v = verifyChain(tampered);
    expect(v.ok).toBe(false);
    expect(v.breaks.some((b) => b.seq === 1 && b.reason === "hash_mismatch")).toBe(true);
  });

  it("catches a back-dated entry", () => {
    const tampered = structuredClone(chain);
    tampered[2].occurredAt = new Date(Date.UTC(2020, 0, 1)).toISOString();
    expect(verifyChain(tampered).ok).toBe(false);
  });

  it("catches a deleted middle entry as both a gap and a broken link", () => {
    const v = verifyChain([chain[0], chain[2]]);
    expect(v.ok).toBe(false);
    expect(v.breaks.map((b) => b.reason).sort()).toEqual(["prev_hash_mismatch", "sequence_gap"]);
    expect(v.breaks.find((b) => b.reason === "sequence_gap")?.detail).toContain("1 entry missing");
  });

  it("catches metadata edited underneath its digest, and reports it apart from the chain", () => {
    const tampered = structuredClone(chain);
    tampered[1].metadata = { note: "nothing to see here" };
    const v = verifyChain(tampered);
    expect(v.ok).toBe(false);
    expect(v.breaks).toHaveLength(1);
    expect(v.breaks[0]).toMatchObject({ seq: 2, reason: "metadata_mismatch" });
  });

  it("catches a first entry that does not link to genesis", () => {
    const forged = structuredClone(chain);
    forged[0].prevHash = "f".repeat(64);
    const v = verifyChain(forged);
    expect(v.ok).toBe(false);
    expect(v.breaks.some((b) => b.reason === "prev_hash_mismatch")).toBe(true);
  });

  it("does not claim a partial window is anchored", () => {
    // A page of recent entries proves its own consistency, not the prefix
    // before it — saying otherwise would overstate what was verified.
    const v = verifyChain([chain[1], chain[2]]);
    expect(v.ok).toBe(true);
    expect(v.anchored).toBe(false);
    expect(v.firstSeq).toBe(2);
  });

  it("is honest about the empty chain", () => {
    const v = verifyChain([]);
    expect(v.ok).toBe(true);
    expect(v.anchored).toBe(false);
    expect(v.headHash).toBeNull();
  });

  it("survives the Postgres timestamp spelling round-trip", () => {
    const fromDb = structuredClone(chain).map((r) => ({
      ...r,
      occurredAt: r.occurredAt.replace("Z", "+00:00"),
    }));
    expect(verifyChain(fromDb).ok).toBe(true);
  });

  it("survives jsonb key reordering, which Postgres does not preserve", () => {
    const rich = buildChain([{ action: "share.created", metadata: { a: 1, z: { m: 1, b: 2 } } }]);
    const reordered = rich.map((r) => ({ ...r, metadata: JSON.parse('{"z":{"b":2,"m":1},"a":1}') }));
    expect(verifyChain(reordered).ok).toBe(true);
  });
});

describe("entry format stability", () => {
  // The chain format is a persistence contract: entries written today must
  // still verify after a refactor. This pins the exact bytes.
  it("hashes a known entry to a fixed value", () => {
    const body = entryBody({
      occurredAt: "2026-07-23T10:00:00.000Z",
      companyId: "11111111-1111-1111-1111-111111111111",
      actorType: "user",
      actorId: "22222222-2222-2222-2222-222222222222",
      actorLabel: "ops@owner.com",
      action: "settlement.cleared",
      resourceType: "claim",
      resourceId: "33333333-3333-3333-3333-333333333333",
      outcome: "allowed",
      metadataHash: metadataHash({ amount: 148125, currency: "USD" }),
    });
    expect(body.split("\u001F")).toHaveLength(11);
    expect(body.startsWith("v1\u001F")).toBe(true);
    expect(entryHash(1, GENESIS_HASH, body)).toBe(
      "553652e2dd86b07670efbc4a851241c2678021cc6a84d0e17c93265460449889"
    );
  });
});
