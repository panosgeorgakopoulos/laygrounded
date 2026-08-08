"use client";

// The mandate you give the negotiating agents.
//
// WHAT THE ENGINE ACTUALLY TAKES. `executeAgenticArbitration` accepts exactly
// three knobs per side: a cumulative concession budget in money
// (`maxConcessionUsd`), a set of categories never conceded (`hardStopClauses`),
// and a round cap. That is the whole contract, and this panel does not invent
// a richer one.
//
// WHAT AN OPERATOR THINKS IN. Percentages of the claim ("hold 85% of it") and
// hours of a delay ("give up three hours of weather"). Both are shown, both are
// CONVERTED IN FRONT OF THE USER into the money figure the engine receives, and
// the converted figure is the one displayed. Hiding the conversion would make
// the mandate feel more precise than it is: the engine trades money, not hours,
// and an operator who believed otherwise would set a bound they did not mean.
//
// NOTHING HERE TOUCHES THE ENGINE'S DETERMINISM. The agents price every
// position with a real laytime run through `sensitivity.ts`; these limits only
// decide how far each side may move. A recommendation still has to clear a
// human review before anything settles.

import { useMemo, useState } from "react";
import { AlertCircle, Bot, Check, Loader2, Scale, Sparkles } from "lucide-react";
import { useCan } from "@/components/role-provider";
import styles from "./ConcessionStrategy.module.css";

/** Mirrors NEGOTIATION_CATEGORIES in `@/lib/negotiation/autonomous`. */
const CATEGORIES = [
  { key: "nor", label: "NOR validity", hint: "When laytime commenced" },
  { key: "completion", label: "Completion time", hint: "When the operation ended" },
  { key: "weather", label: "Weather delays", hint: "Excluded weather stoppages" },
  { key: "shifting", label: "Shifting", hint: "Time moving to or from berth" },
  { key: "excepted", label: "Excepted periods", hint: "Agreed exclusions such as strikes" },
] as const;

type CategoryKey = (typeof CATEGORIES)[number]["key"];

interface Matrix {
  currency: string;
  baselineNet: number;
  ownerOpening: number;
  chartererOpening: number;
  ownerFinal: number;
  chartererFinal: number;
  gap: number;
  recommendedSettlement: number;
  roundsCompleted: number;
  converged: boolean;
  settlementProbability: number;
  disputedValue: number;
  concessions: Array<{
    round: number;
    actor: "owner_agent" | "charterer_agent";
    category: string;
    label: string;
    amount: number;
    forcedByEvidence: boolean;
    rationale: string;
  }>;
  heldFirm: Array<{ actor: string; category: string; label: string; reason: string }>;
}

function money(n: number, ccy: string): string {
  return `${n < 0 ? "−" : ""}${ccy} ${Math.abs(n).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  })}`;
}

export function ConcessionStrategy({
  claimId,
  baselineNet,
  currency,
  demurrageRatePerDay,
}: {
  claimId: string;
  baselineNet: number;
  currency: string;
  demurrageRatePerDay: number;
}) {
  // The mandate is a money ceiling, so setting it is a finance decision even
  // though the controls read as percentages. Disabled rather than hidden: the
  // converted figure below is exactly what an operator needs to SEE before
  // asking a finance manager to authorise it.
  const canNegotiate = useCan("claim.negotiate");
  const [floorPct, setFloorPct] = useState(85);
  const [counterpartyFloorPct, setCounterpartyFloorPct] = useState(85);
  const [hardStops, setHardStops] = useState<CategoryKey[]>([]);
  const [maxRounds, setMaxRounds] = useState(12);
  const [running, setRunning] = useState(false);
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [review, setReview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const claimValue = Math.abs(baselineNet);

  // The engine's actual primitive, derived in front of the user.
  const ownerBudget = useMemo(
    () => Math.max(0, Math.round((claimValue * (100 - floorPct)) / 100)),
    [claimValue, floorPct]
  );
  const counterpartyBudget = useMemo(
    () => Math.max(0, Math.round((claimValue * (100 - counterpartyFloorPct)) / 100)),
    [claimValue, counterpartyFloorPct]
  );

  /** What an hour of delay is worth, so "three hours" has a price. */
  const perHour = demurrageRatePerDay / 24;
  const budgetHours = perHour > 0 ? ownerBudget / perHour : 0;

  function toggle(key: CategoryKey) {
    setHardStops((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/claims/${claimId}/negotiate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerLimits: { maxConcessionUsd: ownerBudget, hardStopClauses: hardStops },
          chartererLimits: { maxConcessionUsd: counterpartyBudget, hardStopClauses: [] },
          maxRounds,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(
          json.error === "NO_CONFIRMED_EVENTS"
            ? "This claim has no confirmed events, so there is no agenda to negotiate over."
            : (json.detail ?? json.error ?? "The negotiation could not be run.")
        );
      }
      setMatrix(json.matrix as Matrix);
      setReview(json.review as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The negotiation could not be run.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className={styles.wrap} aria-label="Concession strategy">
      <h4 className={styles.title}>
        <Bot size={14} /> Concession strategy
      </h4>
      <p className={styles.intro}>
        Two deterministic agents trade concessions over this claim&apos;s dispute agenda and
        recommend a settlement. Not language models — every position is a real engine run, and
        evidence overrides instructions: a contradicted event forces the side relying on it to
        yield, whatever mandate you set.
      </p>

      {claimValue === 0 && (
        <p className={styles.warn}>
          <AlertCircle size={13} /> This claim computes to zero, so there is nothing to concede.
          Percentages below would all resolve to a zero budget.
        </p>
      )}

      <div className={styles.grid}>
        <label className={styles.field}>
          <span className={styles.label}>
            Your floor <span className={styles.hint}>hold at least this much</span>
          </span>
          <div className={styles.sliderRow}>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={floorPct}
              onChange={(e) => setFloorPct(Number(e.target.value))}
            />
            <span className={`${styles.pct} tnum`}>{floorPct}%</span>
          </div>
          <span className={styles.derived}>
            Concession budget <strong>{money(ownerBudget, currency)}</strong>
            {perHour > 0 && (
              <>
                {" "}
                ≈ <strong>{budgetHours.toFixed(1)}h</strong> of delay at{" "}
                {money(demurrageRatePerDay, currency)}/day
              </>
            )}
          </span>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>
            Counterparty floor <span className={styles.hint}>what you assume of them</span>
          </span>
          <div className={styles.sliderRow}>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={counterpartyFloorPct}
              onChange={(e) => setCounterpartyFloorPct(Number(e.target.value))}
            />
            <span className={`${styles.pct} tnum`}>{counterpartyFloorPct}%</span>
          </div>
          <span className={styles.derived}>
            Their budget <strong>{money(counterpartyBudget, currency)}</strong> — an assumption, not
            a position they have taken.
          </span>
        </label>
      </div>

      <fieldset className={styles.stops}>
        <legend className={styles.label}>
          Never concede <span className={styles.hint}>held whatever the budget allows</span>
        </legend>
        <div className={styles.stopGrid}>
          {CATEGORIES.map((c) => (
            <label key={c.key} className={styles.stop}>
              <input
                type="checkbox"
                checked={hardStops.includes(c.key)}
                onChange={() => toggle(c.key)}
              />
              <span>
                <strong>{c.label}</strong>
                <span className={styles.stopHint}>{c.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <p className={styles.stopNote}>
          Facts still override this. An event the position record <em>contradicts</em> is conceded
          whether or not its category is held — evidence is not a bargaining chip, and an agent that
          argued past it would be recommending a settlement no tribunal would reach.
        </p>
      </fieldset>

      <div className={styles.runRow}>
        <label className={styles.rounds}>
          <span className={styles.label}>Max rounds</span>
          <input
            type="number"
            min={1}
            max={50}
            value={maxRounds}
            onChange={(e) => setMaxRounds(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
          />
        </label>
        <button
          type="button"
          className={styles.primary}
          disabled={running || !canNegotiate}
          title={
            canNegotiate
              ? undefined
              : "Running a negotiation commits a concession budget — it needs the Finance manager role."
          }
          onClick={() => void run()}
        >
          {running ? <Loader2 size={13} className={styles.spin} /> : <Sparkles size={13} />} Run
          negotiation
        </button>
      </div>

      {!canNegotiate && (
        <p className={styles.note}>
          You can model a mandate here, but committing one needs the{" "}
          <strong>Finance manager</strong> role — the budget above is real money this tenant&apos;s
          agent may concede. Ask an admin on your <a href="/settings/team">team page</a>.
        </p>
      )}

      {error && (
        <p className={styles.error}>
          <AlertCircle size={13} /> {error}
        </p>
      )}

      {matrix && (
        <div className={styles.result}>
          <div className={styles.resultHead}>
            <Scale size={14} />
            <span className={styles.resultLabel}>Recommended settlement</span>
            <strong className={`${styles.resultValue} tnum`}>
              {money(matrix.recommendedSettlement, matrix.currency)}
            </strong>
            <span className={matrix.converged ? styles.converged : styles.gapRemains}>
              {matrix.converged ? "converged" : `gap ${money(matrix.gap, matrix.currency)}`}
            </span>
          </div>

          <dl className={styles.stats}>
            <div>
              <dt>Baseline</dt>
              <dd className="tnum">{money(matrix.baselineNet, matrix.currency)}</dd>
            </div>
            <div>
              <dt>Final positions</dt>
              <dd className="tnum">
                {money(matrix.ownerFinal, matrix.currency)} vs{" "}
                {money(matrix.chartererFinal, matrix.currency)}
              </dd>
            </div>
            <div>
              <dt>Rounds</dt>
              <dd className="tnum">{matrix.roundsCompleted}</dd>
            </div>
            <div>
              <dt>Settlement likelihood</dt>
              <dd className="tnum">{Math.round(matrix.settlementProbability * 100)}%</dd>
            </div>
          </dl>

          <p className={styles.probabilityNote}>
            Likelihood is a deterministic ranking signal — how much of the opening gap the agents
            closed — not a statistical forecast. Use it to sort claims, not to price one.
          </p>

          {matrix.concessions.length > 0 && (
            <details className={styles.detail}>
              <summary>Concessions ({matrix.concessions.length})</summary>
              <ul className={styles.log}>
                {matrix.concessions.map((c, i) => (
                  <li key={i}>
                    <span className={c.actor === "owner_agent" ? styles.ownerTag : styles.cpTag}>
                      {c.actor === "owner_agent" ? "you" : "them"}
                    </span>
                    <span className={styles.logLabel}>{c.label}</span>
                    <span className="tnum">{money(c.amount, matrix.currency)}</span>
                    {c.forcedByEvidence && <span className={styles.forced}>forced by evidence</span>}
                    <span className={styles.rationale}>{c.rationale}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {matrix.heldFirm.length > 0 && (
            <details className={styles.detail}>
              <summary>Held firm ({matrix.heldFirm.length})</summary>
              <ul className={styles.log}>
                {matrix.heldFirm.map((h, i) => (
                  <li key={i}>
                    <span className={h.actor === "owner_agent" ? styles.ownerTag : styles.cpTag}>
                      {h.actor === "owner_agent" ? "you" : "them"}
                    </span>
                    <span className={styles.logLabel}>{h.label}</span>
                    <span className={styles.rationale}>{h.reason.replace(/_/g, " ")}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <p className={styles.hitl}>
            <Check size={13} />{" "}
            {review === "already_pending"
              ? "A previous recommendation on this claim is still awaiting a human decision, so this one was not queued."
              : "Queued for human review. Nothing settles until a person approves it."}
          </p>
        </div>
      )}
    </section>
  );
}
