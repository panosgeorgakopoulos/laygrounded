import { describe, it, expect } from "bun:test";
import { extractEmailAddress, companyIdFromRecipient, parseInboundEmail } from "./inbound-email";

describe("extractEmailAddress", () => {
  it("pulls the address out of a display-name header", () => {
    expect(extractEmailAddress("Port Agent <agent@ship.co>")).toBe("agent@ship.co");
    expect(extractEmailAddress("bare@host.com")).toBe("bare@host.com");
    expect(extractEmailAddress("Ops TEAM <Ops@Owner.COM>")).toBe("ops@owner.com");
  });
  it("rejects non-addresses", () => {
    expect(extractEmailAddress("not an email")).toBeNull();
    expect(extractEmailAddress(123)).toBeNull();
    expect(extractEmailAddress(undefined)).toBeNull();
  });
});

describe("companyIdFromRecipient", () => {
  const cid = "22222222-2222-2222-2222-222222222222";
  it("reads the plus-addressed company id", () => {
    expect(companyIdFromRecipient(`sof+${cid}@ingest.laygrounded.com`)).toBe(cid);
    expect(companyIdFromRecipient(`Inbox <sof+${cid}@ingest.laygrounded.com>`)).toBe(cid);
  });
  it("falls back to any uuid in the address", () => {
    expect(companyIdFromRecipient(`${cid}@ingest.laygrounded.com`)).toBe(cid);
  });
  it("returns null without a uuid", () => {
    expect(companyIdFromRecipient("sof@ingest.laygrounded.com")).toBeNull();
    expect(companyIdFromRecipient(42)).toBeNull();
  });
});

describe("parseInboundEmail", () => {
  it("normalises a SendGrid-style form record", () => {
    const r = parseInboundEmail({
      from: "Agent <agent@ship.co>",
      to: "sof+22222222-2222-2222-2222-222222222222@ingest.laygrounded.com",
      subject: "MV Test / V123 SoF",
      text: "NOR tendered 04/03 08:00. All fast 14:00. Commenced loading 16:00.",
    })!;
    expect(r.fromEmail).toBe("agent@ship.co");
    expect(r.subject).toContain("MV Test");
    expect(r.text.length).toBeGreaterThan(20);
  });

  it("handles Mailgun/Postmark field names", () => {
    const mg = parseInboundEmail({ sender: "a@b.co", recipient: "x@y", "body-plain": "x".repeat(40) });
    expect(mg?.fromEmail).toBe("a@b.co");
    const pm = parseInboundEmail({ From: "c@d.co", To: "x@y", TextBody: "y".repeat(40) });
    expect(pm?.fromEmail).toBe("c@d.co");
  });

  it("rejects a missing sender or a too-short body", () => {
    expect(parseInboundEmail({ to: "x@y", text: "long enough body here now" })).toBeNull();
    expect(parseInboundEmail({ from: "a@b.co", text: "short" })).toBeNull();
  });
});
