import { LandingNav } from "@/components/laygrounded/landing-nav";
import { Footer } from "@/components/laygrounded/footer/Footer";
import styles from "@/app/StaticPage.module.css";
import { Linkedin } from "lucide-react";

export const metadata = { title: "About Us — LayGrounded" };

export default function AboutPage() {
  return (
    <div className={styles.pageContainer}>
      <LandingNav theme="light" />
      <main className={styles.mainContent}>
        <div className={styles.card}>
          <h1 className={styles.title}>About LayGrounded</h1>
          <p className={styles.subtitle}>
            Digitizing and settling the multi-billion dollar maritime demurrage industry.
          </p>
          <div className={styles.prose}>
            <h2>Our Mission</h2>
            <p>
              Dry bulk and tanker shipping move the world, yet the multi-billion dollar demurrage industry remains stuck in the past—reliant on manual data entry, physical papers, and subjective interpretation of complex charter party clauses. LayGrounded was founded to eliminate these inefficiencies by providing a precise, automated, and legally auditable laytime calculation engine paired with a predictive financial network.
            </p>

            <h2>The Founder</h2>
            <p>
              LayGrounded is built and maintained by Panagiotis-Sergios Georgakopoulos, a solo tech founder and undergraduate student at the University of Piraeus. Combining a deep understanding of computer science with a passion for the maritime industry, LayGrounded bridges the gap between modern technology and traditional shipping operations.
            </p>

            <a 
              href="https://www.linkedin.com/in/panagiotis-sergios-georgakopoulos" 
              target="_blank" 
              rel="noopener noreferrer"
              className={styles.iconLink}
            >
              <Linkedin size={18} />
              Connect on LinkedIn
            </a>

            <h2 style={{ marginTop: "3rem" }}>Why LayGrounded?</h2>
            <p>
              We believe that commercial shipping deserves software that is as robust as the vessels moving the cargo. By focusing specifically on the nuances of laytime, demurrage, predictive risk, and automated settlement—from AI-driven evidence verification to agentic legal drafting and ERP synchronization—LayGrounded ensures that every claim is computationally perfect, arbitration-ready, and instantly actionable.
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
