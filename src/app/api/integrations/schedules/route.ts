// Forward vessel schedules pulled from an ERP.
//
// READ ONLY, and that is the schema's rule rather than this route's caution:
// `erp_vessel_schedules` has a SELECT policy and no INSERT/UPDATE/DELETE policy
// at all. The only writer is the sync worker running as service_role, because a
// schedule is ERP-owned data and a user editing it would silently diverge from
// the source system.
//
// A schedule is a PLAN, not a fact. It is deliberately not a claim, and nothing
// here promotes one — turning an ETA into a claim would fill a customer's book
// with port calls that have not happened.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";
import { PROVIDERS } from "@/lib/integrations/registry";

export interface ScheduleView {
  id: string;
  vessel: string;
  vesselImo: string | null;
  voyageRef: string;
  port: string;
  portFunction: "load" | "discharge" | "bunker" | "transit" | "unknown";
  eta: string | null;
  etb: string | null;
  etd: string | null;
  laycanFrom: string | null;
  laycanTo: string | null;
  cargo: string | null;
  cargoQuantityMt: number | null;
  sourceUpdatedAt: string | null;
  externalRef: string;
  source: {
    provider: string;
    displayName: string;
    /** `mock` means fixtures. Carried to the UI so a plan from a fixture is never mistaken for one from a live ERP. */
    mode: "live" | "mock";
    /** Whether the field mapping follows PUBLISHED vendor documentation. Not "live-tested". */
    mappingVerified: boolean;
  };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const url = new URL(req.url);
    // Past port calls are filtered out by default: a schedule is a forward plan,
    // and a list that leads with last month's calls buries the ones a user can
    // still act on. `?window=all` is there for auditing what was pulled.
    const showAll = url.searchParams.get("window") === "all";

    let query = supabase
      .from("erp_vessel_schedules")
      .select(
        "id, vessel, vessel_imo, voyage_ref, port, port_function, eta, etb, etd, laycan_from, laycan_to, cargo, cargo_quantity_mt, source_updated_at, external_ref, integration_id"
      )
      .eq("company_id", auth.companyId)
      // NULLs last: an ETA the ERP has not set yet is real, and dropping those
      // rows would hide a port call rather than report an unknown date.
      .order("eta", { ascending: true, nullsFirst: false })
      .limit(500);

    if (!showAll) {
      // A day's grace, so a call that arrived this morning does not vanish
      // while an operator is still looking at it.
      const since = new Date(Date.now() - 86_400_000).toISOString();
      query = query.or(`eta.gte.${since},eta.is.null`);
    }

    const [{ data: rows, error }, { data: integrations }] = await Promise.all([
      query,
      supabase
        .from("integrations")
        .select("id, provider, display_name, config")
        .eq("company_id", auth.companyId),
    ]);
    if (error) throw new Error(`SCHEDULES_READ_FAILED: ${error.message}`);

    const byId = new Map(
      (integrations ?? []).map((i) => {
        const descriptor = PROVIDERS.find((p) => p.provider === i.provider);
        return [
          i.id,
          {
            provider: i.provider as string,
            displayName: (i.display_name as string) ?? (i.provider as string),
            mode:
              ((i.config as Record<string, unknown> | null)?.mode === "mock"
                ? "mock"
                : "live") as "live" | "mock",
            mappingVerified: descriptor?.mappingVerifiedAgainstVendorDocs ?? false,
          },
        ];
      })
    );

    const schedules: ScheduleView[] = (rows ?? []).map((r) => ({
      id: r.id,
      vessel: r.vessel,
      vesselImo: r.vessel_imo,
      voyageRef: r.voyage_ref,
      port: r.port,
      portFunction: r.port_function,
      eta: r.eta,
      etb: r.etb,
      etd: r.etd,
      laycanFrom: r.laycan_from,
      laycanTo: r.laycan_to,
      cargo: r.cargo,
      cargoQuantityMt: r.cargo_quantity_mt === null ? null : Number(r.cargo_quantity_mt),
      sourceUpdatedAt: r.source_updated_at,
      externalRef: r.external_ref,
      source: byId.get(r.integration_id) ?? {
        provider: "UNKNOWN",
        displayName: "Unknown integration",
        mode: "live",
        mappingVerified: false,
      },
    }));

    return NextResponse.json({
      schedules,
      // Distinguishes "no ERP connected" from "connected, nothing scheduled".
      // They need different things from the user and the empty state should say
      // which one they are looking at.
      hasIntegration: (integrations ?? []).length > 0,
    });
  } catch (e) {
    return apiError(e, "integrations/schedules/GET");
  }
}
