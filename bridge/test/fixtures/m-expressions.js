/**
 * Synthetic Power Query M expressions, one per navigation shape.
 *
 * These exist so a change to the M parsing can be shown not to move the
 * warehouse relation it resolves. Nothing here comes from a real project: the
 * server names, datasets and tables are invented, and the set deliberately
 * includes a connector nobody has written support for, because "an unknown
 * connector still resolves its table" is a claim that has to be testable.
 *
 * `expect` records the parts of extractTableLineage's output that lineage
 * depends on. `path` is the ordered navigation chain, outermost first — three
 * segments on a catalogue-style connector, one on a flat one. Naming those
 * segments after any one warehouse's vocabulary is exactly what this fixture
 * set is here to prevent.
 */

module.exports = [
    {
        name: 'two-part Schema/Item navigation',
        m: `let
    Source = Sql.Database("warehouse.example.net", "analytics"),
    Nav = Source{[Schema="marts", Item="fct_orders"]}[Data]
in
    Nav`,
        expect: { schema: 'marts', table: 'fct_orders', path: [], renames: [], selected: null },
    },
    {
        name: 'Item before Schema',
        m: `let
    Source = Sql.Database("warehouse.example.net", "analytics"),
    Nav = Source{[Item="dim_customer", Schema="marts"]}[Data]
in
    Nav`,
        expect: { schema: 'marts', table: 'dim_customer', path: [], renames: [], selected: null },
    },
    {
        name: 'three-step Name chain',
        m: `let
    Source = SomeCatalog.Database("acct-1234"),
    a = Source{[Name="acct-1234"]}[Data],
    b = a{[Name="curated"]}[Data],
    c = b{[Name="fct_events"]}[Data]
in
    c`,
        expect: {
            schema: null, table: 'fct_events',
            path: ['acct-1234', 'curated', 'fct_events'],
            renames: [], selected: null,
        },
    },
    {
        name: 'Name chain carrying Kind discriminators',
        m: `let
    Source = SomeCatalog.Database("acct-1234"),
    a = Source{[Name="acct-1234"]}[Data],
    b = a{[Name="curated", Kind="Schema"]}[Data],
    c = b{[Name="fct_events", Kind="Table"]}[Data]
in
    c`,
        expect: {
            schema: null, table: 'fct_events',
            path: ['acct-1234', 'curated', 'fct_events'],
            renames: [], selected: null,
        },
    },
    {
        name: 'two-step Name chain',
        m: `let
    Source = Flatstore.Contents("https://example.invalid/feed"),
    a = Source{[Name="reference"]}[Data],
    b = a{[Name="dim_country"]}[Data]
in
    b`,
        expect: {
            schema: null, table: 'dim_country',
            path: ['reference', 'dim_country'], renames: [], selected: null,
        },
    },
    {
        name: 'unknown connector, standard navigation',
        m: `let
    Source = NobodyHasHeardOfThis.Connect("host.invalid", [Timeout=30]),
    Nav = Source{[Schema="staging", Item="stg_widgets"]}[Data]
in
    Nav`,
        expect: { schema: 'staging', table: 'stg_widgets', path: [], renames: [], selected: null },
    },
    {
        name: 'renames and an explicit projection',
        m: `let
    Source = Sql.Database("warehouse.example.net", "analytics"),
    Nav = Source{[Schema="marts", Item="fct_orders"]}[Data],
    Renamed = Table.RenameColumns(Nav, {{"order_id", "Order ID"}, {"amt", "Amount"}}),
    Picked = Table.SelectColumns(Renamed, {"Order ID", "Amount", "order_date"})
in
    Picked`,
        expect: {
            schema: 'marts', table: 'fct_orders', path: [],
            renames: [{ sourceName: 'order_id', modelName: 'Order ID' },
                      { sourceName: 'amt', modelName: 'Amount' }],
            selected: ['Order ID', 'Amount', 'order_date'],
        },
    },
    {
        name: 'projection pruned by RemoveColumns',
        m: `let
    Source = Sql.Database("warehouse.example.net", "analytics"),
    Nav = Source{[Schema="marts", Item="fct_orders"]}[Data],
    Picked = Table.SelectColumns(Nav, {"order_id", "amt", "internal_flag"}),
    Trimmed = Table.RemoveColumns(Picked, {"internal_flag"})
in
    Trimmed`,
        expect: {
            schema: 'marts', table: 'fct_orders', path: [],
            renames: [], selected: ['order_id', 'amt'],
        },
    },
    {
        name: 'a column computed from two others, used as a key',
        // The case that started this: a key that exists in no source table.
        // Without the reads, the two columns behind it look untouched by it.
        m: `let
    Source = Sql.Database("warehouse.example.net", "analytics"),
    Nav = Source{[Schema="marts", Item="fct_orders"]}[Data],
    Keyed = Table.AddColumn(Nav, "JoinKey", each if [region] = null then [country] else [region]),
    Flagged = Table.AddColumn(Keyed, "IsLarge", each [amount] > 1000)
in
    Flagged`,
        expect: {
            schema: 'marts', table: 'fct_orders', path: [], renames: [], selected: null,
            addedColumns: ['JoinKey', 'IsLarge'],
            addedColumnSources: { JoinKey: ['region', 'country'], IsLarge: ['amount'] },
        },
    },
    {
        name: 'quoted field names and a record literal that is not a field access',
        m: `let
    Source = Sql.Database("warehouse.example.net", "analytics"),
    Nav = Source{[Schema="marts", Item="fct_orders"]}[Data],
    Combined = Table.AddColumn(Nav, "Label", each #"Order Id" & " / " & [#"Customer Name"])
in
    Combined`,
        expect: {
            schema: 'marts', table: 'fct_orders', path: [], renames: [], selected: null,
            addedColumns: ['Label'],
            // Schema and Item come from a record literal in the navigation step
            // and must never be reported as columns.
            addedColumnSources: { Label: ['Customer Name'] },
        },
    },
    {
        name: 'an added column whose expression reads nothing',
        m: `let
    Source = Sql.Database("warehouse.example.net", "analytics"),
    Nav = Source{[Schema="marts", Item="fct_orders"]}[Data],
    Stamped = Table.AddColumn(Nav, "LoadedAt", each DateTime.FixedLocalNow())
in
    Stamped`,
        expect: {
            schema: 'marts', table: 'fct_orders', path: [], renames: [], selected: null,
            addedColumns: ['LoadedAt'],
            addedColumnSources: {},
        },
    },
    {
        name: 'no navigation at all',
        m: `let
    Source = Table.FromRows({{1, "a"}, {2, "b"}}, {"id", "label"})
in
    Source`,
        expect: { schema: null, table: null, path: [], renames: [], selected: null },
    },
];
