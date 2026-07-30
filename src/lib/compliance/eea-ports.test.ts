import { describe, expect, it } from "bun:test";
import { extractCountryCode, resolveEeaPort, EEA_COUNTRY_CODES } from "@/lib/compliance/eea-ports";

describe("extractCountryCode", () => {
  it("takes a trailing code after a comma", () => {
    expect(extractCountryCode("Rotterdam, NL")).toBe("NL");
    expect(extractCountryCode("Newcastle, AU")).toBe("AU");
    expect(extractCountryCode("  santos , br ")).toBe("BR");
  });

  it("refuses a bare city name rather than guessing", () => {
    expect(extractCountryCode("Rotterdam")).toBeNull();
    expect(extractCountryCode("Port Hedland")).toBeNull();
  });

  it("does not scan mid-string for two-letter fragments", () => {
    // Matching anywhere in the string would produce confident nonsense.
    expect(extractCountryCode("Point Lisas Industrial Estate")).toBeNull();
  });

  it("rejects a trailing token that is not a two-letter code", () => {
    expect(extractCountryCode("Houston, Texas")).toBeNull();
    expect(extractCountryCode("Rotterdam, Netherlands")).toBeNull();
    expect(extractCountryCode("Berth, 12")).toBeNull();
  });

  it("handles empty input", () => {
    expect(extractCountryCode("")).toBeNull();
    expect(extractCountryCode("   ")).toBeNull();
  });
});

describe("resolveEeaPort", () => {
  it("recognises EEA calls", () => {
    for (const port of ["Rotterdam, NL", "Hamburg, DE", "Piraeus, GR", "Bergen, NO"]) {
      expect(resolveEeaPort(port).eeaPort).toBe(true);
    }
  });

  it("recognises non-EEA calls", () => {
    for (const port of ["Newcastle, AU", "Santos, BR", "Houston, US", "Qingdao, CN"]) {
      expect(resolveEeaPort(port).eeaPort).toBe(false);
    }
  });

  it("puts the UK OUTSIDE EU ETS — the likeliest mistake in the list", () => {
    const r = resolveEeaPort("Immingham, GB");
    expect(r.eeaPort).toBe(false);
    expect(r.reason).toContain("Brexit");
    expect(EEA_COUNTRY_CODES.has("GB")).toBe(false);
  });

  it("returns UNKNOWN for a bare city, never a guess", () => {
    // There is a Rotterdam in New York State; a bare name is genuinely
    // ambiguous and must not be resolved to the Dutch port.
    const r = resolveEeaPort("Rotterdam");
    expect(r.eeaPort).toBeNull();
    expect(r.reason).toContain("no country code");
  });

  it("returns UNKNOWN for a code it does not know, rather than assuming non-EEA", () => {
    const r = resolveEeaPort("Somewhere, ZZ");
    expect(r.eeaPort).toBeNull();
    expect(r.countryCode).toBe("ZZ");
    expect(r.reason).toContain("undetermined");
  });

  it("handles missing input", () => {
    expect(resolveEeaPort(null).eeaPort).toBeNull();
    expect(resolveEeaPort(undefined).eeaPort).toBeNull();
    expect(resolveEeaPort("").eeaPort).toBeNull();
  });

  it("resolves every port currently in the live book", () => {
    expect(resolveEeaPort("Rotterdam, NL").eeaPort).toBe(true);
    expect(resolveEeaPort("Port Hedland, AU").eeaPort).toBe(false);
    expect(resolveEeaPort("Newcastle, AU").eeaPort).toBe(false);
  });

  it("always explains itself", () => {
    for (const port of ["Rotterdam, NL", "Newcastle, AU", "Rotterdam", "Somewhere, ZZ", ""]) {
      expect(resolveEeaPort(port).reason.length).toBeGreaterThan(10);
    }
  });
});
