"use client";

// Two portfolio outcome distributions on one pair of axes: the book as it
// actually behaves (correlated weather) against the book as a naive
// voyage-by-voyage model would price it (independent weather).
//
// THE POINT OF THE CHART is the gap between the two P90 markers. That shaded
// band IS the correlation uplift — the money a per-voyage model does not see —
// so it is drawn as a region rather than left for the reader to measure between
// two dashed lines.
//
// Both series are binned on a SHARED domain by the simulator. Without that,
// equal densities would sit at unequal heights and the comparison would be
// wrong; the geometry helper documents it as the caller's contract.
//
// Categorical blue/orange, validated against this app's own surfaces in both
// modes (CVD ΔE 24.7 light / 26.8 dark against a ≥8 target).

import { useId, useMemo, useState } from "react";
import {
  buildOverlayModel,
  CHART,
  MARKER_LABEL_ROW_HEIGHT,
  type HistogramBin,
} from "@/lib/risk/chart-model";
import styles from "./PortfolioOverlayChart.module.css";

interface Props {
  correlated: HistogramBin[];
  independent: HistogramBin[];
  trials: number;
  currency: string;
  correlatedP90: number;
  independentP90: number;
}

const W = CHART.width;
const H = CHART.height;
const PAD = CHART.pad;

function compact(v: number, currency: string): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${sign}${currency} ${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${currency} ${Math.round(abs / 1_000)}k`;
  return `${sign}${currency} ${Math.round(abs)}`;
}

function full(v: number, currency: string): string {
  return `${v < 0 ? "−" : ""}${currency} ${Math.abs(v).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  })}`;
}

export default function PortfolioOverlayChart({
  correlated,
  independent,
  trials,
  currency,
  correlatedP90,
  independentP90,
}: Props) {
  const uid = useId().replace(/:/g, "");
  const [hover, setHover] = useState<{ x: number; idx: number } | null>(null);
  const [showTable, setShowTable] = useState(false);

  const model = useMemo(
    () =>
      buildOverlayModel({
        series: [
          { key: "independent", histogram: independent },
          { key: "correlated", histogram: correlated },
        ],
        trials,
        markers: [
          { key: "indep", value: independentP90, label: "Independent P90" },
          { key: "corr", value: correlatedP90, label: "Correlated P90" },
        ],
      }),
    [correlated, independent, trials, correlatedP90, independentP90]
  );

  if (!model) {
    return <p className={styles.empty}>No distribution to plot.</p>;
  }

  const { x, y, base, paths, xTicks, yTicks, yTop, markers, upliftBand } = model;
  const indepMarker = markers.find((m) => m.key === "indep")!;
  const corrMarker = markers.find((m) => m.key === "corr")!;
  const uplift = correlatedP90 - independentP90;

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    if (svgX < PAD.left || svgX > W - PAD.right) {
      setHover(null);
      return;
    }
    const idx = correlated.findIndex((b) => svgX >= x(b.from) && svgX <= x(b.to));
    setHover(idx >= 0 ? { x: svgX, idx } : null);
  };

  const gradId = `uplift-${uid}`;

  return (
    <figure className={styles.figure}>
      <figcaption className={styles.caption}>
        <span className={styles.captionTitle}>
          Portfolio outcome across {trials.toLocaleString("en-US")} simulated quarters
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

      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.swatchCorr}`} aria-hidden="true" />
          Correlated — shared weather (the book as it behaves)
        </span>
        <span className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.swatchIndep}`} aria-hidden="true" />
          Independent — private weather (what a per-voyage model sees)
        </span>
      </div>

      <svg
        className={styles.svg}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={
          `Portfolio cost distribution over ${trials} simulated quarters. ` +
          `Correlated P90 ${full(correlatedP90, currency)} against independent P90 ` +
          `${full(independentP90, currency)}, a correlation uplift of ${full(uplift, currency)}.`
        }
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" className={styles.upliftStop0} />
            <stop offset="100%" className={styles.upliftStop1} />
          </linearGradient>
        </defs>

        {yTicks.map((t, i) => (
          <line
            key={i}
            className={styles.grid}
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(t)}
            y2={y(t)}
          />
        ))}

        {/* The uplift band: the money a per-voyage model cannot see. Drawn
            beneath the curves so it never obscures them. */}
        {upliftBand && upliftBand.toX > upliftBand.fromX && (
          <>
            <rect
              className={styles.upliftBand}
              x={upliftBand.fromX}
              y={PAD.top}
              width={upliftBand.toX - upliftBand.fromX}
              height={base - PAD.top}
              fill={`url(#${gradId})`}
            />
            <text
              className={styles.upliftLabel}
              x={(upliftBand.fromX + upliftBand.toX) / 2}
              y={PAD.top - 10}
              textAnchor="middle"
            >
              uplift {compact(uplift, currency)}
            </text>
          </>
        )}

        {/* Independent first, so the correlated curve reads as the foreground
            answer rather than one of two equal options. */}
        <path className={styles.areaIndep} d={paths.independent} />
        <path className={styles.areaCorr} d={paths.correlated} />

        {[
          { m: indepMarker, cls: styles.markIndep },
          { m: corrMarker, cls: styles.markCorr },
        ].map(({ m, cls }) => {
          const anchor =
            m.x > W - PAD.right - 60 ? "end" : m.x < PAD.left + 60 ? "start" : "middle";
          return (
            <g key={m.key}>
              <line className={cls} x1={m.x} x2={m.x} y1={PAD.top} y2={base} />
              <text
                className={styles.markLabel}
                x={m.x}
                y={base + 32 + m.row * MARKER_LABEL_ROW_HEIGHT}
                textAnchor={anchor}
              >
                {m.label} {compact(m.value, currency)}
              </text>
            </g>
          );
        })}

        {hover && (
          <line className={styles.crosshair} x1={hover.x} x2={hover.x} y1={PAD.top} y2={base} />
        )}

        <line className={styles.axis} x1={PAD.left} x2={W - PAD.right} y1={base} y2={base} />
        {xTicks.map((t, i) => (
          <text
            key={i}
            className={styles.tick}
            x={x(t)}
            y={base + 16}
            textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
          >
            {compact(t, currency)}
          </text>
        ))}
        {yTicks.map((t, i) => (
          <text key={i} className={styles.tick} x={PAD.left - 10} y={y(t) + 4} textAnchor="end">
            {(t * 100).toFixed(yTop < 0.1 ? 1 : 0)}%
          </text>
        ))}
        <text
          className={styles.axisTitle}
          x={PAD.left}
          y={H - 6 + Math.max(0, ...markers.map((m) => m.row)) * MARKER_LABEL_ROW_HEIGHT}
        >
          Total demurrage cost across the book, per simulated quarter
        </text>
      </svg>

      {hover && correlated[hover.idx] && (
        <div className={styles.tooltip} style={{ left: `${(hover.x / W) * 100}%` }}>
          <strong>
            {full(correlated[hover.idx].from, currency)} –{" "}
            {full(correlated[hover.idx].to, currency)}
          </strong>
          <span className={styles.tipCorr}>
            Correlated {((correlated[hover.idx].count / trials) * 100).toFixed(1)}%
          </span>
          <span className={styles.tipIndep}>
            Independent{" "}
            {(((independent[hover.idx]?.count ?? 0) / trials) * 100).toFixed(1)}%
          </span>
        </div>
      )}

      {showTable && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.tableCaption}>
              Share of simulated quarters falling in each cost band.
            </caption>
            <thead>
              <tr>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col">Correlated</th>
                <th scope="col">Independent</th>
              </tr>
            </thead>
            <tbody>
              {correlated.map((b, i) => (
                <tr key={i}>
                  <td className="tnum">{full(b.from, currency)}</td>
                  <td className="tnum">{full(b.to, currency)}</td>
                  <td className="tnum">{((b.count / trials) * 100).toFixed(1)}%</td>
                  <td className="tnum">
                    {(((independent[i]?.count ?? 0) / trials) * 100).toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
