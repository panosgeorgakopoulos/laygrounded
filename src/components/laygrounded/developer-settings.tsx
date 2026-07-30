"use client";

// Developer / API surface: manage Audit-API keys (session-authenticated),
// connect and disconnect AI clients over the MCP OAuth endpoint, configure ERP
// integrations (Veson IMOS / mock), register outbound webhooks (which the
// backend gates behind an API key with the webhooks:manage scope, so the user
// supplies one here), link the machine-readable OpenAPI spec, and document the
// machine-to-machine ingress endpoints (voyage telemetry, SoF text, inbound
// email, recap onboarding, MCP).

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

// The MCP scopes that have working tools today (metadata.ts also advertises
// documents:write, but no tool consumes it yet, so it is intentionally omitted
// here rather than promising a capability that does nothing).
const MCP_SCOPES = [
  { id: "claims:read", desc: "List claims, calculations and event timelines." },
  { id: "claims:write", desc: "Create claims and amend charter-party terms." },
  {
    id: "analysis:read",
    desc: "Read laytime breakdowns, negotiation intel and evidence verdicts.",
  },
] as const;

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

interface Consent {
  clientId: string;
  clientName: string;
  scope: string[];
  grantedAt: string;
}

interface Integration {
  id: string;
  provider: string;
  displayName: string;
  baseUrl: string;
  status: string;
  lastError: string | null;
  lastSyncAt: string | null;
  hasApiToken: boolean;
  hasWebhookSecret: boolean;
  webhookPath: string;
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

  // Connected AI clients (MCP OAuth consents)
  const [consents, setConsents] = useState<Consent[] | null>(null);

  // ERP integrations
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [intProvider, setIntProvider] = useState("VESON_IMOS");
  const [intName, setIntName] = useState("");
  const [intBaseUrl, setIntBaseUrl] = useState("");
  const [intToken, setIntToken] = useState("");
  const [newIntegrationSecret, setNewIntegrationSecret] = useState<string | null>(null);

  // Absolute URLs for the MCP connection guide (origin known only client-side).
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => setOrigin(window.location.origin), []);
  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      /* clipboard blocked — the URL is visible to copy manually */
    }
  };
  const mcpUrl = `${origin}/api/mcp`;
  const resourceMetaUrl = `${origin}/.well-known/oauth-protected-resource/api/mcp`;
  const authServerMetaUrl = `${origin}/.well-known/oauth-authorization-server`;

  const loadKeys = useCallback(async () => {
    const res = await fetch("/api/v1/keys");
    const json = await readJson(res);
    if (res.ok && json?.keys) setKeys(json.keys);
  }, []);

  const loadConsents = useCallback(async () => {
    const res = await fetch("/api/oauth/consents");
    const json = await readJson(res);
    if (res.ok) setConsents(json?.consents ?? []);
  }, []);

  const loadIntegrations = useCallback(async () => {
    const res = await fetch("/api/integrations");
    const json = await readJson(res);
    if (res.ok && json?.integrations) setIntegrations(json.integrations);
  }, []);

  useEffect(() => {
    void loadKeys();
    void loadConsents();
    void loadIntegrations();
  }, [loadKeys, loadConsents, loadIntegrations]);

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
      const res = await fetch("/api/v1/keys", {
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
      const res = await fetch(`/api/v1/keys/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await readJson(res);
        return setError(json?.error || `Revoke failed (${res.status}).`);
      }
      await loadKeys();
    } finally {
      setBusy(null);
    }
  };

  const revokeConsent = async (clientId: string, clientName: string) => {
    if (
      !window.confirm(
        `Disconnect "${clientName}"? Any AI client using this authorization loses access to your claims immediately — every live token is revoked, not just hidden.`
      )
    )
      return;
    setBusy(clientId);
    setError(null);
    try {
      const res = await fetch(`/api/oauth/consents?client_id=${encodeURIComponent(clientId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await readJson(res);
        return setError(json?.error || `Disconnect failed (${res.status}).`);
      }
      await loadConsents();
    } finally {
      setBusy(null);
    }
  };

  const createIntegration = async () => {
    setBusy("createIntegration");
    setError(null);
    setNewIntegrationSecret(null);
    try {
      const res = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: intProvider,
          displayName: intName.trim(),
          baseUrl: intBaseUrl.trim(),
          apiToken: intToken.trim() || undefined,
        }),
      });
      const json = await readJson(res);
      if (!res.ok) return setError(json?.error || `Integration creation failed (${res.status}).`);
      setNewIntegrationSecret(json.webhookSecret);
      setIntName("");
      setIntBaseUrl("");
      setIntToken("");
      await loadIntegrations();
    } finally {
      setBusy(null);
    }
  };

  const setIntegrationStatus = async (id: string, status: string) => {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/integrations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const json = await readJson(res);
        return setError(json?.error || `Update failed (${res.status}).`);
      }
      await loadIntegrations();
    } finally {
      setBusy(null);
    }
  };

  const deleteIntegration = async (id: string, name: string) => {
    if (!window.confirm(`Delete integration "${name || id}"? Pending pushes to it will stop.`)) return;
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/integrations/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await readJson(res);
        return setError(json?.error || `Delete failed (${res.status}).`);
      }
      await loadIntegrations();
    } finally {
      setBusy(null);
    }
  };

  const listWebhooks = async () => {
    if (!bearer.trim()) return setError("Paste an API key with the webhooks:manage scope.");
    setBusy("listWebhooks");
    setError(null);
    try {
      const res = await fetch("/api/v1/webhooks", {
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
      const res = await fetch("/api/v1/webhooks", {
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
      const res = await fetch(`/api/v1/webhooks/${id}`, {
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

      {/* Connect an AI assistant (MCP) */}
      <Card>
        <CardHeader>
          <CardTitle>Connect an AI assistant (MCP)</CardTitle>
          <CardDescription>
            LayGrounded runs a Model Context Protocol (MCP) server, so you can connect an AI
            assistant — Claude Desktop, an IDE, or an agent — straight to your claims book. Point your
            MCP client at the endpoint below: it registers itself, sends you through a one-click OAuth
            consent, then acts as you, inside this company, limited to the scopes you approve. No API
            key to paste. Review and revoke connected clients in the card below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className={styles.list}>
            <div className={styles.item}>
              <div className={styles.itemHead}>
                <span>
                  <strong>MCP endpoint</strong>
                </span>
                <button className={styles.smallBtn} onClick={() => copy(mcpUrl, "mcp")}>
                  {copied === "mcp" ? "COPIED" : "COPY"}
                </button>
              </div>
              <div className={styles.mono}>{mcpUrl}</div>
            </div>
            <div className={styles.item}>
              <div className={styles.itemHead}>
                <span>
                  <strong>OAuth discovery</strong> (clients find these automatically)
                </span>
              </div>
              <div className={styles.mono}>{resourceMetaUrl}</div>
              <div className={styles.mono}>{authServerMetaUrl}</div>
            </div>
          </div>

          <div className={styles.muted} style={{ marginTop: "0.75rem", marginBottom: "0.25rem" }}>
            Scopes a client can request — you approve them on the consent screen:
          </div>
          <div className={styles.list}>
            {MCP_SCOPES.map((s) => (
              <div key={s.id} className={styles.item}>
                <div className={styles.itemHead}>
                  <span className={styles.mono}>{s.id}</span>
                </div>
                <div className={styles.muted}>{s.desc}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Connected AI clients (MCP OAuth) */}
      <Card>
        <CardHeader>
          <CardTitle>Connected AI clients</CardTitle>
          <CardDescription>
            AI assistants and agents connected to your claims over the MCP endpoint (
            <code>/api/mcp</code>) via OAuth. Each acts as you, inside this company, limited to the
            scopes you approved on the consent screen. Disconnecting revokes access immediately —
            every live token is killed, not merely hidden from this list.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className={styles.list}>
            {consents === null ? (
              <div className={styles.muted}>Loading…</div>
            ) : consents.length === 0 ? (
              <div className={styles.muted}>
                No AI clients connected. Point an MCP client at <code>/api/mcp</code> and approve the
                consent screen to connect one.
              </div>
            ) : (
              consents.map((c) => (
                <div key={c.clientId} className={styles.item}>
                  <div className={styles.itemHead}>
                    <span>
                      <strong>{c.clientName}</strong>{" "}
                      <span className={styles.mono}>{c.clientId.slice(0, 12)}…</span>
                    </span>
                    <button
                      className={styles.smallBtn}
                      onClick={() => revokeConsent(c.clientId, c.clientName)}
                      disabled={busy === c.clientId}
                    >
                      {busy === c.clientId ? "…" : "DISCONNECT"}
                    </button>
                  </div>
                  <div className={styles.muted}>
                    {c.scope.length ? c.scope.join(", ") : "no scopes"} · connected{" "}
                    {c.grantedAt.slice(0, 10)}
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* ERP integrations */}
      <Card>
        <CardHeader>
          <CardTitle>ERP integrations</CardTitle>
          <CardDescription>
            Connect a chartering / ERP system (Veson IMOS, or the in-process mock for testing).
            Calculations push out as invoice / ledger entries, and the ERP posts voyage events back to
            the webhook URL shown after creation. The API token and webhook secret never leave the
            server — only whether they are set; the webhook secret is shown once.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className={styles.formRow}>
            <select
              className={styles.input}
              value={intProvider}
              onChange={(e) => setIntProvider(e.target.value)}
              style={{ maxWidth: 170 }}
            >
              <option value="VESON_IMOS">Veson IMOS</option>
              <option value="MOCK_ERP">Mock ERP (testing)</option>
            </select>
            <input
              className={styles.input}
              placeholder="Display name"
              value={intName}
              onChange={(e) => setIntName(e.target.value)}
              style={{ maxWidth: 180 }}
            />
          </div>
          <div className={styles.formRow}>
            <input
              className={styles.input}
              placeholder="Base URL (https://…)"
              value={intBaseUrl}
              onChange={(e) => setIntBaseUrl(e.target.value)}
              style={{ maxWidth: 300 }}
            />
          </div>
          <div className={styles.formRow}>
            <input
              className={styles.input}
              type="password"
              placeholder="API token (optional)"
              value={intToken}
              onChange={(e) => setIntToken(e.target.value)}
              style={{ maxWidth: 300 }}
            />
            <button
              className={styles.btn}
              onClick={createIntegration}
              disabled={busy === "createIntegration"}
            >
              {busy === "createIntegration" ? "ADDING…" : "ADD INTEGRATION"}
            </button>
          </div>

          {newIntegrationSecret && (
            <div className={styles.secretBox}>
              <strong>Webhook secret — shown once. Configure it as the HMAC secret on the ERP side.</strong>
              <div className={styles.mono}>{newIntegrationSecret}</div>
            </div>
          )}

          <div className={styles.list}>
            {integrations.length === 0 ? (
              <div className={styles.muted}>No ERP integrations yet.</div>
            ) : (
              integrations.map((it) => (
                <div key={it.id} className={styles.item}>
                  <div className={styles.itemHead}>
                    <span>
                      <strong>{it.displayName || it.provider}</strong>{" "}
                      <span className={styles.mono}>{it.provider}</span>
                    </span>
                    <span className={styles.itemActions}>
                      <span
                        className={`${styles.chip} ${it.status === "active" ? styles.chipOk : styles.chipMuted} tnum`}
                      >
                        {it.status.toUpperCase()}
                      </span>
                      <button
                        className={styles.smallBtn}
                        onClick={() =>
                          setIntegrationStatus(it.id, it.status === "active" ? "paused" : "active")
                        }
                        disabled={busy === it.id}
                      >
                        {it.status === "active" ? "PAUSE" : "RESUME"}
                      </button>
                      <button
                        className={styles.smallBtn}
                        onClick={() => deleteIntegration(it.id, it.displayName)}
                        disabled={busy === it.id}
                      >
                        DELETE
                      </button>
                    </span>
                  </div>
                  <div className={styles.muted}>
                    {it.hasApiToken ? "token set" : "no token"} ·{" "}
                    {it.hasWebhookSecret ? "webhook secret set" : "no secret"}
                    {it.lastSyncAt ? ` · last sync ${it.lastSyncAt.slice(0, 10)}` : ""}
                    {it.lastError ? ` · error: ${it.lastError}` : ""}
                  </div>
                  <div className={styles.mono}>{it.webhookPath}</div>
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
            <a className={styles.link} href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
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
            <div className={styles.item}>
              <div className={styles.itemHead}>
                <span className={styles.mono}>POST /api/v1/ingestion/email</span>
                <span className={`${styles.chip} tnum`}>secret</span>
              </div>
              <div className={styles.muted}>
                Inbound-email gateway: an email provider posts a Statement of Facts (body or
                attachment) sent to <code>sof+&lt;companyId&gt;@…</code>; it is extracted and
                geofenced, landing as suggested for review. Gated by <code>x-ingestion-secret</code>.
              </div>
            </div>
            <div className={styles.item}>
              <div className={styles.itemHead}>
                <span className={styles.mono}>POST /api/v1/ingestion/sms</span>
                <span className={`${styles.chip} tnum`}>Twilio</span>
              </div>
              <div className={styles.muted}>
                Inbound-SMS gateway: a Twilio Messaging webhook posts a texted Statement of Facts;
                it is extracted and lands as suggested. Authenticated by the{" "}
                <code>X-Twilio-Signature</code> header and routed to the sending member&apos;s company.
              </div>
            </div>
            <div className={styles.item}>
              <div className={styles.itemHead}>
                <span className={styles.mono}>POST /api/mcp</span>
                <span className={`${styles.chip} tnum`}>OAuth</span>
              </div>
              <div className={styles.muted}>
                Model Context Protocol (JSON-RPC 2.0) for AI clients — connect one via the “Connect an
                AI assistant” card above.
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
