/**
 * Synthetic TMDL table files, written to exercise the shapes that a real
 * semantic model uses and a hand-written sample does not.
 *
 * The first fixture is the one that matters. Power BI Desktop writes a
 * multi-line DAX expression with the opening fence on the declaration line —
 * `measure 'x' = ``` ` — and the parser used to look for a fence only on a line
 * of its own. It therefore read each *closing* fence as an opening one and
 * swallowed every object up to the next one. Silent: the table parsed, the
 * report built, and the measures simply were not there. Every visual using one
 * was then reported as a broken reference.
 *
 * `expect.measures` is the full list, in file order. A parser that drops one
 * fails, which is the entire point.
 */

const TABS = '\t';

module.exports = [
    {
        name: 'measures whose fences open on the declaration line',
        file: 'tables/Metrics.tmdl',
        tmdl: `table Metrics

${TABS}measure Simple = SUM('Facts'[Amount])
${TABS}${TABS}formatString: #,0

${TABS}/// A fenced expression, opening on this line.
${TABS}measure 'Fenced One' = \`\`\`
${TABS}${TABS}${TABS}CALCULATE (
${TABS}${TABS}${TABS}    [Simple],
${TABS}${TABS}${TABS}    ALLSELECTED ()
${TABS}${TABS}${TABS})
${TABS}${TABS}${TABS}\`\`\`
${TABS}${TABS}formatString: #,0

${TABS}measure 'After The Fence' = SUM('Facts'[Cost])
${TABS}${TABS}formatString: #,0

${TABS}measure 'Fenced Two' = \`\`\`
${TABS}${TABS}${TABS}DIVIDE ( [Simple], [After The Fence] )
${TABS}${TABS}${TABS}\`\`\`
${TABS}${TABS}formatString: 0.0%

${TABS}measure 'Last One' = [Simple] + [After The Fence]
${TABS}${TABS}formatString: #,0

${TABS}column Amount
${TABS}${TABS}dataType: double
${TABS}${TABS}sourceColumn: Amount

${TABS}partition Metrics = m
${TABS}${TABS}mode: import
${TABS}${TABS}source =
${TABS}${TABS}${TABS}let
${TABS}${TABS}${TABS}    Source = Sql.Database("warehouse.example.net", "analytics"),
${TABS}${TABS}${TABS}    Nav = Source{[Schema="marts", Item="fct_metrics"]}[Data]
${TABS}${TABS}${TABS}in
${TABS}${TABS}${TABS}    Nav
`,
        expect: {
            table: 'Metrics',
            measures: ['Simple', 'Fenced One', 'After The Fence', 'Fenced Two', 'Last One'],
            columns: ['Amount'],
            physicalTable: 'fct_metrics',
            physicalSchema: 'marts',
        },
    },
    {
        name: 'fence on a line of its own still works',
        file: 'tables/Standalone.tmdl',
        tmdl: `table Standalone

${TABS}measure 'Block Below' =
${TABS}${TABS}${TABS}\`\`\`
${TABS}${TABS}${TABS}SUM ( 'Facts'[Amount] )
${TABS}${TABS}${TABS}\`\`\`
${TABS}${TABS}formatString: #,0

${TABS}measure 'Follows It' = COUNTROWS ( 'Facts' )
${TABS}${TABS}formatString: #,0
`,
        expect: {
            table: 'Standalone',
            measures: ['Block Below', 'Follows It'],
            columns: [],
        },
    },
];
