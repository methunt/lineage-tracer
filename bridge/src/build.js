/**
 * Orchestrates one build: dbt + Power BI + mapping -> one merged graph.
 *
 * Node is the entrypoint; Python appears exactly once, as a subprocess that turns
 * two dbt JSON artifacts into a column-lineage graph. Its stderr is passed
 * through verbatim so a Python failure reads as a Python failure.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { extractPbip } = require('./pbip-extract');
const { buildPbiGraph } = require('./pbi-graph');
const { buildGraph } = require('./graph-builder');
const { readMapping } = require('./mapping');
const { toReportData } = require('./report-data');

const PYTHONS = [process.env.LINEAGE_BRIDGE_PYTHON, 'python', 'python3'].filter(Boolean);

/**
 * An input path as it goes into the graph's metadata: relative to the working
 * directory, or the bare filename when the file sits outside it (a different
 * drive, or above the cwd) and a relative path would only be an absolute one
 * wearing dots. Never the author's full path — see the `inputs` block below.
 */
function relativeInput(p) {
    if (!p) return p;
    const rel = path.relative(process.cwd(), path.resolve(p));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return path.basename(p);
    return rel.split(path.sep).join('/');
}

/** Run the dbt extractor, returning our dbt-side graph. */
function extractDbt({ manifest, catalog, colibriSrc, quiet }) {
    const script = path.join(__dirname, 'dbt_extract.py');
    const args = ['--manifest', manifest, '--catalog', catalog, '--colibri-src', colibriSrc];

    let lastError = null;
    for (const python of PYTHONS) {
        const run = spawnSync(python, [script, ...args], {
            encoding: 'utf8',
            maxBuffer: 512 * 1024 * 1024,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });

        if (run.error) { lastError = run.error; continue; }
        if (run.stderr && !quiet) process.stderr.write(indent(run.stderr));
        if (run.status !== 0) {
            throw new Error(
                `dbt extraction failed (${python} exited ${run.status}).\n` +
                (run.stderr || '(no stderr)')
            );
        }
        try {
            return JSON.parse(run.stdout);
        } catch (err) {
            throw new Error(`dbt extraction returned unparseable JSON: ${err.message}`);
        }
    }
    throw new Error(
        `could not run Python (tried: ${PYTHONS.join(', ')}). ` +
        `Set LINEAGE_BRIDGE_PYTHON to your interpreter. Underlying error: ${lastError?.message}`
    );
}

const indent = text => text.split(/\r?\n/).filter(Boolean).map(l => `    ${l}`).join('\n') + '\n';

async function build(options) {
    const {
        pbip, manifest, catalog, mapping: mappingPath,
        colibriRepo, layers, log = () => {},
    } = options;

    log('Parsing PBIP project…');
    const parsed = extractPbip(path.resolve(pbip));
    log(`  ${parsed.payload.parsedModel.tables.length} tables, ` +
        `${parsed.payload.visualData.visuals.length} visuals, ` +
        `${parsed.physicalIndex.length} physical column mappings` +
        (parsed.inlining.inlined
            ? ` (expanded ${parsed.inlining.inlined} via ${parsed.inlining.functions.join(', ')})`
            : ''));

    log('Extracting dbt column lineage…');
    const dbtGraph = extractDbt({
        manifest: path.resolve(manifest),
        catalog: path.resolve(catalog),
        colibriSrc: path.join(colibriRepo, 'src'),
    });
    log(`  ${Object.keys(dbtGraph.nodes).length} dbt nodes, ${dbtGraph.edges.length} column edges` +
        (dbtGraph.errors?.length ? `, ${dbtGraph.errors.length} parse errors` : ''));

    log('Reading mapping…');
    const mapping = await readMapping(mappingPath ? path.resolve(mappingPath) : null);
    log(mapping.path
        ? `  ${mapping.rows.length} valid rows, ${mapping.errors.length} invalid`
        : '  none — automatic matching only');

    log('Merging…');
    const pbiGraph = buildPbiGraph(parsed);
    const graph = buildGraph({
        dbtGraph, pbiGraph, pbip: parsed, mapping,
        layerOrder: layers,
    });

    return {
        ...graph,
        pbip: parsed,
        metadata: {
            generatedAt: new Date().toISOString(),
            dbt: dbtGraph.metadata,
            model: parsed.payload._meta?.modelName || null,
            report: path.basename(path.resolve(pbip)),
            // Relative to the working directory, for the same reason the
            // browser build records names only (`build-browser.js`): the
            // metadata travels inside every exported report, and an absolute
            // path would carry the author's filesystem along with it. Relative
            // is enough to say which inputs were merged.
            inputs: {
                manifest: relativeInput(manifest),
                catalog: relativeInput(catalog),
                pbip: relativeInput(pbip),
                mapping: relativeInput(mapping.path),
            },
            inlining: parsed.inlining,
        },
    };
}

function writeGraph(graph, outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(toReportData(graph)), 'utf8');
    return outPath;
}

module.exports = { build, toReportData, writeGraph, extractDbt };
