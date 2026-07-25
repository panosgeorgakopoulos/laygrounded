// Builds the demo seed dataset from the synthetic corpus.
//
//   bun scripts/seed/build-demo-dataset.ts
//
// The corpus (synthetic-corpus/cases/*.json) is 500 engine-validated voyage
// cases across ~24 edge-case archetypes. Hand-written demo claims are few and
// thin; this instead curates a diverse, realistic slice of the corpus and
// enriches each case with the fields a real claim carries but the corpus does
// not model — a valid IMO number, a named counterparty, EEA/ETS scope, a
// time-bar posture, and evidence verdicts — then emits a committed TypeScript
// module (src/lib/seed-data.generated.ts) the seeder consumes at runtime.
//
// Committing the output means seeding never depends on the corpus files being
// present in the deployed image, while still being sourced from — and kept
// honest by — the engine-validated corpus.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CORPUS_DIR = join(process.cwd(), "synthetic-corpus", "cases");
const OUT_FILE = join(process.cwd(), "src", "lib", "seed-data.generated.ts");

// Which archetypes to showcase, and how many of each. Ordered so the demo book
// opens on clean demurrage/despatch and spans weather, weekend bases, shifting,
// excepted periods, both CP forms, and every time-bar band.
const SELECTION: Array<{ archetype: string; take: number }> = [
  { archetype: "clean-shinc-demurrage", take: 2 },
  { archetype: "clean-shinc-despatch", take: 2 },
  { archetype: "weather-wwd-excluded", take: 2 },
  { archetype: "weather-on-demurrage-counts", take: 1 },
  { archetype: "shex-sunday-excluded", take: 1 },
  { archetype: "shex-uu-worked-counts", take: 1 },
  { archetype: "sshex-weekend-excluded", take: 1 },
  { archetype: "wibon-shifting-counts", take: 1 },
  { archetype: "port-strike-excepted", take: 1 },
  { archetype: "asba-running-hours", take: 1 },
  { archetype: "asba-half-rate-demurrage", take: 1 },
  { archetype: "multi-interruption-stress", take: 1 },
  { archetype: "timebar-warning", take: 1 },
  { archetype: "timebar-critical", take: 1 },
  { archetype: "timebar-expired", take: 1 },
];

// Named counterparties assigned round-robin — recognisable charterers/traders
// so the book reads like a real desk's.
const COUNTERPARTIES = [
  "Cargill Ocean Transportation",
  "Bunge Chartering S.A.",
  "Trafigura Maritime Logistics Pte Ltd",
  "Louis Dreyfus Company Suisse S.A.",
  "Glencore International AG",
  "Oldendorff Carriers GmbH & Co. KG",
  "Rio Tinto Shipping Pte Ltd",
  "COFCO Resources S.A.",
  "ADM International Sàrl",
  "Vitol S.A.",
  "Gunvor SA",
  "Klaveness Combination Carriers",
  "NYK Bulkship (Asia) Pte Ltd",
  "Pacific Basin Chartering Ltd",
  "Norden Tankers & Bulkers",
  "Ultrabulk A/S",
  "Western Bulk Carriers",
  "Swiss Marine Services S.A.",
];

// Ports we treat as EEA (EU ETS in scope) vs not. Anything unlisted → null
// (unknown; the workspace declines to assert scope).
const EEA_PORTS = ["Rotterdam", "Antwerp", "Hamburg", "Piraeus", "Amsterdam", "Constanta", "Gdansk", "Marseille", "Bremen"];
const NON_EEA_PORTS = ["Singapore", "Houston", "Santos", "Newcastle", "Richards Bay", "Port Hedland", "Gibraltar", "Qingdao", "Dampier"];

// FNV-1a — deterministic, so re-running yields byte-identical output.
function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// A valid 7-digit IMO number: six deterministic digits + the ISO check digit
// (each of the first six weighted 7..2, summed, mod 10).
function imoFor(seed: string): string {
  const base = 900000 + (hash(seed) % 100000); // 9xxxxxx, like a modern hull
  const digits = String(base).split("").map(Number);
  const sum = digits.reduce((acc, d, i) => acc + d * (7 - i), 0);
  return `${base}${sum % 10}`;
}

function etsScope(port: string): boolean | null {
  if (EEA_PORTS.some((p) => port.includes(p))) return true;
  if (NON_EEA_PORTS.some((p) => port.includes(p))) return false;
  return null;
}

// Per-archetype time-bar posture and evidence, so the demo shows live,
// meaningful states rather than a book of identical claims.
function posture(archetype: string, idx: number): {
  timeBarDays: number;
  recencyDays: number;
  weatherVerdict: "corroborated" | "contradicted" | null;
} {
  if (archetype === "timebar-expired") return { timeBarDays: 90, recencyDays: 128, weatherVerdict: null };
  if (archetype === "timebar-critical") return { timeBarDays: 90, recencyDays: 86, weatherVerdict: null };
  if (archetype === "timebar-warning") return { timeBarDays: 90, recencyDays: 76, weatherVerdict: null };
  // One weather claim is contradicted by the archive → drives the Legal Shield.
  const weatherVerdict =
    archetype.startsWith("weather")
      ? idx % 2 === 0
        ? "contradicted"
        : "corroborated"
      : null;
  const recency = [21, 29, 37, 45, 25, 33, 41][idx % 7];
  return { timeBarDays: 90, recencyDays: recency, weatherVerdict };
}

interface CorpusCase {
  id: string;
  archetype: string;
  description: string;
  claim: { vessel: string; voyageRef: string; port: string; cargo: string; portTimezone?: string };
  cpTerms: Record<string, unknown>;
  events: Array<{ occurred_at: string; event_type: string; verbatim: string }>;
}

function loadArchetype(archetype: string, take: number): CorpusCase[] {
  const files = readdirSync(CORPUS_DIR)
    .filter((f) => f.startsWith(`${archetype}-`) && f.endsWith(".json"))
    .sort()
    .slice(0, take);
  return files.map((f) => JSON.parse(readFileSync(join(CORPUS_DIR, f), "utf8")) as CorpusCase);
}

let globalIdx = 0;
const scenarios: string[] = [];

for (const sel of SELECTION) {
  const cases = loadArchetype(sel.archetype, sel.take);
  for (const c of cases) {
    const idx = globalIdx++;
    const cpForm = (c.cpTerms.cp_form as string) === "ASBATANKVOY" ? "ASBATANKVOY" : "GENCON94";
    const { timeBarDays, recencyDays, weatherVerdict } = posture(c.archetype, idx);
    const vesselImo = imoFor(`${c.claim.vessel}|${c.id}`);
    const counterpartyName = COUNTERPARTIES[idx % COUNTERPARTIES.length];
    const etsApplicable = etsScope(c.claim.port);

    const events = c.events.map((e, i) => ({
      occurred_at: e.occurred_at,
      event_type: e.event_type,
      verbatim: e.verbatim,
      page: 1,
      bbox: { x: 0, y: 0, width: 0, height: 0 },
      confidence: 0.9 + ((hash(`${c.id}-${i}`) % 8) / 100), // 0.90–0.97
      reasoning: i === 0 ? c.description : "Extracted from the Statement of Facts.",
    }));

    scenarios.push(
      JSON.stringify(
        {
          vessel: c.claim.vessel,
          vesselImo,
          voyageRef: c.claim.voyageRef,
          port: c.claim.port,
          cargo: c.claim.cargo,
          counterpartyName,
          cpForm,
          cpTerms: c.cpTerms,
          timeBarDays,
          recencyDays,
          etsApplicable,
          archetype: c.archetype,
          description: c.description,
          weatherVerdict,
          events,
        },
        null,
        2
      )
    );
  }
}

const header = `// AUTO-GENERATED by scripts/seed/build-demo-dataset.ts — do not edit by hand.
// Sourced from the engine-validated synthetic corpus and enriched with IMO,
// counterparty, ETS scope, time-bar posture and evidence. Re-run the script to
// regenerate. ${scenarios.length} demo scenarios.
import type { SeedScenario } from "./seed-data";

export const seedScenarios: SeedScenario[] = ${`[\n${scenarios.join(",\n")}\n]`} as SeedScenario[];
`;

writeFileSync(OUT_FILE, header);
console.log(`Wrote ${scenarios.length} scenarios to ${OUT_FILE}`);
