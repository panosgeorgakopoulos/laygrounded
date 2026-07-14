import { LandingNav } from "@/components/laygrounded/landing-nav";
import { Footer } from "@/components/laygrounded/footer/Footer";
import styles from "@/app/StaticPage.module.css";
import Link from "next/link";

export const metadata = { title: "Features — LayGrounded" };

export default function FeaturesPage() {
  return (
    <div className={styles.pageContainer}>
      <LandingNav theme="light" />
      <main className={styles.mainContent}>
        <div className={styles.card}>
          <h1 className={styles.title}>Tier-1 Maritime Financial Network Features</h1>
          <p className={styles.subtitle}>
            LayGrounded is engineered for the complexities of dry bulk and tanker shipping. We turn days of manual calculations and negotiations into minutes of automated, auditable accuracy.
          </p>
          <div className={styles.prose}>
            <h2>AI Extraction & Evidence Verification</h2>
            <p>
              Upload PDF or scanned Statement of Facts (SoF) documents and let our proprietary Vision-Language Models digitize the timeline. Our intelligence layer automatically cross-references claimed weather delays against the Open-Meteo ERA5 archive and verifies NOR tender positions against AIS providers.
            </p>
            
            <h2>Deterministic Rules Engine</h2>
            <p>
              Every delay, stoppage, and holiday is evaluated against industry-standard charter party forms, fully supporting both GENCON 94 and ASBATANKVOY logic. LayGrounded autonomously applies strict rules for Weather Working Days (WWD), SHINC/SHEX, and shifting time independent of the AI layer.
            </p>

            <h2>Agentic Legal Drafter</h2>
            <p>
              Powered by Claude Opus, our autonomous drafter analyzes the claim breakdown, evidence verdicts, and ETS data to generate structured legal correspondence. Every financial figure and clause citation is perfectly grounded against the database to prevent hallucinations in demand letters, counter-arguments, and settlement proposals.
            </p>

            <h2>Zero-Day Settlement & ERP Sync</h2>
            <p>
              Clear verified, un-disputed claims instantly through our Zero-Day Settlement clearinghouse. Maintain perfect ledger alignment across your organization with our resilient, bidirectional ERP sync adapters for systems like Veson IMOS, complete with dead-letter fallbacks and strict deduplication.
            </p>
            
            <h2>Secure Workspace Collaboration</h2>
            <p>
              Create dedicated workspaces for your fleet. Invite counterparties into shared claim rooms for live redlining, instantly compute scenario diffs, and review dispute sensitivity ("attack surface") analytics to evaluate financial risk before negotiating.
            </p>

            <div style={{ marginTop: "2rem" }}>
              <Link href="/sign-up" className="bg-slate-900 text-white px-6 py-3 rounded-lg font-medium hover:bg-slate-800 transition-colors inline-block">
                Start Free Trial
              </Link>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
