"use client";

import React from "react";
import styles from "./Story.module.css";
import gsap from "gsap";
import { ScrollToPlugin } from "gsap/ScrollToPlugin";

gsap.registerPlugin(ScrollToPlugin);

interface ProgressNavigationProps {
  chapters: string[];
  activeChapter: number;
  chapterCount: number;
}

export function ProgressNavigation({
  chapters,
  activeChapter,
  chapterCount,
}: ProgressNavigationProps) {
  const scrollToChapter = (index: number) => {
    // The total scroll distance GSAP creates is equal to the track width:
    // trackWidth = chapterCount × 100vw, so total extra scroll = (chapterCount - 1) × 100vw
    // Each chapter maps to 1 × 100vw of scroll.
    const chapterScrollHeight = window.innerWidth; // 100vw scroll per chapter
    const targetY = index * chapterScrollHeight;

    gsap.to(window, {
      duration: 1.1,
      scrollTo: { y: targetY, autoKill: false },
      ease: "power3.inOut",
    });
  };

  return (
    <nav className={styles.progressNav} aria-label="Story chapters">
      <ul className={styles.progressList}>
        {chapters.map((label, i) => (
          <li key={i} className={styles.progressItem}>
            <button
              onClick={() => scrollToChapter(i)}
              className={`${styles.progressDot} ${
                activeChapter === i ? styles.progressDotActive : ""
              }`}
              aria-label={`Go to chapter ${i + 1}: ${label}`}
              aria-current={activeChapter === i ? "step" : undefined}
            >
              <span className={styles.progressLabel}>{label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
