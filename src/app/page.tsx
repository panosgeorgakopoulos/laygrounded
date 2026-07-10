"use client";

import { HeroSection } from "@/components/laygrounded/hero/HeroSection";
import { StoryScene } from "@/components/laygrounded/story/StoryScene";
import { Footer } from "@/components/laygrounded/footer/Footer";
import styles from "./Landing.module.css";

export default function Home() {
  return (
    <div className={styles.pageContainer} data-theme="dark">
      
      <main className={styles.mainContent}>
        <HeroSection />
        <StoryScene />
      </main>
      
      <Footer />
    </div>
  );
}
