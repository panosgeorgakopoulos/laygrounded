"use client";

import { LandingNav } from "@/components/laygrounded/landing-nav";
import { StoryScene } from "@/components/laygrounded/story/StoryScene";
import styles from "./Landing.module.css";

export default function Home() {
  return (
    <div className={styles.pageContainer} data-theme="dark">
      <LandingNav />
      
      <main className={styles.mainContent}>
        <StoryScene />
      </main>
    </div>
  );
}
