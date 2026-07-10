"use client";

import React, { useRef, useState, useEffect } from "react";
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

// ─── Chapter Data ───────────────────────────────────────────────────────────
const CHAPTERS = [
  {
    title: "The Crane",
    subtitle: "01 — Intake",
    content:
      "Automated extraction of SOF data right at the source. Eliminate manual entry and human error before they compound downstream.",
    align: "left" as const,
  },
  {
    title: "The Ship",
    subtitle: "02 — Analysis",
    content:
      "Instantly cross-reference voyage details with charterparty clauses, NOR tenders, and SHEX exceptions. Every hour accounted for.",
    align: "right" as const,
  },
  {
    title: "Solar Infrastructure",
    subtitle: "03 — Processing",
    content:
      "Our AI engines handle complex weather delays, pumping logs, and port congestion with perfect precision at industrial scale.",
    align: "left" as const,
  },
  {
    title: "The Containers",
    subtitle: "04 — Output",
    content:
      "Generate defensible, perfectly formatted Laytime & Demurrage statements ready for arbitration. Zero ambiguity.",
    align: "right" as const,
  },
  {
    title: "The City",
    subtitle: "05 — Resolution",
    content:
      "Connect your entire fleet's data to a centralized intelligence hub. Stop leaving money on the table.",
    align: "left" as const,
  },
];

const NUM_CHAPTERS = CHAPTERS.length;

// ─── Component ───────────────────────────────────────────────────────────────
export function StoryScene() {
  const masterRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [activeChapter, setActiveChapter] = useState(0);

  useGSAP(() => {
    if (!masterRef.current || !trackRef.current) return;

    // ── Lenis smooth scroll (desktop only via matchMedia) ──────────────────
    let lenis: Lenis | null = null;

    const mm = gsap.matchMedia();

    // ══ DESKTOP ════════════════════════════════════════════════════════════
    mm.add("(min-width: 768px)", () => {
      lenis = new Lenis({
        duration: 1.2,
        easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        orientation: "vertical",
        gestureOrientation: "vertical",
        smoothWheel: true,
        wheelMultiplier: 1,
        touchMultiplier: 2,
      });

      // Bridge Lenis → ScrollTrigger
      lenis.on("scroll", ScrollTrigger.update);
      gsap.ticker.add((time) => lenis!.raf(time * 1000));
      gsap.ticker.lagSmoothing(0, 0);

      const track = trackRef.current!;

      // ── Main horizontal translation ────────────────────────────────────
      // Move the entire track left by (trackWidth - viewportWidth).
      // xPercent: -80 is identical to translating by -400vw for 500vw track.
      const mainTween = gsap.to(track, {
        xPercent: -100 * (NUM_CHAPTERS - 1) / NUM_CHAPTERS,
        ease: "none",
        scrollTrigger: {
          trigger: masterRef.current,
          pin: true,
          scrub: 1.5,
          snap: {
            snapTo: 1 / (NUM_CHAPTERS - 1),
            duration: { min: 0.2, max: 0.5 },
            delay: 0.1,
            ease: "power1.inOut",
          },
          end: () => "+=" + track.offsetWidth,
          onUpdate(self) {
            const idx = Math.round(self.progress * (NUM_CHAPTERS - 1));
            setActiveChapter(idx);
          },
        },
      });

      // ── Per-chapter card animations (keyed to the main ST progress) ────
      // We don't embed these in the main tween; we use onUpdate to drive
      // them so they respect the same scrub timing.
      const cards = gsap.utils.toArray<HTMLElement>(".chapter-card");

      cards.forEach((card, i) => {
        gsap.set(card, { y: 60, opacity: 0, scale: 0.96 });
      });

      const ST = mainTween.scrollTrigger!;

      // We create a standalone ScrollTrigger per chapter window
      // start/end are fractions of the overall scroll distance.
      const totalScrollPx = track.offsetWidth; // same as ST end offset

      cards.forEach((card, i) => {
        const chapterFraction = 1 / NUM_CHAPTERS;
        const center = i * chapterFraction + chapterFraction / 2;

        // Appear window: centre ± 30% of one chapter width
        const fadeInStart  = Math.max(0, center - chapterFraction * 0.40);
        const fadeInEnd    = center;
        const fadeOutStart = center + chapterFraction * 0.05;
        const fadeOutEnd   = Math.min(1, center + chapterFraction * 0.45);

        // Convert fractions → pixel offsets for this ST instance
        const toOffset = (frac: number) =>
          `+=${(ST.start as number) + frac * totalScrollPx}`;

        // Fade-in
        ScrollTrigger.create({
          trigger: document.body,
          start: toOffset(fadeInStart),
          end: toOffset(fadeInEnd),
          scrub: 1.5,
          onUpdate(self) {
            gsap.set(card, {
              y: gsap.utils.interpolate(60, 0, self.progress),
              opacity: gsap.utils.interpolate(0, 1, self.progress),
              scale: gsap.utils.interpolate(0.96, 1, self.progress),
            });
          },
        });

        // Fade-out (not for last card)
        if (i < NUM_CHAPTERS - 1) {
          ScrollTrigger.create({
            trigger: document.body,
            start: toOffset(fadeOutStart),
            end: toOffset(fadeOutEnd),
            scrub: 1.5,
            onUpdate(self) {
              gsap.set(card, {
                y: gsap.utils.interpolate(0, -60, self.progress),
                opacity: gsap.utils.interpolate(1, 0, self.progress),
                scale: gsap.utils.interpolate(1, 0.96, self.progress),
              });
            },
          });
        }
      });

      return () => {
        lenis?.destroy();
        lenis = null;
      };
    });

    // ══ MOBILE (stacked vertical fallback) ════════════════════════════════
    mm.add("(max-width: 767px)", () => {
      const cards = gsap.utils.toArray<HTMLElement>(".chapter-card");
      cards.forEach((card, i) => {
        gsap.fromTo(
          card,
          { y: 40, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.8,
            ease: "power3.out",
            scrollTrigger: {
              trigger: card,
              start: "top 82%",
              toggleActions: "play none none reverse",
              onEnter: () => setActiveChapter(i),
              onEnterBack: () => setActiveChapter(i),
            },
          }
        );
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

        {/* ── The ultra-wide horizontal track ───────────────────────────── */}
        <div className={styles.horizontalTrack} ref={trackRef}>

          {/* Layer 0: Panoramic background (CSS background-image) */}
          <div className={styles.parallaxBackground} aria-hidden="true" />

          {/* Layer 1: Middle depth — particles & fog */}
          <ParticlesLayer />

          {/* Layer 2: Five chapter sections with glassmorphic cards */}
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
