#!/usr/bin/env node
/**
 * End-to-end check: build a graph from samples/, export it into the viewer
 * template, then assert both the data and the rendered DOM. Catches the failure
 * modes that are invisible from the data alone — an export that produces a file
 * happily and renders a blank page.
 *
 *   npm test
 */
const fs = require('fs');
const path = require('path');
const { build, toReportData } = require('../src/build');
const { renderCheck } = require('./smoke');

const ROOT = path.resolve(__dirname, '..');
const SAMPLES = path.resolve(ROOT, '..', 'samples');
const OUT = path.join(ROOT, '.work', 'test-report.html');
// The artifact the app's Export button fetches, built by `npm run build:viewer`.
const VIEWER = path.join(ROOT, 'ui', 'dist', 'index.html');

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
    if (!pass) failures++;
}

(async () => {
    if (!fs.existsSync(VIEWER)) {
        console.error(`Viewer template missing. Run:  npm run build:viewer`);
        process.exit(1);
    }

    // Parsing first: if the M navigation resolves to the wrong relation, every
    // check below is asserting on a graph built from the wrong joins.
    console.log('— parsing —');
    const parsing = require('./parsing');
    failures += parsing.failures;

    // The merge, on synthetic graphs: samples/ produces no automatic matches at
    // all, so Pass 2 has no coverage from the end-to-end build below.
    // The export's escaping, on a graph built to break out of a script element.
    // Ahead of the render below, which uses the same injector on real data.
    console.log('\n— export —');
    failures += await require('./export').run();

    console.log('\n— merge —');
    const merge = require('./merge');
    failures += merge.failures;

    // Graph translation, on synthetic payloads: neither samples/ nor the
    // a real production project can be relied on to contain two visuals sharing a name
    // on one page, which is the identity mistake this catches.
    console.log('\n— pbi graph —');
    failures += require('./pbi-graph').failures;

    // Renames, on a synthetic payload: the cases that matter are a field
    // renamed two different ways and the several near-misses that must *not*
    // read as renames, and no real project can be relied on to hold all of
    // them at once.
    console.log('\n— renames —');
    failures += require('./renames').failures;

    // Field parameters, on synthetic models: the cases that decide whether a
    // measure reached only through a parameter is seen at all are the near
    // misses — a target named without quotes, a marker with no rows behind it,
    // rows with no marker — and no one project holds them all.
    console.log('\n— field parameters —');
    failures += require('./field-parameters').failures;

    // The folder tree, on a synthetic project: samples/ is flat and the
    // real projects nest several folders deep, so neither exercises collapsing a
    // single-child chain or a folder holding both files and subfolders.
    console.log('\n— folder tree —');
    failures += await require('./tree').run();

    console.log('\nBuilding from samples/…\n');
    const graph = await build({
        pbip: SAMPLES,
        manifest: path.join(SAMPLES, 'dbt-sqlserver', 'manifest.json'),
        catalog: path.join(SAMPLES, 'dbt-sqlserver', 'catalog.json'),
        mapping: path.join(SAMPLES, 'mapping-example.csv'),
        colibriRepo: path.resolve(ROOT, '..', 'dbt-colibri'),
        layers: ['staging', 'marts'],
        log: () => {},
    });

    const s = graph.summary;
    const kinds = {};
    for (const n of Object.values(graph.nodes)) kinds[n.kind] = (kinds[n.kind] || 0) + 1;

    console.log('— data —');
    check('dbt column lineage resolved', graph.edges.some(e => e.matchLevel === 'dbt'),
        `${graph.edges.filter(e => e.matchLevel === 'dbt').length} dbt edges`);
    check('cross-boundary links found', s.crossLinks === 4, `${s.crossLinks} links`);
    check('links are declared (from mapping)', s.linksDeclared === 4 && s.linksDerived === 0);
    check('all five node kinds present',
        ['source', 'model', 'pbiTable', 'measure', 'visual'].every(k => kinds[k] > 0), JSON.stringify(kinds));
    check('layers ordered sources-first, powerbi-last',
        graph.layers[0] === 'sources' && graph.layers[graph.layers.length - 1] === 'powerbi',
        graph.layers.join(' → '));
    check('a dbt source reaches a Power BI visual',
        Object.entries(graph.impact.column).some(([k, v]) => k.startsWith('dbt:source.') && v.visuals.length > 0));
    check('impact bands assigned',
        Object.values(graph.impact.node).every(i => ['high', 'medium', 'low', 'none'].includes(i.band)));
    check('breakage never inferred',
        (graph.diagnostics.brokenRefs || []).every(r => r.reason), 'brokenRefs all carry a reason');

    // An edge to a node that does not exist is invisible on the canvas and
    // silently wrong everywhere else. Calculated columns used to mint them:
    // their references_column edges were read as if they came from measures.
    const ids = new Set(Object.keys(graph.nodes));
    const dangling = graph.edges.filter(e => !ids.has(e.source) || !ids.has(e.target));
    check('every edge lands on a node that exists', dangling.length === 0,
        dangling[0] ? `${dangling[0].kind}: ${dangling[0].source} -> ${dangling[0].target}` : '');
    check('no node points at itself',
        graph.edges.every(e => e.source !== e.target));

    // A key column is load-bearing without appearing in any visual, so nothing
    // else in the graph records that it matters.
    const keyed = Object.values(graph.nodes)
        .filter(n => n.kind === 'pbiTable')
        .flatMap(n => (n.columns || []).filter(c => c.relationships?.length));
    check('relationship keys are recorded on their columns', keyed.length > 0,
        `${keyed.length} key columns`);
    check('each relationship names its other side and its state',
        keyed.every(c => c.relationships.every(r =>
            r.otherTable && r.otherColumn && typeof r.active === 'boolean')));

    // An inactive relationship is reachable only through USERELATIONSHIP, which
    // makes it the easiest dependency to miss and no less real. The sample
    // carries one on Sales[ShipDate], the classic role-playing date.
    const inactive = keyed.filter(c => c.relationships.some(r => !r.active));
    check('inactive relationships are kept, not filtered out', inactive.length > 0,
        inactive.map(c => c.name).join(', ') || 'none found');

    /*
     * The whole chain, on the sample's Sales[ProductKey]: a key built in Power
     * Query from two other columns. Each link is a separate thing that can
     * break, so each is checked separately.
     */
    const sales = graph.nodes['pbi:table:Sales'];
    const productKey = sales?.columns.find(c => c.name === 'ProductKey');
    check('a key computed in M records what it reads',
        (productKey?.dependsOn || []).map(d => d.column).sort().join(',') === 'OrderID,ProductID',
        JSON.stringify(productKey?.dependsOn || []));
    check('the columns behind a computed key are marked as feeding it',
        ['OrderID', 'ProductID'].every(n =>
            sales.columns.find(c => c.name === n)?.keysFed?.some(k => k.column === 'ProductKey')));

    // And one system earlier: the dbt column that becomes one of those inputs.
    const feeders = Object.values(graph.nodes)
        .filter(n => n.origin !== 'pbi')
        .flatMap(n => (n.columns || []).filter(c => c.keysFed?.length).map(c => `${n.name}[${c.name}]`));
    check('dbt columns feeding a key are marked across the boundary',
        feeders.length > 0, feeders.join(', '));

    // One derivation hop, never further: marking every ancestor would mark
    // almost everything, which is the failure this rule exists to avoid.
    const marked = new Set(feeders);
    check('the mark does not walk up dbt lineage',
        !marked.has('stg_orders[order_id]'), [...marked].join(', '));

    // Impact must not travel through a join: a star schema would make almost
    // every column high-impact, and a blast radius of "everything" says nothing.
    const relTables = new Set(keyed.map(c => c.name));
    check('relationships do not become lineage edges',
        !graph.edges.some(e => e.kind === 'relationship'), `${relTables.size} keyed names`);

    /*
     * A join is the dependency that breaks silently, so the impact sentence
     * counts it. Both directions of one relationship name the same join, and
     * counting a node's whole downstream would report the entire model.
     */
    const salesImpact = graph.impact.node['pbi:table:Sales'];
    check('a table holding keys counts the relationships it holds up',
        salesImpact.relationships > 0, `${salesImpact.relationships} relationships`);
    // Every relationship is recorded on both of its columns, so a naive tally
    // reports each join twice. Counting the distinct endpoint pairs by hand
    // here gives the figure the roll-up must not exceed.
    const sides = Object.values(graph.nodes)
        .filter(n => n.kind === 'pbiTable')
        .flatMap(n => (n.columns || []).flatMap(c => (c.relationships || []).map(r =>
            [`${n.name}[${c.name}]`.toLowerCase(),
                `${r.otherTable}[${r.otherColumn}]`.toLowerCase()].sort().join('~'))));
    const distinct = new Set(sides);
    check('a relationship is counted once, not once per side',
        distinct.size < sides.length && salesImpact.relationships <= distinct.size,
        `${salesImpact.relationships} on Sales; ${sides.length} sides collapse to ${distinct.size} joins`);
    check('inactive relationships are counted and named',
        salesImpact.relationshipsInactive > 0,
        `${salesImpact.relationshipsInactive} inactive`);

    // One derivation hop: a dbt column feeding a key reports that key's joins.
    const fed = Object.values(graph.nodes)
        .filter(n => n.origin !== 'pbi')
        .flatMap(n => (n.columns || [])
            .filter(c => c.keysFed?.length)
            .map(c => graph.impact.column[`${n.id}|${c.name}`]))
        .filter(Boolean);
    check('a dbt column feeding a key reports that key\'s relationships',
        fed.length > 0 && fed.every(i => i.relationships > 0),
        `${fed.length} feeder columns, ${fed.map(i => i.relationships).join('/')}`);

    // The star-schema trap: reaching a table must not inherit its joins.
    const noKeys = Object.values(graph.nodes)
        .filter(n => n.kind === 'model')
        .filter(n => !(n.columns || []).some(c => c.keysFed?.length || c.relationships?.length));
    check('reaching a keyed table does not inherit its relationships',
        noKeys.every(n => (graph.impact.node[n.id].relationships || 0) === 0),
        `${noKeys.length} models hold no key`);

    /*
     * The deep reach: a column several hops upstream of a key. Carried on
     * column identity so it cannot smear across a table, reported at column
     * scope only, and counted by relationship because that is what breaks.
     */
    const deep = Object.entries(graph.impact.column)
        .filter(([, i]) => i.relationshipsDownstream > 0);
    check('a column upstream of a key reports the joins it reaches',
        deep.length > 0, `${deep.length} columns, e.g. ${deep[0]?.[0]}`);
    check('the two counts are never both shown',
        deep.every(([, i]) => !i.relationships),
        'a column holding a key must not also report reaching one');
    // A table summarises its columns, counted by relationship: two columns
    // reaching the same join are one, not two.
    for (const [key, ci] of deep) {
        const nodeId = key.slice(0, key.lastIndexOf('|'));
        const ni = graph.impact.node[nodeId];
        if (!ni?.relationshipsDownstream) continue;
        check(`table scope covers its columns (${graph.nodes[nodeId]?.name})`,
            ni.relationshipsDownstream >= ci.relationshipsDownstream,
            `table ${ni.relationshipsDownstream} ≥ column ${ci.relationshipsDownstream}`);
        break;
    }
    const unioned = Object.entries(graph.impact.node)
        .filter(([, i]) => i.relationshipsDownstream > 0);
    check('the table roll-up counts joins, not columns',
        unioned.every(([id, i]) => i.relationshipsDownstream <= distinct.size),
        `${unioned.length} tables, max ${Math.max(0, ...unioned.map(([, i]) => i.relationshipsDownstream))} of ${distinct.size} joins`);
    // Only column-named edges are followed, so a column can never reach more
    // joins than the model contains.
    check('the deep count cannot exceed the model',
        deep.every(([, i]) => i.relationshipsDownstream <= distinct.size),
        `max ${Math.max(...deep.map(([, i]) => i.relationshipsDownstream))} of ${distinct.size}`);

    /*
     * The band floor. A join key appears in no visual, so the visual count puts
     * it in `none` — which reads as safe to drop, for the one dependency that
     * breaks without breaking anything.
     */
    const RANK = { none: 0, low: 1, medium: 2, high: 3 };
    const allImpacts = [...Object.values(graph.impact.node), ...Object.values(graph.impact.column)];
    check('holding a join keeps something out of the "none" band',
        allImpacts.every(i => !(i.relationships > 0) || RANK[i.band] >= RANK.medium),
        `${allImpacts.filter(i => i.relationships > 0).length} hold a join`);
    check('reaching a join keeps something out of the "none" band',
        allImpacts.every(i => !(i.relationshipsDownstream > 0) || RANK[i.band] >= RANK.low));
    // A floor, not a promotion: it may never lower what the visuals earned.
    check('the floor never lowers a band',
        allImpacts.every(i => !i.bandRaisedFrom || RANK[i.band] > RANK[i.bandRaisedFrom]));
    check('a raised band says why', allImpacts.every(i => !i.bandRaisedFrom || i.bandReason));
    // High is earned on visuals alone, so it stays scarce enough to mean something.
    check('the floor never mints a high band',
        allImpacts.every(i => !i.bandRaisedFrom || i.band !== 'high'));

    check('untested findings are scoped to the high band',
        (graph.diagnostics.untestedHighImpact || []).every(r =>
            graph.impact.node[r.id]?.band === 'high' &&
            (graph.nodes[r.id]?.meta?.testCount || 0) === 0),
        `${(graph.diagnostics.untestedHighImpact || []).length} rows`);

    /*
     * The render, on exactly what the Export button produces.
     *
     * `injectGraph` is the browser's own function, imported here rather than
     * reimplemented: an export that is assembled one way in the app and another
     * way in the test proves nothing about the file a user actually receives.
     */
    console.log('\n— render —');
    const { injectGraph } = await import('../ui/src/web/export-viewer.js');
    const reportData = toReportData(graph);
    const html = injectGraph(fs.readFileSync(VIEWER, 'utf8'), reportData);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, html, 'utf8');

    /*
     * The viewer template must arrive with no graph of its own — a stale one
     * baked in would render, and hide an injection that never happened.
     *
     * Asked of the parsed document rather than of the text: the inlined bundle
     * contains the injector's own source, so the string `<script
     * id="lineage-data"` appears in the file whether or not an element by that
     * id exists. Scripts are not run — this is a parse, not a render.
     */
    const { JSDOM } = require('jsdom');
    const bare = new JSDOM(fs.readFileSync(VIEWER, 'utf8'));
    check('the template ships empty', !bare.window.document.getElementById('lineage-data'));
    bare.window.close();
    const block = /<script id="lineage-data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    check('the export carries the graph as inert JSON', !!block);
    check('and it parses back to the graph that went in',
        !!block && JSON.stringify(JSON.parse(block[1])) === JSON.stringify(reportData),
        block ? `${(block[1].length / 1024).toFixed(0)} KB payload` : '');
    check('the bundle is a classic script, runnable from file://',
        !/<script[^>]*type="module"/.test(html));

    const result = await renderCheck(OUT);
    for (const [name, pass, detail] of result.checks) check(name, pass, detail);
    if (result.errors.length) {
        check('no runtime errors', false, result.errors[0].slice(0, 200));
    } else {
        check('no runtime errors', true);
    }

    console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
    console.error('Test run failed:', err.message);
    process.exit(1);
});
