// LayGrounded shared laytime types — exact spec.

export type EventTypeEnum =
  | "NOR_TENDERED"
  | "ALL_FAST"
  | "HATCH_OPEN"
  | "HATCH_CLOSE"
  | "COMMENCED_LOADING"
  | "COMPLETED_LOADING"
  | "COMMENCED_DISCHARGE"
  | "COMPLETED_DISCHARGE"
  | "WEATHER_DELAY"
  | "SHIFTING"
  | "BERTHED"
  | "EXCEPTED_PERIOD_START"
  | "EXCEPTED_PERIOD_END";

export type NorVariant = "WIBON" | "WIPON" | "WICCON" | "WIFPON";
export type DaysBasis = "SHINC" | "SHEX" | "SHEX-UU" | "WWDSHEX-EIU" | "SSHEX" | "SSHEX-UU" | "WWDSSHEX-EIU";

export interface CpTerms {
  laytime_allowed_hours: number;
  load_rate?: number;
  discharge_rate?: number;
  turn_time_hours: number;
  nor_variant: NorVariant;
  days_basis: DaysBasis;
  demurrage_rate: number; // per day
  despatch_rate: number; // per day
  currency: string; // ISO 4217
  port_timezone?: string; // IANA timezone, e.g. "Asia/Singapore"
}

export interface SofEventInput {
  id: string;
  occurred_at: string; // ISO 8601
  event_type: EventTypeEnum;
}

export type BreakdownStatus =
  | "laytime"
  | "demurrage"
  | "excepted"
  | "weather_delay"
  | "shifting";

export interface BreakdownRow {
  start_time: string;
  end_time: string;
  duration_hours: number;
  status: BreakdownStatus;
  counts: boolean;
  clause_ref: string;
  reasoning: string;
}

export interface CalculationTotals {
  allowed_hours: number;
  used_hours: number;
  time_on_demurrage_hours: number;
  time_saved_hours: number;
  demurrage_amount: number;
  despatch_amount: number;
  currency: string;
}

export interface LaytimeResult {
  breakdown: BreakdownRow[];
  totals: CalculationTotals;
}

// === Helper: enum value lists ===
export const EVENT_TYPE_VALUES: EventTypeEnum[] = [
  "NOR_TENDERED",
  "ALL_FAST",
  "HATCH_OPEN",
  "HATCH_CLOSE",
  "COMMENCED_LOADING",
  "COMPLETED_LOADING",
  "COMMENCED_DISCHARGE",
  "COMPLETED_DISCHARGE",
  "WEATHER_DELAY",
  "SHIFTING",
  "BERTHED",
  "EXCEPTED_PERIOD_START",
  "EXCEPTED_PERIOD_END",
];

export const NOR_VARIANTS: NorVariant[] = ["WIBON", "WIPON", "WICCON", "WIFPON"];
export const DAYS_BASES: DaysBasis[] = ["SHINC", "SHEX", "SHEX-UU", "WWDSHEX-EIU", "SSHEX", "SSHEX-UU", "WWDSSHEX-EIU"];

// === Default CP terms for new claims ===
export const DEFAULT_CP_TERMS: CpTerms = {
  laytime_allowed_hours: 72,
  load_rate: 5000,
  discharge_rate: 4000,
  turn_time_hours: 6,
  nor_variant: "WIBON",
  days_basis: "SHINC",
  demurrage_rate: 25000,
  despatch_rate: 12500,
  currency: "USD",
};
