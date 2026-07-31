// Tests for the hardened XML reader/writer behind the Danaos SOAP adapter.
//
// The security cases are the point of this file. Inbound XML from an ERP (or
// from anything that can reach the webhook endpoint) is untrusted input, and
// every classic XML attack — external entities, entity expansion, unbounded
// nesting — is a refusal here rather than a mitigation.

import { describe, expect, test } from "bun:test";
import {
  buildXml,
  child,
  childrenNamed,
  findDescendant,
  localName,
  parseXml,
  textAt,
  XmlParseError,
  XmlSecurityError,
} from "./xml";

describe("hostile documents are refused, not parsed", () => {
  const refused: Array<{ name: string; xml: string }> = [
    {
      name: "XXE: external entity reading a local file",
      xml: `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>`,
    },
    {
      name: "XXE: external entity pointing at an internal URL (SSRF)",
      xml: `<!DOCTYPE r [<!ENTITY x SYSTEM "http://169.254.169.254/latest/meta-data/">]><r>&x;</r>`,
    },
    {
      name: "billion laughs: nested entity expansion",
      xml:
        `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">` +
        `<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">` +
        `<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;">]><lolz>&lol3;</lolz>`,
    },
    {
      name: "lowercase doctype (case must not be a bypass)",
      xml: `<!doctype foo><foo/>`,
    },
    {
      name: "mixed-case DoCtYpE",
      xml: `<!DoCtYpE foo><foo/>`,
    },
    {
      name: "a bare ENTITY declaration without a DOCTYPE wrapper",
      xml: `<r><!ENTITY e "x">text</r>`,
    },
    {
      name: "DOCTYPE hidden after leading whitespace and a comment",
      xml: `   <!-- harmless --> <!DOCTYPE foo SYSTEM "http://evil.test/x.dtd"><foo/>`,
    },
  ];

  for (const c of refused) {
    test(`refuses: ${c.name}`, () => {
      expect(() => parseXml(c.xml)).toThrow(XmlSecurityError);
    });
  }

  test("nesting deeper than the limit is refused, not stack-overflowed", () => {
    // An unbounded recursive descent parser dies with a RangeError the caller
    // cannot distinguish from a bug. This must be an explicit refusal.
    const depth = 500;
    const xml = "<a>".repeat(depth) + "x" + "</a>".repeat(depth);
    expect(() => parseXml(xml)).toThrow(XmlSecurityError);
  });

  test("an oversized document is refused before parsing begins", () => {
    const xml = `<r>${"x".repeat(5_000_001)}</r>`;
    expect(() => parseXml(xml)).toThrow(XmlSecurityError);
  });

  test("an undeclared entity is left literal, never resolved", () => {
    // With DOCTYPE refused, `&secret;` cannot have been declared. Passing it
    // through unchanged neither crashes nor expands it.
    const doc = parseXml(`<r>&secret;</r>`);
    expect(doc.text).toBe("&secret;");
  });
});

describe("parsing", () => {
  test("reads elements, attributes and nested text", () => {
    const doc = parseXml(
      `<?xml version="1.0" encoding="UTF-8"?>
       <Voyage id="V-1" xmlns="urn:x">
         <VesselName>AEGEAN TRADER</VesselName>
         <VoyageNo>4201/2026</VoyageNo>
       </Voyage>`
    );
    expect(doc.name).toBe("Voyage");
    expect(doc.attrs.id).toBe("V-1");
    expect(textAt(doc, "VesselName")).toBe("AEGEAN TRADER");
    expect(textAt(doc, "VoyageNo")).toBe("4201/2026");
  });

  test("a missing path yields empty string, never a throw", () => {
    // Adapters call textAt() on optional fields constantly; throwing would
    // make an absent ETA an outage.
    const doc = parseXml(`<r><a>1</a></r>`);
    expect(textAt(doc, "nope")).toBe("");
    expect(textAt(doc, "a", "deeper", "still")).toBe("");
  });

  test("self-closing and empty elements", () => {
    const doc = parseXml(`<r><a/><b></b><c d="1"/></r>`);
    expect(doc.children.map((n) => n.name)).toEqual(["a", "b", "c"]);
    expect(textAt(doc, "a")).toBe("");
    expect(child(doc, "c")?.attrs.d).toBe("1");
  });

  test("CDATA is literal — markup inside it is not parsed", () => {
    const doc = parseXml(`<r><note><![CDATA[<b>bold</b> & 5 < 6]]></note></r>`);
    expect(textAt(doc, "note")).toBe("<b>bold</b> & 5 < 6");
    expect(child(doc, "note")?.children).toHaveLength(0);
  });

  test("comments containing markup do not corrupt the document", () => {
    // Pre-stripping comments with a regex would mangle this; the scanner
    // handles them positionally instead.
    const doc = parseXml(`<r><!-- <fake>ignored</fake> --><real>1</real></r>`);
    expect(doc.children).toHaveLength(1);
    expect(textAt(doc, "real")).toBe("1");
  });

  test("predefined entities decode in text and attributes", () => {
    const doc = parseXml(`<r a="x &amp; y &lt;z&gt;">5 &lt; 6 &amp;&amp; 7 &gt; 6</r>`);
    expect(doc.text).toBe("5 < 6 && 7 > 6");
    expect(doc.attrs.a).toBe("x & y <z>");
  });

  test("numeric character references decode", () => {
    const doc = parseXml(`<r>&#65;&#x42;&#8364;</r>`);
    expect(doc.text).toBe("AB€");
  });

  test("both quote styles for attributes", () => {
    const doc = parseXml(`<r a='single' b="double"/>`);
    expect(doc.attrs).toEqual({ a: "single", b: "double" });
  });

  const malformed: Array<{ name: string; xml: string }> = [
    { name: "mismatched closing tag", xml: `<a><b></c></a>` },
    { name: "unclosed element", xml: `<a><b>text` },
    { name: "unquoted attribute value", xml: `<a b=1/>` },
    { name: "attribute with no value", xml: `<a b/>` },
    { name: "unterminated CDATA", xml: `<a><![CDATA[oops</a>` },
    { name: "unterminated comment", xml: `<a><!-- oops</a>` },
    { name: "trailing content after the root", xml: `<a/><b/>` },
    { name: "empty input", xml: `` },
  ];

  for (const c of malformed) {
    test(`rejects malformed: ${c.name}`, () => {
      expect(() => parseXml(c.xml)).toThrow(XmlParseError);
    });
  }
});

describe("namespace-tolerant navigation", () => {
  // The same SOAP envelope arrives as soap:/soapenv:/env: depending on the
  // vendor's stack. Matching the prefix would fail on a cosmetic difference.
  const envelope = (prefix: string) =>
    `<${prefix}:Envelope xmlns:${prefix}="http://schemas.xmlsoap.org/soap/envelope/">
       <${prefix}:Body><GetVoyagesResponse><Voyage><VoyageId>7</VoyageId></Voyage></GetVoyagesResponse></${prefix}:Body>
     </${prefix}:Envelope>`;

  for (const prefix of ["soap", "soapenv", "env", "SOAP-ENV"]) {
    test(`finds Body under the '${prefix}:' prefix`, () => {
      const doc = parseXml(envelope(prefix));
      const body = findDescendant(doc, "Body");
      expect(body).not.toBeNull();
      expect(textAt(findDescendant(body, "Voyage"), "VoyageId")).toBe("7");
    });
  }

  test("localName strips the prefix", () => {
    expect(localName("soap:Body")).toBe("Body");
    expect(localName("Body")).toBe("Body");
  });

  test("childrenNamed returns every match, not just the first", () => {
    const doc = parseXml(`<r><v>1</v><v>2</v><w>3</w><v>4</v></r>`);
    expect(childrenNamed(doc, "v").map((n) => n.text)).toEqual(["1", "2", "4"]);
  });
});

describe("serialization", () => {
  test("escapes text and attribute content", () => {
    const xml = buildXml(
      { name: "r", attrs: { note: `a "quoted" & <angled>` }, text: `5 < 6 & 7` },
      { declaration: false }
    );
    expect(xml).toBe(`<r note="a &quot;quoted&quot; &amp; &lt;angled&gt;">5 &lt; 6 &amp; 7</r>`);
  });

  test("a hostile value cannot break out of its element", () => {
    // The whole reason to escape: a charterer named `</Amount><Amount>0`
    // must not be able to rewrite the invoice.
    const xml = buildXml(
      { name: "Invoice", children: [{ name: "Party", text: `</Party><Amount>0</Amount>` }] },
      { declaration: false }
    );
    expect(xml).not.toContain("<Amount>");
    const round = parseXml(xml);
    expect(textAt(round, "Party")).toBe(`</Party><Amount>0</Amount>`);
  });

  test("null and undefined attributes are omitted, not stringified", () => {
    const xml = buildXml(
      { name: "r", attrs: { a: null, b: undefined, c: "keep" } },
      { declaration: false }
    );
    expect(xml).toBe(`<r c="keep"/>`);
  });

  test("empty text becomes a self-closing element", () => {
    expect(buildXml({ name: "r", text: "" }, { declaration: false })).toBe("<r/>");
    expect(buildXml({ name: "r", text: null }, { declaration: false })).toBe("<r/>");
  });

  test("null children are skipped (an omitted optional SOAP header)", () => {
    const xml = buildXml(
      { name: "r", children: [null, { name: "a", text: "1" }, undefined] },
      { declaration: false }
    );
    expect(xml).toBe("<r><a>1</a></r>");
  });

  test("round-trips a nested document", () => {
    const xml = buildXml({
      name: "Envelope",
      children: [
        {
          name: "Entries",
          children: [
            { name: "Entry", children: [{ name: "Hours", text: "12.5000" }] },
            { name: "Entry", children: [{ name: "Hours", text: "3.2500" }] },
          ],
        },
      ],
    });
    const doc = parseXml(xml);
    const entries = childrenNamed(child(doc, "Entries"), "Entry");
    expect(entries.map((e) => textAt(e, "Hours"))).toEqual(["12.5000", "3.2500"]);
  });
});
