// The bridge from an ERP schedule to the pre-arrival risk simulator.
//
// Pure, and shared by BOTH ends of the link: the Fleet Schedules page builds the
// query string with `buildPreArrivalQuery`, and the simulator reads it with
// `readPreArrivalPrefill`. Two hand-written copies of the same parameter names
// would drift the first time one side added a field, and the failure is silent —
// a prefill that simply stops arriving looks like a user who did not click the
// button.
//
// WHAT IS DELIBERATELY NOT PREFILLED
//
// An ERP schedule carries a plan: who, where, when, what cargo. It does NOT
// carry charterparty terms. Laytime allowance, days basis, demurrage and
// despatch rates and the expected operation duration are all absent from
// `erp_vessel_schedules`, and each is an input the risk figure is highly
// sensitive to.
//
// So they are left at the simulator's defaults and the page says so. Carrying a
// plausible-looking default across the bridge would produce an exposure number
// that LOOKS derived from the ERP and is not — the same failure the provenance
// discipline exists to prevent everywhere else in this codebase.

export interface PreArrivalPrefill {
  vessel: string | null;
  voyageRef: string | null;
  port: string | null;
  cargo: string | null;
  /** ISO instant. Converted to the input's local-time format by the caller. */
  etaISO: string | null;
  operation: "loading" | "discharge" | null;
  /** Carried for display only — the simulator has no quantity input. */
  cargoQuantityMt: number | null;
  /** The originating schedule, so the simulator can say where its inputs came from. */
  scheduleRef: string | null;
}

export interface SchedulePrefillSource {
  vessel: string;
  voyageRef?: string | null;
  port: string;
  cargo?: string | null;
  eta?: string | null;
  portFunction?: string | null;
  cargoQuantityMt?: number | null;
  externalRef?: string | null;
}

/**
 * Maps the ERP's port function onto the simulator's operation.
 *
 * `bunker`, `transit` and `unknown` map to NULL rather than to a guess. A
 * bunker call is not a cargo operation, and defaulting it to "loading" would
 * silently model the wrong thing.
 */
export function operationFromPortFunction(
  portFunction: string | null | undefined
): "loading" | "discharge" | null {
  if (portFunction === "load") return "loading";
  if (portFunction === "discharge") return "discharge";
  return null;
}

const PARAM = {
  vessel: "vessel",
  voyageRef: "voyageRef",
  port: "port",
  cargo: "cargo",
  eta: "eta",
  operation: "operation",
  quantity: "qtyMt",
  scheduleRef: "scheduleRef",
} as const;

/** Builds the query string for `/simulator/pre-arrival`. Empty fields are omitted. */
export function buildPreArrivalQuery(schedule: SchedulePrefillSource): string {
  const p = new URLSearchParams();
  const set = (key: string, value: string | null | undefined) => {
    if (value && value.trim()) p.set(key, value.trim());
  };

  set(PARAM.vessel, schedule.vessel);
  set(PARAM.voyageRef, schedule.voyageRef);
  set(PARAM.port, schedule.port);
  set(PARAM.cargo, schedule.cargo);
  set(PARAM.eta, schedule.eta);
  set(PARAM.scheduleRef, schedule.externalRef);

  const operation = operationFromPortFunction(schedule.portFunction);
  if (operation) p.set(PARAM.operation, operation);

  if (typeof schedule.cargoQuantityMt === "number" && Number.isFinite(schedule.cargoQuantityMt)) {
    p.set(PARAM.quantity, String(schedule.cargoQuantityMt));
  }

  return p.toString();
}

/**
 * Reads a prefill back out of a query string.
 *
 * Every field is independently optional and independently validated: a bad ETA
 * must not discard a good vessel name. The user came from a button click and
 * should get whatever of their data survived, with the rest left at defaults.
 */
export function readPreArrivalPrefill(params: URLSearchParams): PreArrivalPrefill {
  const str = (key: string): string | null => {
    const v = params.get(key);
    return v && v.trim() ? v.trim() : null;
  };

  const rawEta = str(PARAM.eta);
  const etaISO = rawEta && !Number.isNaN(new Date(rawEta).getTime())
    ? new Date(rawEta).toISOString()
    : null;

  const rawOp = str(PARAM.operation);
  const operation = rawOp === "loading" || rawOp === "discharge" ? rawOp : null;

  const rawQty = str(PARAM.quantity);
  const qty = rawQty !== null ? Number(rawQty) : null;

  return {
    vessel: str(PARAM.vessel),
    voyageRef: str(PARAM.voyageRef),
    port: str(PARAM.port),
    cargo: str(PARAM.cargo),
    etaISO,
    operation,
    cargoQuantityMt: qty !== null && Number.isFinite(qty) && qty > 0 ? qty : null,
    scheduleRef: str(PARAM.scheduleRef),
  };
}

/** True when the query carried anything at all — used to show the provenance banner. */
export function hasPrefill(p: PreArrivalPrefill): boolean {
  return Boolean(p.vessel || p.port || p.cargo || p.etaISO || p.voyageRef);
}

/**
 * ISO instant → the `datetime-local` input format, in the BROWSER's timezone.
 *
 * Matches how the page's own default ETA is built and how it reads the value
 * back (`new Date(eta).toISOString()` parses a bare datetime-local string as
 * local time). Formatting the instant as UTC here instead would shift every
 * prefilled ETA by the viewer's offset — silently, and by exactly the amount
 * that makes a lead time wrong.
 */
export function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
