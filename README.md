# papyrus-export-markdown (GitHub action)

Exports markdown documentation from the package tree of a Papyrus model:
one markdown file per package, filled with the package's documentation
comments, diagram images in place, plus table-of-contents generation.

Tested against Papyrus-Desktop **7.1.0** (Eclipse 2025-06).

## Quick start

In any consuming repo, drop a workflow like this in
`.github/workflows/export-docs.yml`:

```yaml
name: Export documentation
on:
  push:
    paths: ['model/**']
permissions:
  contents: write
jobs:
  export:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - id: papyrus
        uses: thomas-worm/setup-papyrus@v1
      - uses: thomas-worm/papyrus-export-markdown@v1
        with:
          papyrus-home:     ${{ steps.papyrus.outputs.papyrus-home }}
          papyrus-launcher: ${{ steps.papyrus.outputs.papyrus-launcher }}
          model-dir:        model
          output-dir:       docs
      - run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add docs
          git diff --staged --quiet || \
            (git commit -m "docs: re-export documentation [skip ci]" && \
             git push origin HEAD:${GITHUB_REF#refs/heads/})
```

Diagram images are produced by
[thomas-worm/papyrus-export-diagrams](https://github.com/thomas-worm/papyrus-export-diagrams),
which this action calls internally — hence the `setup-papyrus` step. If
you already run the diagram export yourself (with `naming: xmiId` and
the same format), pass its output directory as `images-dir` and both
the internal export and the `papyrus-home` input become unnecessary.

## Inputs

| Input               | Default     | Description |
| ------------------- | ----------- | --- |
| `model-dir`         | `model`     | Scanned recursively for `*.uml`, `*.di`/`*.notation` and `*.aird` files. GMF diagrams need their `.di` file (same rule as `papyrus-export-diagrams`). |
| `start-package`     | model root  | Package to start from: qualified name (`Documentation::arc42`, with or without the root model name) or `xmi:id`. |
| `output-dir`        | —           | Root of the generated markdown tree. Created if missing. |
| `include-diagrams`  | `true`      | Embed diagrams placed directly inside a package into that package's file (see ordering rules below). |
| `diagram-format`    | `SVG`       | One of `SVG`, `PNG`, `JPEG`, `BMP`, `GIF`. |
| `images-subdir`     | `images`    | Directory below `output-dir` holding the diagram images. |
| `images-dir`        | —           | Pre-exported diagram images (`naming: xmiId`). Skips the internal diagram export. |
| `index-file`        | `README.md` | Per-package file name; use `index.md` for MkDocs-style sites. |
| `add-title`         | `true`      | Start every file with a `# <package name>` heading. |
| `papyrus-home`      | —           | From `setup-papyrus`. Required unless `images-dir` is set. |
| `papyrus-launcher`  | —           | From `setup-papyrus`. Optional. |
| `fail-on-error`     | `true`      | Fail on export errors and unresolvable `uml:#` references. Set to `false` to get partial output with warnings. |

## Outputs

| Output          | Description |
| --------------- | --- |
| `package-count` | Number of markdown files generated (one per package). |
| `diagram-count` | Number of distinct diagram images embedded or referenced. |

## How the documentation is modelled

The text shown in Papyrus Desktop's *Documentation* view of a package is
stored as a `Comment` owned by the package that *annotates* the package.
Exactly those comments become the package's markdown content, in model
order, emitted verbatim — write markdown in the Documentation textarea
and it ends up 1:1 in the generated file.

The package tree becomes the folder tree: every package is a directory
with one `index-file` inside; the starting package's file sits directly
in `output-dir`. Directory names are the package names with unsafe
characters replaced by `_`.

Diagrams placed inside a package are appended after the package's
comments (with `include-diagrams: true`). Papyrus does not persist an
ordering between comments and diagrams, so to place a diagram at an
exact position — for example between two paragraphs — reference it
explicitly with a `uml:#` image link; explicitly referenced diagrams
are not appended a second time.

## Referencing model content from comments

Inside comment bodies the following link forms are rewritten:

- `![Alt text](uml:#_DjtpcGsBEfGhz_JEWM1XrA)` — a diagram by its unique
  id (the `xmi:id` of the diagram in the `.notation` file, or the
  descriptor `uid` in the `.aird` file).
- `![Alt text](<uml:#Documentation::Building Block View::BuildingBlockView>)`
  — a diagram by qualified name: the owning packages' names plus the
  diagram name, `::`-separated. The root model name may be omitted.
  Wrap the URI in `<…>` when names contain spaces (or `%20`-encode).
- `![Alt text](<uml:#Documentation::Building Block View>)` — when the
  reference resolves to a *package* instead of a diagram, an image link
  embeds all diagrams placed directly in that package.
- `[Link text](<uml:#Documentation::Glossary>)` — a plain (non-image)
  link to a package becomes a link to that package's generated file.
- `![Alt text](images/photo.png)` — plain relative references are
  resolved against the folder of the model file that contains the
  comment; the referenced files are copied into the output tree and the
  paths adjusted automatically.

## Table of contents

Put a TOC directive into any documentation comment:

```markdown
<!-- toc -->
```

It expands to a nested bullet list of all sub-packages of the current
package, linking their generated files. An optional
`<!-- toc --maxdepth=2 -->` limits the nesting depth. The generated list
is wrapped in `<!-- toc -->` … `<!-- tocstop -->` markers, so the
directive stays invisible in unprocessed markdown and re-exports are
idempotent. `[[_TOC_]]` and `[TOC]` (alone on a line) are accepted as
aliases.

## Notes

- The markdown generation itself is plain Node.js (preinstalled on all
  GitHub-hosted runners) — Papyrus is only needed for rendering the
  diagram images.
- Diagram image files are named by diagram id (`naming: xmiId` of the
  diagram export); this is what makes `uml:#` references resolvable, so
  pre-exported images passed via `images-dir` must use that mode.
- Diagrams that exist in the model but were skipped by the diagram
  export (for example content-less Sirius representations) are dropped
  from automatic embedding with a warning; only explicitly referenced
  diagrams without an image fail the action.
- The sample model under `model/` is an arc42 documentation skeleton
  used by this repo's test workflow. The workflow also publishes the
  model's `Documentation` package as a rendered site at
  <https://thomas-worm.github.io/papyrus-export-markdown/> — see the
  `deployPages` job for a copyable GitHub Pages setup (export with
  `index-file: index.md`, render with `actions/jekyll-build-pages`,
  deploy with `actions/deploy-pages`).
