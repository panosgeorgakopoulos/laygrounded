import Link from "next/link";
import { SignUpForm } from "@/components/laygrounded/sign-up-form";
import styles from "@/app/Auth.module.css";

export const metadata = { title: "Initialize Workspace — LayGrounded" };

export default function SignUpPage() {
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
          <h1 className={styles.title}>Initialize Workspace</h1>
          <p className={styles.subtitle}>
            Create your account and initialize a new fleet workspace.
          </p>

          <SignUpForm />

          <div className={styles.footerText}>
            Already have an account?{" "}
            <Link href="/sign-in" className={styles.link}>
              Sign in here
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
