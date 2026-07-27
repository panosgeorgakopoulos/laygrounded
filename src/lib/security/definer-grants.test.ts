import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractDefinerFunctions,
  findUnlockedDefinerFunctions,
  revokesExecuteFrom,
  INTENTIONALLY_EXECUTABLE,
} from "./definer-grants";

const MIGRATIONS_DIR = join(import.meta.dir, "../../../supabase/migrations");

function loadMigrations(): Array<{ file: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8") }));
}

describe("extractDefinerFunctions", () => {
  test("finds a dollar-quoted definer function and its return type", () => {
    const sql = `
      CREATE OR REPLACE FUNCTION public.refresh_thing()
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $$ BEGIN REFRESH MATERIALIZED VIEW public.thing; END; $$;
    `;
    expect(extractDefinerFunctions(sql, "m.sql")).toEqual([
      { name: "refresh_thing", file: "m.sql", returns: "void" },
    ]);
  });

  test("ignores SECURITY INVOKER functions", () => {
    const sql = `
      create function public.plain() returns int language sql
      security invoker as $$ select 1 $$;
    `;
    expect(extractDefinerFunctions(sql, "m.sql")).toEqual([]);
  });

  test("does not match the phrase inside a comment or a function body", () => {
    const sql = `
      -- CREATE FUNCTION public.ghost() RETURNS void SECURITY DEFINER
      create function public.real() returns text language plpgsql
      as $$ BEGIN RETURN 'security definer'; END; $$;
    `;
    expect(extractDefinerFunctions(sql, "m.sql")).toEqual([]);
  });

  test("captures event_trigger return type", () => {
    const sql = `
      CREATE FUNCTION public.on_ddl() RETURNS event_trigger
      LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN END; $$;
    `;
    expect(extractDefinerFunctions(sql, "m.sql")[0].returns).toBe("event_trigger");
  });
});

describe("revokesExecuteFrom", () => {
  const sql = `
    REVOKE EXECUTE ON FUNCTION public.locked() FROM public, anon, authenticated;
    REVOKE EXECUTE ON FUNCTION public.half_locked() FROM public;
    revoke all on function public.arged(text) from anon, authenticated;
  `;

  test("detects a by-name revoke", () => {
    expect(revokesExecuteFrom(sql, "locked", "anon")).toBe(true);
    expect(revokesExecuteFrom(sql, "locked", "authenticated")).toBe(true);
  });

  test("a revoke from `public` alone does not count — the bug this catches", () => {
    expect(revokesExecuteFrom(sql, "half_locked", "anon")).toBe(false);
    expect(revokesExecuteFrom(sql, "half_locked", "authenticated")).toBe(false);
  });

  test("handles REVOKE ALL and argument lists", () => {
    expect(revokesExecuteFrom(sql, "arged", "anon")).toBe(true);
  });

  test("an unmentioned function is not revoked", () => {
    expect(revokesExecuteFrom(sql, "absent", "anon")).toBe(false);
  });
});

describe("findUnlockedDefinerFunctions", () => {
  test("flags a definer function left executable by anon", () => {
    const files = [
      {
        file: "bad.sql",
        sql: `CREATE FUNCTION public.leaky() RETURNS void LANGUAGE plpgsql
              SECURITY DEFINER AS $$ BEGIN END; $$;
              REVOKE EXECUTE ON FUNCTION public.leaky() FROM public;`,
      },
    ];
    const unlocked = findUnlockedDefinerFunctions(files);
    expect(unlocked).toHaveLength(1);
    expect(unlocked[0].fn.name).toBe("leaky");
    expect(unlocked[0].revokesAnon).toBe(false);
  });

  test("accepts a revoke that lands in a later migration", () => {
    const files = [
      {
        file: "a.sql",
        sql: `CREATE FUNCTION public.fixed() RETURNS void LANGUAGE plpgsql
              SECURITY DEFINER AS $$ BEGIN END; $$;`,
      },
      {
        file: "b.sql",
        sql: `REVOKE EXECUTE ON FUNCTION public.fixed() FROM public, anon, authenticated;`,
      },
    ];
    expect(findUnlockedDefinerFunctions(files)).toEqual([]);
  });

  test("exempts event_trigger functions, which PostgREST cannot call", () => {
    const files = [
      {
        file: "a.sql",
        sql: `CREATE FUNCTION public.on_ddl() RETURNS event_trigger LANGUAGE plpgsql
              SECURITY DEFINER AS $$ BEGIN END; $$;`,
      },
    ];
    expect(findUnlockedDefinerFunctions(files)).toEqual([]);
  });
});

// The regression guard itself. This is the check that would have caught the
// honesty-index / pricing-oracle / port-resilience refresh functions being
// reachable by `anon` for ~11 days.
describe("migration corpus", () => {
  test("every SECURITY DEFINER function revokes EXECUTE from anon and authenticated", () => {
    const unlocked = findUnlockedDefinerFunctions(loadMigrations());
    const report = unlocked.map(
      (a) =>
        `  ${a.fn.name} (${a.fn.file}) — missing revoke from ` +
        [!a.revokesAnon && "anon", !a.revokesAuthenticated && "authenticated"]
          .filter(Boolean)
          .join(" + "),
    );
    expect(
      unlocked.length,
      `SECURITY DEFINER functions reachable by end-user roles:\n${report.join("\n")}\n\n` +
        "REVOKE ... FROM public is NOT enough on Supabase: anon/authenticated hold " +
        "direct grants from default privileges. Revoke them by name, or add the " +
        "function to INTENTIONALLY_EXECUTABLE with a written reason.",
    ).toBe(0);
  });

  test("the allowlist has no stale entries", () => {
    const migrations = loadMigrations();
    const declared = new Set(
      migrations.flatMap(({ file, sql }) => extractDefinerFunctions(sql, file)).map((f) => f.name),
    );
    for (const name of INTENTIONALLY_EXECUTABLE) {
      expect(declared.has(name), `${name} is allowlisted but no longer declared`).toBe(true);
    }
  });
});
