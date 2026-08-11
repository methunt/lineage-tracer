#!/usr/bin/env node
/**
 * Field renames applied inside a visual, from the projection to the graph.
 *
 * A reader can rename a field in one visual's field well; the semantic model
 * keeps the original, so the label on the chart may be a name the model has
 * never heard of. That label is the only name most readers can quote back, and
 * the tool is unusable to them if it cannot be searched.
 *
 * The two failure modes worth a test are both silent. A missed rename makes the
 * feature quietly absent — indistinguishable from a report with no renames. An
 * *invented* rename is worse: Power BI writes `displayName` even when it repeats
 * the field name, and it writes `nativeQueryRef` for reasons no author typed, so
 * a parser that trusts either reports names nobody chose.
 */
const VisualParser = require('../src/pbip/visual-parser');
const { buildPbiGraph } = require('../src/pbi-graph');

let failures = 0;
const check = (name, pass, detail) => {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
    if (!pass) failures++;
};

const projection = (field, extra = {}) => ({ field, ...extra });
const measure = (table, name) => ({ Measure: { Expression: { SourceRef: { Entity: table } }, Property: name } });
const column = (table, name) => ({ Column: { Expression: { SourceRef: { Entity: table } }, Property: name } });

/*
 * One page, two visuals, and every case in one payload:
 *   - a measure renamed, and renamed *differently* in the second visual
 *   - the same measure in a sort definition, where no rename is written
 *   - a `displayName` that merely repeats the field name
 *   - a `nativeQueryRef` that differs with no `displayName` beside it
 *   - a group container, whose `displayName` is its own caption
 */
const pagesData = () => [{
    pageId: 'p1',
    pageName: 'Overview',
    displayName: 'Overview',
    visuals: [
        {
            visualId: 'v1',
            visualData: {
                name: 'v1',
                visual: {
                    visualType: 'table',
                    query: {
                        queryState: {
                            Values: {
                                projections: [
                                    projection(measure('Sales', 'Total Revenue'), {
                                        displayName: 'Revenue', nativeQueryRef: 'Revenue',
                                    }),
                                    // Repeats the field name: not a rename.
                                    projection(column('Product', 'Category'), { displayName: 'Category' }),
                                    // A suffix Power BI added, with nothing an author typed.
                                    projection(column('Date', 'Year'), { nativeQueryRef: 'Year1' }),
                                ],
                            },
                        },
                        // Names the renamed measure again, carrying no rename.
                        sortDefinition: { sort: [{ field: measure('Sales', 'Total Revenue'), direction: 'Descending' }] },
                    },
                },
            },
        },
        {
            visualId: 'v2',
            visualData: {
                name: 'v2',
                visual: {
                    visualType: 'card',
                    query: {
                        queryState: {
                            Data: {
                                projections: [
                                    projection(measure('Sales', 'Total Revenue'), { displayName: 'Grand Total' }),
                                ],
                            },
                        },
                    },
                },
            },
        },
        {
            visualId: 'g1',
            visualData: { name: 'g1', visualGroup: { displayName: 'Headline figures' } },
        },
    ],
}];

const parsed = new VisualParser().parseReport(pagesData());
const fieldsOf = id => parsed.visuals.find(v => v.visualId === id).fields;
const find = (id, table, name) => fieldsOf(id).find(f => f.table === table && f.name === name);

check('a renamed measure carries the visual\'s label',
    find('v1', 'Sales', 'Total Revenue')?.displayName === 'Revenue');

check('the same measure carries a different label in another visual',
    find('v2', 'Sales', 'Total Revenue')?.displayName === 'Grand Total');

// The sort names the measure a second time and carries no rename. Whichever
// extractor writes the entry first, the rename has to survive the other.
check('a rename survives the same field being projected again without one',
    (find('v1', 'Sales', 'Total Revenue')?.displayNames || []).join() === 'Revenue');

check('a displayName repeating the field name is not a rename',
    find('v1', 'Product', 'Category')?.displayName == null);

check('a nativeQueryRef alone is not a rename',
    find('v1', 'Date', 'Year')?.displayName == null);

// A group's displayName is the caption on the container the author drew, and a
// group holds no fields at all. Reading it as one would invent a rename on
// whatever field happened to be nearby.
const group = parsed.visuals.find(v => v.visualId === 'g1');
check('a visual group\'s own caption is not read as a field rename',
    group.isGroup && group.fields.length === 0 && group.groupName === 'Headline figures');

/* ── Through to the graph ─────────────────────────────────────────────────── */

const pbipPayload = {
    parsedModel: {
        model: { name: 'm' },
        tables: [
            {
                name: 'Sales',
                columns: [{ name: 'UnitPrice', dataType: 'decimal' }],
                measures: [{ name: 'Total Revenue', expression: '1' }],
                partitions: [],
            },
            {
                name: 'Product',
                columns: [{ name: 'Category', dataType: 'string' }],
                measures: [], partitions: [],
            },
        ],
        relationships: [],
    },
    visualData: {
        pages: [{ id: 'p1', name: 'Overview', displayName: 'Overview', visuals: [] }],
        visuals: parsed.visuals.map(v => ({ ...v, pageName: 'Overview', pageId: 'p1' })),
    },
};

const graph = buildPbiGraph({
    payload: pbipPayload,
    engine: { nodes: new Map(), edges: [], brokenRefs: [] },
    physicalIndex: [],
    mComputed: new Map(),
});

const measureNode = Object.values(graph.nodes)
    .find(n => n.kind === 'measure' && n.name === 'Total Revenue');
const aliases = measureNode?.meta?.aliases || [];

check('the measure knows every label it is read under',
    aliases.map(a => a.name).sort().join(', ') === 'Grand Total, Revenue',
    aliases.map(a => `${a.name}×${a.visuals.length}`).join(' '));

check('each label knows which visuals use it',
    aliases.every(a => a.visuals.length === 1 && a.visuals[0].page === 'Overview'));

check('a field nobody renamed carries no aliases',
    Object.values(graph.nodes)
        .filter(n => n.kind === 'pbiTable')
        .flatMap(n => n.columns)
        .every(c => c.aliases === undefined));

const renamedFieldEntries = Object.values(graph.nodes)
    .filter(n => n.kind === 'visual')
    .flatMap(n => n.definition.fields || [])
    .filter(f => f.displayName);
check('every rename reaches the visual\'s own field list',
    renamedFieldEntries.length === 2,
    renamedFieldEntries.map(f => `${f.name}→${f.displayName}`).join(' '));

// Reported, not merely used: zero rows is how an author learns the extraction
// broke rather than that their report has no renames.
check('renames are reported for Diagnostics',
    (graph.stats.fieldRenames || []).length === 2
    && graph.stats.fieldRenames.every(r => r.page === 'Overview' && r.field && r.shownAs && r.role));

/*
 * A graph built before renames existed has none of these keys. Every reader is
 * written to treat absent as "no renames", so an already-exported viewer keeps
 * working — this asserts the producer side of that: nothing is emitted at all
 * when nothing was renamed, rather than empty arrays everywhere.
 */
const plainVisuals = JSON.parse(JSON.stringify(parsed.visuals)).map(v => ({
    ...v,
    pageName: 'Overview',
    pageId: 'p1',
    fields: (v.fields || []).map(({ displayName, displayNames, ...rest }) => rest),
}));
const plain = buildPbiGraph({
    payload: { ...pbipPayload, visualData: { ...pbipPayload.visualData, visuals: plainVisuals } },
    engine: { nodes: new Map(), edges: [], brokenRefs: [] },
    physicalIndex: [],
    mComputed: new Map(),
});
check('a report with no renames gains no rename keys',
    Object.values(plain.nodes).every(n => n.meta?.aliases === undefined)
    && plain.stats.fieldRenames.length === 0
    && Object.values(plain.nodes).filter(n => n.kind === 'visual')
        .flatMap(n => n.definition.fields || []).every(f => !('displayName' in f)));

module.exports = { failures };

if (require.main === module) process.exit(failures ? 1 : 0);
