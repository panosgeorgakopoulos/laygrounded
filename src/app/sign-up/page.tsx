import Link from "next/link";
import { SignUpForm } from "@/components/laygrounded/sign-up-form";
import { Logo } from "@/components/laygrounded/Logo";
import styles from "@/app/Auth.module.css";

export const metadata = { title: "Initialize Workspace — LayGrounded" };

export default function SignUpPage() {
  return (
    <main className={styles.pageContainer}>
      <div className={styles.mainContent}>
        <div className={styles.formContainer}>
          <div className="flex justify-center mb-8">
            <Logo variant="auth" />
          </div>
          <h1 className={styles.title}>Create your workspace</h1>
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
