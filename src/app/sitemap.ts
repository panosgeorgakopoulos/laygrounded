import type { MetadataRoute } from "next";
import { listClauses } from "@/lib/knowledge/query";

const BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://laygrounded.com";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const staticPaths: Array<[string, number]> = [
    ["", 1],
    ["/features", 0.8],
    ["/pricing", 0.7],
    ["/about", 0.6],
    ["/contact", 0.5],
    ["/knowledge", 0.9],
    ["/legal/terms", 0.3],
    ["/legal/privacy", 0.3],
  ];
  // Only listed once actually published — the page 404s while the flag is unset,
  // and a sitemap entry pointing at a 404 is worse than no entry.
  if (process.env.PUBLIC_CONGESTION_INDEX === "1") {
    staticPaths.push(["/congestion", 0.9]);
  }
  const staticRoutes: MetadataRoute.Sitemap = staticPaths.map(([p, priority]) => ({
    url: `${BASE}${p}`,
    lastModified: now,
    changeFrequency: "weekly",
    priority,
  }));

  // listClauses() falls back to [] on any DB error, so the sitemap still builds.
  const clauses = await listClauses();
  const clauseRoutes: MetadataRoute.Sitemap = clauses.map((c) => ({
    url: `${BASE}/knowledge/${c.slug}`,
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.6,
  }));

  return [...staticRoutes, ...clauseRoutes];
}
