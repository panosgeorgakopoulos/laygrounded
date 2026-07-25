// Shared SSRF guard for any URL the server will fetch on a caller's behalf
// (webhook registrations, callbacks). One implementation so every emitter
// blocks the same internal targets — cloud metadata, loopback, RFC1918,
// link-local, CGNAT — rather than each route re-deriving a partial denylist.
//
// This blocks unsafe URLs by literal host and forbids credentials-in-URL and
// non-https. It does NOT resolve DNS, so a public hostname that resolves to a
// private address (DNS rebinding) is not caught here — the emitters pair this
// with `redirect: "error"` at fetch time, and full protection would require
// pinning the connection to a re-validated resolved IP (out of scope). The
// layers here are the same posture the audit webhooks route already took,
// applied consistently.

const PRIVATE_SUFFIXES = [".localhost", ".internal", ".local", ".svc", ".cluster.local"];

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, ""); // strip a trailing dot
  if (h === "localhost" || PRIVATE_SUFFIXES.some((s) => h.endsWith(s))) return true;
  // Any IPv6 literal (the URL keeps the brackets) is blocked wholesale — a
  // public unicast IPv6 literal is rare and not worth the parsing risk.
  if (h.startsWith("[") || h === "::1" || h === "::") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const octets = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
    if (octets.some((n) => n > 255)) return true; // malformed dotted-quad → refuse
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true; // this-host / private / loopback
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local + cloud metadata (AWS/GCP/Azure)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  }
  return false;
}

export class InsecureUrlError extends Error {
  constructor(message = "INSECURE_WEBHOOK_URL") {
    super(message);
    this.name = "InsecureUrlError";
  }
}

/**
 * Validates a URL the server will POST to on a caller's behalf. Throws
 * InsecureUrlError on a non-https scheme, embedded credentials, a malformed
 * URL, or a private/loopback/metadata host. Returns the parsed URL on success.
 */
export function assertPublicWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InsecureUrlError();
  }
  if (url.protocol !== "https:") throw new InsecureUrlError();
  // Credentials in the URL (user:pass@host) are a smuggling/exfil vector and
  // are never legitimate for a delivery endpoint.
  if (url.username || url.password) throw new InsecureUrlError();
  if (isPrivateHost(url.hostname)) throw new InsecureUrlError();
  return url;
}
