"use client";

// The distribution of simulated outcomes for one voyage.
//
// WHY THE SPLIT AT ZERO IS THE WHOLE CHART: net = demurrage − despatch, and the
// engine never produces both at once, so `net > 0` is EXACTLY the demurrage
// boundary. The blue area is therefore the share of simulated voyages that cost
// nothing, and the red area's share is the headline probability. The reader sees
// where the number came from rather than being asked to trust it.
//
// Binned data is drawn as a STEPPED area, not a smoothed curve: the simulation
// produces 24 bins, and interpolating between them would draw a shape the data
// does not support.
//
// Diverging blue↔red on a neutral zero, validated against this app's own light
// and dark surfaces (CVD ΔE 21.6 light / 19.2 dark against a ≥8 target).

import { useId, useMemo, useState } from "react";
import { buildChartModel, CHART, type HistogramBin } from "@/lib/risk/chart-model";
import styles from "./RiskDistributionChart.module.css";

export type { HistogramBin };

interface Props {
  histogram: HistogramBin[];
  trials: number;
  currency: string;
  meanValue: number;
  p90Value: number;
  demurrageProbability: number;
}

const W = CHART.width;
const H = CHART.height;
const PAD = CHART.pad;
const PLOT_W = W - PAD.left - PAD.right;

function compactMoney(v: number, currency: string): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${sign}${currency} ${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${currency} ${Math.round(abs / 1_000)}k`;
  return `${sign}${currency} ${Math.round(abs)}`;
}

function fullMoney(v: number, currency: string): string {
  return `${v < 0 ? "−" : ""}${currency} ${Math.abs(v).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  })}`;
}

export default function RiskDistributionChart({
  histogram,
  trials,
  currency,
  meanValue,
  p90Value,
  demurrageProbability,
}: Props) {
  const uid = useId().replace(/:/g, "");
  const [hover, setHover] = useState<{ bin: HistogramBin; x: number } | null>(null);
  const [showTable, setShowTable] = useState(false);

  const model = useMemo(
    () => buildChartModel({ histogram, trials, meanValue, p90Value }),
    [histogram, trials, meanValue, p90Value]
  );

  if (!model) {
    return (
      <p className={styles.empty}>
        No distribution to plot — the simulation produced no outcomes.
      </p>
    );
  }

  const { x, y, path: d, base, xTicks: ticks, yTicks, yTop, zeroX } = model;
  const noDemurrageShare = 1 - demurrageProbability;

  // 1px inset each side of zero gives the 2px surface gap between the two fills,
  // so they read as separate regions without a border drawn around either.
  const clipNeg = `clipNeg-${uid}`;
  const clipPos = `clipPos-${uid}`;

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    if (svgX < PAD.left || svgX > PAD.left + PLOT_W) {
      setHover(null);
      return;
    }
    const bin = histogram.find((b) => svgX >= x(b.from) && svgX <= x(b.to));
    setHover(bin ? { bin, x: svgX } : null);
  };

  return (
    <figure className={styles.figure}>
      <figcaption className={styles.caption}>
        <span className={styles.captionTitle}>
          Distribution of simulated outcomes across {trials.toLocaleString("en-US")} voyages
        </span>
        <button
          type="button"
          className={styles.tableToggle}
          onClick={() => setShowTable((s) => !s)}
          aria-expanded={showTable}
        >
          {showTable ? "Hide data table" : "View as table"}
        </button>
      </figcaption>

      {/* Legend: two series, so identity is never carried by colour alone. */}
      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.swatchNeg}`} aria-hidden="true" />
          No demurrage — {(noDemurrageShare * 100).toFixed(0)}% of voyages
        </span>
        <span className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.swatchPos}`} aria-hidden="true" />
          On demurrage — {(demurrageProbability * 100).toFixed(0)}% of voyages
        </span>
      </div>

      <svg
        className={styles.svg}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={
          `Distribution of net exposure across ${trials} simulated voyages. ` +
          `${(demurrageProbability * 100).toFixed(0)} percent end on demurrage. ` +
          `Mean ${fullMoney(meanValue, currency)}, P90 ${fullMoney(p90Value, currency)}.`
        }
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <clipPath id={clipNeg}>
            <rect x={0} y={0} width={Math.max(0, zeroX - 1)} height={H} />
          </clipPath>
          <clipPath id={clipPos}>
            <rect x={zeroX + 1} y={0} width={Math.max(0, W - zeroX - 1)} height={H} />
          </clipPath>
        </defs>

        {/* Gridlines: solid hairlines one shade off the surface, never dashed. */}
        {yTicks.map((t, i) => (
          <line
            key={i}
            className={styles.grid}
            x1={PAD.left}
            x2={PAD.left + PLOT_W}
            y1={y(t)}
            y2={y(t)}
          />
        ))}

        <path className={styles.areaNeg} d={d} clipPath={`url(#${clipNeg})`} />
        <path className={styles.areaPos} d={d} clipPath={`url(#${clipPos})`} />

        {/* The zero rule: the demurrage boundary itself. */}
        <line className={styles.zeroLine} x1={zeroX} x2={zeroX} y1={PAD.top} y2={base} />
        <text className={styles.zeroLabel} x={zeroX} y={PAD.top - 12} textAnchor="middle">
          break-even
        </text>

        {/* Annotation lines are DASHED on purpose — they are thresholds, which is
            exactly what dashing should mean. Gridlines above stay solid. */}
        {[
          { v: meanValue, label: "Expected", cls: styles.markMean },
          { v: p90Value, label: "P90", cls: styles.markP90 },
        ].map((m) => {
          const mx = x(m.v);
          // Keep the label inside the plot so it is never clipped at an edge.
          const anchor = mx > PAD.left + PLOT_W - 60 ? "end" : mx < PAD.left + 60 ? "start" : "middle";
          return (
            <g key={m.label}>
              <line className={m.cls} x1={mx} x2={mx} y1={PAD.top} y2={base} />
              <text className={styles.markLabel} x={mx} y={base + 32} textAnchor={anchor}>
                {m.label} {compactMoney(m.v, currency)}
              </text>
            </g>
          );
        })}

        {hover && (
          <>
            <line
              className={styles.crosshair}
              x1={hover.x}
              x2={hover.x}
              y1={PAD.top}
              y2={base}
            />
            <circle
              className={styles.hoverDot}
              cx={hover.x}
              cy={y(hover.bin.count / trials)}
              r={4.5}
            />
          </>
        )}

        {/* Axes */}
        <line className={styles.axis} x1={PAD.left} x2={PAD.left + PLOT_W} y1={base} y2={base} />
        {ticks.map((t, i) => (
          <text
            key={i}
            className={styles.tick}
            x={x(t)}
            y={base + 16}
            textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}
          >
            {compactMoney(t, currency)}
          </text>
        ))}
        {yTicks.map((t, i) => (
          <text key={i} className={styles.tick} x={PAD.left - 10} y={y(t) + 4} textAnchor="end">
            {(t * 100).toFixed(t === yTop && yTop < 0.1 ? 1 : 0)}%
          </text>
        ))}
        <text className={styles.axisTitle} x={PAD.left} y={H - 6}>
          Net position per voyage — left of break-even costs nothing
        </text>
      </svg>

      {hover && (
        <div className={styles.tooltip} style={{ left: `${(hover.x / W) * 100}%` }}>
          <strong>
            {fullMoney(hover.bin.from, currency)} to {fullMoney(hover.bin.to, currency)}
          </strong>
          <span>
            {((hover.bin.count / trials) * 100).toFixed(1)}% of voyages (
            {hover.bin.count.toLocaleString("en-US")})
          </span>
        </div>
      )}

      {showTable && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.tableCaption}>
              Simulated outcomes by band. Negative values are despatch earned.
            </caption>
            <thead>
              <tr>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col">Voyages</th>
                <th scope="col">Share</th>
              </tr>
            </thead>
            <tbody>
              {histogram.map((b, i) => (
                <tr key={i}>
                  <td className="tnum">{fullMoney(b.from, currency)}</td>
                  <td className="tnum">{fullMoney(b.to, currency)}</td>
                  <td className="tnum">{b.count.toLocaleString("en-US")}</td>
                  <td className="tnum">{((b.count / trials) * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
