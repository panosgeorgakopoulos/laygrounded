"use client";

import React, { useEffect, useRef } from "react";
import styles from "./Story.module.css";
import gsap from "gsap";

export function ParticlesLayer() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const particles: HTMLDivElement[] = [];
    const PARTICLE_COUNT = 35;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const el = document.createElement("div");
      el.className = styles.particle;

      // Randomise size, position, opacity
      const size    = Math.random() * 3 + 1.5; // 1.5 – 4.5px
      const x       = Math.random() * 100;      // spread across full 500vw track
      const y       = Math.random() * 100;
      const opacity = Math.random() * 0.35 + 0.08;

      el.style.cssText = `
        width: ${size}px;
        height: ${size}px;
        left: ${x}%;
        top: ${y}%;
        opacity: ${opacity};
      `;

      container.appendChild(el);
      particles.push(el);

      // Each particle drifts independently — slower than any scroll effect
      gsap.to(el, {
        x: `+=${(Math.random() - 0.5) * 80}`,
        y: `+=${(Math.random() - 0.5) * 60}`,
        opacity: `+=${(Math.random() - 0.5) * 0.15}`,
        duration: Math.random() * 12 + 10,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
        delay: Math.random() * 8,
      });
    }

    return () => {
      particles.forEach((p) => p.remove());
    };
  }, []);

  return (
    <div className={styles.particlesLayer} ref={containerRef} aria-hidden="true">
      {/* Cinematic vignette + fog gradient lives here */}
      <div className={styles.fogOverlay} />
    </div>
  );
}
