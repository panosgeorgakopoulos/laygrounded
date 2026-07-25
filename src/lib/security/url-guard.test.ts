import { describe, it, expect } from "bun:test";
import { isPrivateHost, assertPublicWebhookUrl, InsecureUrlError } from "./url-guard";

describe("isPrivateHost", () => {
  const privates = [
    "localhost",
    "foo.localhost",
    "svc.internal",
    "db.local",
    "api.svc",
    "x.cluster.local",
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "[::1]",
    "::1",
    "999.1.1.1", // malformed dotted-quad → refuse
  ];
  for (const h of privates) {
    it(`blocks ${h}`, () => expect(isPrivateHost(h)).toBe(true));
  }

  const publics = ["example.com", "hooks.slack.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "11.0.0.1"];
  for (const h of publics) {
    it(`allows ${h}`, () => expect(isPrivateHost(h)).toBe(false));
  }
});

describe("assertPublicWebhookUrl", () => {
  it("accepts a normal https URL", () => {
    expect(() => assertPublicWebhookUrl("https://hooks.example.com/webhook")).not.toThrow();
  });

  const rejected = [
    "http://example.com/webhook", // not https
    "https://user:pass@example.com/webhook", // credentials in URL
    "https://169.254.169.254/latest/meta-data", // metadata SSRF
    "https://localhost:8080/hook",
    "https://10.1.2.3/hook",
    "ftp://example.com/x", // wrong scheme
    "not a url",
  ];
  for (const u of rejected) {
    it(`rejects ${u}`, () => {
      expect(() => assertPublicWebhookUrl(u)).toThrow(InsecureUrlError);
    });
  }
});
