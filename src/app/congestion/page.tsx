import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  buildCongestionCells,
  summarizePorts,
  MIN_VOYAGES,
  MIN_COMPANIES,
  type CongestionSample,
  type PortCongestionSummary,
} from "@/lib/intel/congestion";
import { LandingNav } from "@/components/laygrounded/landing-nav";
import styles from "./Congestion.module.css";

// Rendered per request, NOT prerendered. The publication flag below has to be
// read at request time: with ISR this page is built once, so a build that ran
// while the flag was unset bakes `notFound()` into the static output and later
// setting the variable appears to do nothing. A silent no-op on the switch that
// governs publishing customer-derived data is the wrong failure mode.
//
// The cost is one indexed read of a small materialized view per request. If this
// page ever draws real crawl traffic, cache the data load rather than
// reintroducing prerendering of the gate.
export const dynamic = "force-dynamic";

/**
 * Publication switch, OFF unless explicitly set.
 *
 * The page aggregates data contributed by every tenant. Building the capability
 * is one decision; publishing a public dataset built on customers' operating
 * data is a separate one that belongs to the operator, not to a deploy. With the
 * flag unset this route 404s and nothing is exposed.
 */
const PUBLISHED = process.env.PUBLIC_CONGESTION_INDEX === "1";

const MONTHS_OF_HISTORY = 24;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const metadata: Metadata = {
  title: "Port congestion index — waiting times by port | LayGrounded",
  description:
    "Median vessel waiting time from Notice of Readiness to berth, by port, " +
    "aggregated across dry bulk voyages. Free and updated continuously.",
};

async function loadPorts(): Promise<PortCongestionSummary[]> {
  const service = createServiceRoleClient();
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - MONTHS_OF_HISTORY);

  const { data, error } = await service
    .from("port_congestion_stats")
    .select("port_key, port_label, company_id, year, month, waiting_hours, working_hours")
    .gte("nor_at", cutoff.toISOString());

  // A statistics page is not worth failing a deploy over; an empty index reads
  // honestly as "not enough data yet".
  if (error) return [];

  const samples: CongestionSample[] = (data ?? []).map((r) => ({
    portKey: r.port_key,
    portLabel: r.port_label,
    companyId: r.company_id,
    year: r.year,
    month: r.month,
    waitingHours: Number(r.waiting_hours),
    workingHours: r.working_hours === null ? null : Number(r.working_hours),
  }));

  return summarizePorts(buildCongestionCells(samples));
}

function TrendChip({ port }: { port: PortCongestionSummary }) {
  if (port.trend === "unknown" || port.changeVsPriorPct === null) {
    return <span className={styles.trendFlat}>—</span>;
  }
  const cls =
    port.trend === "rising"
      ? styles.trendUp
      : port.trend === "easing"
        ? styles.trendDown
        : styles.trendFlat;
  const sign = port.changeVsPriorPct > 0 ? "+" : "";
  return (
    <span className={cls}>
      {port.trend === "rising" ? "▲" : port.trend === "easing" ? "▼" : "="} {sign}
      {port.changeVsPriorPct}%
    </span>
  );
}

export default async function CongestionIndexPage() {
  if (!PUBLISHED) notFound();

  const ports = await loadPorts();
  const publishable = ports.filter((p) => p.latest !== null);

  return (
    <div className={styles.page}>
      <LandingNav />
      <main className={styles.main}>
        <header className={styles.head}>
          <h1 className={styles.title}>Port congestion index</h1>
          <p className={styles.sub}>
            Median waiting time from Notice of Readiness to all fast, by port. Built from
            confirmed statements of facts across participating dry bulk voyages, and updated
            as new voyages complete.
          </p>
        </header>

        {publishable.length === 0 ? (
          <div className={styles.empty}>
            <p>
              No port yet has enough independent voyages to publish. Cells appear once they
              clear {MIN_VOYAGES} voyages from at least {MIN_COMPANIES} separate companies.
            </p>
          </div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Port</th>
                  <th style={{ textAlign: "right" }}>Median wait</th>
                  <th style={{ textAlign: "right" }}>P90 wait</th>
                  <th style={{ textAlign: "right" }}>Median time alongside</th>
                  <th style={{ textAlign: "right" }}>Trend</th>
                  <th style={{ textAlign: "right" }}>Period</th>
                </tr>
              </thead>
              <tbody>
                {publishable.map((p) => (
                  <tr key={p.portKey}>
                    <td className={styles.port}>{p.portLabel}</td>
                    <td className="tnum" style={{ textAlign: "right" }}>
                      <strong>{p.latest!.medianWaitingHours}h</strong>
                    </td>
                    <td className="tnum" style={{ textAlign: "right" }}>
                      {p.latest!.p90WaitingHours}h
                    </td>
                    <td className="tnum" style={{ textAlign: "right" }}>
                      {p.latest!.medianWorkingHours !== null
                        ? `${p.latest!.medianWorkingHours}h`
                        : "—"}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <TrendChip port={p} />
                    </td>
                    <td className="tnum" style={{ textAlign: "right" }}>
                      {MONTH_NAMES[p.latest!.month - 1]} {p.latest!.year}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <section className={styles.method}>
          <h2>How this is measured</h2>
          <ul>
            <li>
              Waiting time is the interval from a confirmed Notice of Readiness to the
              confirmed all-fast timestamp on the same voyage.
            </li>
            <li>
              A port/month is published only when it contains at least{" "}
              <strong>{MIN_VOYAGES} voyages</strong> from at least{" "}
              <strong>{MIN_COMPANIES} separate companies</strong>. Anything below either
              threshold is suppressed entirely — including its voyage count.
            </li>
            <li>
              Figures are medians across companies. No individual voyage, vessel, charterer
              or owner is identifiable, and participation is per-company and revocable.
            </li>
            <li>
              Trend compares the latest published month against the median of that
              port&apos;s earlier published months; moves under 10% are shown as steady.
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}
