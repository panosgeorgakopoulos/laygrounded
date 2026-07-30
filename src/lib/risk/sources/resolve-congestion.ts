// Choosing which congestion provider runs — the one place a mock can be
// installed, and the one place it can be refused.
//
// The default is UNAVAILABLE, not mock. That direction matters: a missing
// environment variable in production must produce "we could not measure the
// queue", never an invented one. Synthetic data reaching a customer is a
// deployment mistake away in any design where mock is the fallback, so mock is
// opt-in, and in production it additionally requires a second, explicitly
// named flag.

import {
  createDatalasticAdapter,
  type AisCongestionAdapter,
} from "@/lib/risk/sources/ais-congestion";
import { createMockAdapter } from "@/lib/risk/sources/ais-mock";

export interface CongestionProviderEnv {
  AIS_CONGESTION_PROVIDER?: string;
  DATALASTIC_API_KEY?: string;
  ALLOW_MOCK_AIS_IN_PRODUCTION?: string;
  NODE_ENV?: string;
}

export interface ProviderSelection {
  adapter: AisCongestionAdapter | null;
  /** Why there is no adapter, for the caller to surface verbatim. */
  reason: string | null;
}

export function selectCongestionAdapter(env: CongestionProviderEnv): ProviderSelection {
  const provider = (env.AIS_CONGESTION_PROVIDER ?? "").trim().toLowerCase();

  if (!provider) {
    return {
      adapter: null,
      reason:
        "No AIS congestion provider is configured (AIS_CONGESTION_PROVIDER is unset), so port " +
        "queueing could not be measured. Set it to 'datalastic' with DATALASTIC_API_KEY, or to " +
        "'mock' in a non-production environment.",
    };
  }

  if (provider === "datalastic") {
    const key = env.DATALASTIC_API_KEY?.trim();
    if (!key) {
      return {
        adapter: null,
        reason:
          "AIS_CONGESTION_PROVIDER is 'datalastic' but DATALASTIC_API_KEY is not set, so no " +
          "congestion data could be fetched.",
      };
    }
    return { adapter: createDatalasticAdapter(key), reason: null };
  }

  if (provider === "mock") {
    const isProduction = (env.NODE_ENV ?? "").toLowerCase() === "production";
    const allowed = (env.ALLOW_MOCK_AIS_IN_PRODUCTION ?? "").trim() === "1";
    if (isProduction && !allowed) {
      return {
        adapter: null,
        reason:
          "The mock AIS provider is refused in production. Mock congestion is synthetic and " +
          "must not reach a commercial decision. Configure 'datalastic', or set " +
          "ALLOW_MOCK_AIS_IN_PRODUCTION=1 to accept clearly-labelled synthetic output.",
      };
    }
    return { adapter: createMockAdapter(), reason: null };
  }

  return {
    adapter: null,
    reason: `Unknown AIS congestion provider '${provider}'. Supported: 'datalastic', 'mock'.`,
  };
}
