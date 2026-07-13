"use client";

import { useSyncExternalStore } from "react";
import styles from "./OfflineIndicator.module.css";

// navigator.onLine exposed as an external store: no state, no effect. The
// server snapshot reports "online", so SSR renders nothing and the client
// corrects itself immediately after hydration if actually offline.
function subscribeToNetwork(onStoreChange: () => void): () => void {
  window.addEventListener("online", onStoreChange);
  window.addEventListener("offline", onStoreChange);
  return () => {
    window.removeEventListener("online", onStoreChange);
    window.removeEventListener("offline", onStoreChange);
  };
}

export function OfflineIndicator() {
  const isOnline = useSyncExternalStore(
    subscribeToNetwork,
    () => navigator.onLine,
    () => true
  );

  if (isOnline) return null;

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
