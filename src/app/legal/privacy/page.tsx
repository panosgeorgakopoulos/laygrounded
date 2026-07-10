import { LandingNav } from "@/components/laygrounded/landing-nav";
import { Footer } from "@/components/laygrounded/footer/Footer";
import styles from "@/app/StaticPage.module.css";

export const metadata = { title: "Privacy Policy — LayGrounded" };

export default function PrivacyPage() {
  return (
    <div className={styles.pageContainer}>
      <LandingNav theme="light" />
      <main className={styles.mainContent}>
        <div className={styles.card}>
          <h1 className={styles.title}>Privacy Policy</h1>
          <p className={styles.subtitle}>
            Last Updated: July 2026
          </p>
          <div className={styles.prose}>
            <p>
              LayGrounded respects your privacy and is committed to protecting your personal data and highly sensitive commercial information. This Privacy Policy informs you as to how we look after your data when you visit our website (regardless of where you visit it from) and tells you about your privacy rights and how the law protects you.
            </p>

            <h2>1. Important Information and Who We Are</h2>
            <p>
              LayGrounded is the data controller and is responsible for your personal data. We are a B2B SaaS platform designed to automate laytime and demurrage calculations for the maritime shipping industry. If you have any questions about this Privacy Policy, including any requests to exercise your legal rights, please contact us at panosgeorgakopoulos@icloud.com.
            </p>

            <h2>2. The Data We Collect About You</h2>
            <p>
              We may collect, use, store and transfer different kinds of personal and commercial data which we have grouped together as follows:
            </p>
            <ul>
              <li><strong>Identity Data:</strong> includes first name, last name, username or similar identifier, title, and company name.</li>
              <li><strong>Contact Data:</strong> includes corporate billing address, delivery address, email address, and telephone numbers.</li>
              <li><strong>Commercial Data:</strong> includes Statements of Facts (SoFs), Charter Party agreements, fixture recaps, and vessel operational data uploaded to the Service. <em>(Note: We treat this data with strict commercial confidentiality.)</em></li>
              <li><strong>Technical Data:</strong> includes internet protocol (IP) address, your login data, browser type and version, time zone setting and location, browser plug-in types and versions, operating system and platform, and other technology on the devices you use to access this website.</li>
              <li><strong>Usage Data:</strong> includes information about how you use our website, products, and services.</li>
            </ul>

            <h2>3. How We Use Your Data</h2>
            <p>
              We will only use your data when the law allows us to. Most commonly, we will use your personal and commercial data in the following circumstances:
            </p>
            <ul>
              <li>Where we need to perform the contract we are about to enter into or have entered into with you (e.g., parsing your SoFs and calculating demurrage).</li>
              <li>Where it is necessary for our legitimate interests (or those of a third party) and your interests and fundamental rights do not override those interests (e.g., to study how customers use our products/services, to develop them, and to grow our business).</li>
              <li>Where we need to comply with a legal or regulatory obligation.</li>
            </ul>

            <h2>4. Data Security and Commercial Confidentiality</h2>
            <p>
              We have put in place appropriate security measures to prevent your personal data and highly sensitive commercial data from being accidentally lost, used, or accessed in an unauthorized way, altered, or disclosed. This includes end-to-end encryption in transit and AES-256 encryption at rest. In addition, we limit access to your data to those employees, agents, contractors, and other third parties who have a business need to know. They will only process your data on our instructions and they are subject to a strict duty of confidentiality.
            </p>

            <h2>5. Data Sharing and Third-Party Processors</h2>
            <p>
              We do not sell your personal or commercial data. We may share your data with strictly vetted third-party service providers acting as processors based within the EU and US who provide IT and system administration services (e.g., secure cloud hosting providers). We require all third parties to respect the security of your data and to treat it in accordance with the law. We do not allow our third-party service providers to use your data for their own purposes.
            </p>

            <h2>6. Data Retention</h2>
            <p>
              We will only retain your data for as long as reasonably necessary to fulfil the purposes we collected it for, including for the purposes of satisfying any legal, regulatory, tax, accounting, or reporting requirements. We may retain your data for a longer period in the event of a complaint or if we reasonably believe there is a prospect of litigation in respect to our relationship with you.
            </p>

            <h2>7. Your Legal Rights (GDPR)</h2>
            <p>
              Under certain circumstances, you have rights under data protection laws in relation to your personal data, including the right to:
            </p>
            <ul>
              <li>Request access to your personal data (a "data subject access request").</li>
              <li>Request correction of the personal data that we hold about you.</li>
              <li>Request erasure of your personal data.</li>
              <li>Object to processing of your personal data.</li>
              <li>Request restriction of processing of your personal data.</li>
              <li>Request the transfer of your personal data to you or to a third party.</li>
              <li>Withdraw consent at any time where we are relying on consent to process your personal data.</li>
            </ul>
            <p>
              If you wish to exercise any of the rights set out above, please contact us.
            </p>

            <h2>8. Changes to the Privacy Policy</h2>
            <p>
              We keep our Privacy Policy under regular review. We will notify you of any material changes by posting the new Privacy Policy on this page and updating the "Last Updated" date.
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
