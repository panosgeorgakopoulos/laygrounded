"use client";

import Link from "next/link";
import { useAuth } from "@/components/providers";

export function LandingNav() {
  const { data: session } = useAuth();
  return (
    <header className="sticky top-0 z-40 border-b border-[#1f2937] bg-[#0a0f1e]/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 min-w-0">
          <span
            className="inline-block h-2 w-2 rounded-full shrink-0"
            style={{ background: "#f59e0b" }}
          />
          <span
            className="text-lg font-semibold tracking-tight truncate"
            style={{ fontFamily: "var(--font-space-grotesk)" }}
          >
            LayGrounded
          </span>
        </Link>
        <nav className="flex items-center gap-3 text-sm">
          {session?.user ? (
            <Link
              href="/claims"
              className="border border-[#1f2937] bg-[#111827] px-3 py-2 sm:py-1.5 min-h-[36px] flex items-center text-[#f9fafb] transition hover:border-[#f59e0b]"
              style={{ borderRadius: 2 }}
            >
              Open Dashboard
            </Link>
          ) : (
            <>
              <Link
                href="/sign-in"
                className="px-3 py-2 sm:py-1.5 min-h-[36px] flex items-center text-[#9ca3af] transition hover:text-[#f9fafb]"
              >
                Sign In
              </Link>
              {/* CTA hidden on mobile — only the hero CTA is shown to phone users */}
              <Link
                href="/sign-up"
                className="hidden md:inline-block px-3 py-1.5 text-[#0a0f1e] font-medium transition hover:opacity-90"
                style={{
                  background: "#f59e0b",
                  borderRadius: 2,
                }}
              >
                Initialize Claim Workspace
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
