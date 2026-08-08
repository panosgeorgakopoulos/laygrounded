import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROLES,
  ROLE_RANK,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  CAPABILITY_MIN_ROLE,
  can,
  capabilitiesOf,
  isRole,
  roleOf,
  type Capability,
  type Role,
} from "./roles";

const ALL_CAPABILITIES = Object.keys(CAPABILITY_MIN_ROLE) as Capability[];

describe("the ladder", () => {
  // The invariant the min-role shape exists to guarantee. If someone refactors
  // to per-capability role lists, this is what catches the finance manager who
  // silently lost a capability every operator holds.
  test("capabilities are monotonic in rank", () => {
    for (const capability of ALL_CAPABILITIES) {
      for (const lower of ROLES) {
        if (!can(lower, capability)) continue;
        for (const higher of ROLES) {
          if (ROLE_RANK[higher] < ROLE_RANK[lower]) continue;
          expect({ capability, higher, allowed: can(higher, capability) }).toEqual({
            capability,
            higher,
            allowed: true,
          });
        }
      }
    }
  });

  test("admin holds every capability", () => {
    expect(capabilitiesOf("admin").sort()).toEqual([...ALL_CAPABILITIES].sort());
  });

  test("viewer holds only read", () => {
    expect(capabilitiesOf("viewer")).toEqual(["claim.read"]);
  });

  test("ranks are distinct and cover every role", () => {
    const ranks = ROLES.map((r) => ROLE_RANK[r]);
    expect(new Set(ranks).size).toBe(ROLES.length);
  });

  test("every role carries display copy", () => {
    for (const role of ROLES) {
      expect(ROLE_LABELS[role]?.length).toBeGreaterThan(0);
      expect(ROLE_DESCRIPTIONS[role]?.length).toBeGreaterThan(0);
    }
  });
});

describe("the operator boundary", () => {
  // Phase 14's whole premise, stated as assertions: a junior operator does the
  // laytime work and touches none of the money.
  test("an operator can do day-to-day claim work", () => {
    expect(can("operator", "claim.read")).toBe(true);
    expect(can("operator", "claim.write")).toBe(true);
  });

  test.each([
    "claim.negotiate",
    "claim.agree",
    "claim.settle",
    "finance.grant",
    "finance.counterparty",
    "team.manage",
  ] as Capability[])("an operator cannot %s", (capability) => {
    expect(can("operator", capability)).toBe(false);
  });

  test("a finance manager holds the money capabilities but not team management", () => {
    expect(can("finance_manager", "claim.agree")).toBe(true);
    expect(can("finance_manager", "claim.settle")).toBe(true);
    expect(can("finance_manager", "finance.grant")).toBe(true);
    expect(can("finance_manager", "finance.counterparty")).toBe(true);
    expect(can("finance_manager", "claim.negotiate")).toBe(true);
    expect(can("finance_manager", "team.manage")).toBe(false);
  });

  test("a viewer cannot write a claim", () => {
    expect(can("viewer", "claim.write")).toBe(false);
  });
});

describe("roleOf", () => {
  test("passes through every known role", () => {
    for (const role of ROLES) expect(roleOf(role)).toBe(role);
  });

  test("maps the legacy `member` to operator", () => {
    expect(roleOf("member")).toBe("operator");
  });

  test.each([null, undefined, "", "root", "ADMIN", "superuser", "finance-manager"])(
    "fails closed to viewer on %p",
    (raw) => {
      expect(roleOf(raw as string | null | undefined)).toBe("viewer");
    }
  );

  // Case matters: 'ADMIN' must not become admin. A case-insensitive coercion
  // would let any capitalisation reaching the column bypass the ladder.
  test("does not case-fold its way into a grant", () => {
    expect(can(roleOf("ADMIN"), "team.manage")).toBe(false);
  });

  test("isRole is exact", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("member")).toBe(false);
    expect(isRole(3)).toBe(false);
  });
});

describe("SQL parity", () => {
  // The one place the model is duplicated: RLS policies cannot import
  // TypeScript, so `current_role_rank()` restates the ladder. This test is what
  // makes that duplication safe — the SQL copy is the one nobody would think to
  // update when adding a role.
  const sql = readFileSync(
    join(import.meta.dir, "../../../supabase/migrations/20260805000000_rbac_roles.sql"),
    "utf8"
  );

  test("current_role_rank() agrees with ROLE_RANK", () => {
    const fromSql = Object.fromEntries(
      [...sql.matchAll(/when\s+'([a-z_]+)'\s+then\s+(\d+)/gi)].map((m) => [m[1], Number(m[2])])
    );
    expect(fromSql).toEqual(ROLE_RANK);
  });

  test("the CHECK constraint lists exactly the roles the code knows", () => {
    const list = sql.match(/check\s*\(role\s+in\s*\(([^)]*)\)\)/i)?.[1] ?? "";
    const fromSql = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(fromSql).toEqual([...ROLES].sort());
  });

  test("the column default is a real role, and the least-privileged working one", () => {
    const dflt = sql.match(/alter column role set default '([a-z_]+)'/i)?.[1];
    expect(isRole(dflt)).toBe(true);
    expect(dflt).toBe("operator");
  });

  // `else 0` is what makes an unrecognised role in the database resolve to no
  // privilege inside a policy, mirroring roleOf()'s fail-closed default. An
  // `else 3` here would be a silent full grant on every unknown value.
  test("an unrecognised role ranks zero in SQL, as it does in TypeScript", () => {
    expect(/else\s+0/i.test(sql)).toBe(true);
    expect(ROLE_RANK[roleOf("something-new")]).toBe(0);
  });
});
