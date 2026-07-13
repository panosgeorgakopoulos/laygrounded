// Sanctions screening — OpenSanctions-compatible matching API.
//
// The default endpoint speaks the OpenSanctions /match API (which aggregates
// OFAC SDN, EU consolidated, UN Security Council, UK OFSI and ~250 other
// lists). Configure with:
//   SANCTIONS_API_URL — default https://api.opensanctions.org
//   SANCTIONS_API_KEY — required; without it every screen returns
//                       "unavailable" (never a silent pass).

const FETCH_TIMEOUT_MS = 12_000;

export type SanctionsVerdict = "clear" | "possible_match" | "match" | "unavailable";

export interface SanctionsMatch {
  id: string;
  caption: string;
  score: number;
  datasets: string[];
}

export interface SanctionsResult {
  verdict: SanctionsVerdict;
  riskScore: number | null;
  matches: SanctionsMatch[];
  source: string;
  summary: string;
}

// Score bands: the OpenSanctions matcher returns [0,1]; `match: true` is its
// own high-precision decision. The band between the thresholds is deliberately
// "possible_match" — a human decision, never an automatic clear.
const MATCH_THRESHOLD = 0.85;
const POSSIBLE_THRESHOLD = 0.5;

export async function screenEntity(
  name: string,
  schema: "Company" | "Vessel",
  extra?: { imoNumber?: string }
): Promise<SanctionsResult> {
  const apiKey = process.env.SANCTIONS_API_KEY;
  const baseUrl = process.env.SANCTIONS_API_URL || "https://api.opensanctions.org";

  if (!apiKey) {
    return {
      verdict: "unavailable",
      riskScore: null,
      matches: [],
      source: baseUrl,
      summary:
        "No sanctions API configured — set SANCTIONS_API_KEY (OpenSanctions-compatible) to screen counterparties and vessels against OFAC/EU/UN lists.",
    };
  }

  const properties: Record<string, string[]> = { name: [name] };
  if (schema === "Vessel" && extra?.imoNumber) {
    properties.imoNumber = [extra.imoNumber];
  }

  try {
    const res = await fetch(`${baseUrl}/match/sanctions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `ApiKey ${apiKey}`,
      },
      body: JSON.stringify({
        queries: { q: { schema, properties } },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      return {
        verdict: "unavailable",
        riskScore: null,
        matches: [],
        source: baseUrl,
        summary: `Sanctions API returned ${res.status} — screening not completed.`,
      };
    }

    const json: any = await res.json();
    const results: any[] = json?.responses?.q?.results ?? [];
    const matches: SanctionsMatch[] = results.slice(0, 5).map((r) => ({
      id: String(r.id ?? ""),
      caption: String(r.caption ?? ""),
      score: typeof r.score === "number" ? r.score : 0,
      datasets: Array.isArray(r.datasets) ? r.datasets.slice(0, 6) : [],
    }));

    const top = results[0];
    const topScore: number = typeof top?.score === "number" ? top.score : 0;
    const apiDecidedMatch = results.some((r) => r.match === true);

    const verdict = classifyScore(topScore, apiDecidedMatch);
    const summary =
      verdict === "clear"
        ? `No sanctions-list match for "${name}"${topScore > 0 ? ` (best score ${topScore.toFixed(2)})` : ""}.`
        : verdict === "match"
          ? `SANCTIONS MATCH: "${name}" matches ${top?.caption ?? "a listed entity"} (score ${topScore.toFixed(2)}). Do not settle without legal review.`
          : `Possible sanctions match for "${name}": ${top?.caption ?? "listed entity"} (score ${topScore.toFixed(2)}) — human review required.`;

    return { verdict, riskScore: topScore, matches, source: baseUrl, summary };
  } catch (e) {
    return {
      verdict: "unavailable",
      riskScore: null,
      matches: [],
      source: baseUrl,
      summary: `Sanctions API request failed (${e instanceof Error ? e.message : e}) — screening not completed.`,
    };
  }
}

// Exported for tests: the verdict banding is policy, keep it pure.
export function classifyScore(topScore: number, apiDecidedMatch: boolean): SanctionsVerdict {
  if (apiDecidedMatch || topScore >= MATCH_THRESHOLD) return "match";
  if (topScore >= POSSIBLE_THRESHOLD) return "possible_match";
  return "clear";
}
