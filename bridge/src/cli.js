#!/usr/bin/env node
/**
 * lineage-bridge — end-to-end column lineage from a dbt source to the Power BI
 * visual that renders it.
 *
 *   lineage-bridge graph  --manifest <f> --catalog <f> --pbip <dir> [--out graph.json]
 *
 * Reports are no longer written here: the hosted web app builds the same graph
 * in the browser and its Export button writes the self-contained HTML. What is
 * left is the graph itself, as JSON — the input to `npm run dev` and the
 * reference the browser build is checked against in test/web.js.
 */
const path = require('path');

const { build, writeGraph } = require('./build');

const ROOT = path.resolve(__dirname, '..');
const DEFAULTS = {
    colibriRepo: path.resolve(ROOT, '..', 'dbt-colibri'),
};

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { args._.push(a); continue; }
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) args[key] = true;
        else { args[key] = next; i++; }
    }
    return args;
}

const USAGE = `
lineage-bridge — dbt column lineage joined to Power BI report lineage

Commands
  graph      Write the merged graph as JSON

graph options
  --manifest <file>     dbt target/manifest.json          [required]
  --catalog  <file>     dbt target/catalog.json           [required]
  --pbip     <dir>      PBIP project root                 [required]
  --mapping  <file>     mapping workbook .xlsx or .csv    (optional)
  --out      <path>     output file  (default: graph.json)
  --layers   <list>     comma-separated layer order, e.g. base,staging,warehouse,analytics
  --colibri-repo <dir>  default: ../dbt-colibri

To read a graph rather than write one, use the app: \`npm run dev:web\`, or the
deployed site. Its Export button saves what you are looking at as one
self-contained HTML file.

The dbt manifest must contain compiled SQL: run \`dbt compile\` (or dbt run/build)
before exporting it. A parse-only manifest yields zero column lineage.
`;

function fail(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}

function requireArgs(args, keys) {
    const missing = keys.filter(k => !args[k]);
    if (missing.length) {
        console.error(`Error: missing required option(s): ${missing.map(k => `--${k}`).join(', ')}`);
        console.error(USAGE);
        process.exit(1);
    }
}

function commonOptions(args) {
    return {
        pbip: args.pbip,
        manifest: args.manifest,
        catalog: args.catalog,
        mapping: args.mapping === true ? null : args.mapping,
        colibriRepo: path.resolve(args['colibri-repo'] || DEFAULTS.colibriRepo),
        layers: typeof args.layers === 'string'
            ? args.layers.split(',').map(s => s.trim()).filter(Boolean)
            : null,
        log: m => console.log(m.startsWith(' ') ? m : `→ ${m}`),
    };
}

async function cmdGraph(args) {
    requireArgs(args, ['manifest', 'catalog', 'pbip']);
    const graph = await build(commonOptions(args));
    const out = writeGraph(graph, args.out || 'graph.json');
    report(graph);
    console.log(`\n  ${path.resolve(out)}`);
}

function report(graph) {
    const s = graph.summary;
    console.log('');
    console.log(`  ${s.crossLinks} column links (${s.linksDerived} derived, ${s.linksDeclared} declared)`);
    console.log(`  ${s.dbtNodesLinked}/${s.dbtNodes} dbt nodes reach Power BI`);
    console.log(`  ${s.modelColumnsLinked}/${s.modelColumns} model columns traced to dbt`);
    console.log(`  ${s.visualsReached}/${s.visuals} visuals downstream of dbt`);
    if (s.issues) console.log(`  ! ${s.issues} issues — see the Diagnostics tab`);
    if (!s.crossLinks) {
        console.log('  ! nothing linked. Check that the manifest has compiled SQL and that the');
        console.log('    warehouse relations match, or add rows to a mapping workbook.');
    }
}

(async () => {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0];
    try {
        if (cmd === 'graph') await cmdGraph(args);
        else { console.log(USAGE); process.exit(cmd ? 1 : 0); }
    } catch (err) {
        fail(err.message + (process.env.DEBUG ? `\n${err.stack}` : ''));
    }
})();
