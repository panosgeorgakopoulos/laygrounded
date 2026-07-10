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
          <h1 className={styles.title}>Precision Features for Maritime Claims</h1>
          <p className={styles.subtitle}>
            LayGrounded is engineered specifically for the complexities of dry bulk shipping, turning hours of manual calculation into minutes of automated, auditable accuracy.
          </p>
          <div className={styles.prose}>
            <h2>Automated Statement of Facts (SoF) Parsing</h2>
            <p>
              Upload PDF or scanned Statement of Facts documents and let our proprietary extraction engine digitize the timeline. We identify key operational events—Arrival, NOR Tendered, Commenced Loading, Rain Delays, and Completion—with high fidelity.
            </p>
            
            <h2>Legally Auditable Clause Matching</h2>
            <p>
              Every delay, stoppage, and holiday is evaluated against industry-standard charter party forms (including GENCON 94, NYPE, and ASBATANKVOY). LayGrounded automatically applies logical rules for Weather Working Days (WWD), SHINC/SHEX, and shifting time.
            </p>
            
            <h2>Arbitration-Ready Exporting</h2>
            <p>
              Generate comprehensive, mathematically proven laytime calculations in PDF or Excel format. Every calculation includes a transparent audit trail linking the final demurrage or despatch figure directly back to the specific charter party clause and SoF event.
            </p>
            
            <h2>Secure Workspace Collaboration</h2>
            <p>
              Create dedicated workspaces for your fleet. Invite team members, operators, and legal counsel to review claims in real-time, ensuring commercial data remains secure, centralized, and version-controlled.
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
