/**
 * One build, in the browser. The counterpart of build.js.
 *
 * Same three inputs merged the same way and in the same order — the difference
 * is only where the bytes come from. The dbt side arrives already extracted,
 * because that half runs in a Pyodide worker (see ui/src/web/dbt-worker.js) and
 * this module has to stay free of anything that cannot cross a postMessage.
 *
 * Nothing here touches `fs`, `path` or `child_process`; the parsers it calls
 * never did.
 */
const { extractPbipFromFiles } = require('./pbip-extract');
const { buildPbiGraph } = require('./pbi-graph');
const { buildGraph } = require('./graph-builder');
const { readMappingFromBuffer } = require('./mapping');
const { toReportData } = require('./report-data');

/**
 * @param {object}   options
 * @param {object}   options.files        PBIP project as path -> text
 * @param {string}   options.rootName     the project folder's own name
 * @param {object}   options.dbtGraph     what dbt_extract.py returned
 * @param {ArrayBuffer|string} options.mappingData  the mapping file's bytes
 * @param {string}   options.mappingName  its filename, for error messages
 * @param {string[]} [options.layers]     explicit layer order
 * @param {function} [options.log]
 */
async function buildInBrowser({
    files, rootName, dbtGraph, mappingData, mappingName, layers, log = () => {},
}) {
    log('Parsing PBIP project…');
    const parsed = extractPbipFromFiles(files, { rootName, warn: m => log(`  ! ${m}`) });
    log(`  ${parsed.payload.parsedModel.tables.length} tables, ` +
        `${parsed.payload.visualData.visuals.length} visuals, ` +
        `${parsed.physicalIndex.length} physical column mappings` +
        (parsed.inlining.inlined
            ? ` (expanded ${parsed.inlining.inlined} via ${parsed.inlining.functions.join(', ')})`
            : ''));

    log(`  ${Object.keys(dbtGraph.nodes).length} dbt nodes, ${dbtGraph.edges.length} column edges` +
        (dbtGraph.errors?.length ? `, ${dbtGraph.errors.length} parse errors` : ''));

    log('Reading mapping…');
    const mapping = await readMappingFromBuffer(mappingData, mappingName);
    log(`  ${mapping.rows.length} valid rows, ${mapping.errors.length} invalid`);

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
            report: rootName,
            // Names only: the browser has no paths to report, and inventing
            // ones would put a filesystem that does not exist in the metadata.
            inputs: {
                manifest: 'manifest.json',
                catalog: 'catalog.json',
                pbip: rootName,
                mapping: mapping.path,
            },
            inlining: parsed.inlining,
        },
    };
}

module.exports = { buildInBrowser, toReportData };
