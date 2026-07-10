"use client";

import { useEffect, useState } from "react";
import styles from "./OfflineIndicator.module.css";

export function OfflineIndicator() {
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    // Only run on the client side
    if (typeof window === "undefined") return;

    function handleOnline() {
      setIsOffline(false);
    }
    
    function handleOffline() {
      setIsOffline(true);
    }

    // Set initial state
    setIsOffline(!navigator.onLine);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (!isOffline) return null;

  return (
    <div className={styles.container} role="alert">
      <svg className={styles.icon} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.58 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"></path>
      </svg>
      <div className={styles.textContainer}>
        <span className={styles.title}>You are offline</span>
        <span className={styles.subtitle}>Please check your network connection.</span>
      </div>
    </div>
  );
}
