import { describe, expect, test, afterEach } from "bun:test";
import {
  anchorMerkleRoot,
  anchorProvider,
  encodeTimeStampReq,
  parseTimeStampResp,
  PKI_STATUS_TEXT,
} from "./anchor";

const ENV_KEYS = ["ANCHOR_PROVIDER", "TSA_URL", "TSA_AUTH_HEADER"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// sha256("laygrounded-test")
const DIGEST = "7a33e137b11d093402704fc8545d5e3cf021707e0710c6c31238fbc5b2fbb556";

// Golden vectors produced by OpenSSL 3.6.2, independently of this code:
//   openssl ts -query -digest <DIGEST> -sha256 -no_nonce -cert
//   openssl ts -query -digest <DIGEST> -sha256 -no_nonce
// A DER encoder that only agrees with itself proves nothing; these pin our
// bytes to a reference implementation a TSA will actually accept.
const OPENSSL_CERTREQ =
  "30390201013031300d0609608648016503040201050004207a33e137b11d093402704fc8545d5e3cf021707e0710c6c31238fbc5b2fbb5560101ff";
const OPENSSL_NO_CERTREQ =
  "30360201013031300d0609608648016503040201050004207a33e137b11d093402704fc8545d5e3cf021707e0710c6c31238fbc5b2fbb556";

const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

describe("encodeTimeStampReq", () => {
  test("matches OpenSSL's TimeStampReq byte for byte", () => {
    expect(hex(encodeTimeStampReq(DIGEST, { certReq: true }))).toBe(OPENSSL_CERTREQ);
    expect(hex(encodeTimeStampReq(DIGEST, { certReq: false }))).toBe(OPENSSL_NO_CERTREQ);
  });

  test("requests the TSA's certificate by default so the token verifies standalone", () => {
    expect(hex(encodeTimeStampReq(DIGEST))).toBe(OPENSSL_CERTREQ);
  });

  test("includes a nonce when given, lengthening the structure", () => {
    const withNonce = encodeTimeStampReq(DIGEST, {
      nonce: Uint8Array.from([0x01, 0x02, 0x03, 0x04]),
      certReq: false,
    });
    expect(withNonce.length).toBeGreaterThan(encodeTimeStampReq(DIGEST, { certReq: false }).length);
    // ...and the nonce bytes are actually in there.
    expect(hex(withNonce)).toContain("01020304");
  });

  test("pads a nonce whose top bit is set so it cannot read as negative", () => {
    const der = hex(encodeTimeStampReq(DIGEST, { nonce: Uint8Array.from([0xff, 0x01]) }));
    expect(der).toContain("020300ff01"); // INTEGER, len 3, 0x00 pad, ff 01
  });

  test("rejects anything that is not a SHA-256 hex digest", () => {
    for (const bad of ["", "xyz", "a".repeat(63), "a".repeat(65), "g".repeat(64)]) {
      expect(() => encodeTimeStampReq(bad)).toThrow("ANCHOR_BAD_HASH");
    }
  });
});

describe("parseTimeStampResp", () => {
  // TimeStampResp ::= SEQUENCE { PKIStatusInfo SEQUENCE { INTEGER status }, token? }
  const resp = (status: number, token?: number[]) => {
    const statusInfo = [0x30, 0x03, 0x02, 0x01, status];
    const content = [...statusInfo, ...(token ?? [])];
    return Uint8Array.from([0x30, content.length, ...content]);
  };

  test("reads a granted status and slices out the token", () => {
    const token = [0x30, 0x03, 0x02, 0x01, 0x7f];
    const r = parseTimeStampResp(resp(0, token));
    expect(r.status).toBe(0);
    expect(r.statusText).toBe("granted");
    expect(r.token && hex(r.token)).toBe(hex(Uint8Array.from(token)));
  });

  test("reports a rejection with no token", () => {
    const r = parseTimeStampResp(resp(2));
    expect(r.status).toBe(2);
    expect(r.statusText).toBe("rejection");
    expect(r.token).toBeNull();
  });

  test("names every PKIStatus rather than printing a bare number", () => {
    for (const [n, text] of Object.entries(PKI_STATUS_TEXT)) {
      expect(parseTimeStampResp(resp(Number(n))).statusText).toBe(text);
    }
  });

  test("rejects malformed DER instead of guessing", () => {
    expect(() => parseTimeStampResp(Uint8Array.from([]))).toThrow();
    expect(() => parseTimeStampResp(Uint8Array.from([0x02, 0x01, 0x00]))).toThrow("SEQUENCE");
    // Length overruns the buffer.
    expect(() => parseTimeStampResp(Uint8Array.from([0x30, 0x7f, 0x30]))).toThrow("overruns");
  });
});

describe("anchorProvider", () => {
  test("is null with nothing configured — anchoring is opt-in", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(anchorProvider()).toBeNull();
  });

  test("a TSA_URL alone implies rfc3161", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.TSA_URL = "https://tsa.example/tsr";
    expect(anchorProvider()).toBe("rfc3161");
  });

  test("an unrecognised provider is not honoured", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ANCHOR_PROVIDER = "dogecoin";
    expect(anchorProvider()).toBeNull();
  });
});

// The guarantees that matter: never claim an anchor we did not obtain.
describe("anchorMerkleRoot", () => {
  const ROOT = "a".repeat(64);

  test("reports not-configured rather than faking an anchor", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const r = await anchorMerkleRoot(ROOT);
    expect(r.anchored).toBe(false);
    if (!r.anchored) {
      expect(r.reason).toBe("not_configured");
      // Says plainly what is and isn't proven without an anchor.
      expect(r.detail).toContain("not independently timestamped");
    }
  });

  test("refuses EBSI loudly and explains what onboarding requires", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ANCHOR_PROVIDER = "ebsi";
    const r = await anchorMerkleRoot(ROOT);
    expect(r.anchored).toBe(false);
    if (!r.anchored) {
      expect(r.reason).toBe("unsupported");
      expect(r.detail).toContain("permissioned");
      expect(r.detail).toContain("onboarding");
      // Points at the path that actually works.
      expect(r.detail).toContain("rfc3161");
    }
  });

  test("rfc3161 selected but unconfigured still refuses", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ANCHOR_PROVIDER = "rfc3161";
    const r = await anchorMerkleRoot(ROOT);
    expect(r.anchored).toBe(false);
    if (!r.anchored) expect(r.reason).toBe("not_configured");
  });

  test("a TSA HTTP error is a provider_error, never an anchor", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.TSA_URL = "https://tsa.invalid.example/tsr";
    const r = await anchorMerkleRoot(ROOT);
    expect(r.anchored).toBe(false);
    if (!r.anchored) {
      expect(r.reason).toBe("provider_error");
      expect(r.detail).toContain("not anchored");
    }
  });
});
