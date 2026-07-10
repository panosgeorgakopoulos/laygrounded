import { LandingNav } from "@/components/laygrounded/landing-nav";
import { Footer } from "@/components/laygrounded/footer/Footer";
import styles from "@/app/StaticPage.module.css";
import Link from "next/link";

export const metadata = { title: "Contact Us — LayGrounded" };

export default function ContactPage() {
  return (
    <div className={styles.pageContainer}>
      <LandingNav theme="light" />
      <main className={styles.mainContent}>
        <div className={styles.card}>
          <h1 className={styles.title}>Contact Us</h1>
          <p className={styles.subtitle}>
            We're here to help you streamline your maritime claims.
          </p>
          <div className={styles.prose}>
            <h2>Get in Touch</h2>
            <p>
              Whether you have a question about enterprise pricing, need technical support, or want to explore custom API integrations for your fleet, our team is ready to assist.
            </p>

            <div style={{ marginTop: "2rem", marginBottom: "2rem" }}>
              <h3>Email Support</h3>
              <p>
                For general inquiries and technical assistance:<br/>
                <a href="mailto:panosgeorgakopoulos@icloud.com">panosgeorgakopoulos@icloud.com</a>
              </p>
            </div>

            <div style={{ marginBottom: "2rem" }}>
              <h3>Enterprise Sales</h3>
              <p>
                For high-volume processing and dedicated account management:<br/>
                <a href="mailto:panosgeorgakopoulos@icloud.com">panosgeorgakopoulos@icloud.com</a>
              </p>
            </div>

            <h2>Office Location</h2>
            <p>
              LayGrounded is built at the heart of global shipping.<br/>
              Piraeus, Greece
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
