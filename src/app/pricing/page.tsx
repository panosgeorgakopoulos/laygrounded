import { LandingNav } from "@/components/laygrounded/landing-nav";
import { Footer } from "@/components/laygrounded/footer/Footer";
import styles from "@/app/StaticPage.module.css";
import Link from "next/link";

export const metadata = { title: "Pricing — LayGrounded" };

export default function PricingPage() {
  return (
    <div className={styles.pageContainer}>
      <LandingNav theme="light" />
      <main className={styles.mainContent}>
        <div className={styles.card}>
          <h1 className={styles.title}>One plan. Everything included. Free.</h1>
          <p className={styles.subtitle}>
            LayGrounded is free. Every feature — the deterministic laytime engine, evidence
            verification, collaborative claim rooms, the agentic legal drafter, settlement,
            compliance, and the AI / MCP integration — is available to every account. No tiers, no
            usage caps, no paywalls, no &ldquo;contact sales&rdquo;.
          </p>
          <div className={styles.prose}>
            <h2>Everything, for everyone</h2>
            <p>
              Whether you are an independent operator validating a single claim or a fleet manager
              running a whole book, you get the entire platform from day one.
            </p>
            <ul>
              <li>Unlimited laytime / demurrage calculations</li>
              <li>GENCON 94 and ASBATANKVOY clause logic, hour-resolution breakdowns</li>
              <li>AI Statement-of-Facts extraction and deterministic recomputation</li>
              <li>Evidence verification against AIS and the Open-Meteo / ERA5 weather archive</li>
              <li>Shared counterparty claim rooms, scenario diffing, dispute-sensitivity intel</li>
              <li>Excel &amp; PDF arbitration-ready exports</li>
              <li>Agentic legal drafter and the in-voyage Legal Shield</li>
              <li>Zero-day settlement clearinghouse and Veson IMOS ERP sync</li>
              <li>Pre-fixture pricing and parametric-insurance oracles</li>
              <li>EU MRV / ETS reporting, FuelEU Maritime, and the carbon cost of delay</li>
              <li>Connect any AI assistant to your claims over the secure MCP endpoint</li>
            </ul>

            <div style={{ marginTop: "2rem" }}>
              <Link href="/sign-up" className="bg-slate-900 text-white px-6 py-3 rounded-lg font-medium hover:bg-slate-800 transition-colors inline-block">
                Get started free
              </Link>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
