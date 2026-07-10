"use client";

import { useAuth } from "@/components/providers";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { FileText, PlusCircle, Settings } from "lucide-react";
import { OfflineIndicator } from "@/components/core/OfflineIndicator";
import { Logo } from "@/components/laygrounded/Logo";
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

  const navItems = [
    { href: "/claims", label: "Claims", Icon: FileText },
    { href: "/claims/new", label: "New Claim", Icon: PlusCircle },
    { href: "/settings", label: "Settings", Icon: Settings },
  ];

  const isActive = (href: string) => {
    if (href === "/claims")
      return pathname === "/claims" || pathname.startsWith("/claims/");
    return pathname === href;
  };

  return (
    <div className={styles.container}>
      {/* Sidebar Navigation */}
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <Logo />
          {companyName && (
            <div className={styles.companyName} style={{ marginTop: '0.25rem' }}>{companyName}</div>
          )}
        </div>

        <nav className={styles.nav}>
          <div className={styles.navGroup}>MAIN MENU</div>
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link 
                key={item.href} 
                href={item.href} 
                className={`${styles.navLink} ${active ? styles.navLinkActive : ""}`}
              >
                <item.Icon className={styles.navIcon} size={20} strokeWidth={active ? 2.5 : 2} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className={styles.footer}>
          <div className={styles.userLabel}>Logged in as</div>
          <div className={styles.userEmail} title={userEmailFromSession}>
            {userEmailFromSession}
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
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
