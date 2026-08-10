#!/usr/bin/env node
/**
 * Graph translation, on synthetic payloads.
 *
 * Separate from parsing.js because nothing here parses anything: it checks the
 * step that turns a parsed PBIP into our node and edge vocabulary, which is
 * where identity mistakes hide. A visual's *name* is not its identity — Power
 * BI lets two charts on one page share a title — and a graph keyed by name
 * silently gives one of them every edge and the other none.
 */
const { buildPbiGraph } = require('../src/pbi-graph');

let failures = 0;
const check = (name, pass, detail) => {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
    if (!pass) failures++;
};

/** Two visuals, one page, same display name, different fields. */
function twinsPayload() {
    const page = { pageId: 'p1', pageName: 'Sales', displayName: 'Sales', visuals: [] };
    const mk = (visualId, fields) => ({
        pageId: 'p1',
        pageName: 'Sales',
        visualId,
        visualName: 'Media Cost by Month',      // the collision
        visualType: 'lineChart',
        name: visualId,
        position: { x: 0, y: 0, z: 0, width: 100, height: 100 },
        fields,
    });
    const visuals = [
        mk('v_left', [{ type: 'measure', table: 'Metrics', name: 'Media Cost', role: 'Y' }]),
        mk('v_right', [{ type: 'column', table: 'Calendar', name: 'Month', role: 'Category' }]),
    ];
    page.visuals = visuals;
    const payload = {
        parsedModel: { model: { name: 'm' }, tables: [
            { name: 'Metrics', columns: [], measures: [{ name: 'Media Cost', expression: '1' }] },
            { name: 'Calendar', columns: [{ name: 'Month', dataType: 'string' }], measures: [] },
        ], relationships: [] },
        visualData: { pages: [page], visuals },
    };
    return {
        payload,
        // The lineage engine keys visuals `pageName|visualName`, which is what
        // this fixture exists to break; an empty engine proves the graph does
        // not depend on it for field edges.
        engine: { nodes: new Map(), edges: [] },
        physicalIndex: [],
        mComputed: new Map(),
    };
}

const graph = buildPbiGraph(twinsPayload());
const idOf = suffix => Object.keys(graph.nodes).find(id => id.endsWith(suffix));
const left = idOf('/v_left');
const right = idOf('/v_right');
const feeding = id => graph.edges
    .filter(e => e.target === id && e.kind !== 'page_to_visual')
    .map(e => e.source);

check('both twins are on the graph', Boolean(left && right), `${left} | ${right}`);
check('each twin is fed by its own field, not by the other\'s',
    feeding(left).join() === 'pbi:measure:Metrics[Media Cost]' &&
    feeding(right).join() === 'pbi:table:Calendar',
    `left ← ${feeding(left).join() || '(nothing)'} · right ← ${feeding(right).join() || '(nothing)'}`);
check('neither twin is left with no lineage at all',
    feeding(left).length > 0 && feeding(right).length > 0,
    `${feeding(left).length} and ${feeding(right).length}`);

/*
 * Power BI is case-insensitive about object names, and report authors are
 * inconsistent about them: a textbox referring to Metrics[Reporting Last Full
 * Month] means the measure declared as `Reporting last full month`. Reported
 * as broken, it sends someone looking for a bug that is not there — and every
 * false row makes the real ones easier to dismiss.
 */
{
    const p = twinsPayload();
    p.engine.nodes = new Map([['measure:Metrics.Media Cost', { type: 'measure' }]]);
    p.engine.brokenRefs = [
        { visual: 'v1', target: 'measure:Metrics.MEDIA COST', type: 'missing_node' },
        { visual: 'v1', target: 'measure:Metrics.Gone', type: 'missing_node' },
        { visual: 'v1', target: 'column:Calendar.MONTH', type: 'missing_node' },
        { visual: 'v1', target: 'column:Calendar.Nope', type: 'missing_node' },
    ];
    const g = buildPbiGraph(p);
    const left = (g.stats.brokenRefs || []).map(r => r.target).sort();
    check('a reference that differs only in case is not called broken',
        !left.includes('measure:Metrics.MEDIA COST') && !left.includes('column:Calendar.MONTH'),
        left.join(', ') || '(none)');
    check('a reference that really is missing survives',
        left.includes('measure:Metrics.Gone') && left.includes('column:Calendar.Nope'),
        left.join(', ') || '(none)');
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll pbi-graph checks passed.');
// run.js sums `failures` off each suite it requires; without this the total
// went NaN and the run reported "NaN check(s) failed".
module.exports = { failures };

// Only when run on its own: unguarded, requiring this from run.js ended the
// whole suite here, silently and with status 0 — the folder-tree, build and
// DOM checks after it never ran.
if (require.main === module) process.exit(failures ? 1 : 0);
