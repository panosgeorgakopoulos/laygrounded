// The RBAC model: who may do what, in one place.
//
// Pure — no I/O, no Supabase, no Next. Imported by route guards, by the team
// management UI and by the workspace panels that hide controls, so all three
// agree by construction. A UI that hid a button the API still allowed, or
// showed one the API would refuse, is the failure mode this exists to prevent.
//
// WHY A MINIMUM ROLE PER CAPABILITY, NOT A SET OF ROLES PER CAPABILITY.
//
// The obvious shape is `Record<Capability, Role[]>`. It is also the shape that
// lets you write `["operator", "admin"]` and silently deny a finance manager a
// capability every role below them holds. That bug is invisible in review — the
// list looks deliberate — and it surfaces as a support ticket from the one
// customer who uses the middle role.
//
// These four roles are genuinely totally ordered (a finance manager does
// everything an operator does, plus money), so a minimum rank expresses the
// real model AND makes non-monotonic grants unrepresentable. If a future role
// is NOT on this ladder — an external auditor, say, who reads more than an
// operator but writes nothing — it does not belong in this enum, and bolting it
// on by widening the ladder is how the ladder stops meaning anything.

export const ROLES = ["viewer", "operator", "finance_manager", "admin"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Privilege order. Mirrored by `public.current_role_rank()` in
 * `20260805000000_rbac_roles.sql`, which RLS policies use for the second layer
 * of enforcement; `roles.sql-parity.test.ts` fails if the two drift.
 */
export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  operator: 1,
  finance_manager: 2,
  admin: 3,
};

export type Capability =
  /** See claims, calculations, evidence, the grant ledger and bank details. */
  | "claim.read"
  /** Day-to-day laytime work: create claims, ingest SoF, confirm events, dispute. */
  | "claim.write"
  /** Set the autonomous negotiator's mandate — a concession budget in money. */
  | "claim.negotiate"
  /** Agree a claim. The moment the numbers stop being negotiable. */
  | "claim.agree"
  /** Generate and clear a settlement payload. */
  | "claim.settle"
  /** Issue or revoke a bank's trade-finance access token. */
  | "finance.grant"
  /** Edit the IBAN/BIC/wallet a settlement instruction pays to. */
  | "finance.counterparty"
  /** Invite, remove and re-role colleagues. */
  | "team.manage";

/**
 * The authority. Read as "you must be at least this role".
 *
 * The four money capabilities sit at `finance_manager` because each one either
 * moves money or authorises somebody else to: `claim.agree` fixes the figure,
 * `claim.settle` builds the payment instruction, `finance.counterparty` chooses
 * the account it pays into, and `finance.grant` hands a bank a credential.
 * `claim.negotiate` is there for the same reason and it is the least obvious —
 * a concession mandate is denominated in money, and the strategy room converts
 * the operator's percentage into that figure in front of them.
 */
export const CAPABILITY_MIN_ROLE: Record<Capability, Role> = {
  "claim.read": "viewer",
  "claim.write": "operator",
  "claim.negotiate": "finance_manager",
  "claim.agree": "finance_manager",
  "claim.settle": "finance_manager",
  "finance.grant": "finance_manager",
  "finance.counterparty": "finance_manager",
  "team.manage": "admin",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Coerces whatever the database or a stale client handed us into a Role.
 *
 * **Fails closed.** Anything unrecognised — null, a role from a future version,
 * a typo — resolves to `viewer`, the role that can do nothing but look. The
 * alternative (defaulting to the old `member`, or to `operator`) means a value
 * nobody anticipated grants more than it should, which is the wrong direction
 * for an unknown.
 *
 * `member` is the one legacy value mapped rather than rejected: it was the
 * pre-Phase-14 name for the day-to-day role and `20260805000000` rewrote every
 * row, but a session or a cached payload minted before that migration can still
 * carry it, and demoting those users to viewer would look like an outage.
 */
export function roleOf(raw: string | null | undefined): Role {
  if (raw === "member") return "operator";
  return isRole(raw) ? raw : "viewer";
}

/** True when `role` holds `capability`. */
export function can(role: Role, capability: Capability): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[CAPABILITY_MIN_ROLE[capability]];
}

/** Every capability a role holds — used to send one payload to the client. */
export function capabilitiesOf(role: Role): Capability[] {
  return (Object.keys(CAPABILITY_MIN_ROLE) as Capability[]).filter((c) => can(role, c));
}

/** Display copy. Kept beside the model so a new role cannot ship unlabelled. */
export const ROLE_LABELS: Record<Role, string> = {
  viewer: "Viewer",
  operator: "Operator",
  finance_manager: "Finance manager",
  admin: "Admin",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: "Read-only. Sees claims, calculations and evidence; changes nothing.",
  operator:
    "Day-to-day laytime work — create claims, ingest Statements of Facts, confirm events, raise disputes.",
  finance_manager:
    "Everything an operator does, plus money: agreeing claims, settlement payloads, bank details, trade-finance grants and the negotiation mandate.",
  admin: "Everything, plus inviting colleagues and changing their roles.",
};
