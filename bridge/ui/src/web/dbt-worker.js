/**
 * The dbt side of the bridge, in the browser.
 *
 * sqlglot resolves column lineage across a dozen SQL dialects and there is no
 * JavaScript equivalent worth trusting, so the browser runs the same Python the
 * CLI runs — CPython compiled to WebAssembly, via Pyodide. `dbt_extract.py` is
 * byte-identical to the file the CLI executes; only the way it is called
 * differs.
 *
 * This lives in a worker because extraction on a real project is seconds of
 * solid CPU, and on the main thread that is a frozen tab with a spinner that
 * cannot spin.
 *
 * What gets downloaded, and nothing else:
 *   - Pyodide's wasm runtime and the Python stdlib      (~7 MB over the wire)
 *   - the sqlglot wheel, vendored under public/py/      (~0.7 MB)
 *   - colibri + dbt_extract.py as plain source          (~0.1 MB)
 *
 * No `packages:` list, so no numpy and no default package set. No micropip
 * either: sqlglot is pure Python with no runtime dependencies, so unpacking the
 * wheel onto sys.path does everything an installer would have, without pulling
 * an installer and its own dependencies down first.
 */

// Pinned rather than floating: the runtime is the one thing here we cannot test
// on every visitor's machine, and a silent major-version bump would surface as
// a parse failure in someone's lineage.
const PYODIDE_VERSION = '314.0.3';
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

const SQLGLOT_WHEEL = 'py/sqlglot-30.4.3-py3-none-any.whl';
const PYTHON_SOURCES = 'py/python-sources.json';

// Everything we mount lives under here: the unpacked wheel, colibri's package
// tree, dbt_extract.py, and the two dbt artifacts while they are being read.
const ROOT = '/lineage';
const SITE = `${ROOT}/site`;
const SRC = `${ROOT}/src`;

const log = message => postMessage({ type: 'log', message });

/*
 * Where our own assets live, as told to us by the page.
 *
 * Not derived from `self.location`: a bundled worker is served from the hashed
 * assets directory, so resolving `py/…` against itself looks for the wheel one
 * level too deep and finds a 404 body, which then fails as "not a zip file" —
 * a fetch problem wearing an archive problem's clothes. The page knows its own
 * base and a subpath deploy changes it, so the page is what gets asked.
 */
let baseUrl = self.location.href;
const asset = name => new URL(name, baseUrl).href;

let pyodidePromise = null;

/**
 * Load the runtime once and reuse it.
 *
 * Kicked off the moment the landing page mounts, so the ~7 MB overlaps with the
 * user choosing their files instead of following it.
 */
function bootPyodide() {
    if (pyodidePromise) return pyodidePromise;
    pyodidePromise = (async () => {
        log('Downloading Python runtime…');
        // Dynamic, and hidden from Vite, because the runtime is fetched from
        // the CDN at run time rather than bundled — it must stay an external
        // URL through the build.
        const { loadPyodide } = await import(/* @vite-ignore */ `${PYODIDE_URL}pyodide.mjs`);

        const pyodide = await loadPyodide({
            indexURL: PYODIDE_URL,
            // No package set at all. Anything Python needs, we mount ourselves.
            packages: [],
            stdout: line => log(line),
            // colibri's warnings are the useful kind ("not in catalog, maybe
            // it's not materialized"), so they are surfaced, not swallowed.
            stderr: line => log(line),
        });

        log('Loading sqlglot…');
        const wheel = await (await fetch(asset(SQLGLOT_WHEEL))).arrayBuffer();
        pyodide.FS.mkdirTree(SITE);
        // A wheel is a zip, and sqlglot is pure Python with no dependencies, so
        // unpacking it onto sys.path is the whole of "installing" it.
        await pyodide.unpackArchive(wheel, 'zip', { extractDir: SITE });

        log('Loading lineage extractor…');
        const sources = await (await fetch(asset(PYTHON_SOURCES))).json();
        for (const [rel, text] of Object.entries(sources)) {
            const full = `${SRC}/${rel}`;
            pyodide.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
            pyodide.FS.writeFile(full, text, { encoding: 'utf8' });
        }

        pyodide.runPython(`
import sys
for p in (${JSON.stringify(SITE)}, ${JSON.stringify(SRC)}):
    if p not in sys.path:
        sys.path.insert(0, p)
`);
        log('Runtime ready.');
        return pyodide;
    })();
    return pyodidePromise;
}

/**
 * Run one extraction.
 *
 * The two artifacts are written into Pyodide's in-memory filesystem rather than
 * passed as parsed objects: colibri's extractor opens them itself, and
 * reshaping its constructor would mean forking a dependency this project
 * deliberately uses unmodified. They are deleted the moment it has read them,
 * because a catalog can be hundreds of megabytes and holding the text and the
 * parsed dict at once for any longer than necessary is how a tab dies.
 */
async function extract({ manifestText, catalogText }) {
    const pyodide = await bootPyodide();

    const manifestPath = `${ROOT}/manifest.json`;
    const catalogPath = `${ROOT}/catalog.json`;
    pyodide.FS.writeFile(manifestPath, manifestText, { encoding: 'utf8' });
    pyodide.FS.writeFile(catalogPath, catalogText, { encoding: 'utf8' });

    log('Resolving column lineage…');
    try {
        const json = pyodide.runPython(`
import json, os
import dbt_extract

try:
    _result = dbt_extract.run(
        ${JSON.stringify(manifestPath)},
        ${JSON.stringify(catalogPath)},
        ${JSON.stringify(SRC)},
    )
finally:
    for _p in (${JSON.stringify(manifestPath)}, ${JSON.stringify(catalogPath)}):
        if os.path.exists(_p):
            os.remove(_p)

json.dumps(_result, default=str)
`);
        // Handed across as text and parsed here: converting a dict of this size
        // with .toJs() walks every node twice and proxies each one.
        return JSON.parse(json);
    } finally {
        // Whatever happened, do not leave a second copy of the artifacts in the
        // virtual filesystem for the next run to sit alongside.
        for (const p of [manifestPath, catalogPath]) {
            try { pyodide.FS.unlink(p); } catch { /* already gone */ }
        }
    }
}

/*
 * Every reply carries the id of the request that caused it.
 *
 * Requests overlap in the one case that matters: the warm-up is still fetching
 * 7 MB when the user finishes picking files and presses Build. Without an id,
 * the reply to the warm-up is indistinguishable from the reply to the build,
 * and the build resolves on it — arriving at the merge with no dbt graph at
 * all, several steps away from anything that looks like the cause.
 */
onmessage = async ({ data }) => {
    const { id } = data;
    try {
        if (data.baseUrl) baseUrl = data.baseUrl;
        if (data.type === 'warm') {
            await bootPyodide();
            postMessage({ id, type: 'warm' });
            return;
        }
        if (data.type === 'extract') {
            const graph = await extract(data);
            postMessage({ id, type: 'result', graph });
        }
    } catch (error) {
        postMessage({ id, type: 'error', message: error?.message || String(error) });
    }
};
