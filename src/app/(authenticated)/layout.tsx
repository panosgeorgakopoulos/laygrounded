"use client";

import { useAuth } from "@/components/providers";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { OfflineIndicator } from "@/components/core/OfflineIndicator";
import { LandingNav } from "@/components/laygrounded/landing-nav";
import { NotificationBell } from "@/components/laygrounded/notification-bell";
import { useRole } from "@/components/role-provider";

import styles from "./Layout.module.css";

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, status } = useAuth();
  // Authenticated is not the same as tenanted. A user with a valid session and
  // no company reaches every page in this group and every panel on it fails
  // with NO_COMPANY — a dashboard that looks broken rather than one that has
  // not been set up.
  const { loading: roleLoading, noCompany } = useRole();
  const router = useRouter();

  useEffect(() => {
    if (status === "loading") return;
    if (!session?.user) {
      router.push("/sign-in");
      return;
    }
    // Ordered after the session check: a signed-out user is not tenantless,
    // they are signed out, and /sign-in is where they belong.
    if (!roleLoading && noCompany) {
      router.push("/onboarding");
    }
  }, [session, status, roleLoading, noCompany, router]);

  if (status === "loading") {
    return (
      <div className={styles.loading}>
        <div className="tnum">AUTHENTICATING...</div>
      </div>
    );
  }

  if (!session?.user) return null;

  // Nothing is rendered while the redirect to /onboarding is in flight. The
  // alternative — showing the workspace shell for a frame — flashes a nav and a
  // notification bell that cannot resolve, which reads as a failure.
  if (noCompany) return null;

  return (
    <div className={styles.container}>
      <LandingNav theme="light" />
      {/* Outside the nav, deliberately. `LandingNav` is a collapsing GSAP pill
          whose links are not visible at rest — a badge inside it would be
          hidden exactly when it has something to say. */}
      <div className={styles.bellSlot}>
        <NotificationBell />
      </div>
      <main className={styles.main}>
        <div className={styles.content}>
          {children}
        </div>
      </main>
      <OfflineIndicator />
    </div>
  );
}
