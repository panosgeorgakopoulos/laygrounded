import type { Metadata } from "next";
import { LandingNav } from "@/components/laygrounded/landing-nav";
import { Footer } from "@/components/laygrounded/footer/Footer";
import staticStyles from "@/app/StaticPage.module.css";
import styles from "./Knowledge.module.css";
import { listClauses } from "@/lib/knowledge/query";
import { KnowledgeBrowser } from "./KnowledgeBrowser";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Laytime & Demurrage Knowledge Base — LayGrounded",
  description:
    "A free reference to GENCON 94 and ASBATANKVOY laytime and demurrage clauses — NOR, turn time, SHINC / SHEX, WIBON, demurrage and despatch — explained plainly.",
  alternates: { canonical: "/knowledge" },
};

export default async function KnowledgePage() {
  const clauses = await listClauses();
  return (
    <div className={staticStyles.pageContainer}>
      <LandingNav theme="light" />
      <main className={staticStyles.mainContent}>
        <div className={styles.hero}>
          <h1>Laytime &amp; Demurrage Knowledge Base</h1>
          <p>
            Plain-language reference to the GENCON 94 and ASBATANKVOY clauses the LayGrounded engine
            computes against — free and open to everyone.
          </p>
        </div>
        <KnowledgeBrowser clauses={clauses} />
      </main>
      <Footer />
    </div>
  );
}
