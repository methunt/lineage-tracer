/**
 * Join the dbt graph to the Power BI graph and compute impact.
 *
 * Precedence, per bridge/docs/ui-spec.md:
 *   1. Mapping file rows — the user's assertion, possibly across layers we
 *      cannot see. Emitted with provenance "declared".
 *   2. Automatic relation matching — resolved from M navigation. "derived".
 *
 * Impact is blast radius (exact, always shown) kept strictly separate from
 * breakage (proven only, never inferred). See section 6.
 */
const { relationKey, lower } = require('./mapping');
const { tableId } = require('./pbi-graph');

const IMPACT_BANDS = { high: 10, medium: 3, low: 1 };

// ── dbt relation index ───────────────────────────────────────────────────────

function buildDbtIndex(dbtGraph) {
    const byRelation = new Map();
    const bySchemaTable = new Map();
    const byTable = new Map();

    const push = (map, key, value) => {
        if (!key || key === '..') return;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(value);
    };

    for (const node of Object.values(dbtGraph.nodes)) {
        if (node.kind !== 'model' && node.kind !== 'source') continue;
        const { database, schema } = node.meta;
        const table = (node.meta.relation || '').split('.').pop() || node.name;
        const entry = {
            node,
            database,
            schema,
            table,
            columnLookup: new Map(node.columns.map(c => [lower(c.name), c.name])),
        };
        push(byRelation, relationKey(database, schema, table), entry);
        push(bySchemaTable, `${lower(schema)}.${lower(table)}`, entry);
        push(byTable, lower(table), entry);
    }
    return { byRelation, bySchemaTable, byTable };
}

/** Degrade database.schema.table -> schema.table -> table, reporting how far we fell. */
function resolveRelation(index, { database, schema, table }) {
    if (!table) return null;
    if (database && schema) {
        const hits = index.byRelation.get(relationKey(database, schema, table));
        if (hits?.length) return { entry: hits[0], matchLevel: 'database.schema.table', ambiguous: hits.length > 1 };
    }
    if (schema) {
        const hits = index.bySchemaTable.get(`${lower(schema)}.${lower(table)}`);
        if (hits?.length) return { entry: hits[0], matchLevel: 'schema.table', ambiguous: hits.length > 1 };
    }
    const hits = index.byTable.get(lower(table));
    if (hits?.length) return { entry: hits[0], matchLevel: 'table', ambiguous: hits.length > 1 };
    return null;
}

// ── Build ────────────────────────────────────────────────────────────────────

function buildGraph({ dbtGraph, pbiGraph, pbip, mapping, layerOrder }) {
    const nodes = { ...dbtGraph.nodes, ...pbiGraph.nodes };
    const edges = [...dbtGraph.edges, ...pbiGraph.edges];
    const diagnostics = {
        mappingErrors: [...(mapping.errors || [])],
        mappingWarnings: [...(mapping.warnings || [])],
        unresolvedMappingRows: [],
        ambiguousMatches: [],
        modelTablesWithoutSource: [],
        brokenRefs: (pbiGraph.stats.brokenRefs || []).map(normaliseBrokenRef),
        fieldRenames: [...(pbiGraph.stats.fieldRenames || [])],
        fieldParameters: [...(pbiGraph.stats.fieldParameters || [])],
        fieldParametersBroken: [...(pbiGraph.stats.fieldParametersBroken || [])],
        modelColumnsUnlinked: [],
        relationshipKeysUnlinked: [],
        multiSourceColumns: [],
        untestedHighImpact: [],
        dbtNodesNotUsed: [],
    };

    const index = buildDbtIndex(dbtGraph);
    const modelTables = new Map(
        Object.values(pbiGraph.nodes)
            .filter(n => n.kind === 'pbiTable')
            .map(n => [lower(n.name), n])
    );

    const crossEdges = new Map();
    const addCross = (edge) => {
        const key = `${edge.source}|${lower(edge.sourceColumn)}|${edge.target}|${lower(edge.targetColumn)}`;
        const existing = crossEdges.get(key);
        // A declared edge always beats a derived one: the user is asserting
        // something we could not see.
        if (existing && !(existing.provenance === 'derived' && edge.provenance === 'declared')) return;
        crossEdges.set(key, edge);
    };

    // ── Pass 1: mapping rows ────────────────────────────────────────────────
    const claimed = new Set();          // table names claimed by a table-level row
    const claimedColumns = new Set();   // "table|column" claimed by a column-level row
    for (const row of mapping.rows || []) {
        const resolved = resolveRelation(index, {
            database: row.fromDatabase, schema: row.fromSchema, table: row.fromTable,
        });
        if (!resolved) {
            diagnostics.unresolvedMappingRows.push({
                row: row._row,
                reason: `no dbt model builds ${row.fromDatabase}.${row.fromSchema}.${row.fromTable}`,
            });
            continue;
        }
        if (resolved.ambiguous) {
            diagnostics.ambiguousMatches.push({
                source: `mapping row ${row._row}`,
                relation: `${row.fromDatabase}.${row.fromSchema}.${row.fromTable}`,
                matchLevel: resolved.matchLevel,
            });
        }

        const target = modelTables.get(lower(row.toTable));
        if (!target) {
            diagnostics.unresolvedMappingRows.push({
                row: row._row, reason: `semantic model has no table named "${row.toTable}"`,
            });
            continue;
        }
        /*
         * A row claims what it names, and nothing more.
         *
         * This used to claim the whole table for any row, so one column-level
         * row switched off automatic matching for every other column of that
         * table. On a large production project, mapping a single column of one
         * wide table took it from dozens of automatic links to one — silently.
         * "The mapping sheet takes precedence" should mean the row wins where
         * it applies, not that it disables everything around it.
         *
         * A table-level row (both column cells blank) still claims the table,
         * because that is exactly what writing one means.
         */
        if (row.level === 'table') claimed.add(lower(target.name));
        else claimedColumns.add(`${lower(target.name)}|${lower(row.toColumn)}`);

        const pairs = row.level === 'column'
            ? [[resolved.entry.columnLookup.get(lower(row.fromColumn)), findColumn(target, row.toColumn)]]
            : [...resolved.entry.columnLookup.values()]
                .map(c => [c, findColumn(target, c)])
                .filter(([, m]) => m);

        if (!pairs.length || pairs.some(([a, b]) => !a || !b)) {
            diagnostics.unresolvedMappingRows.push({
                row: row._row,
                reason: row.level === 'column'
                    ? `column not found on one side (${row.fromColumn} -> ${row.toColumn})`
                    : `table-level row matched 0 columns by name between ${resolved.entry.node.name} and "${target.name}"`,
            });
            if (row.level === 'column') continue;
        }

        for (const [dbtColumn, modelColumn] of pairs) {
            if (!dbtColumn || !modelColumn) continue;
            addCross({
                source: resolved.entry.node.id,
                target: target.id,
                sourceColumn: dbtColumn,
                targetColumn: modelColumn,
                provenance: 'declared',
                matchLevel: 'mapping-row',
                mappingRow: row._row,
                kind: 'dbt_to_pbi',
            });
        }
    }

    // ── Pass 2: automatic relation matching ─────────────────────────────────
    for (const phys of pbip.physicalIndex) {
        if (claimed.has(lower(phys.modelTable))) continue;
        const resolved = resolveRelation(index, {
            database: phys.physicalDatabase, schema: phys.physicalSchema, table: phys.physicalTable,
        });
        if (!resolved) continue;
        if (resolved.ambiguous) {
            diagnostics.ambiguousMatches.push({
                source: `auto match for ${phys.modelTable}`,
                relation: [phys.physicalDatabase, phys.physicalSchema, phys.physicalTable].filter(Boolean).join('.'),
                matchLevel: resolved.matchLevel,
            });
        }
        const dbtColumn = resolved.entry.columnLookup.get(lower(phys.physicalColumn));
        const target = modelTables.get(lower(phys.modelTable));
        const modelColumn = target && findColumn(target, phys.modelColumn);
        if (!dbtColumn || !modelColumn) continue;
        // Declaring where a column comes from closes that column: adding a
        // second source automatically would contradict what the row says.
        if (claimedColumns.has(`${lower(target.name)}|${lower(modelColumn)}`)) continue;

        addCross({
            source: resolved.entry.node.id,
            target: target.id,
            sourceColumn: dbtColumn,
            targetColumn: modelColumn,
            provenance: 'derived',
            matchLevel: resolved.matchLevel,
            kind: 'dbt_to_pbi',
        });
    }

    const crossing = [...crossEdges.values()];
    edges.push(...crossing);

    // Mark linked columns on both sides so the UI can show a lineage dot.
    for (const edge of crossing) {
        markColumn(nodes[edge.source], edge.sourceColumn);
        markColumn(nodes[edge.target], edge.targetColumn);
    }

    markKeyFeeders(nodes, crossing);

    // ── Diagnostics ─────────────────────────────────────────────────────────
    for (const node of Object.values(pbiGraph.nodes)) {
        if (node.kind !== 'pbiTable') continue;
        if (!node.meta.physicalSource && !claimed.has(lower(node.name))) {
            diagnostics.modelTablesWithoutSource.push({
                table: node.name,
                reason: 'no physical source resolved from M — add a mapping row if this is a warehouse table',
            });
        }
        for (const column of node.columns) {
            if (column.isCalculated || column.hasLineage) continue;
            diagnostics.modelColumnsUnlinked.push({ table: node.name, column: column.name });

            /*
             * A join key with nothing behind it.
             *
             * Only for tables that *do* resolve to a warehouse relation: on one
             * whose source we never found, every column is unlinked and the
             * keys say nothing extra. Where the table is warehouse-backed and
             * the key still did not match, the column either was renamed, was
             * dropped, or never existed — and unlike a broken visual, a broken
             * join raises no error. The report keeps rendering with different
             * numbers.
             */
            if (node.meta.physicalSource && column.relationships?.length) {
                for (const rel of column.relationships) {
                    diagnostics.relationshipKeysUnlinked.push({
                        table: node.name,
                        column: column.name,
                        joins: `${rel.otherTable}[${rel.otherColumn}]`,
                        state: rel.active ? 'active' : 'inactive',
                        reason: 'join key with no dbt column behind it',
                    });
                }
            }
        }
    }
    /*
     * Columns the mapping file declares more than one source for.
     *
     * Legitimate — a column built from an `if` over two fields genuinely has
     * two sources, and both must keep working. It is also exactly what a typo
     * in "To Column" looks like. Info, not a warning: worth being able to see
     * on purpose rather than discovering by reading edges.
     */
    const declaredSources = new Map();
    for (const edge of crossing) {
        if (edge.provenance !== 'declared') continue;
        const key = `${edge.target}|${lower(edge.targetColumn)}`;
        if (!declaredSources.has(key)) declaredSources.set(key, []);
        declaredSources.get(key).push(edge);
    }
    for (const [, list] of declaredSources) {
        if (list.length < 2) continue;
        const first = list[0];
        diagnostics.multiSourceColumns.push({
            table: nodes[first.target]?.name || first.target,
            column: first.targetColumn,
            sources: list
                .map(e => `${nodes[e.source]?.name || e.source}[${e.sourceColumn}]`)
                .sort()
                .join(', '),
            rows: list.map(e => e.mappingRow).filter(Boolean).join(', '),
        });
    }

    /*
     * "Not consumed by this report" is a claim about the whole upstream, not
     * about the boundary.
     *
     * Only a handful of dbt models are named by a Power BI table directly —
     * the marts. Everything those are built from is just as consumed: drop the
     * staging model under a mart the report reads and the report breaks. The
     * check used to count the crossing nodes alone, so on a large production
     * project it called the overwhelming majority of nodes unused, which is not
     * a finding but a wall of text with the few genuinely dead models buried
     * in it.
     *
     * So walk upstream from every node that does cross, and let the closure be
     * the answer.
     */
    const upstream = new Map();
    for (const edge of dbtGraph.edges || []) {
        if (!upstream.has(edge.target)) upstream.set(edge.target, []);
        upstream.get(edge.target).push(edge.source);
    }
    const consumed = new Set();
    const queue = crossing.map(e => e.source);
    while (queue.length) {
        const id = queue.pop();
        if (!id || consumed.has(id)) continue;
        consumed.add(id);
        for (const parent of upstream.get(id) || []) queue.push(parent);
    }
    for (const node of Object.values(dbtGraph.nodes)) {
        if (node.kind === 'unknown' || consumed.has(node.id)) continue;
        diagnostics.dbtNodesNotUsed.push({ id: node.id, name: node.name, kind: node.kind, layer: node.layer });
    }

    const layers = orderLayers(nodes, layerOrder);
    const impact = computeImpact(nodes, edges);
    addRelationshipReach(nodes, edges, impact);

    /*
     * Untested where it matters. Every model is a candidate for a test and most
     * will never have one, so a bare "no tests" list is 150 rows of noise. Tied
     * to the blast radius already computed, it is a short list of the models
     * whose failure would be felt widest and which nothing is watching.
     */
    for (const node of Object.values(dbtGraph.nodes)) {
        if (node.kind === 'unknown') continue;
        if ((node.meta?.testCount || 0) > 0) continue;
        const band = impact.node[node.id]?.band;
        if (band !== 'high') continue;
        diagnostics.untestedHighImpact.push({
            id: node.id,
            name: node.name,
            layer: node.layer,
            visuals: impact.node[node.id]?.visuals?.length || 0,
        });
    }
    diagnostics.untestedHighImpact.sort((a, b) => b.visuals - a.visuals);

    return {
        nodes, edges, layers, impact, diagnostics,
        summary: summarise(nodes, crossing, diagnostics, impact),
    };
}

function findColumn(node, name) {
    const hit = node.columns.find(c => lower(c.name) === lower(name));
    return hit ? hit.name : null;
}

/**
 * Mark the columns that a join depends on but that no visual ever names.
 *
 * A key column is load-bearing and invisible: it appears in no chart, so the
 * impact walk reports zero visuals for it and the tool effectively says it is
 * safe to drop. It is not — dropping a key raises no error, it changes the
 * numbers.
 *
 * The mark travels exactly one *derivation* hop and no further. A column
 * computed in Power Query from two others makes both of those load-bearing, and
 * a dbt column linked to any of them is the same column one system earlier, so
 * crossing the warehouse boundary is transparent rather than a hop of its own.
 * Walking further up dbt's own lineage was considered and rejected: `order_id`
 * traces back through staging to source, and by the time it arrives almost
 * everything "feeds a key", which is the same failure as propagating impact
 * through joins.
 */
function markKeyFeeders(nodes, crossing) {
    const keyOf = new Map();   // "table|column" -> [{table, column, joins}]
    const note = (map, key, entry) => {
        if (!map.has(key)) map.set(key, []);
        if (!map.get(key).some(e => e.table === entry.table && e.column === entry.column)) {
            map.get(key).push(entry);
        }
    };

    for (const node of Object.values(nodes)) {
        if (node.kind !== 'pbiTable') continue;
        for (const column of node.columns || []) {
            if (!column.relationships?.length) continue;
            const describe = {
                table: node.name,
                column: column.name,
                joins: column.relationships
                    .map(r => `${r.otherTable}[${r.otherColumn}]`)
                    .join(', '),
            };
            // One derivation hop: whatever this key is computed from.
            for (const dep of column.dependsOn || []) {
                note(keyOf, `${lower(dep.table)}|${lower(dep.column)}`, describe);
            }
            note(keyOf, `${lower(node.name)}|${lower(column.name)}`, describe);
        }
    }

    // The Power BI side: a feeder that is not itself a key.
    for (const node of Object.values(nodes)) {
        if (node.kind !== 'pbiTable') continue;
        for (const column of node.columns || []) {
            if (column.relationships?.length) continue;
            const keys = keyOf.get(`${lower(node.name)}|${lower(column.name)}`);
            if (keys) column.keysFed = keys;
        }
    }

    // The dbt side: the same column, one system earlier.
    for (const edge of crossing) {
        const keys = keyOf.get(`${lower(nodes[edge.target]?.name)}|${lower(edge.targetColumn)}`);
        if (!keys) continue;
        const source = nodes[edge.source];
        const column = source?.columns?.find(c => lower(c.name) === lower(edge.sourceColumn));
        if (!column) continue;
        if (!column.keysFed) column.keysFed = [];
        for (const key of keys) {
            if (!column.keysFed.some(k => k.table === key.table && k.column === key.column)) {
                column.keysFed.push(key);
            }
        }
    }
}

/**
 * How many relationships in the semantic model this node's columns hold up.
 *
 * The impact sentence counts measures, visuals and pages — everything that
 * visibly stops working. A join is the dependency that does not: break the key
 * and every one of those visuals keeps rendering, with different numbers. So
 * the count belongs in the same sentence, and it was the one thing missing from
 * it.
 *
 * Counted at one derivation hop, the same rule `keysFed` already follows: a
 * relationship counts if this node holds the key or feeds the column that
 * becomes it. Not "every relationship on every downstream table" — in a star
 * schema anything reaching the fact table would report the entire model and the
 * number would mean nothing.
 *
 * Both sides of a relationship name the same join, so identity is the
 * endpoint pair, sorted. Inactive ones count: USERELATIONSHIP makes them real,
 * and they are named separately rather than dropped.
 */
function addRelationshipReach(nodes, edges, impact) {
    const endpoint = (table, column) => `${lower(table)}[${lower(column)}]`;
    const relId = (table, column, rel) =>
        [endpoint(table, column), endpoint(rel.otherTable, rel.otherColumn)].sort().join('~');

    // "table|column" -> the relationships that key carries.
    const keyRels = new Map();
    for (const node of Object.values(nodes)) {
        if (node.kind !== 'pbiTable') continue;
        for (const column of node.columns || []) {
            if (!column.relationships?.length) continue;
            keyRels.set(`${lower(node.name)}|${lower(column.name)}`, column.relationships.map(r => ({
                id: relId(node.name, column.name, r),
                active: r.active !== false,
            })));
        }
    }

    const tally = columns => {
        const seen = new Map();
        for (const column of columns) {
            const keys = [
                // A key held directly.
                ...(column.relationships?.length
                    ? [`${lower(column._ownerName)}|${lower(column.name)}`] : []),
                // …and every key this column feeds, here or one system earlier.
                ...(column.keysFed || []).map(k => `${lower(k.table)}|${lower(k.column)}`),
            ];
            for (const key of keys) {
                for (const rel of keyRels.get(key) || []) {
                    if (!seen.has(rel.id)) seen.set(rel.id, rel.active);
                }
            }
        }
        const total = seen.size;
        const inactive = [...seen.values()].filter(active => !active).length;
        return { relationships: total, relationshipsInactive: inactive };
    };

    for (const node of Object.values(nodes)) {
        // `relationships` lives on the column and names no owner, so the tally
        // is told which table it is reading.
        const owned = (node.columns || []).map(c => ({ ...c, _ownerName: node.name }));
        Object.assign(impact.node[node.id] || {}, tally(owned));
        for (const column of owned) {
            const entry = impact.column[`${node.id}|${column.name}`];
            if (entry) Object.assign(entry, tally([column]));
        }
    }

    /*
     * The same question, asked further upstream.
     *
     * A dbt source four hops from Power BI holds no key and feeds none directly,
     * so everything above stays silent on it — correct, and useless to someone
     * looking at the source. What they want to know is whether anything in this
     * table eventually becomes a join key.
     *
     * Two rules keep that from degenerating into "almost everything". It is
     * carried on column identity, not node identity: only edges naming a column
     * on both sides are followed, so it can never smear across a table. And it
     * is reported at column scope only — on a large production project most
     * dbt nodes reach a key somehow, which is a useless thing to print on a
     * table, while a given source table may have exactly one column in ten
     * that does.
     *
     * Counted by relationship, not by column or table, because that is the unit
     * that breaks: a source split into four models feeding four semantic tables
     * joined to four different dimensions is four.
     */
    const upstream = new Map();     // "nodeId|column" -> [predecessor keys]
    for (const edge of edges) {
        if (!edge.sourceColumn || !edge.targetColumn) continue;
        const key = `${edge.target}|${lower(edge.targetColumn)}`;
        if (!upstream.has(key)) upstream.set(key, []);
        upstream.get(key).push(`${edge.source}|${lower(edge.sourceColumn)}`);
    }

    // Seeded from every key, walked backwards once per key rather than forwards
    // once per column: there are a few dozen keys and thousands of columns.
    const reach = new Map();        // "nodeId|column" -> Set of relationship ids
    for (const node of Object.values(nodes)) {
        if (node.kind !== 'pbiTable') continue;
        for (const column of node.columns || []) {
            const rels = keyRels.get(`${lower(node.name)}|${lower(column.name)}`);
            if (!rels?.length) continue;
            const seen = new Set();
            const stack = [`${node.id}|${lower(column.name)}`];
            while (stack.length) {
                const at = stack.pop();
                if (seen.has(at)) continue;
                seen.add(at);
                if (!reach.has(at)) reach.set(at, new Map());
                for (const rel of rels) reach.get(at).set(rel.id, rel.active);
                for (const prev of upstream.get(at) || []) stack.push(prev);
            }
        }
    }

    const apply = (entry, found) => {
        if (!entry || !found?.size) return;
        // Only where the direct count says nothing: something that holds a key
        // already reports it, and two counts for one idea reads as two findings.
        if (entry.relationships > 0) return;
        entry.relationshipsDownstream = found.size;
        entry.relationshipsDownstreamInactive =
            [...found.values()].filter(active => !active).length;
    };

    for (const node of Object.values(nodes)) {
        // The table is the union of its columns, counted by relationship and
        // not by column: a source split across four models feeding four
        // semantic tables joined to four dimensions is four, however many
        // columns carried it there.
        const union = new Map();
        for (const column of node.columns || []) {
            const found = reach.get(`${node.id}|${lower(column.name)}`);
            if (!found) continue;
            for (const [id, active] of found) union.set(id, active);
            apply(impact.column[`${node.id}|${column.name}`], found);
        }
        apply(impact.node[node.id], union);
    }

    /*
     * A floor on the band, not a promotion.
     *
     * The band is computed from downstream visual count, and a join key appears
     * in no visual — so a column whose only consequence is that every number
     * moves lands in `none`, which reads as "safe to drop". On a large
     * production project that is a few hundred columns holding or reaching a
     * join with zero visuals behind them.
     *
     * A minimum, so it can never lower a band: a column already high on visuals
     * stays high whatever its joins. And two heights, because the two facts are
     * not the same risk — holding a key means the join breaks the moment you
     * touch it, reaching one means several hops of insulation. Lifting both to
     * high would put nearly twice as many columns in the band as earn it on
     * visuals, and a band that is mostly "high" stops being read.
     *
     * A count threshold was measured first and rejected: >4 relationships moves
     * no nodes and a handful of columns, because anything with that many joins is
     * already high on visuals. Magnitude is in the sentence; the band answers
     * how carefully to tread.
     */
    const RANK = { none: 0, low: 1, medium: 2, high: 3 };
    const floor = entry => {
        if (!entry) return;
        const wanted = entry.relationships > 0 ? 'medium'
            : entry.relationshipsDownstream > 0 ? 'low'
                : null;
        if (!wanted || RANK[entry.band] >= RANK[wanted]) return;
        entry.bandRaisedFrom = entry.band;
        entry.bandReason = entry.relationships > 0
            ? `holds ${entry.relationships === 1 ? 'a join key' : `${entry.relationships} join keys`}`
            : 'feeds a join key downstream';
        entry.band = wanted;
    };
    for (const entry of Object.values(impact.node)) floor(entry);
    for (const entry of Object.values(impact.column)) floor(entry);
}

function markColumn(node, name) {
    if (!node || !name) return;
    const col = node.columns.find(c => lower(c.name) === lower(name));
    if (col) col.hasLineage = true;
}

/**
 * The upstream engine records a broken reference as `{visual, target, type}`,
 * where `target` is the node id it could not resolve — `measure:Metrics.Revenue`,
 * `column:Customer.Group Customer`. Reading `ref.field` / `ref.table` /
 * `ref.column` instead meant every row fell through to the empty template and
 * printed a bare `[]`: 150 rows that named nothing. The ids carry both halves,
 * so split them rather than inventing a shape the producer never emits.
 */
function normaliseBrokenRef(ref) {
    const parsed = parseFieldId(ref.target);
    const table = ref.table ?? parsed.table;
    const field = ref.column ?? ref.measure ?? parsed.field;

    return {
        visual: stripId(ref.visual || ref.visualName),
        page: ref.page || ref.pageName || pageOfVisualId(ref.visual) || null,
        field: ref.field || (table ? `${table}[${field}]` : field) || null,
        kind: parsed.kind,
        reason: ref.reason ||
            `the ${parsed.kind || 'field'} does not exist in the semantic model`,
    };
}

/** `measure:Metrics.Revenue` -> {kind:'measure', table:'Metrics', field:'Revenue'}. */
function parseFieldId(id) {
    if (typeof id !== 'string') return { kind: null, table: null, field: null };
    const colon = id.indexOf(':');
    const kind = colon === -1 ? null : id.slice(0, colon);
    const rest = colon === -1 ? id : id.slice(colon + 1);
    // Table names contain dots far less often than field names do, and the
    // producer joins them with the last one.
    const dot = rest.lastIndexOf('.');
    return dot === -1
        ? { kind, table: null, field: rest || null }
        : { kind, table: rest.slice(0, dot), field: rest.slice(dot + 1) };
}

/** `visual:Page Name|Visual Name` -> `Visual Name`. */
function stripId(id) {
    if (typeof id !== 'string') return id || null;
    const rest = id.startsWith('visual:') ? id.slice('visual:'.length) : id;
    const bar = rest.indexOf('|');
    return bar === -1 ? rest : rest.slice(bar + 1);
}

/** The same id carries the page before the bar. */
function pageOfVisualId(id) {
    if (typeof id !== 'string' || !id.startsWith('visual:')) return null;
    const rest = id.slice('visual:'.length);
    const bar = rest.indexOf('|');
    return bar === -1 ? null : rest.slice(0, bar);
}

// ── Layers ───────────────────────────────────────────────────────────────────

function orderLayers(nodes, configured) {
    const present = new Set(Object.values(nodes).map(n => n.layer).filter(Boolean));
    const ordered = [];
    const take = name => { if (present.has(name)) { ordered.push(name); present.delete(name); } };

    take('sources');
    for (const layer of configured || []) take(layer);
    // Anything undeclared keeps a stable position rather than a random one.
    for (const layer of [...present].sort()) if (layer !== 'powerbi') ordered.push(layer);
    if (present.has('powerbi') || ordered.includes('powerbi') === false) {
        const i = ordered.indexOf('powerbi');
        if (i !== -1) ordered.splice(i, 1);
        ordered.push('powerbi');
    }
    return ordered;
}

// ── Impact ───────────────────────────────────────────────────────────────────

/**
 * Downstream reach per node and per column.
 *
 * Blast radius only — exact traversal of the merged graph. Breakage lives in
 * diagnostics.brokenRefs and is never mixed in here.
 */
function computeImpact(nodes, edges) {
    const out = new Map();     // nodeId -> [{edge}]
    for (const edge of edges) {
        if (!out.has(edge.source)) out.set(edge.source, []);
        out.get(edge.source).push(edge);
    }

    const nodeImpact = {};
    const columnImpact = {};

    const walk = (startId, startColumn) => {
        const seen = new Set();
        const reached = {
            measures: new Set(), visuals: new Set(), tables: new Set(),
            models: new Set(), pages: new Set(),
        };
        // Column identity is only meaningful while edges carry it; once we hit a
        // measure or visual the column is consumed and everything downstream counts.
        //
        // Not every edge names a column, and following an unnamed one widens the
        // answer from "this column" to "this table". That is still a real
        // dependency and it stays in the count — a reader asking "what breaks"
        // is not helped by dropping it — but the subset that is column-precise
        // is counted separately, so the panel can say how much of the number it
        // can actually stand behind.
        const exactVisuals = new Set();
        const queue = [[startId, startColumn, true]];

        while (queue.length) {
            const [id, column, exact] = queue.shift();
            const key = `${id}|${column ?? ''}|${exact ? 1 : 0}`;
            if (seen.has(key)) continue;
            seen.add(key);

            for (const edge of out.get(id) || []) {
                // Containment, not lineage: following a page to its visuals
                // would make every visual on a page count as affected because
                // one of them is. See pbi-graph.js.
                if (edge.kind === 'page_to_visual') continue;
                if (column && edge.sourceColumn && lower(edge.sourceColumn) !== lower(column)) continue;
                const next = nodes[edge.target];
                if (!next) continue;

                const stillExact = exact && (!startColumn || !column || Boolean(edge.sourceColumn));

                if (next.kind === 'page') reached.pages.add(next.id);
                else if (next.kind === 'measure') reached.measures.add(next.id);
                else if (next.kind === 'visual') {
                    reached.visuals.add(next.id);
                    if (stillExact) exactVisuals.add(next.id);
                } else if (next.kind === 'pbiTable') reached.tables.add(next.id);
                else if (next.kind === 'model') reached.models.add(next.id);

                const nextColumn = edge.targetColumn || null;
                queue.push([
                    next.id,
                    next.kind === 'measure' || next.kind === 'visual' ? null : nextColumn,
                    stillExact,
                ]);
            }
        }
        return {
            measures: [...reached.measures],
            visuals: [...reached.visuals],
            tables: [...reached.tables],
            models: [...reached.models],
            pages: [...reached.pages],
            // Column traces only: for a table there is nothing to be exact about.
            visualsExact: startColumn ? exactVisuals.size : reached.visuals.size,
            band: band(reached.visuals.size),
        };
    };

    for (const node of Object.values(nodes)) {
        nodeImpact[node.id] = walk(node.id, null);
        for (const column of node.columns || []) {
            columnImpact[`${node.id}|${column.name}`] = walk(node.id, column.name);
        }
    }
    return { node: nodeImpact, column: columnImpact, bands: IMPACT_BANDS };
}

function band(visualCount) {
    if (visualCount >= IMPACT_BANDS.high) return 'high';
    if (visualCount >= IMPACT_BANDS.medium) return 'medium';
    if (visualCount >= IMPACT_BANDS.low) return 'low';
    return 'none';
}

function summarise(nodes, crossing, diagnostics, impact) {
    const all = Object.values(nodes);
    const count = kind => all.filter(n => n.kind === kind).length;
    const pbiTables = all.filter(n => n.kind === 'pbiTable');
    const modelColumns = pbiTables.reduce((n, t) => n + t.columns.length, 0);
    const linkedColumns = pbiTables.reduce((n, t) => n + t.columns.filter(c => c.hasLineage).length, 0);
    const visualsReached = new Set(crossing.flatMap(e => impact.node[e.source]?.visuals || []));

    return {
        crossLinks: crossing.length,
        linksDeclared: crossing.filter(e => e.provenance === 'declared').length,
        linksDerived: crossing.filter(e => e.provenance === 'derived').length,
        dbtNodes: count('model') + count('source'),
        dbtNodesLinked: new Set(crossing.map(e => e.source)).size,
        pbiTables: pbiTables.length,
        pbiTablesLinked: new Set(crossing.map(e => e.target)).size,
        modelColumns,
        modelColumnsLinked: linkedColumns,
        measures: count('measure'),
        pages: count('page'),
        visuals: count('visual'),
        visualsReached: visualsReached.size,
        // Kept in step with the Diagnostics tab, which counts its error and
        // warning sections and nothing else. Two numbers that disagree read as
        // a bug in the tool rather than as two different questions.
        // untestedHighImpact is deliberately absent: it is context, since not
        // every model needs a test, and 38 rows of it would swamp the things
        // that are genuinely wrong.
        issues:
            diagnostics.mappingErrors.length +
            diagnostics.unresolvedMappingRows.length +
            diagnostics.modelTablesWithoutSource.length +
            diagnostics.brokenRefs.length +
            diagnostics.relationshipKeysUnlinked.length +
            // A parameter row naming a field that is gone breaks the visual for
            // whoever picks it, and breaks it on a click nobody made while
            // testing. The listing beside it is context and is not counted.
            diagnostics.fieldParametersBroken.length,
    };
}

module.exports = { buildGraph, buildDbtIndex, resolveRelation, IMPACT_BANDS };
