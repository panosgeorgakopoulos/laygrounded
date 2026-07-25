# @laygrounded/laytime-core

The deterministic heart of [LayGrounded](https://laygrounded.com), open-sourced
under Apache-2.0: a pure-TypeScript **laytime & demurrage engine** for dry-bulk
voyage charters, plus scenario diffing and dispute-sensitivity ("attack surface")
analysis.

No I/O, no AI, no database — every function is a pure transform of
`SofEventInput[]` + `CpTerms` into a result. That purity is what makes the engine
independently testable (a 500-case synthetic-corpus regression net backs it in
the main app) and reusable in any TypeScript project.

## What it does

- **`recomputeLaytime(events, cpTerms)`** — an hour-by-hour laytime breakdown and
  demurrage/despatch totals. Two charter-party forms:
  - **GENCON 94** (default; clause refs `GENCON94-*`) with timezone-aware
    SHEX/SSHEX/UU day exclusions, WIBON/WIPON regimes, weather and shifting
    interruptions.
  - **ASBATANKVOY** (tanker running-hours regime; refs `ASBA-II-*`): berthing
    cuts turn time short, weather never stops laytime, storm-on-demurrage bills
    at half rate.
- **`diffScenarios(...)` / `applyProposals(...)`** — apply proposed event
  amendments to a baseline, run the engine on both, and return the per-side
  results plus a money delta (owner's perspective).
- **`analyzeSensitivity(events, cpTerms)`** — simulate the amendments a
  counterparty would argue and the owner's counters, ranked by net money moved.

All money arithmetic is `decimal.js`; timezone handling is `date-fns-tz`.

## Install

```bash
npm install @laygrounded/laytime-core   # or: bun add @laygrounded/laytime-core
```

## Use

```ts
import { recomputeLaytime, DEFAULT_CP_TERMS } from "@laygrounded/laytime-core";

const result = recomputeLaytime(
  [
    { id: "1", occurred_at: "2026-01-05T08:00:00+08:00", event_type: "NOR_TENDERED" },
    { id: "2", occurred_at: "2026-01-05T11:30:00+08:00", event_type: "ALL_FAST" },
    { id: "3", occurred_at: "2026-01-08T17:00:00+08:00", event_type: "COMPLETED_LOADING" },
  ],
  { ...DEFAULT_CP_TERMS, laytime_allowed_hours: 72, port_timezone: "Asia/Singapore" }
);

console.log(result.totals.demurrage_amount, result.totals.currency);
```

Subpath entry points are also exported: `@laygrounded/laytime-core/gencon94`,
`/types`, `/diff`, `/sensitivity`.

## Scope

This package is the engine only. LayGrounded's AI SoF extraction, evidence
verification, agentic drafting, claim rooms, settlement, compliance and
integrations are **not** part of it and remain proprietary.

## Publishing (maintainers)

Consumed as TypeScript source inside the monorepo. To publish to npm, run
`bun run build` (emits `dist/` with declarations) and point the `exports` map at
`./dist/*.js` / `./dist/*.d.ts` before `npm publish`.

## License

Apache-2.0 © LayGrounded. See [LICENSE](./LICENSE).
