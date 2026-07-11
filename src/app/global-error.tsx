"use client";

import { useEffect } from "react";
import { Button } from "@/components/core/Button";
import { AlertOctagon, RefreshCw } from "lucide-react";
import "./globals.css";

const logger = {
  error: (payload: { error: Error; digest?: string; context: string }) => {
    const logEntry = {
      level: "critical",
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

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logger.error({ error, digest: error.digest, context: "GlobalErrorBoundary" });
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>
        <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", backgroundColor: "#0f172a" }}>
          <div style={{ maxWidth: "480px", width: "100%", padding: "2.5rem", backgroundColor: "#1e293b", borderRadius: "12px", border: "1px solid #334155", boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.5)" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: "1.5rem", color: "#ef4444" }}>
              <AlertOctagon size={56} />
            </div>
            <h2 style={{ fontSize: "1.5rem", fontWeight: 600, textAlign: "center", marginBottom: "0.75rem", color: "#f8fafc" }}>
              Critical System Failure
            </h2>
            <p style={{ color: "#94a3b8", textAlign: "center", marginBottom: "2rem", lineHeight: 1.6 }}>
              A fatal error occurred at the root layout level. Telemetry has been dispatched to engineering.
            </p>
            
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <Button onClick={() => reset()} variant="primary" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem", width: "100%", padding: "0.75rem" }}>
                <RefreshCw size={18} />
                Hard Reset
              </Button>
            </div>

            {error.digest && (
              <div style={{ marginTop: "2rem", paddingTop: "1.25rem", borderTop: "1px solid #334155", fontSize: "0.75rem", color: "#64748b", textAlign: "center", fontFamily: "monospace", opacity: 0.8 }}>
                Reference ID: {error.digest}
              </div>
            )}
          </div>
        </div>
      </body>
    </html>
  );
}
