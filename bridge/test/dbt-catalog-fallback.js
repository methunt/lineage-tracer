/**
 * Runs the Python regression tests for dbt-colibri's extractor under
 * test/python/ (catalog-gap fallback, T-SQL/Synapse OPENROWSET handling,
 * union-branch resolution, schema.table-without-catalog resolution).
 *
 * Node is not the runtime under test here — Python is, same as the real
 * dbt-extraction path in src/build.js — so this shells out rather than
 * reimplementing the checks in JS.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PYTHONS = [process.env.LINEAGE_BRIDGE_PYTHON, 'python', 'python3'].filter(Boolean);
const PYTHON_TEST_DIR = path.join(__dirname, 'python');
const SCRIPTS = fs.readdirSync(PYTHON_TEST_DIR)
    .filter(f => f.startsWith('test_') && f.endsWith('.py'))
    .map(f => path.join(PYTHON_TEST_DIR, f));

let failures = 0;

for (const script of SCRIPTS) {
    const label = path.basename(script);
    let ran = false;
    for (const python of PYTHONS) {
        const run = spawnSync(python, [script, '-v'], { encoding: 'utf8' });
        if (run.error) continue;
        ran = true;
        process.stdout.write(run.stderr || '');
        if (run.status !== 0) {
            console.log(`FAIL  ${label} (python: ${python} exited ${run.status})`);
            failures += 1;
        } else {
            console.log(`PASS  ${label}`);
        }
        break;
    }
    if (!ran) {
        console.log(`FAIL  ${label}  — no Python interpreter found (tried: ${PYTHONS.join(', ')})`);
        failures += 1;
    }
}

module.exports = { failures };
