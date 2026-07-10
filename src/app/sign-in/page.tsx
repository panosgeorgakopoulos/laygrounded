import Link from "next/link";
import { SignInForm } from "@/components/laygrounded/sign-in-form";
import styles from "@/app/Auth.module.css";

export const metadata = { title: "Sign In — LayGrounded" };

export default function SignInPage() {
  return (
    <main className={styles.pageContainer}>
      <header className={styles.header}>
        <div className={styles.headerContainer}>
          <Link href="/" className={styles.brandLink}>
            <span className={styles.brandIcon} />
            <span className={styles.brandText}>LayGrounded</span>
          </Link>
        </div>
      </header>

      <div className={styles.mainContent}>
        <div className={styles.formContainer}>
          <h1 className={styles.title}>Sign in</h1>
          <p className={styles.subtitle}>Access your claim workspace.</p>

          <SignInForm />

          <div className={styles.footerText}>
            New to LayGrounded?{" "}
            <Link href="/sign-up" className={styles.link}>
              Initialize a workspace
            </Link>
          </div>

          <div className={styles.demoBox}>
            <div className={`${styles.demoBoxTitle} tnum`}>Demo access</div>
            <div>
              Email: <span className={styles.demoBoxValue}>demo@laygrounded.io</span>
            </div>
            <div>
              Password: <span className={styles.demoBoxValue}>demo1234</span>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
