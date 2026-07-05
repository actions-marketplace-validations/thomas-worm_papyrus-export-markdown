/*
 * Copyright (c) 2026 Thomas Worm
 * SPDX-License-Identifier: MIT
 */

/**
 * Minimal, dependency-free, non-validating XML parser.
 *
 * Papyrus/EMF resources (.uml, .notation, .aird) are machine-written,
 * well-formed XML without DTDs, so a small recursive parser is all that
 * is needed here — this keeps the action free of node_modules and
 * committed build artefacts, matching the sibling actions.
 *
 * The parser produces a tree of plain objects:
 *
 *   { tag: 'ownedComment', attrs: { 'xmi:id': '…' },
 *     children: [ …element nodes… ], text: 'concatenated text content' }
 *
 * Element order is preserved (EMF document order is semantically
 * meaningful for us: comment order inside a package, diagram order
 * inside a notation resource). Comments, processing instructions and
 * the XML declaration are skipped. CDATA sections are folded into text.
 */

/** Named XML entities that EMF emits (plus the XML standard set). */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Decodes XML character references and the five standard named
 * entities. Unknown entities are left untouched rather than throwing —
 * a documentation exporter should degrade, not die, on odd input.
 *
 * @param {string} value raw text between tags or inside an attribute
 * @returns {string} decoded text
 */
export function decodeEntities(value) {
  if (!value.includes('&')) {
    return value;
  }
  return value.replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // Out-of-range references (above U+10FFFF) are not well-formed —
      // leave them untouched instead of letting fromCodePoint throw.
      return Number.isNaN(code) || code > 0x10ffff ? match : String.fromCodePoint(code);
    }
    return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
  });
}

/**
 * Parses an XML document into an element tree.
 *
 * @param {string} source the full XML document text
 * @param {string} [origin] file path used in error messages
 * @returns {{tag: string, attrs: Object<string, string>, children: Array, text: string}}
 *          the root element
 */
export function parseXml(source, origin = '<xml>') {
  // XML 1.0 section 2.11: parsers must translate CRLF and lone CR to
  // LF before any other processing. Papyrus on Windows (and CRLF git
  // checkouts) produce such files; without this, \r would leak into
  // every extracted comment body. Escaped carriage returns (&#xD;)
  // survive because entity decoding happens later.
  source = source.replace(/\r\n?/g, '\n');
  // Strip a UTF-8 BOM if present — Windows tooling occasionally adds one.
  let pos = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const len = source.length;

  /** Throws a parse error with document context. */
  function fail(message) {
    const line = source.slice(0, pos).split('\n').length;
    throw new Error(`${origin}:${line}: ${message}`);
  }

  /** Skips whitespace. */
  function skipWs() {
    while (pos < len && /\s/.test(source[pos])) {
      pos += 1;
    }
  }

  /**
   * Skips non-element markup starting at `pos` (declaration, comment,
   * processing instruction, DOCTYPE). Returns true if something was
   * skipped.
   */
  function skipMisc() {
    if (source.startsWith('<?', pos)) {
      const end = source.indexOf('?>', pos);
      if (end === -1) fail('unterminated processing instruction');
      pos = end + 2;
      return true;
    }
    if (source.startsWith('<!--', pos)) {
      const end = source.indexOf('-->', pos);
      if (end === -1) fail('unterminated comment');
      pos = end + 3;
      return true;
    }
    if (source.startsWith('<!DOCTYPE', pos)) {
      // EMF never writes DOCTYPEs, but skip to the closing '>' just in case.
      const end = source.indexOf('>', pos);
      if (end === -1) fail('unterminated DOCTYPE');
      pos = end + 1;
      return true;
    }
    return false;
  }

  /** Parses the attribute list of a start tag into an object. */
  function parseAttributes() {
    const attrs = {};
    for (;;) {
      skipWs();
      const ch = source[pos];
      if (ch === '>' || ch === '/' || ch === undefined) {
        return attrs;
      }
      const eq = source.indexOf('=', pos);
      if (eq === -1) fail('malformed attribute');
      const name = source.slice(pos, eq).trim();
      pos = eq + 1;
      skipWs();
      const quote = source[pos];
      if (quote !== '"' && quote !== "'") fail(`attribute ${name} is not quoted`);
      const end = source.indexOf(quote, pos + 1);
      if (end === -1) fail(`unterminated value for attribute ${name}`);
      attrs[name] = decodeEntities(source.slice(pos + 1, end));
      pos = end + 1;
    }
  }

  /** Parses one element starting at `pos` (which must point at '<'). */
  function parseElement() {
    pos += 1; // consume '<'
    const nameMatch = /^[^\s/>]+/.exec(source.slice(pos));
    if (!nameMatch) fail('malformed start tag');
    const tag = nameMatch[0];
    pos += tag.length;
    const attrs = parseAttributes();
    const node = { tag, attrs, children: [], text: '' };

    if (source[pos] === '/') {
      // Self-closing element.
      if (source[pos + 1] !== '>') fail(`malformed self-closing tag <${tag}>`);
      pos += 2;
      return node;
    }
    if (source[pos] !== '>') fail(`malformed start tag <${tag}>`);
    pos += 1;

    // Content loop: text, CDATA, child elements, until the end tag.
    for (;;) {
      if (pos >= len) fail(`missing end tag for <${tag}>`);
      const lt = source.indexOf('<', pos);
      if (lt === -1) fail(`missing end tag for <${tag}>`);
      if (lt > pos) {
        node.text += decodeEntities(source.slice(pos, lt));
        pos = lt;
      }
      if (source.startsWith('</', pos)) {
        const end = source.indexOf('>', pos);
        if (end === -1) fail(`unterminated end tag for <${tag}>`);
        const endTag = source.slice(pos + 2, end).trim();
        if (endTag !== tag) fail(`end tag </${endTag}> does not match <${tag}>`);
        pos = end + 1;
        return node;
      }
      if (source.startsWith('<![CDATA[', pos)) {
        const end = source.indexOf(']]>', pos);
        if (end === -1) fail('unterminated CDATA section');
        node.text += source.slice(pos + 9, end);
        pos = end + 3;
        continue;
      }
      if (skipMisc()) {
        continue;
      }
      node.children.push(parseElement());
    }
  }

  skipWs();
  while (pos < len && skipMisc()) {
    skipWs();
  }
  if (source[pos] !== '<') fail('no root element found');
  const root = parseElement();
  return root;
}

/**
 * Returns the direct child elements of `node` with the given tag name.
 *
 * @param {object} node an element node
 * @param {string} tag child tag name to match
 * @returns {Array<object>} matching children in document order
 */
export function childrenByTag(node, tag) {
  return node.children.filter((child) => child.tag === tag);
}
