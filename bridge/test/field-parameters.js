#!/usr/bin/env node
/**
 * Field parameters, from the model file to a structured list of what they swap.
 *
 * A field parameter is a calculated table whose rows are references to other
 * fields: the reader picks one in a slicer and every visual bound to the
 * parameter re-reads a different measure or column. Two facts about it are
 * invisible in the file and load-bearing in the tool.
 *
 * The first is that the reference is a reference. `NAMEOF('t'[c])` names a
 * field without reading it, so a measure used *only* through a parameter has no
 * ordinary dependency anywhere — and a tool that misses it reports the measure
 * as unused, which is a confident wrong answer to the only question that
 * matters before a change.
 *
 * The second is the caption. Each row carries its own label, authored in the
 * model, and it is what the reader sees in the slicer and on the chart. It is
 * frequently nothing like the name of the field behind it, and it is the only
 * name most readers can quote back.
 *
 * The near-misses matter as much as the hits. A table using `SWITCH` is not a
 * parameter; a parameter may name its target with or without quotes; and the
 * marker Power BI writes can be present on a table whose rows reference
 * nothing at all.
 */
const { TMDLParser } = require('../src/pbip/tmdl-parser');

let failures = 0;
const check = (name, pass, detail) => {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
    if (!pass) failures++;
};
const T = '\t';

const parse = files => new TMDLParser().parseAll(files);
const tableNamed = (model, name) => (model.tables || []).find(t => t.name === name);

/*
 * The shape Power BI Desktop writes: a display column, a hidden column carrying
 * the marker, a hidden column for the sort order, and a calculated partition
 * whose body is a list of tuples.
 *
 * Both tuple widths appear here. The three-element form is caption, reference
 * and order; the four-element form adds a group caption, and a parser that
 * expects one width silently drops the other.
 */
const PARAMETER = `table 'Chooser'

${T}column 'Chooser'
${T}${T}summarizeBy: none
${T}${T}sourceColumn: [Value1]
${T}${T}sortByColumn: 'Chooser Order'

${T}${T}relatedColumnDetails
${T}${T}${T}groupByColumn: 'Chooser Fields'

${T}column 'Chooser Fields'
${T}${T}isHidden
${T}${T}summarizeBy: none
${T}${T}sourceColumn: [Value2]

${T}${T}extendedProperty ParameterMetadata =
${T}${T}${T}${T}{
${T}${T}${T}${T}  "version": 3,
${T}${T}${T}${T}  "kind": 2
${T}${T}${T}${T}}

${T}column 'Chooser Order'
${T}${T}isHidden
${T}${T}sourceColumn: [Value3]

${T}partition 'Chooser' = calculated
${T}${T}mode: import
${T}${T}source =
${T}${T}${T}${T}{
${T}${T}${T}${T}    ("Alpha", NAMEOF('t_dim'[colA]), 0, "Group One"),
${T}${T}${T}${T}    ("Beta", NAMEOF(t_dim[colB]), 1),
${T}${T}${T}${T}    ("Gamma", NAMEOF('t_metrics'[mTotal]), 2, "Group Two"),
${T}${T}${T}${T}    ("Delta ""quoted""", NAMEOF([mBare]), 3)
${T}${T}${T}${T}}
`;

const model = parse({ 'tables/Chooser.tmdl': PARAMETER });
const chooser = tableNamed(model, 'Chooser');

check('the table parses', !!chooser, chooser ? '' : 'not found');
check('it is recognised as a field parameter', !!chooser?.fieldParameter);

const items = chooser?.fieldParameter?.items || [];
check('every row is found, whatever its width', items.length === 4,
    `${items.length} items: ${items.map(i => i.caption).join(', ')}`);

check('the caption is kept as the reader sees it',
    items.map(i => i.caption).join('|') === 'Alpha|Beta|Gamma|Delta "quoted"',
    items.map(i => i.caption).join('|'));
/*
 * A measure is normally referenced with no table at all, and this is the form a
 * parameter over measures is written in. Requiring a table name made every one
 * of them invisible — the case where a missed dependency does the most harm,
 * since a measure has no other reason to look used.
 */
check('a target named with no table at all resolves',
    items[3]?.targetTable === null && items[3]?.targetName === 'mBare',
    `${items[3]?.targetTable}[${items[3]?.targetName}]`);
check('a target named with quotes resolves',
    items[0]?.targetTable === 't_dim' && items[0]?.targetName === 'colA',
    `${items[0]?.targetTable}[${items[0]?.targetName}]`);
/*
 * The unquoted form is legal DAX and the old extractor required the quotes, so
 * a parameter written this way was invisible — no items, no warning.
 */
check('a target named without quotes resolves too',
    items[1]?.targetTable === 't_dim' && items[1]?.targetName === 'colB',
    `${items[1]?.targetTable}[${items[1]?.targetName}]`);
check('the order is kept, as a number',
    items.map(i => i.order).join(',') === '0,1,2,3', items.map(i => i.order).join(','));
check('a group caption is kept when present and absent when not',
    items[0]?.group === 'Group One' && items[1]?.group === null,
    `${items[0]?.group} / ${items[1]?.group}`);

// The marker Power BI writes, read as the marker rather than inferred from DAX.
check('the marker column is identified',
    chooser?.fieldParameter?.markerColumn === 'Chooser Fields',
    String(chooser?.fieldParameter?.markerColumn));

/*
 * The marker's own body is JSON, and its lines look like properties. Left
 * unconsumed they were written onto the column as keys nobody declared, where
 * a name collision would quietly overwrite a real property.
 */
const fieldsCol = (chooser?.columns || []).find(c => c.name === 'Chooser Fields');
check('the column carrying the marker says so',
    fieldsCol?.hasParameterMetadata === true, String(fieldsCol?.hasParameterMetadata));
check('the marker body does not derail the column it sits on',
    fieldsCol?.isHidden === true && fieldsCol?.sourceColumn === '[Value2]',
    `hidden ${fieldsCol?.isHidden}, source ${fieldsCol?.sourceColumn}`);
check('and the column declared after it is still read',
    (chooser?.columns || []).find(c => c.name === 'Chooser Order')?.isHidden === true);
check('a column without the marker does not claim it',
    (chooser?.columns || []).find(c => c.name === 'Chooser')?.hasParameterMetadata === false);

/*
 * A table doing something else with a one-word DAX function is not a parameter.
 * The engine used to test for `SWITCH` as well as `NAMEOF`, which made every
 * table holding a branching calculated column a candidate.
 */
const SWITCHED = `table 'Banded'

${T}column 'Band' = SWITCH ( TRUE (), 'Facts'[Amount] > 100, "High", "Low" )
${T}${T}dataType: string

${T}partition 'Banded' = calculated
${T}${T}mode: import
${T}${T}source =
${T}${T}${T}${T}SUMMARIZE ( 'Facts', 'Facts'[Label] )
`;
const banded = tableNamed(parse({ 'tables/Banded.tmdl': SWITCHED }), 'Banded');
check('a branching calculated column is not a field parameter',
    !!banded && !banded.fieldParameter, JSON.stringify(banded?.fieldParameter));

/*
 * The marker with nothing behind it. This is a real state — an author can empty
 * the row list — and it must read as a parameter with no items rather than as
 * an ordinary table, because the two need different things said about them.
 */
const EMPTY = `table 'Empty Chooser'

${T}column 'Empty Chooser Fields'
${T}${T}isHidden

${T}${T}extendedProperty ParameterMetadata =
${T}${T}${T}${T}{
${T}${T}${T}${T}  "version": 3,
${T}${T}${T}${T}  "kind": 2
${T}${T}${T}${T}}

${T}partition 'Empty Chooser' = calculated
${T}${T}mode: import
${T}${T}source =
${T}${T}${T}${T}{
${T}${T}${T}${T}}
`;
const empty = tableNamed(parse({ 'tables/Empty.tmdl': EMPTY }), 'Empty Chooser');
check('the marker alone makes it a parameter, with no rows',
    !!empty?.fieldParameter && empty.fieldParameter.items.length === 0,
    JSON.stringify(empty?.fieldParameter?.items));

/*
 * And the reverse: rows referencing fields, with no marker written. Older files
 * and hand-edited ones look like this, so detection cannot rest on the marker
 * alone either.
 */
const UNMARKED = `table 'Plain Chooser'

${T}column 'Plain Chooser'
${T}${T}sourceColumn: [Value1]

${T}partition 'Plain Chooser' = calculated
${T}${T}mode: import
${T}${T}source =
${T}${T}${T}${T}{
${T}${T}${T}${T}    ("Delta", NAMEOF('t_dim'[colD]), 0)
${T}${T}${T}${T}}
`;
const plain = tableNamed(parse({ 'tables/Plain.tmdl': UNMARKED }), 'Plain Chooser');
check('rows without the marker are still a parameter',
    (plain?.fieldParameter?.items || []).length === 1,
    JSON.stringify(plain?.fieldParameter?.items));
check('and it reports having no marker',
    plain?.fieldParameter?.markerColumn === null, String(plain?.fieldParameter?.markerColumn));

// An ordinary table must gain nothing at all, so nothing downstream has to ask.
const ORDINARY = `table 'Facts'

${T}column Amount
${T}${T}dataType: double

${T}partition 'Facts' = m
${T}${T}mode: import
${T}${T}source =
${T}${T}${T}${T}let
${T}${T}${T}${T}    Source = Sql.Database("host.example.net", "db")
${T}${T}${T}${T}in
${T}${T}${T}${T}    Source
`;
const facts = tableNamed(parse({ 'tables/Facts.tmdl': ORDINARY }), 'Facts');
check('an ordinary table is left exactly as it was',
    !!facts && facts.fieldParameter === null && facts._isFieldParameter !== true);

/* ── Into the graph ───────────────────────────────────────────────────────────
 *
 * Reading the rows is half of it. The rows have to become edges, because every
 * question a reader asks — is this measure used, what breaks if I change it,
 * which visuals read it — is answered by walking edges. A parameter whose rows
 * stay in the model object is a parameter the impact walk cannot see.
 *
 * The visual is the trap. Power BI writes the item that happened to be selected
 * when the report was saved as an ordinary field reference, so the tool already
 * shows one edge and looks correct. The other rows are the ones nobody can see,
 * and a reader switching the slicer reads them.
 */
const { buildPbiGraph } = require('../src/pbi-graph');

const parameterTable = {
    name: 'Chooser',
    columns: [
        { name: 'Chooser', dataType: 'string' },
        { name: 'Chooser Fields', isHidden: true, hasParameterMetadata: true },
    ],
    measures: [],
    partitions: [{ name: 'Chooser', mode: 'import', sourceType: 'calculated', source: '{}' }],
    fieldParameter: {
        markerColumn: 'Chooser Fields',
        items: [
            { caption: 'Alpha', targetTable: 't_dim', targetName: 'colA', order: 0, group: null },
            // Unqualified, the form a measure is written in.
            { caption: 'Gamma', targetTable: null, targetName: 'mTotal', order: 1, group: null },
            // Named, and nothing in the model answers to it.
            { caption: 'Ghost', targetTable: 't_dim', targetName: 'colGone', order: 2, group: null },
            /*
             * Spelled in a case the model does not use. Power BI does not care
             * and authors are inconsistent, so this must resolve — and resolve to
             * the *declared* spelling, or the id names a node that does not
             * exist and the row links to nothing at all.
             */
            { caption: 'Cased', targetTable: 'T_DIM', targetName: 'COLB', order: 3, group: null },
        ],
    },
};

const graphPayload = () => {
    const visual = {
        pageId: 'p1', pageName: 'Overview', visualId: 'v1',
        visualName: 'By Chosen Field', visualType: 'barChart', name: 'v1',
        position: { x: 0, y: 0, z: 0, width: 100, height: 100 },
        // What Power BI writes: the parameter's own column, as an ordinary field.
        fields: [{ type: 'column', table: 'Chooser', name: 'Chooser', role: 'Category' }],
        fpSelections: { Chooser: { selectedIndex: 0, length: 1 } },
    };
    return {
        payload: {
            parsedModel: {
                model: { name: 'm' },
                tables: [
                    parameterTable,
                    {
                        name: 't_dim', measures: [], partitions: [],
                        columns: [{ name: 'colA', dataType: 'string' }, { name: 'colB' }],
                        fieldParameter: null,
                    },
                    {
                        name: 't_metrics', columns: [], partitions: [],
                        measures: [{ name: 'mTotal', expression: '1' }],
                        fieldParameter: null,
                    },
                ],
                relationships: [],
            },
            visualData: {
                pages: [{ pageId: 'p1', pageName: 'Overview', displayName: 'Overview', visuals: [visual] }],
                visuals: [visual],
            },
        },
        engine: { nodes: new Map(), edges: [] },
        physicalIndex: [],
        mComputed: new Map(),
    };
};

const g = buildPbiGraph(graphPayload());
const V = 'pbi:visual:p1/v1';
const P = 'pbi:page:p1';
const into = (target, kind) => g.edges.filter(e => e.target === target && (!kind || e.kind === kind));
const edgeFrom = (source, column, target) => g.edges
    .find(e => e.source === source && e.target === target && (column == null || e.sourceColumn === column));

const fpNode = g.nodes['pbi:table:Chooser'];
check('the parameter table says it is one', !!fpNode?.meta?.fieldParameter);
check('and carries its rows for the panel to show',
    (fpNode?.meta?.fieldParameter?.items || []).length === 4,
    JSON.stringify((fpNode?.meta?.fieldParameter?.items || []).map(i => i.caption)));

/*
 * A row resolves to a node or it does not, and which it is has to be recorded
 * rather than inferred from an edge's absence — a broken row and a row nobody
 * uses look identical from the edge list.
 */
const byCaption = c => (fpNode?.meta?.fieldParameter?.items || []).find(i => i.caption === c);
check('a row pointing at a column resolves to that column',
    byCaption('Alpha')?.targetId === 'pbi:table:t_dim' &&
    byCaption('Alpha')?.targetKind === 'column',
    `${byCaption('Alpha')?.targetId} (${byCaption('Alpha')?.targetKind})`);
check('a row with no table resolves to the measure that answers to the name',
    byCaption('Gamma')?.targetId === 'pbi:measure:t_metrics[mTotal]' &&
    byCaption('Gamma')?.targetKind === 'measure',
    `${byCaption('Gamma')?.targetId} (${byCaption('Gamma')?.targetKind})`);
check('a row spelled in another case still resolves',
    byCaption('Cased')?.targetId === 'pbi:table:t_dim',
    String(byCaption('Cased')?.targetId));
check('and is reported under the name the model declares',
    byCaption('Cased')?.targetTable === 't_dim' && byCaption('Cased')?.targetName === 'colB',
    `${byCaption('Cased')?.targetTable}[${byCaption('Cased')?.targetName}]`);
check('a row pointing at nothing says so, rather than going quiet',
    byCaption('Ghost')?.targetId === null && byCaption('Ghost')?.targetKind === null,
    JSON.stringify(byCaption('Ghost')));

/*
 * The point of the whole exercise. Neither of these edges exists in the file:
 * the visual names the parameter's column and nothing else, so without them a
 * measure a reader reaches through the slicer is reported as used by no visual.
 */
const viaColumn = edgeFrom('pbi:table:t_dim', 'colA', V);
const viaMeasure = edgeFrom('pbi:measure:t_metrics[mTotal]', null, V);
check('a column the parameter can swap in reaches the visual', !!viaColumn,
    into(V).map(e => `${e.source}[${e.sourceColumn}]`).join(' · '));
check('a measure the parameter can swap in reaches the visual', !!viaMeasure);
check('and both say they arrived through the parameter',
    viaColumn?.viaParameter === 'Chooser' && viaMeasure?.viaParameter === 'Chooser',
    `${viaColumn?.viaParameter} / ${viaMeasure?.viaParameter}`);
// The page carries what its visuals carry, or a parameter is invisible at the
// zoom level most readers work at.
check('the page inherits them, like any other field',
    !!edgeFrom('pbi:table:t_dim', 'colA', P) && !!edgeFrom('pbi:measure:t_metrics[mTotal]', null, P));
check('a row that resolves to nothing mints no edge',
    !g.edges.some(e => e.sourceColumn === 'colGone'));

/*
 * The parameter is also a thing in its own right — a reader looks for it by
 * name and asks where it is used. Passing its edges through to the real fields
 * must not cost it its own.
 */
check('the parameter keeps its own edge to the visual',
    !!edgeFrom('pbi:table:Chooser', 'Chooser', V));

/*
 * Which row is showing. Recorded by the report, thrown away until now, and the
 * only honest way to distinguish what the visual reads today from what it can
 * be made to read.
 */
const shown = g.nodes[V]?.meta?.fieldParameters || [];
check('the visual records that a parameter drives it',
    shown.length === 1 && shown[0].table === 'Chooser', JSON.stringify(shown));
check('and which row was showing when the report was saved',
    shown[0]?.selected === 'Alpha', String(shown[0]?.selected));

/*
 * Where a parameter comes from.
 *
 * A parameter looked like a table with no upstream at all, which reads as "this
 * came from nowhere" — and it is the opposite of true: every row names a field
 * in another table, and renaming or dropping that field breaks the row. The
 * parameter is downstream of everything it offers.
 *
 * The edge lands on the parameter's own display column, so a walk that arrives
 * at a field carries on through the parameter to the visuals reading it, instead
 * of stopping at the table.
 */
const upstream = edgeFrom('pbi:table:t_dim', 'colA', 'pbi:table:Chooser');
check('a parameter is downstream of the column it offers', !!upstream,
    into('pbi:table:Chooser').map(e => `${e.source}[${e.sourceColumn}]`).join(' · '));
check('and of the measure it offers',
    !!edgeFrom('pbi:measure:t_metrics[mTotal]', null, 'pbi:table:Chooser'));
check('the link lands on the column the parameter exposes',
    upstream?.targetColumn === 'Chooser', String(upstream?.targetColumn));
check('a row pointing at nothing has nothing to come from',
    into('pbi:table:Chooser').every(e => e.sourceColumn !== 'colGone'));

/*
 * The caption, as a name the field is read under.
 *
 * A row's caption is authored in the model and shown in the slicer, so it is
 * frequently the only name a reader can quote back — and it is nothing like the
 * name of the field behind it. It belongs in the same index as a rename made
 * inside a visual, because a reader searching a label does not know, and should
 * not have to know, which of the two they are looking at.
 *
 * What they do need is to be told apart once found: a caption is authored once
 * and inherited by every visual on the parameter, a rename is authored per
 * visual, and the two are fixed in different places.
 */
const dimCol = (g.nodes['pbi:table:t_dim']?.columns || []).find(c => c.name === 'colA');
check('a caption is recorded on the column it names',
    (dimCol?.aliases || []).some(a => a.name === 'Alpha'),
    JSON.stringify(dimCol?.aliases || []));
check('and on the measure, when the row names a measure',
    (g.nodes['pbi:measure:t_metrics[mTotal]']?.meta?.aliases || []).some(a => a.name === 'Gamma'),
    JSON.stringify(g.nodes['pbi:measure:t_metrics[mTotal]']?.meta?.aliases || []));
check('a caption says where it comes from',
    (dimCol?.aliases || []).find(a => a.name === 'Alpha')?.origin === 'parameter' &&
    (dimCol?.aliases || []).find(a => a.name === 'Alpha')?.parameter === 'Chooser',
    JSON.stringify((dimCol?.aliases || []).find(a => a.name === 'Alpha')));
check('and it names the visuals that read the field under it',
    ((dimCol?.aliases || []).find(a => a.name === 'Alpha')?.visuals || []).length === 1);

/*
 * One label, both origins. An author who captions a parameter row "Alpha" and
 * also renames the same column to "Alpha" in a visual's field well has done
 * something entirely ordinary twice — and indexed by label alone the two merged
 * into one row that credited the parameter with the rename, sending the reader
 * to the wrong place to change it.
 */
{
    const p = graphPayload();
    p.payload.visualData.visuals[0].fields.push({
        type: 'column', table: 't_dim', name: 'colA', role: 'Y', displayNames: ['Alpha'],
    });
    const g2 = buildPbiGraph(p);
    const both = (g2.nodes['pbi:table:t_dim']?.columns || [])
        .find(c => c.name === 'colA')?.aliases || [];
    check('the same label from both origins stays two rows', both.length === 2,
        JSON.stringify(both.map(a => `${a.name}/${a.origin}`)));
    check('and each keeps its own origin',
        both.some(a => a.origin === 'parameter' && a.parameter === 'Chooser') &&
        both.some(a => a.origin === 'visual' && !a.parameter),
        JSON.stringify(both.map(a => `${a.origin}:${a.parameter}`)));
}

// A visual with no parameter must gain nothing, so no caller has to ask.
check('an ordinary visual is left alone',
    g.nodes[V] && !('fieldParameters' in (g.nodes['pbi:page:p1']?.meta || {})));

console.log(`\n${failures === 0
    ? `All ${'field parameter'} checks passed.`
    : `${failures} field parameter check(s) failed.`}`);

module.exports = { failures };
if (require.main === module) process.exit(failures === 0 ? 0 : 1);
