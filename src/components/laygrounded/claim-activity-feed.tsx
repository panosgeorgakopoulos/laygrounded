"use client";

// "How did we get to this number?"
//
// The platform has a lot of autonomous actors — ERPs pushing schedules, AIS
// deriving verdicts, agents trading concessions, webhooks firing — and the
// single most important thing this view does is say WHO did each thing.
//
// The actor filter is the feature, not decoration. An auditor's first question
// is "which of this did a person decide?", and answering it should be one click
// rather than a reading exercise. `unknown` is shown as its own kind for the
// same reason it exists in the projection: a machine's action attributed to a
// person is worse than an unattributed one.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Bot,
  Cpu,
  History,
  Loader2,
  Plug,
  User,
  HelpCircle,
} from "lucide-react";
import styles from "./ClaimActivityFeed.module.css";

type ActorKind = "human" | "system" | "ai" | "external" | "unknown";

interface Entry {
  id: string;
  at: string;
  category: string;
  actorKind: ActorKind;
  actorLabel: string | null;
  summary: string;
  detail?: string | null;
  amount?: { value: number; currency: string } | null;
}

const ACTORS: Array<{
  kind: ActorKind;
  label: string;
  Icon: typeof User;
  hint: string;
}> = [
  { kind: "human", label: "Person", Icon: User, hint: "Someone in your team decided this" },
  { kind: "ai", label: "AI", Icon: Bot, hint: "Extraction, drafting or an autonomous agent" },
  { kind: "system", label: "System", Icon: Cpu, hint: "The engine, a sweep or a trigger" },
  { kind: "external", label: "External", Icon: Plug, hint: "An ERP, a counterparty or a provider" },
  { kind: "unknown", label: "Unattributed", Icon: HelpCircle, hint: "Provenance was not recorded" },
];

const ACTOR_CLASS: Record<ActorKind, string> = {
  human: styles.human,
  ai: styles.ai,
  system: styles.system,
  external: styles.external,
  unknown: styles.unknown,
};

function when(iso: string): string {
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}Z`;
}

function money(v: number, ccy: string): string {
  return `${v < 0 ? "−" : ""}${ccy} ${Math.abs(v).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  })}`;
}

export function ClaimActivityFeed({ claimId }: { claimId: string }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ActorKind | "all">("all");

  const load = useCallback(async () => {
    try {
      const d = await fetch(`/api/claims/${claimId}/activity`).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      setEntries(d.entries ?? []);
      setTruncated(Boolean(d.truncated));
      setError(null);
    } catch {
      setError("Could not load the activity ledger.");
    } finally {
      setLoading(false);
    }
  }, [claimId]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of entries) c[e.actorKind] = (c[e.actorKind] ?? 0) + 1;
    return c;
  }, [entries]);

  const shown = useMemo(
    () => (filter === "all" ? entries : entries.filter((e) => e.actorKind === filter)),
    [entries, filter]
  );

  if (loading) {
    return (
      <div className={styles.wrap}>
        <p className={styles.loading}>
          <Loader2 size={13} className={styles.spin} /> Loading activity…
        </p>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <header className={styles.head}>
        <h3 className={styles.title}>
          <History size={15} /> Activity ledger
        </h3>
        <span className={styles.total}>{entries.length} entries</span>
      </header>

      <p className={styles.intro}>
        Every state change on this claim, newest first — who or what caused it, and when. Projected
        from the underlying records rather than kept as a separate log, so it cannot drift from what
        actually happened.
      </p>

      {error && (
        <p className={styles.error}>
          <AlertCircle size={14} /> {error}
        </p>
      )}

      <div className={styles.filters} role="group" aria-label="Filter by actor">
        <button
          type="button"
          className={`${styles.filter} ${filter === "all" ? styles.filterOn : ""}`}
          onClick={() => setFilter("all")}
        >
          All
        </button>
        {ACTORS.filter((a) => counts[a.kind]).map((a) => (
          <button
            key={a.kind}
            type="button"
            title={a.hint}
            className={`${styles.filter} ${filter === a.kind ? styles.filterOn : ""}`}
            onClick={() => setFilter(filter === a.kind ? "all" : a.kind)}
          >
            <a.Icon size={12} /> {a.label}
            <span className={styles.filterCount}>{counts[a.kind]}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className={styles.empty}>
          {entries.length === 0
            ? "Nothing has happened on this claim yet."
            : "No entries from that actor."}
        </p>
      ) : (
        <ol className={styles.feed}>
          {shown.map((e) => {
            const actor = ACTORS.find((a) => a.kind === e.actorKind) ?? ACTORS[4];
            return (
              <li key={e.id} className={styles.entry}>
                <span className={`${styles.icon} ${ACTOR_CLASS[e.actorKind]}`} title={actor.hint}>
                  <actor.Icon size={12} />
                </span>
                <div className={styles.body}>
                  <div className={styles.line}>
                    <strong className={styles.summary}>{e.summary}</strong>
                    {e.amount && (
                      <span className={`${styles.amount} tnum`}>
                        {money(e.amount.value, e.amount.currency)}
                      </span>
                    )}
                  </div>
                  <div className={styles.meta}>
                    <span className={`${styles.when} tnum`}>{when(e.at)}</span>
                    <span className={`${styles.actorTag} ${ACTOR_CLASS[e.actorKind]}`}>
                      {actor.label}
                    </span>
                    {e.actorLabel && <span className={styles.actorLabel}>{e.actorLabel}</span>}
                    <span className={styles.category}>{e.category}</span>
                  </div>
                  {e.detail && <p className={styles.detail}>{e.detail}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {truncated && (
        <p className={styles.truncated}>
          <AlertCircle size={13} /> This is the most recent window, not the full history — at least
          one source hit its row cap. Older entries exist in the underlying records.
        </p>
      )}
    </div>
  );
}
