/// <reference types="bun-types" />
// Fails the build when an API route has no way to reach it from the app.
//
//   bun run check:routes            # fail on any unallowlisted orphan
//   bun run check:routes -- --list  # print the full classification, exit 0
//
// WHY THIS EXISTS. Phase 12's manual sweep found five features with working
// backends and no UI. The worst was `finance-grants`: the audit room had spent
// four phases showing a bank exactly what it would be handed, while nothing in
// the product could actually hand it over. Nobody noticed because nothing was
// broken — the code compiled, the tests passed, and the gap was invisible from
// inside any single file.
//
// A snapshot of 1:1 surface area is worthless without something that keeps it
// there. This is that something.
//
// WHAT IT CANNOT CATCH, stated so nobody trusts it further than it deserves:
// a route referenced by a component nobody renders, a fetch built by string
// concatenation the regex cannot see, and a UI that calls the route but does
// nothing useful with it. It proves reachability, not usefulness.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const API_ROOT = join(REPO_ROOT, "src/app/api");
const SCAN_ROOTS = ["src/app", "src/components", "src/lib"];

/**
 * Routes that are correct to have no UI, each with the reason.
 *
 * A PREFIX MATCH, and the reason is mandatory. Adding an entry is a deliberate
 * statement that a human will never call this, and the reason is what a
 * reviewer checks — an allowlist of bare paths degrades into a place to silence
 * failures, which is exactly how the gap this script exists to prevent got in.
 */
const MACHINE_FACING: Array<{ prefix: string; reason: string }> = [
  // --- Scheduled sweeps -----------------------------------------------------
  { prefix: "/events/dispatch", reason: "cron: drains the transactional outbox" },
  { prefix: "/insurance/run", reason: "cron: parametric insurance sweep" },
  { prefix: "/settlement/run", reason: "cron: settlement clearing sweep" },
  { prefix: "/integrations/run-sync", reason: "cron: ERP sync sweep" },
  { prefix: "/voyage-shield/run", reason: "cron: in-voyage re-verification" },
  { prefix: "/voyage-notices/run", reason: "cron: notice generation sweep" },
  { prefix: "/v1/notary/run", reason: "cron: notarisation sweep" },
  { prefix: "/v1/webhooks/run", reason: "cron: webhook delivery queue" },
  { prefix: "/oauth/purge", reason: "cron: expired OAuth token purge" },

  // --- Machine-to-machine API ----------------------------------------------
  // The whole /v1 surface is the integrator API. It is documented by
  // /v1/openapi.json rather than by a page in this app, and requiring a UI for
  // each endpoint would mean building a screen for somebody else's software.
  { prefix: "/v1/", reason: "M2M integrator API (see /v1/openapi.json)" },

  // --- Inbound from other systems ------------------------------------------
  { prefix: "/integrations/", reason: "inbound ERP webhook receiver" },
  { prefix: "/mcp", reason: "MCP JSON-RPC server for agent clients" },
  { prefix: "/security/csp-report", reason: "browser-posted CSP violation reports" },

  // --- Operational ----------------------------------------------------------
  { prefix: "/health/", reason: "health probe" },
  { prefix: "/init-demo", reason: "admin bootstrap, header-secret guarded" },

  // --- Public / partner-facing ---------------------------------------------
  { prefix: "/insurance/oracle", reason: "insurer read, API-key authenticated" },
  { prefix: "/tools/weather-checker/lead", reason: "public lead-magnet capture" },
  // Both of these were flagged by this script on its first run, and both turned
  // out to be deliberate public APIs whose UI reads the underlying library
  // directly. That is the distinction the reason field exists to record: the
  // capability HAS an interface, the route is simply not how the interface gets
  // its data. Left undocumented, a later reader would have deleted one.
  {
    prefix: "/knowledge/search",
    reason:
      "public FTS for programmatic callers; /knowledge renders server-side so it stays crawlable and works without JS",
  },
  {
    prefix: "/intel/congestion",
    reason:
      "public congestion nowcast API; /congestion is a server component reading lib/intel/congestion directly",
  },
];

interface Classification {
  route: string;
  referenced: boolean;
  allowlisted: { prefix: string; reason: string } | null;
}

/** Every `route.ts` under src/app/api, as its URL path with params normalised. */
function discoverRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "route.ts" || entry === "route.tsx") {
        const rel = relative(API_ROOT, dir).replace(/\\/g, "/");
        out.push(("/" + rel).replace(/\/\[[^\]]+\]/g, "/:p").replace(/^\/\.$/, "/"));
      }
    }
  };
  walk(API_ROOT);
  return [...new Set(out)].sort();
}

/**
 * Every `/api/...` path referenced anywhere in the front end.
 *
 * Scans `.ts` as well as `.tsx`: a fetch helper extracted into a hook or a lib
 * file is still a real reference, and only scanning components would report a
 * false orphan the first time somebody refactors one out.
 */
function discoverReferences(): Set<string> {
  const refs = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "node_modules" && entry !== ".next") walk(full);
        continue;
      }
      if (!/\.(tsx?|jsx?)$/.test(entry)) continue;
      // Route handlers are not references to themselves.
      if (full.startsWith(API_ROOT)) continue;

      const text = readFileSync(full, "utf8");
      for (const m of text.matchAll(/["'`]\/api\/([^"'`?\s)]*)/g)) {
        let path = "/" + m[1];
        // An interpolation NOT preceded by `/` is a suffix, not a path segment
        // — `/api/intel/benchmark${qs}` appends a query string. Treating it as
        // a segment yielded `/intel/benchmark:p`, which matched no route and
        // reported a live feature as orphaned. Truncate there instead.
        path = path.replace(/([^/])\$\{[^}]*\}.*$/, "$1");
        // A genuine path parameter — `/api/claims/${id}/events` — collapses to
        // the same `:p` the route discovery uses.
        path = path.replace(/\$\{[^}]*\}/g, ":p").replace(/\/+$/, "");
        refs.add(path || "/");
        // A reference to a sub-path implies its parent segment is reachable
        // (`/claims/:p/events/:p` proves `/claims/:p/events` is in use), which
        // is how a collection route with only item-level calls stays honest.
        const parts = path.split("/").filter(Boolean);
        for (let i = 1; i < parts.length; i++) refs.add("/" + parts.slice(0, i).join("/"));
      }
    }
  };
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root));
  return refs;
}

function classify(): Classification[] {
  const refs = discoverReferences();
  return discoverRoutes().map((route) => ({
    route,
    referenced: refs.has(route),
    allowlisted: MACHINE_FACING.find((m) => route.startsWith(m.prefix)) ?? null,
  }));
}

function main() {
  const listOnly = process.argv.includes("--list");
  const results = classify();

  const orphans = results.filter((r) => !r.referenced && !r.allowlisted);
  const covered = results.filter((r) => r.referenced);
  const machine = results.filter((r) => !r.referenced && r.allowlisted);

  if (listOnly) {
    console.log(`\nUI-reachable (${covered.length})`);
    for (const r of covered) console.log(`  ${r.route}`);
    console.log(`\nMachine-facing (${machine.length})`);
    for (const r of machine) console.log(`  ${r.route.padEnd(44)} ${r.allowlisted!.reason}`);
  }

  // An allowlisted route that a component DOES call is not an error — it is a
  // stale entry, and reporting it keeps the list from accumulating cruft that
  // would later hide a real orphan.
  const staleAllowlist = results.filter((r) => r.referenced && r.allowlisted);
  if (staleAllowlist.length > 0) {
    console.warn(
      `\n⚠ ${staleAllowlist.length} allowlisted route(s) are now called from the UI. ` +
        `Remove them from MACHINE_FACING so the list stays meaningful:`
    );
    for (const r of staleAllowlist) console.warn(`    ${r.route}`);
  }

  console.log(
    `\nroutes ${results.length} · UI-reachable ${covered.length} · machine-facing ${machine.length} · orphaned ${orphans.length}`
  );

  if (orphans.length > 0 && !listOnly) {
    console.error(
      `\n✗ ${orphans.length} API route(s) have no way to reach them from the app:\n`
    );
    for (const r of orphans) console.error(`    ${r.route}`);
    console.error(
      "\nEvery backend capability must be reachable from the UI. Either build the\n" +
        "interface, or — if this is genuinely machine-facing — add it to\n" +
        "MACHINE_FACING in scripts/check-orphaned-routes.ts WITH A REASON.\n" +
        "\nThe reason is not paperwork: it is what a reviewer checks to tell a\n" +
        "deliberate integration endpoint from a feature somebody forgot to finish.\n"
    );
    process.exit(1);
  }

  if (!listOnly) console.log("✓ every route is either UI-reachable or a declared machine endpoint\n");
}

main();
