/**
 * Semantic models whose partitions hide their navigation inside a user-defined
 * M function — the shape `inlineCustomSources` exists to expand.
 *
 * Two of them, on purpose. The claim being tested is that the expansion is
 * generic: it follows a call into any shared expression shaped `(a, b) => body`,
 * whatever the function is called and whatever it wraps. One fixture wraps a
 * three-step catalogue chain, the other a two-part Schema/Item navigation, and
 * neither is named after a warehouse. A third has no wrapper at all and must
 * come back untouched.
 */

module.exports = [
    {
        name: 'wrapper around a three-step chain, arguments from parameters',
        model: {
            expressions: [
                { name: 'p_account', expression: '"acct-1234" meta [IsParameterQuery=true, Type="Text"]' },
                { name: 'p_zone', expression: '"curated" meta [IsParameterQuery=true, Type="Text"]' },
                {
                    name: 'get_table',
                    expression: `(_account, _zone, _table, _columns) =>
    let a = Root{[Name=_account]}[Data],
        b = a{[Name=_zone, Kind="Schema"]}[Data],
        c = b{[Name=_table, Kind="Table"]}[Data],
        d = Table.SelectColumns(c, _columns)
    in  d`,
                },
            ],
            tables: [{
                name: 'Orders',
                partitions: [{
                    source: `let
    Fields = {"order_id", "amount"},
    Source = get_table(p_account, p_zone, "fct_orders", Fields),
    Renamed = Table.RenameColumns(Source, {{"order_id", "Order ID"}})
in
    Renamed`,
                }],
            }],
        },
        expect: {
            inlined: 1,
            functions: ['get_table'],
            table: 'fct_orders',
            path: ['acct-1234', 'curated', 'fct_orders'],
            renames: [{ sourceName: 'order_id', modelName: 'Order ID' }],
        },
    },
    {
        name: 'wrapper around a two-part Schema/Item navigation',
        model: {
            expressions: [
                { name: 'p_schema', expression: '"marts" meta [IsParameterQuery=true, Type="Text"]' },
                {
                    name: 'fetch',
                    expression: `(_schema, _item) =>
    let src = Warehouse{[Schema=_schema, Item=_item]}[Data]
    in  src`,
                },
            ],
            tables: [{
                name: 'Customers',
                partitions: [{ source: 'let Source = fetch(p_schema, "dim_customer") in Source' }],
            }],
        },
        expect: {
            inlined: 1,
            functions: ['fetch'],
            table: 'dim_customer',
            schema: 'marts',
            path: [],
            renames: [],
        },
    },
    {
        name: 'no wrapper function — model must be returned untouched',
        model: {
            expressions: [
                { name: 'p_server', expression: '"warehouse.example.net" meta [IsParameterQuery=true]' },
            ],
            tables: [{
                name: 'Plain',
                partitions: [{
                    source: `let
    Source = Sql.Database(p_server, "analytics"),
    Nav = Source{[Schema="marts", Item="fct_orders"]}[Data]
in
    Nav`,
                }],
            }],
        },
        expect: {
            inlined: 0,
            functions: [],
            table: 'fct_orders',
            schema: 'marts',
            path: [],
            renames: [],
        },
    },
];
