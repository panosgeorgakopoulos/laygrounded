"use client";

import React from "react";
import styles from "./Story.module.css";
import gsap from "gsap";
import { ScrollToPlugin } from "gsap/ScrollToPlugin";

// Register ScrollToPlugin for smooth anchor navigation
if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollToPlugin);
}

interface ProgressNavigationProps {
  chapters: string[];
  activeChapter: number;
}

export function ProgressNavigation({ chapters, activeChapter }: ProgressNavigationProps) {
  
  const scrollToChapter = (index: number) => {
    // Determine the scroll position based on chapter index
    // Assuming each chapter takes exactly 100vh of scroll distance in the scroll wrapper
    // The main container has 5 sections, so 500vh total scroll distance.
    const scrollPosition = index * window.innerHeight;
    
    gsap.to(window, {
      duration: 1,
      scrollTo: { y: scrollPosition, autoKill: false },
      ease: "power3.inOut"
    });
  };

  return (
    <nav className={styles.progressNav} aria-label="Story Chapters">
      <ul className={styles.progressList}>
        {chapters.map((title, i) => (
          <li key={i} className={styles.progressItem}>
            <button
              onClick={() => scrollToChapter(i)}
              className={`${styles.progressDot} ${activeChapter === i ? styles.progressDotActive : ""}`}
              aria-label={`Scroll to ${title}`}
              aria-current={activeChapter === i ? "step" : undefined}
            >
              <span className={styles.progressLabel}>{title}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
