"use client";

import { useState } from "react";
import {
  CpTerms,
  NorVariant,
  DaysBasis,
  NOR_VARIANTS,
  DAYS_BASES,
  LaytimeResult,
} from "@/lib/laytime/types";

interface ClauseFlag {
  id: string;
  eventId: string;
  clauseRef: string;
  severity: "info" | "warning" | "critical";
  note: string;
  createdAt: string;
}

interface CalculationPaneProps {
  claimId: string;
  cpTerms: CpTerms;
  onCpTermsChange: (cpTerms: CpTerms) => void;
  result: LaytimeResult | null;
  clauseFlags: ClauseFlag[];
  onRunClauseAnalysis: () => void;
  onExport: () => void;
  exporting: boolean;
  flagging: boolean;
}

export function CalculationPane({
  claimId,
  cpTerms,
  onCpTermsChange,
  result,
  clauseFlags,
  onRunClauseAnalysis,
  onExport,
  exporting,
  flagging,
}: CalculationPaneProps) {
  // Local state mirrors the prop on mount. Parent uses a `key` prop based on
  // a cpTerms hash to force re-mount (and thus re-init) after server saves,
  // which avoids the cascading-render anti-pattern of setState-in-effect.
  const [local, setLocal] = useState<CpTerms>(cpTerms);
  const [dirty, setDirty] = useState(false);

  function update<K extends keyof CpTerms>(k: K, v: CpTerms[K]) {
    setLocal({ ...local, [k]: v });
    setDirty(true);
  }

  function save() {
    onCpTermsChange(local);
    setDirty(false);
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        {/* CP Terms form */}
        <section className="border-b border-[#1f2937] p-4">
          <div
            className="text-xs uppercase tracking-wider text-[#9ca3af] mb-3"
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            CP TERMS — GENCON 94
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Laytime allowed (hrs)">
              <input
                type="number"
                value={local.laytime_allowed_hours}
                onChange={(e) => update("laytime_allowed_hours", Number(e.target.value))}
                className="w-full bg-[#0a0f1e] border border-[#1f2937] px-2 py-1 text-xs text-[#f9fafb] tnum"
                style={{ borderRadius: 2, fontFamily: "var(--font-jetbrains-mono)" }}
              />
            </Field>
            <Field label="Turn time (hrs)">
              <input
                type="number"
                value={local.turn_time_hours}
                onChange={(e) => update("turn_time_hours", Number(e.target.value))}
                className="w-full bg-[#0a0f1e] border border-[#1f2937] px-2 py-1 text-xs text-[#f9fafb] tnum"
                style={{ borderRadius: 2, fontFamily: "var(--font-jetbrains-mono)" }}
              />
            </Field>
            <Field label="Load rate (MT/day)">
              <input
                type="number"
                value={local.load_rate ?? 0}
                onChange={(e) => update("load_rate", Number(e.target.value))}
                className="w-full bg-[#0a0f1e] border border-[#1f2937] px-2 py-1 text-xs text-[#f9fafb] tnum"
                style={{ borderRadius: 2, fontFamily: "var(--font-jetbrains-mono)" }}
              />
            </Field>
            <Field label="Discharge rate (MT/day)">
              <input
                type="number"
                value={local.discharge_rate ?? 0}
                onChange={(e) => update("discharge_rate", Number(e.target.value))}
                className="w-full bg-[#0a0f1e] border border-[#1f2937] px-2 py-1 text-xs text-[#f9fafb] tnum"
                style={{ borderRadius: 2, fontFamily: "var(--font-jetbrains-mono)" }}
              />
            </Field>
            <Field label="NOR variant">
              <select
                value={local.nor_variant}
                onChange={(e) => update("nor_variant", e.target.value as NorVariant)}
                className="w-full bg-[#0a0f1e] border border-[#1f2937] px-2 py-1 text-xs text-[#f9fafb]"
                style={{ borderRadius: 2, fontFamily: "var(--font-jetbrains-mono)" }}
              >
                {NOR_VARIANTS.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </Field>
            <Field label="Days basis">
              <select
                value={local.days_basis}
                onChange={(e) => update("days_basis", e.target.value as DaysBasis)}
                className="w-full bg-[#0a0f1e] border border-[#1f2937] px-2 py-1 text-xs text-[#f9fafb]"
                style={{ borderRadius: 2, fontFamily: "var(--font-jetbrains-mono)" }}
              >
                {DAYS_BASES.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </Field>
            <Field label="Demurrage rate (/day)">
              <input
                type="number"
                value={local.demurrage_rate}
                onChange={(e) => update("demurrage_rate", Number(e.target.value))}
                className="w-full bg-[#0a0f1e] border border-[#1f2937] px-2 py-1 text-xs text-[#f9fafb] tnum"
                style={{ borderRadius: 2, fontFamily: "var(--font-jetbrains-mono)" }}
              />
            </Field>
            <Field label="Despatch rate (/day)">
              <input
                type="number"
                value={local.despatch_rate}
                onChange={(e) => update("despatch_rate", Number(e.target.value))}
                className="w-full bg-[#0a0f1e] border border-[#1f2937] px-2 py-1 text-xs text-[#f9fafb] tnum"
                style={{ borderRadius: 2, fontFamily: "var(--font-jetbrains-mono)" }}
              />
            </Field>
            <Field label="Currency">
              <input
                type="text"
                value={local.currency}
                onChange={(e) => update("currency", e.target.value)}
                className="w-full bg-[#0a0f1e] border border-[#1f2937] px-2 py-1 text-xs text-[#f9fafb]"
                style={{ borderRadius: 2, fontFamily: "var(--font-jetbrains-mono)" }}
              />
            </Field>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={save}
              disabled={!dirty}
              className="px-3 py-1.5 text-xs text-[#0a0f1e] font-medium disabled:opacity-40"
              style={{ background: "#f59e0b", borderRadius: 2 }}
            >
              SAVE & RECOMPUTE
            </button>
            {dirty && (
              <span className="text-xs text-[#f59e0b]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                UNSAVED CHANGES
              </span>
            )}
          </div>
        </section>

        {/* Calculation output */}
        <section className="border-b border-[#1f2937] p-4">
          <div
            className="text-xs uppercase tracking-wider text-[#9ca3af] mb-3"
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            CALCULATION
          </div>
          {result ? (
            <>
              <div className="flex items-baseline gap-3 mb-3">
                <div>
                  <div
                    className="text-[10px] uppercase tracking-wider text-[#6b7280]"
                    style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                  >
                    USED
                  </div>
                  <div
                    className="text-2xl tnum text-[#f9fafb]"
                    style={{ fontFamily: "var(--font-space-grotesk)" }}
                  >
                    {result.totals.used_hours.toFixed(1)}h
                  </div>
                </div>
                <div className="text-[#6b7280]">/</div>
                <div>
                  <div
                    className="text-[10px] uppercase tracking-wider text-[#6b7280]"
                    style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                  >
                    ALLOWED
                  </div>
                  <div
                    className="text-2xl tnum text-[#f9fafb]"
                    style={{ fontFamily: "var(--font-space-grotesk)" }}
                  >
                    {result.totals.allowed_hours.toFixed(1)}h
                  </div>
                </div>
              </div>

              {result.totals.demurrage_amount > 0 ? (
                <div className="border border-[#f59e0b] bg-[#f59e0b]/5 p-3" style={{ borderRadius: 2 }}>
                  <div
                    className="text-[10px] uppercase tracking-wider text-[#f59e0b]"
                    style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                  >
                    DEMURRAGE
                  </div>
                  <div
                    className="text-2xl font-semibold tnum"
                    style={{ color: "#f59e0b", fontFamily: "var(--font-space-grotesk)" }}
                  >
                    {result.totals.currency} {result.totals.demurrage_amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                  <div
                    className="text-xs text-[#9ca3af] mt-1 tnum"
                    style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                  >
                    {result.totals.time_on_demurrage_hours.toFixed(2)}h on demurrage · GENCON94-8
                  </div>
                </div>
              ) : result.totals.despatch_amount > 0 ? (
                <div className="border border-[#14b8a6] bg-[#14b8a6]/5 p-3" style={{ borderRadius: 2 }}>
                  <div
                    className="text-[10px] uppercase tracking-wider text-[#14b8a6]"
                    style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                  >
                    DESPATCH ↓
                  </div>
                  <div
                    className="text-2xl font-semibold tnum"
                    style={{ color: "#14b8a6", fontFamily: "var(--font-space-grotesk)" }}
                  >
                    {result.totals.currency} {result.totals.despatch_amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                  <div
                    className="text-xs text-[#9ca3af] mt-1 tnum"
                    style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                  >
                    {result.totals.time_saved_hours.toFixed(2)}h time saved · GENCON94-7
                  </div>
                </div>
              ) : (
                <div className="border border-[#1f2937] p-3 text-sm text-[#9ca3af]" style={{ borderRadius: 2 }}>
                  Laytime exactly matches allowed.
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-[#9ca3af]">
              No calculation yet. Accept at least a NOR_TENDERED event to begin.
            </div>
          )}
        </section>

        {/* Hour-resolution breakdown */}
        <section className="border-b border-[#1f2937] p-4">
          <div
            className="text-xs uppercase tracking-wider text-[#9ca3af] mb-3"
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            BREAKDOWN — HOUR RESOLUTION
          </div>
          {result && result.breakdown.length > 0 ? (
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[#0a0f1e]">
                  <tr className="text-left text-[10px] uppercase tracking-wider text-[#6b7280]">
                    <th className="py-1 pr-2" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>Start</th>
                    <th className="py-1 pr-2" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>End</th>
                    <th className="py-1 pr-2" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>Hrs</th>
                    <th className="py-1 pr-2" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>Status</th>
                    <th className="py-1 pr-2" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>Clause</th>
                  </tr>
                </thead>
                <tbody>
                  {result.breakdown.map((row, i) => (
                    <tr key={i} className="border-t border-[#1f2937] align-top">
                      <td className="py-1.5 pr-2 tnum text-[#9ca3af]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                        {row.start_time.slice(5, 16).replace("T", " ")}
                      </td>
                      <td className="py-1.5 pr-2 tnum text-[#9ca3af]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                        {row.end_time.slice(5, 16).replace("T", " ")}
                      </td>
                      <td className="py-1.5 pr-2 tnum text-[#f9fafb]">
                        {row.duration_hours}
                      </td>
                      <td className="py-1.5 pr-2">
                        <span
                          className="status-badge px-1 py-0.5"
                          style={{
                            color: breakdownColor(row.status, row.counts),
                            background: `${breakdownColor(row.status, row.counts)}10`,
                            borderRadius: 2,
                          }}
                        >
                          {row.status.replace(/_/g, " ")}
                          {!row.counts && " ✕"}
                        </span>
                      </td>
                      <td className="py-1.5 pr-2 tnum text-[#f59e0b]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                        {row.clause_ref}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-sm text-[#9ca3af]">No breakdown rows yet.</div>
          )}
        </section>

        {/* Clause flags */}
        <section className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div
              className="text-xs uppercase tracking-wider text-[#9ca3af]"
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              CLAUSE FLAGS ({clauseFlags.length})
            </div>
            <button
              onClick={onRunClauseAnalysis}
              disabled={flagging}
              className="px-2 py-1 text-[10px] border border-[#1f2937] bg-[#111827] text-[#9ca3af] hover:text-[#f9fafb] hover:border-[#f59e0b] disabled:opacity-50"
              style={{ borderRadius: 2, fontFamily: "var(--font-jetbrains-mono)" }}
            >
              {flagging ? "ANALYZING…" : "RUN CLAUSE ANALYSIS"}
            </button>
          </div>
          {clauseFlags.length === 0 ? (
            <div className="text-sm text-[#9ca3af]">
              No flags. Run clause analysis after accepting events.
            </div>
          ) : (
            <div className="space-y-2">
              {clauseFlags.map((f) => (
                <div
                  key={f.id}
                  className="border-l-2 p-2 text-xs"
                  style={{
                    borderLeftColor: severityColor(f.severity),
                    background: `${severityColor(f.severity)}08`,
                  }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="status-badge"
                      style={{ color: severityColor(f.severity) }}
                    >
                      {f.severity}
                    </span>
                    <span
                      className="tnum text-[#f9fafb]"
                      style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                    >
                      {f.clauseRef}
                    </span>
                  </div>
                  <div className="text-[#9ca3af]">{f.note}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Export bar */}
      <div className="border-t border-[#1f2937] p-3 flex items-center justify-end">
        <button
          onClick={onExport}
          disabled={exporting}
          className="px-3 py-1.5 text-xs text-[#0a0f1e] font-medium disabled:opacity-50"
          style={{ background: "#f59e0b", borderRadius: 2 }}
        >
          {exporting ? "EXPORTING…" : "EXPORT CLAIM PACK"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div
        className="text-[10px] uppercase tracking-wider text-[#6b7280] mb-1"
        style={{ fontFamily: "var(--font-jetbrains-mono)" }}
      >
        {label}
      </div>
      {children}
    </label>
  );
}

function breakdownColor(status: string, counts: boolean): string {
  if (status === "demurrage") return "#f59e0b";
  if (status === "weather_delay") return "#ef4444";
  if (status === "shifting") return "#92691a";
  if (status === "excepted") return counts ? "#14b8a6" : "#6b7280";
  return "#14b8a6";
}

function severityColor(s: string): string {
  if (s === "critical") return "#ef4444";
  if (s === "warning") return "#92691a";
  return "#6b7280";
}
