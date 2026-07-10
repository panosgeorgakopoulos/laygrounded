"use client";

import Link from "next/link";
import { useAuth } from "@/components/providers";
import styles from "@/app/Landing.module.css";

export function LandingNav() {
  const { data: session } = useAuth();
  return (
    <header className={styles.nav}>
      <div className={styles.navContainer}>
        <Link href="/" className={styles.brandLink}>
          <span className={styles.brandIcon} />
          <span className={styles.brandText}>
            LayGrounded
          </span>
        </Link>
        <nav className={styles.navActions}>
          {session?.user ? (
            <Link
              href="/claims"
              className={styles.navDashboardLink}
            >
              Open Dashboard
            </Link>
          ) : (
            <>
              <Link
                href="/sign-in"
                className={styles.signInLink}
              >
                Sign In
              </Link>
              <Link
                href="/sign-up"
                className={`${styles.actionPrimary} ${styles.hiddenMobile}`}
                style={{ minHeight: '36px', padding: '0.375rem 0.75rem' }}
              >
                Initialize Claim Workspace
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
