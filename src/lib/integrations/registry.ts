import { ErpAdapter } from "./adapter";
import { IntegrationRow } from "./types";
import { VesonImosAdapter } from "./veson";
import { MockErpAdapter } from "./mock";

export function getAdapter(integration: IntegrationRow): ErpAdapter {
  switch (integration.provider) {
    case "VESON_IMOS":
      return new VesonImosAdapter(integration);
    case "MOCK_ERP":
      return new MockErpAdapter(integration);
    default:
      throw new Error(`Unknown integration provider: ${integration.provider}`);
  }
}
