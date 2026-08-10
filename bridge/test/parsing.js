/**
 * Parsing guard: the warehouse relation resolved from an M expression must not
 * move.
 *
 * Everything downstream — the dbt/Power BI column links, the impact numbers, the
 * whole report — hangs off `physicalSchema` / `physicalTable` / the navigation
 * path. Nothing pinned them before, so a parser change could have rewritten
 * every relation in a project while the canvas tests carried on passing: they
 * assert that nodes render, not that they are the right nodes.
 *
 * Run directly:  node test/parsing.js
 */
const path = require('path');
const MExpressionParser = require(path.join(__dirname, '..', 'src', 'pbip', 'm-parser.js'));
const { inlineCustomSources } = require('../src/m-inline');

const { TMDLParser } = require(path.join(__dirname, '..', 'src', 'pbip', 'tmdl-parser.js'));

const EXPRESSIONS = require('./fixtures/m-expressions');
const WRAPPERS = require('./fixtures/m-wrappers');
const TABLES = require('./fixtures/tmdl-tables');

const results = [];
const check = (name, pass, detail = '') => results.push([name, pass, detail]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── TMDL objects ─────────────────────────────────────────────────────────────
// A dropped measure is invisible: the table still parses and the report still
// builds, it simply has fewer objects than the file declares.
for (const fixture of TABLES) {
    const parser = new TMDLParser();
    const model = parser.parseAll({ [fixture.file]: fixture.tmdl });
    const table = (model.tables || []).find(t => t.name === fixture.expect.table);

    check(`${fixture.name}: table parsed`, !!table, table ? '' : 'not found');
    if (!table) continue;

    const got = (table.measures || []).map(m => m.name);
    check(`${fixture.name}: every measure survives`, same(got, fixture.expect.measures),
        `${JSON.stringify(got)} (want ${JSON.stringify(fixture.expect.measures)})`);
    check(`${fixture.name}: columns survive`,
        same((table.columns || []).map(c => c.name), fixture.expect.columns),
        JSON.stringify((table.columns || []).map(c => c.name)));

    if (fixture.expect.physicalTable) {
        const source = (table.partitions || [])[0]?.source || '';
        const lineage = MExpressionParser.extractTableLineage(source) || {};
        check(`${fixture.name}: partition still resolves`,
            lineage.physicalTable === fixture.expect.physicalTable &&
            lineage.physicalSchema === fixture.expect.physicalSchema,
            `${lineage.physicalSchema}.${lineage.physicalTable}`);
    }
}

// ── Dynamic text ─────────────────────────────────────────────────────────────
/*
 * A textbox whose sentence ends in a measure — "Data available through
 * <Reporting last full month>" — is a real dependency, and it is written in a
 * shape the field walker did not recognise: the SourceRef names an *alias*
 * (`Source: "m"`) and the entity behind it is declared in the enclosing
 * subquery's From list. Unresolved, the reference was skipped and the textbox
 * reported reading nothing. On a large production report, a whole class of
 * textboxes is this.
 */
{
    const VisualParser = require(path.join(__dirname, '..', 'src', 'pbip', 'visual-parser.js'));
    const parser = new VisualParser();
    // Verbatim shape from a real textbox: the measure sits under a subquery,
    // and its SourceRef points at the alias `m` declared in that From list.
    const SELECT = {
        Measure: {
            Expression: { SourceRef: { Source: 'm' } },
            Property: 'Reporting last full month',
        },
        Name: 'Measure.Reporting last full month',
    };
    const QUERY = { Version: 2, From: [{ Name: 'm', Entity: 'Metrics', Type: 0 }], Select: [SELECT] };
    const DYNAMIC_TEXT_EXPR = {
        expr: { Min: { Expression: { Column: { Expression: { Subquery: { Query: QUERY } } } } } },
    };
    const textbox = {
        name: 'tb1',
        position: { x: 0, y: 0, z: 0, width: 360, height: 113 },
        visual: {
            visualType: 'textbox',
            objects: {
                general: [{ properties: { paragraphs: [{ textRuns: [{ value: 'Data available through ' }] }] } }],
                values: [{ properties: { expr: DYNAMIC_TEXT_EXPR } }],
            },
        },
    };
    const parsed = parser.parseVisual(textbox, 'Overview');
    const fields = (parsed?.fields || []).map(f => `${f.type}:${f.table}[${f.name}]`);
    check('a measure behind a subquery alias is found',
        fields.includes('measure:Metrics[Reporting last full month]'),
        fields.join(', ') || '(no fields)');
}

// ── Relationship endpoints ───────────────────────────────────────────────────
/*
 * A name with a space in it is quoted in TMDL, on either side of the dot.
 * Unquoting only the table left the column carrying its quotes, so
 * Customer.'Source System' was indexed under a key no column ever matches —
 * the relationship parsed, and then vanished from the column that holds it. On
 * a large production model that hid a join, and a join that nothing mentions
 * is one you drop without warning.
 */
{
    const parser = new TMDLParser();
    const rels = parser.parseRelationships([
        "relationship a",
        "	fromColumn: Customer.'Source System'",
        "	toColumn: Ref_SourceSystem.SourceSystem",
        "",
        "relationship b",
        "	fromColumn: 'Site Performance'.'Date Key'",
        "	toColumn: Calendar.Date",
        "",
        "relationship c",
        "	fromColumn: Accounts.OwnerKey",
        "	toColumn: 'Customer Account Mapping'.OwnerKey",
        "	isActive: false",
    ].join('\n'));

    check('every relationship in the file is parsed', rels.length === 3, `${rels.length}`);
    const ends = rels.map(r => `${r.fromTable}.${r.fromColumn} -> ${r.toTable}.${r.toColumn}`);
    check('a quoted column keeps its name and loses its quotes',
        ends[0] === "Customer.Source System -> Ref_SourceSystem.SourceSystem", ends[0]);
    check('quoted on both sides of the dot',
        ends[1] === "Site Performance.Date Key -> Calendar.Date", ends[1]);
    check('a quoted table on the far side survives too',
        ends[2] === "Accounts.OwnerKey -> Customer Account Mapping.OwnerKey", ends[2]);
    check('an inactive relationship is marked, not dropped',
        rels[2].isActive === false && rels[0].isActive === true, `${rels[2].isActive}`);
}

// ── Navigation shapes ────────────────────────────────────────────────────────
for (const fixture of EXPRESSIONS) {
    const got = MExpressionParser.extractTableLineage(fixture.m) || {};
    const want = fixture.expect;

    check(`${fixture.name}: table`, (got.physicalTable ?? null) === want.table,
        `${got.physicalTable ?? null} (want ${want.table})`);
    check(`${fixture.name}: schema`, (got.physicalSchema ?? null) === want.schema,
        `${got.physicalSchema ?? null} (want ${want.schema})`);
    check(`${fixture.name}: navigation path`, same(got.path || [], want.path),
        `${JSON.stringify(got.path || [])} (want ${JSON.stringify(want.path)})`);
    check(`${fixture.name}: renames`, same(got.renames || [], want.renames),
        JSON.stringify(got.renames || []));
    check(`${fixture.name}: projection`, same(got.selectedColumns ?? null, want.selected),
        JSON.stringify(got.selectedColumns ?? null));

    // A column computed in Power Query is a dead end unless the columns its
    // expression reads are recorded too.
    if (want.addedColumns) {
        check(`${fixture.name}: added columns`, same(got.addedColumns || [], want.addedColumns),
            JSON.stringify(got.addedColumns || []));
        check(`${fixture.name}: what each added column reads`,
            same(got.addedColumnSources || {}, want.addedColumnSources),
            JSON.stringify(got.addedColumnSources || {}));
    }
}

// ── Wrapper-function expansion ───────────────────────────────────────────────
for (const fixture of WRAPPERS) {
    // inlineCustomSources rewrites partition.source in place.
    const model = JSON.parse(JSON.stringify(fixture.model));
    const stats = inlineCustomSources(model);
    const want = fixture.expect;

    check(`${fixture.name}: partitions expanded`, stats.inlined === want.inlined,
        `${stats.inlined} (want ${want.inlined})`);
    check(`${fixture.name}: functions used`, same(stats.functions, want.functions),
        JSON.stringify(stats.functions));

    const source = model.tables[0].partitions[0].source;
    const got = MExpressionParser.extractTableLineage(source) || {};
    check(`${fixture.name}: resolves to a table`, (got.physicalTable ?? null) === want.table,
        `${got.physicalTable ?? null} (want ${want.table})`);
    if ('schema' in want) {
        check(`${fixture.name}: resolves the schema`, (got.physicalSchema ?? null) === want.schema,
            `${got.physicalSchema ?? null} (want ${want.schema})`);
    }
    check(`${fixture.name}: navigation path`, same(got.path || [], want.path),
        `${JSON.stringify(got.path || [])} (want ${JSON.stringify(want.path)})`);
    check(`${fixture.name}: renames survive expansion`, same(got.renames || [], want.renames),
        JSON.stringify(got.renames || []));
}

let failures = 0;
for (const [name, pass, detail] of results) {
    if (!pass) failures++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail && !pass ? `  — ${detail}` : ''}`);
}
console.log(`\n${failures === 0 ? `All ${results.length} parsing checks passed.` : `${failures} of ${results.length} failed.`}`);

module.exports = { failures, results };
if (require.main === module) process.exit(failures === 0 ? 0 : 1);
