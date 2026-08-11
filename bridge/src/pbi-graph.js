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
    const aliasIndex = new Map();          // "type|table|field" -> Map(alias -> sites[])
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
                if (!byAlias.has(alias)) byAlias.set(alias, []);
                byAlias.get(alias).push({
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

    /** The alias list for one field, in the shape the panel renders. */
    const aliasesFor = (type, table, name) => {
        const byAlias = aliasIndex.get(`${type}|${lower(table)}|${lower(name)}`);
        if (!byAlias) return [];
        return [...byAlias.entries()].map(([alias, visuals]) => ({ name: alias, visuals }));
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
