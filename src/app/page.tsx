"use client";

import { LandingNav } from "@/components/laygrounded/landing-nav";
import { HeroSection } from "@/components/laygrounded/hero/HeroSection";
import { StoryScene } from "@/components/laygrounded/story/StoryScene";
import { Footer } from "@/components/laygrounded/footer/Footer";
import styles from "./Landing.module.css";

export default function Home() {
  return (
    <div className={styles.pageContainer} data-theme="dark">
      <LandingNav />
      
      <main className={styles.mainContent}>
        <HeroSection />
        <StoryScene />
      </main>
      
      <Footer />
    </div>
  );
}
