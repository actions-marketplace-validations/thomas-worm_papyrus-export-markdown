/*
 * Copyright (c) 2026 Thomas Worm
 * SPDX-License-Identifier: MIT
 */

/**
 * CI verification for the markdown export of the sample model.
 *
 * Usage:
 *   node verify-docs.mjs --docs <dir> --index README.md \
 *     --expect-packages 29 --reported-packages <action output>
 *
 * Checks, in order:
 * 1. the number of generated index files matches the expectation and
 *    the action's package-count output;
 * 2. no unresolved `uml:#` reference survives in any generated file;
 * 3. every relative image/link target referenced from a generated file
 *    exists on disk (catches broken diagram/asset paths);
 * 4. every TOC directive has been expanded (a marker pair with at
 *    least one list entry in between).
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** Same inline-reference pattern the generator uses. */
const INLINE_REF = /(!?)\[((?:\\.|[^\]\\])*)\]\(\s*(?:<([^<>]*)>|([^()\s]+))(\s+"[^"]*"|\s+'[^']*')?\s*\)/g;

const options = {
  docs: '',
  index: 'README.md',
  'expect-packages': '',
  'reported-packages': '',
  'expect-diagrams': '',
  'reported-diagrams': '',
};
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i].replace(/^--/, '');
  if (!(flag in options)) {
    console.log(`::error::verify-docs: unknown option --${flag}`);
    process.exit(2);
  }
  options[flag] = process.argv[i + 1] ?? '';
}

const docsDir = path.resolve(options.docs);
let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`::error::verify-docs: ${msg}`);
};

/** Recursively collects files below dir. */
const collect = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collect(full));
    } else {
      out.push(full);
    }
  }
  return out;
};

const files = collect(docsDir);
const indexFiles = files.filter((file) => path.basename(file) === options.index);

// 1. Package counts.
const expected = Number.parseInt(options['expect-packages'], 10);
if (indexFiles.length !== expected) {
  fail(`expected ${expected} ${options.index} files, found ${indexFiles.length}`);
}
if (options['reported-packages'] !== String(expected)) {
  fail(`action reported package-count=${options['reported-packages']}, expected ${expected}`);
}
if (options['expect-diagrams'] !== '' && options['reported-diagrams'] !== options['expect-diagrams']) {
  fail(`action reported diagram-count=${options['reported-diagrams']}, expected ${options['expect-diagrams']}`);
}

for (const file of indexFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const rel = path.relative(docsDir, file);

  // 2. No unresolved uml:# references.
  if (content.includes('](uml:#') || content.includes('](<uml:#')) {
    fail(`${rel}: contains an unresolved uml:# reference`);
  }

  // 3. Relative targets must exist.
  for (const match of content.matchAll(INLINE_REF)) {
    const url = match[3] ?? match[4];
    if (/^([a-zA-Z][a-zA-Z0-9+.-]*:|\/|#)/.test(url)) {
      continue; // external / absolute / anchor
    }
    const target = path.resolve(path.dirname(file), decodeURIComponent(url.split('#')[0]));
    if (!fs.existsSync(target)) {
      fail(`${rel}: broken relative reference '${url}'`);
    }
  }

  // 4. TOC directives must be expanded.
  for (const toc of content.matchAll(/<!--\s*toc[^>]*-->([\s\S]*?)<!--\s*tocstop\s*-->/g)) {
    if (!/^\s*-\s+\[/m.test(toc[1])) {
      fail(`${rel}: TOC directive was not expanded to a list`);
    }
  }
  if (/^\[\[_TOC_\]\]|^\[TOC\]/m.test(content)) {
    fail(`${rel}: TOC alias survived unexpanded`);
  }
}

if (failures > 0) {
  console.log(`::error::verify-docs: ${failures} check(s) failed for ${docsDir}`);
  process.exit(1);
}
console.log(`verify-docs: OK — ${indexFiles.length} package files under ${docsDir}`);
