// AIS position verification — provider-pluggable.
//
// Commercial AIS history (MarineTraffic, Spire, Kpler, VesselFinder…) is
// paywalled, so the concrete provider is injected via environment:
//   AIS_PROVIDER_URL — endpoint template; {imo}, {from}, {to} are substituted
//   AIS_PROVIDER_KEY — bearer token
// Without configuration every check reports "unavailable" (never a guess) so
// the rest of the evidence pipeline stays honest.

const FETCH_TIMEOUT_MS = 10_000;

export interface AisPositionCheck {
  verdict: "corroborated" | "contradicted" | "inconclusive" | "unavailable";
  summary: string;
  data: Record<string, unknown>;
}

export async function checkVesselPosition(
  vesselName: string,
  atISO: string
): Promise<AisPositionCheck> {
  const providerUrl = process.env.AIS_PROVIDER_URL;
  const providerKey = process.env.AIS_PROVIDER_KEY;

  if (!providerUrl || !providerKey) {
    return {
      verdict: "unavailable",
      summary:
        "No AIS provider configured — set AIS_PROVIDER_URL and AIS_PROVIDER_KEY to verify vessel positions against AIS history.",
      data: { vessel: vesselName, at: atISO },
    };
  }

  try {
    const url = providerUrl
      .replace("{imo}", encodeURIComponent(vesselName))
      .replace("{from}", encodeURIComponent(atISO))
      .replace("{to}", encodeURIComponent(atISO));
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${providerKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        verdict: "unavailable",
        summary: `AIS provider returned ${res.status}; position not verified.`,
        data: { vessel: vesselName, at: atISO, status: res.status },
      };
    }
    const positions: any = await res.json();
    // Provider payloads differ; we only assert that history exists for the
    // timestamp. Interpreting anchorage vs berth geofences is provider-
    // specific and left to a concrete adapter.
    return {
      verdict: "inconclusive",
      summary: "AIS history retrieved; automated berth/anchorage geofencing not configured for this provider.",
      data: { vessel: vesselName, at: atISO, positions },
    };
  } catch (e) {
    return {
      verdict: "unavailable",
      summary: "AIS provider request failed; position not verified.",
      data: { vessel: vesselName, at: atISO, error: e instanceof Error ? e.message : String(e) },
    };
  }
}
