"use client";

import { useState, useEffect } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

export function SignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  // Pre-create the demo user (idempotent) so the "Use demo credentials" button works.
  useEffect(() => {
    fetch("/api/init-demo", { method: "POST" }).catch(() => {});
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
    setLoading(false);
    if (res?.error) {
      setError("Invalid email or password.");
      return;
    }
    router.push("/claims");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label className="block text-xs uppercase tracking-wider text-[#9ca3af] mb-2" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
          Email
        </label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full bg-[#111827] border border-[#1f2937] px-3 py-2 text-[#f9fafb] focus:outline-none focus:border-[#f59e0b]"
          style={{ borderRadius: 2 }}
          placeholder="captain@fleet.com"
        />
      </div>
      <div>
        <label className="block text-xs uppercase tracking-wider text-[#9ca3af] mb-2" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
          Password
        </label>
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full bg-[#111827] border border-[#1f2937] px-3 py-2 text-[#f9fafb] focus:outline-none focus:border-[#f59e0b]"
          style={{ borderRadius: 2 }}
        />
      </div>
      {error && (
        <div className="text-xs text-[#ef4444]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={loading}
        className="w-full px-4 py-3 min-h-[48px] text-[#0a0f1e] font-medium transition hover:opacity-90 disabled:opacity-50"
        style={{ background: "#f59e0b", borderRadius: 2 }}
      >
        {loading ? "Signing in…" : "Sign in"}
      </button>

      <div className="relative py-2">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-[#1f2937]" />
        </div>
        <div className="relative flex justify-center text-xs">
          <span className="bg-[#0a0f1e] px-3 text-[#6b7280]">or</span>
        </div>
      </div>

      <button
        type="button"
        onClick={() => {
          setEmail("demo@laygrounded.io");
          setPassword("demo1234");
        }}
        className="w-full px-4 py-3 min-h-[48px] border border-[#1f2937] bg-[#111827] text-[#f9fafb] transition hover:border-[#f59e0b]"
        style={{ borderRadius: 2 }}
      >
        Use demo credentials
      </button>
    </form>
  );
}
