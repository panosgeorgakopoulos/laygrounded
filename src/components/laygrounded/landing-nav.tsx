"use client";

import { useRef, useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import gsap from "gsap";
import { useAuth } from "@/components/providers";
import { Logo } from "@/components/laygrounded/Logo";
import styles from "./IslandNav.module.css";

const NAV_ITEMS = [
  { label: "Claims",     href: "/claims" },
  { label: "New Claim",  href: "/claims/new" },
  { label: "Settings",  href: "/settings" },
];

export function LandingNav({ theme = "dark" }: { theme?: "dark" | "light" }) {
  const { data: session } = useAuth();
  const pathname = usePathname();

  const pillRef        = useRef<HTMLDivElement>(null);
  const labelsRef      = useRef<HTMLDivElement>(null);
  const linksRef       = useRef<HTMLDivElement>(null);
  const glowRef        = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const tlRef          = useRef<gsap.core.Timeline | null>(null);

  const isActive = (href: string) => {
    if (href === "/claims") {
      return pathname === "/claims" || pathname.startsWith("/claims/");
    }
    return pathname === href;
  };

  /* ── Build the expand / collapse timeline once ──────────────────────── */
  useEffect(() => {
    const pill   = pillRef.current!;
    const labels = labelsRef.current!;
    const links  = linksRef.current!;
    const glow   = glowRef.current!;

    /* Collapsed state */
    gsap.set(pill,   { borderRadius: "999px", width: "auto" });
    gsap.set(labels, { opacity: 0, y: 4, pointerEvents: "none" });
    gsap.set(links,  { opacity: 0, y: 4, pointerEvents: "none" });

    tlRef.current = gsap.timeline({ paused: true })
      /* 1. Widen the pill */
      .to(pill, {
        scale: 1.02,
        duration: 0.12,
        ease: "power2.in",
      })
      .to(pill, {
        scale: 1,
        duration: 0.45,
        ease: "elastic.out(1, 0.55)",
      }, "<0.1")
      /* 2. Glow bloom */
      .to(glow, {
        opacity: 1,
        scale: 1.15,
        duration: 0.5,
        ease: "power2.out",
      }, 0)
      /* 3. Fade in nav links */
      .to(links, {
        opacity: 1,
        y: 0,
        duration: 0.35,
        ease: "power3.out",
        pointerEvents: "auto",
      }, 0.1)
      /* 4. Fade in CTA labels */
      .to(labels, {
        opacity: 1,
        y: 0,
        duration: 0.3,
        ease: "power3.out",
        pointerEvents: "auto",
      }, 0.18);

  }, []);

  /* ── Hover handlers ─────────────────────────────────────────────────── */
  const handleEnter = () => {
    if (!expanded) {
      setExpanded(true);
      tlRef.current?.play();
    }
  };

  const handleLeave = () => {
    if (expanded) {
      setExpanded(false);
      tlRef.current?.reverse();
    }
  };

  /* ── Mouse-track glow ───────────────────────────────────────────────── */
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const pill = pillRef.current;
    const glow = glowRef.current;
    if (!pill || !glow) return;
    const rect = pill.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    gsap.to(glow, {
      x: x - rect.width / 2,
      y: y - rect.height / 2,
      duration: 0.4,
      ease: "power2.out",
    });
  };

  const islandClass = `${styles.island} ${expanded ? styles.islandExpanded : ""} ${theme === "light" ? styles.light : ""}`;

  return (
    /* Outer row: centres the pill */
    <header className={styles.header}>
      <div
        className={islandClass}
        ref={pillRef}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        onMouseMove={handleMouseMove}
        role="navigation"
        aria-label="Main navigation"
      >
        {/* Soft glow blob that follows the cursor */}
        <div className={styles.glow} ref={glowRef} aria-hidden="true" />

        {/* Inner content row */}
        <div className={styles.row}>

          {/* Brand — always visible */}
          <Link href="/" className={`${styles.brand} flex items-center`} style={{ textDecoration: 'none' }}>
            <Logo theme={theme} variant="navbar" />
          </Link>

          {/* Separator */}
          <span className={styles.sep} aria-hidden="true" />

          {/* Nav links — revealed on expand */}
          <div className={styles.links} ref={linksRef} aria-hidden={!expanded}>
            {NAV_ITEMS.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`${styles.navLink} ${active ? styles.active : ""}`}
                  tabIndex={expanded ? 0 : -1}
                >
                  {item.label}
                </Link>
              );
            })}
            <span className={styles.linkSep} aria-hidden="true" />
          </div>

          {/* CTA — revealed on expand */}
          <div className={styles.ctas} ref={labelsRef} aria-hidden={!expanded}>
            {session?.user ? (
              <>
                <Link
                  href="/claims"
                  className={styles.ghostBtn}
                  tabIndex={expanded ? 0 : -1}
                >
                  Dashboard
                </Link>
                <button
                  onClick={async () => {
                    const { createClient } = await import("@/lib/supabase/client");
                    await createClient().auth.signOut();
                    window.location.href = "/sign-in";
                  }}
                  className={styles.ctaBtn}
                  tabIndex={expanded ? 0 : -1}
                >
                  Logout
                </button>
              </>
            ) : (
              <>
                <Link
                  href="/sign-in"
                  className={styles.ghostBtn}
                  tabIndex={expanded ? 0 : -1}
                >
                  Sign In
                </Link>
                <Link
                  href="/sign-up"
                  className={styles.ctaBtn}
                  tabIndex={expanded ? 0 : -1}
                >
                  Start Free
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
