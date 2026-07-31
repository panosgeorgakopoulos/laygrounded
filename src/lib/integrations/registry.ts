// The provider registry — one source of truth for which ERPs exist.
//
// `PROVIDERS` is exported so the API's Zod enum, the settings UI and the
// database CHECK constraint all describe the same set. Adding a provider is
// therefore three coordinated changes, and the third is easy to forget:
//
//   1. an adapter class + a case in `getAdapter`;
//   2. an entry here;
//   3. a MIGRATION widening `integrations_provider_check`.
//
// Step 3 is invisible to `tsc`. A provider added without it type-checks, passes
// every unit test, and fails only at INSERT time against the live database —
// the same class of trap `evidence_checks.check_type` sprang in Phase 6.

import { ErpAdapter } from "./adapter";
import { DanaosAdapter } from "./danaos";
import { FortuneAdapter } from "./fortune";
import { MockErpAdapter } from "./mock";
import { UlyssesAdapter } from "./ulysses";
import { VesonImosAdapter } from "./veson";
import { IntegrationProvider, IntegrationRow } from "./types";

export interface ProviderDescriptor {
  provider: IntegrationProvider;
  label: string;
  vendor: string;
  /** Wire format, shown in the UI so an operator knows what to expect. */
  transport: "GraphQL + REST" | "SOAP/XML" | "JSON/REST";
  /**
   * True when the payload mapping was written against published vendor
   * documentation. False means it follows the general shape of that product
   * family and has never met a live tenant — surfaced in the UI so nobody
   * mistakes a plausible mapping for a verified one.
   */
  mappingVerifiedAgainstVendorDocs: boolean;
}

export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    provider: "VESON_IMOS",
    label: "Veson IMOS Platform (VesLink)",
    vendor: "Veson Nautical",
    transport: "GraphQL + REST",
    mappingVerifiedAgainstVendorDocs: true,
  },
  {
    provider: "DANAOS",
    label: "Danaos Enterprise Suite",
    vendor: "Danaos Management Consultants",
    transport: "SOAP/XML",
    mappingVerifiedAgainstVendorDocs: false,
  },
  {
    provider: "FORTUNE",
    label: "Fortune Shipping Suite",
    vendor: "Fortune Technologies",
    transport: "JSON/REST",
    mappingVerifiedAgainstVendorDocs: false,
  },
  {
    provider: "ULYSSES",
    label: "Ulysses Task Assistant",
    vendor: "Ulysses Systems",
    transport: "JSON/REST",
    mappingVerifiedAgainstVendorDocs: false,
  },
  {
    provider: "MOCK_ERP",
    label: "Mock ERP (test double)",
    vendor: "LayGrounded",
    transport: "JSON/REST",
    mappingVerifiedAgainstVendorDocs: true,
  },
] as const;

export const PROVIDER_IDS = PROVIDERS.map((p) => p.provider) as [
  IntegrationProvider,
  ...IntegrationProvider[],
];

export function getAdapter(integration: IntegrationRow): ErpAdapter {
  switch (integration.provider) {
    case "VESON_IMOS":
      return new VesonImosAdapter(integration);
    case "DANAOS":
      return new DanaosAdapter(integration);
    case "FORTUNE":
      return new FortuneAdapter(integration);
    case "ULYSSES":
      return new UlyssesAdapter(integration);
    case "MOCK_ERP":
      return new MockErpAdapter(integration);
    default:
      throw new Error(`Unknown integration provider: ${integration.provider}`);
  }
}
