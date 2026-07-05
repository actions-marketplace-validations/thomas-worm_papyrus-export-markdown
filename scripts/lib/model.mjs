/*
 * Copyright (c) 2026 Thomas Worm
 * SPDX-License-Identifier: MIT
 */

/**
 * Loads a Papyrus model directory into an in-memory documentation model.
 *
 * Three resource kinds are read:
 *
 * - `*.uml`       — the semantic model: the package tree and the
 *                   `ownedComment` elements that hold the documentation
 *                   text (Papyrus Desktop's "Documentation" textarea
 *                   writes comments that annotate their parent package).
 * - `*.notation`  — GMF diagrams. Each `notation:Diagram` carries an
 *                   `element`/`owner` href back to the semantic package
 *                   that owns it.
 * - `*.aird`      — Sirius representations. Each
 *                   `DRepresentationDescriptor` carries a `target` href.
 *
 * The loader mirrors the discovery order of papyrus-export-diagrams
 * (files sorted lexicographically, elements in document order) so the
 * "append remaining diagrams" rule of the markdown generator produces
 * the same order as the image exporter's log.
 */

import fs from 'node:fs';
import path from 'node:path';

import { sanitizeName } from './markdown.mjs';
import { parseXml } from './xml.mjs';

/** Tags/xmi:types treated as packages (uml:Model is a Package subtype). */
const PACKAGE_TYPES = new Set(['uml:Package', 'uml:Model']);

/**
 * Tags/xmi:types of expected companion resources that are silently
 * skipped rather than warned about (profiles are Papyrus-standard
 * *.profile.uml files, not documentation models).
 */
const SKIPPED_ROOT_TYPES = new Set(['uml:Profile']);

/**
 * A package node of the documentation tree.
 *
 * @typedef {object} PackageNode
 * @property {string} id        xmi:id of the package
 * @property {string} name      package name ('' if unnamed)
 * @property {string} file      absolute path of the defining .uml file
 * @property {PackageNode|null} parent    owning package
 * @property {Array<PackageNode>} children  sub-packages in document order
 * @property {Array<string>} comments  markdown bodies of annotating comments in document order
 * @property {Array<DiagramInfo>} diagrams  diagrams owned by this package, exporter order
 * @property {Array<string>} qualifiedNames FQN variants this package answers to
 */

/**
 * A diagram (GMF) or representation (Sirius) found in the model.
 *
 * @typedef {object} DiagramInfo
 * @property {string} id      notation xmi:id (GMF) or descriptor uid (Sirius)
 * @property {string} name    diagram name ('' if unnamed)
 * @property {string} kind    'notation' or 'aird'
 * @property {string} file    absolute path of the defining resource
 * @property {string} imageStem filename stem the diagram exporter assigns (xmiId mode)
 * @property {string|null} ownerId  xmi:id of the owning semantic element
 * @property {string|null} ownerFile absolute path of the .uml file the owner lives in
 */

/**
 * Replays papyrus-export-diagrams' DiagramFilenameGenerator.dedupe():
 * the first user of a stem keeps it, later collisions get _2, _3, …
 *
 * @returns {(stem: string) => string} stateful dedup function
 */
function makeStemDeduper() {
  const used = new Set();
  return (stem) => {
    let candidate = stem;
    let suffix = 1;
    while (used.has(candidate)) {
      suffix += 1;
      candidate = `${stem}_${suffix}`;
    }
    used.add(candidate);
    return candidate;
  };
}

/**
 * Recursively lists files below `dir` with one of the given extensions,
 * sorted lexicographically by full path (the same order
 * papyrus-export-diagrams uses via Files.walk().sorted()).
 *
 * @param {string} dir  directory to scan
 * @param {string} ext  file extension including the dot, e.g. '.uml'
 * @returns {Array<string>} absolute file paths
 */
function listFiles(dir, ext) {
  const result = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) {
        result.push(full);
      }
    }
  }
  return result.sort();
}

/**
 * Splits an EMF href like `example.uml#_SomeId` into the referenced
 * absolute file path (resolved against the referring resource) and the
 * fragment.
 *
 * @param {string} href      the href attribute value
 * @param {string} fromFile  absolute path of the resource containing the href
 * @returns {{file: string|null, fragment: string}} resolved reference;
 *          `file` is null for pathmap:/platform: URIs we cannot resolve
 */
function resolveHref(href, fromFile) {
  const hash = href.indexOf('#');
  const resource = hash === -1 ? '' : href.slice(0, hash);
  const fragment = hash === -1 ? href : href.slice(hash + 1);
  if (resource === '') {
    return { file: fromFile, fragment };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(resource)) {
    // pathmap://, platform:/plugin/… — external, not part of model-dir.
    return { file: null, fragment };
  }
  return { file: path.resolve(path.dirname(fromFile), decodeURIComponent(resource)), fragment };
}

/**
 * Collects the documentation text of one annotating comment: its own
 * `<body>` plus the bodies of all nested `ownedComment` descendants in
 * document order. Papyrus occasionally nests the body-bearing comment
 * inside the annotating one (observed in real models), so a plain
 * "own body only" rule would silently drop text.
 *
 * @param {object} commentNode an ownedComment element node
 * @returns {Array<string>} non-empty bodies in document order
 */
function collectCommentBodies(commentNode) {
  const bodies = [];
  const ownBody = commentNode.children
    .filter((child) => child.tag === 'body')
    .map((child) => child.text)
    .join('');
  const attrBody = commentNode.attrs.body;
  const body = ownBody !== '' ? ownBody : (attrBody ?? '');
  if (body.trim() !== '') {
    bodies.push(body);
  }
  for (const child of commentNode.children) {
    if (child.tag === 'ownedComment') {
      bodies.push(...collectCommentBodies(child));
    }
  }
  return bodies;
}

/**
 * Returns the ids listed in a comment's annotatedElement reference.
 * EMF serializes multi-valued references either as a space-separated
 * attribute of local idrefs or as child elements with xmi:idref/href.
 *
 * @param {object} commentNode an ownedComment element node
 * @param {string} fromFile    absolute path of the containing .uml file
 * @returns {Array<{file: string|null, fragment: string}>} referenced elements
 */
function annotatedElementRefs(commentNode, fromFile) {
  const refs = [];
  const attr = commentNode.attrs.annotatedElement;
  if (attr) {
    for (const id of attr.split(/\s+/).filter((s) => s !== '')) {
      refs.push({ file: fromFile, fragment: id });
    }
  }
  for (const child of commentNode.children) {
    if (child.tag !== 'annotatedElement') {
      continue;
    }
    if (child.attrs['xmi:idref']) {
      refs.push({ file: fromFile, fragment: child.attrs['xmi:idref'] });
    } else if (child.attrs.href) {
      refs.push(resolveHref(child.attrs.href, fromFile));
    }
  }
  return refs;
}

/**
 * Recursively builds PackageNodes from a uml:Package/uml:Model element.
 *
 * @param {object} element   the XML element of the package
 * @param {PackageNode|null} parent owning package node
 * @param {string} file      absolute path of the .uml file
 * @param {object} ctx       loader context (indexes, warnings)
 * @returns {PackageNode} the built node
 */
function buildPackage(element, parent, file, ctx) {
  const id = element.attrs['xmi:id'] ?? '';
  const node = {
    id,
    name: element.attrs.name ?? '',
    file,
    parent,
    children: [],
    comments: [],
    diagrams: [],
    qualifiedNames: [],
  };
  registerId(ctx, file, id, { kind: 'package', node });

  // Documentation text: direct ownedComment children whose
  // annotatedElement points back at this very package, in document order.
  for (const child of element.children) {
    if (child.tag !== 'ownedComment') {
      continue;
    }
    const annotatesThis = annotatedElementRefs(child, file)
      .some((ref) => ref.fragment === id && (ref.file === null || ref.file === file));
    if (annotatesThis) {
      node.comments.push(...collectCommentBodies(child));
    }
  }

  // Sub-packages: packagedElement children typed as Package/Model, in
  // document order. Packages may also sit inside non-package elements
  // (a uml:Component can own packages); those are attached to the
  // nearest package ancestor so they stay part of the documentation
  // tree. Other non-package elements (classes, actors, …) are not part
  // of the tree themselves.
  const walkForPackages = (parentElement) => {
    for (const child of parentElement.children) {
      if (child.tag !== 'packagedElement') {
        continue;
      }
      if (PACKAGE_TYPES.has(child.attrs['xmi:type'] ?? '')) {
        node.children.push(buildPackage(child, node, file, ctx));
      } else {
        walkForPackages(child);
      }
    }
  };
  walkForPackages(element);
  return node;
}

/**
 * Records an id → object mapping, both per-file (exact) and globally
 * (first-wins, used for `uml:#<id>` references).
 */
function registerId(ctx, file, id, entry) {
  if (id === '') {
    return;
  }
  ctx.idsByFile.get(file)?.set(id, entry) ?? ctx.idsByFile.set(file, new Map([[id, entry]]));
  if (!ctx.idsGlobal.has(id)) {
    ctx.idsGlobal.set(id, entry);
  } else {
    ctx.duplicateIds.add(id);
  }
}

/**
 * Computes and indexes the qualified-name variants of every package.
 * A package answers both to its full UML qualified name (including the
 * root model's name, e.g. `example::Documentation::arc42`) and to the
 * variant without the root segment (`Documentation::arc42`), since
 * users usually think of the packages below the model root.
 */
function indexQualifiedNames(root, ctx) {
  const walk = (node, segments) => {
    const withRoot = [...segments, node.name];
    const variants = new Set();
    variants.add(withRoot.join('::'));
    if (withRoot.length > 1) {
      variants.add(withRoot.slice(1).join('::'));
    }
    node.qualifiedNames = [...variants];
    for (const fqn of node.qualifiedNames) {
      const list = ctx.packagesByFqn.get(fqn) ?? [];
      list.push(node);
      ctx.packagesByFqn.set(fqn, list);
    }
    const nameList = ctx.packagesByName.get(node.name) ?? [];
    nameList.push(node);
    ctx.packagesByName.set(node.name, nameList);
    for (const child of node.children) {
      walk(child, withRoot);
    }
  };
  walk(root, []);
}

/**
 * Extracts GMF diagrams from a parsed .notation resource. The resource
 * root is either a single notation:Diagram or an xmi:XMI wrapper
 * holding several.
 *
 * @param {object} root  parsed root element
 * @param {string} file  absolute path of the .notation file
 * @returns {Array<object>} raw diagram records (owner not yet resolved)
 */
function extractNotationDiagrams(root, file) {
  const nodes = root.tag === 'xmi:XMI'
    ? root.children.filter((child) => child.tag === 'notation:Diagram')
    : (root.tag === 'notation:Diagram' ? [root] : []);
  const diagrams = [];
  for (const diagram of nodes) {
    // "Directly placed within a package" means the Model Explorer
    // placement, which Papyrus persists as the <owner> inside the
    // PapyrusDiagramStyle. The diagram-level <element href="…"/> (the
    // depicted root, usually identical) is the fallback; child views
    // may carry xsi:nil elements, so only diagram-level children count.
    let ownerRef = null;
    for (const style of diagram.children.filter((child) => child.tag === 'styles')) {
      for (const owner of style.children.filter((child) => child.tag === 'owner')) {
        if (owner.attrs.href) {
          ownerRef = resolveHref(owner.attrs.href, file);
          break;
        }
      }
      if (ownerRef !== null) break;
    }
    if (ownerRef === null) {
      for (const child of diagram.children) {
        if (child.tag === 'element' && child.attrs.href) {
          ownerRef = resolveHref(child.attrs.href, file);
          break;
        }
      }
    }
    diagrams.push({
      id: diagram.attrs['xmi:id'] ?? '',
      name: diagram.attrs.name ?? '',
      kind: 'notation',
      file,
      ownerRef,
    });
  }
  return diagrams;
}

/**
 * Extracts Sirius representation descriptors from a parsed .aird
 * resource (elements tagged ownedRepresentationDescriptors at any
 * depth — they live inside DView containers).
 *
 * @param {object} root  parsed root element
 * @param {string} file  absolute path of the .aird file
 * @returns {Array<object>} raw diagram records (owner not yet resolved)
 */
function extractAirdRepresentations(root, file) {
  const found = [];
  const walk = (node) => {
    if (node.tag === 'ownedRepresentationDescriptors') {
      let ownerRef = null;
      for (const child of node.children) {
        if (child.tag === 'target' && child.attrs.href) {
          ownerRef = resolveHref(child.attrs.href, file);
          break;
        }
      }
      found.push({
        id: node.attrs.uid ?? node.attrs['xmi:id'] ?? '',
        name: node.attrs.name ?? '',
        kind: 'aird',
        file,
        ownerRef,
      });
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  return found;
}

/**
 * Loads the model directory.
 *
 * @param {string} modelDir absolute path of the model directory
 * @param {(msg: string) => void} warn callback for non-fatal findings
 * @returns {{
 *   roots: Array<PackageNode>,
 *   diagrams: Array<DiagramInfo>,
 *   diagramsById: Map<string, DiagramInfo>,
 *   diagramsByFqn: Map<string, Array<DiagramInfo>>,
 *   diagramsByName: Map<string, Array<DiagramInfo>>,
 *   packagesByFqn: Map<string, Array<PackageNode>>,
 *   packagesByName: Map<string, Array<PackageNode>>,
 *   idsGlobal: Map<string, {kind: string, node: object}>,
 *   idsByFile: Map<string, Map<string, {kind: string, node: object}>>,
 *   duplicateIds: Set<string>,
 * }} the loaded model
 */
export function loadModel(modelDir, warn) {
  const ctx = {
    idsByFile: new Map(),
    idsGlobal: new Map(),
    duplicateIds: new Set(),
    packagesByFqn: new Map(),
    packagesByName: new Map(),
  };

  // ---- Semantic model (.uml) --------------------------------------------
  const umlFiles = listFiles(modelDir, '.uml');
  if (umlFiles.length === 0) {
    throw new Error(`no .uml files found under ${modelDir}`);
  }
  const roots = [];
  for (const file of umlFiles) {
    const parsed = parseXml(fs.readFileSync(file, 'utf8'), file);
    // The root is either a bare uml:Model/uml:Package or an xmi:XMI
    // wrapper that additionally carries stereotype applications.
    const candidates = parsed.tag === 'xmi:XMI' ? parsed.children : [parsed];
    const typeOf = (el) => (PACKAGE_TYPES.has(el.tag) || SKIPPED_ROOT_TYPES.has(el.tag)
      ? el.tag
      : el.attrs['xmi:type'] ?? '');
    const modelElements = candidates.filter((el) => PACKAGE_TYPES.has(typeOf(el)));
    if (modelElements.length === 0) {
      // Profiles (*.profile.uml) are expected companions of a Papyrus
      // model — skip them without noise; anything else is worth a hint.
      if (!candidates.some((el) => SKIPPED_ROOT_TYPES.has(typeOf(el)))) {
        warn(`no uml:Model root found in ${file} — skipping this file`);
      }
      continue;
    }
    for (const element of modelElements) {
      const root = buildPackage(element, null, file, ctx);
      indexQualifiedNames(root, ctx);
      roots.push(root);
    }
  }
  if (roots.length === 0) {
    throw new Error(`no UML model roots found under ${modelDir}`);
  }

  // ---- Diagrams (GMF notation first, then Sirius .aird) -------------------
  // Discovery mirrors papyrus-export-diagrams exactly, because the
  // filename stems must match its output: GMF diagrams are found via
  // .di files with a same-basename .notation sibling (files sorted by
  // full path, diagrams in document order) with ONE stem deduper for
  // the whole pipeline; .aird files get a fresh deduper each.
  const rawDiagrams = [];
  const notationDedupe = makeStemDeduper();
  const consumedNotation = new Set();
  for (const diFile of listFiles(modelDir, '.di')) {
    const notationFile = `${diFile.slice(0, -'.di'.length)}.notation`;
    if (!fs.existsSync(notationFile)) {
      continue;
    }
    consumedNotation.add(notationFile);
    for (const raw of extractNotationDiagrams(parseXml(fs.readFileSync(notationFile, 'utf8'), notationFile), notationFile)) {
      raw.imageStem = notationDedupe(sanitizeName(raw.id !== '' ? raw.id : 'diagram'));
      rawDiagrams.push(raw);
    }
  }
  for (const file of listFiles(modelDir, '.notation')) {
    if (!consumedNotation.has(file)) {
      warn(`${file} has no same-name .di sibling — papyrus-export-diagrams ignores it, so its diagrams have no images`);
    }
  }
  for (const file of listFiles(modelDir, '.aird')) {
    const airdDedupe = makeStemDeduper();
    for (const raw of extractAirdRepresentations(parseXml(fs.readFileSync(file, 'utf8'), file), file)) {
      raw.imageStem = airdDedupe(sanitizeName(raw.id !== '' ? raw.id : 'representation'));
      rawDiagrams.push(raw);
    }
  }

  const diagrams = [];
  const diagramsById = new Map();
  const diagramsByFqn = new Map();
  const diagramsByName = new Map();
  for (const raw of rawDiagrams) {
    // Resolve the owning package. Hrefs into resources we cannot map
    // to a file (platform:/resource/… URIs) fall back to the global id
    // index — fragments are unique enough in practice.
    let owner = null;
    if (raw.ownerRef !== null) {
      const entry = (raw.ownerRef.file !== null
        ? ctx.idsByFile.get(raw.ownerRef.file)?.get(raw.ownerRef.fragment)
        : undefined)
        ?? ctx.idsGlobal.get(raw.ownerRef.fragment);
      if (entry?.kind === 'package') {
        owner = entry.node;
      }
    }
    const info = {
      id: raw.id,
      name: raw.name,
      kind: raw.kind,
      file: raw.file,
      imageStem: raw.imageStem,
      ownerId: owner?.id ?? null,
      ownerFile: owner?.file ?? null,
    };
    diagrams.push(info);
    if (owner !== null) {
      owner.diagrams.push(info);
      for (const ownerFqn of owner.qualifiedNames) {
        const fqn = `${ownerFqn}::${info.name}`;
        const list = diagramsByFqn.get(fqn) ?? [];
        list.push(info);
        diagramsByFqn.set(fqn, list);
      }
    } else {
      warn(`diagram '${raw.name || raw.id}' in ${raw.file} is not owned by a package of this model — it will not be embedded automatically`);
    }
    if (raw.id === '') {
      warn(`diagram '${raw.name}' in ${raw.file} has no id — it cannot be referenced via uml:#<id>`);
    } else if (diagramsById.has(raw.id)) {
      warn(`duplicate diagram id '${raw.id}' — uml:# references by this id are ambiguous`);
    } else {
      diagramsById.set(raw.id, info);
    }
    if (info.name !== '') {
      const list = diagramsByName.get(info.name) ?? [];
      list.push(info);
      diagramsByName.set(info.name, list);
    }
  }

  return {
    roots,
    diagrams,
    diagramsById,
    diagramsByFqn,
    diagramsByName,
    packagesByFqn: ctx.packagesByFqn,
    packagesByName: ctx.packagesByName,
    idsGlobal: ctx.idsGlobal,
    idsByFile: ctx.idsByFile,
    duplicateIds: ctx.duplicateIds,
  };
}

/**
 * Resolves the `start-package` input to a package node.
 *
 * Resolution rules:
 * - empty        → the single model root (error if the model directory
 *                  contains more than one root model)
 * - contains ::  → exact qualified-name match, with or without the
 *                  root model's name as first segment
 * - otherwise    → xmi:id match first, then a unique package with that
 *                  name (root models themselves included)
 *
 * @param {object} model  result of loadModel()
 * @param {string} input  the raw start-package input ('' for default)
 * @returns {PackageNode} the resolved starting package
 */
export function resolveStartPackage(model, input) {
  const trimmed = input.trim();
  if (trimmed === '') {
    if (model.roots.length > 1) {
      const names = model.roots.map((root) => `'${root.name}'`).join(', ');
      throw new Error(`the model directory contains ${model.roots.length} root models (${names}) — set the start-package input to choose one`);
    }
    return model.roots[0];
  }

  if (trimmed.includes('::')) {
    const matches = model.packagesByFqn.get(trimmed) ?? [];
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      throw new Error(`start-package '${trimmed}' is ambiguous (${matches.length} matches) — qualify it with the root model name`);
    }
    throw new Error(`start-package '${trimmed}' does not match any package qualified name`);
  }

  const byId = model.idsGlobal.get(trimmed);
  if (byId?.kind === 'package') {
    if (model.duplicateIds.has(trimmed)) {
      throw new Error(`start-package id '${trimmed}' occurs in more than one model file — use a qualified name instead`);
    }
    return byId.node;
  }
  const byName = model.packagesByName.get(trimmed) ?? [];
  if (byName.length === 1) {
    return byName[0];
  }
  if (byName.length > 1) {
    throw new Error(`start-package '${trimmed}' is ambiguous (${byName.length} packages carry this name) — use a qualified name`);
  }
  throw new Error(`start-package '${trimmed}' matches neither a package id nor a package name`);
}
