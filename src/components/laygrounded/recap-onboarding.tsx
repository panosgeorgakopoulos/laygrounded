"use client";

// Self-serve onboarding: paste the fixture recap you already have, get a
// working claim.
//
// The parsing engine (src/lib/api/plg.ts) and its route have existed and been
// unit-tested for a while, reachable only by machine. This is the human
// entrance to it — the difference between a capability and a feature.
//
// Two things it deliberately does NOT do:
//  * It does not call an LLM. The parser is deterministic regex, so onboarding
//    is instant, free, reproducible and works with no API quota — which is why
//    it can be the very first thing a prospect touches.
//  * It does not pretend it understood more than it did. Everything the parser
//    missed is listed, with the default it fell back to, before the user goes
//    near a calculation. A demurrage figure resting on a silently-guessed
//    laytime allowance is worse than no figure.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/core/Card";
import { FileText, AlertTriangle, ArrowRight } from "lucide-react";
import styles from "./RecapOnboarding.module.css";

interface RecapClaimFields {
  vessel: string | null;
  port: string | null;
  cargo: string | null;
  voyageRef: string | null;
  counterpartyName: string | null;
}

interface RoiSnapshot {
  claimCount: number;
  quantifiedClaimCount: number;
  unquantifiedClaimCount: number;
  totalClaimedValue: number;
  timeBarExpiredValue: number;
  atRiskValue: number;
  estimatedLeakage: number;
  narrative: string;
}

interface OnboardResult {
  claimId: string;
  parsed: {
    claim: RecapClaimFields;
    cpTerms: Record<string, unknown>;
    matched: string[];
    missing: string[];
    warnings: string[];
  };
  roi: RoiSnapshot;
  nextSteps: string[];
}

const SAMPLE = `MV ARCTIC HORIZON / VR-2024-0336
Charterer: Oldendorff Carriers GmbH
Load port: Rotterdam, NL
Cargo: Soybeans 54,000 MT
Laytime: 48 hours WWDSSHEX EIU
Demurrage: USD 18,000 per day / despatch half demurrage
Turn time: 6 hours, NOR WIBON`;

// Money, without inventing precision the source data does not have.
function money(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function pretty(field: string): string {
  return field
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .toLowerCase()
    .trim();
}

export function RecapOnboarding() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OnboardResult | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/v1/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recap_text: text }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(
          res.status === 422
            ? "Nothing recognisable as a fixture recap in that text. Paste the recap itself — vessel, port, cargo, laytime and demurrage lines — rather than an email thread around it."
            : body?.error === "VALIDATION_ERROR"
              ? "The recap needs to be at least 20 characters."
              : body?.error || `Request failed (${res.status})`
        );
        return;
      }
      setResult(body as OnboardResult);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const parsed = result?.parsed;
  const roi = result?.roi;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Start from a fixture recap</CardTitle>
        <CardDescription>
          Paste the recap you already have and LayGrounded builds the claim and charter-party terms
          from it. Deterministic parsing — no AI, no waiting, and every field it could not find is
          listed below with the default it used, so nothing is guessed silently.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <textarea
          className={styles.textarea}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={9}
          placeholder={SAMPLE}
          spellCheck={false}
          aria-label="Fixture recap text"
        />

        <div className={styles.actions}>
          <button
            className={styles.btnPrimary}
            onClick={submit}
            disabled={busy || text.trim().length < 20}
          >
            <FileText size={14} />
            {busy ? "PARSING…" : "PARSE RECAP & CREATE CLAIM"}
          </button>
          {!text && (
            <button className={styles.btnGhost} onClick={() => setText(SAMPLE)} disabled={busy}>
              Use a sample recap
            </button>
          )}
        </div>

        {error && <p className={styles.error}>{error}</p>}

        {parsed && result && (
          <div className={styles.result}>
            <div className={styles.resultHead}>
              <span className={styles.ok}>Claim created</span>
              <button
                className={styles.btnPrimary}
                onClick={() => router.push(`/claims/${result.claimId}/workspace`)}
              >
                OPEN WORKSPACE <ArrowRight size={14} />
              </button>
            </div>

            <dl className={styles.fields}>
              {(
                [
                  ["Vessel", parsed.claim.vessel],
                  ["Voyage", parsed.claim.voyageRef],
                  ["Port", parsed.claim.port],
                  ["Cargo", parsed.claim.cargo],
                  ["Counterparty", parsed.claim.counterpartyName],
                ] as [string, string | null][]
              ).map(([label, value]) => (
                <div key={label} className={styles.field}>
                  <dt>{label}</dt>
                  <dd className={value ? "" : styles.unset}>{value ?? "not stated"}</dd>
                </div>
              ))}
            </dl>

            {parsed.matched.length > 0 && (
              <p className={styles.note}>
                <strong>Read from the recap:</strong> {parsed.matched.map(pretty).join(", ")}.
              </p>
            )}

            {parsed.missing.length > 0 && (
              <p className={styles.warn}>
                <AlertTriangle size={13} />
                <span>
                  <strong>Fell back to defaults:</strong> {parsed.missing.map(pretty).join(", ")}.
                  Check these in the workspace before relying on any figure — they drive the
                  calculation.
                </span>
              </p>
            )}

            {parsed.warnings.map((w, i) => (
              <p key={i} className={styles.warn}>
                <AlertTriangle size={13} />
                <span>{w}</span>
              </p>
            ))}

            {roi && roi.claimCount > 1 && (
              <div className={styles.roi}>
                <p className={styles.roiNarrative}>{roi.narrative}</p>
                <div className={styles.roiGrid}>
                  <div>
                    <span className={styles.roiValue}>{money(roi.totalClaimedValue)}</span>
                    <span className={styles.roiLabel}>claimed across {roi.claimCount} claims</span>
                  </div>
                  <div>
                    <span className={styles.roiValue}>{money(roi.atRiskValue)}</span>
                    <span className={styles.roiLabel}>within the time-bar warning window</span>
                  </div>
                  <div>
                    <span className={`${styles.roiValue} ${styles.roiBad}`}>
                      {money(roi.timeBarExpiredValue)}
                    </span>
                    <span className={styles.roiLabel}>already past its deadline</span>
                  </div>
                  <div>
                    <span className={styles.roiValue}>{roi.unquantifiedClaimCount}</span>
                    <span className={styles.roiLabel}>claims with no calculation yet</span>
                  </div>
                </div>
              </div>
            )}

            <ul className={styles.next}>
              {result.nextSteps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
