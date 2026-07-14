"use client";

// Agentic drafting studio: a focused modal for generating legal
// correspondence and — crucially — reading the grounding verdict before
// anything leaves the building. The generate call runs the two-step drafting
// chain server-side (position analysis → letter → figure-by-figure grounding
// verification), so the loader stages mirror what is actually happening.

import { useCallback, useEffect, useState } from "react";
import styles from "./DraftingStudio.module.css";

export interface GeneratedDraft {
  id: string;
  kind: string;
  tone: string;
  subject: string;
  contentMd: string;
  grounding: {
    verified: boolean;
    issues: Array<{ type: string; value: string; message: string }>;
    amountsChecked?: number;
    clausesChecked?: number;
  };
  createdAt: string;
}

interface Props {
  claimId: string;
  open: boolean;
  onClose: () => void;
  // Fired when a draft lands (even if the modal was closed mid-generation)
  // so the workspace list stays in sync.
  onDrafted: (draft: GeneratedDraft) => void;
}

const KINDS: Array<{ value: string; label: string; blurb: string }> = [
  {
    value: "demand_letter",
    label: "Demand letter",
    blurb: "Formal demurrage claim with the clause-cited breakdown.",
  },
  {
    value: "letter_of_protest",
    label: "Letter of protest",
    blurb: "In-voyage protest — the one kind that works before a calculation exists.",
  },
  {
    value: "counter_argument",
    label: "Counter-argument",
    blurb: "Point-by-point rebuttal of the counterparty's position.",
  },
  {
    value: "settlement_proposal",
    label: "Settlement proposal",
    blurb: "Commercial middle ground, anchored to the computed exposure.",
  },
];

const TONES = ["firm", "neutral", "conciliatory"] as const;

// Mirrors the real server-side chain; purely cosmetic pacing.
const STAGES = [
  "Assembling the closed-world claim context…",
  "Analyzing the legal position…",
  "Drafting the letter…",
  "Verifying every figure and citation against the database…",
];

export function DraftingStudio({ claimId, open, onClose, onDrafted }: Props) {
  const [kind, setKind] = useState("demand_letter");
  const [tone, setTone] = useState<(typeof TONES)[number]>("firm");
  const [phase, setPhase] = useState<"configure" | "generating" | "done" | "error">(
    "configure"
  );
  const [stageIdx, setStageIdx] = useState(0);
  const [draft, setDraft] = useState<GeneratedDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (phase !== "generating") return;
    const t = setInterval(
      () => setStageIdx((i) => Math.min(i + 1, STAGES.length - 1)),
      12_000
    );
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const generate = useCallback(async () => {
    setPhase("generating");
    setStageIdx(0);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch(`/api/claims/${claimId}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, tone }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body.error === "NO_CALCULATION"
            ? "This draft kind needs a computed calculation first — confirm the events and recompute, or draft a letter of protest instead."
            : body.error || `Drafting failed (${res.status})`
        );
      }
      const d = (await res.json()).draft as GeneratedDraft;
      setDraft(d);
      onDrafted(d);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [claimId, kind, tone, onDrafted]);

  const copy = async () => {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${draft.contentMd}`);
      setCopied(true);
    } catch {
      setError("Clipboard unavailable — select the text manually.");
    }
  };

  const download = () => {
    if (!draft) return;
    const blob = new Blob([`# ${draft.subject}\n\n${draft.contentMd}\n`], {
      type: "text/markdown",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${draft.kind}-${draft.createdAt.slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!open) return null;

  const grounding = draft?.grounding;

  return (
    <div className={styles.overlay} onClick={onClose} role="presentation">
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Legal drafting studio"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <span className={`${styles.title} tnum`}>LEGAL DRAFTING STUDIO</span>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {phase === "configure" && (
          <>
            <div className={styles.sectionLabel}>Document type</div>
            <div className={styles.kindGrid}>
              {KINDS.map((k) => (
                <button
                  key={k.value}
                  className={`${styles.kindCard} ${kind === k.value ? styles.kindCardActive : ""}`}
                  onClick={() => setKind(k.value)}
                >
                  <span className={styles.kindLabel}>{k.label}</span>
                  <span className={styles.kindBlurb}>{k.blurb}</span>
                </button>
              ))}
            </div>

            <div className={styles.sectionLabel}>Tone</div>
            <div className={styles.toneRow} role="radiogroup" aria-label="Tone">
              {TONES.map((t) => (
                <button
                  key={t}
                  role="radio"
                  aria-checked={tone === t}
                  className={`${styles.toneBtn} ${tone === t ? styles.toneBtnActive : ""}`}
                  onClick={() => setTone(t)}
                >
                  {t.toUpperCase()}
                </button>
              ))}
            </div>

            <div className={styles.footerRow}>
              <span className={styles.hint}>
                Every generated figure is verified against the claim record before
                you see it — no unchecked numbers leave this screen.
              </span>
              <button className={styles.primaryBtn} onClick={generate}>
                GENERATE DRAFT
              </button>
            </div>
          </>
        )}

        {phase === "generating" && (
          <div className={styles.loaderWrap} aria-live="polite">
            <div className={styles.stageText}>{STAGES[stageIdx]}</div>
            <div className={styles.skeletonLines}>
              {Array.from({ length: 7 }).map((_, i) => (
                <div
                  key={i}
                  className={styles.skeletonLine}
                  style={{ width: `${88 - (i % 3) * 14}%` }}
                />
              ))}
            </div>
            <div className={styles.hint}>
              Two-model chain with grounding verification — usually about a minute.
              You can close this window; the draft will appear in the list when done.
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className={styles.loaderWrap}>
            <div className={styles.errorBox}>{error}</div>
            <div className={styles.footerRow}>
              <button className={styles.secondaryBtn} onClick={() => setPhase("configure")}>
                BACK
              </button>
              <button className={styles.primaryBtn} onClick={generate}>
                RETRY
              </button>
            </div>
          </div>
        )}

        {phase === "done" && draft && (
          <>
            {grounding?.verified ? (
              <div className={styles.groundingPass} role="status">
                <span className={styles.groundingBadge}>✓ VERIFICATION PASSED</span>
                <span>
                  Every monetary figure and clause citation in this letter was
                  checked against the claim record
                  {typeof grounding.amountsChecked === "number"
                    ? ` (${grounding.amountsChecked} amount${grounding.amountsChecked === 1 ? "" : "s"}, ${grounding.clausesChecked ?? 0} citation${(grounding.clausesChecked ?? 0) === 1 ? "" : "s"})`
                    : ""}
                  . Safe to send.
                </span>
              </div>
            ) : (
              <div className={styles.groundingFail} role="alert">
                <span className={styles.groundingBadge}>✗ VERIFICATION FAILED</span>
                <span>
                  The letter contains figures or citations that do not match the
                  claim record — review before sending:
                </span>
                <ul className={styles.issueList}>
                  {(grounding?.issues ?? []).map((iss, i) => (
                    <li key={i}>{iss.message}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className={styles.subjectLine}>
              <strong>{draft.subject}</strong>
            </div>
            <pre className={styles.letterBody}>{draft.contentMd}</pre>

            <div className={styles.footerRow}>
              <button className={styles.secondaryBtn} onClick={() => setPhase("configure")}>
                DRAFT ANOTHER
              </button>
              <span className={styles.footerActions}>
                <button className={styles.secondaryBtn} onClick={download}>
                  DOWNLOAD .MD
                </button>
                <button className={styles.primaryBtn} onClick={copy}>
                  {copied ? "COPIED ✓" : "COPY LETTER"}
                </button>
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
