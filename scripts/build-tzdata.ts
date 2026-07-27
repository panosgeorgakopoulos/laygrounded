// Generates packages/laytime-core/src/tzdata.ts — a pinned UTC-offset
// transition table for every IANA zone, covering a bounded era.
//
// WHY THIS EXISTS. The engine used to resolve timezones through date-fns-tz,
// which calls Intl.DateTimeFormat, which reads whatever tzdata the host runtime
// happens to carry. Two runtimes on one laptop disagreed: Node exposed 418
// zones, Bun 445. That made a laytime calculation a function of the machine it
// ran on — and because IANA does issue retroactive corrections (Brazil, Egypt,
// Chile have all had historical offsets re-cut), a claim computed in 2026 could
// silently produce a different SHEX exclusion when re-run in 2029. For a number
// that goes into an arbitration, that is disqualifying.
//
// So the offsets are read from ICU ONCE, here, and committed as data. After
// that the engine needs no Intl at all: it is a pure function of its inputs plus
// a table that is versioned, digested, and reviewable in a diff.
//
// Run: bun scripts/build-tzdata.ts [--start 2000] [--end 2040]
// The output is COMMITTED. Regenerating it is a deliberate act that changes
// calculations, so the digest is printed and the corpus must be re-blessed.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
function arg(name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
}

// Bounded era. Voyages predating 2000 are not a use case, and an unbounded
// table would be both enormous and meaningless (future DST rules are politics,
// not data).
const START_YEAR = arg("start", 2000);
const END_YEAR = arg("end", 2040);

const DAY_MS = 86_400_000;

// IANA renamed many zones and kept the old names as "backward" links. Runtimes
// disagree about which spelling is canonical: Bun's supportedValuesOf returns
// Asia/Calcutta and omits Asia/Kolkata, Node returns the modern names. Both
// accept either in DateTimeFormat.
//
// That disagreement is the very ICU skew this table exists to eliminate, so the
// scan is not left to whatever the host chooses to enumerate. Both spellings are
// generated, and a test asserts each pair resolves identically — an alias is
// only sound if the offsets actually agree.
const ALIAS_NAMES = [
  "Asia/Kolkata", "Asia/Calcutta",
  "Asia/Kathmandu", "Asia/Katmandu",
  "Asia/Ho_Chi_Minh", "Asia/Saigon",
  "Asia/Yangon", "Asia/Rangoon",
  "Asia/Istanbul", "Europe/Istanbul",
  "Europe/Kyiv", "Europe/Kiev",
  "America/Nuuk", "America/Godthab",
  "America/Argentina/Buenos_Aires", "America/Buenos_Aires",
  "America/Indiana/Indianapolis", "America/Indianapolis",
  "Atlantic/Faroe", "Atlantic/Faeroe",
  "Pacific/Pohnpei", "Pacific/Ponape",
  "Pacific/Chuuk", "Pacific/Truk",
  "Pacific/Kanton", "Pacific/Enderbury",
  "America/Ciudad_Juarez",
  "Africa/Asmara", "Africa/Asmera",
  "Asia/Urumqi", "Asia/Kashgar",
];

function zonesToScan(): string[] {
  const supported =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  // UTC is the engine's default and is not always enumerated; Etc/UTC and GMT
  // are common spellings in stored data.
  return [...new Set(["UTC", "Etc/UTC", "Etc/GMT", "GMT", ...ALIAS_NAMES, ...supported])].sort();
}

/** Offset in minutes east of UTC at instant `t`, via a cached formatter. */
function makeOffsetReader(timeZone: string): (t: number) => number {
  // Constructing the formatter is the expensive part — hoist it out of the loop.
  const dtf = new Intl.DateTimeFormat("en-US", {
    hourCycle: "h23",
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return (t: number) => {
    const p: Record<string, number> = {};
    for (const part of dtf.formatToParts(new Date(t))) {
      if (part.type !== "literal") p[part.type] = Number(part.value);
    }
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
    return Math.round((asUtc - t) / 60_000);
  };
}

/**
 * Exact instant of the change, to the second.
 *
 * A coarse scan only brackets a transition; recording it at the next probe
 * boundary would place it up to a day late. The engine steps hour by hour, so an
 * imprecise boundary silently mis-classifies an hour — binary search closes it.
 */
function findTransition(
  offsetAt: (t: number) => number,
  loT: number,
  hiT: number,
  loOffset: number,
): number {
  let lo = loT;
  let hi = hiT;
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetAt(mid) === loOffset) lo = mid;
    else hi = mid;
  }
  return hi;
}

function buildTable(): Record<string, number[]> {
  const start = Date.UTC(START_YEAR, 0, 1);
  const end = Date.UTC(END_YEAR, 0, 1);
  const table: Record<string, number[]> = {};

  for (const zone of zonesToScan()) {
    let offsetAt: (t: number) => number;
    try {
      offsetAt = makeOffsetReader(zone);
      offsetAt(start);
    } catch {
      // A name this ICU build cannot resolve is skipped rather than guessed at.
      continue;
    }

    // Flat [seconds, offsetMinutes, …] pairs: markedly smaller as source text
    // than an array of tuples, and trivially indexable.
    const flat: number[] = [];
    let prevOffset = offsetAt(start);
    flat.push(Math.floor(start / 1000), prevOffset);

    // Daily probe brackets every real transition (none last under a day), then
    // the boundary is pinned exactly.
    for (let t = start + DAY_MS; t <= end; t += DAY_MS) {
      const offset = offsetAt(t);
      if (offset !== prevOffset) {
        const exact = findTransition(offsetAt, t - DAY_MS, t, prevOffset);
        flat.push(Math.floor(exact / 1000), offset);
        prevOffset = offset;
      }
    }
    table[zone] = flat;
  }
  return table;
}

const table = buildTable();
const zoneCount = Object.keys(table).length;
const transitionCount = Object.values(table).reduce((n, v) => n + v.length / 2, 0);

// Canonical serialisation: keys sorted, no incidental whitespace, so the digest
// is a property of the DATA and not of how it was printed.
const canonical = JSON.stringify(
  Object.fromEntries(Object.keys(table).sort().map((k) => [k, table[k]])),
);
const digest = createHash("sha256").update(canonical).digest("hex");

const out = `// GENERATED FILE — do not edit by hand.
// Regenerate with: bun scripts/build-tzdata.ts
//
// Pinned IANA UTC-offset transitions, read from ICU once and committed as data
// so the laytime engine never depends on the host runtime's tzdata. Changing
// this file changes laytime calculations: regenerating it is a deliberate act
// that requires re-blessing the 500-case corpus.
//
// Era: ${START_YEAR}-01-01 .. ${END_YEAR}-01-01 (UTC)
// Zones: ${zoneCount}   Transitions: ${transitionCount}

/** SHA-256 over the canonical table. This is the version that matters. */
export const TZDATA_DIGEST = "${digest}";

/** Bounds of the pinned era, as UTC seconds. Outside this range we refuse. */
export const TZDATA_ERA_START_SEC = ${Math.floor(Date.UTC(START_YEAR, 0, 1) / 1000)};
export const TZDATA_ERA_END_SEC = ${Math.floor(Date.UTC(END_YEAR, 0, 1) / 1000)};

/**
 * Zone -> flat [utcSeconds, offsetMinutes, …] pairs, ascending.
 * The first pair is the offset in force at the start of the era.
 */
export const TZ_TRANSITIONS: Record<string, number[]> = ${canonical};
`;

const target = join(import.meta.dir, "../packages/laytime-core/src/tzdata.ts");
writeFileSync(target, out);

console.log(`zones=${zoneCount} transitions=${transitionCount}`);
console.log(`digest=${digest}`);
console.log(`bytes=${out.length}`);
console.log(`written: ${target}`);
