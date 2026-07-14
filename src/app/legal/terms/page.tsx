import { LandingNav } from "@/components/laygrounded/landing-nav";
import { Footer } from "@/components/laygrounded/footer/Footer";
import styles from "@/app/StaticPage.module.css";

export const metadata = { title: "Terms of Service — LayGrounded" };

export default function TermsPage() {
  return (
    <div className={styles.pageContainer}>
      <LandingNav theme="light" />
      <main className={styles.mainContent}>
        <div className={styles.card}>
          <h1 className={styles.title}>Terms of Service</h1>
          <p className={styles.subtitle}>
            Last Updated: July 2026
          </p>
          <div className={styles.prose}>
            <p>
              These Terms of Service ("Terms") constitute a legally binding agreement made between you, whether personally or on behalf of an entity ("you") and LayGrounded ("we," "us" or "our"), concerning your access to and use of the LayGrounded web application as well as any other media form, media channel, mobile website or mobile application related, linked, or otherwise connected thereto (collectively, the "Service").
            </p>

            <h2>1. Description of Service</h2>
            <p>
              LayGrounded is a Business-to-Business (B2B) software-as-a-service platform designed to automate the extraction of data from Statements of Facts (SoFs) and calculate laytime, demurrage, and despatch claims based on configured Charter Party clauses. The Service also includes AI-driven evidence verification, agentic legal drafting, predictive oracles, and ERP integrations.
            </p>

            <h2>2. Disclaimer of Warranties and Accuracy (CRITICAL)</h2>
            <p>
              <strong>2.1 Tool for Assistance:</strong> The Service is provided strictly as a computational and data extraction tool to assist maritime professionals. It is <strong>NOT</strong> a substitute for professional legal advice or commercial judgment.
            </p>
            <p>
              <strong>2.2 Verification Required:</strong> While we strive for absolute accuracy through our proprietary algorithms, the automated parsing of unstructured PDFs (SoFs), application of complex Charter Party clauses (e.g., GENCON, ASBATANKVOY), and agentic generation of legal correspondence inherently carries a margin of error. <strong>You acknowledge and agree that it is solely your responsibility to review, audit, and verify all calculations, parsed dates, applied clauses, evidence verdicts, and generated text by LayGrounded before using them for commercial billing, arbitration, legal disputes, ERP synchronization, or any other professional capacity.</strong>
            </p>
            <p>
              <strong>2.3 No Warranty:</strong> The Service is provided on an "AS IS" and "AS AVAILABLE" basis. LayGrounded expressly disclaims all warranties, whether express or implied, including but not limited to the implied warranties of merchantability, fitness for a particular purpose, and non-infringement.
            </p>

            <h2>3. User Content and Data Ownership</h2>
            <p>
              <strong>3.1 Ownership:</strong> You retain all ownership rights in and to the documents, Charter Party agreements, Statements of Facts, and operational data that you upload, submit, or otherwise transmit to the Service ("User Content"). 
            </p>
            <p>
              <strong>3.2 License to Process:</strong> By uploading User Content, you grant LayGrounded a limited, non-exclusive, worldwide, royalty-free license to host, process, and compute this data solely for the purpose of providing the Service to you. You warrant that you have all necessary rights and permissions to upload such confidential commercial data to the platform.
            </p>

            <h2>4. Intellectual Property Rights</h2>
            <p>
              Unless otherwise indicated, the Service is our proprietary property and all source code, databases, functionality, software, website designs, audio, video, text, photographs, and graphics on the Service (collectively, the "Content") and the trademarks, service marks, and logos contained therein are owned or controlled by us, and are protected by copyright and trademark laws. You may not reverse engineer, decompile, or extract the algorithms from the Service under any circumstances.
            </p>

            <h2>5. Fees and Payment</h2>
            <p>
              Access to certain premium features of the Service is subject to payment of subscription fees. All fees are non-refundable unless otherwise required by law. We reserve the right to change our pricing upon providing reasonable notice.
            </p>

            <h2>6. Limitation of Liability</h2>
            <p>
              IN NO EVENT WILL WE OR OUR DIRECTORS, EMPLOYEES, OR AGENTS BE LIABLE TO YOU OR ANY THIRD PARTY FOR ANY DIRECT, INDIRECT, CONSEQUENTIAL, EXEMPLARY, INCIDENTAL, SPECIAL, OR PUNITIVE DAMAGES, INCLUDING LOST PROFIT, LOST REVENUE, LOSS OF DATA, LOSS RELATING TO COMMERCIAL ARBITRATION OR BILLING DISPUTES, OR OTHER DAMAGES ARISING FROM YOUR USE OF THE SERVICE, EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
            </p>

            <h2>7. Indemnification</h2>
            <p>
              You agree to defend, indemnify, and hold us harmless, including our subsidiaries, affiliates, and all of our respective officers, agents, partners, and employees, from and against any loss, damage, liability, claim, or demand, including reasonable attorneys’ fees and expenses, made by any third party due to or arising out of: (1) your use of the Service; (2) breach of these Terms; (3) any breach of your representations and warranties set forth in these Terms; (4) your violation of the rights of a third party; or (5) any dispute between you and a commercial counterparty regarding laytime or demurrage calculations generated by the Service.
            </p>

            <h2>8. Governing Law and Jurisdiction</h2>
            <p>
              These Terms and your use of the Service are governed by and construed in accordance with the laws of Greece and the European Union, without regard to conflict of law principles. Any legal action or proceeding related to your access to or use of the Service shall be instituted in a court of competent jurisdiction in Piraeus, Greece.
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
