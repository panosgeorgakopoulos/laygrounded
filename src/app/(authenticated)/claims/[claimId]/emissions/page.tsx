"use client";

// The green commercial view of one claim: what the delay emitted, what the
// allowances cost, and — the part that decides whether it is money you can
// recover — who carries it under this charterparty.
//
// Anchored on the CLAIM rather than the voyage because that is where the fact
// lives: a claim is one port call, and the demurrage period it records is what
// burned the fuel. A voyage-level roll-up would be a sum of these.

import { use, useCallback, useEffect, useState } from "react";
import styles from "./Emissions.module.css";

interface Line {
  label: string;
  value: string;
  emphasis?: boolean;
}

type TenantRole = "owner" | "charterer" | "trader";

interface Addendum {
  allocation: "charterer_liability" | "unrecovered_owner_cost" | "unallocated";
  direction: "receivable" | "payable" | "none" | "undetermined";
  tenantRole: TenantRole | null;
  title: string;
  amountEur: number;
  bearer: string;
  basis: string;
  warning: string | null;
  lines: Line[];
  footnotes: string[];
  decisionGrade: boolean;
  issuedAt: string;
}

interface Payload {
  addendum: Addendum;
  carbonCost: {
    emissions: {
      delayHours: number;
      co2Tonnes: number;
      noxKg: number;
      soxKg: number;
      fuelTonnes: number;
      fuel: string;
    };
    etsCostEur: number;
    etsScope: { share: number; phaseIn: number; scopeCertain: boolean; note: string };
    demurrageAmount: number | null;
    currency: string | null;
  };
  euaPrice: {
    priceEur: number;
    quoteDate: string | null;
    provenance: { source: string; provider: string; label: string };
  };
  claim: {
    vessel: string;
    voyageRef: string | null;
    port: string;
    cargo: string | null;
    charterer: string | null;
    owner: string | null;
    hasBimcoEtsClause: boolean | null;
    tenantRole: TenantRole | null;
  };
}

const num = (n: number, dp = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export default function ClaimEmissionsPage({
  params,
}: {
  params: Promise<{ claimId: string }>;
}) {
  const { claimId } = use(params);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/ets-addendum`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          body.error === "NO_CALCULATION"
            ? "This claim has no laytime calculation yet, so there is no demurrage period to price."
            : body.message || body.error || "Could not load the emissions view."
        );
        setData(null);
        return;
      }
      setData(body as Payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [claimId]);

  useEffect(() => {
    void load();
  }, [load]);

  const patchClaim = async (patch: Record<string, unknown>) => {
    setSaving(true);
    // Optimistic, but rolled back to the SERVER-CONFIRMED value on failure
    // rather than to whatever was there when the page loaded.
    const previous = data?.claim;
    try {
      const res = await fetch(`/api/claims/${claimId}/ets-addendum`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("Could not save that.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData((d) => (d && previous ? { ...d, claim: previous } : d));
    } finally {
      setSaving(false);
    }
  };

  const a = data?.addendum;
  const cc = data?.carbonCost;

  const allocationClass =
    a?.allocation === "charterer_liability"
      ? styles.allocRecoverable
      : a?.allocation === "unrecovered_owner_cost"
        ? styles.allocOwner
        : styles.allocUnknown;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Emissions &amp; carbon liability</h1>
        {data && (
          <p className={styles.pageSub}>
            {data.claim.vessel}
            {data.claim.voyageRef ? ` · ${data.claim.voyageRef}` : ""} · {data.claim.port}
          </p>
        )}
      </header>

      {loading && <div className={`${styles.skeleton} ${styles.skeletonBlock}`} aria-hidden="true" />}

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      {data && a && cc && (
        <>
          {!a.decisionGrade && (
            <div className={styles.banner} role="alert">
              <strong>Not decision-grade.</strong> One or more inputs to this figure is synthetic or
              uncertain — see the basis below. Do not send this to a counterparty as it stands.
            </div>
          )}

          {/* The allocation is the headline, not the amount: the same number
              means different things depending on the charterparty. */}
          <section className={`${styles.allocCard} ${allocationClass}`} aria-label="Liability allocation">
            <span className={styles.allocLabel}>{a.title}</span>
            <span className={styles.allocAmount}>EUR {num(a.amountEur)}</span>
            <span className={styles.allocBearer}>Borne by {a.bearer}</span>
            {/* The direction is the tenant-facing fact: the same amount is a
                receivable to an owner and a payable to a charterer. */}
            {a.direction !== "undetermined" && (
              <span
                className={`${styles.direction} ${
                  a.direction === "receivable"
                    ? styles.dirIn
                    : a.direction === "payable"
                      ? styles.dirOut
                      : styles.dirNone
                }`}
              >
                {a.direction === "receivable"
                  ? "Recoverable by you"
                  : a.direction === "payable"
                    ? "Payable by you"
                    : "No liability for you"}
              </span>
            )}
            {a.warning && <p className={styles.allocWarning}>{a.warning}</p>}
            <p className={styles.allocBasis}>{a.basis}</p>
          </section>

          <section className={styles.clauseCard} aria-label="Your role on this fixture">
            <div>
              <h2 className={styles.sectionTitle}>Your role on this fixture</h2>
              <p className={styles.sectionSub}>
                Decides which way the money runs. Under an identical ETS clause the same amount
                is recoverable by an owner and payable by a charterer.
              </p>
            </div>
            <div className={styles.clauseChoices} role="group" aria-label="Tenant role">
              {[
                { v: "owner" as const, label: "Owner" },
                { v: "charterer" as const, label: "Charterer" },
                { v: "trader" as const, label: "Trader" },
                { v: null, label: "Not recorded" },
              ].map((opt) => (
                <button
                  key={String(opt.v)}
                  type="button"
                  className={`${styles.choice} ${
                    data.claim.tenantRole === opt.v ? styles.choiceOn : ""
                  }`}
                  aria-pressed={data.claim.tenantRole === opt.v}
                  disabled={saving}
                  onClick={() => patchClaim({ tenantRole: opt.v })}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </section>

          <section className={styles.clauseCard} aria-label="Charterparty ETS clause">
            <div>
              <h2 className={styles.sectionTitle}>BIMCO ETS clause</h2>
              <p className={styles.sectionSub}>
                EU ETS puts the surrender obligation on the shipping company. Whether it is
                recoverable from the charterer depends on this clause — so the answer changes who
                the amount above falls on.
              </p>
            </div>
            <div className={styles.clauseChoices} role="group" aria-label="Clause status">
              {[
                { v: true as const, label: "Present" },
                { v: false as const, label: "Absent" },
                { v: null, label: "Not recorded" },
              ].map((opt) => (
                <button
                  key={String(opt.v)}
                  type="button"
                  className={`${styles.choice} ${
                    data.claim.hasBimcoEtsClause === opt.v ? styles.choiceOn : ""
                  }`}
                  aria-pressed={data.claim.hasBimcoEtsClause === opt.v}
                  disabled={saving}
                  onClick={() => patchClaim({ hasBimcoEtsClause: opt.v })}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </section>

          <section className={styles.statGrid} aria-label="Emissions of the delay">
            {[
              { k: "Demurrage period", v: `${num(cc.emissions.delayHours, 1)} h` },
              { k: "Fuel burned", v: `${num(cc.emissions.fuelTonnes, 3)} t ${cc.emissions.fuel}` },
              { k: "CO2 emitted", v: `${num(cc.emissions.co2Tonnes, 3)} t` },
              { k: "NOx", v: `${num(cc.emissions.noxKg)} kg` },
              { k: "SOx", v: `${num(cc.emissions.soxKg)} kg` },
              {
                k: "Demurrage claimed",
                v:
                  cc.demurrageAmount != null
                    ? `${cc.currency ?? "USD"} ${num(cc.demurrageAmount)}`
                    : "—",
              },
            ].map((s) => (
              <div key={s.k} className={styles.stat}>
                <span className={styles.statKey}>{s.k}</span>
                <span className={`${styles.statVal} tnum`}>{s.v}</span>
              </div>
            ))}
          </section>

          <section className={styles.detailCard} aria-label="Calculation and provenance">
            <h2 className={styles.sectionTitle}>Calculation</h2>
            <dl className={styles.lines}>
              {a.lines.map((l) => (
                <div key={l.label} className={`${styles.line} ${l.emphasis ? styles.lineStrong : ""}`}>
                  <dt>{l.label}</dt>
                  <dd className="tnum">{l.value}</dd>
                </div>
              ))}
            </dl>

            <div className={styles.priceRow}>
              <span className={styles.statKey}>EUA price</span>
              <span className="tnum">EUR {num(data.euaPrice.priceEur)} / tCO2</span>
              <span
                className={`${styles.pill} ${
                  data.euaPrice.provenance.source === "live"
                    ? styles.pillLive
                    : data.euaPrice.provenance.source === "mock"
                      ? styles.pillMock
                      : styles.pillAssumed
                }`}
              >
                {data.euaPrice.provenance.source === "live"
                  ? `Live · ${data.euaPrice.provenance.provider}`
                  : data.euaPrice.provenance.source === "mock"
                    ? "Mocked"
                    : "Assumption"}
              </span>
            </div>

            <ul className={styles.notes}>
              {a.footnotes.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>

            <div className={styles.actions}>
              <a className={styles.download} href={`/api/claims/${claimId}/ets-addendum?format=pdf`}>
                Download addendum (PDF)
              </a>
              <span className={styles.actionNote}>
                Regenerated server-side from the claim — the document can only ever state what the
                data supports.
              </span>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
