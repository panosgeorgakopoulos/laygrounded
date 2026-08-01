"use client";

// The audit room: what makes this claim checkable without trusting us.
//
// This is the view a trade-finance counterparty reasons about, shown to the
// owner so they know what they are handing over. Its whole job is to be
// precise about which hash answers which question, because the two here are
// routinely conflated and the consequence of conflating them is a reader who
// believes a tampered claim is intact:
//
//   ENGINE — `conformanceRoot` is a behavioural digest of what the verifier
//   computes across 500 published cases. It is IDENTICAL for every claim on
//   the same rule set and does not move when this claim changes. It answers
//   "is this the engine you say it is".
//
//   THIS CLAIM — the notarisation digest is a Merkle root over this claim's
//   sealed state, and it is what an RFC-3161 authority timestamped. It moves
//   the moment anything in the claim moves. It answers "has this claim
//   changed since it was sealed".
//
// Absent values are shown as absent. A claim that was never notarised says so
// rather than showing a blank that reads as zero.

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  BadgeCheck,
  Cpu,
  Download,
  FileJson,
  Loader2,
  ShieldCheck,
  Stamp,
} from "lucide-react";
import styles from "./ClaimVerificationPanel.module.css";

interface VerifierDescriptor {
  version: string;
  tzdataDigest: string;
  wasmSha256: string;
  mjsSha256: string;
  conformanceCases: number;
  conformanceRoot: string;
  downloadPath: string;
  conformancePath: string;
}

interface View {
  engine: {
    version: 1 | 2;
    fingerprint: { name: string; version: string; fingerprint: string };
  };
  verifier: VerifierDescriptor;
  notarization: {
    digest: string;
    algorithm: string;
    anchoredAt: string;
    authority: string | null;
  } | null;
  published: unknown | null;
  counts: { confirmedEvents: number };
  caveats: string[];
  howToVerify: string[];
  bundleBytes: number;
}

/** Long hex, middle-elided. Full value stays in the title for copying. */
function short(hex: string, head = 16): string {
  if (!hex) return "—";
  return hex.length <= head + 6 ? hex : `${hex.slice(0, head)}…${hex.slice(-6)}`;
}

function bytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`;
}

export function ClaimVerificationPanel({ claimId }: { claimId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetch(`/api/claims/${claimId}/verification`).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      setView(d as View);
      setError(null);
    } catch {
      setError("Could not load the verification record for this claim.");
    } finally {
      setLoading(false);
    }
  }, [claimId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className={styles.wrap}>
        <p className={styles.loading}>
          <Loader2 size={13} className={styles.spin} /> Loading verification record…
        </p>
      </div>
    );
  }
  if (!view) {
    return (
      <div className={styles.wrap}>
        <p className={styles.error}>
          <AlertCircle size={14} /> {error ?? "Unavailable."}
        </p>
      </div>
    );
  }

  const v = view.verifier;
  // An empty digest means the verifier build manifest was not on disk. Shown as
  // unavailable rather than as an empty string that could read as "verified".
  const artifactsPublished = Boolean(v.conformanceRoot);

  return (
    <div className={styles.wrap}>
      <header className={styles.head}>
        <h3 className={styles.title}>
          <ShieldCheck size={15} /> Audit &amp; verification
        </h3>
        <a
          className={styles.download}
          href={`/api/claims/${claimId}/verification?download=1`}
          download
        >
          <Download size={14} /> Download verification bundle
          <span className={styles.size}>{bytes(view.bundleBytes)}</span>
        </a>
      </header>

      <p className={styles.intro}>
        This claim does not ask anyone to take a figure on trust. The bundle below carries the{" "}
        <strong>facts</strong> — charterparty terms and the confirmed event timeline — plus the
        figures published from them and the fingerprint of the engine that produced them. A
        counterparty runs that engine themselves, offline, and compares. Nothing in that step
        contacts us.
      </p>

      {/* ── The engine ───────────────────────────────────────────────── */}
      <section className={styles.block}>
        <h4 className={styles.blockTitle}>
          <Cpu size={13} /> Engine
        </h4>
        <dl className={styles.rows}>
          <div className={styles.row}>
            <dt>Rule set</dt>
            <dd>
              <span className={styles.badge}>v{view.engine.version}</span>
              <span className={styles.note}>
                {view.engine.version === 2
                  ? "agreed excepted periods deducted under GENCON 94 + SHINC"
                  : "as published through 2026-07; frozen"}
              </span>
            </dd>
          </div>
          <div className={styles.row}>
            <dt>Conformance root</dt>
            <dd>
              <code className="tnum" title={v.conformanceRoot || undefined}>
                {artifactsPublished ? v.conformanceRoot : "unavailable"}
              </code>
              <span className={styles.note}>
                What the verifier computes across {v.conformanceCases || "—"} published cases.{" "}
                <strong>Identical for every claim on this rule set</strong> — it fingerprints the
                engine, not this claim.
              </span>
            </dd>
          </div>
          <div className={styles.row}>
            <dt>Engine fingerprint</dt>
            <dd>
              <code className="tnum" title={view.engine.fingerprint.fingerprint}>
                {short(view.engine.fingerprint.fingerprint)}
              </code>
              <span className={styles.note}>
                Behavioural digest sealed into this claim&apos;s derivation record.
              </span>
            </dd>
          </div>
          <div className={styles.row}>
            <dt>Timezone table</dt>
            <dd>
              <code className="tnum" title={v.tzdataDigest || undefined}>
                {v.tzdataDigest ? short(v.tzdataDigest) : "unavailable"}
              </code>
              <span className={styles.note}>
                Pinned offsets, so a recomputation cannot drift when a runtime ships new tzdata.
              </span>
            </dd>
          </div>
        </dl>
      </section>

      {/* ── The artifacts ────────────────────────────────────────────── */}
      <section className={styles.block}>
        <h4 className={styles.blockTitle}>
          <FileJson size={13} /> Verifier artifacts
        </h4>
        {artifactsPublished ? (
          <dl className={styles.rows}>
            <div className={styles.row}>
              <dt>WASM SHA-256</dt>
              <dd>
                <code className="tnum" title={v.wasmSha256 || undefined}>
                  {v.wasmSha256 ? short(v.wasmSha256) : "not built"}
                </code>
                <span className={styles.note}>
                  Distribution-integrity check. The wasm is <strong>not</strong> byte-reproducible —
                  the compiler emits different bytes for identical input — so this confirms you
                  received the artifact we published, nothing more. The reproducible claim is the
                  conformance root above.
                </span>
              </dd>
            </div>
            <div className={styles.row}>
              <dt>Readable JS SHA-256</dt>
              <dd>
                <code className="tnum" title={v.mjsSha256 || undefined}>
                  {v.mjsSha256 ? short(v.mjsSha256) : "not built"}
                </code>
                <span className={styles.note}>
                  This one <strong>is</strong> reproducible: build from the same source and you get
                  the same bytes. It is the artifact an expert can actually read.
                </span>
              </dd>
            </div>
            <div className={styles.row}>
              <dt>Download</dt>
              <dd>
                <a className={styles.link} href={v.downloadPath}>
                  verifier (wasm)
                </a>
                {" · "}
                <a className={styles.link} href={v.conformancePath}>
                  conformance suite
                </a>
              </dd>
            </div>
          </dl>
        ) : (
          <p className={styles.unavailable}>
            <AlertCircle size={13} /> The verifier build manifest is not present on this deployment,
            so the artifact digests cannot be shown. The bundle is still fully verifiable — a
            counterparty recomputes from the facts it carries.
          </p>
        )}
      </section>

      {/* ── This claim ───────────────────────────────────────────────── */}
      <section className={styles.block}>
        <h4 className={styles.blockTitle}>
          <Stamp size={13} /> This claim
        </h4>
        <dl className={styles.rows}>
          <div className={styles.row}>
            <dt>Confirmed events</dt>
            <dd>
              <strong className="tnum">{view.counts.confirmedEvents}</strong>
              <span className={styles.note}>
                Only confirmed events are included. Anything extracted or pushed but not yet
                reviewed is excluded by design, and affects no figure here.
              </span>
            </dd>
          </div>
          <div className={styles.row}>
            <dt>Published figures</dt>
            <dd>
              {view.published ? (
                <span className={styles.yes}>
                  <BadgeCheck size={13} /> included — the verifier reports a match or names the
                  disagreeing figures
                </span>
              ) : (
                <span className={styles.no}>
                  not computed yet — the verifier will report what it computes, with nothing to
                  compare against
                </span>
              )}
            </dd>
          </div>
          <div className={styles.row}>
            <dt>Notarisation</dt>
            <dd>
              {view.notarization ? (
                <>
                  <code className="tnum" title={view.notarization.digest}>
                    {short(view.notarization.digest)}
                  </code>
                  <span className={styles.note}>
                    {view.notarization.algorithm} Merkle root over this claim&apos;s sealed state,
                    anchored {new Date(view.notarization.anchoredAt).toISOString().slice(0, 10)}
                    {view.notarization.authority
                      ? ` and timestamped by ${view.notarization.authority}`
                      : " with no RFC-3161 authority (locally sealed only)"}
                    . <strong>This</strong> is the hash that moves when the claim changes.
                  </span>
                </>
              ) : (
                <span className={styles.no}>
                  not notarised — there is no independent timestamp proving when this state existed.
                  The figures remain recomputable from the facts.
                </span>
              )}
            </dd>
          </div>
        </dl>
      </section>

      {/* ── How a bank checks it ─────────────────────────────────────── */}
      <details className={styles.details}>
        <summary>How a counterparty verifies this</summary>
        <ol className={styles.steps}>
          {view.howToVerify.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      </details>

      {view.caveats.length > 0 && (
        <details className={styles.details}>
          <summary>What this does not prove ({view.caveats.length})</summary>
          <ul className={styles.caveats}>
            {view.caveats.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
