// Server-side reads for the public Legal Knowledge Graph.
//
// kb_clauses / kb_precedents are the app's one public-read surface (anon SELECT),
// so this uses the service-role client purely to read public reference data
// without a request/cookie context (it also runs from the sitemap at build).
// Every function swallows errors into a safe empty/null fallback, so a DB blip
// degrades a page to "nothing found" rather than failing a build or a render.

import { createServiceRoleClient } from "@/lib/supabase/server";

export interface KbClause {
  slug: string;
  cpForm: string;
  clauseRef: string | null;
  title: string;
  body: string;
  tags: string[];
  sourceLabel: string;
  sourceUrl: string | null;
}

export interface KbPrecedent {
  slug: string;
  caseName: string;
  citation: string | null;
  jurisdiction: string | null;
  summary: string;
  holding: string | null;
  tags: string[];
  sourceLabel: string;
  sourceUrl: string | null;
}

export interface KnowledgeHit {
  type: "clause" | "precedent";
  slug: string;
  title: string;
  snippet: string;
  cpForm: string | null;
  tags: string[];
}

const CLAUSE_COLS = "slug, cp_form, clause_ref, title, body, tags, source_label, source_url";
const PRECEDENT_COLS =
  "slug, case_name, citation, jurisdiction, summary, holding, tags, source_label, source_url";

function toClause(r: Record<string, unknown>): KbClause {
  return {
    slug: r.slug as string,
    cpForm: r.cp_form as string,
    clauseRef: (r.clause_ref as string | null) ?? null,
    title: r.title as string,
    body: r.body as string,
    tags: (r.tags as string[]) ?? [],
    sourceLabel: r.source_label as string,
    sourceUrl: (r.source_url as string | null) ?? null,
  };
}

export async function listClauses(): Promise<KbClause[]> {
  try {
    const db = createServiceRoleClient();
    const { data } = await db
      .from("kb_clauses")
      .select(CLAUSE_COLS)
      .order("cp_form", { ascending: true })
      .order("title", { ascending: true });
    return (data ?? []).map((r) => toClause(r as Record<string, unknown>));
  } catch {
    return [];
  }
}

export async function getClauseBySlug(slug: string): Promise<KbClause | null> {
  try {
    const db = createServiceRoleClient();
    const { data } = await db.from("kb_clauses").select(CLAUSE_COLS).eq("slug", slug).maybeSingle();
    return data ? toClause(data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Full-text search across clauses and (when populated) precedents. */
export async function searchKnowledge(
  q: string,
  opts: { cpForm?: string; limit?: number } = {}
): Promise<KnowledgeHit[]> {
  const query = q.trim();
  if (!query) return [];
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
  try {
    const db = createServiceRoleClient();

    let clauseQ = db
      .from("kb_clauses")
      .select("slug, cp_form, title, body, tags")
      .textSearch("search", query, { type: "websearch", config: "english" })
      .limit(limit);
    if (opts.cpForm) clauseQ = clauseQ.eq("cp_form", opts.cpForm);

    const precedentQ = db
      .from("kb_precedents")
      .select("slug, case_name, summary, tags")
      .textSearch("search", query, { type: "websearch", config: "english" })
      .limit(limit);

    const [clauses, precedents] = await Promise.all([clauseQ, precedentQ]);

    const hits: KnowledgeHit[] = [];
    for (const r of clauses.data ?? []) {
      const row = r as Record<string, unknown>;
      hits.push({
        type: "clause",
        slug: row.slug as string,
        title: row.title as string,
        snippet: (row.body as string).slice(0, 200),
        cpForm: (row.cp_form as string) ?? null,
        tags: (row.tags as string[]) ?? [],
      });
    }
    for (const r of precedents.data ?? []) {
      const row = r as Record<string, unknown>;
      hits.push({
        type: "precedent",
        slug: row.slug as string,
        title: row.case_name as string,
        snippet: (row.summary as string).slice(0, 200),
        cpForm: null,
        tags: (row.tags as string[]) ?? [],
      });
    }
    return hits;
  } catch {
    return [];
  }
}
