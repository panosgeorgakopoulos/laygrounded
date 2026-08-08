// Static audit of SECURITY DEFINER functions declared in the migration files.
//
// Why this exists: three migrations (20260714000002, 20260714000004,
// 20260715000002) each declared "service_role only" as
//
//   REVOKE EXECUTE ON FUNCTION ... FROM public;
//
// and every one of them silently failed. On Supabase, default privileges grant
// EXECUTE on new public-schema functions to `anon` and `authenticated`
// *directly* — those are explicit role grants, not memberships of the PUBLIC
// pseudo-role, so a REVOKE FROM public does not touch them. The result was
// three SECURITY DEFINER functions that any holder of the publishable anon key
// could invoke over PostgREST, while the route comments asserted the opposite.
//
// A SECURITY DEFINER function runs with its owner's privileges, so leaving one
// reachable by `anon` hands an unauthenticated caller whatever that owner can
// do. The rule enforced here: every such function must revoke EXECUTE from
// `anon` and `authenticated` by name, not via `public`.
//
// Pure string analysis over the .sql files — no DB connection — so it runs in
// CI wherever the repo is checked out.

export interface DefinerFunction {
  name: string;
  file: string;
  /** Declared return type, lowercased. `event_trigger` is not PostgREST-reachable. */
  returns: string | null;
}

export interface DefinerAudit {
  fn: DefinerFunction;
  revokesAnon: boolean;
  revokesAuthenticated: boolean;
}

/**
 * Functions that intentionally keep EXECUTE for end-user roles.
 *
 * The RLS helpers are invoked from inside policy expressions, which evaluate as
 * the querying role — revoking EXECUTE from `authenticated` would deny every
 * policy that calls them and lock users out of their own rows. They are safe to
 * expose because each one answers only about the caller's own memberships
 * (keyed on auth.uid()) and returns a boolean or the caller's own company ids.
 */
export const INTENTIONALLY_EXECUTABLE = new Set([
  "current_user_company_ids",
  "is_company_member",
  // Same role as is_company_member, for the UPDATE policy on `companies`: it is
  // evaluated inside a policy, so `authenticated` must retain EXECUTE. It
  // answers only about the caller's own membership (keyed on auth.uid()) and is
  // revoked from `anon`, which has no auth.uid() to match anyway.
  "is_company_admin",
  "user_owns_claim",
  "user_owns_event",
  "user_owns_integration",
  // The RBAC helpers (20260805000000). Same reasoning as the membership helpers
  // above: they are evaluated inside the policy expressions on finance_grants,
  // counterparty_finance and settlement_chain_configs, which run as the querying
  // role, so revoking EXECUTE from `authenticated` would deny those policies and
  // lock every user out of rows they own. Each answers only about the CALLER's
  // own membership (keyed on auth.uid()) and returns their own role or its rank —
  // it cannot be asked about anyone else. Both are revoked from `public` AND
  // `anon` by name, so an anonymous caller cannot reach them at all.
  "current_member_role",
  "current_role_rank",
  // Supabase Auth invokes this hook as the `supabase_auth_admin` role, not over
  // PostgREST. Never enabled on this project (see the JWT app_metadata note in
  // the RLS migrations), but it is declared in 20260711000003.
  "custom_access_token_hook",
]);

const FUNCTION_HEADER_RE =
  /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi;

/**
 * Extracts the SECURITY DEFINER functions declared in one migration file.
 *
 * A function's "header" is everything between `CREATE FUNCTION` and the start of
 * its body (`AS $...$`, or `AS '...'` for SQL-language one-liners). `SECURITY
 * DEFINER` and `RETURNS` both live there, so scanning the header avoids matching
 * the words where they appear inside a body or a comment.
 */
export function extractDefinerFunctions(sql: string, file: string): DefinerFunction[] {
  const found: DefinerFunction[] = [];
  // Strip line comments so a commented-out CREATE, or the phrase "SECURITY
  // DEFINER" in prose, cannot register as a declaration.
  const stripped = sql.replace(/--[^\n]*/g, "");

  for (const match of stripped.matchAll(FUNCTION_HEADER_RE)) {
    const start = match.index + match[0].length;
    const rest = stripped.slice(start);
    // Body opener: a dollar-quote tag, or AS followed by a single-quoted string.
    const bodyStart = rest.search(/\$[a-z0-9_]*\$|\bas\s+'/i);
    const header = bodyStart === -1 ? rest.slice(0, 400) : rest.slice(0, bodyStart);

    if (!/\bsecurity\s+definer\b/i.test(header)) continue;

    const returnsMatch = header.match(/\breturns\s+(?:setof\s+)?([a-z0-9_.]+)/i);
    found.push({
      name: match[1],
      file,
      returns: returnsMatch ? returnsMatch[1].toLowerCase() : null,
    });
  }
  return found;
}

/**
 * True when `sql` revokes EXECUTE on `fnName` from the given role by name.
 *
 * Matches `REVOKE EXECUTE ON FUNCTION [public.]fn(...) FROM a, b, c` and
 * tolerates the `REVOKE ALL` spelling. Deliberately does NOT count a revoke
 * from `public` — that is the exact mistake this module exists to catch.
 */
export function revokesExecuteFrom(sql: string, fnName: string, role: string): boolean {
  const stripped = sql.replace(/--[^\n]*/g, "");
  const re = new RegExp(
    `revoke\\s+(?:execute|all)[^;]*?\\bon\\s+function\\s+(?:public\\.)?${fnName}\\s*\\([^)]*\\)\\s*from\\s+([^;]+);`,
    "gi",
  );
  for (const match of stripped.matchAll(re)) {
    const roles = match[1].split(",").map((r) => r.trim().toLowerCase());
    if (roles.includes(role)) return true;
  }
  return false;
}

/**
 * Audits every declared SECURITY DEFINER function against the full corpus of
 * migration SQL (a later migration may revoke what an earlier one created).
 */
export function auditDefinerGrants(
  files: Array<{ file: string; sql: string }>,
): DefinerAudit[] {
  const allSql = files.map((f) => f.sql).join("\n");
  const seen = new Map<string, DefinerFunction>();

  for (const { file, sql } of files) {
    for (const fn of extractDefinerFunctions(sql, file)) {
      // A CREATE OR REPLACE in a later migration re-declares the same function;
      // audit it once, attributed to where it first appeared.
      if (!seen.has(fn.name)) seen.set(fn.name, fn);
    }
  }

  return [...seen.values()].map((fn) => ({
    fn,
    revokesAnon: revokesExecuteFrom(allSql, fn.name, "anon"),
    revokesAuthenticated: revokesExecuteFrom(allSql, fn.name, "authenticated"),
  }));
}

/**
 * The audit reduced to the functions that violate the rule. Empty = clean.
 *
 * THE ALLOWLIST IS PER-ROLE, AND THAT IS THE POINT.
 *
 * It used to exempt a listed function from BOTH checks, which is broader than
 * anything the entries justify. Every reason written beside a name in
 * `INTENTIONALLY_EXECUTABLE` is the same one: the function is called from
 * inside an RLS policy expression, policies evaluate as the querying role, so
 * revoking `authenticated` would deny users their own rows. Not one of them is
 * an argument for letting `anon` execute anything.
 *
 * The consequence of the coarse version showed up in Supabase's own security
 * advisor after Phase 17: five SECURITY DEFINER helpers were executable by
 * `anon` and by the PUBLIC pseudo-role, and this test was green throughout
 * because the names were on the list. Nothing was exploitable — they all key on
 * `auth.uid()`, which is NULL for an anonymous caller — but "the grant is
 * harmless because of how the function happens to be written" is not the
 * guarantee this module claims to provide.
 *
 * So: `anon` is never exempt. `authenticated` may be, with a written reason.
 *
 * `event_trigger` functions stay fully exempt — Postgres invokes them on DDL
 * and they have no PostgREST-callable signature to revoke.
 */
export function findUnlockedDefinerFunctions(
  files: Array<{ file: string; sql: string }>,
): DefinerAudit[] {
  return auditDefinerGrants(files).filter((a) => {
    if (a.fn.returns === "event_trigger") return false;
    // No exemptions, for any function, ever.
    if (!a.revokesAnon) return true;
    // `authenticated` is the only half the allowlist may waive.
    if (INTENTIONALLY_EXECUTABLE.has(a.fn.name)) return false;
    return !a.revokesAuthenticated;
  });
}
