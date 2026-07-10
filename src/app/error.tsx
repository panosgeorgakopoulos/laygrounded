"use client";

import { useEffect } from "react";
import { Button } from "@/components/core/Button";
import styles from "./Error.module.css";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Optionally log the error to an error reporting service
    console.error(error);
  }, [error]);

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.icon}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
        </div>
        <h2 className={styles.title}>Something went wrong!</h2>
        <p className={styles.message}>
          We encountered an unexpected error while processing your request. Please try again.
        </p>
        <Button onClick={() => reset()} variant="primary">
          Try again
        </Button>
        {error.digest && (
          <p className={styles.digest}>
            Error ID: {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
