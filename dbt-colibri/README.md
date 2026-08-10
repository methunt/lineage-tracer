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

That is the whole reachable import graph from `dbt_extract.py`. **The contents
of these files are unmodified upstream code** — the project deliberately does
not fork colibri's logic. Everything our side needs to change is done by
subclassing in `bridge/src/dbt_extract.py`.

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

## Updating this copy

Diff against the upstream tag, copy the files listed above, re-check that the
import graph has not grown a new module, then re-run `node scripts/pack-python.mjs`
from `bridge/` and run `npm test`.
