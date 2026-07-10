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
            Scale your demurrage workflows without unpredictable costs. Whether you manage a small fleet or global operations, LayGrounded scales with your cargo volume.
          </p>
          <div className={styles.prose}>
            <h2>Free Trial</h2>
            <p>
              Experience the power of automated SoF parsing at zero risk. Ideal for independent operators and small maritime teams looking to validate our engine.
            </p>
            <ul>
              <li>Up to 5 Laytime/Demurrage Calculations per month</li>
              <li>Basic GENCON 94 clause logic</li>
              <li>PDF exporting</li>
            </ul>

            <h2>Professional</h2>
            <p>
              Built for commercial shipping companies, shipbrokers, and charterers who process high volumes of laytime claims and demand arbitration-grade accuracy.
            </p>
            <ul>
              <li>Unlimited Laytime/Demurrage Calculations</li>
              <li>Advanced Custom Charter Party Clause configuration (SHEX/SHINC, Weather exceptions)</li>
              <li>Excel & PDF Arbitration-Ready Exports</li>
              <li>Priority Email Support</li>
            </ul>

            <h2>Enterprise</h2>
            <p>
              For global fleet managers requiring deep integration, dedicated account management, and advanced workspace permissions.
            </p>
            <ul>
              <li>Everything in Professional</li>
              <li>SSO / SAML Security integration</li>
              <li>Dedicated Success Manager</li>
              <li>Custom API Integration for internal systems</li>
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
