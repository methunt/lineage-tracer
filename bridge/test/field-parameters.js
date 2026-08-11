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

console.log(`\n${failures === 0
    ? `All ${'field parameter'} checks passed.`
    : `${failures} field parameter check(s) failed.`}`);

module.exports = { failures };
if (require.main === module) process.exit(failures === 0 ? 0 : 1);
