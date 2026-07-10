"use client";

import React, { useRef, useState } from "react";
import styles from "./Story.module.css";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { ScrollToPlugin } from "gsap/ScrollToPlugin";
import { useGSAP } from "@gsap/react";
import { ChapterCard } from "./ChapterCard";
import { ProgressNavigation } from "./ProgressNavigation";
import { ParticlesLayer } from "./ParticlesLayer";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger, ScrollToPlugin);

// ─── Chapter Data — Tied to LayGrounded's actual product flow ────────────────
// These mirror the claims pipeline: upload SoF → extract events → apply
// charterparty clauses → compute laytime & demurrage → export final claim.
const CHAPTERS = [
  {
    title: "Upload SoF",
    subtitle: "01 — Document Intake",
    content:
      "Drop your Statement of Facts PDF into a claim workspace. Our Vision-Language Models parse every page — NOR tenders, berth times, hatch operations — into structured events with per-page quality gates.",
    align: "left" as const,
  },
  {
    title: "Extract Events",
    subtitle: "02 — AI Extraction",
    content:
      "Each SoF line is classified into precise event types: NOR_TENDERED, ALL_FAST, COMMENCED_LOADING, WEATHER_DELAY, SHIFTING, and more. Automatic retries and deterministic fallbacks ensure 99.9% extraction fidelity.",
    align: "right" as const,
  },
  {
    title: "Apply Clauses",
    subtitle: "03 — GENCON 94 Engine",
    content:
      "The rules engine runs hour-by-hour laytime logic: NOR validation, WIBON/WIPON variants, turn time, SHEX working-hour advancement, and operational window detection — all with clause citations.",
    align: "left" as const,
  },
  {
    title: "Compute Claim",
    subtitle: "04 — Demurrage & Despatch",
    content:
      "Get a complete breakdown: allowed hours vs. used hours, time on demurrage, time saved, and final amounts in any currency. Ambiguous events are flagged automatically for review.",
    align: "right" as const,
  },
  {
    title: "Export & Resolve",
    subtitle: "05 — Arbitration-Ready",
    content:
      "Export defensible, fully formatted Laytime & Demurrage statements ready for counterparty negotiation or arbitration. Every calculation line cites the governing charterparty clause.",
    align: "left" as const,
  },
];

const NUM_CHAPTERS = CHAPTERS.length;

// ─── Component ───────────────────────────────────────────────────────────────
export function StoryScene() {
  const masterRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const img1Ref = useRef<HTMLImageElement>(null);
  const img2Ref = useRef<HTMLImageElement>(null);
  const [activeChapter, setActiveChapter] = useState(0);

  useGSAP(() => {
    if (!masterRef.current || !trackRef.current) return;

    const mm = gsap.matchMedia();

    // ══ DESKTOP ════════════════════════════════════════════════════════════
    mm.add("(min-width: 768px)", () => {
      // ── Lenis smooth scroll ──────────────────────────────────────────
      const lenis = new Lenis({
        duration: 1.4,
        easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        orientation: "vertical",
        gestureOrientation: "vertical",
        smoothWheel: true,
        wheelMultiplier: 0.8,
        touchMultiplier: 1.5,
      });

      lenis.on("scroll", ScrollTrigger.update);
      gsap.ticker.add((time) => lenis.raf(time * 1000));
      gsap.ticker.lagSmoothing(0, 0);

      const track = trackRef.current!;

      // ── Scroll distance ────────────────────────────────────────────────
      // Dynamic: exactly how much the track overflows the viewport.
      const getScrollDistance = () => -(track.scrollWidth - window.innerWidth);

      // ── Main horizontal tween (Foreground track) ──────────────────────
      const scrollDuration = () => "+=" + (window.innerWidth * 3); // 3 viewports of scrolling (faster, smoother)

      const horizontalTween = gsap.to(track, {
        x: getScrollDistance,
        ease: "none",
        scrollTrigger: {
          trigger: masterRef.current,
          pin: true,
          scrub: true, /* MUST be true (not a number) for containerAnimation to work properly with Lenis */
          end: scrollDuration,
          invalidateOnRefresh: true,
          anticipatePin: 1,
          onUpdate(self) {
            setActiveChapter(
              Math.round(self.progress * (NUM_CHAPTERS - 1))
            );
          },
        },
      });

      // ── Perfect aspect-ratio background panning ───────────────────────
      // Instead of relying on background-size: cover (which zooms aggressively),
      // we use 100vh images. We calculate exactly how much overflow they have,
      // and translate them by precisely that amount.

      // Layer 1: Furthest background (pans slower for depth)
      if (img1Ref.current) {
        gsap.to(img1Ref.current, {
          x: () => -(img1Ref.current!.offsetWidth - window.innerWidth) * 0.7, 
          ease: "none",
          scrollTrigger: {
            trigger: masterRef.current,
            scrub: true,
            end: scrollDuration,
            invalidateOnRefresh: true,
          },
        });
      }

      // Layer 2: Midground (pans full distance to exact right edge)
      if (img2Ref.current) {
        gsap.to(img2Ref.current, {
          x: () => -(img2Ref.current!.offsetWidth - window.innerWidth), // Capped at exactly 1.0 so it never leaves a gap
          ease: "none",
          scrollTrigger: {
            trigger: masterRef.current,
            scrub: true,
            end: scrollDuration,
            invalidateOnRefresh: true,
          },
        });
      }

      // ── Per-card animations via containerAnimation ──────────────────
      const cards = gsap.utils.toArray<HTMLElement>(".chapter-card");

      cards.forEach((card) => {
        gsap.set(card, { opacity: 0, y: 50, scale: 0.97 });

        const section = card.closest("section")!;

        ScrollTrigger.create({
          trigger: section,
          containerAnimation: horizontalTween,
          start: "left 85%",
          end: "left 15%",
          onEnter() {
            gsap.to(card, {
              opacity: 1,
              y: 0,
              scale: 1,
              duration: 0.7,
              ease: "power3.out",
            });
          },
          onLeave() {
            gsap.to(card, {
              opacity: 0,
              y: -40,
              scale: 0.97,
              duration: 0.5,
              ease: "power2.in",
            });
          },
          onEnterBack() {
            gsap.to(card, {
              opacity: 1,
              y: 0,
              scale: 1,
              duration: 0.7,
              ease: "power3.out",
            });
          },
          onLeaveBack() {
            gsap.to(card, {
              opacity: 0,
              y: 50,
              scale: 0.97,
              duration: 0.5,
              ease: "power2.in",
            });
          },
        });
      });

      return () => {
        lenis.destroy();
      };
    });

    // ══ MOBILE — stacked vertical fallback ════════════════════════════════
    mm.add("(max-width: 767px)", () => {
      const cards = gsap.utils.toArray<HTMLElement>(".chapter-card");
      cards.forEach((card, i) => {
        gsap.set(card, { opacity: 0, y: 40 });
        ScrollTrigger.create({
          trigger: card,
          start: "top 82%",
          onEnter: () => {
            gsap.to(card, {
              opacity: 1,
              y: 0,
              duration: 0.8,
              ease: "power3.out",
            });
            setActiveChapter(i);
          },
          onEnterBack: () => setActiveChapter(i),
        });
      });
    });
  }, { scope: masterRef });

  return (
    <>
      {/* Fixed progress nav — outside the pin so it stays visible */}
      <ProgressNavigation
        chapters={CHAPTERS.map((c) => c.subtitle.split(" — ")[1])}
        activeChapter={activeChapter}
        chapterCount={NUM_CHAPTERS}
      />

      {/* ── Pinned master wrapper ───────────────────────────────────────── */}
      <div className={styles.pinMaster} ref={masterRef}>
        
        {/* Fixed Viewport Layers for Parallax Images */}
        <div className={styles.fixedLayer}>
          <img 
            ref={img1Ref}
            src="/images/scroll1.png" 
            alt="" 
            className={styles.parallaxImg}
            aria-hidden="true" 
          />
        </div>
        
        <div className={styles.fixedLayer}>
          <img 
            ref={img2Ref}
            src="/images/scroll2.png" 
            alt="" 
            className={styles.parallaxImg}
            aria-hidden="true" 
          />
        </div>

        {/* ── The ultra-wide horizontal track (Cards) ───────────────────── */}
        <div className={styles.horizontalTrack} ref={trackRef}>
          {/* Layer 2: Floating particles / fog */}
          <ParticlesLayer />

          {/* Layer 2: Chapter sections with glassmorphic cards */}
          {CHAPTERS.map((chapter, i) => (
            <section
              key={i}
              className={styles.chapter}
              aria-label={`Chapter ${i + 1}: ${chapter.title}`}
            >
              <ChapterCard
                title={chapter.title}
                subtitle={chapter.subtitle}
                align={chapter.align}
              >
                <p>{chapter.content}</p>
              </ChapterCard>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
