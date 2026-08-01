"use client";

// Where the Master's Statement of Facts meets the satellite record.
//
// Plots the vessel's AIS track and marks each confirmed SoF event with the
// motion verdict already derived for it, so an operator can see at a glance
// where the two disagree.
//
// PLAIN SVG, NO TILE LAYER, ON PURPOSE. A basemap would need a remote tile
// host, and the question this view answers is not "where in the world" — it is
// "did she move when the SoF says she moved". That is a shape-and-time
// question, and the shape is the track itself. It also keeps the component
// self-contained, which is what lets it render inside an exported claim pack.
//
// ABSENT DATA IS NOT AN ERROR STATE. No provider configured, no coverage, or a
// timeline too short to bound a request are three different answers and each
// says which one it is. A map that drew nothing and said nothing would imply
// the vessel was missing from a feed nobody queried.

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, Satellite, ShieldAlert, ShieldCheck } from "lucide-react";
import styles from "./AisVerificationMap.module.css";

interface Fix {
  at: string;
  lat: number;
  lon: number;
}

interface Segment {
  from: string;
  to: string;
  hours: number;
  distanceM: number;
  speedKn: number;
  state: "moored" | "shifting" | "underway" | "unknown";
  isGap: boolean;
}

interface TimelineEvent {
  id: string;
  event_type: string;
  occurred_at: string;
  motion: {
    checkType: string;
    verdict: string;
    summary: string;
  } | null;
}

interface TrackView {
  available: boolean;
  reason?: string;
  providerConfigured?: boolean;
  /** True when the track is a dev fixture rather than a provider's record. */
  synthetic?: boolean;
  vessel: string;
  window?: { from: string; to: string };
  port: { name: string; lat: number | null; lon: number | null };
  track: Fix[];
  segments: Segment[];
  events: TimelineEvent[];
  counts?: { fixes: number; gaps: number; contradicted: number; corroborated: number };
}

const STATE_CLASS: Record<Segment["state"], string> = {
  moored: styles.moored,
  shifting: styles.shifting,
  underway: styles.underway,
  unknown: styles.unknownState,
};

const VIEW = { w: 640, h: 340, pad: 26 };

/**
 * Equirectangular projection, scaled to the track's own bounds.
 *
 * Longitude is scaled by cos(latitude) so a degree of longitude is not drawn as
 * long as a degree of latitude — without it a berth shift at Port Hedland looks
 * like it ran east for miles. Adequate at port scale, which is the only scale
 * this view is ever asked to draw.
 */
function useProjection(track: Fix[]) {
  return useMemo(() => {
    if (track.length === 0) return null;
    const lats = track.map((f) => f.lat);
    const lons = track.map((f) => f.lon);
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const kx = Math.cos((midLat * Math.PI) / 180) || 1;

    const xs = lons.map((l) => l * kx);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...lats);
    const maxY = Math.max(...lats);

    // A vessel that never moved has zero extent; a floor keeps the divide safe
    // and draws her as a point rather than filling the frame with noise.
    const spanX = Math.max(maxX - minX, 1e-6);
    const spanY = Math.max(maxY - minY, 1e-6);
    const scale = Math.min(
      (VIEW.w - VIEW.pad * 2) / spanX,
      (VIEW.h - VIEW.pad * 2) / spanY
    );

    const offX = (VIEW.w - spanX * scale) / 2;
    const offY = (VIEW.h - spanY * scale) / 2;

    return {
      project(lat: number, lon: number): [number, number] {
        const x = offX + (lon * kx - minX) * scale;
        // SVG y grows downward; latitude grows north. Flip, or the track is
        // drawn upside down and a northward shift reads as southward.
        const y = VIEW.h - (offY + (lat - minY) * scale);
        return [x, y];
      },
      metresPerPx: (111_320 * spanY) / (spanY * scale) / 1,
    };
  }, [track]);
}

export function AisVerificationMap({ claimId }: { claimId: string }) {
  const [view, setView] = useState<TrackView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetch(`/api/claims/${claimId}/ais-track`).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      setView(d as TrackView);
      setError(null);
    } catch {
      setError("Could not load the AIS track for this claim.");
    } finally {
      setLoading(false);
    }
  }, [claimId]);

  useEffect(() => {
    void load();
  }, [load]);

  const projection = useProjection(view?.track ?? []);

  // Where each event falls on the track, by nearest fix in time. Only drawn
  // when a fix is close enough to actually be that event's position.
  const eventMarkers = useMemo(() => {
    if (!view || !projection || view.track.length === 0) return [];
    return view.events
      .map((e) => {
        const t = Date.parse(e.occurred_at);
        let best: Fix | null = null;
        let bestGap = Infinity;
        for (const f of view.track) {
          const gap = Math.abs(Date.parse(f.at) - t);
          if (gap < bestGap) {
            bestGap = gap;
            best = f;
          }
        }
        // Two hours. Beyond that the nearest fix is not where she was when the
        // event happened, and pinning a marker there would place an event at a
        // position the track does not support.
        if (!best || bestGap > 2 * 3_600_000) return null;
        const [x, y] = projection.project(best.lat, best.lon);
        return { event: e, x, y, gapMinutes: Math.round(bestGap / 60_000) };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);
  }, [view, projection]);

  if (loading) {
    return (
      <div className={styles.wrap}>
        <p className={styles.loading}>
          <Loader2 size={13} className={styles.spin} /> Loading AIS track…
        </p>
      </div>
    );
  }
  if (!view) {
    return (
      <div className={styles.wrap}>
        <p className={styles.error}>
          <AlertCircle size={14} /> {error ?? "Unavailable."}
        </p>
      </div>
    );
  }

  const contradicted = view.events.filter((e) => e.motion?.verdict === "contradicted");

  return (
    <div className={styles.wrap}>
      <header className={styles.head}>
        <h3 className={styles.title}>
          <Satellite size={15} /> AIS verification
        </h3>
        {view.counts && (
          <div className={styles.counts}>
            {view.synthetic && <span className={styles.syntheticChip}>synthetic</span>}
            <span className={styles.okChip}>
              <ShieldCheck size={12} /> {view.counts.corroborated} corroborated
            </span>
            <span className={view.counts.contradicted > 0 ? styles.badChip : styles.mutedChip}>
              <ShieldAlert size={12} /> {view.counts.contradicted} contradicted
            </span>
            <span className={styles.mutedChip}>{view.counts.fixes} fixes</span>
          </div>
        )}
      </header>

      <p className={styles.intro}>
        The vessel&apos;s own position record, beside what the Statement of Facts says she was
        doing. A <strong>contradiction</strong> is where the track says she moved while the SoF
        claims cargo work, or sat still while it claims shifting.
      </p>

      {view.synthetic && (
        <p className={styles.syntheticWarn}>
          <AlertCircle size={14} />
          <span>
            <strong>Synthetic track — not evidence.</strong> No AIS provider is configured, so this
            is a generated fixture for checking that the map draws correctly. The verdicts below are
            computed from it in memory and are <strong>never stored</strong> against this claim.
            Nothing here may be relied on, quoted, or served to a counterparty.
          </span>
        </p>
      )}

      {!view.available ? (
        <div className={styles.unavailable}>
          <AlertCircle size={15} />
          <div>
            <strong>No track to plot.</strong>
            <p>{view.reason}</p>
            {view.providerConfigured === false && (
              <p className={styles.hint}>
                Set <code>AIS_PROVIDER_URL</code> and <code>AIS_PROVIDER_KEY</code> to enable
                spatial verification. Until then every motion check reports{" "}
                <em>unavailable</em> rather than guessing — an unverified event is not a
                contradicted one.
              </p>
            )}
          </div>
        </div>
      ) : (
        <>
          <svg
            className={styles.map}
            viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
            // Letterbox rather than stretch: this is a verification tool, and a
            // distorted projection would make a berth shift look like a run to
            // sea. True geometry, fitted to whatever box it is given.
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={`AIS track for ${view.vessel} with ${view.events.length} statement-of-facts events overlaid`}
          >
            {/* Segments, coloured by derived motion state. */}
            {projection &&
              view.segments.map((s, i) => {
                const a = view.track.find((f) => f.at === s.from);
                const b = view.track.find((f) => f.at === s.to);
                if (!a || !b) return null;
                const [x1, y1] = projection.project(a.lat, a.lon);
                const [x2, y2] = projection.project(b.lat, b.lon);
                return (
                  <line
                    key={i}
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    className={`${styles.segment} ${STATE_CLASS[s.state]}`}
                    // A gap is drawn dashed: the fixes bounding it are too far
                    // apart to observe what happened between them, and a solid
                    // line would assert a straight course nobody recorded.
                    strokeDasharray={s.isGap ? "4 4" : undefined}
                  >
                    <title>
                      {s.state}
                      {s.isGap ? " (gap — unobserved)" : ""} · {s.hours.toFixed(1)}h ·{" "}
                      {Math.round(s.distanceM)}m · {s.speedKn.toFixed(1)}kn
                    </title>
                  </line>
                );
              })}

            {/* Fixes, faint, so the track's sampling density is visible. */}
            {projection &&
              view.track.map((f, i) => {
                const [x, y] = projection.project(f.lat, f.lon);
                return <circle key={i} cx={x} cy={y} r={1.5} className={styles.fix} />;
              })}

            {/* Events. Contradictions drawn last so they are never occluded. */}
            {[...eventMarkers]
              .sort((a, b) =>
                (a.event.motion?.verdict === "contradicted" ? 1 : 0) -
                (b.event.motion?.verdict === "contradicted" ? 1 : 0)
              )
              .map((m) => {
                const verdict = m.event.motion?.verdict;
                const cls =
                  verdict === "contradicted"
                    ? styles.markerBad
                    : verdict === "corroborated"
                      ? styles.markerOk
                      : styles.markerUnknown;
                return (
                  <g
                    key={m.event.id}
                    onMouseEnter={() => setHovered(m.event.id)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <circle
                      cx={m.x}
                      cy={m.y}
                      r={hovered === m.event.id ? 8 : 6}
                      className={`${styles.marker} ${cls}`}
                    />
                    <title>
                      {m.event.event_type.replace(/_/g, " ")} ·{" "}
                      {new Date(m.event.occurred_at).toISOString().slice(0, 16).replace("T", " ")}Z
                      {m.event.motion ? ` · ${m.event.motion.verdict}` : " · not checked"}
                      {m.gapMinutes > 15 ? ` (nearest fix ${m.gapMinutes}m away)` : ""}
                    </title>
                  </g>
                );
              })}
          </svg>

          <div className={styles.legend}>
            <span>
              <i className={`${styles.swatch} ${styles.moored}`} /> moored
            </span>
            <span>
              <i className={`${styles.swatch} ${styles.shifting}`} /> shifting
            </span>
            <span>
              <i className={`${styles.swatch} ${styles.underway}`} /> under way
            </span>
            <span>
              <i className={`${styles.swatch} ${styles.unknownState}`} /> unobserved gap
            </span>
          </div>

          <p className={styles.scaleNote}>
            Drawn to true scale. A run from the anchorage dwarfs the metres a moored vessel drifts,
            so the anchor and berth phases compress to points — that is the geometry, not a
            rendering fault. Per-event detail is in the list below; the segment colours carry the
            finding at any zoom.
          </p>

          {view.counts && view.counts.gaps > 0 && (
            <p className={styles.gapNote}>
              {view.counts.gaps} segment{view.counts.gaps === 1 ? " spans" : "s span"} fixes too far
              apart to observe. Those are drawn dashed and classified <em>unknown</em> — a gap in the feed
              is not evidence the vessel sat still.
            </p>
          )}
        </>
      )}

      {/* The timeline, always shown — the verdicts exist even with no track. */}
      <ul className={styles.timeline}>
        {view.events.map((e) => {
          const verdict = e.motion?.verdict;
          return (
            <li
              key={e.id}
              className={`${styles.row} ${hovered === e.id ? styles.rowHover : ""}`}
              onMouseEnter={() => setHovered(e.id)}
              onMouseLeave={() => setHovered(null)}
            >
              <span className={`${styles.dot} ${
                verdict === "contradicted"
                  ? styles.markerBad
                  : verdict === "corroborated"
                    ? styles.markerOk
                    : styles.markerUnknown
              }`} />
              <span className={styles.evType}>{e.event_type.replace(/_/g, " ")}</span>
              <span className={`${styles.evTime} tnum`}>
                {new Date(e.occurred_at).toISOString().slice(0, 16).replace("T", " ")}Z
              </span>
              <span className={styles.evVerdict}>
                {e.motion ? (
                  <>
                    <strong
                      className={
                        verdict === "contradicted"
                          ? styles.bad
                          : verdict === "corroborated"
                            ? styles.ok
                            : styles.muted
                      }
                    >
                      {verdict}
                    </strong>{" "}
                    <span className={styles.muted}>{e.motion.summary}</span>
                  </>
                ) : (
                  <span className={styles.muted}>no motion check for this event type</span>
                )}
              </span>
            </li>
          );
        })}
        {view.events.length === 0 && (
          <li className={styles.empty}>No confirmed events on this claim yet.</li>
        )}
      </ul>

      {contradicted.length > 0 && (
        <p className={styles.contradictionNote}>
          <ShieldAlert size={14} /> {contradicted.length} event
          {contradicted.length === 1 ? "" : "s"} contradicted by the position record. These are the
          ones a counterparty will find, so they are worth resolving before the claim is served.
        </p>
      )}
    </div>
  );
}
