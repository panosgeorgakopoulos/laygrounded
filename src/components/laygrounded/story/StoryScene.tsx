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
  const img1Ref = useRef<HTMLImageElement>(null);
  const img2Ref = useRef<HTMLImageElement>(null);
  const [activeChapter, setActiveChapter] = useState(0);

  useGSAP(() => {
    if (!masterRef.current) return;

    const mm = gsap.matchMedia();

    // ══ DESKTOP ════════════════════════════════════════════════════════════
    mm.add("(min-width: 768px)", () => {
      const scrollDuration = () => "+=" + (window.innerWidth * 3.5); // 3.5 viewports of scrolling

      // ── Main Scene Pin & Progress Tracker ──────────────────────────────
      ScrollTrigger.create({
        trigger: masterRef.current,
        pin: true,
        scrub: 1, // 1-second smoothing (replaces Lenis)
        end: scrollDuration,
        invalidateOnRefresh: true,
        anticipatePin: 1,
        onUpdate(self) {
          setActiveChapter(
            Math.round(self.progress * (NUM_CHAPTERS - 1))
          );
        },
      });

      // ── Perfect aspect-ratio background panning ───────────────────────
      // We calculate exactly how much overflow the images have,
      // and translate them by precisely that amount.

      // Layer 1: Furthest background (pans slower for depth)
      if (img1Ref.current) {
        gsap.to(img1Ref.current, {
          x: () => {
            const overflow = img1Ref.current!.offsetWidth - window.innerWidth;
            return overflow > 0 ? -(overflow * 0.7) : 0;
          }, 
          ease: "none",
          scrollTrigger: {
            trigger: masterRef.current,
            scrub: 1,
            end: scrollDuration,
            invalidateOnRefresh: true,
          },
        });
      }

      // Layer 2: Midground (pans full distance to exact right edge)
      if (img2Ref.current) {
        gsap.to(img2Ref.current, {
          x: () => {
            const overflow = img2Ref.current!.offsetWidth - window.innerWidth;
            return overflow > 0 ? -overflow : 0;
          }, 
          ease: "none",
          scrollTrigger: {
            trigger: masterRef.current,
            scrub: 1,
            end: scrollDuration,
            invalidateOnRefresh: true,
          },
        });
      }

      // Per-card animations are now handled by CSS and activeChapter state!
    });

    // ══ MOBILE — stacked vertical fallback ════════════════════════════════
    mm.add("(max-width: 767px)", () => {
      // For mobile, we just rely on simple scroll triggers to update the active chapter
      const sections = gsap.utils.toArray<HTMLElement>(".mobile-chapter-section");
      sections.forEach((section, i) => {
        ScrollTrigger.create({
          trigger: section,
          start: "top 50%",
          onEnter: () => setActiveChapter(i),
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
            onLoad={() => ScrollTrigger.refresh()}
          />
        </div>
        
        <div className={styles.fixedLayer}>
          <img 
            ref={img2Ref}
            src="/images/scroll2.png" 
            alt="" 
            className={styles.parallaxImg}
            aria-hidden="true" 
            onLoad={() => ScrollTrigger.refresh()}
          />
        </div>

        {/* ── Fixed UI Layer (Crossfading Cards) ─────────────────────────── */}
        <div className={styles.uiLayer}>
          <ParticlesLayer />

          {/* Cards render on top of the panning background */}
          {CHAPTERS.map((chapter, i) => (
            <div
              key={i}
              className={`${styles.fixedCardContainer} mobile-chapter-section`}
              data-active={activeChapter === i}
              aria-label={`Chapter ${i + 1}: ${chapter.title}`}
            >
              <ChapterCard
                title={chapter.title}
                subtitle={chapter.subtitle}
                align={chapter.align}
              >
                <p>{chapter.content}</p>
              </ChapterCard>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
