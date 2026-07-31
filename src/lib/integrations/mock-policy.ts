// Who may serve synthetic ERP data in production, and who may not.
//
// WHY THIS IS NOT A PROVIDER ALLOWLIST. The obvious spelling —
// `ALLOWED_MOCK_INTEGRATIONS="danaos,fortune"` — does not achieve the thing it
// is for. A real design partner's Danaos integration accidentally left in
// `mode: "mock"` would match the `danaos` entry and be served fixtures, which
// is precisely the leak the allowlist exists to prevent. Only an
// IDENTITY-scoped allowlist works: it names the specific integration (or the
// specific demo company), so no entry can ever accidentally cover a tenant it
// was not written for.
//
// This replaces the previous global `ALLOW_MOCK_ERP_IN_PRODUCTION=1`, which
// permitted fixtures for EVERY mock-mode integration in the deployment at once.
//
// Pure: the environment is read by the caller and passed in, so the policy is
// table-testable without touching `process.env`.

/** A parsed allowlist. Empty means "nothing may mock in production". */
export interface MockAllowlist {
  integrationIds: ReadonlySet<string>;
  companyIds: ReadonlySet<string>;
  /** Entries that were not usable, kept so misconfiguration is visible. */
  invalidEntries: string[];
}

export const EMPTY_ALLOWLIST: MockAllowlist = {
  integrationIds: new Set(),
  companyIds: new Set(),
  invalidEntries: [],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses `ALLOWED_MOCK_INTEGRATIONS`.
 *
 * Accepts a comma- or whitespace-separated list of:
 *   `<uuid>`            — one integration
 *   `company:<uuid>`    — every integration belonging to one company
 *
 * Anything that is not a UUID is collected into `invalidEntries` rather than
 * ignored silently or matched loosely. A typo'd id must fail closed and be
 * reportable — never widen into a prefix match.
 */
export function parseMockAllowlist(raw: string | undefined | null): MockAllowlist {
  if (!raw || !raw.trim()) return EMPTY_ALLOWLIST;

  const integrationIds = new Set<string>();
  const companyIds = new Set<string>();
  const invalidEntries: string[] = [];

  for (const token of raw.split(/[\s,]+/)) {
    const entry = token.trim();
    if (!entry) continue;

    const isCompany = entry.toLowerCase().startsWith("company:");
    const value = isCompany ? entry.slice("company:".length).trim() : entry;

    if (!UUID.test(value)) {
      invalidEntries.push(entry);
      continue;
    }
    // Lowercased so a copy-paste in a different case still matches; UUIDs are
    // case-insensitive by specification.
    (isCompany ? companyIds : integrationIds).add(value.toLowerCase());
  }

  return { integrationIds, companyIds, invalidEntries };
}

export interface MockPolicyQuery {
  integrationId: string;
  companyId: string;
  /** `process.env.NODE_ENV` at the call site. */
  nodeEnv: string | undefined;
  allowlist: MockAllowlist;
}

export type MockPolicyVerdict =
  | { allowed: true; reason: "not_production" | "integration_allowlisted" | "company_allowlisted" }
  | { allowed: false; reason: "not_allowlisted"; message: string };

/**
 * May this integration serve fixtures?
 *
 * Outside production, yes — development and CI depend on it. In production,
 * only if this exact integration, or its company, is named.
 *
 * The refusal message names the id to add. A self-fixing error is worth the
 * few extra characters: the alternative is an operator guessing which of a
 * dozen integrations the sweep refused.
 */
export function evaluateMockPolicy(query: MockPolicyQuery): MockPolicyVerdict {
  if (query.nodeEnv !== "production") return { allowed: true, reason: "not_production" };

  const integrationId = query.integrationId.toLowerCase();
  const companyId = query.companyId.toLowerCase();

  if (query.allowlist.integrationIds.has(integrationId)) {
    return { allowed: true, reason: "integration_allowlisted" };
  }
  if (query.allowlist.companyIds.has(companyId)) {
    return { allowed: true, reason: "company_allowlisted" };
  }

  return {
    allowed: false,
    reason: "not_allowlisted",
    message:
      `MOCK_ERP_REFUSED_IN_PRODUCTION: integration ${query.integrationId} is in mock mode ` +
      `but is not allowlisted. To permit synthetic data for THIS integration only, add ` +
      `"${query.integrationId}" to ALLOWED_MOCK_INTEGRATIONS (or "company:${query.companyId}" ` +
      `for the whole demo tenant). Do not allowlist a live partner's integration.`,
  };
}
