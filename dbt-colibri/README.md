# dbt-colibri (vendored, pruned)

**This is not the upstream package.** It is a pruned, vendored copy of
[dbt-colibri](https://github.com/b-ned/dbt-colibri) (MIT), kept in this repo so
the dbt column-lineage extraction can run without a pip install — including in
the browser, where there is no pip at all.

| | |
|---|---|
| Upstream | https://github.com/b-ned/dbt-colibri |
| Version taken | **0.3.6** (per upstream `pyproject.toml`, retained below) |
| Licence | MIT — see `LICENSE`, which is unmodified and must stay that way |
| How it is used | source directory on `sys.path`; **never pip-installed, never built** |

## How it is consumed

Two callers, both pointing at `src/`:

- **CLI** — `bridge/src/build.js` spawns `bridge/src/dbt_extract.py` with
  `--colibri-src <this dir>/src`; that script does `sys.path.insert(0, colibri_src)`
  and imports `dbt_colibri.lineage_extractor.extractor`.
- **Browser** — `bridge/scripts/pack-python.mjs` walks every `.py` under `src/`
  into `bridge/ui/public/py/python-sources.json`, which
  `bridge/ui/src/web/dbt-worker.js` writes into Pyodide's in-memory filesystem
  and imports the same way.

`sqlglot` is the only real third-party dependency; in the browser it is loaded
as a wheel alongside the packed sources.

## What is actually here

```
src/dbt_colibri/
  lineage_extractor/__init__.py
  lineage_extractor/extractor.py     # DbtColumnLineageExtractor — the entry point
  lineage_extractor/lineage.py       # sqlglot lineage walk
  utils/__init__.py
  utils/json_utils.py
  utils/log.py
  utils/parsing_utils.py
```

That is the whole reachable import graph from `dbt_extract.py`. **Most of
these files are unmodified upstream code** — the project's default is to
change behavior by subclassing in `bridge/src/dbt_extract.py` rather than
forking colibri's logic. `extractor.py` and `lineage.py` are the exception:
see "Local patches" below for the handful of places that diverge from
upstream, and why subclassing wasn't enough for them.

## What was removed from upstream, and why

Whole files only — nothing was pruned *inside* a retained module.

| Removed | Why |
|---|---|
| `utils/version_check.py` | Made an outbound HTTP request to PyPI to check for a newer release, and cached the result in a file under the user's home directory. Nothing in this repo imported it. The app's promise is that nothing leaves your browser, so shipping a module whose job is to phone home is wrong even while unreachable. |
| CLI package (`dbt_colibri/cli/`) | Upstream's `colibri` console script. We drive the extractor as a library; this was also the only consumer of the `click` dependency. |
| Report/dashboard generator and its HTML assets | Upstream shapes output for its own renderer. `bridge/src/dbt_extract.py` replaces it and shapes output for ours. |
| Upstream tests, CI config, docs, README | Not part of the runtime import graph; every byte here is shipped to the browser. |

`pyproject.toml` was trimmed to match (no `click`, no console script, no
build/test/publish config) and kept only as a provenance record — see the
comment at the top of that file. It is not used to build or install anything.

## Local patches

Unlike the rest of this copy, `extractor.py` and `lineage.py` carry fixes made
directly against upstream's logic rather than through the `dbt_extract.py`
subclass. Each is a case where the extractor's own resolution logic — not just
how our side calls it — was silently dropping or breaking lineage:

- **A model missing from `catalog.json`** (a stale or partial catalog, or a
  materialization the adapter doesn't always produce a catalog entry for)
  used to make the extractor drop that model's lineage entirely. Its columns
  are now derived from its compiled SQL instead, the same way the extractor
  already handled ephemeral models — which never appear in `catalog.json` by
  definition and already needed this.
- **A T-SQL/Synapse `OPENROWSET(...)` read of an external file** isn't valid
  grammar in sqlglot's `tsql` dialect and raised a parse error that took down
  lineage for the *entire* model containing it, not just that one reference.
  The call (and its optional `WITH (...)` column-schema clause) is now stubbed
  to a placeholder identifier before parsing.
- **One unresolvable branch of a large `UNION ALL`** (e.g. a `SELECT *` whose
  source table can't be resolved) crashed lineage resolution for every column
  of the whole model, including its resolvable sibling branches, because the
  branches ended up with inconsistent column counts. An unresolvable branch is
  now skipped instead of crashing.
- **A parent referenced as a two-part `schema.table`** (no database prefix)
  could fail to resolve even when the schema held only one unambiguous
  database for that pair, because sqlglot's qualifier fills in the schema but
  not the catalog. A schema.table-only lookup now covers this case, but only
  when it is unambiguous — an identical schema.table pair in two different
  databases is left unresolved rather than guessed.

Diffing against upstream will show these as real deviations. That's expected
— re-check they're still present (and still needed) rather than reverting
them wholesale.

## Updating this copy

Diff against the upstream tag, copy the files listed above, then reapply the
local patches described above (they will not survive a plain file copy),
re-check that the import graph has not grown a new module, then re-run
`node scripts/pack-python.mjs` from `bridge/` and run `npm test`.
