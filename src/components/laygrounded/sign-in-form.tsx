"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import styles from "@/app/Auth.module.css";

export function SignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
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
    router.push("/claims");
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
