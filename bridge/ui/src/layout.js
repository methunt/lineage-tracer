import ELK from 'elkjs/lib/elk.bundled.js';

/*
 * `elk.bundled.js` (as opposed to `elk-api.js`) is elkjs's browser build that
 * offloads the actual solve to a Web Worker of its own internally, spun up
 * from a blob: URL it bundles the worker code into — `new ELK()` with no
 * options is elkjs's own documented "just works, off the main thread" mode.
 *
 * That only works, though, if the browser is actually allowed to construct a
 * blob: worker. Before `worker-src` in this app's CSP allowed `blob:`, elkjs's
 * attempt to spin one up failed and it silently fell back to running the
 * whole solve inline — which is what made a large graph's solve a multi-ten-
 * second freeze of the entire tab rather than a background wait: not elkjs
 * being slow off-thread, but elkjs quietly never getting off the main thread
 * at all. See vite.config.js for the CSP side of this fix.
 */
const elk = new ELK();

// Sizes follow docs/design-system.md §2: a 12px type floor makes the card
// taller and wider, and roughly a quarter fewer nodes fit per screen. That is
// the deliberate trade for a canvas readable without zooming.
const HEADER_H = 64;
const HOP_H = 37;         // the upstream/downstream handle strip
const ROW_H = 24;
const WIDTH = 248;
// Tightened from 104/20: on a graph with many columns the old gap added up
// to a large fraction of total scroll width for no legibility gain — a
// bezier edge and its arrowhead read fine well below 104px of clearance.
const LANE_GAP = 56;      // horizontal space between lanes
const NODE_GAP = 14;      // vertical space between nodes in a lane

export function nodeHeight(node, expanded) {
    const hops = node._hops ? HOP_H : 0;
    if (!expanded || !node.columns?.length) return HEADER_H + hops;
    // Long column lists scroll inside the node rather than making it enormous.
    return HEADER_H + Math.min(node.columns.length, 14) * ROW_H + 8 + hops;
}

/**
 * Left-to-right DAG, columns chosen by ELK itself.
 *
 * ELK's layered algorithm decides both axes: which column a node falls into
 * (by longest path from a source, respecting every edge's direction) and,
 * within a column, the order that minimises edge crossings. Forcing nodes
 * into columns keyed by dbt folder or Power BI object kind — the previous
 * design — discarded ELK's column choice and reapplied its crossing-minimised
 * ordering to a completely different layout than the one ELK optimised
 * against, which is what produced long tangled edges on any project where
 * folder depth does not track dependency depth (a staging model feeding a
 * mart directly, skipping the folders in between). Letting ELK's own columns
 * stand fixes that: an edge only crosses the columns its endpoints are
 * actually that many hops apart.
 *
 * A node with no edges at all has nothing to anchor its column to and lands
 * in the leftmost one, ELK's own (deterministic, not random) default.
 *
 * Split in two on purpose:
 *
 *   elkOrder()  — expensive, async, depends only on the node and edge *sets*
 *   place()     — cheap, synchronous, depends on which nodes are expanded
 *
 * Expanding a node's columns changes only its height, and heights are consumed
 * entirely by place(). Re-solving the whole graph for that was the source of
 * the canvas lag: a single click re-ran ELK over every visible node.
 */
export async function elkOrder(nodes, edges) {
    if (!nodes.length) return { x: new Map(), y: new Map() };

    // Collapsed heights throughout: only the *relative* order ELK produces is
    // kept, and place() overrides every y anyway. Using a fixed height also
    // makes this result cacheable across expand/collapse.
    const graph = {
        id: 'root',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.layered.spacing.nodeNodeBetweenLayers': String(LANE_GAP),
            'elk.spacing.nodeNode': String(NODE_GAP),
            /*
             * ELK's default packs each disconnected component (a cluster with
             * no edge to the rest of the graph — not just the single-node case
             * `ISOLATED_COLUMN` below already handles) using its own
             * space-filling placement, which can spread components far apart
             * on whichever axis makes the overall bounding box more square —
             * on a real graph this showed up as two small clusters placed at
             * opposite ends of an otherwise empty canvas. Turning it off makes
             * ELK lay out every component in the same coordinate system,
             * governed by the same edge-driven layering as everything else.
             */
            'elk.separateConnectedComponents': 'false',
            /*
             * NETWORK_SIMPLEX computes marginally tighter coordinates than
             * BRANDES_KOEPF; place() re-stacks every column regardless, so the
             * y it produces is thrown away same as before. Crossing
             * minimisation is a separate phase, so the ordering we actually
             * consume is unchanged by dropping to BRANDES_KOEPF. Measured on a
             * large production project — a couple of hundred nodes, ~1,600
             * edges — the layout went from roughly 4s to half a second.
             *
             * The x this run produces, unlike before, IS read now — it is
             * ELK's column assignment, kept via elk.layered.layering.strategy
             * left at its default (longest-path from sources).
             *
             * Spline routes are likewise never read — React Flow draws its own
             * bezier edges from the node positions.
             */
            'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
            'elk.edgeRouting': 'ORTHOGONAL',
        },
        children: nodes.map(node => ({
            id: node.id,
            width: WIDTH,
            height: nodeHeight(node, false),
        })),
        edges: edges.map((edge, i) => ({ id: `e${i}`, sources: [edge.source], targets: [edge.target] })),
    };

    const result = await elk.layout(graph);

    const elkY = new Map();
    const elkX = new Map();
    for (const child of result.children || []) {
        elkY.set(child.id, child.y ?? 0);
        elkX.set(child.id, child.x ?? 0);
    }
    return { x: elkX, y: elkY };
}

/**
 * Group ELK's raw x coordinates into discrete columns.
 *
 * ELK assigns every node in the same layer the same x (all nodes share one
 * width here), but floating-point noise between runs makes exact equality
 * unsafe — so nearby values are clustered instead of compared directly.
 */
function columnsFromElkX(elkX) {
    const xs = [...new Set([...elkX.values()])].sort((a, b) => a - b);
    const columns = new Map(); // rounded x -> column index
    let index = -1;
    let last = -Infinity;
    for (const x of xs) {
        if (x - last > WIDTH / 2) index += 1;
        columns.set(x, index);
        last = x;
    }
    return columns;
}

// The column every edge-less node shares, regardless of what ELK's x says
// for it. ELK has nothing to anchor a disconnected node's column to — a
// model with no upstream dbt parent at all (e.g. one that only reads an
// external file) is its own trivial single-node component, and on a graph
// with many such nodes ELK spread each into its own column across the
// graph's full width instead of grouping them. -1 sorts before every real
// ELK column (which start at 0), so this reads as "before everything else"
// rather than splicing into a column real edges anchor.
const ISOLATED_COLUMN = -1;

/**
 * Turn an ELK ordering into positions. Pure arithmetic — safe to run on every
 * expand, every frame if it came to that.
 */
export function place(nodes, edges, order, expanded) {
    if (!nodes.length) return new Map();
    const { x: elkX, y: elkY } = order;

    const connected = new Set();
    for (const edge of edges) { connected.add(edge.source); connected.add(edge.target); }

    const columnOf = columnsFromElkX(elkX);
    const columnIndex = node => (connected.has(node.id)
        ? columnOf.get(elkX.get(node.id) ?? 0) ?? 0
        : ISOLATED_COLUMN);

    const byColumn = new Map();
    for (const node of nodes) {
        const c = columnIndex(node);
        if (!byColumn.has(c)) byColumn.set(c, []);
        byColumn.get(c).push(node);
    }
    const columns = [...byColumn.keys()].sort((a, b) => a - b);

    // Within a column, keep ELK's relative order but re-stack to remove
    // overlap — except the isolated column, which ELK never ordered at all:
    // alphabetical there is at least predictable, and grouping every one of
    // dozens of unrelated leaf models by original folder would just recreate
    // a smaller version of the folder-lane problem this layout replaced.
    const positions = new Map();
    for (const c of columns) {
        const inColumn = c === ISOLATED_COLUMN
            ? byColumn.get(c).sort((a, b) => a.name.localeCompare(b.name))
            : byColumn.get(c).sort((a, b) => (elkY.get(a.id) ?? 0) - (elkY.get(b.id) ?? 0));

        let y = 0;
        for (const node of inColumn) {
            positions.set(node.id, { x: c * (WIDTH + LANE_GAP), y });
            y += nodeHeight(node, expanded.has(node.id)) + NODE_GAP;
        }
    }

    // Centre each column vertically so short columns sit against the tall
    // ones rather than all hugging the top.
    const heights = new Map();
    for (const c of columns) {
        const last = byColumn.get(c).reduce((max, n) => {
            const p = positions.get(n.id);
            return Math.max(max, p.y + nodeHeight(n, expanded.has(n.id)));
        }, 0);
        heights.set(c, last);
    }
    const tallest = Math.max(...heights.values(), 0);
    for (const c of columns) {
        const offset = (tallest - heights.get(c)) / 2;
        if (offset <= 0) continue;
        for (const node of byColumn.get(c)) {
            const p = positions.get(node.id);
            positions.set(node.id, { x: p.x, y: p.y + offset });
        }
    }

    return positions;
}

/** Both halves, for callers that have no ordering cached. */
export async function layout(nodes, edges, expanded) {
    return place(nodes, edges, await elkOrder(nodes, edges), expanded);
}

export { WIDTH, HEADER_H, ROW_H };
