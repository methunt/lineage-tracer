# lineage-bridge

End-to-end column lineage: from a **dbt source**, through every dbt model, across
the warehouse boundary into a **Power BI** semantic model, to the **visual** that
renders it.

One question, answered exactly: *if I change this column, what breaks?*

The design contract is [docs/ui-spec.md](docs/ui-spec.md). This file is how to run it.

## Quick start

The app is the tool. It runs entirely in the browser — the extractor included —
so there is nothing to install for the people who only need to *read* a graph.

```bash
npm install
npm run build:web        # → ui/dist-web  (one command; see "Hosting")
npx serve ui/dist-web
```

Open it and hand it four things — `manifest.json`, `catalog.json`, the mapping
workbook and the PBIP folder — and it builds the graph in the tab. Nothing is
uploaded. All four are required: **Build lineage** stays disabled until every
slot is filled.

The two dbt artifacts are told apart by content, not by filename, so dropping
the catalog into the manifest slot is refused on the spot rather than after the
extraction — `metadata.dbt_schema_version` when dbt wrote one, otherwise the
shape (`parent_map`/`macros` for a manifest, per-node `stats` for a catalog).
Rename the files however you like.

Press **Export** in the header and you get one self-contained `.html` file: no
server, no sidecar assets, openable off disk by someone who has never heard of
this tool.

The CLI is what remains for automation, and it writes the graph rather than a
report:

```bash
node src/cli.js graph \
  --manifest  path/to/dbt/target/manifest.json \
  --catalog   path/to/dbt/target/catalog.json \
  --pbip      "path/to/MyProject" \
  --mapping   mapping.xlsx \
  --out       graph.json
```

> **The manifest must contain compiled SQL.** Run `dbt compile` (or `dbt run` /
> `dbt build`) before exporting `target/manifest.json`. A parse-only manifest
> still produces the dbt→Power BI links, but no lineage *inside* dbt.

## Inputs

| Input | Required | Notes |
|---|---|---|
| `--manifest` | yes | dbt `target/manifest.json`, compiled |
| `--catalog` | yes | dbt `target/catalog.json` — supplies real column types |
| `--pbip` | yes | PBIP project root, holding `<name>.SemanticModel` and `<name>.Report` |
| `--mapping` | no | `.xlsx` or `.csv` — only needed where the link can't be derived |
| `--layers` | no | layer order, e.g. `base,staging,warehouse,analytics`. Auto-detected from folders if omitted |

Scope is one dbt project and one report per run.

## How the join works

`From` is always the warehouse relation dbt builds; `To` is always the Power BI
object. Two mechanisms, in precedence order:

1. **Mapping workbook** — your rows always win. A row asserts a link that may
   cross layers the tool cannot see (views, a second warehouse, native SQL).
   These render as **dashed** edges, marked *declared*.
2. **Automatic matching** — resolved by reading the M query back to
   `project.dataset.table` / `schema.table`. Rendered **solid**, marked *derived*.
   Degrades `database.schema.table` → `schema.table` → `table`, and every
   degraded or ambiguous match is reported rather than trusted silently.

A human assertion and a machine-verified fact never look the same on screen.

### Custom M source functions

Many enterprise models wrap their source in a helper:

```m
Source = fn_get_table(p_project, p_dataset, "dim_customer", Fields)
```

The M parser can't follow a user-defined function, so the lineage is
invisible to it. [`src/m-inline.js`](src/m-inline.js) resolves the arguments to
literals, substitutes them into the function body, normalises the navigation
steps, and prepends the result to the partition source — the upstream parser then
resolves the table as if the chain had been written inline. On a large real-world
project this took the build from **no links at all to dozens**. pbip-documenter itself is
never modified.

## Mapping workbook

One sheet named `mapping`:

| From Database | From Schema | From Table | From Column | To Table | To Column |
|---|---|---|---|---|---|
| ANALYTICS | marts | fct_sales | *(blank)* | Sales | *(blank)* |
| ANALYTICS | marts | dim_customer | `cust_key` | Customer | `CustomerID` |

- Both column cells **blank** → table-level row; columns auto-match by name.
- Both **filled** → column-level row. Use only for genuine renames.
- Exactly one filled is an **error**, reported rather than guessed.

The app's Diagnostics tab lists the tables whose source could not be resolved —
those are the rows worth writing.

## The graph

**Lineage tab** — layer and kind pills, search, and one left-to-right
DAG laid out in swimlanes (`sources → base → staging → warehouse → analytics →
Power BI`). Table nodes expand to their columns; selecting a column dims
everything except its path, all the way to the visuals.

**Side panel** — Overview (impact), Definition (compiled SQL / DAX / M, with the
authored M shown next to what we resolved it to), Metadata (description, tags,
tests, renames, columns).

**Diagnostics tab** — every gap between the two graphs, ordered by how actionable
it is. Rows link back into the graph.

### Impact analysis

Blast radius and breakage are kept strictly separate.

- **Blast radius** is exact graph traversal: "12 measures and 4 visuals downstream".
  Banded High ≥ 10 visuals / Medium ≥ 3 / Low ≥ 1, with the raw counts always
  shown next to the band and the thresholds stated in the panel.
- **Breakage** shows a `BROKEN` chip only where the artifacts prove it — a visual
  referencing a field that does not exist. Severity is never inferred. There is
  no heuristic `CRITICAL`.

Selecting a table gives the union across its columns ("if I drop this model");
selecting a column gives just that column ("if I rename this field").

## Architecture

```
manifest.json + catalog.json ─┐
                              ├─► Python: colibri DbtColumnLineageExtractor ─┐
PBIP folder ──────────────────┤                                              ├─► merge ─► one graph
                              ├─► Node: pbip-documenter parsers + m-inline ──┤
mapping.xlsx ─────────────────┴──────────────────────────────────────────────┘
```

The same merge runs in two places: as Node, from the CLI, and as the same
sources put through a bundler in the browser (`src/build-browser.js`, driven by
`ui/src/web/`). `src/report-data.js` is the one projection both produce.

| File | |
|---|---|
| `src/cli.js` | `graph` |
| `src/build.js` | Orchestration; spawns Python once, passes its stderr through |
| `src/dbt_extract.py` | Wraps colibri's extractor, emits our schema |
| `src/pbip-extract.js` | Runs the PBIP parsers in `src/pbip/` headless |
| `src/m-inline.js` | Expands user-defined M source functions |
| `src/pbi-graph.js` | Power BI side → our schema |
| `src/graph-builder.js` | The join, diagnostics, and impact |
| `ui/src/web/export-viewer.js` | Injects a graph into the viewer template — the Export button |
| `ui/` | React + React Flow + ELK + Tailwind, built by Vite to two targets |
| `test/` | End-to-end build, escaping, and jsdom render assertions |

**Neither upstream is modified.** colibri is imported as a library; the two
quirks of running pbip-documenter headless are handled on our side.

### Build notes — two targets, one an asset of the other

`ui/vite.config.js` builds the app twice:

| Mode | Output | What it is |
|---|---|---|
| `--mode web` | `ui/dist-web/` | The hosted app. Chunked ESM, lazy chunks, a module worker |
| default | `ui/dist/index.html` | The **viewer**: the same app collapsed into one self-contained file, with no data in it |

Nobody visits the viewer. `npm run build:web` builds it first, stages it at
`ui/public/viewer.html` (`scripts/stage-viewer.mjs`), and the web build copies it
into `dist-web` like any other public asset. Export fetches it **on click** —
it is ~2 MB and most sessions never export — and injects the current graph.

- The viewer bundles as a **classic IIFE, not an ES module** — inline module
  scripts are the thing browsers refuse on `file://` origins, and it keeps an
  export testable in jsdom.
- The graph is injected **before** the app bundle, because the store reads
  `globalThis.__LINEAGE__` at module evaluation time. That is the same global
  `loadGraph` writes, so the viewer needs no code path of its own.
- The injection escapes `<`, `>`, `&` and U+2028/9 as `\uXXXX`. Column and table
  names are attacker-influenced text going into a `<script>` element, and
  `JSON.stringify` alone does not close that. See the comment in
  `ui/src/web/export-viewer.js` and the proof in `test/export.js`.
- `ui/dist/`, `ui/dist-web/` and `ui/public/viewer.html` are build artifacts and
  gitignored.

## Testing

```bash
npm run build:viewer   # once — the template the render tests inject into
npm test               # data + escaping + jsdom render — no browser needed
npm run test:browser   # real Chromium; needs `npx playwright install chromium` once
npm run build:web && npm run test:web        # the hosted app, end to end
npm run test:web:dev                          # the same, against the dev server
```

`npm test` builds from `../samples/` and asserts the data (dbt lineage resolved,
four cross-links, all five node kinds, a source reaching a visual, bands
assigned), the export's escaping (`test/export.js` — a graph whose names carry
`</script>`, `<!--`, `-->` and U+2028/9, which must parse and come back
byte-identical), and the rendered DOM in jsdom (app mounts, layout completes,
every visible node positioned, no runtime errors).

`npm run test:browser` opens an exported file from `file://` in Chromium and
drives the real interaction: expand a table, select a column, read the impact
panel, switch to Diagnostics. It also asserts a node is the topmost element at
its own coordinates.

`npm run test:web` drives the hosted app: four files in, the same graph out as
the CLI builds from the same four files — then presses Export, opens the
downloaded file from a `file://` URL in a fresh page, and asserts it renders the
same graph. An export that downloads but does not open is the failure mode that
otherwise slips through.

They exist because the failure modes here are invisible to each other: jsdom
cannot execute ES modules or enforce pointer-event layering, so it happily passed
a page that was blank in a browser and one whose nodes could not be clicked.

### Live development

```bash
npm run dev:data -- --manifest <f> --catalog <f> --pbip <dir>   # writes ui/dev-data.json
npm run dev                                                      # http://localhost:5173
```

A serve-only Vite plugin injects `ui/dev-data.json` the same way an export
injects its data, so dev and the exported file show the same thing. The file is
watched — regenerate it and the page reloads.

## Hosting

The same tool, without the CLI: a fully client-side build that runs the Python
extractor in the browser and is served as static files from GitHub Pages.

```bash
npm run build:web        # → ui/dist-web
npx serve ui/dist-web    # any static server; not file://, the worker needs an origin
```

What gets deployed is `ui/dist-web` and nothing else — the app bundle, the
vendored sqlglot wheel and extractor sources under `py/`, and a service worker.
No server, no API, no upload: the manifest, catalog and PBIP files a user picks
never leave their machine.

`.github/workflows/pages.yml` builds and publishes it on every push to `main`.
**One-time setup:** Settings → Pages → Build and deployment → Source →
**GitHub Actions**. Until that is set the workflow succeeds and deploys nowhere.

### The download story

| Visit | Over the wire |
|---|---|
| First | ~7 MB — Pyodide's wasm runtime and Python stdlib from jsDelivr, plus ~0.8 MB of wheel and sources |
| Second | ~0 — all of it served from the service worker's cache |

Every cached URL is version-pinned, so the cache is never wrong; the app shell
itself is deliberately **not** cached, so a deploy is live the moment it lands.

## Licence

MIT. Uses [dbt-colibri](https://github.com/b-ned/dbt-colibri) (MIT, © 2024 Canva
OpenSource) and [pbip-documenter](https://github.com/JonathanJihwanKim/pbip-documenter)
(MIT, © 2026 Jihwan Kim). Each adopted parser names its origin and its copyright
holder in a header comment.
