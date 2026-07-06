import Link from "next/link";
import { LandingNav } from "@/components/laygrounded/landing-nav";

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-[#0a0f1e] text-[#f9fafb]">
      <LandingNav />

      {/* Hero — with grid + scanline overlay */}
      <section className="relative overflow-hidden">
        <div className="bg-grid-overlay bg-scanlines absolute inset-0 pointer-events-none" />
        <div className="relative mx-auto max-w-7xl px-6 py-24 lg:py-36">
          <div className="flex items-center gap-3 mb-6">
            <span
              className="beacon inline-block h-2 w-2 rounded-full"
              style={{ background: "#f59e0b" }}
            />
            <span
              className="text-xs uppercase tracking-[0.2em] text-[#9ca3af]"
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              LIVE — DRY BULK CLAIMS ENGINE
            </span>
          </div>
          <h1
            className="max-w-4xl text-5xl md:text-7xl font-semibold leading-[1.05] tracking-tight"
            style={{ fontFamily: "var(--font-space-grotesk)" }}
          >
            Precision Laytime Arbitration for Global Bulk Fleets.
          </h1>
          <p className="mt-8 max-w-2xl text-lg text-[#9ca3af] leading-relaxed">
            Automated Statement of Facts extraction with legally auditable
            clause-matching. Turn hours of manual review into minutes of
            defensible calculation.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <Link
              href="/sign-up"
              className="px-6 py-3 text-[#0a0f1e] font-medium transition hover:opacity-90"
              style={{ background: "#f59e0b", borderRadius: 2 }}
            >
              Initialize Claim Workspace
            </Link>
            <Link
              href="/sign-in"
              className="border border-[#1f2937] bg-[#111827] px-6 py-3 text-[#f9fafb] transition hover:border-[#f59e0b]"
              style={{ borderRadius: 2 }}
            >
              Sign in to existing fleet
            </Link>
          </div>

          {/* Stats row */}
          <div className="mt-20 grid grid-cols-1 md:grid-cols-3 gap-px bg-[#1f2937] border border-[#1f2937]">
            {[
              {
                stat: "$8–10B",
                label: "in dry bulk demurrage annually",
                color: "#f59e0b",
              },
              {
                stat: "99%",
                label: "of SoFs processed by hand",
                color: "#f9fafb",
              },
              {
                stat: "$15,000+",
                label: "exposure per missed event",
                color: "#f59e0b",
              },
            ].map((s, i) => (
              <div key={i} className="bg-[#0a0f1e] p-8">
                <div
                  className="text-4xl font-semibold tnum"
                  style={{ color: s.color, fontFamily: "var(--font-space-grotesk)" }}
                >
                  {s.stat}
                </div>
                <div className="mt-2 text-sm text-[#9ca3af]">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 4-step pipeline */}
      <section className="border-t border-[#1f2937]">
        <div className="mx-auto max-w-7xl px-6 py-20">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-px bg-[#1f2937] border border-[#1f2937]">
            {[
              {
                n: "01",
                title: "Upload SoF",
                body: "Drag-and-drop Statement of Facts in PDF or image format. Per-page storage with signed URLs only.",
              },
              {
                n: "02",
                title: "AI Extraction",
                body: "Vision-language model maps every SoF entry to canonical event types with bbox, confidence, and verbatim text.",
              },
              {
                n: "03",
                title: "Rules Engine",
                body: "Pure TypeScript GENCON 94 engine. Hour-by-hour iteration with full clause citations per row.",
              },
              {
                n: "04",
                title: "Claim Pack",
                body: "Export arbitrated PDF + XLSX with every line cited to source. Court-ready in minutes.",
              },
            ].map((step) => (
              <div key={step.n} className="bg-[#0a0f1e] p-8">
                <div
                  className="text-xs tnum text-[#f59e0b]"
                  style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                >
                  {step.n}
                </div>
                <h3
                  className="mt-3 text-xl font-medium"
                  style={{ fontFamily: "var(--font-space-grotesk)" }}
                >
                  {step.title}
                </h3>
                <p className="mt-2 text-sm text-[#9ca3af] leading-relaxed">
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[#1f2937]">
        <div className="mx-auto max-w-7xl px-6 py-10 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: "#f59e0b" }}
            />
            <span
              className="font-semibold"
              style={{ fontFamily: "var(--font-space-grotesk)" }}
            >
              LayGrounded
            </span>
            <span className="text-xs text-[#6b7280] ml-3">
              Laytime & Demurrage Claims Engine — GENCON 94
            </span>
          </div>
          <div className="text-xs text-[#6b7280]">
            © {new Date().getFullYear()} LayGrounded. All rights reserved.
          </div>
        </div>
      </footer>
    </main>
  );
}
