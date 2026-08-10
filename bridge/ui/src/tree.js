/**
 * The two navigation trees, plus the lane ordering they share.
 *
 * Both trees are pure views over the node set — nothing here writes to
 * node.meta, and neither tree owns any state beyond what the store holds.
 */

const PBI_CHILDREN = [
    { kind: 'pbiTable', label: 'Tables' },
    { kind: 'page', label: 'Pages' },
    { kind: 'measure', label: 'Measures' },
    { kind: 'visual', label: 'Visuals' },
];

/**
 * Left-to-right lane order, derived rather than declared.
 *
 * A project may use any folder names at all (bronze/silver/gold, raw/clean/…),
 * so the order cannot be a constant. dbt edges already encode the dependency:
 * if any node in layer A feeds a node in layer B, A belongs left of B. That is
 * a topological sort over layers, with alphabetical order breaking ties so the
 * result is stable, and Power BI pinned last because it is always the sink.
 *
 * Real projects are not acyclic at layer granularity — a handful of models
 * import from a later stage, which is fine for dbt (the node graph is still a
 * DAG) and fatal for a naive sort. So edges are weighted by how many node
 * edges they represent, and when the sort deadlocks the layer with the least
 * incoming weight is forced out next. On this project that keeps the 327-edge
 * staging→warehouse flow intact and sacrifices the 4-edge back-reference,
 * rather than exiling warehouse to the far right.
 */
export function deriveLayerOrder(nodes, edges) {
    const layers = [...new Set(Object.values(nodes).map(n => n.layer))].filter(Boolean);
    const dbt = layers.filter(l => l !== 'powerbi').sort();

    const after = new Map(dbt.map(l => [l, new Map()]));   // layer -> {next: weight}
    for (const edge of edges) {
        const from = nodes[edge.source]?.layer;
        const to = nodes[edge.target]?.layer;
        if (!from || !to || from === to) continue;
        if (!after.has(from) || !after.has(to)) continue;
        after.get(from).set(to, (after.get(from).get(to) || 0) + 1);
    }

    const incoming = layer => {
        let total = 0;
        for (const [from, nexts] of after) {
            if (remaining.has(from) && nexts.has(layer)) total += nexts.get(layer);
        }
        return total;
    };

    const remaining = new Set(dbt);
    const order = [];
    while (remaining.size) {
        const free = [...remaining].filter(l => incoming(l) === 0).sort();
        // Deadlock: every remaining layer is fed by another. Break the weakest
        // dependency, preferring alphabetical order among equal weights.
        const next = free.length
            ? free[0]
            : [...remaining].sort((a, b) => incoming(a) - incoming(b) || a.localeCompare(b))[0];
        remaining.delete(next);
        order.push(next);
    }

    if (layers.includes('powerbi')) order.push('powerbi');
    return order;
}

/**
 * Resource tree: dbt grouped the way dbt itself is grouped.
 *
 * The old tree listed layers at the top, which put `sources` on the same footing
 * as `staging` even though one is a resource type and the other is a folder.
 * dbt's own shape is resource type first — models, sources, snapshots, seeds,
 * exposures, analyses — with layers as subdivisions of models only. A source's
 * layer is always `sources`, so nesting it under itself said nothing.
 *
 * Resource types the project declares but that carry no column lineage still
 * get a row, greyed, with their manifest count. Analyses are the usual case:
 * seven of them exist and none appear in the lineage graph, and a tree that
 * silently omits them is indistinguishable from one that lost them.
 */
const RESOURCE_ORDER = ['model', 'source', 'snapshot', 'seed', 'exposure', 'analysis', 'test'];

const RESOURCE_LABEL = {
    model: 'models', source: 'sources', snapshot: 'snapshots', seed: 'seeds',
    exposure: 'exposures', analysis: 'analyses', test: 'tests', unknown: 'unresolved',
};

export function resourceTree(nodes, layerOrder, declared = {}, declaredNames = {}) {
    const counts = new Map();          // resourceType -> node count
    const byResource = new Map();      // resourceType -> nodes
    const modelLayers = new Map();     // layer -> model nodes
    const pbi = [];

    for (const node of Object.values(nodes)) {
        if (node.origin === 'pbi') { pbi.push(node); continue; }

        const resource = node.kind === 'unknown'
            ? 'unknown'
            : (node.meta?.resourceType || 'model');
        counts.set(resource, (counts.get(resource) || 0) + 1);
        if (!byResource.has(resource)) byResource.set(resource, []);
        byResource.get(resource).push(node);
        if (resource === 'model' && node.layer) {
            if (!modelLayers.has(node.layer)) modelLayers.set(node.layer, []);
            modelLayers.get(node.layer).push(node);
        }
    }

    // Everything present, plus everything the manifest declared, in a stable
    // order with unrecognised types appended rather than dropped.
    const seen = [...new Set([
        ...RESOURCE_ORDER,
        ...counts.keys(),
        ...Object.keys(declared),
    ])].filter(r => counts.has(r) || declared[r]);

    const order = seen.sort((a, b) => {
        const ia = RESOURCE_ORDER.indexOf(a);
        const ib = RESOURCE_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });

    const groups = order.map(resource => {
        const count = counts.get(resource) || 0;
        const own = byResource.get(resource) || [];
        return {
            key: resource,
            resource,
            label: RESOURCE_LABEL[resource] || `${resource}s`,
            count: count || declared[resource] || 0,
            // No lineage to show — the row exists to say the resource exists.
            empty: count === 0,
            note: count === 0 ? 'declared in the manifest, no column lineage' : null,
            // Models subdivide by layer; everything else opens straight to its
            // tables, because a second folder holding one thing is a click that
            // buys nothing.
            children: childrenFor(resource, layerOrder, modelLayers, own),
            nodes: resource === 'model' || resource === 'source' ? [] : sortByName(own),
            // Declared in the manifest but absent from the lineage graph: the
            // names are all we have, and they are worth showing.
            ghosts: count === 0 ? (declaredNames[resource] || []) : [],
        };
    });

    if (pbi.length) {
        groups.push({
            key: 'powerbi',
            label: 'Power BI',
            count: pbi.length,
            empty: false,
            nodes: [],
            children: PBI_CHILDREN.map(c => {
                const list = pbi.filter(n => n.kind === c.kind);
                return { ...c, key: `kind:${c.kind}`, count: list.length, nodes: sortByName(list) };
            }),
        });
    }

    return groups;
}

const sortByName = list => [...list].sort((a, b) => a.name.localeCompare(b.name));

/**
 * Models subdivide by layer, sources by the dbt source they belong to. Both are
 * how the project itself is organised — a flat list of dozens of sources
 * spanning several datasets is a list, not a tree.
 */
function childrenFor(resource, layerOrder, modelLayers, own) {
    if (resource === 'model') return folderTree(layerOrder, modelLayers);
    if (resource === 'source') {
        const bySource = new Map();
        for (const node of own) {
            const name = node.meta?.sourceName || node.meta?.schema || 'ungrouped';
            if (!bySource.has(name)) bySource.set(name, []);
            bySource.get(name).push(node);
        }
        return [...bySource.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([name, list]) => ({
                key: `source:${name}`,
                sourceName: name,
                label: name,
                title: list[0]?.meta?.relation || name,
                count: list.length,
                nodes: sortByName(list),
            }));
    }
    return [];
}

/**
 * Model folders, nested to whatever depth the project uses.
 *
 * A layer is the full path (`staging/crm/base`), so the tree is rebuilt from the
 * segments. Every folder carries `layer` — the path down to it, which is also a
 * real layer if models sit directly in it — and `descendants`, every layer at
 * or below it. The eye acts on the whole subtree: hiding `staging` while
 * `staging/crm` stays on canvas is the same class of bug as the sources/models
 * name collision, where a control appeared to do nothing.
 *
 * `count` is the subtree total, not the folder's own files. A folder reading 6
 * that opens onto 4 rows and two subfolders is arithmetic the reader has to do;
 * the number they want is how much is in there.
 *
 * Single-child chains collapse into one row labelled `a/b/c`, as file trees do,
 * so a four-deep path to one model is one click rather than four. It changes
 * the label only — the eye still governs the whole subtree.
 */
function folderTree(layerOrder, modelLayers) {
    const rank = new Map(layerOrder.map((l, i) => [l, i]));
    const root = { children: new Map() };

    for (const layer of modelLayers.keys()) {
        let at = root;
        const parts = layer.split('/');
        for (let i = 0; i < parts.length; i++) {
            const path = parts.slice(0, i + 1).join('/');
            if (!at.children.has(parts[i])) {
                at.children.set(parts[i], { name: parts[i], layer: path, children: new Map() });
            }
            at = at.children.get(parts[i]);
        }
        at.nodes = sortByName(modelLayers.get(layer));
    }

    const build = (folder, label) => {
        // Collapse a folder that holds nothing but one subfolder.
        if (!folder.nodes?.length && folder.children.size === 1) {
            const only = [...folder.children.values()][0];
            return build(only, `${label}/${only.name}`);
        }
        const children = [...folder.children.values()]
            .map(child => build(child, child.name))
            .sort((a, b) =>
                (rank.get(a.layer) ?? 99) - (rank.get(b.layer) ?? 99) ||
                a.label.localeCompare(b.label));
        const own = folder.nodes || [];
        return {
            key: `layer:${folder.layer}`,
            layer: folder.layer,
            label,
            count: own.length + children.reduce((n, c) => n + c.count, 0),
            nodes: own,
            children,
            descendants: [
                ...(own.length ? [folder.layer] : []),
                ...children.flatMap(c => c.descendants),
            ],
        };
    };

    return [...root.children.values()]
        .map(child => build(child, child.name))
        .sort((a, b) =>
            (rank.get(a.layer) ?? 99) - (rank.get(b.layer) ?? 99) ||
            a.label.localeCompare(b.label));
}

/**
 * Database tree: database -> schema -> node, read off metadata dbt already
 * carries. Power BI nodes have no relation, so they group under a synthetic
 * root keyed off the semantic model name. The fallback lives here, in the
 * grouper — node.meta is never written to, so the graph, the impact walk and
 * the export stay unaware of it. If a Power BI table ever does carry a real
 * database (a DirectQuery table would), it lands in that database instead and
 * the synthetic root simply gets smaller.
 */
export function databaseTree(nodes, modelName) {
    const SYNTHETIC = `Power BI — ${modelName || 'semantic model'}`;
    const databases = new Map();

    for (const node of Object.values(nodes)) {
        if (node.kind === 'measure' || node.kind === 'visual' || node.kind === 'page') continue;
        const db = node.meta?.database ?? SYNTHETIC;
        const schema = node.meta?.schema ?? 'Tables';

        if (!databases.has(db)) {
            databases.set(db, { name: db, synthetic: db === SYNTHETIC, count: 0, schemas: new Map() });
        }
        const entry = databases.get(db);
        entry.count++;
        if (!entry.schemas.has(schema)) entry.schemas.set(schema, { name: schema, tables: [] });
        entry.schemas.get(schema).tables.push(node);
    }

    const out = [...databases.values()].map(db => ({
        ...db,
        schemas: [...db.schemas.values()]
            .map(s => ({ ...s, tables: s.tables.sort((a, b) => a.name.localeCompare(b.name)) }))
            .sort((a, b) => a.name.localeCompare(b.name)),
    }));

    // Real databases first, alphabetically; the synthetic Power BI root last.
    return out.sort((a, b) =>
        (a.synthetic - b.synthetic) || a.name.localeCompare(b.name));
}

/** Depth-limited walk used by both the stepper and the per-node handles. */
export function walk(startId, direction, hops, adj, nodes) {
    const map = direction === 'up' ? adj.inn : adj.out;
    const pick = direction === 'up' ? e => e.source : e => e.target;

    const found = new Set();
    let frontier = [startId];
    const seen = new Set([startId]);

    for (let hop = 0; hop < hops && frontier.length; hop++) {
        const next = [];
        for (const id of frontier) {
            for (const edge of map.get(id) || []) {
                const neighbour = pick(edge);
                if (seen.has(neighbour) || !nodes[neighbour]) continue;
                seen.add(neighbour);
                found.add(neighbour);
                next.push(neighbour);
            }
        }
        frontier = next;
    }
    return found;
}

export { PBI_CHILDREN };
