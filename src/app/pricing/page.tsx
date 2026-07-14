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
          <h1 className={styles.title}>Simple, Transparent Pricing</h1>
          <p className={styles.subtitle}>
            Scale your demurrage workflows and financial settlements without unpredictable costs. LayGrounded scales with your cargo volume and intelligence requirements.
          </p>
          <div className={styles.prose}>
            <h2>Free Trial</h2>
            <p>
              Experience the power of automated SoF parsing and deterministic logic at zero risk. Ideal for independent operators looking to validate our engine.
            </p>
            <ul>
              <li>Up to 5 Laytime/Demurrage Calculations per month</li>
              <li>GENCON 94 and ASBATANKVOY clause logic</li>
              <li>PDF exporting</li>
            </ul>

            <h2>Professional</h2>
            <p>
              Built for commercial shipping companies and brokers who process high volumes of claims and require intelligence tools like weather verification and scenario diffing.
            </p>
            <ul>
              <li>Unlimited Laytime/Demurrage Calculations</li>
              <li>Advanced Evidence Verification (AIS & Open-Meteo)</li>
              <li>Shared Counterparty Claim Rooms & Scenario Diffing</li>
              <li>Excel & PDF Arbitration-Ready Exports</li>
            </ul>

            <h2>Enterprise</h2>
            <p>
              For global fleet managers requiring deep integration, predictive oracles, zero-day settlement clearing, and automated agentic legal drafting.
            </p>
            <ul>
              <li>Everything in Professional</li>
              <li>Agentic Legal Drafter & In-Voyage Legal Shield</li>
              <li>Zero-Day Settlement Clearinghouse & Veson IMOS ERP Sync</li>
              <li>Pre-Fixture Pricing & Parametric Insurance Oracles</li>
              <li>SSO / SAML Security integration & Dedicated Success Manager</li>
            </ul>

            <div style={{ marginTop: "2rem" }}>
              <Link href="/contact" className="bg-slate-900 text-white px-6 py-3 rounded-lg font-medium hover:bg-slate-800 transition-colors inline-block">
                Contact Sales
              </Link>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
