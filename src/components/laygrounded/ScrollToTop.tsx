"use client";

import { useEffect, useRef, useCallback } from "react";
import gsap from "gsap";
import styles from "./ScrollToTop.module.css";

/*
  Yacht silhouette — side view (bow left, stern right) in a 124×68 viewBox.
  Path starts at the stern bottom and traces the FULL exterior perimeter:
  stern bottom → hull underside → bow tip → bow face → forward deck →
  cabin front → cabin roof → chimney → cabin aft → aft deck → stern transom → close.
  This ordering makes the stroke "draw" from stern toward the bow as progress increases.
*/
const YACHT_PATH =
  "M102,54 C80,60 40,60 6,50 L2,44 C2,36 8,30 18,28 L40,26 L46,14 L72,14 L74,8 L80,8 L82,14 L88,14 L88,26 L102,26 L102,54 Z";

export function ScrollToTop() {
  const wrapperRef  = useRef<HTMLDivElement>(null);
  const svgRef      = useRef<SVGSVGElement>(null);
  const progressRef = useRef<SVGPathElement>(null);
  const wake1Ref    = useRef<SVGPathElement>(null);
  const wake2Ref    = useRef<SVGPathElement>(null);
  const wake3Ref    = useRef<SVGPathElement>(null);

  // Lerp state (all refs to avoid re-renders on every frame)
  const scrollTarget   = useRef(0);
  const scrollCurrent  = useRef(0);
  const pathLength     = useRef(0);
  const rafId          = useRef<number | null>(null);
  const rockTl         = useRef<gsap.core.Timeline | null>(null);
  const isVisible      = useRef(false);
  const lastScrollY    = useRef(0);
  const velocityTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ── 1. Measure path & init stroke on mount ─────────────────────────── */
  useEffect(() => {
    const path = progressRef.current;
    if (!path) return;
    const len = path.getTotalLength();
    pathLength.current = len;
    // Full dasharray = full perimeter; start fully hidden (offset = full length)
    path.style.strokeDasharray = String(len);
    path.style.strokeDashoffset = String(len);
  }, []);

  /* ── 2. Lerp RAF loop — runs for entire component lifetime ──────────── */
  useEffect(() => {
    const tick = () => {
      const diff = scrollTarget.current - scrollCurrent.current;
      if (Math.abs(diff) > 0.0002) {
        scrollCurrent.current += diff * 0.08; // lerp factor
        const path = progressRef.current;
        const len  = pathLength.current;
        if (path && len > 0) {
          path.style.strokeDashoffset = String(len * (1 - scrollCurrent.current));
        }
      }
      rafId.current = requestAnimationFrame(tick);
    };
    rafId.current = requestAnimationFrame(tick);
    return () => {
      if (rafId.current) cancelAnimationFrame(rafId.current);
      rockTl.current?.kill();
    };
  }, []);

  /* ── 3. Idle rocking ─────────────────────────────────────────────────── */
  const startRocking = useCallback(() => {
    rockTl.current?.kill();
    const svg = svgRef.current;
    if (!svg) return;
    rockTl.current = gsap.timeline({ repeat: -1, repeatDelay: 4 })
      .to(svg, { rotation: -2, duration: 0.7, ease: "sine.inOut", transformOrigin: "50% 100%" })
      .to(svg, { rotation: 2,  duration: 1.2, ease: "sine.inOut" })
      .to(svg, { rotation: 0,  duration: 0.7, ease: "sine.inOut" });
  }, []);

  /* ── 4. Show / hide ──────────────────────────────────────────────────── */
  const showButton = useCallback(() => {
    if (isVisible.current) return;
    isVisible.current = true;
    const el = wrapperRef.current;
    if (!el) return;
    el.style.pointerEvents = "auto";
    gsap.to(el, {
      opacity: 1, y: 0, filter: "blur(0px)",
      duration: 0.5, ease: "power3.out",
      onComplete: startRocking,
    });
  }, [startRocking]);

  const hideButton = useCallback(() => {
    if (!isVisible.current) return;
    isVisible.current = false;
    rockTl.current?.pause();
    const el  = wrapperRef.current;
    const svg = svgRef.current;
    if (!el) return;
    el.style.pointerEvents = "none";
    // Arrival bounce before fade-out
    gsap.timeline()
      .to(svg, { y: 5, duration: 0.12, ease: "power2.in" })
      .to(svg, { y: 0, duration: 0.18, ease: "bounce.out" })
      .to(el,  { opacity: 0, y: 15, filter: "blur(6px)", duration: 0.3, ease: "power3.in" }, ">0.06");
  }, []);

  /* ── 5. Scroll tracking ──────────────────────────────────────────────── */
  const handleScroll = useCallback(() => {
    const scrollY = window.scrollY;
    const docH    = document.documentElement.scrollHeight - window.innerHeight;

    // Wake velocity
    const velocity = Math.abs(scrollY - lastScrollY.current);
    lastScrollY.current = scrollY;
    const wakeOpacity = Math.min(velocity / 25, 1);
    const wakes = [wake1Ref, wake2Ref, wake3Ref];
    wakes.forEach((ref, i) => {
      if (ref.current) {
        gsap.to(ref.current, {
          opacity: 0.04 + wakeOpacity * (0.22 - i * 0.05),
          duration: 0.2,
          overwrite: true,
        });
      }
    });
    // Decay wake when scrolling stops
    if (velocityTimer.current) clearTimeout(velocityTimer.current);
    velocityTimer.current = setTimeout(() => {
      wakes.forEach((ref, i) => {
        if (ref.current) {
          gsap.to(ref.current, { opacity: 0.04 - i * 0.01, duration: 1.0, overwrite: true });
        }
      });
    }, 180);

    if (docH <= 0) { scrollTarget.current = 0; hideButton(); return; }
    scrollTarget.current = Math.min(scrollY / docH, 1);
    if (scrollY > 250) showButton(); else hideButton();
  }, [showButton, hideButton]);

  useEffect(() => {
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (velocityTimer.current) clearTimeout(velocityTimer.current);
    };
  }, [handleScroll]);

  /* ── 6. Hover ────────────────────────────────────────────────────────── */
  const handleMouseEnter = useCallback(() => {
    rockTl.current?.pause();
    const svg = svgRef.current;
    if (!svg) return;
    gsap.to(svg, {
      scale: 1.08, rotation: -3,
      duration: 0.35, ease: "power2.out",
      transformOrigin: "50% 100%",
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    gsap.to(svg, {
      scale: 1, rotation: 0, duration: 0.5, ease: "elastic.out(1, 0.55)",
      transformOrigin: "50% 100%",
      onComplete: () => { if (isVisible.current) startRocking(); },
    });
  }, [startRocking]);

  /* ── 7. Click ────────────────────────────────────────────────────────── */
  const handleClick = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    gsap.timeline()
      .to(svg, { y: -12, duration: 0.13, ease: "power2.in" })
      .to(svg, { y: 2,   duration: 0.09, ease: "power2.out" })
      .to(svg, { y: 0,   duration: 0.28, ease: "elastic.out(1, 0.5)" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return (
    <div
      ref={wrapperRef}
      className={styles.wrapper}
      style={{ opacity: 0, transform: "translateY(15px)", filter: "blur(6px)", pointerEvents: "none" }}
    >
      <button
        className={styles.button}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        aria-label="Scroll to top"
      >
        <svg
          ref={svgRef}
          viewBox="0 0 124 68"
          className={styles.yachtSvg}
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <defs>
            {/* Gradient for the progress stroke: teal → sky blue matching the app accent */}
            <linearGradient id="yachtProgressGrad" x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%"   stopColor="#4FE3D2" />
              <stop offset="100%" stopColor="#5BC8FF" />
            </linearGradient>
            {/* Glow filter for progress stroke */}
            <filter id="yachtGlowFilter" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="2.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* 1. Background track — always visible, faint */}
          <path
            d={YACHT_PATH}
            className={styles.trackPath}
          />

          {/* 2. Progress stroke — animated via JS dashoffset */}
          <path
            ref={progressRef}
            d={YACHT_PATH}
            className={styles.progressPath}
            stroke="url(#yachtProgressGrad)"
            filter="url(#yachtGlowFilter)"
          />

          {/* 3. Cabin windows — illuminate on hover via CSS */}
          <rect x="48" y="16" width="8" height="6" rx="1.5" className={styles.window} />
          <rect x="59" y="16" width="8" height="6" rx="1.5" className={styles.window} />
          <rect x="70" y="16" width="8" height="6" rx="1.5" className={styles.window} />

          {/* 4. Wake lines — opacity driven by scroll velocity via JS */}
          <path ref={wake1Ref} d="M106,33 C110,31 114,33 118,31" className={styles.wake} style={{ opacity: 0.04 }} />
          <path ref={wake2Ref} d="M107,39 C111,37 115,39 119,37" className={styles.wake} style={{ opacity: 0.03 }} />
          <path ref={wake3Ref} d="M106,45 C110,43 114,45 118,43" className={styles.wake} style={{ opacity: 0.02 }} />
        </svg>
      </button>
    </div>
  );
}
