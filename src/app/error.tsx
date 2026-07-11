"use client";

import { useEffect } from "react";
import { Button } from "@/components/core/Button";
import Link from "next/link";
import { AlertTriangle, Home, RefreshCw } from "lucide-react";

const logger = {
  error: (payload: { error: Error; digest?: string; context: string }) => {
    const logEntry = {
      level: "error",
      timestamp: new Date().toISOString(),
      context: payload.context,
      digest: payload.digest,
      errorName: payload.error?.name,
      errorMessage: payload.error?.message,
      stack: payload.error?.stack,
    };
    // Outputs strict JSON for Datadog/Sentry sink simulation
    console.error(JSON.stringify(logEntry));
  }
};

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logger.error({ error, digest: error.digest, context: "AppErrorBoundary" });
  }, [error]);

  return (
    <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", backgroundColor: "var(--color-bg-base)" }}>
      <div style={{ maxWidth: "480px", width: "100%", padding: "2.5rem", backgroundColor: "var(--color-bg-surface)", borderRadius: "12px", border: "1px solid var(--color-border)", boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: "1.5rem", color: "var(--color-danger)" }}>
          <AlertTriangle size={56} />
        </div>
        <h2 style={{ fontSize: "1.5rem", fontWeight: 600, textAlign: "center", marginBottom: "0.75rem", color: "var(--color-text-primary)" }}>
          System Exception Intercepted
        </h2>
        <p style={{ color: "var(--color-text-secondary)", textAlign: "center", marginBottom: "2rem", lineHeight: 1.6 }}>
          An unexpected disruption occurred while processing your request. Our telemetry systems have securely logged the failure.
        </p>
        
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <Button onClick={() => reset()} variant="primary" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem", width: "100%", padding: "0.75rem" }}>
            <RefreshCw size={18} />
            Attempt Recovery
          </Button>
          <Link href="/claims" passHref style={{ width: "100%", textDecoration: "none" }}>
            <Button variant="secondary" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem", width: "100%", padding: "0.75rem" }}>
              <Home size={18} />
              Return to Dashboard
            </Button>
          </Link>
        </div>

        {error.digest && (
          <div style={{ marginTop: "2rem", paddingTop: "1.25rem", borderTop: "1px solid var(--color-border)", fontSize: "0.75rem", color: "var(--color-text-tertiary)", textAlign: "center", fontFamily: "monospace", opacity: 0.8 }}>
            Reference ID: {error.digest}
          </div>
        )}
      </div>
    </div>
  );
}
