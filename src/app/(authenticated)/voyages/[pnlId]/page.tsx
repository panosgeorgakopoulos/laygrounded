import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { computeStoredPnl } from "@/lib/pnl/pnl-server";
import { VoyagePnlSheet, type LinkableClaim } from "@/components/laygrounded/voyage-pnl-sheet";

export const metadata = {
  title: "Voyage P&L · LayGrounded",
};

/**
 * Claims in the company that could feed this voyage, with the demurrage each
 * would contribute. Showing the figure at the point of linking is the whole
 * value of the picker: an operator can see what attaching a port call does to
 * the sheet before doing it.
 */
async function loadLinkableClaims(
  companyId: string,
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<LinkableClaim[]> {
  const { data: claims } = await supabase
    .from("claims")
    .select("id, vessel, voyage_ref, port")
    .eq("company_id", companyId)
    .order("updated_at", { ascending: false });

  const ids = (claims ?? []).map((c) => c.id);
  if (ids.length === 0) return [];

  const { data: calcs } = await supabase
    .from("laytime_calculations")
    .select("claim_id, demurrage_amount, despatch_amount, currency")
    .in("claim_id", ids);

  const byClaim = new Map(
    (calcs ?? []).map((c) => [
      c.claim_id as string,
      {
        demurrage: c.demurrage_amount ?? 0,
        despatch: c.despatch_amount ?? 0,
        currency: (c.currency as string) ?? "USD",
      },
    ])
  );

  return (claims ?? []).map((c) => {
    const calc = byClaim.get(c.id);
    return {
      id: c.id,
      vessel: c.vessel,
      voyageRef: c.voyage_ref,
      port: c.port,
      demurrage: calc?.demurrage ?? null,
      despatch: calc?.despatch ?? null,
      currency: calc?.currency ?? null,
      hasCalculation: !!calc,
    };
  });
}

export default async function VoyagePnlPage({
  params,
}: {
  params: Promise<{ pnlId: string }>;
}) {
  const { pnlId } = await params;
  const auth = await requireAuth();
  const supabase = await createClient();

  const { data: row } = await supabase
    .from("voyage_pnl")
    .select("id, company_id")
    .eq("id", pnlId)
    .maybeSingle();
  // Ownership is checked here as well as by RLS, per the route convention.
  if (!row || row.company_id !== auth.companyId) notFound();

  const [{ pnl, claimIds, result }, linkable] = await Promise.all([
    computeStoredPnl(pnlId, supabase),
    loadLinkableClaims(auth.companyId, supabase),
  ]);

  return (
    <VoyagePnlSheet
      pnlId={pnlId}
      vessel={pnl.vessel}
      voyageRef={pnl.voyage_ref}
      charterType={pnl.charter_type}
      status={pnl.status}
      initialResult={result}
      initialClaimIds={claimIds}
      linkableClaims={linkable}
    />
  );
}
