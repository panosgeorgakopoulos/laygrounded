"use client";

import React, { useEffect, useRef } from "react";
import styles from "./Story.module.css";
import gsap from "gsap";

export function ParticlesLayer() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    
    // Create random particles
    const particlesCount = 40;
    const container = containerRef.current;
    
    for (let i = 0; i < particlesCount; i++) {
      const particle = document.createElement("div");
      particle.className = styles.particle;
      
      // Random properties
      const size = Math.random() * 4 + 2; // 2px to 6px
      const x = Math.random() * 100; // 0 to 100vw
      const y = Math.random() * 100; // 0 to 100vh
      const opacity = Math.random() * 0.4 + 0.1;
      
      particle.style.width = `${size}px`;
      particle.style.height = `${size}px`;
      particle.style.left = `${x}vw`;
      particle.style.top = `${y}vh`;
      particle.style.opacity = opacity.toString();
      
      container.appendChild(particle);
      
      // Slow float animation independent of scroll
      gsap.to(particle, {
        y: `+=${Math.random() * 100 - 50}`,
        x: `+=${Math.random() * 50 - 25}`,
        rotation: Math.random() * 360,
        duration: Math.random() * 10 + 10,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut"
      });
    }

    return () => {
      if (container) {
        container.innerHTML = "";
      }
    };
  }, []);

  return (
    <div className={styles.particlesLayer} ref={containerRef} aria-hidden="true">
      <div className={styles.fogOverlay}></div>
    </div>
  );
}
