// The hybrid horizon model: how much of the weather picture is forecast, and
// how much is climate.
//
// An ensemble forecast has real skill for about a week and decays to no better
// than climatology somewhere around two. Beyond the model's own horizon there
// is simply no forecast to have. So the risk engine draws from ensemble members
// when they are informative and from historical years when they are not.
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO:
//
// 1. It does not switch at a cliff. A step change at exactly 14 days would make
//    a vessel's P90 jump discontinuously as it approaches — the same voyage,
//    materially different published exposure, one day apart. Nobody can defend
//    that to a charterer. The weight decays smoothly with zero slope at both
//    ends, so the number drifts rather than snaps.
//
// 2. It does not AVERAGE a forecast trajectory with a historical one. Blending
//    two weather series arithmetically destroys exactly the property that makes
//    this simulation sound: a mean of two storms is a drizzle, autocorrelation
//    collapses, and the variance shrinks toward zero. The weight is a MIXTURE
//    PROBABILITY — each trial draws one whole, physically-consistent trajectory
//    from one pool or the other.
//
// Pure.

/** Ensemble members are fetched to here; beyond it there is no forecast at all. */
export const ENSEMBLE_HORIZON_HOURS = 336; // 14 days

/**
 * Inside this lead time the ensemble is taken at full weight.
 *
 * Seven days is the conventional edge of useful synoptic skill for the surface
 * variables that stop cargo work (precipitation, wind, gusts). It is a
 * judgement, and it is stated here as one number so it can be argued with.
 */
export const FULL_SKILL_HOURS = 168; // 7 days

/**
 * Share of trials that should draw from the ensemble pool, given lead time.
 *
 * Smoothstep between full skill and the ensemble horizon: 1 at or before 7
 * days, 0 at or after 14, with a continuous first derivative at both ends so
 * there is no kink to explain.
 */
export function ensembleWeight(
  leadTimeHours: number,
  fullSkillHours: number = FULL_SKILL_HOURS,
  horizonHours: number = ENSEMBLE_HORIZON_HOURS
): number {
  if (leadTimeHours <= fullSkillHours) return 1;
  if (leadTimeHours >= horizonHours) return 0;

  const t = (leadTimeHours - fullSkillHours) / (horizonHours - fullSkillHours);
  // 3t² − 2t³ rises 0→1; we want the ensemble share to fall, hence 1 − that.
  return 1 - (3 * t * t - 2 * t * t * t);
}

export type HorizonMode = "ensemble" | "blended" | "climatology";

export function horizonMode(leadTimeHours: number): HorizonMode {
  const w = ensembleWeight(leadTimeHours);
  if (w >= 1) return "ensemble";
  if (w <= 0) return "climatology";
  return "blended";
}

/** Lead time from now to ETA, in hours. Negative when the ETA has passed. */
export function leadTimeHours(nowISO: string, etaISO: string): number {
  return (new Date(etaISO).getTime() - new Date(nowISO).getTime()) / 3_600_000;
}

export function describeHorizon(leadTimeHours: number): string {
  const w = ensembleWeight(leadTimeHours);
  const days = (leadTimeHours / 24).toFixed(1);
  if (w >= 1) {
    return `ETA in ${days} days: inside ensemble skill, every trial draws a forecast member.`;
  }
  if (w <= 0) {
    return `ETA in ${days} days: beyond the ensemble horizon, every trial draws a historical year.`;
  }
  return (
    `ETA in ${days} days: ${Math.round(w * 100)}% of trials draw a forecast member and ` +
    `${Math.round((1 - w) * 100)}% draw a historical year, weighted by declining forecast skill.`
  );
}
