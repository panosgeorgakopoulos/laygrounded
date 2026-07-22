"use client";

// Developer / API surface: manage Audit-API keys (session-authenticated),
// register outbound webhooks (which the backend gates behind an API key with
// the webhooks:manage scope, so the user supplies one here), link the
// machine-readable OpenAPI spec, and document the machine-to-machine ingress
// endpoints (voyage telemetry, SoF text, recap onboarding).

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/core/Card";
import styles from "./DeveloperSettings.module.css";

const API_SCOPES = [
  { id: "voyages:write", desc: "push voyage / SoF data in" },
  { id: "calculations:read", desc: "pull laytime calculations" },
  { id: "disputes:read", desc: "pull dispute / proposal status" },
  { id: "webhooks:manage", desc: "register and remove webhooks" },
] as const;

const WEBHOOK_EVENTS = ["time_bar.warning", "time_bar.critical", "time_bar.expired"] as const;

interface ApiKey {
  id: string;
  label: string;
  keyPrefix: string;
  scopes: string[];
  status: string;
  rateLimitPerMinute: number;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface Webhook {
  id: string;
  url: string;
  eventTypes: string[];
  createdAt?: string;
}

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function DeveloperSettings() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Keys
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [rateLimit, setRateLimit] = useState(120);
  const [newKey, setNewKey] = useState<string | null>(null);

  // Webhooks (require a Bearer key with webhooks:manage)
  const [bearer, setBearer] = useState("");
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookEvents, setWebhookEvents] = useState<string[]>([...WEBHOOK_EVENTS]);
  const [newWebhookSecret, setNewWebhookSecret] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    const res = await fetch("/api/v1/audit/keys");
    const json = await readJson(res);
    if (res.ok && json?.keys) setKeys(json.keys);
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const toggleScope = (id: string) =>
    setScopes((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  const toggleEvent = (id: string) =>
    setWebhookEvents((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));

  const createKey = async () => {
    if (!label.trim()) return setError("Key label is required.");
    if (scopes.length === 0) return setError("Grant at least one scope.");
    setBusy("createKey");
    setError(null);
    setNewKey(null);
    try {
      const res = await fetch("/api/v1/audit/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim(), scopes, rateLimitPerMinute: rateLimit }),
      });
      const json = await readJson(res);
      if (!res.ok) return setError(json?.error || `Key creation failed (${res.status}).`);
      setNewKey(json.apiKey);
      setLabel("");
      setScopes([]);
      await loadKeys();
    } finally {
      setBusy(null);
    }
  };

  const revokeKey = async (id: string) => {
    if (!window.confirm("Revoke this key? Calls using it will start failing immediately.")) return;
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/v1/audit/keys/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await readJson(res);
        return setError(json?.error || `Revoke failed (${res.status}).`);
      }
      await loadKeys();
    } finally {
      setBusy(null);
    }
  };

  const listWebhooks = async () => {
    if (!bearer.trim()) return setError("Paste an API key with the webhooks:manage scope.");
    setBusy("listWebhooks");
    setError(null);
    try {
      const res = await fetch("/api/v1/audit/webhooks", {
        headers: { Authorization: `Bearer ${bearer.trim()}` },
      });
      const json = await readJson(res);
      if (!res.ok) return setError(json?.error || `Could not list webhooks (${res.status}).`);
      setWebhooks(json.webhooks ?? json.data ?? []);
    } finally {
      setBusy(null);
    }
  };

  const registerWebhook = async () => {
    if (!bearer.trim()) return setError("Paste an API key with the webhooks:manage scope.");
    if (!webhookUrl.trim()) return setError("Webhook URL is required.");
    if (webhookEvents.length === 0) return setError("Select at least one event.");
    setBusy("registerWebhook");
    setError(null);
    setNewWebhookSecret(null);
    try {
      const res = await fetch("/api/v1/audit/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer.trim()}` },
        body: JSON.stringify({ url: webhookUrl.trim(), eventTypes: webhookEvents }),
      });
      const json = await readJson(res);
      if (!res.ok) return setError(json?.message || json?.error || `Registration failed (${res.status}).`);
      setNewWebhookSecret(json.secret);
      setWebhookUrl("");
      await listWebhooks();
    } finally {
      setBusy(null);
    }
  };

  const deleteWebhook = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/v1/audit/webhooks/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${bearer.trim()}` },
      });
      if (!res.ok) {
        const json = await readJson(res);
        return setError(json?.error || `Delete failed (${res.status}).`);
      }
      await listWebhooks();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      {/* API keys */}
      <Card>
        <CardHeader>
          <CardTitle>Audit API keys</CardTitle>
          <CardDescription>
            Keys authenticate the read-only Audit API and voyage push. Send as{" "}
            <code>Authorization: Bearer &lt;key&gt;</code>. The plaintext is shown once — only its
            hash is stored. Revoking keeps the row as a record; it does not delete it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className={styles.formRow}>
            <input
              className={styles.input}
              placeholder="Key label (e.g. Veson prod)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <label className={styles.label}>Rate /min</label>
            <input
              className={`${styles.input} tnum`}
              type="number"
              min={1}
              value={rateLimit}
              onChange={(e) => setRateLimit(parseInt(e.target.value || "0", 10))}
              style={{ maxWidth: 90 }}
            />
          </div>
          <div className={styles.scopeRow}>
            {API_SCOPES.map((s) => (
              <label key={s.id} className={styles.scopeChip} title={s.desc}>
                <input type="checkbox" checked={scopes.includes(s.id)} onChange={() => toggleScope(s.id)} />
                <span className="tnum">{s.id}</span>
              </label>
            ))}
          </div>
          <button className={styles.btn} onClick={createKey} disabled={busy === "createKey"}>
            {busy === "createKey" ? "MINTING…" : "MINT KEY"}
          </button>

          {newKey && (
            <div className={styles.secretBox}>
              <strong>Copy this key now — it will not be shown again.</strong>
              <div className={styles.mono}>{newKey}</div>
            </div>
          )}

          <div className={styles.list}>
            {keys.length === 0 ? (
              <div className={styles.muted}>No keys yet.</div>
            ) : (
              keys.map((k) => (
                <div key={k.id} className={styles.item}>
                  <div className={styles.itemHead}>
                    <span>
                      <strong>{k.label}</strong>{" "}
                      <span className={`${styles.mono}`}>{k.keyPrefix}…</span>
                    </span>
                    <span className={styles.itemActions}>
                      <span
                        className={`${styles.chip} ${k.status === "active" ? styles.chipOk : styles.chipMuted} tnum`}
                      >
                        {k.status.toUpperCase()}
                      </span>
                      {k.status === "active" && (
                        <button
                          className={styles.smallBtn}
                          onClick={() => revokeKey(k.id)}
                          disabled={busy === k.id}
                        >
                          REVOKE
                        </button>
                      )}
                    </span>
                  </div>
                  <div className={styles.muted}>
                    {k.scopes.join(", ")} · {k.rateLimitPerMinute}/min
                    {k.lastUsedAt ? ` · last used ${k.lastUsedAt.slice(0, 10)}` : " · never used"}
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* Webhooks */}
      <Card>
        <CardHeader>
          <CardTitle>Time-bar webhooks</CardTitle>
          <CardDescription>
            Registers HTTPS endpoints notified on time-bar state changes. The backend manages
            webhooks through the API itself, so paste a key with the <code>webhooks:manage</code>{" "}
            scope. Deliveries are signed: <code>x-laygrounded-signature: sha256=HMAC(body)</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className={styles.formRow}>
            <input
              className={styles.input}
              type="password"
              placeholder="API key with webhooks:manage"
              value={bearer}
              onChange={(e) => setBearer(e.target.value)}
              style={{ maxWidth: 320 }}
            />
            <button className={styles.btn} onClick={listWebhooks} disabled={busy === "listWebhooks"}>
              {busy === "listWebhooks" ? "LOADING…" : "LIST"}
            </button>
          </div>
          <div className={styles.formRow}>
            <input
              className={styles.input}
              placeholder="https://your-erp.example/webhook"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              style={{ maxWidth: 320 }}
            />
          </div>
          <div className={styles.scopeRow}>
            {WEBHOOK_EVENTS.map((ev) => (
              <label key={ev} className={styles.scopeChip}>
                <input type="checkbox" checked={webhookEvents.includes(ev)} onChange={() => toggleEvent(ev)} />
                <span className="tnum">{ev}</span>
              </label>
            ))}
          </div>
          <button className={styles.btn} onClick={registerWebhook} disabled={busy === "registerWebhook"}>
            {busy === "registerWebhook" ? "REGISTERING…" : "REGISTER WEBHOOK"}
          </button>

          {newWebhookSecret && (
            <div className={styles.secretBox}>
              <strong>Signing secret — stored nowhere retrievable. Copy it now.</strong>
              <div className={styles.mono}>{newWebhookSecret}</div>
            </div>
          )}

          {webhooks && (
            <div className={styles.list}>
              {webhooks.length === 0 ? (
                <div className={styles.muted}>No webhooks registered.</div>
              ) : (
                webhooks.map((w) => (
                  <div key={w.id} className={styles.item}>
                    <div className={styles.itemHead}>
                      <span className={styles.mono}>{w.url}</span>
                      <button
                        className={styles.smallBtn}
                        onClick={() => deleteWebhook(w.id)}
                        disabled={busy === w.id}
                      >
                        DELETE
                      </button>
                    </div>
                    <div className={styles.muted}>{w.eventTypes.join(", ")}</div>
                  </div>
                ))
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Reference */}
      <Card>
        <CardHeader>
          <CardTitle>API reference</CardTitle>
          <CardDescription>
            The full contract is generated and validated. Machine-to-machine ingress endpoints
            authenticate the same way (Bearer key with the listed scope).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p style={{ marginBottom: "0.75rem" }}>
            <a className={styles.link} href="/api/v1/audit/openapi.json" target="_blank" rel="noreferrer">
              Open the OpenAPI 3.1 spec ↗
            </a>
          </p>
          <div className={styles.list}>
            <div className={styles.item}>
              <div className={styles.itemHead}>
                <span className={styles.mono}>POST /api/v1/m2m/telemetry</span>
                <span className={`${styles.chip} tnum`}>HMAC</span>
              </div>
              <div className={styles.muted}>
                Batched machine telemetry / voyage events. HMAC-signed like the ERP webhooks;
                events upsert claims and land as <em>suggested</em> (no human trust conferred).
              </div>
            </div>
            <div className={styles.item}>
              <div className={styles.itemHead}>
                <span className={styles.mono}>POST /api/v1/ingestion/sof-text</span>
                <span className={`${styles.chip} tnum`}>voyages:write</span>
              </div>
              <div className={styles.muted}>
                Ingest a plain-text Statement of Facts; events are extracted and geofenced, landing
                as suggested for review.
              </div>
            </div>
            <div className={styles.item}>
              <div className={styles.itemHead}>
                <span className={styles.mono}>POST /api/v1/onboard</span>
                <span className={`${styles.chip} tnum`}>session</span>
              </div>
              <div className={styles.muted}>
                Provision a draft claim from a pasted charter-party recap.
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
