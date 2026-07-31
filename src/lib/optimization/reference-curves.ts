// Reference fuel-consumption curves by vessel class.
//
// The eco-speed optimiser refuses to run without a consumption curve, and that
// refusal is correct: fuel burn is hull-specific, and a curve invented for a
// ship produces a confident speed instruction that ship will not obey.
//
// But refusing outright makes the tool unusable for anyone who has not yet
// loaded their fleet's curves, which is everyone on day one. So these exist as
// an explicitly-labelled middle path — the same shape as the mock AIS feed:
// usable, clearly not measurement, and structurally unable to pass as it.
// A plan built on one of these is never decision-grade.
//
// The figures are order-of-magnitude typicals for the class at design draught
// in good weather, from published IMO Fourth GHG Study fleet averages. They are
// NOT a substitute for a vessel's own noon reports.
//
// Pure.

import type { ConsumptionCurve } from "@/lib/compliance/carbon";

export type VesselClass = "handysize" | "supramax" | "panamax" | "capesize";

export interface ReferenceCurve {
  vesselClass: VesselClass;
  label: string;
  curve: ConsumptionCurve;
  sourceLabel: string;
}

/**
 * Curves rise roughly with the cube of speed, as the admiralty relation
 * implies, so the optimiser's trade-off between speed and burn behaves
 * realistically even though the absolute numbers are generic.
 */
export const REFERENCE_CURVES: Record<VesselClass, ReferenceCurve> = {
  handysize: {
    vesselClass: "handysize",
    label: "Handysize (~30,000 dwt)",
    curve: {
      sea_curve: [
        { speed_knots: 9, tonnes_per_day: 9 },
        { speed_knots: 11, tonnes_per_day: 13 },
        { speed_knots: 13, tonnes_per_day: 19 },
        { speed_knots: 14.5, tonnes_per_day: 25 },
      ],
      at_berth_aux_tonnes_per_day: 2.5,
    } as ConsumptionCurve,
    sourceLabel: "LayGrounded generic handysize reference — not this vessel",
  },
  supramax: {
    vesselClass: "supramax",
    label: "Supramax / Ultramax (~58,000 dwt)",
    curve: {
      sea_curve: [
        { speed_knots: 9, tonnes_per_day: 12 },
        { speed_knots: 11, tonnes_per_day: 18 },
        { speed_knots: 13, tonnes_per_day: 26 },
        { speed_knots: 14.5, tonnes_per_day: 34 },
      ],
      at_berth_aux_tonnes_per_day: 4,
    } as ConsumptionCurve,
    sourceLabel: "LayGrounded generic supramax reference — not this vessel",
  },
  panamax: {
    vesselClass: "panamax",
    label: "Panamax / Kamsarmax (~82,000 dwt)",
    curve: {
      sea_curve: [
        { speed_knots: 9, tonnes_per_day: 15 },
        { speed_knots: 11, tonnes_per_day: 22 },
        { speed_knots: 13, tonnes_per_day: 32 },
        { speed_knots: 14.5, tonnes_per_day: 42 },
      ],
      at_berth_aux_tonnes_per_day: 5,
    } as ConsumptionCurve,
    sourceLabel: "LayGrounded generic panamax reference — not this vessel",
  },
  capesize: {
    vesselClass: "capesize",
    label: "Capesize (~180,000 dwt)",
    curve: {
      sea_curve: [
        { speed_knots: 9, tonnes_per_day: 24 },
        { speed_knots: 11, tonnes_per_day: 36 },
        { speed_knots: 13, tonnes_per_day: 52 },
        { speed_knots: 14.5, tonnes_per_day: 68 },
      ],
      at_berth_aux_tonnes_per_day: 7,
    } as ConsumptionCurve,
    sourceLabel: "LayGrounded generic capesize reference — not this vessel",
  },
};

export const VESSEL_CLASSES = Object.keys(REFERENCE_CURVES) as VesselClass[];

export function referenceCurve(vesselClass: VesselClass): ReferenceCurve {
  return REFERENCE_CURVES[vesselClass];
}
