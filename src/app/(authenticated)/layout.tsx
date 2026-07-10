"use client";

import { useAuth } from "@/components/providers";
import { useRouter } from "next/navigation";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { OfflineIndicator } from "@/components/core/OfflineIndicator";
import styles from "./Layout.module.css";

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [companyName, setCompanyName] = useState<string>("");
  const [memberEmail, setMemberEmail] = useState<string>("");

  useEffect(() => {
    if (status === "loading") return;
    if (!session?.user) {
      router.push("/sign-in");
      return;
    }
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.company?.name) setCompanyName(d.company.name);
        if (d?.members) {
          const me = d.members.find(
            (m: { email: string }) => m.email === session.user?.email
          );
          if (me) setMemberEmail(me.email);
        }
      })
      .catch(() => {});
  }, [session, status, router]);

  const userEmailFromSession = memberEmail || session?.user?.email || "";

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
      <main className={styles.main}>
        <header className={styles.header}>
          {/* Top header can be expanded later for breadcrumbs or actions */}
        </header>
        <div className={styles.content}>
          {children}
        </div>
      </main>

      <OfflineIndicator />
    </div>
  );
}
