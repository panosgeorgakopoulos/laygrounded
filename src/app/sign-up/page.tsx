import Link from "next/link";
import { SignUpForm } from "@/components/laygrounded/sign-up-form";
import { LandingNav } from "@/components/laygrounded/landing-nav";
import { Logo } from "@/components/laygrounded/Logo";
import styles from "@/app/Auth.module.css";

export const metadata = { title: "Initialize Workspace — LayGrounded" };

export default function SignUpPage() {
  return (
    <main className={styles.pageContainer}>
      <LandingNav theme="light" />
      <div className={styles.mainContent}>
        <div className={styles.formContainer}>
          <div className="flex justify-center mb-8">
            <Logo variant="auth" />
          </div>
          <h1 className={styles.title}>Create your account</h1>
          <p className={styles.subtitle}>
            {/* The company is named at /onboarding, not here — an invited user
                must never be asked to create one, and at this point we do not
                yet know whether they were invited. */}
            Next you will either create a workspace or join one you have been invited to.
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
