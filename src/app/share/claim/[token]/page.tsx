// The counterparty statement view.
//
// What an owner sends when they want a charterer to CHECK a figure rather than
// argue about it: the laytime statement, the timeline it was derived from, the
// vessel's track, and the fingerprint of the engine that produced the number.
//
// Server-rendered from the validated token, outside the authenticated group and
// outside the proxy matcher — same shape as `/rooms/[token]`, and for the same
// reason: the reader has no Supabase session and never will.
//
// NOT THE SAME THING AS A CLAIM ROOM, and the distinction is the whole point of
// the phase. A room is a negotiation the counterparty can write into. This is
// evidence they can only read, and the token that reaches it cannot write —
// `/api/rooms/[token]/proposals` refuses a readonly token with a 404.

import type { Metadata } from "next";
import { resolveShareForMode } from "@/lib/rooms";
import { loadStatementView } from "@/lib/sharing/statement-view-server";
import { Logo } from "@/components/laygrounded/Logo";
import { StatementTrack } from "./statement-track";
import styles from "./Statement.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Laytime Statement — LayGrounded",
  // The URL contains a credential. It must never be indexed, and must not leak
  // into the referrer of anything the reader clicks next.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function hours(value: number): string {
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} h`;
}

/** UTC, always, and labelled as such — a laytime dispute turns on the zone. */
function utc(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export default async function SharedStatementPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = await resolveShareForMode(token, "readonly");

  // One dead end for unknown, revoked, expired AND wrong-mode. The reader is
  // never told which — a token that "exists but is the wrong kind" is a fact
  // worth nothing to a legitimate recipient and something to a prober.
  if (!resolved) {
    return (
      <main className={styles.page}>
        <div className={styles.deadEnd}>
          <Logo variant="auth" />
          <h1 className={styles.deadTitle}>This statement is no longer available</h1>
          <p className={styles.deadBody}>
            The link may have expired or been withdrawn by the sender. Ask them for a fresh one —
            statements are shared as revocable links, so an old one stops working by design.
          </p>
        </div>
      </main>
    );
  }

  const view = await loadStatementView(resolved);
  const { claim, terms, calculation, events, verifier, track } = view;
  const currency = calculation?.totals.currency ?? terms.currency ?? "USD";
  const net = calculation
    ? calculation.totals.demurrage_amount - calculation.totals.despatch_amount
    : 0;

  return (
    <main className={styles.page}>
      <div className={styles.sheet}>
        {/* ── Header ─────────────────────────────────────────────────── */}
        <header className={styles.header}>
          <div className={styles.brand}>
            <Logo variant="auth" />
            <span className={styles.readonlyBadge}>Read-only statement</span>
          </div>
          <h1 className={styles.title}>{claim.vessel}</h1>
          <p className={styles.subtitle}>
            {claim.voyageRef} · {claim.port}
            {claim.terminal ? ` · ${claim.terminal}` : ""} · {claim.cargo}
          </p>
          <p className={styles.sharedWith}>
            Shared with <strong>{view.share.counterpartyLabel || "your organisation"}</strong> ·
            access expires {utc(view.share.expiresAt)}
          </p>
        </header>

        {/* ── The figure ─────────────────────────────────────────────── */}
        {calculation ? (
          <section className={styles.section} aria-label="Laytime result">
            <div className={styles.headline}>
              <span className={styles.headlineLabel}>
                {net >= 0 ? "Demurrage claimed" : "Despatch due to charterers"}
              </span>
              <span className={`${styles.headlineFigure} tnum`}>
                {money(Math.abs(net), currency)}
              </span>
            </div>

            <dl className={styles.totals}>
              <div>
                <dt>Laytime allowed</dt>
                <dd className="tnum">{hours(calculation.totals.allowed_hours)}</dd>
              </div>
              <div>
                <dt>Laytime used</dt>
                <dd className="tnum">{hours(calculation.totals.used_hours)}</dd>
              </div>
              <div>
                <dt>Time on demurrage</dt>
                <dd className="tnum">{hours(calculation.totals.time_on_demurrage_hours)}</dd>
              </div>
              <div>
                <dt>Time saved</dt>
                <dd className="tnum">{hours(calculation.totals.time_saved_hours)}</dd>
              </div>
              {calculation.totals.demurrage_half_rate_hours !== undefined && (
                <div>
                  {/* ASBATANKVOY Part II cl. 8 — absent entirely under GENCON 94,
                      rather than shown as a zero that implies the rule was
                      evaluated and did not apply. */}
                  <dt>Of which at half rate</dt>
                  <dd className="tnum">{hours(calculation.totals.demurrage_half_rate_hours)}</dd>
                </div>
              )}
            </dl>

            <p className={styles.computedAt}>
              Computed {utc(calculation.computedAt)} under {claim.cpForm} terms.
            </p>
          </section>
        ) : (
          <section className={styles.section}>
            {/* Never rendered as a zero. A counterparty must not read "not yet
                calculated" as "nothing is owed". */}
            <p className={styles.empty}>
              No laytime calculation has been published for this claim yet.
            </p>
          </section>
        )}

        {/* ── Terms the arithmetic rests on ──────────────────────────── */}
        <section className={styles.section} aria-label="Charterparty terms">
          <h2 className={styles.sectionTitle}>Terms applied</h2>
          <dl className={styles.terms}>
            <div>
              <dt>Laytime allowed</dt>
              <dd className="tnum">
                {terms.laytimeAllowedHours !== null ? hours(terms.laytimeAllowedHours) : "—"}
              </dd>
            </div>
            <div>
              <dt>Turn time</dt>
              <dd className="tnum">
                {terms.turnTimeHours !== null ? hours(terms.turnTimeHours) : "—"}
              </dd>
            </div>
            <div>
              <dt>Demurrage rate</dt>
              <dd className="tnum">
                {terms.demurrageRate !== null
                  ? `${money(terms.demurrageRate, currency)} / day`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Despatch rate</dt>
              <dd className="tnum">
                {terms.despatchRate !== null
                  ? `${money(terms.despatchRate, currency)} / day`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Days basis</dt>
              <dd>{terms.daysBasis ?? "—"}</dd>
            </div>
            <div>
              <dt>NOR</dt>
              <dd>{terms.norVariant ?? "—"}</dd>
            </div>
          </dl>
        </section>

        {/* ── The breakdown ──────────────────────────────────────────── */}
        {calculation && calculation.breakdown.length > 0 && (
          <section className={styles.section} aria-label="Laytime breakdown">
            <h2 className={styles.sectionTitle}>Laytime breakdown</h2>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">From (UTC)</th>
                    <th scope="col">To (UTC)</th>
                    <th scope="col" className={styles.right}>
                      Hours
                    </th>
                    <th scope="col">Counts</th>
                    <th scope="col">Clause</th>
                    <th scope="col">Reasoning</th>
                  </tr>
                </thead>
                <tbody>
                  {calculation.breakdown.map((row, i) => (
                    <tr key={i} className={row.counts ? undefined : styles.notCounted}>
                      <td className="tnum">{utc(row.start_time)}</td>
                      <td className="tnum">{utc(row.end_time)}</td>
                      <td className={`${styles.right} tnum`}>{row.duration_hours.toFixed(2)}</td>
                      <td>
                        <span className={row.counts ? styles.yes : styles.no}>
                          {row.counts ? "Yes" : "No"}
                        </span>
                      </td>
                      <td className={styles.clause}>{row.clause_ref}</td>
                      <td className={styles.reasoning}>{row.reasoning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* ── Vessel track ───────────────────────────────────────────── */}
        <section className={styles.section} aria-label="Vessel position track">
          <h2 className={styles.sectionTitle}>Vessel track</h2>
          {track && track.length > 1 ? (
            <StatementTrack track={track} portLat={claim.portLat} portLon={claim.portLon} />
          ) : (
            // Says which it is. "We could not look" and "she did not move" are
            // different claims, and only one of them is evidence.
            <p className={styles.empty}>
              No AIS position data is available for this voyage, so the timeline above is not
              corroborated against the vessel&apos;s movements here.
            </p>
          )}
        </section>

        {/* ── Statement of Facts ─────────────────────────────────────── */}
        <section className={styles.section} aria-label="Statement of Facts timeline">
          <h2 className={styles.sectionTitle}>Statement of Facts ({events.length})</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Time (UTC)</th>
                  <th scope="col">Event</th>
                  <th scope="col">As recorded</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={i}>
                    <td className="tnum">{utc(e.occurredAt)}</td>
                    <td>{e.eventType.replace(/_/g, " ")}</td>
                    <td className={styles.reasoning}>{e.rawText}</td>
                  </tr>
                ))}
                {events.length === 0 && (
                  <tr>
                    <td colSpan={3} className={styles.empty}>
                      No confirmed events on this claim yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── The fingerprint ────────────────────────────────────────── */}
        <section className={styles.section} aria-label="Engine verification">
          <h2 className={styles.sectionTitle}>Verify this calculation</h2>
          {verifier.available ? (
            <>
              <p className={styles.verifyIntro}>
                These figures were produced by a deterministic rules engine, not by a model. The
                fingerprint below identifies the exact rule set: run the published verifier against
                its conformance suite and you should reproduce this root. It does not depend on
                trusting this application.
              </p>
              <dl className={styles.fingerprint}>
                <div>
                  <dt>Engine rule set</dt>
                  <dd className="tnum">v{verifier.engineVersion}</dd>
                </div>
                <div>
                  <dt>Conformance root</dt>
                  <dd className={`${styles.mono} tnum`}>{verifier.conformanceRoot}</dd>
                </div>
                <div>
                  <dt>Conformance cases</dt>
                  <dd className="tnum">{verifier.conformanceCases.toLocaleString("en-US")}</dd>
                </div>
                {verifier.wasmSha256 && (
                  <div>
                    <dt>Verifier WASM SHA-256</dt>
                    <dd className={`${styles.mono} tnum`}>{verifier.wasmSha256}</dd>
                  </div>
                )}
                <div>
                  <dt>Verifier version</dt>
                  <dd className="tnum">{verifier.verifierVersion}</dd>
                </div>
              </dl>
              <p className={styles.verifyNote}>
                The root fingerprints the <strong>engine</strong>, and is identical for every claim
                computed on this rule set — it is not a per-claim hash and does not change when this
                claim changes.
              </p>
            </>
          ) : (
            // Explicit, so a missing build artefact can never read as a
            // verified one.
            <p className={styles.empty}>
              The engine fingerprint is not available in this deployment, so these figures cannot be
              independently verified from this page.
            </p>
          )}
        </section>

        {/* ── Export ─────────────────────────────────────────────────── */}
        <section className={styles.section}>
          <a className={styles.exportButton} href={`/api/share/claim/${token}?format=csv`} download>
            Download as CSV
          </a>
          <p className={styles.verifyNote}>
            Contains the totals, the full breakdown and the Statement of Facts timeline.
          </p>
        </section>

        <footer className={styles.footer}>
          <p>
            Generated {utc(view.generatedAt)} · This is a read-only statement. Nothing on this page
            can be edited, and the link can be withdrawn by the sender at any time.
          </p>
        </footer>
      </div>
    </main>
  );
}
