import React from "react";
import styles from "./Hero.module.css";
import Link from "next/link";
import { CargoShipsBackground } from "./CargoShipsBackground";

export function HeroSection() {
  return (
    <section className={styles.heroSection}>
      <CargoShipsBackground />
      <div className={styles.content}>
        <h1 className={styles.title}>
          The Tier-1 Maritime Financial Network
        </h1>
        <p className={styles.subtitle}>
          Drop your Statement of Facts PDF into a claim workspace. 
          Our vision models extract events, apply GENCON 94 & ASBATANKVOY logic, 
          and leverage predictive oracles and agentic drafters to settle claims instantly.
        </p>
        <div className={styles.ctaWrapper}>
          <Link href="/sign-up" className={styles.primaryCta}>
            Get Started
          </Link>
          <a href="#how-it-works" className={styles.secondaryCta}>
            See How It Works
          </a>
        </div>
      </div>
    </section>
  );
}
