"use client";

// Client-side filter over the server-rendered clause list. The full list is in
// the initial HTML (so it is crawlable and works without JS); this just adds an
// instant text/charter-party filter on top. The FTS API (/api/knowledge/search)
// exists for programmatic/external callers.

import { useMemo, useState } from "react";
import Link from "next/link";
import type { KbClause } from "@/lib/knowledge/query";
import styles from "./Knowledge.module.css";

const FORMS = ["ALL", "GENCON94", "ASBATANKVOY", "GENERAL"] as const;
const FORM_LABEL: Record<string, string> = {
  ALL: "All",
  GENCON94: "GENCON 94",
  ASBATANKVOY: "ASBATANKVOY",
  GENERAL: "Concepts",
};

export function KnowledgeBrowser({ clauses }: { clauses: KbClause[] }) {
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<string>("ALL");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clauses.filter((c) => {
      if (form !== "ALL" && c.cpForm !== form) return false;
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        c.body.toLowerCase().includes(q) ||
        (c.clauseRef ?? "").toLowerCase().includes(q) ||
        c.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [clauses, query, form]);

  return (
    <div>
      <div className={styles.searchRow}>
        <input
          className={styles.searchInput}
          type="search"
          placeholder="Search clauses, terms, tags…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search the knowledge base"
        />
      </div>
      <div className={styles.filterChips}>
        {FORMS.map((f) => (
          <button
            key={f}
            className={`${styles.chip} ${form === f ? styles.chipActive : ""}`}
            onClick={() => setForm(f)}
          >
            {FORM_LABEL[f]}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className={styles.empty}>No entries match your search.</p>
      ) : (
        <div className={styles.grid}>
          {filtered.map((c) => (
            <Link key={c.slug} href={`/knowledge/${c.slug}`} className={styles.cardLink}>
              <article className={styles.card}>
                <div className={styles.cardHead}>
                  <span className={styles.badge}>{FORM_LABEL[c.cpForm] ?? c.cpForm}</span>
                  {c.clauseRef && <span className={styles.ref}>{c.clauseRef}</span>}
                </div>
                <h3 className={styles.cardTitle}>{c.title}</h3>
                <p className={styles.snippet}>{c.body.slice(0, 160)}…</p>
                <div className={styles.tags}>
                  {c.tags.slice(0, 4).map((t) => (
                    <span key={t} className={styles.tag}>
                      {t}
                    </span>
                  ))}
                </div>
              </article>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
