// Is this port in the EEA?
//
// EU ETS scope for an at-berth delay is all-or-nothing on geography, so this
// one boolean decides whether a demurrage period carries a EUA liability at
// all. Getting it wrong in the permissive direction invents money the charterer
// does not owe.
//
// `claims.port` is free text an operator typed — "Rotterdam, NL", "Santos, BR",
// sometimes just "Rotterdam". So this resolver answers in three states and
// returns UNKNOWN rather than guessing: a bare city name is genuinely ambiguous
// (there is a Rotterdam in New York State), and the downstream ETS scope
// already knows how to present an uncertain answer as potential exposure
// instead of a settled liability.
//
// An explicit `claims.ets_applicable` always wins over anything inferred here.
//
// Pure.

/**
 * EEA = EU-27 plus Iceland, Liechtenstein and Norway.
 *
 * Liechtenstein is landlocked and included only for completeness of the bloc.
 * The UK is deliberately ABSENT: it left the EU ETS after Brexit and runs its
 * own scheme, so a UK call is outside EU ETS scope even though it is in Europe
 * — the single most likely mistake in this list.
 */
export const EEA_COUNTRY_CODES: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR",
  "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
  "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "IS", "LI", "NO",
]);

/**
 * Non-EEA codes worth naming, so a confident "no" is possible.
 *
 * Without this a port outside the list would be indistinguishable from an
 * unparseable one, and every non-EEA call would read "unknown" — technically
 * honest but useless, and it would leave the potential-exposure caveat on
 * calls that plainly carry no liability.
 */
const KNOWN_NON_EEA: ReadonlySet<string> = new Set([
  "AU", "BR", "CA", "CN", "IN", "ID", "JP", "KR", "MY", "MX",
  "NZ", "PE", "PH", "QA", "RU", "SA", "SG", "TH", "TR", "TW",
  "AE", "GB", "US", "VN", "ZA", "CL", "CO", "EG", "MA", "NG",
  "OM", "PA", "PK", "UA", "UY", "AR", "BD", "IL", "KW", "LK",
]);

export type EeaVerdict = true | false | null;

export interface EeaResolution {
  eeaPort: EeaVerdict;
  /** The ISO code the decision rested on, when one was found. */
  countryCode: string | null;
  reason: string;
}

/**
 * Extracts a trailing ISO 3166-1 alpha-2 country code from a free-text port.
 *
 * Only a TRAILING code is accepted, and only after a comma or as the final
 * token. Scanning the whole string for any two-letter sequence would match
 * fragments of city names and produce confident nonsense.
 */
export function extractCountryCode(port: string): string | null {
  const trimmed = port.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(",");
  const last = parts[parts.length - 1]?.trim() ?? "";

  // A bare city name has no comma and is not a country code.
  if (parts.length < 2) return null;
  if (!/^[A-Za-z]{2}$/.test(last)) return null;

  return last.toUpperCase();
}

export function resolveEeaPort(port: string | null | undefined): EeaResolution {
  if (!port || !port.trim()) {
    return { eeaPort: null, countryCode: null, reason: "No port recorded." };
  }

  const code = extractCountryCode(port);
  if (!code) {
    return {
      eeaPort: null,
      countryCode: null,
      reason: `"${port.trim()}" carries no country code, so its EU ETS scope cannot be determined. Set the claim's ETS applicability explicitly to remove this uncertainty.`,
    };
  }

  if (EEA_COUNTRY_CODES.has(code)) {
    return {
      eeaPort: true,
      countryCode: code,
      reason: `${code} is in the EEA, so at-berth emissions are within EU ETS scope.`,
    };
  }

  if (KNOWN_NON_EEA.has(code)) {
    return {
      eeaPort: false,
      countryCode: code,
      reason:
        code === "GB"
          ? "GB left the EU ETS after Brexit and operates its own scheme, so this call is outside EU ETS scope."
          : `${code} is outside the EEA, so at-berth emissions carry no EU ETS liability.`,
    };
  }

  return {
    eeaPort: null,
    countryCode: code,
    reason: `Country code ${code} is not in this module's list, so EU ETS scope is undetermined rather than assumed.`,
  };
}
