/*
 * Copyright (c) 2026 Thomas Worm
 * SPDX-License-Identifier: MIT
 */

/**
 * Turns a loaded documentation model (see model.mjs) into a tree of
 * markdown files.
 *
 * Layout: every package becomes a directory holding one index file
 * (default README.md); the starting package's index file sits directly
 * in the output directory. Diagram images live in a flat images
 * subdirectory under the filename stems papyrus-export-diagrams
 * assigns with `naming: xmiId` (computed by model.mjs).
 *
 * Comment bodies are emitted verbatim (they are markdown), except that
 * three kinds of references are rewritten — never inside code spans or
 * fenced code blocks:
 *
 * - `uml:#<qualified::name>` / `uml:#<id>` — resolved to a diagram
 *   image (or, as fallback, to a package: image references embed the
 *   package's diagrams, plain links point at the package's index file).
 * - relative asset references (e.g. `images/foo.png`) — the asset is
 *   copied into the output tree and the path adjusted per file depth.
 * - TOC directives (`<!-- toc -->`, aliases `[[_TOC_]]`/`[TOC]`) —
 *   expanded to a bullet list of the package subtree.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Matches one markdown inline image/link: `![alt](url "title")`.
 * The alt text may contain one level of nested brackets, so links
 * wrapping an image (`[![alt](img)](target)`) match as a whole.
 */
const INLINE_REF = /(!?)\[((?:\\.|[^[\]\\]|\[(?:\\.|[^[\]\\])*\])*)\]\(\s*(?:<([^<>]*)>|([^()\s]+))(\s+"[^"]*"|\s+'[^']*')?\s*\)/g;

/** Matches one reference-style link definition line: `[label]: url`. */
const REF_DEF = /^([ \t]{0,3}\[(?:\\.|[^\]\\])+\]:[ \t]*)(<[^<>\n]*>|\S+)/gm;

/** Matches a TOC opening marker with optional `--flag=value` options. */
const TOC_OPEN = /<!--\s*toc((?:\s+--[a-zA-Z][a-zA-Z0-9-]*(?:=[^\s>]+)?)*)\s*-->/gi;

/** Matches a TOC closing marker. */
const TOC_STOP = /<!--\s*tocstop\s*-->/gi;

/** URL schemes (and anchors) that are never touched. */
const OPAQUE_URL = /^([a-zA-Z][a-zA-Z0-9+.-]*:|\/|#)/;

/** Directory names Windows reserves regardless of extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Replaces every run of characters outside [A-Za-z0-9._-] with a single
 * underscore — the same sanitisation papyrus-export-diagrams applies to
 * filename stems, so image paths computed here match its output.
 *
 * @param {string} raw candidate file/directory name
 * @returns {string} sanitised name ('' stays '')
 */
export function sanitizeName(raw) {
  return raw.trim().replace(/[^A-Za-z0-9._-]+/g, '_');
}

/**
 * Derives a safe directory name for a package. Beyond the exporter
 * sanitisation this guards path traversal ('.', '..'), Windows
 * reserved device names and trailing dots — those never collide with
 * the exporter's image stems because images live in their own subdir.
 *
 * @param {string} raw      package name
 * @param {string} fallback used when the name sanitises to nothing (the xmi:id)
 * @returns {string} safe, non-empty directory name
 */
function dirSegmentName(raw, fallback) {
  let base = sanitizeName(raw);
  if (base === '') {
    base = sanitizeName(fallback);
  }
  // Windows silently strips trailing dots; '.' and '..' would escape
  // the output directory entirely.
  base = base.replace(/\.+$/, '');
  if (base === '') {
    base = 'package';
  }
  if (WINDOWS_RESERVED.test(base)) {
    base = `_${base}`;
  }
  return base;
}

/**
 * Maps the action's format input to the file extension the diagrams
 * exporter uses (lowercase; JPEG becomes .jpg).
 *
 * @param {string} format format input value, e.g. 'SVG'
 * @returns {string} extension without dot
 */
export function imageExtension(format) {
  const normalized = format.trim().toUpperCase();
  const known = { SVG: 'svg', PNG: 'png', JPEG: 'jpg', JPG: 'jpg', BMP: 'bmp', GIF: 'gif' };
  const ext = known[normalized];
  if (ext === undefined) {
    throw new Error(`unsupported diagram-format '${format}' (expected SVG, PNG, JPEG, BMP or GIF)`);
  }
  return ext;
}

/**
 * Percent-encodes a relative path for use inside a markdown URL.
 * Slashes are kept; spaces and parentheses (which would terminate the
 * markdown link — encodeURIComponent leaves parentheses alone) are
 * escaped.
 *
 * @param {string} relPath forward-slash relative path
 * @returns {string} URL-safe path
 */
function encodeRelUrl(relPath) {
  return relPath
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29')))
    .join('/');
}

/**
 * Escapes square brackets in generated link labels so package or
 * diagram names containing ']' cannot break the emitted markdown.
 * Author-written alt texts are never escaped — they own their syntax.
 *
 * @param {string} label generated label text
 * @returns {string} escaped label
 */
function escapeLabel(label) {
  return label.replace(/([[\]])/g, '\\$1');
}

/**
 * Masks fenced code blocks and inline code spans with placeholder
 * tokens so reference rewriting and TOC expansion never touch code.
 *
 * @param {string} text markdown text
 * @returns {{masked: string, restore: (s: string) => string}}
 */
function maskCode(text) {
  const slots = [];
  const stash = (segment) => {
    slots.push(segment);
    return `\u0000${slots.length - 1}\u0000`;
  };

  // Fenced blocks first (line scanner; ``` or ~~~ fences, closing
  // fence must use the same character and at least the same length).
  const out = [];
  let fence = null;
  let buffer = [];
  for (const line of text.split('\n')) {
    if (fence === null) {
      const openMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (openMatch !== null) {
        fence = { char: openMatch[1][0], len: openMatch[1].length };
        buffer = [line];
      } else {
        out.push(line);
      }
      continue;
    }
    buffer.push(line);
    const closeMatch = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (closeMatch !== null && closeMatch[1][0] === fence.char && closeMatch[1].length >= fence.len) {
      out.push(stash(buffer.join('\n')));
      fence = null;
    }
  }
  if (fence !== null) {
    // Unterminated fence: everything to the end is code.
    out.push(stash(buffer.join('\n')));
  }

  // Inline code spans (backtick runs of equal length).
  const masked = out.join('\n').replace(/(`+)([\s\S]+?)\1(?!`)/g, (span) => stash(span));

  const restore = (value) => value.replace(/\u0000(\d+)\u0000/g, (_, index) => slots[Number(index)]);
  return { masked, restore };
}

/**
 * Locates TOC regions in a text. A marker's region extends to the next
 * `<!-- tocstop -->` only when no other TOC marker begins first —
 * otherwise the marker is treated as stop-less, so authored content
 * between two independent directives is never swallowed.
 *
 * @param {string} text markdown text (code already masked)
 * @returns {Array<{openStart:number, openEnd:number, flags:string, stopStart:number|null, stopEnd:number|null}>}
 */
function findTocRegions(text) {
  const regions = [];
  const open = new RegExp(TOC_OPEN.source, 'gi');
  let match;
  while ((match = open.exec(text)) !== null) {
    const openEnd = open.lastIndex;
    let stopStart = null;
    let stopEnd = null;
    const stop = new RegExp(TOC_STOP.source, 'gi');
    stop.lastIndex = openEnd;
    const stopMatch = stop.exec(text);
    if (stopMatch !== null) {
      const nextOpen = new RegExp(TOC_OPEN.source, 'gi');
      nextOpen.lastIndex = openEnd;
      const nextMatch = nextOpen.exec(text);
      if (nextMatch === null || nextMatch.index > stopMatch.index) {
        stopStart = stopMatch.index;
        stopEnd = stopMatch.index + stopMatch[0].length;
      }
    }
    regions.push({ openStart: match.index, openEnd, flags: match[1] ?? '', stopStart, stopEnd });
    open.lastIndex = stopEnd ?? openEnd;
  }
  return regions;
}

/**
 * Normalises TOC alias forms and drops the stale content of previously
 * expanded TOC regions, leaving bare marker pairs. Runs before
 * reference rewriting so stale generated links are not mistaken for
 * authored references.
 *
 * @param {string} body raw comment body (code already masked)
 * @returns {string} body with clean TOC markers
 */
function normalizeTocMarkers(body) {
  const text = body.replace(/^[ \t]*(\[\[_TOC_\]\]|\[TOC\])[ \t]*$/gm, '<!-- toc -->');
  let result = '';
  let cursor = 0;
  for (const region of findTocRegions(text)) {
    if (region.stopStart === null) {
      continue;
    }
    result += text.slice(cursor, region.openEnd);
    result += '\n\n';
    cursor = region.stopStart;
  }
  result += text.slice(cursor);
  return result;
}

/**
 * Assigns output directories and index-file paths to every package of
 * the exported subtree. Sibling packages whose directory names collide
 * (case-insensitively — macOS/Windows filesystems would merge them)
 * get _2/_3… suffixes; the images subdirectory and the index file name
 * are reserved so no package directory can shadow them.
 *
 * @param {object} startPkg     root package of the export
 * @param {string} outputDir    absolute output directory
 * @param {string} indexFile    index file name, e.g. 'README.md'
 * @param {string} imagesSubdir images directory name below outputDir
 * @param {(msg: string) => void} warn callback for non-fatal findings
 * @returns {Map<object, {dir: string, file: string, depth: number}>}
 *          plan entries keyed by package node
 */
export function planLayout(startPkg, outputDir, indexFile, imagesSubdir, warn) {
  const plan = new Map();
  const assign = (pkg, dir, depth) => {
    plan.set(pkg, { dir, file: path.join(dir, indexFile), depth });
    const used = new Set([indexFile.toLowerCase()]);
    if (depth === 0) {
      used.add(imagesSubdir.toLowerCase());
    }
    for (const child of pkg.children) {
      const base = dirSegmentName(child.name, child.id);
      let candidate = base;
      for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
        candidate = `${base}_${n}`;
      }
      if (candidate !== sanitizeName(child.name)) {
        warn(`package '${child.name}' written as directory '${candidate}' (sibling collision or unsafe name)`);
      }
      used.add(candidate.toLowerCase());
      assign(child, path.join(dir, candidate), depth + 1);
    }
  };
  assign(startPkg, outputDir, 0);
  return plan;
}

/**
 * Generates all markdown files for the planned subtree.
 *
 * @param {object} model    result of loadModel()
 * @param {object} startPkg root package of the export
 * @param {object} opts     generation options:
 *   {string} outputDir       absolute output directory
 *   {string} modelDir        absolute model directory (asset root)
 *   {string} imagesSubdir    images directory name below outputDir
 *   {string} indexFile       index file name
 *   {string} ext             image file extension (from imageExtension())
 *   {boolean} includeDiagrams append unreferenced package diagrams
 *   {boolean} addTitle       emit a `# <name>` heading per file
 *   {(msg: string) => void} warn    non-fatal finding
 *   {(msg: string) => void} problem finding that fails the action when fail-on-error is set
 * @returns {{packageCount: number, diagramCount: number}} statistics
 */
export function generateDocs(model, startPkg, opts) {
  const plan = planLayout(startPkg, opts.outputDir, opts.indexFile, opts.imagesSubdir, opts.warn);
  const imagesDir = path.join(opts.outputDir, opts.imagesSubdir);
  const usedDiagramIds = new Set();
  const copiedAssets = new Set();

  /** Absolute image path the diagrams exporter produced for a diagram. */
  const imageFileOf = (diagram) => path.join(imagesDir, `${diagram.imageStem ?? sanitizeName(diagram.id)}.${opts.ext}`);

  /** Relative URL from a generated file's directory to a target path. */
  const relUrlFrom = (fromDir, target) => {
    const rel = path.relative(fromDir, target).split(path.sep).join('/');
    return encodeRelUrl(rel === '' ? '.' : rel);
  };

  /**
   * Resolves a `uml:#` fragment. Per the reference contract, diagrams
   * win over packages: qualified names try diagram FQNs before package
   * FQNs, plain fragments try diagram ids/names before package
   * ids/names.
   *
   * @returns {{kind: 'diagram'|'package', node: object}|null}
   */
  const resolveFragment = (fragment) => {
    let decoded = fragment;
    if (decoded.includes('%')) {
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        // Not valid percent-encoding — treat literally.
      }
    }
    decoded = decoded.trim();
    if (decoded.includes('::')) {
      const diagrams = model.diagramsByFqn.get(decoded) ?? [];
      if (diagrams.length === 1) return { kind: 'diagram', node: diagrams[0] };
      if (diagrams.length > 1) {
        opts.problem(`uml:#${decoded} is ambiguous — ${diagrams.length} diagrams carry this qualified name`);
        return null;
      }
      const packages = model.packagesByFqn.get(decoded) ?? [];
      if (packages.length === 1) return { kind: 'package', node: packages[0] };
      if (packages.length > 1) {
        opts.problem(`uml:#${decoded} is ambiguous — ${packages.length} packages carry this qualified name`);
      }
      return null;
    }
    const byDiagramId = model.diagramsById.get(decoded);
    if (byDiagramId !== undefined) return { kind: 'diagram', node: byDiagramId };
    const byId = model.idsGlobal.get(decoded);
    if (byId?.kind === 'package' && !model.duplicateIds.has(decoded)) {
      return { kind: 'package', node: byId.node };
    }
    const byDiagramName = model.diagramsByName.get(decoded) ?? [];
    if (byDiagramName.length === 1) return { kind: 'diagram', node: byDiagramName[0] };
    const byPkgName = model.packagesByName.get(decoded) ?? [];
    if (byPkgName.length === 1) return { kind: 'package', node: byPkgName[0] };
    if (byDiagramName.length > 1 || byPkgName.length > 1) {
      opts.problem(`uml:#${decoded} is ambiguous — several diagrams/packages match`);
    }
    return null;
  };

  /** Renders one diagram as a markdown image, tracking usage. */
  const diagramImage = (diagram, alt, title, fromDir, referencedIds) => {
    const file = imageFileOf(diagram);
    if (!fs.existsSync(file)) {
      // A directly referenced diagram must have an image — this is
      // either a mismatch with the diagram export settings or a
      // diagram the exporter skipped (e.g. a content-less Sirius
      // representation).
      opts.problem(`no exported image for diagram '${diagram.name || diagram.id}' (expected ${file}) — was it skipped by the diagram export?`);
    } else {
      usedDiagramIds.add(diagram.id);
    }
    referencedIds?.add(diagram.id);
    const label = alt !== '' ? alt : escapeLabel(diagram.name || diagram.id);
    return `![${label}](${relUrlFrom(fromDir, file)}${title ?? ''})`;
  };

  /**
   * Copies one relative asset into the output tree and returns the new
   * URL relative to the generated file, or null when the reference
   * must stay unchanged (with a warning already emitted).
   *
   * @param {string} url    the raw relative URL from the markdown
   * @param {object} pkg    package the reference belongs to
   * @param {object} entry  plan entry of that package
   * @returns {string|null} rewritten URL or null
   */
  const copyAsset = (url, pkg, entry) => {
    const [assetPath, anchor] = url.split('#', 2);
    let decodedAsset = assetPath;
    try {
      decodedAsset = decodeURIComponent(assetPath);
    } catch {
      // Keep the raw path if it is not valid percent-encoding.
    }
    // Tolerate backslash-separated paths (authored on Windows) — as a
    // markdown URL they would be broken everywhere anyway.
    decodedAsset = decodedAsset.replace(/\\/g, '/');
    // Authors write asset paths relative to the model file that holds
    // the comment (that is how Papyrus resolves them, too).
    const source = path.resolve(path.dirname(pkg.file), decodedAsset);
    const relToModel = path.relative(opts.modelDir, source);
    if (relToModel.startsWith('..') || path.isAbsolute(relToModel)) {
      opts.warn(`asset '${url}' in package '${pkg.name}' points outside the model directory — reference left unchanged`);
      return null;
    }
    if (!fs.existsSync(source)) {
      opts.warn(`asset '${url}' in package '${pkg.name}' not found at ${source} — reference left unchanged`);
      return null;
    }
    const target = path.join(opts.outputDir, relToModel);
    if (!copiedAssets.has(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      copiedAssets.add(target);
    }
    return relUrlFrom(entry.dir, target) + (anchor !== undefined ? `#${anchor}` : '');
  };

  /**
   * Rewrites one URL from a link/image/definition. Returns:
   * - {url}          — URL replaced, surrounding syntax kept
   * - {replacement}  — the whole construct is replaced (package embed)
   * - {keep: true}   — leave the construct untouched
   *
   * @param {string} url     raw URL
   * @param {boolean} isImage whether the construct renders an image
   * @param {object} pkg     package being generated
   * @param {object} entry   plan entry of that package
   * @param {Set<string>} referencedIds collects referenced diagram ids
   * @param {string} alt     author alt/label text ('' for definitions)
   * @param {string} title   raw title suffix incl. leading space ('' if none)
   */
  const rewriteUrl = (url, isImage, pkg, entry, referencedIds, alt, title) => {
    // ---- uml:# model references --------------------------------------
    if (url.startsWith('uml:#')) {
      const resolved = resolveFragment(url.slice('uml:#'.length));
      if (resolved === null) {
        opts.problem(`unresolved reference ${url} in package '${pkg.name}' — left unchanged`);
        return { keep: true };
      }
      if (resolved.kind === 'diagram') {
        referencedIds.add(resolved.node.id);
        const file = imageFileOf(resolved.node);
        if (!fs.existsSync(file)) {
          opts.problem(`no exported image for diagram '${resolved.node.name || resolved.node.id}' (expected ${file}) — was it skipped by the diagram export?`);
        } else {
          usedDiagramIds.add(resolved.node.id);
        }
        return {
          url: relUrlFrom(entry.dir, file),
          // Images without author alt text get the diagram name.
          defaultLabel: isImage ? escapeLabel(resolved.node.name || resolved.node.id) : undefined,
        };
      }
      // Package fallback.
      if (isImage) {
        // Embed every diagram directly owned by the referenced
        // package. Like the append rule, this means "embed what is
        // available": diagrams the exporter skipped (e.g. content-less
        // Sirius representations) are dropped with a warning instead
        // of failing the action.
        const available = resolved.node.diagrams.filter((diagram) => {
          if (fs.existsSync(imageFileOf(diagram))) {
            return true;
          }
          opts.warn(`diagram '${diagram.name || diagram.id}' of package '${resolved.node.name}' has no exported image — not embedded for ${url}`);
          return false;
        });
        if (available.length === 0) {
          opts.warn(`${url} in package '${pkg.name}' names a package without exported diagrams — reference left unchanged`);
          return { keep: true };
        }
        return {
          replacement: available
            .map((diagram) => diagramImage(diagram, alt, title, entry.dir, referencedIds))
            .join('\n\n'),
        };
      }
      const targetEntry = plan.get(resolved.node);
      if (targetEntry === undefined) {
        opts.warn(`${url} in package '${pkg.name}' points at a package outside the exported subtree — reference left unchanged`);
        return { keep: true };
      }
      return { url: relUrlFrom(entry.dir, targetEntry.file) };
    }

    // ---- plain relative asset references ------------------------------
    if (OPAQUE_URL.test(url) || url === '') {
      return { keep: true }; // http:, https:, mailto:, data:, absolute paths, anchors …
    }
    const rewritten = copyAsset(url, pkg, entry);
    return rewritten === null ? { keep: true } : { url: rewritten };
  };

  /**
   * Rewrites every inline reference of a text. Alt texts of enclosing
   * links are processed recursively so `[![alt](uml:#…)](uml:#…)`
   * rewrites both the inner image and the outer link.
   *
   * @param {string} text     markdown text (code already masked)
   * @param {object} pkg      package the text belongs to
   * @param {object} entry    plan entry of that package
   * @param {Set<string>} referencedIds collects diagram ids referenced here
   * @param {number} depth    recursion guard for nested alt texts
   * @returns {string} rewritten text
   */
  const rewriteInline = (text, pkg, entry, referencedIds, depth = 0) => text.replace(
    INLINE_REF,
    (match, bang, alt, angledUrl, plainUrl, title) => {
      const url = angledUrl ?? plainUrl;
      const isImage = bang === '!';
      const newAlt = depth < 2 && alt.includes('](')
        ? rewriteInline(alt, pkg, entry, referencedIds, depth + 1)
        : alt;

      const result = rewriteUrl(url, isImage, pkg, entry, referencedIds, newAlt, title ?? '');
      if (result.replacement !== undefined) {
        return result.replacement;
      }
      if (result.keep && newAlt === alt) {
        return match;
      }
      const finalAlt = newAlt !== '' ? newAlt : (result.defaultLabel ?? '');
      const finalUrl = result.url ?? (angledUrl !== undefined ? `<${angledUrl}>` : plainUrl);
      return `${bang}[${finalAlt}](${finalUrl}${title ?? ''})`;
    },
  );

  /**
   * Rewrites the URLs of reference-style link definitions
   * (`[label]: uml:#…`). Diagrams resolve to their image file, package
   * references to the package's generated file — usable both as
   * `[text][label]` and `![alt][label]`.
   */
  const rewriteRefDefs = (text, pkg, entry, referencedIds) => text.replace(
    REF_DEF,
    (match, prefix, target) => {
      const angled = target.startsWith('<') && target.endsWith('>');
      const url = angled ? target.slice(1, -1) : target;
      const result = rewriteUrl(url, false, pkg, entry, referencedIds, '', '');
      if (result.url === undefined) {
        return match;
      }
      return `${prefix}${result.url}`;
    },
  );

  /**
   * Expands TOC directives in an assembled document (code already
   * masked; bodies arrive with normalised, empty marker regions). The
   * generated list is placed between the canonical marker pair so
   * re-running the export stays idempotent.
   */
  const expandToc = (content, pkg, entry) => {
    let result = '';
    let cursor = 0;
    for (const region of findTocRegions(content)) {
      let maxDepth = Number.POSITIVE_INFINITY;
      const depthFlag = /--maxdepth=(\d+)/.exec(region.flags);
      if (depthFlag !== null) {
        maxDepth = Number.parseInt(depthFlag[1], 10);
      }
      const listLines = [];
      const walk = (node, depth) => {
        if (depth > maxDepth) {
          return;
        }
        for (const child of node.children) {
          const childEntry = plan.get(child);
          const link = relUrlFrom(entry.dir, childEntry.file);
          listLines.push(`${'  '.repeat(depth - 1)}- [${escapeLabel(child.name || child.id)}](${link})`);
          walk(child, depth + 1);
        }
      };
      walk(pkg, 1);
      const list = listLines.join('\n');

      result += content.slice(cursor, region.openEnd);
      result += `\n\n${list}\n\n<!-- tocstop -->`;
      cursor = region.stopEnd ?? region.openEnd;
    }
    result += content.slice(cursor);
    return result;
  };

  // ---- Emit one file per package ------------------------------------------
  let packageCount = 0;
  for (const [pkg, entry] of plan) {
    const blocks = [];
    if (opts.addTitle) {
      blocks.push(`# ${pkg.name || '(unnamed package)'}`);
    }
    const referencedIds = new Set();
    for (const body of pkg.comments) {
      // Code spans/fences must survive verbatim: mask them, normalise
      // TOC markers (dropping stale generated content), rewrite the
      // references, then restore the code.
      const { masked, restore } = maskCode(body.trim());
      let text = normalizeTocMarkers(masked);
      text = rewriteInline(text, pkg, entry, referencedIds);
      text = rewriteRefDefs(text, pkg, entry, referencedIds);
      blocks.push(restore(text));
    }
    if (opts.includeDiagrams) {
      // Comment/diagram interleaving is not persisted by Papyrus, so
      // unreferenced diagrams are appended after the comments in the
      // exporter's deterministic order. Explicit uml:# references are
      // the way to place a diagram at an exact position — such diagrams
      // are not appended a second time.
      for (const diagram of pkg.diagrams) {
        if (referencedIds.has(diagram.id)) {
          continue;
        }
        if (!fs.existsSync(imageFileOf(diagram))) {
          opts.warn(`diagram '${diagram.name || diagram.id}' of package '${pkg.name}' has no exported image — skipped`);
          continue;
        }
        usedDiagramIds.add(diagram.id);
        blocks.push(`![${escapeLabel(diagram.name || diagram.id)}](${relUrlFrom(entry.dir, imageFileOf(diagram))})`);
      }
    }
    const assembled = blocks.join('\n\n');
    const { masked, restore } = maskCode(assembled);
    const content = restore(expandToc(masked, pkg, entry));
    fs.mkdirSync(entry.dir, { recursive: true });
    fs.writeFileSync(entry.file, `${content}\n`, 'utf8');
    packageCount += 1;
  }

  return { packageCount, diagramCount: usedDiagramIds.size };
}
