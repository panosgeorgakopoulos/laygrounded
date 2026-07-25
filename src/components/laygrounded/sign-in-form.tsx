"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import styles from "@/app/Auth.module.css";

// Only ever follow a same-site, path-only destination. An open `next` that
// accepted an absolute URL would let a crafted sign-in link bounce the user to
// an attacker's page after a real login — and this form is reached from the
// OAuth consent flow, which is exactly where that would be abused.
function safeNext(raw: string | null): string {
  if (!raw) return "/claims";
  // Must be a single leading slash (a relative path), not "//host" or a scheme.
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/claims";
  return raw;
}

export function SignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setLoading(false);
    if (signInError) {
      setError("Invalid email or password.");
      return;
    }
    router.push(safeNext(searchParams.get("next")));
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className={styles.form}>
      <div className={styles.inputGroup}>
        <label className={styles.label}>
          Email
        </label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={styles.input}
          placeholder="captain@fleet.com"
        />
      </div>
      <div className={styles.inputGroup}>
        <label className={styles.label}>
          Password
        </label>
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={styles.input}
        />
      </div>
      {error && (
        <div className={styles.errorText}>
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={loading}
        className={styles.submitButton}
      >
        {loading ? "Signing in…" : "Sign in"}
      </button>

      <div className={styles.divider}>
        <div className={styles.dividerLine}>
          <div className={styles.dividerLineInner} />
        </div>
        <div className={styles.dividerContent}>
          <span className={styles.dividerText}>or</span>
        </div>
      </div>

      <button
        type="button"
        onClick={() => {
          setEmail("demo2@laygrounded.com");
          setPassword("demo1234");
        }}
        className={styles.secondaryButton}
      >
        Use demo credentials
      </button>
    </form>
  );
}
