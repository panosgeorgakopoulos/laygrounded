// Public claim room — the shared negotiation surface a counterparty reaches
// through an unguessable share link. Server-rendered from the validated
// token; no Supabase session involved.

import type { Metadata } from "next";
import { resolveShare, loadRoomView } from "@/lib/rooms";
import { Logo } from "@/components/laygrounded/Logo";
import { RoomClient } from "./room-client";
import styles from "./Room.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Claim Room — LayGrounded",
  robots: { index: false, follow: false },
};

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default async function ClaimRoomPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = await resolveShare(token);

  if (!resolved) {
    return (
      <div className={styles.deadCenter}>
        <Logo variant="navbar" />
        <h1 style={{ fontSize: "1.25rem", fontWeight: 700 }}>This claim room is no longer active</h1>
        <p style={{ color: "var(--color-text-secondary)", maxWidth: "420px" }}>
          The link may have expired or been revoked. Ask the claim owner for a fresh
          invitation.
        </p>
      </div>
    );
  }

  const view = await loadRoomView(resolved);
  const { claim, room, diff } = view;
  const baseline = diff?.baseline ?? null;
  const currency = claim.cpTerms?.currency ?? "USD";

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <header className={styles.topBar}>
          <div>
            <div className={styles.roomLabel}>Laytime claim room</div>
            <div className={styles.vesselTitle}>MV {claim.vessel}</div>
            <div className={styles.metaRow}>
              <span className={styles.metaItem}>
                Voyage <strong className="tnum">{claim.voyageRef}</strong>
              </span>
              <span className={styles.metaItem}>
                Port <strong>{claim.port}</strong>
              </span>
              <span className={styles.metaItem}>
                Cargo <strong>{claim.cargo}</strong>
              </span>
              {claim.cpTerms && (
                <span className={styles.metaItem}>
                  Terms{" "}
                  <strong>
                    {(claim.cpTerms.cp_form ?? "GENCON94") === "ASBATANKVOY"
                      ? "Asbatankvoy"
                      : "GENCON 94"}{" "}
                    · {claim.cpTerms.days_basis} · {claim.cpTerms.nor_variant}
                  </strong>
                </span>
              )}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.375rem" }}>
            <Logo variant="navbar" />
            <div className={styles.expiry}>
              Access expires {room.expiresAt.slice(0, 10)}
            </div>
          </div>
        </header>

        <section className={styles.card}>
          <div className={styles.cardTitle}>Position</div>
          {baseline ? (
            <>
              <div className={styles.totalsGrid}>
                <div className={styles.totalCell}>
                  <div className={styles.totalLabel}>Laytime allowed</div>
                  <div className={`${styles.totalValue} tnum`}>
                    {baseline.totals.allowed_hours.toFixed(0)} h
                  </div>
                </div>
                <div className={styles.totalCell}>
                  <div className={styles.totalLabel}>Laytime used</div>
                  <div className={`${styles.totalValue} tnum`}>
                    {baseline.totals.used_hours.toFixed(0)} h
                  </div>
                </div>
                <div className={styles.totalCell}>
                  <div className={styles.totalLabel}>Demurrage</div>
                  <div className={`${styles.totalValue} tnum`}>
                    {money(baseline.totals.demurrage_amount, currency)}
                  </div>
                </div>
                <div className={styles.totalCell}>
                  <div className={styles.totalLabel}>Despatch</div>
                  <div className={`${styles.totalValue} tnum`}>
                    {money(baseline.totals.despatch_amount, currency)}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className={styles.emptyNote}>
              No calculation available yet
              {diff?.baselineError ? ` (${diff.baselineError})` : ""}.
            </div>
          )}
        </section>

        <RoomClient
          token={token}
          events={view.events}
          proposals={view.proposals}
          initialDiff={diff}
          currency={currency}
        />

        <div className={styles.hint}>
          Powered by LayGrounded — both parties see the same deterministic,
          clause-cited calculation. Every figure above is reproducible from the
          agreed timeline and CP terms.
        </div>
      </div>
    </div>
  );
}
