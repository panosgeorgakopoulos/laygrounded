// A deliberately small XML reader/writer for legacy maritime ERP envelopes.
//
// WHY NOT A LIBRARY. The only XML this app will ever touch is a handful of
// SOAP-ish request/response shapes we define ourselves. A general parser brings
// a general attack surface — external entities, DTD expansion, namespace
// trickery — to solve a problem we do not have. This module instead REFUSES the
// hostile constructs outright (see `guardHostileConstructs`) and supports only
// elements, attributes, text, CDATA, comments and processing instructions.
//
// Refused by design, never "handled":
//   * `<!DOCTYPE` — the entry point for XXE (file/SSRF disclosure) and for
//     billion-laughs entity expansion. There is no legitimate DOCTYPE in an
//     ERP payload we would accept.
//   * `<!ENTITY` — custom entity declarations, same reason.
// Bounded by design: input size and nesting depth, so a hostile document
// cannot exhaust memory or the call stack.

const MAX_INPUT_BYTES = 5_000_000;
const MAX_DEPTH = 100;

export class XmlSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlSecurityError";
  }
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlParseError";
  }
}

export interface XmlNode {
  /** The tag as written, including any namespace prefix. */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated direct text (including CDATA), trimmed. */
  text: string;
}

// === Reading ===

export function parseXml(source: string): XmlNode {
  if (source.length > MAX_INPUT_BYTES) {
    throw new XmlSecurityError(`XML input exceeds ${MAX_INPUT_BYTES} bytes`);
  }
  guardHostileConstructs(source);
  const cursor = { i: 0 };
  skipIgnorable(source, cursor);
  const root = parseElement(source, cursor, 0);
  skipIgnorable(source, cursor);
  if (cursor.i < source.length) {
    throw new XmlParseError("trailing content after the root element");
  }
  return root;
}

/**
 * Rejects DTD and entity declarations before any parsing happens.
 *
 * Checked against the raw source rather than during the scan, because the point
 * is to never begin interpreting a document that contains them at all. The
 * comparison is case-insensitive: `<!doctype` is the same threat as `<!DOCTYPE`.
 */
function guardHostileConstructs(source: string): void {
  const lowered = source.toLowerCase();
  if (lowered.includes("<!doctype")) {
    throw new XmlSecurityError("XML DOCTYPE declarations are refused (XXE / entity expansion)");
  }
  if (lowered.includes("<!entity")) {
    throw new XmlSecurityError("XML ENTITY declarations are refused (XXE / entity expansion)");
  }
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9._:-]/;

function parseElement(s: string, c: { i: number }, depth: number): XmlNode {
  if (depth > MAX_DEPTH) {
    throw new XmlSecurityError(`XML nesting deeper than ${MAX_DEPTH} levels`);
  }
  if (s[c.i] !== "<") throw new XmlParseError(`expected '<' at offset ${c.i}`);
  c.i++;
  const name = readName(s, c);
  if (!name) throw new XmlParseError(`malformed tag name at offset ${c.i}`);

  const attrs: Record<string, string> = {};
  for (;;) {
    skipWhitespace(s, c);
    if (s.startsWith("/>", c.i)) {
      c.i += 2;
      return { name, attrs, children: [], text: "" };
    }
    if (s[c.i] === ">") {
      c.i++;
      break;
    }
    const attrName = readName(s, c);
    if (!attrName) throw new XmlParseError(`malformed attribute in <${name}> at offset ${c.i}`);
    skipWhitespace(s, c);
    if (s[c.i] !== "=") throw new XmlParseError(`attribute '${attrName}' has no value`);
    c.i++;
    skipWhitespace(s, c);
    const quote = s[c.i];
    if (quote !== '"' && quote !== "'") {
      throw new XmlParseError(`attribute '${attrName}' value is not quoted`);
    }
    c.i++;
    const end = s.indexOf(quote, c.i);
    if (end < 0) throw new XmlParseError(`unterminated value for attribute '${attrName}'`);
    attrs[attrName] = decodeEntities(s.slice(c.i, end));
    c.i = end + 1;
  }

  const children: XmlNode[] = [];
  let text = "";
  for (;;) {
    if (c.i >= s.length) throw new XmlParseError(`unclosed element <${name}>`);

    if (s.startsWith("<![CDATA[", c.i)) {
      const end = s.indexOf("]]>", c.i + 9);
      if (end < 0) throw new XmlParseError("unterminated CDATA section");
      // CDATA is literal: no entity decoding, by definition.
      text += s.slice(c.i + 9, end);
      c.i = end + 3;
      continue;
    }
    if (s.startsWith("<!--", c.i)) {
      const end = s.indexOf("-->", c.i + 4);
      if (end < 0) throw new XmlParseError("unterminated comment");
      c.i = end + 3;
      continue;
    }
    if (s.startsWith("<?", c.i)) {
      const end = s.indexOf("?>", c.i + 2);
      if (end < 0) throw new XmlParseError("unterminated processing instruction");
      c.i = end + 2;
      continue;
    }
    if (s.startsWith("</", c.i)) {
      c.i += 2;
      const closing = readName(s, c);
      skipWhitespace(s, c);
      if (s[c.i] !== ">") throw new XmlParseError(`malformed closing tag for <${name}>`);
      c.i++;
      if (closing !== name) {
        throw new XmlParseError(`<${name}> closed by </${closing}>`);
      }
      break;
    }
    if (s[c.i] === "<") {
      children.push(parseElement(s, c, depth + 1));
      continue;
    }
    const next = s.indexOf("<", c.i);
    const stop = next < 0 ? s.length : next;
    text += decodeEntities(s.slice(c.i, stop));
    c.i = stop;
  }

  return { name, attrs, children, text: text.trim() };
}

function readName(s: string, c: { i: number }): string {
  if (c.i >= s.length || !NAME_START.test(s[c.i])) return "";
  const start = c.i;
  c.i++;
  while (c.i < s.length && NAME_CHAR.test(s[c.i])) c.i++;
  return s.slice(start, c.i);
}

function skipWhitespace(s: string, c: { i: number }): void {
  while (c.i < s.length && /\s/.test(s[c.i])) c.i++;
}

/** Whitespace, comments and processing instructions outside the root element. */
function skipIgnorable(s: string, c: { i: number }): void {
  for (;;) {
    skipWhitespace(s, c);
    if (s.startsWith("<?", c.i)) {
      const end = s.indexOf("?>", c.i + 2);
      if (end < 0) throw new XmlParseError("unterminated processing instruction");
      c.i = end + 2;
      continue;
    }
    if (s.startsWith("<!--", c.i)) {
      const end = s.indexOf("-->", c.i + 4);
      if (end < 0) throw new XmlParseError("unterminated comment");
      c.i = end + 3;
      continue;
    }
    return;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/**
 * Decodes the five predefined XML entities and numeric character references.
 *
 * Anything else is left LITERAL rather than resolved. With DOCTYPE refused, a
 * custom entity cannot have been declared, so `&whatever;` is either invalid
 * XML or an attempt to smuggle one — and passing it through unchanged is the
 * response that neither crashes nor expands it.
 */
function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (match, body: string) => {
    if (body[0] === "#") {
      const codePoint =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

// === Navigating ===

/** The tag name without its namespace prefix (`soap:Body` → `Body`). */
export function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

/**
 * First child with this local name.
 *
 * Namespace prefixes are ignored on purpose: the same SOAP envelope arrives as
 * `soap:Body`, `soapenv:Body` or `env:Body` depending on the vendor's stack,
 * and matching the prefix would make the parser fail on a cosmetic difference.
 */
export function child(node: XmlNode | null | undefined, name: string): XmlNode | null {
  if (!node) return null;
  return node.children.find((n) => localName(n.name) === name) ?? null;
}

/** All children with this local name. */
export function childrenNamed(node: XmlNode | null | undefined, name: string): XmlNode[] {
  if (!node) return [];
  return node.children.filter((n) => localName(n.name) === name);
}

/** Follows a path of local names and returns the trimmed text, or "". */
export function textAt(node: XmlNode | null | undefined, ...path: string[]): string {
  let current: XmlNode | null | undefined = node;
  for (const step of path) {
    current = child(current, step);
    if (!current) return "";
  }
  return current?.text ?? "";
}

/** Depth-first search for the first descendant with this local name. */
export function findDescendant(node: XmlNode | null | undefined, name: string): XmlNode | null {
  if (!node) return null;
  if (localName(node.name) === name) return node;
  for (const c of node.children) {
    const hit = findDescendant(c, name);
    if (hit) return hit;
  }
  return null;
}

// === Writing ===

export interface XmlElement {
  name: string;
  attrs?: Record<string, string | number | null | undefined>;
  children?: Array<XmlElement | null | undefined>;
  /** Element text. Mutually exclusive with `children` in practice. */
  text?: string | number | null;
}

export function buildXml(root: XmlElement, opts: { declaration?: boolean } = {}): string {
  const body = serializeElement(root);
  return opts.declaration === false ? body : `<?xml version="1.0" encoding="UTF-8"?>${body}`;
}

function serializeElement(el: XmlElement): string {
  const attrs = Object.entries(el.attrs ?? {})
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
    .join("");

  const kids = (el.children ?? []).filter((c): c is XmlElement => !!c);
  if (kids.length > 0) {
    return `<${el.name}${attrs}>${kids.map(serializeElement).join("")}</${el.name}>`;
  }
  if (el.text === null || el.text === undefined || el.text === "") {
    return `<${el.name}${attrs}/>`;
  }
  return `<${el.name}${attrs}>${escapeText(String(el.text))}</${el.name}>`;
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
