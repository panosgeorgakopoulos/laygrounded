// The vessel's position track, as plain SVG.
//
// No tile layer and no mapping library, matching `ais-verification-map.tsx`:
// the question a counterparty is asking here is "did she move when the
// Statement of Facts says she moved", which is shape and time, not geography.
// It also keeps the page self-contained — a shared statement that fetched tiles
// from a third party would leak the fact that this claim is being read, and to
// whom, on every open.
//
// A server component: the data is already resolved and nothing here is
// interactive, so there is no reason to ship it as client JavaScript.

import styles from "./Statement.module.css";

interface Position {
  timestamp: string;
  lat: number;
  lon: number;
}

/** Gaps longer than this are drawn dashed — a silent feed is not a stationary vessel. */
const GAP_HOURS = 6;

const W = 720;
const H = 300;
const PAD = 28;

export function StatementTrack({
  track,
  portLat,
  portLon,
}: {
  track: Position[];
  portLat: number | null;
  portLon: number | null;
}) {
  const lats = track.map((p) => p.lat);
  const lons = track.map((p) => p.lon);
  if (portLat !== null && portLon !== null) {
    lats.push(portLat);
    lons.push(portLon);
  }

  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);

  // A vessel at anchor barely moves, and dividing by a near-zero span would
  // magnify GPS jitter into a scribble that looks like frantic manoeuvring.
  // The floor keeps a stationary vessel looking stationary.
  const spanLat = Math.max(maxLat - minLat, 0.01);
  const spanLon = Math.max(maxLon - minLon, 0.01);

  const x = (lon: number) => PAD + ((lon - minLon) / spanLon) * (W - PAD * 2);
  // Latitude increases northward, SVG y increases downward.
  const y = (lat: number) => H - PAD - ((lat - minLat) / spanLat) * (H - PAD * 2);

  const segments: Array<{ d: string; gap: boolean }> = [];
  for (let i = 1; i < track.length; i++) {
    const prev = track[i - 1];
    const cur = track[i];
    const hours =
      (new Date(cur.timestamp).getTime() - new Date(prev.timestamp).getTime()) / 3_600_000;
    segments.push({
      d: `M ${x(prev.lon)} ${y(prev.lat)} L ${x(cur.lon)} ${y(cur.lat)}`,
      gap: !Number.isFinite(hours) || hours > GAP_HOURS,
    });
  }

  const hasGap = segments.some((s) => s.gap);
  const first = track[0];
  const last = track[track.length - 1];

  return (
    <figure className={styles.trackFigure}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={styles.trackSvg}
        role="img"
        aria-label={`Vessel position track, ${track.length} fixes between ${first.timestamp} and ${last.timestamp}`}
      >
        {segments.map((seg, i) => (
          <path
            key={i}
            d={seg.d}
            className={seg.gap ? styles.trackGap : styles.trackLine}
            fill="none"
          />
        ))}

        {portLat !== null && portLon !== null && (
          <g>
            <circle cx={x(portLon)} cy={y(portLat)} r={6} className={styles.portMarker} />
            <text x={x(portLon) + 10} y={y(portLat) + 4} className={styles.trackLabel}>
              Port
            </text>
          </g>
        )}

        <circle cx={x(first.lon)} cy={y(first.lat)} r={4} className={styles.trackStart} />
        <circle cx={x(last.lon)} cy={y(last.lat)} r={4} className={styles.trackEnd} />
      </svg>

      <figcaption className={styles.trackCaption}>
        {track.length.toLocaleString("en-US")} AIS fixes from{" "}
        <span className="tnum">{first.timestamp.slice(0, 16).replace("T", " ")}Z</span> to{" "}
        <span className="tnum">{last.timestamp.slice(0, 16).replace("T", " ")}Z</span>.
        {hasGap && (
          <>
            {" "}
            Dashed segments span more than {GAP_HOURS} hours between fixes —{" "}
            <strong>a gap in the AIS feed is not evidence the vessel was stationary.</strong>
          </>
        )}
      </figcaption>
    </figure>
  );
}
