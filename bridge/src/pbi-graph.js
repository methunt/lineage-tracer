/**
 * Power BI side of the bridge: a parsed PBIP project -> our merged-graph schema.
 *
 * Consumes the output of pbip-extract.js (which runs pbip-documenter's parsers
 * headless) and reshapes it into the nodes/edges contract in
 * bridge/docs/ui-spec.md section 3.
 *
 * Node kinds emitted: pbiTable, measure, page, visual. Columns are nested inside
 * their table, never standalone nodes — that is what keeps the graph readable and
 * what makes the expand-a-table interaction natural.
 *
 * Pages exist for the same reason columns are nested: a report with a couple of
 * hundred visuals
 * cannot be read one visual at a time. A page carries the same data edges its
 * visuals do, so a measure feeding eight visuals across two pages shows two
 * nodes instead of eight, and the visuals are one expansion away.
 */

const lower = s => String(s ?? '').trim().toLowerCase();

const tableId = name => `pbi:table:${name}`;
const measureId = (table, name) => `pbi:measure:${table}[${name}]`;
const visualId = (pageId, vId) => `pbi:visual:${pageId}/${vId}`;
const pageId_ = pageId => `pbi:page:${pageId}`;

/**
 * @param {object} pbip  output of extractPbip()
 * @returns {{nodes: object, edges: Array, stats: object}}
 */
function buildPbiGraph(pbip) {
    const { payload, engine, physicalIndex, mComputed } = pbip;
    const model = payload.parsedModel;
    const nodes = {};
    const edges = [];

    // Physical source per model table, so the panel can show where a table came from.
    const physByTable = new Map();
    for (const row of physicalIndex) {
        if (!physByTable.has(lower(row.modelTable))) {
            physByTable.set(lower(row.modelTable), {
                database: row.physicalDatabase,
                schema: row.physicalSchema,
                table: row.physicalTable,
            });
        }
    }
    /*
     * Relationship keys, indexed by table[column].
     *
     * A column can be load-bearing without appearing in a single visual: the
     * key columns of a star schema are used by every join and by no chart. On
     * a large production model the great majority of key columns are like
     * that, and until this
     * index existed the report described them as unused — the worst possible
     * advice, because dropping a key does not raise an error, it silently
     * changes the numbers.
     *
     * Inactive relationships are indexed too. They are reachable only through
     * USERELATIONSHIP in a measure, which makes them easier to miss and no less
     * real; the flag rides along so the UI can say which is which.
     */
    const relKey = (table, column) => `${lower(table)}|${lower(column)}`;
    const relationshipsByColumn = new Map();
    const noteKey = (table, column, entry) => {
        if (!table || !column) return;
        const key = relKey(table, column);
        if (!relationshipsByColumn.has(key)) relationshipsByColumn.set(key, []);
        relationshipsByColumn.get(key).push(entry);
    };
    for (const rel of model.relationships || []) {
        const active = rel.isActive !== false;
        noteKey(rel.fromTable, rel.fromColumn, {
            side: 'from', active, cardinality: rel.cardinality || null,
            otherTable: rel.toTable, otherColumn: rel.toColumn,
        });
        noteKey(rel.toTable, rel.toColumn, {
            side: 'to', active, cardinality: rel.cardinality || null,
            otherTable: rel.fromTable, otherColumn: rel.fromColumn,
        });
    }

    /*
     * Field parameters, resolved to the nodes their rows point at.
     *
     * A row names a field without reading it, so nothing else in the model
     * records the dependency. Resolution has to happen here, against the whole
     * model, because a row may name its target with a table or without one —
     * the unqualified form being how a measure is normally written.
     *
     * Resolution is recorded on the row, including its failure. A row pointing
     * at a field that no longer exists and a row nobody uses are the same shape
     * once you are looking at the edge list, and only one of them is a problem.
     */
    /*
     * Resolution is case-insensitive, and it resolves to the name the model
     * declares rather than the one the row happens to spell.
     *
     * Power BI does not care about case and report authors are not consistent
     * about it: a row written `NAMEOF([Total Value Sold])` refers to the measure
     * declared `Total Value sold`. Building an id out of the row's
     * spelling produced an id for a node that does not exist, so the row resolved
     * and then linked to nothing — the same silent near-miss the broken-reference
     * check already exists to avoid.
     */
    const measureHome = new Map();          // lower(name) -> {table, name} as declared
    for (const table of model.tables || []) {
        for (const measure of table.measures || []) {
            if (!measureHome.has(lower(measure.name))) {
                measureHome.set(lower(measure.name), { table: table.name, name: measure.name });
            }
        }
    }
    const tablesByName = new Map();          // lower(table) -> {name, columns, measures} as declared
    for (const table of model.tables || []) {
        tablesByName.set(lower(table.name), {
            name: table.name,
            columns: new Map((table.columns || []).map(c => [lower(c.name), c.name])),
            measures: new Map((table.measures || []).map(m => [lower(m.name), m.name])),
        });
    }

    const NOT_FOUND = { targetId: null, targetKind: null, homeTable: null };
    const resolveParameterRow = item => {
        const name = lower(item.targetName);
        // Unqualified brackets are a measure, always: that is what the syntax
        // means, and it is the form a parameter over measures is written in.
        if (!item.targetTable) {
            const home = measureHome.get(name);
            return home ? {
                targetId: measureId(home.table, home.name), targetKind: 'measure',
                homeTable: home.table, targetTable: null, targetName: home.name,
            } : NOT_FOUND;
        }
        const table = tablesByName.get(lower(item.targetTable));
        if (!table) return NOT_FOUND;
        // A qualified name may be either, and a measure wins — Power BI will not
        // let a table hold a measure and a column of one name.
        const measure = table.measures.get(name);
        if (measure) {
            return {
                targetId: measureId(table.name, measure), targetKind: 'measure',
                homeTable: table.name, targetTable: table.name, targetName: measure,
            };
        }
        const column = table.columns.get(name);
        if (!column) return NOT_FOUND;
        return {
            targetId: tableId(table.name), targetKind: 'column',
            homeTable: table.name, targetTable: table.name, targetName: column,
        };
    };

    const parametersByTable = new Map();    // lower(fp table) -> {name, markerColumn, valueColumn, items}
    for (const table of model.tables || []) {
        if (!table.fieldParameter) continue;
        /*
         * The column the reader actually sees. A parameter carries three or four:
         * the labels, a hidden one holding the references, a hidden one for the
         * sort order, and sometimes a fourth. Only the first is what a visual
         * binds to, so it is the one an upstream link should land on.
         */
        const marker = lower(table.fieldParameter.markerColumn || '');
        const value = (table.columns || []).find(c => !c.isHidden && lower(c.name) !== marker)
            || (table.columns || [])[0] || null;
        parametersByTable.set(lower(table.name), {
            name: table.name,
            markerColumn: table.fieldParameter.markerColumn || null,
            valueColumn: value ? value.name : null,
            items: (table.fieldParameter.items || []).map(item => ({
                ...item, ...resolveParameterRow(item),
            })),
        });
    }

    const renamesByTable = new Map();
    for (const row of physicalIndex) {
        if (lower(row.physicalColumn) === lower(row.modelColumn)) continue;
        const list = renamesByTable.get(lower(row.modelTable)) || [];
        list.push({ sourceName: row.physicalColumn, modelName: row.modelColumn });
        renamesByTable.set(lower(row.modelTable), list);
    }

    // ── Tables ───────────────────────────────────────────────────────────────
    for (const table of model.tables || []) {
        if (table._isAutoDate) continue;

        const phys = physByTable.get(lower(table.name)) || null;
        const partition = (table.partitions || [])[0] || {};

        nodes[tableId(table.name)] = {
            id: tableId(table.name),
            kind: 'pbiTable',
            name: table.name,
            layer: 'powerbi',
            origin: 'pbi',
            columns: (table.columns || []).map(col => ({
                name: col.name,
                dataType: col.dataType || null,
                description: col.description || null,
                isHidden: !!col.isHidden,
                isCalculated: !!col.expression,
                // Kept so the panel can show *what* a calculated column
                // computes — "calculated" alone tells a reader nothing about
                // whether their change breaks it.
                expression: col.expression || null,
                hasLineage: false,           // set by the merge when a dbt link lands
                // Joins this column takes part in. Empty for most columns; the
                // ones that have entries are the model's skeleton.
                relationships: relationshipsByColumn.get(relKey(table.name, col.name)) || [],
                tests: [],
                tags: [],
            })),
            meta: {
                storageMode: partition.mode || null,
                isHidden: !!table.isHidden,
                description: table.description || null,
                columnCount: (table.columns || []).length,
                measureCount: (table.measures || []).length,
                physicalSource: phys,
                relation: phys ? [phys.database, phys.schema, phys.table].filter(Boolean).join('.') : null,
                renames: renamesByTable.get(lower(table.name)) || [],
                // Present only on a field parameter, so a reader — and the
                // panel — can tell one from a table that merely looks odd.
                fieldParameter: parametersByTable.get(lower(table.name)) || null,
                relationshipCount: (table.columns || [])
                    .reduce((n, c) => n + (relationshipsByColumn.get(relKey(table.name, c.name))?.length || 0), 0),
                tags: [],
                testCount: 0,
            },
            definition: {
                // What the author wrote, and — when a custom source function was
                // expanded — what we resolved it to. Both, so the panel can show
                // the derivation rather than asking the reader to trust it.
                m: partition._originalSource || partition.source || null,
                mInlined: partition._originalSource ? partition.source : null,
            },
        };

        // ── Measures ─────────────────────────────────────────────────────────
        for (const measure of table.measures || []) {
            const id = measureId(table.name, measure.name);
            nodes[id] = {
                id,
                kind: 'measure',
                name: measure.name,
                layer: 'powerbi',
                origin: 'pbi',
                columns: [],
                meta: {
                    homeTable: table.name,
                    description: measure.description || null,
                    formatString: measure.formatString || null,
                    displayFolder: measure.displayFolder || null,
                    isHidden: !!measure.isHidden,
                    tags: [],
                    testCount: 0,
                },
                definition: { dax: measure.expression || null },
            };
        }
    }

    // ── Visuals ──────────────────────────────────────────────────────────────
    // A visual is identified by pageId/visualId throughout. The engine's own
    // `pageName|visualName` key is deliberately not carried here: two visuals
    // on one page may share a title, and a lookup on that key hands one of them
    // every edge and the other none.
    const visualPage = new Map();          // visual node id -> page node id

    /*
     * Absolute page coordinates.
     *
     * A visual inside a group stores its position relative to that group, and
     * groups nest. Drawing the stored numbers put every grouped visual at the
     * page origin — on a real, heavily grouped page that was most of its
     * visuals, stacked in the top-left
     * corner. Resolved here rather than in the view: it needs every visual on
     * the page at once, which the view does not have when it draws one box.
     */
    const byName = new Map();
    for (const v of payload.visualData?.visuals || []) {
        if (v.name) byName.set(`${v.pageId}|${v.name}`, v);
    }
    const chainOf = visual => {
        const chain = [];
        let node = visual;
        const seen = new Set();
        // Bounded by `seen`: a group cycle in a malformed file must not hang
        // the build.
        while (node && !seen.has(node.name)) {
            seen.add(node.name);
            chain.unshift(node);              // root ancestor first
            node = node.parentGroupName
                ? byName.get(`${visual.pageId}|${node.parentGroupName}`)
                : null;
        }
        return chain;
    };

    /*
     * Stacking, and why one number will not do.
     *
     * `z` is scoped to its siblings, not to the page. A group's background
     * shape sits at z=0 *within that group*, and must still paint above every
     * visual in a group ranked below it. Comparing raw z across the page
     * interleaves one group's backdrop with another group's charts, and the
     * report ends up drawn in an order the author never chose.
     *
     * The ancestor chain of z values sorts correctly by construction: compare
     * the outermost first, and only fall through to the next level on a tie —
     * which is exactly what "inside that group" means.
     */
    const geometry = visual => {
        const chain = chainOf(visual);
        let x = 0;
        let y = 0;
        for (const node of chain) {
            x += node.position?.x || 0;
            y += node.position?.y || 0;
        }
        return { x, y, zPath: chain.map(n => n.position?.z ?? 0) };
    };

    /*
     * Pages come from the page list, not from the visuals that happen to sit on
     * them. Built lazily from visuals, a page holding nothing — a section
     * divider, a page mid-authoring — has no node at all, and the layout view
     * would show a report with pages missing and no way to tell.
     *
     * The geometry travels with them: the layout view draws real coordinates,
     * and a page that reports its own size is the frame those coordinates are
     * relative to.
     */
    for (const page of payload.visualData?.pages || []) {
        const pId = pageId_(page.id);
        nodes[pId] = {
            id: pId,
            kind: 'page',
            name: page.displayName || page.name || page.id,
            layer: 'powerbi',
            origin: 'pbi',
            columns: [],
            meta: {
                pageId: page.id,
                visualCount: 0,
                order: page.order ?? null,
                hidden: Boolean(page.hidden),
                isLanding: Boolean(page.isLanding),
                isDrillthrough: Boolean(page.isDrillthrough),
                width: page.pageWidth || null,
                height: page.pageHeight || null,
                displayOption: page.displayOption || null,
                tags: [],
                testCount: 0,
            },
            definition: {},
        };
    }

    for (const visual of payload.visualData?.visuals || []) {
        const name = visual.visualName || visual.visualType || 'visual';
        const id = visualId(visual.pageId, visual.visualId);

        // A page node normally exists already, from the pass above; this
        // covers a visual whose page is somehow absent from the page list.
        const pId = pageId_(visual.pageId);
        visualPage.set(id, pId);
        if (!nodes[pId]) {
            nodes[pId] = {
                id: pId,
                kind: 'page',
                name: visual.pageName || visual.pageId,
                layer: 'powerbi',
                origin: 'pbi',
                columns: [],
                meta: {
                    pageId: visual.pageId, visualCount: 0, order: null,
                    hidden: false, tags: [], testCount: 0,
                },
                definition: {},
            };
        }
        // Groups do not count: "27 visuals" that includes four containers the
        // author drew around the other 23 is not a number anyone can check.
        if (!visual.isGroup) nodes[pId].meta.visualCount++;

        nodes[id] = {
            id,
            kind: 'visual',
            name,
            layer: 'powerbi',
            origin: 'pbi',
            columns: [],
            meta: {
                page: visual.pageName,
                pageId: visual.pageId,
                visualId: visual.visualId,
                visualType: visual.visualType || null,
                fieldCount: (visual.fields || []).length,
                // Where it sits on the page, in page coordinates. Kept because
                // the layout view draws it; the graph has no use for them.
                position: visual.position
                    ? { ...visual.position, ...geometry(visual) }
                    : null,
                // A group is a container the author drew around other visuals:
                // it holds no fields and is not a thing that can break.
                isGroup: Boolean(visual.isGroup),
                groupName: visual.groupName || null,
                tags: [],
                testCount: 0,
            },
            definition: {
                fields: (visual.fields || []).map(f => ({
                    type: f.type,
                    table: f.table || f.entity,
                    name: f.name || f.column || f.measure || f.hierarchy,
                    role: f.projectionName || f.role || null,
                    // What *this* visual calls the field, when the author renamed
                    // it here. Absent on every field that is not renamed, and on
                    // every graph built before renames were extracted — so each
                    // reader treats absent as "no rename", not as missing data.
                    ...(f.displayName ? { displayName: f.displayName } : {}),
                    ...(f.displayNames?.length > 1 ? { displayNames: f.displayNames } : {}),
                })),
            },
        };
    }

    /*
     * ── Where each field is renamed, gathered onto the field itself ──────────
     *
     * A rename belongs to one projection in one visual, so it cannot simply be a
     * property of the measure: one measure reads "Label A" in a table and
     * "Label B" in a KPI card. But the reader arrives from the other end — they
     * were told "Label B is wrong" and have to find the measure — so the field
     * carries the set of names it is read under, and which visual uses which.
     *
     * Distinct from a table's `meta.renames`, which is the physical-to-model
     * column rename the semantic model itself performs. That one no report
     * reader ever sees; this one is the only name they *do* see.
     */
    /*
     * Keyed by origin as well as by name, because one label can arrive from both
     * at once — a parameter row captioned "Price per Unit" and a visual whose
     * field well renames the same column to "Price per Unit" is an ordinary
     * thing for one author to have done twice. Keyed by name alone, the two
     * merged into a single row that credited the parameter with a rename typed
     * into a visual, and pointed the reader at the wrong place to change it.
     */
    const aliasKey = (origin, alias) => `${origin} ${alias}`;
    const aliasIndex = new Map();          // "type|table|field" -> Map(originKey -> entry)
    const renameRows = [];                 // the same facts, flat, for Diagnostics
    for (const visual of payload.visualData?.visuals || []) {
        for (const field of visual.fields || []) {
            const fName = field.name || field.column || field.hierarchy;
            const fTable = field.table || field.entity;
            if (!fName || !fTable) continue;
            for (const alias of field.displayNames || []) {
                renameRows.push({
                    page: visual.pageName || '',
                    visual: visual.visualName || visual.visualType || '',
                    field: `${fTable}[${fName}]`,
                    shownAs: alias,
                    role: field.projectionName || '',
                });
                const key = `${field.type}|${lower(fTable)}|${lower(fName)}`;
                if (!aliasIndex.has(key)) aliasIndex.set(key, new Map());
                const byAlias = aliasIndex.get(key);
                const entryKey = aliasKey('visual', alias);
                if (!byAlias.has(entryKey)) {
                    byAlias.set(entryKey, { name: alias, origin: 'visual', parameter: null, visuals: [] });
                }
                byAlias.get(entryKey).visuals.push({
                    page: visual.pageName || null,
                    visual: visual.visualName || visual.visualType || null,
                    // Role is kept because a rename on a tooltip and a rename on
                    // a value are not equally visible to a reader, and no single
                    // place here should have to decide which of those counts.
                    role: field.projectionName || null,
                });
            }
        }
    }

    /*
     * A field parameter's captions belong in the same index.
     *
     * They are the same fact from the reader's side — a label on screen that the
     * model has never heard of — and a reader searching one does not know which
     * kind they have. What they need is to be told apart once found: a caption is
     * authored once, in the model, and inherited by every visual bound to the
     * parameter; a rename is authored in one visual and stops there. Different
     * scope, different place to go and fix it, so each alias carries its origin.
     */
    for (const [key, param] of parametersByTable) {
        const readers = [];
        for (const visual of payload.visualData?.visuals || []) {
            if (!(visual.fields || []).some(f => f.type === 'column' && lower(f.table) === key)) continue;
            readers.push({
                page: visual.pageName || null,
                visual: visual.visualName || visual.visualType || null,
                role: null,       // the parameter drives the well, not one role
            });
        }
        for (const item of param.items) {
            if (!item.caption || !item.targetKind || !item.homeTable) continue;
            if (lower(item.caption) === lower(item.targetName)) continue;   // says nothing
            const key2 = `${item.targetKind}|${lower(item.homeTable)}|${lower(item.targetName)}`;
            if (!aliasIndex.has(key2)) aliasIndex.set(key2, new Map());
            const byAlias = aliasIndex.get(key2);
            const entryKey = aliasKey('parameter', item.caption);
            if (!byAlias.has(entryKey)) {
                byAlias.set(entryKey, {
                    name: item.caption, origin: 'parameter', parameter: param.name, visuals: [],
                });
            }
            byAlias.get(entryKey).visuals.push(...readers);
        }
    }

    /** The alias list for one field, in the shape the panel renders. */
    const aliasesFor = (type, table, name) => {
        const byAlias = aliasIndex.get(`${type}|${lower(table)}|${lower(name)}`);
        return byAlias ? [...byAlias.values()] : [];
    };

    for (const node of Object.values(nodes)) {
        if (node.kind === 'measure') {
            const aliases = aliasesFor('measure', node.meta.homeTable, node.name);
            if (aliases.length) node.meta.aliases = aliases;
            continue;
        }
        if (node.kind !== 'pbiTable') continue;
        for (const col of node.columns || []) {
            const aliases = aliasesFor('column', node.name, col.name);
            if (aliases.length) col.aliases = aliases;
        }
    }

    /*
     * Where a field parameter comes from.
     *
     * Drawn with no upstream it read as a table out of nowhere, which is the
     * opposite of the truth: every row names a field in another table, and
     * renaming or dropping that field breaks the row — silently, for whoever
     * picks that label in the slicer. The parameter is downstream of everything
     * it offers.
     *
     * The link lands on the parameter's display column, the one a visual binds
     * to, so a walk that reaches a field carries on through the parameter to the
     * visuals reading it rather than stopping at the table.
     */
    for (const param of parametersByTable.values()) {
        const into = tableId(param.name);
        if (!nodes[into]) continue;
        for (const item of param.items) {
            if (!item.targetId || !nodes[item.targetId] || item.targetId === into) continue;
            pushEdge(edges, {
                source: item.targetId,
                target: into,
                sourceColumn: item.targetKind === 'column' ? item.targetName : '',
                targetColumn: param.valueColumn || '',
                kind: item.targetKind === 'measure' ? 'measure_to_table' : 'column_to_table',
                viaParameter: param.name,
            });
        }
    }

    // ── Edges, translated from the engine's own graph ────────────────────────
    // Only the relationships that matter for lineage; layout edges are dropped.
    // Calculated-column dependencies, collected here and attached to the
    // columns once the edge pass is done.
    const columnDeps = [];

    for (const edge of engine.edges) {
        switch (edge.type) {
            case 'references_column': {
                /*
                 * Emitted by two producers, not one: a measure referencing a
                 * column, and a *calculated column* referencing the columns its
                 * DAX reads. Treating every `from` as a measure minted ids like
                 * `pbi:measure:Field Dim[Name]` for something that is a column,
                 * so those edges pointed at nodes that do not exist — the DAX
                 * column lineage was parsed and then thrown away.
                 */
                const from = engine.nodes.get(edge.from);
                const target = engine.nodes.get(edge.to);
                if (!from || !target?.table) break;

                if (from.type !== 'measure') {
                    /*
                     * A calculated column and the columns its DAX reads. Both
                     * sides are columns, and columns are nested inside table
                     * nodes — so within one table this is metadata on the
                     * column, not an edge. Emitting it as one produced a node
                     * pointing at itself, which the canvas would draw as a loop
                     * and the impact walk would have to guard against. Across
                     * tables it is a genuine dependency and becomes an edge.
                     */
                    if (!from.table) break;
                    columnDeps.push({
                        table: from.table, column: from.name,
                        fromTable: target.table, fromColumn: target.name,
                    });
                    if (lower(from.table) !== lower(target.table)) {
                        pushEdge(edges, {
                            source: tableId(target.table),
                            target: tableId(from.table),
                            sourceColumn: target.name,
                            targetColumn: from.name,
                            kind: 'column_to_column',
                        });
                    }
                    break;
                }

                const m = from;
                pushEdge(edges, {
                    source: tableId(target.table),
                    target: measureId(m.table, m.name),
                    sourceColumn: target.name,
                    targetColumn: '',
                    kind: 'column_to_measure',
                });
                break;
            }
            case 'depends_on_measure': {
                const from = engine.nodes.get(edge.from);
                const to = engine.nodes.get(edge.to);
                if (!from || !to) break;
                pushEdge(edges, {
                    source: measureId(to.table, to.name),
                    target: measureId(from.table, from.name),
                    sourceColumn: '',
                    targetColumn: '',
                    kind: 'measure_to_measure',
                });
                break;
            }
            case 'derived_from_table': {
                /*
                 * A calculated table and the tables its DAX reads.
                 *
                 * The engine has always worked this out and nothing carried it
                 * across, so a calculated table was drawn with no upstream —
                 * indistinguishable from a table loaded from nowhere. It also
                 * never fired until the partition's source type was read
                 * properly, so this is newly worth translating.
                 *
                 * Field parameters are excluded: the engine resolves this at
                 * table granularity, and a parameter's own rows are resolved to
                 * the field, which is both narrower and more useful. Taking both
                 * would draw the coarse link beside the precise ones.
                 */
                const derived = engine.nodes.get(edge.from);
                const from = engine.nodes.get(edge.to);
                if (!derived?.name || !from?.name) break;
                if (parametersByTable.has(lower(derived.name))) break;
                const target = tableId(derived.name);
                const source = tableId(from.name);
                if (!nodes[target] || !nodes[source] || source === target) break;
                pushEdge(edges, {
                    source, target,
                    sourceColumn: '', targetColumn: '',
                    kind: 'table_to_table',
                });
                break;
            }
            case 'uses_field':
                // Handled below, from the visuals themselves. The engine
                // identifies a visual by `pageName|visualName`, and a name is
                // not an identity: see the pass after this loop.
                break;
            default:
                break;
        }
    }

    /*
     * What each visual reads, keyed by the visual's own id.
     *
     * This used to come from the engine's `uses_field` edges, which identify a
     * visual as `pageName|visualName`. A name is not an identity: Power BI
     * happily puts two charts called "Media Cost by Month" on one page, the
     * lookup collided, and one of them was handed every field edge while the
     * other was left with nothing but its page. On a large production report
     * that silently emptied several visuals on one page — they rendered as
     * dependency-free, which is the most dangerous thing this tool can say.
     *
     * The parsed visual already carries both its stable id and its own field
     * list, so the identity question does not arise.
     */
    for (const visual of payload.visualData?.visuals || []) {
        const vId = visualId(visual.pageId, visual.visualId);
        if (!nodes[vId]) continue;
        const pId = visualPage.get(vId);

        /*
         * A visual driven by a field parameter reads whichever row the reader
         * picks, but the file records only the row that was showing when the
         * report was saved — as an ordinary field reference, so the graph looks
         * complete and is not. Every row gets an edge, or a measure reachable
         * only through the slicer is reported as used by nothing.
         *
         * `viaParameter` rides along so the difference stays visible; the edges
         * are otherwise ordinary, which is what lets the impact walk, the
         * highlighting and the filters count them without knowing about any of
         * this. The row that *is* showing already has a direct edge from the
         * pass below, and the deduplication keeps that one.
         */
        const driving = [];
        for (const field of visual.fields || []) {
            const param = field.type === 'column' && parametersByTable.get(lower(field.table));
            if (!param || driving.some(p => p.table === param.name)) continue;
            const sel = (visual.fpSelections || {})[param.name];
            const chosen = sel && sel.selectedIndex != null
                ? param.items.find(i => i.order === sel.selectedIndex) : null;
            driving.push({
                table: param.name,
                items: param.items.length,
                selected: chosen ? chosen.caption : null,
            });
            for (const item of param.items) {
                if (!item.targetId || !nodes[item.targetId]) continue;
                const column = item.targetKind === 'column' ? item.targetName : '';
                for (const [target, kind] of [[vId, 'visual'], [pId, 'page']]) {
                    if (!target) continue;
                    pushEdge(edges, {
                        source: item.targetId, target,
                        sourceColumn: column, targetColumn: '',
                        kind: `${item.targetKind === 'measure' ? 'measure' : 'column'}_to_${kind}`,
                        viaParameter: param.name,
                    });
                }
            }
        }
        if (driving.length) nodes[vId].meta.fieldParameters = driving;

        for (const field of visual.fields || []) {
            if (!field?.table || !field?.name) continue;
            /*
             * Each data edge lands on the visual *and* on its page. The page is
             * genuinely downstream — a change that breaks the visual breaks the
             * page it sits on — so this aggregates rather than invents a
             * relationship. Filtering decides which is on screen.
             */
            if (field.type === 'measure') {
                const source = measureId(field.table, field.name);
                if (!nodes[source]) continue;
                pushEdge(edges, {
                    source, target: vId,
                    sourceColumn: '', targetColumn: '',
                    kind: 'measure_to_visual',
                });
                if (pId) {
                    pushEdge(edges, {
                        source, target: pId,
                        sourceColumn: '', targetColumn: '',
                        kind: 'measure_to_page',
                    });
                }
            } else {
                const source = tableId(field.table);
                if (!nodes[source]) continue;
                pushEdge(edges, {
                    source, target: vId,
                    sourceColumn: field.name, targetColumn: '',
                    kind: 'column_to_visual',
                });
                if (pId) {
                    pushEdge(edges, {
                        source, target: pId,
                        sourceColumn: field.name, targetColumn: '',
                        kind: 'column_to_page',
                    });
                }
            }
        }
    }

    /*
     * Containment, not data flow: a page holds its visuals.
     *
     * These exist so expanding a page reveals what is on it. They are excluded
     * from the impact walk and from path highlighting on purpose — following
     * them would mean one affected visual made every other visual on the same
     * page count as affected, which would inflate every impact number in the
     * report.
     */
    // Columns computed in Power Query, and what they read. Same shape as the
    // DAX case below, because it answers the same question — a column that
    // exists in no source table, and the columns it is built from.
    for (const [tableName, computed] of (mComputed || new Map())) {
        const owner = nodes[tableId(tableName)];
        if (!owner) continue;
        for (const [columnName, reads] of Object.entries(computed)) {
            const column = owner.columns?.find(c => lower(c.name) === lower(columnName));
            if (!column) continue;
            for (const read of reads) {
                // Only reads that survive as columns of this table. A step may
                // read something later removed, and pointing at a column the
                // reader cannot open would be worse than saying nothing.
                const source = owner.columns.find(c => lower(c.name) === lower(read));
                if (!source || source === column) continue;
                if (!column.dependsOn) column.dependsOn = [];
                const already = column.dependsOn.some(d =>
                    lower(d.table) === lower(tableName) && lower(d.column) === lower(source.name));
                if (!already) column.dependsOn.push({ table: tableName, column: source.name, via: 'm' });
            }
        }
    }

    // What each calculated column reads. Regex over DAX gives the *set* of
    // columns, not the structure of the expression — enough to answer "does
    // dropping this break that", which is the question being asked.
    for (const dep of columnDeps) {
        const owner = nodes[tableId(dep.table)];
        const column = owner?.columns?.find(c => lower(c.name) === lower(dep.column));
        if (!column) continue;
        if (!column.dependsOn) column.dependsOn = [];
        const already = column.dependsOn.some(d =>
            lower(d.table) === lower(dep.fromTable) && lower(d.column) === lower(dep.fromColumn));
        if (!already) column.dependsOn.push({ table: dep.fromTable, column: dep.fromColumn, via: 'dax' });
    }

    for (const [vId, pId] of visualPage) {
        if (!nodes[pId] || !nodes[vId]) continue;
        pushEdge(edges, {
            source: pId, target: vId,
            sourceColumn: '', targetColumn: '',
            kind: 'page_to_visual',
        });
    }

    return {
        nodes,
        edges,
        stats: {
            pages: Object.values(nodes).filter(n => n.kind === 'page').length,
            tables: Object.values(nodes).filter(n => n.kind === 'pbiTable').length,
            measures: Object.values(nodes).filter(n => n.kind === 'measure').length,
            visuals: Object.values(nodes).filter(n => n.kind === 'visual').length,
            brokenRefs: (engine.brokenRefs || []).filter(ref => !resolvesIgnoringCase(ref, nodes)),
            /*
             * Every rename, one row per place it is applied.
             *
             * Reported rather than merely used, on the same principle as a
             * degraded relation match: the alternative is a reader having to
             * take the extractor's word for it. Zero rows on a report whose
             * author knows they renamed something is the signal that the
             * extraction is what broke, and without this the panel's silence
             * would look identical to a report that has no renames.
             */
            fieldRenames: renameRows,
            /*
             * Every field parameter and every row it offers, plus the rows that
             * point at nothing.
             *
             * The two are separated because only one is a defect. A row naming a
             * field the model no longer has breaks the visual for whoever picks
             * it in the slicer, and it breaks it silently — the report opens
             * fine and fails on a click nobody made while testing. The listing
             * beside it is here for the same reason the renames are: so that
             * "this report has no parameters" and "we failed to read them" are
             * answerable apart.
             */
            fieldParameters: [...parametersByTable.values()].flatMap(p =>
                p.items.map(item => ({
                    parameter: p.name,
                    shownAs: item.caption,
                    reads: item.targetTable ? `${item.targetTable}[${item.targetName}]` : item.targetName,
                    kind: item.targetKind || 'not found',
                    order: item.order,
                }))),
            fieldParametersBroken: [...parametersByTable.values()].flatMap(p =>
                p.items.filter(item => !item.targetId).map(item => ({
                    parameter: p.name,
                    shownAs: item.caption,
                    reads: item.targetTable ? `${item.targetTable}[${item.targetName}]` : item.targetName,
                    reason: item.targetTable
                        ? 'No column or measure of this name on that table'
                        : 'No measure of this name in the model',
                }))),
        },
    };
}

/*
 * Does a "broken" reference actually exist, spelled differently?
 *
 * Power BI matches object names without regard to case, and report authors are
 * inconsistent: a textbox reading Metrics[Reporting Last Full Month] means the
 * measure declared as `Reporting last full month`. The engine compares ids
 * exactly, so those arrived as broken references — and a diagnostic that sends
 * someone hunting a bug that is not there costs more than it saves, because it
 * teaches the reader to skim past the real ones.
 *
 * Targets look like `measure:Metrics.Revenue` or `column:Customer.Group`.
 */
function resolvesIgnoringCase(ref, nodes) {
    const target = typeof ref?.target === 'string' ? ref.target : '';
    const colon = target.indexOf(':');
    const dot = target.indexOf('.', colon + 1);
    if (colon < 0 || dot < 0) return false;
    const kind = target.slice(0, colon);
    const table = lower(target.slice(colon + 1, dot));
    const field = lower(target.slice(dot + 1));

    if (kind === 'measure') {
        return Object.values(nodes).some(n => n.kind === 'measure'
            && lower(n.name) === field && lower(n.meta?.homeTable) === table);
    }
    if (kind === 'column') {
        return Object.values(nodes).some(n => n.kind === 'pbiTable'
            && lower(n.name) === table
            && (n.columns || []).some(c => lower(c.name) === field));
    }
    return false;
}

/** Dedupe key is per-build; `edges` carries its own Set so repeated builds stay clean. */
function pushEdge(edges, edge) {
    if (!edges._seen) Object.defineProperty(edges, '_seen', { value: new Set(), enumerable: false });
    const key = `${edge.source}|${edge.sourceColumn}|${edge.target}|${edge.kind}`;
    if (edges._seen.has(key)) return;
    edges._seen.add(key);
    edges.push({ ...edge, provenance: 'derived', matchLevel: 'pbi' });
}

module.exports = { buildPbiGraph, tableId, measureId, visualId };
