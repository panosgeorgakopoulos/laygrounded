// Builds the two verifier artifacts and proves they agree.
//
//   laygrounded-verify.mjs   ~50 KB  — the AUDITABLE artifact. An arbitrator's
//                                      technical expert can read 50 KB. Nobody
//                                      reads 1.5 MB of WebAssembly, so this is
//                                      the one that actually functions as
//                                      evidence.
//   laygrounded-verify.wasm  ~1.5 MB — the ZERO-TOOLCHAIN artifact. No Node, no
//                                      npm, no install: `wasmtime verify.wasm
//                                      < bundle.json`.
//
// Shipping both, from one source, with CI asserting they produce an identical
// conformance root, is a stronger claim than either alone: the readable file can
// be reviewed, and the sealed one can be run by someone who will not install a
// JavaScript runtime to check a demurrage claim.
//
// The wasm step is skipped (not failed) when Javy is absent, so the ordinary
// build does not depend on a toolchain most contributors will not have.
//
// Run: bun packages/laytime-verify/scripts/build-artifacts.ts [--javy <path>]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const PKG_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(PKG_ROOT, "../..");
const DIST = join(PKG_ROOT, "dist");

// TWO SUITES, one per engine rule set — see EngineVersion in laytime-core.
//
// v1's root is PUBLISHED. It appears in README.md and in documents that cite it,
// and a third party re-running the bundle they downloaded last year must still
// get the same number. It is pinned here rather than merely reported: a build
// that changed it would be a build that silently re-versioned every claim
// already served under those rules, and it must fail rather than publish.
const SUITES = [
  {
    label: "v1",
    cases: join(REPO_ROOT, "synthetic-corpus/cases"),
    file: "conformance.json",
    expectedRoot: "bc9f24fdab910a1b",
  },
  {
    label: "v2",
    cases: join(REPO_ROOT, "synthetic-corpus-v2/cases"),
    file: "conformance-v2.json",
    expectedRoot: "261e3468d2246f30",
  },
] as const;

const args = process.argv.slice(2);
function flag(name: string): string | null {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

// In CI the wasm must be exercised through the runtime an auditor would use.
// The node:wasi fallback is a local-development convenience; letting it stand in
// silently would mean publishing a wasm nobody had run the way it will be run.
const REQUIRE_WASMTIME = args.includes("--require-wasmtime");

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

mkdirSync(DIST, { recursive: true });

// ── 1. The conformance bundles ───────────────────────────────────────────────
// Published alongside the artifacts so a third party can re-run the same cases
// the vendor claims to pass — one bundle per rule set.
const suites = SUITES.map((suite) => {
  if (!existsSync(suite.cases)) {
    throw new Error(
      `corpus missing for ${suite.label} at ${suite.cases}. Generate it with: ` +
        `bun scripts/synthetic-claims/generate.ts` +
        (suite.label === "v2" ? " --engine-version 2 --no-pdf" : ""),
    );
  }
  const cases = readdirSync(suite.cases)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const c = JSON.parse(readFileSync(join(suite.cases, f), "utf8"));
      return { id: c.id, cpTerms: c.cpTerms, events: c.events, expected: c.expected };
    });
  const path = join(DIST, suite.file);
  writeFileSync(path, JSON.stringify({ cases }));
  console.log(`conformance ${suite.label}: ${cases.length} cases, ${statSync(path).size} bytes`);
  return { ...suite, cases, path };
});

// The v1 bundle is what `verify.test.ts` and the README refer to as "the"
// conformance suite; keep the familiar handle for the steps below.
const primary = suites[0];
const cases = primary.cases;
const conformancePath = primary.path;

// ── 2. The readable JS artifact ──────────────────────────────────────────────
const mjsPath = join(DIST, "laygrounded-verify.mjs");
const entry = join(PKG_ROOT, "src/entry-node.ts");

// Written here rather than committed: it is a thin shim over the shared entry,
// and generating it keeps the two artifacts provably built from one source.
writeFileSync(
  entry,
  `import { readFileSync } from "node:fs";
import { processDocument } from "./entry-cli";
process.stdout.write(processDocument(readFileSync(0, "utf8")));
`,
);

await Bun.build({
  entrypoints: [entry],
  outdir: DIST,
  target: "node",
  format: "esm",
  minify: true,
  naming: "laygrounded-verify.mjs",
});

const mjs = readFileSync(mjsPath);
console.log(`mjs: ${mjs.length} bytes  sha256=${sha256(mjs).slice(0, 16)}…`);

// ── 3. Run conformance through the JS artifact ───────────────────────────────
function runMjs(inputPath: string): string {
  return execFileSync(flag("node") ?? "node", [mjsPath], {
    input: readFileSync(inputPath),
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });
}

const mjsReports = suites.map((suite) => {
  const report = JSON.parse(runMjs(suite.path));
  console.log(`mjs conformance ${suite.label}: ${report.passed}/${report.cases} root=${report.root}`);
  if (report.failed > 0) {
    console.error("FAILURES:", JSON.stringify(report.failures.slice(0, 5), null, 2));
    throw new Error(`JS artifact failed ${report.failed} ${suite.label} conformance cases`);
  }
  // The published root is a promise, not an observation. A build that moved it
  // would invalidate every citation of it, so it fails here rather than at a
  // tribunal.
  if (report.root !== suite.expectedRoot) {
    throw new Error(
      `CONFORMANCE ROOT CHANGED (${suite.label}): expected ${suite.expectedRoot}, got ${report.root}. ` +
        `Rule set ${suite.label} is frozen — this means engine behaviour moved under it. ` +
        `Refusing to publish.`,
    );
  }
  return { suite, report };
});
const mjsReport = mjsReports[0].report;

// ── 4. The wasm artifact ─────────────────────────────────────────────────────
// Javy has no Intl at all, which is precisely why the engine had to stop using
// it: the pinned tz table is what makes this build possible.
const javy = flag("javy") ?? join(REPO_ROOT, "javy");
let wasmReport: { root: string; passed: number; cases: number; failed: number } | null = null;
let wasmSha: string | null = null;
let verifiedBy: string | null = null;
let wasmRunner: { name: string; run: (inputPath: string) => string } | null = null;

if (existsSync(javy)) {
  const javyEntry = join(PKG_ROOT, "src/entry-javy.ts");
  writeFileSync(
    javyEntry,
    `import { processDocument } from "./entry-cli";
// Javy exposes stdio through its own global rather than node:fs.
const chunks = [];
const buf = new Uint8Array(65536);
let n;
while ((n = Javy.IO.readSync(0, buf)) > 0) chunks.push(buf.slice(0, n));
let total = 0;
for (const c of chunks) total += c.length;
const all = new Uint8Array(total);
let off = 0;
for (const c of chunks) { all.set(c, off); off += c.length; }
const out = new TextEncoder().encode(processDocument(new TextDecoder().decode(all)));
Javy.IO.writeSync(1, out);
`,
  );

  const javyBundle = join(DIST, "_javy-entry.js");
  await Bun.build({
    entrypoints: [javyEntry],
    outdir: DIST,
    target: "browser",
    format: "esm",
    minify: true,
    naming: "_javy-entry.js",
  });

  const wasmPath = join(DIST, "laygrounded-verify.wasm");
  execFileSync(javy, ["build", javyBundle, "-o", wasmPath], { stdio: "inherit" });

  const wasm = readFileSync(wasmPath);
  wasmSha = sha256(wasm);
  console.log(`wasm: ${wasm.length} bytes  sha256=${wasmSha.slice(0, 16)}…`);

  // Run the wasm to prove it agrees. wasmtime is preferred because it is what a
  // third party would realistically use, but Node's built-in WASI is the
  // fallback so the equivalence assertion ALWAYS executes — a build that
  // silently skipped it would publish two artifacts nobody had checked against
  // each other, which is the one thing this script exists to prevent.
  // Parameterised by input path: the same runner executes the conformance
  // suite and, in step 6, the whole-object claim bundles.
  const runners: Array<{ name: string; run: (inputPath: string) => string }> = [];
  const wasmtime = flag("wasmtime") ?? "wasmtime";
  runners.push({
    name: "wasmtime",
    run: (inputPath: string) =>
      execFileSync(wasmtime, [wasmPath], {
        input: readFileSync(inputPath),
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      }),
  });
  if (!REQUIRE_WASMTIME) runners.push({
    name: "node:wasi",
    run: (inputPath: string) => {
      const runner = join(DIST, "_run-wasi.mjs");
      writeFileSync(
        runner,
        `import { readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { WASI } from "node:wasi";
import { argv, env } from "node:process";
const inFd = openSync(argv[3], "r");
const outFd = openSync(argv[4], "w");
const wasi = new WASI({ version: "preview1", args: [], env, stdin: inFd, stdout: outFd,
  returnOnExit: true });
const wasm = await WebAssembly.compile(readFileSync(argv[2]));
const instance = await WebAssembly.instantiate(wasm, wasi.getImportObject());
wasi.start(instance);
closeSync(inFd); closeSync(outFd);
`,
      );
      const outPath = join(DIST, "_wasi-out.json");
      // Explicitly `node`, not process.execPath: this script runs under Bun,
      // which has no node:wasi. The point of this runner is to execute the wasm
      // in a DIFFERENT engine from the one that produced the JS artifact —
      // running both in Bun would prove nothing.
      execFileSync(flag("node") ?? "node", [runner, wasmPath, inputPath, outPath], {
        stdio: "inherit",
      });
      return readFileSync(outPath, "utf8");
    },
  });

  for (const runner of runners) {
    try {
      wasmReport = JSON.parse(runner.run(conformancePath));
      wasmRunner = runner;
      verifiedBy = runner.name;
      console.log(
        `wasm conformance via ${runner.name}: ${wasmReport!.passed}/${wasmReport!.cases} ` +
          `root=${wasmReport!.root}`,
      );
      break;
    } catch (e) {
      console.warn(`  ${runner.name} unavailable: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  // The wasm must reproduce EVERY rule set, not just the first. An artifact that
  // agreed on v1 and diverged on v2 would verify a legacy claim and quietly
  // misjudge a current one — the worse of the two failures, because the number
  // it produced would look authoritative.
  if (wasmReport && wasmRunner) {
    for (const { suite, report: mjsSuiteReport } of mjsReports.slice(1)) {
      const r = JSON.parse(wasmRunner.run(suite.path));
      console.log(
        `wasm conformance ${suite.label} via ${wasmRunner.name}: ${r.passed}/${r.cases} root=${r.root}`,
      );
      if (r.failed > 0) throw new Error(`wasm artifact failed ${r.failed} ${suite.label} cases`);
      if (r.root !== suite.expectedRoot) {
        throw new Error(
          `CONFORMANCE ROOT CHANGED (${suite.label}, wasm): expected ${suite.expectedRoot}, got ${r.root}.`,
        );
      }
      if (r.root !== mjsSuiteReport.root) {
        throw new Error(
          `ARTIFACT DIVERGENCE (${suite.label}): mjs root ${mjsSuiteReport.root} != wasm root ${r.root}.`,
        );
      }
    }
  }
  if (!wasmReport) {
    throw new Error(
      REQUIRE_WASMTIME
        ? "--require-wasmtime was set but wasmtime could not run the artifact. " +
          "Refusing to fall back to node:wasi: the wasm must be exercised through " +
          "the runtime a third party would actually use."
        : "wasm was built but could not be executed by any runtime, so its agreement " +
          "with the JS artifact is unverified. Install wasmtime, or use a Node with " +
          "node:wasi. Refusing to publish unchecked artifacts.",
    );
  }
} else {
  console.warn(`javy not found at ${javy} — skipping the wasm artifact.`);
}

// ── 5. The equivalence assertion ─────────────────────────────────────────────
// This is the claim worth making: two independently-executed artifacts, one
// readable and one sealed, agreeing exactly on 500 published cases.
if (wasmReport) {
  if (wasmReport.root !== mjsReport.root) {
    throw new Error(
      `ARTIFACT DIVERGENCE: mjs root ${mjsReport.root} != wasm root ${wasmReport.root}. ` +
        `The two artifacts do not agree; neither should be published.`,
    );
  }
  console.log(`✓ artifacts agree on root ${mjsReport.root}`);
}

// ── 6. The whole-object claim path ───────────────────────────────────────────
// The conformance root proves the artifacts RECOMPUTE identically. It says
// nothing about `verifyClaim` with `published` set — the path a bank actually
// exercises, and since format 1.1 the product's core claim. It needs its own
// check because a "verified" verdict is only worth something if the negative
// case is also proven: an artifact that answered `true` unconditionally would
// pass every conformance case ever written.
//
// Cases are drawn from the published corpus rather than hand-written, so this
// exercises real breakdowns, and both CP forms are required to be present —
// GENCON 94 omits `demurrage_half_rate_hours` while ASBATANKVOY emits it, and
// the canonical JSON treats an absent key differently from a null one.
{
  const successful = cases.filter((c) => c.expected?.result);
  const pick = (form: string) =>
    successful.find((c) => (c.cpTerms?.cp_form ?? "GENCON94") === form);

  const gencon = pick("GENCON94");
  const asba = pick("ASBATANKVOY");
  if (!gencon || !asba) {
    throw new Error(
      "the corpus no longer contains a successful case for both CP forms, so the " +
        "whole-object check cannot cover the half-rate key. Refusing to publish.",
    );
  }

  const checks: Array<{ name: string; bundle: unknown; expect: boolean | null }> = [
    // A faithful publication must verify.
    { name: "gencon/intact", bundle: { ...gencon, published: gencon.expected.result }, expect: true },
    { name: "asba/intact", bundle: { ...asba, published: asba.expected.result }, expect: true },
    // A tampered total must NOT. This is the assertion that gives `true` meaning.
    {
      name: "gencon/tampered",
      bundle: {
        ...gencon,
        published: {
          ...gencon.expected.result,
          totals: {
            ...gencon.expected.result.totals,
            demurrage_amount: gencon.expected.result.totals.demurrage_amount + 1000,
          },
        },
      },
      expect: false,
    },
    // Publishing nothing is honest, not a failure: the verdict must be null
    // rather than a false "verified".
    { name: "gencon/unpublished", bundle: { cpTerms: gencon.cpTerms, events: gencon.events }, expect: null },
  ];

  for (const check of checks) {
    const inputPath = join(DIST, "_claim-check.json");
    writeFileSync(inputPath, JSON.stringify(check.bundle));

    const mjsVerdict = JSON.parse(runMjs(inputPath));
    if (mjsVerdict.matchesPublished !== check.expect) {
      throw new Error(
        `WHOLE-OBJECT CHECK FAILED (${check.name}): mjs matchesPublished=` +
          `${mjsVerdict.matchesPublished}, expected ${check.expect}.`,
      );
    }

    if (wasmRunner) {
      const wasmVerdict = JSON.parse(wasmRunner.run(inputPath));
      if (wasmVerdict.matchesPublished !== check.expect) {
        throw new Error(
          `WHOLE-OBJECT CHECK FAILED (${check.name}): wasm matchesPublished=` +
            `${wasmVerdict.matchesPublished}, expected ${check.expect}.`,
        );
      }
      // Equality on the whole verdict, not just the boolean: the discrepancy
      // list is what a tribunal reads, so the artifacts must agree on it too.
      if (JSON.stringify(wasmVerdict) !== JSON.stringify(mjsVerdict)) {
        throw new Error(
          `ARTIFACT DIVERGENCE on claim verdict (${check.name}); neither should be published.`,
        );
      }
    }
    rmSync(inputPath, { force: true });
  }
  console.log(
    `✓ whole-object claim verification agrees across artifacts (${checks.length} checks, both CP forms)`,
  );
}

writeFileSync(
  join(DIST, "manifest.json"),
  JSON.stringify(
    {
      verifierVersion: mjsReport.verifierVersion,
      tzdataDigest: mjsReport.tzdataDigest,
      // The v1 suite keeps the unqualified key it has always had: consumers
      // parse `conformance.root` and compare it to the README, and renaming it
      // would break them for no gain.
      conformance: {
        cases: mjsReport.cases,
        root: mjsReport.root,
        sha256: sha256(readFileSync(conformancePath)),
      },
      // One entry per rule set, including v1 again — a consumer that wants to
      // check "which engines does this artifact attest?" should not have to
      // treat one of them as a special case.
      conformanceSuites: mjsReports.map(({ suite, report }) => ({
        engineVersion: suite.label === "v2" ? 2 : 1,
        file: suite.file,
        cases: report.cases,
        root: report.root,
        sha256: sha256(readFileSync(suite.path)),
      })),
      artifacts: {
        // The JS artifact IS reproducible: same source, same bytes, every time.
        mjs: { bytes: mjs.length, sha256: sha256(mjs), reproducible: true },
        // The wasm is NOT. Javy emits different bytes for byte-identical input
        // (verified: two builds of the same file differ deep in the embedded
        // QuickJS section), so this hash identifies the artifact we published —
        // it is a distribution-integrity check, not something a third party can
        // reproduce by rebuilding. The reproducible attestation is
        // `conformance.root`, which is behavioural and stable.
        ...(wasmSha
          ? { wasm: { sha256: wasmSha, reproducible: false, reason: "javy output is not byte-deterministic" } }
          : {}),
      },
      agreementVerified: Boolean(wasmReport),
      // Named, because "the artifacts agree" means less if nobody can tell which
      // runtime was asked.
      agreementRuntime: verifiedBy,
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
console.log(`manifest written to ${join(DIST, "manifest.json")}`);
