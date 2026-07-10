"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import styles from "@/app/Auth.module.css";

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
    <form onSubmit={onSubmit} className={styles.form}>
      <div className={styles.inputGroup}>
        <label className={styles.label}>
          Your name
        </label>
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={styles.input}
        />
      </div>
      <div className={styles.inputGroup}>
        <label className={styles.label}>
          Company / Fleet name
        </label>
        <input
          type="text"
          required
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          className={styles.input}
        />
      </div>
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
        />
      </div>
      <div className={styles.inputGroup}>
        <label className={styles.label}>
          Password
        </label>
        <input
          type="password"
          required
          minLength={8}
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
        {loading ? "Creating workspace…" : "Initialize workspace"}
      </button>
    </form>
  );
}
