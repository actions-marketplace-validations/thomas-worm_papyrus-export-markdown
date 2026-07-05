/*
 * Copyright (c) 2026 Thomas Worm
 * SPDX-License-Identifier: MIT
 */

/**
 * CLI entry point of the export-papyrus-markdown action.
 *
 * Reads a Papyrus model directory, walks the package tree from a
 * configurable starting package and writes one markdown file per
 * package (see lib/markdown.mjs for the emission rules). Diagram
 * images are expected in `<output-dir>/<images-subdir>` under their
 * xmi-id filenames — either exported there beforehand by
 * thomas-worm/papyrus-export-diagrams or copied from a pre-exported
 * directory passed via --images-source.
 *
 * Runs on any Node.js ≥ 18 (only node: builtins, no dependencies).
 *
 * Usage:
 *   node export-markdown.mjs --model-dir model --output-dir docs \
 *     [--start-package 'Documentation::arc42'] [--images-subdir images] \
 *     [--images-source /pre/exported] [--index-file README.md] \
 *     [--diagram-format SVG] [--include-diagrams true] \
 *     [--add-title true] [--fail-on-error true]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { loadModel, resolveStartPackage } from './lib/model.mjs';
import { generateDocs, imageExtension } from './lib/markdown.mjs';

/**
 * Parses `--name value` style arguments into an object; every option
 * has a default so the script can run without the action wrapper.
 *
 * @param {Array<string>} argv process arguments after the script path
 * @returns {Object<string, string>} option map
 */
function parseArgs(argv) {
  const options = {
    'model-dir': 'model',
    'start-package': '',
    'output-dir': '',
    'images-subdir': 'images',
    'images-source': '',
    'index-file': 'README.md',
    'diagram-format': 'SVG',
    'include-diagrams': 'true',
    'add-title': 'true',
    'fail-on-error': 'true',
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag.startsWith('--') || !(flag.slice(2) in options)) {
      throw new Error(`unknown option '${flag}'`);
    }
    if (i + 1 >= argv.length) {
      throw new Error(`missing value for option '${flag}'`);
    }
    options[flag.slice(2)] = argv[i + 1];
  }
  return options;
}

/** Interprets an action boolean input ('true'/'false', case-insensitive). */
function toBool(value, name) {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`input ${name} must be 'true' or 'false', got '${value}'`);
}

/** Appends a name=value pair to $GITHUB_OUTPUT when running in Actions. */
function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}${os.EOL}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options['output-dir'] === '') {
    throw new Error('--output-dir is required');
  }
  const modelDir = path.resolve(options['model-dir']);
  const outputDir = path.resolve(options['output-dir']);
  if (!fs.existsSync(modelDir) || !fs.statSync(modelDir).isDirectory()) {
    throw new Error(`model directory not found: ${modelDir}`);
  }
  const failOnError = toBool(options['fail-on-error'], 'fail-on-error');
  const ext = imageExtension(options['diagram-format']);

  // Findings are emitted as GitHub workflow annotations. `problem`s
  // fail the action when fail-on-error is set; `warn`ings never do.
  let warningCount = 0;
  let problemCount = 0;
  const warn = (msg) => {
    warningCount += 1;
    console.log(`::warning::${msg}`);
  };
  const problem = (msg) => {
    problemCount += 1;
    console.log(`::${failOnError ? 'error' : 'warning'}::${msg}`);
  };

  // ---- Stage diagram images ------------------------------------------
  // With --images-source the images were exported by an earlier
  // papyrus-export-diagrams step (naming: xmiId) into some directory —
  // copy them into the output tree so the generated links are
  // self-contained. Without it the action's own export step has
  // already written them to <output-dir>/<images-subdir>.
  const imagesDir = path.join(outputDir, options['images-subdir']);
  if (options['images-source'] !== '') {
    const source = path.resolve(options['images-source']);
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
      throw new Error(`images-dir not found: ${source}`);
    }
    fs.mkdirSync(imagesDir, { recursive: true });
    if (path.relative(imagesDir, source) !== '') {
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (entry.isFile()) {
          fs.copyFileSync(path.join(source, entry.name), path.join(imagesDir, entry.name));
        }
      }
    }
  }

  // ---- Load, resolve, generate -----------------------------------------
  const model = loadModel(modelDir, warn);
  const startPkg = resolveStartPackage(model, options['start-package']);
  console.log(`Starting package: '${startPkg.name}' (${startPkg.id})`);
  console.log(`Model: ${model.roots.length} root(s), ${model.diagrams.length} diagram(s)`);

  const stats = generateDocs(model, startPkg, {
    outputDir,
    modelDir,
    imagesSubdir: options['images-subdir'],
    indexFile: options['index-file'],
    ext,
    includeDiagrams: toBool(options['include-diagrams'], 'include-diagrams'),
    addTitle: toBool(options['add-title'], 'add-title'),
    warn,
    problem,
  });

  console.log(`Generated ${stats.packageCount} markdown file(s), ${stats.diagramCount} diagram image(s) referenced.`);
  setOutput('package-count', stats.packageCount);
  setOutput('diagram-count', stats.diagramCount);

  if (problemCount > 0 && failOnError) {
    console.log(`::error::${problemCount} reference problem(s) — failing (set fail-on-error: false to tolerate).`);
    process.exit(1);
  }
  if (warningCount > 0) {
    console.log(`${warningCount} warning(s).`);
  }
}

try {
  main();
} catch (error) {
  console.log(`::error::${error.message}`);
  process.exit(1);
}
