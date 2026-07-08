"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

export function SignUpForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name },
      },
    });
    
    if (signUpError) {
      setLoading(false);
      setError(signUpError.message || "Could not create account.");
      return;
    }

    await fetch("/api/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, companyName }),
    });

    setLoading(false);
    router.push("/claims");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label className="block text-xs uppercase tracking-wider text-[#9ca3af] mb-2" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
          Your name
        </label>
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-[#111827] border border-[#1f2937] px-3 py-2 text-[#f9fafb] focus:outline-none focus:border-[#f59e0b]"
          style={{ borderRadius: 2 }}
        />
      </div>
      <div>
        <label className="block text-xs uppercase tracking-wider text-[#9ca3af] mb-2" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
          Company / Fleet name
        </label>
        <input
          type="text"
          required
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          className="w-full bg-[#111827] border border-[#1f2937] px-3 py-2 text-[#f9fafb] focus:outline-none focus:border-[#f59e0b]"
          style={{ borderRadius: 2 }}
        />
      </div>
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
        />
      </div>
      <div>
        <label className="block text-xs uppercase tracking-wider text-[#9ca3af] mb-2" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
          Password
        </label>
        <input
          type="password"
          required
          minLength={8}
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
        {loading ? "Creating workspace…" : "Initialize workspace"}
      </button>
    </form>
  );
}
