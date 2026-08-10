/**
 * The merge, tested directly on synthetic graphs.
 *
 * `samples/` produces zero automatic matches — its semantic model points at
 * relations no dbt model builds — so the whole of Pass 2, which is the path
 * almost every real project runs on, had no fixture coverage. Building a PBIP
 * that matches would be a large fixture change; calling buildGraph with two
 * small hand-written graphs tests the same code in a few lines and stays
 * readable when it fails.
 *
 * Run directly:  node test/merge.js
 */
const { buildGraph } = require('../src/graph-builder');

const results = [];
const check = (name, pass, detail = '') => results.push([name, pass, detail]);

const dbtNode = (name, columns) => ({
    id: `dbt:model.demo.${name}`,
    kind: 'model',
    name,
    layer: 'marts',
    origin: 'dbt',
    columns: columns.map(c => ({ name: c })),
    meta: { database: 'wh', schema: 'marts', relation: `wh.marts.${name}`, resourceType: 'model' },
    definition: {},
});

const pbiTable = (name, columns) => ({
    id: `pbi:table:${name}`,
    kind: 'pbiTable',
    name,
    layer: 'powerbi',
    origin: 'pbi',
    columns: columns.map(c => ({ name: c, hasLineage: false, relationships: [] })),
    meta: { physicalSource: { database: 'wh', schema: 'marts', table: 'fct_orders' }, columnCount: columns.length },
    definition: {},
});

/** One warehouse table feeding one model table, four columns, all matching by name. */
function fixture(mappingRows) {
    const COLUMNS = ['order_id', 'customer_id', 'amount', 'order_date'];
    const dbtGraph = { nodes: { [`dbt:model.demo.fct_orders`]: dbtNode('fct_orders', COLUMNS) }, edges: [] };
    const pbiGraph = {
        nodes: { 'pbi:table:Orders': pbiTable('Orders', COLUMNS) },
        edges: [],
        stats: { brokenRefs: [] },
    };
    const physicalIndex = COLUMNS.map(c => ({
        physicalDatabase: 'wh', physicalSchema: 'marts', physicalTable: 'fct_orders',
        physicalColumn: c, modelTable: 'Orders', modelColumn: c,
    }));
    return buildGraph({
        dbtGraph, pbiGraph,
        pbip: { physicalIndex },
        mapping: { rows: mappingRows, errors: [], warnings: [] },
        layerOrder: ['marts', 'powerbi'],
    });
}

const crossings = graph => graph.edges.filter(e => e.kind === 'dbt_to_pbi');

// ── Automatic matching, with no workbook at all ──────────────────────────────
{
    const g = fixture([]);
    check('every column matches automatically when nothing is declared',
        crossings(g).length === 4, `${crossings(g).length} links`);
}

// ── One column-level row must not switch off the other three ────────────────
{
    const g = fixture([{
        _row: 2, level: 'column',
        fromDatabase: 'wh', fromSchema: 'marts', fromTable: 'fct_orders', fromColumn: 'order_id',
        toTable: 'Orders', toColumn: 'order_id',
    }]);
    const links = crossings(g);
    const declared = links.filter(e => e.provenance === 'declared');
    check('a column-level row leaves the rest of its table auto-matched',
        links.length === 4, `${links.length} links (regression: used to be 1)`);
    check('the declared row wins on its own column',
        declared.length === 1 && declared[0].targetColumn === 'order_id',
        `${declared.length} declared`);
}

// ── A table-level row still claims the table ────────────────────────────────
{
    const g = fixture([{
        _row: 2, level: 'table',
        fromDatabase: 'wh', fromSchema: 'marts', fromTable: 'fct_orders', fromColumn: '',
        toTable: 'Orders', toColumn: '',
    }]);
    const links = crossings(g);
    check('a table-level row claims the whole table',
        links.length === 4 && links.every(e => e.provenance === 'declared'),
        `${links.filter(e => e.provenance === 'declared').length} of ${links.length} declared`);
}

// ── Two rows into one column: a fan-in, not a duplicate ─────────────────────
{
    const COLUMNS = ['order_id', 'customer_id', 'amount', 'order_date'];
    const dbtGraph = {
        nodes: {
            'dbt:model.demo.fct_orders': dbtNode('fct_orders', COLUMNS),
            'dbt:model.demo.dim_customer': dbtNode('dim_customer', ['customer_id', 'region']),
        },
        edges: [],
    };
    const pbiGraph = {
        nodes: { 'pbi:table:Orders': pbiTable('Orders', COLUMNS) },
        edges: [], stats: { brokenRefs: [] },
    };
    const row = (n, from, fromCol, toCol) => ({
        _row: n, level: 'column',
        fromDatabase: 'wh', fromSchema: 'marts', fromTable: from, fromColumn: fromCol,
        toTable: 'Orders', toColumn: toCol,
    });
    const g = buildGraph({
        dbtGraph, pbiGraph,
        pbip: { physicalIndex: [] },
        mapping: {
            rows: [row(2, 'fct_orders', 'customer_id', 'customer_id'),
                   row(3, 'dim_customer', 'customer_id', 'customer_id')],
            errors: [], warnings: [],
        },
        layerOrder: ['marts', 'powerbi'],
    });
    const into = crossings(g).filter(e => e.targetColumn === 'customer_id');
    check('two rows into one column keep both sources', into.length === 2,
        into.map(e => `${e.source.split('.').pop()}[${e.sourceColumn}]`).join(' + '));
    check('a column with two declared sources is reported',
        g.diagnostics.multiSourceColumns.length === 1,
        JSON.stringify(g.diagnostics.multiSourceColumns[0] || {}));
}

// ── Column precision must not be claimed across a hop that has no columns ────
/*
 * The failure this guards: a dbt edge sqlglot could not resolve carries the
 * whole relation, and the walk used to carry the selected column straight
 * through it and report the far end as that column's downstream. The visual
 * really is downstream — it stays in `visuals` — but it is the table's
 * downstream, not the column's, and `visualsExact` is what says so.
 */
{
    const COLUMNS = ['order_id', 'amount'];
    const dbtGraph = {
        nodes: {
            'dbt:model.demo.stg_orders': dbtNode('stg_orders', COLUMNS),
            'dbt:model.demo.fct_orders': dbtNode('fct_orders', COLUMNS),
        },
        // No sourceColumn/targetColumn: table-grade, which is what an
        // unresolved SELECT * looks like coming out of the extractor.
        edges: [{
            source: 'dbt:model.demo.stg_orders',
            target: 'dbt:model.demo.fct_orders',
            kind: 'dbt_lineage',
        }],
    };
    const pbiGraph = {
        nodes: {
            'pbi:table:Orders': pbiTable('Orders', COLUMNS),
            'pbi:visual:v1': {
                id: 'pbi:visual:v1', kind: 'visual', name: 'Card', layer: 'powerbi',
                origin: 'pbi', columns: [], meta: { page: 'Page 1', visualType: 'card' },
                definition: {},
            },
        },
        edges: [{
            source: 'pbi:table:Orders', target: 'pbi:visual:v1',
            kind: 'column_to_visual', sourceColumn: 'order_id',
        }],
        stats: { brokenRefs: [] },
    };
    const g = buildGraph({
        dbtGraph, pbiGraph,
        pbip: {
            physicalIndex: COLUMNS.map(c => ({
                physicalDatabase: 'wh', physicalSchema: 'marts', physicalTable: 'fct_orders',
                physicalColumn: c, modelTable: 'Orders', modelColumn: c,
            })),
        },
        mapping: { rows: [], errors: [], warnings: [] },
        layerOrder: ['marts', 'powerbi'],
    });

    const near = g.impact.column['dbt:model.demo.fct_orders|order_id'];
    const far = g.impact.column['dbt:model.demo.stg_orders|order_id'];
    check('a column traced over named edges only is fully exact',
        near && near.visuals.length === 1 && near.visualsExact === 1,
        JSON.stringify({ visuals: near?.visuals.length, exact: near?.visualsExact }));
    check('a column-less hop keeps the reach and drops the precision',
        far && far.visuals.length === 1 && far.visualsExact === 0,
        JSON.stringify({ visuals: far?.visuals.length, exact: far?.visualsExact }));
    check('a table trace is never marked imprecise',
        g.impact.node['dbt:model.demo.stg_orders'].visualsExact ===
        g.impact.node['dbt:model.demo.stg_orders'].visuals.length);
}

// ── What "not consumed" is allowed to mean ──────────────────────────────────
/*
 * A staging model that no Power BI table names is still consumed if a mart
 * built on it is. The check counted only the dbt nodes crossing the boundary
 * *directly*, so every ancestor of a used model was reported unused — on the
 * a large production project nearly every node, which is not a finding, it is a wall of
 * text that hides the handful that are genuinely dead.
 */
{
    const stg = dbtNode('stg_orders', ['order_id']);
    const raw = dbtNode('raw_orders', ['order_id']);
    const orphan = dbtNode('stg_abandoned', ['order_id']);
    const fct = dbtNode('fct_orders', ['order_id', 'customer_id', 'amount', 'order_date']);
    const dbtGraph = {
        nodes: { [stg.id]: stg, [raw.id]: raw, [orphan.id]: orphan, [fct.id]: fct },
        edges: [
            { source: raw.id, target: stg.id, kind: 'dbt', sourceColumn: 'order_id', targetColumn: 'order_id' },
            { source: stg.id, target: fct.id, kind: 'dbt', sourceColumn: 'order_id', targetColumn: 'order_id' },
        ],
    };
    const COLUMNS = ['order_id', 'customer_id', 'amount', 'order_date'];
    const g = buildGraph({
        dbtGraph,
        pbiGraph: {
            nodes: { 'pbi:table:Orders': pbiTable('Orders', COLUMNS) },
            edges: [], stats: { brokenRefs: [] },
        },
        pbip: {
            physicalIndex: COLUMNS.map(c => ({
                physicalDatabase: 'wh', physicalSchema: 'marts', physicalTable: 'fct_orders',
                physicalColumn: c, modelTable: 'Orders', modelColumn: c,
            })),
        },
        mapping: { rows: [], errors: [], warnings: [] },
        layerOrder: ['marts', 'powerbi'],
    });
    const unused = (g.diagnostics.dbtNodesNotUsed || []).map(n => n.name).sort();
    check('a model feeding one the report reads is not reported unused',
        !unused.includes('stg_orders') && !unused.includes('raw_orders'), unused.join(', ') || '(none)');
    check('a model that reaches nothing still is',
        unused.includes('stg_abandoned'), unused.join(', ') || '(none)');
}

let failures = 0;
for (const [name, pass, detail] of results) {
    if (!pass) failures++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
console.log(`\n${failures === 0 ? `All ${results.length} merge checks passed.` : `${failures} of ${results.length} failed.`}`);

module.exports = { failures, results };
if (require.main === module) process.exit(failures === 0 ? 0 : 1);
