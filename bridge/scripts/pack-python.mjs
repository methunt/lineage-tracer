/**
 * Pack the Python the browser needs into one JSON asset.
 *
 * Two things go in: dbt-colibri's package source, and our own dbt_extract.py.
 * Neither is pip-installed in the browser — colibri is used exactly as the CLI
 * uses it, as a directory on sys.path (see build.js), which means we never need
 * its `click` dependency and never need a wheel build. sqlglot is the only
 * genuine third-party package, and it ships as a wheel alongside this.
 *
 * A JSON map rather than a zip so the build stays dependency-free: the worker
 * writes each entry into Pyodide's filesystem. It is ~60 KB of text, which the
 * server gzips to a fraction of the sqlglot wheel sitting next to it.
 *
 *   node scripts/pack-python.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, '..');
const COLIBRI = path.resolve(BRIDGE, '..', 'dbt-colibri', 'src');
const OUT = path.join(BRIDGE, 'ui', 'public', 'py', 'python-sources.json');

/** Every .py under `root`, keyed by its path relative to `root` (POSIX). */
function collect(root, into, prefix = '') {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        // __pycache__ is machine-specific and would double the payload.
        if (entry.name === '__pycache__') continue;
        const full = path.join(root, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) collect(full, into, rel);
        else if (entry.name.endsWith('.py')) into[rel] = fs.readFileSync(full, 'utf8');
    }
    return into;
}

if (!fs.existsSync(COLIBRI)) {
    console.error(`pack-python: no dbt-colibri source at ${COLIBRI}`);
    process.exit(1);
}

const files = collect(COLIBRI, {});
files['dbt_extract.py'] = fs.readFileSync(path.join(BRIDGE, 'src', 'dbt_extract.py'), 'utf8');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(files), 'utf8');

const bytes = fs.statSync(OUT).size;
console.log(`pack-python: ${Object.keys(files).length} files → ${OUT} (${Math.round(bytes / 1024)} KB)`);
