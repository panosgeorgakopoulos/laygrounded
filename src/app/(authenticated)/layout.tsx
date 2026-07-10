"use client";

import { useAuth } from "@/components/providers";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { OfflineIndicator } from "@/components/core/OfflineIndicator";
import { LandingNav } from "@/components/laygrounded/landing-nav";

import styles from "./Layout.module.css";

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "loading") return;
    if (!session?.user) {
      router.push("/sign-in");
    }
  }, [session, status, router]);

  if (status === "loading") {
    return (
      <div className={styles.loading}>
        <div className="tnum">AUTHENTICATING...</div>
      </div>
    );
  }
  
  if (!session?.user) return null;

  return (
    <div className={styles.container}>
      <LandingNav theme="light" />
      <main className={styles.main}>
        <div className={styles.content}>
          {children}
        </div>
      </main>
      <OfflineIndicator />
    </div>
  );
}
