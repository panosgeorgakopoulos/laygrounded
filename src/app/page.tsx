"use client";

import { LandingNav } from "@/components/laygrounded/landing-nav";
import { StoryScene } from "@/components/laygrounded/story/StoryScene";
import styles from "./Landing.module.css";

export default function Home() {
  return (
    <div className={styles.pageContainer}>
      <LandingNav />
      
      <main>
        <StoryScene />
      </main>

      {/* We can hide the footer or keep it if needed, but in a cinematic full-screen 
          scrolling experience, a standard footer might break immersion. 
          Let's keep it simple at the bottom of the scroll. 
          Actually, since StoryScene handles all 100vh scrolling and pinning, 
          putting the footer after it might cause layout issues.
          Let's remove the standard footer for the cinematic landing. */}
    </div>
  );
}
