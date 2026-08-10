import ELK from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();

// Sizes follow docs/design-system.md §2: a 12px type floor makes the card
// taller and wider, and roughly a quarter fewer nodes fit per screen. That is
// the deliberate trade for a canvas readable without zooming.
const HEADER_H = 64;
const HOP_H = 37;         // the upstream/downstream handle strip
const ROW_H = 24;
const WIDTH = 248;
const LANE_GAP = 104;     // horizontal space between lanes
const NODE_GAP = 20;      // vertical space between nodes in a lane

export function nodeHeight(node, expanded) {
    const hops = node._hops ? HOP_H : 0;
    if (!expanded || !node.columns?.length) return HEADER_H + hops;
    // Long column lists scroll inside the node rather than making it enormous.
    return HEADER_H + Math.min(node.columns.length, 14) * ROW_H + 8 + hops;
}

/**
 * Left-to-right DAG in strict layer lanes.
 *
 * ELK decides the *vertical* ordering — that is the hard part, and its layered
 * algorithm minimises edge crossings well. It does not decide the horizontal
 * placement: ELK's own partitioning did not reliably keep layers in the declared
 * order, and a lineage graph where "Power BI" can land left of "staging" is
 * worse than useless. So each layer is assigned its own column here, and ELK's
 * y-ordering is preserved within it.
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
    if (!nodes.length) return new Map();

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
             * Both of these were paid for and thrown away.
             *
             * NETWORK_SIMPLEX computes precise coordinates; place() discards
             * every one of them and re-stacks the lane. Crossing minimisation
             * is a separate phase, so the ordering we actually consume is
             * unchanged by dropping to BRANDES_KOEPF. Measured on a large
             * production project — a couple of hundred nodes, ~1,600 edges —
             * the layout went from roughly 4s to half a second.
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
    for (const child of result.children || []) elkY.set(child.id, child.y ?? 0);
    return elkY;
}

/**
 * Turn an ELK ordering into positions. Pure arithmetic — safe to run on every
 * expand, every frame if it came to that.
 */
export function place(nodes, elkY, layerOrder, expanded) {
    if (!nodes.length) return new Map();

    // Lane x positions, in declared order, skipping layers with no nodes.
    const present = layerOrder.filter(layer => nodes.some(n => n.layer === layer));
    const laneX = new Map();
    present.forEach((layer, i) => laneX.set(layer, i * (WIDTH + LANE_GAP)));

    // Within a lane, keep ELK's relative order but re-stack to remove overlap.
    const positions = new Map();
    for (const layer of present) {
        const inLane = nodes
            .filter(n => n.layer === layer)
            .sort((a, b) => (elkY.get(a.id) ?? 0) - (elkY.get(b.id) ?? 0));

        let y = 0;
        for (const node of inLane) {
            positions.set(node.id, { x: laneX.get(layer), y });
            y += nodeHeight(node, expanded.has(node.id)) + NODE_GAP;
        }
    }

    // Centre each lane vertically so short lanes sit against the tall ones
    // rather than all hugging the top.
    const heights = new Map();
    for (const layer of present) {
        const inLane = nodes.filter(n => n.layer === layer);
        const last = inLane.reduce((max, n) => {
            const p = positions.get(n.id);
            return Math.max(max, p.y + nodeHeight(n, expanded.has(n.id)));
        }, 0);
        heights.set(layer, last);
    }
    const tallest = Math.max(...heights.values(), 0);
    for (const layer of present) {
        const offset = (tallest - heights.get(layer)) / 2;
        if (offset <= 0) continue;
        for (const node of nodes.filter(n => n.layer === layer)) {
            const p = positions.get(node.id);
            positions.set(node.id, { x: p.x, y: p.y + offset });
        }
    }

    return positions;
}

/** Both halves, for callers that have no ordering cached. */
export async function layout(nodes, edges, layerOrder, expanded) {
    return place(nodes, await elkOrder(nodes, edges), layerOrder, expanded);
}

export { WIDTH, HEADER_H, ROW_H };
