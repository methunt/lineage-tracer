import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ReactFlow, Background, Controls, MiniMap, Panel,
    useReactFlow, ReactFlowProvider, applyNodeChanges,
} from '@xyflow/react';
import { useStore, ADJ, DATA, resourceOf } from './store';
import { elkOrder, place, nodeHeight, WIDTH } from './layout';
import GraphNode from './GraphNode';
import LineageEdge from './LineageEdge';
import { KIND_COLOR, topLayer } from './theme';
import { revealOptions } from './reveal';
import {
    IconArrowLeft, IconArrowRight, IconFit, IconX, IconInfo, IconSpinner,
    IconChevronDown, IconChevronRight, IconSearch,
} from './icons';

const nodeTypes = { lineage: GraphNode };
const edgeTypes = { lineage: LineageEdge };

// Above this, node position transitions are dropped: animating several hundred
// transforms at once drops frames, and a stuttering canvas reads as broken
// rather than as polished (design-system.md §5).
const GLIDE_LIMIT = 200;

/*
 * Above this many visible nodes an ELK solve is long enough to be felt, and the
 * loading overlay is worth the two frames it costs to raise it.
 *
 * There is no way to make this "always". elkjs blocks the main thread, so the
 * overlay has to be painted *before* the solve starts; a CSS animation-delay
 * cannot help, because no frames are painted during the block. A floor is the
 * only thing that stops a 20ms solve from flashing a blur.
 */
const BUSY_THRESHOLD = 40;

// Power BI is one layer in the data, but tables, measures and visuals in a
// single column cannot be read. Split into three columns for layout only —
// node.layer in the data is untouched.
const PBI_LANE = { pbiTable: 'powerbi', measure: 'measures', page: 'pages', visual: 'visuals' };
/*
 * A lane is the top folder, never the full path.
 *
 * `node.layer` carries the whole chain (`staging/crm/base`) because the
 * navigation tree needs the hierarchy. The canvas does not: a lane per folder
 * turned five columns into seventeen, and depth is not something anyone reads
 * off a left-to-right axis — the axis is there to show flow. Subfolders stay in
 * the rail, where hierarchy belongs.
 *
 * The data is untouched, exactly as with the Power BI split above: this is a
 * layout decision and it lives with the layout.
 */
const laneOf = node => (node.origin === 'pbi'
    ? PBI_LANE[node.kind] || 'powerbi'
    : topLayer(node.layer));
const laneOrder = layers => [
    ...new Set(layers.filter(l => l !== 'powerbi').map(topLayer)),
    'powerbi', 'measures', 'pages', 'visuals',
];

const DEPTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, Infinity];
const LARGE_EXPANSION = 150;

// Columns rendered by one press of expand-all before it asks first. Each column
// is a DOM row, and the several hundred tables of a large production project
// carry several thousand between them — enough to stall the tab without warning.
const BULK_COLUMN_LIMIT = 800;

const neighboursOf = (id, direction) =>
    ((direction === 'up' ? ADJ.inn : ADJ.out).get(id) || [])
        .map(e => (direction === 'up' ? e.source : e.target))
        .filter(n => DATA.nodes[n]);

/**
 * Nodes surviving the filters, plus anything explicitly revealed.
 *
 * Revealed neighbours deliberately bypass every filter: the point of pressing
 * "+" on a search result is to see what the search is hiding. Focus mode goes
 * further and suspends the filters altogether, so a table clicked in the
 * database tree always appears — a click that silently shows nothing because
 * of a filter set elsewhere is indistinguishable from a broken button.
 */
function useVisibleGraph() {
    const data = useStore(s => s.data);
    const layers = useStore(s => s.layers);
    const kinds = useStore(s => s.kinds);
    const resources = useStore(s => s.resources);
    const linkedOnly = useStore(s => s.linkedOnly);
    const reveals = useStore(s => s.reveals);
    const focusRoot = useStore(s => s.focusRoot);
    const resultSet = useStore(s => s.resultSet);
    const blank = useStore(s => s.blank);

    return useMemo(() => {
        const all = Object.values(data.nodes);
        const revealed = new Set();
        for (const ids of Object.values(reveals)) for (const id of ids) revealed.add(id);

        let base;
        /*
         * A warehouse of a thousand models laid out at once is not a diagram,
         * it is a texture — and the reader always arrives with a question
         * narrower than "everything". So the canvas opens empty and fills on
         * the first thing you ask for. Cleared by any choice: a search, a node
         * from the rail, a filter, or the button on the empty state.
         */
        if (blank) {
            base = [];
        } else if (resultSet) {
            base = [...resultSet.ids].map(id => data.nodes[id]).filter(Boolean);
        } else if (focusRoot) {
            base = data.nodes[focusRoot] ? [data.nodes[focusRoot]] : [];
        } else {
            // "Linked only" = on a path that actually crosses into Power BI.
            let allowed = null;
            if (linkedOnly) {
                allowed = new Set();
                const walkAll = (start, map, pick) => {
                    const stack = [start];
                    while (stack.length) {
                        const id = stack.pop();
                        if (allowed.has(id)) continue;
                        allowed.add(id);
                        for (const e of map.get(id) || []) stack.push(pick(e));
                    }
                };
                for (const e of data.edges.filter(x => x.kind === 'dbt_to_pbi')) {
                    walkAll(e.source, ADJ.inn, x => x.source);
                    walkAll(e.target, ADJ.out, x => x.target);
                }
            }

            /*
             * The layer axis governs models and nothing else.
             *
             * `layer` is a folder name, and a folder is free to be called
             * anything — including `sources` or `models`. The rail presents
             * layers as a subdivision of the models group, so hiding one
             * should hide models. It used to hide every node carrying that
             * layer string: switching off a `sources` *folder* of models also
             * hid every dbt source, whose layer is `sources` by construction,
             * and switching off the `models` folder hid the snapshot, which is
             * a different resource type sitting in a folder of that name.
             *
             * Every other resource type has its own row and its own eye in the
             * rail, which is where its visibility belongs.
             */
            base = all.filter(n =>
                kinds.has(n.kind) &&
                (n.origin === 'pbi'
                    ? true
                    : resources.has(resourceOf(n)) &&
                      (resourceOf(n) !== 'model' || layers.has(n.layer))) &&
                (!allowed || allowed.has(n.id)));
        }

        const ids = new Set(base.map(n => n.id));
        for (const id of revealed) if (data.nodes[id]) ids.add(id);

        const visible = [...ids].map(id => {
            const node = data.nodes[id];
            const lane = laneOf(node);
            const up = hopState(id, 'up', ids, reveals);
            const down = downState(node, ids, reveals);
            return {
                ...node,
                layer: lane,
                _up: up,
                _down: down,
                _shown: down === 'menu' ? shownKinds(node, ids) : '',
                _hops: up !== 'none' || down !== 'none',
            };
        });

        const edges = data.edges
            .map((e, i) => ({ ...e, _i: i }))
            .filter(e => ids.has(e.source) && ids.has(e.target));

        return { nodes: visible, edges };
    }, [data, layers, kinds, resources, linkedOnly, reveals, focusRoot, resultSet, blank]);
}

/**
 * 'retract' once this node's own press is on the canvas, 'none' when there is
 * nothing left to show in that direction, otherwise 'add'. Hiding the button
 * when the direction is exhausted is what stops a press that visibly does
 * nothing.
 */
function hopState(id, direction, visibleIds, reveals) {
    if (reveals[`${id}|${direction}`]) return 'retract';
    const neighbours = neighboursOf(id, direction);
    if (!neighbours.length) return 'none';
    return neighbours.every(n => visibleIds.has(n)) ? 'none' : 'add';
}

/*
 * Downstream of a Power BI table or a page, `+` is a menu rather than a hop.
 *
 * 'menu' unconditionally once the card has any neighbour of any offered kind —
 * unlike the plain button, this one is *not* hidden when everything it offers is
 * already on canvas, because it is also the retract control and the only place
 * the ticks live. A card with nothing to offer at all still falls through to the
 * plain state, so it disappears as before.
 */
function downState(node, visibleIds, reveals) {
    const options = revealOptions(node.id, node.kind, ADJ, DATA.nodes);
    if (options?.some(o => o.ids.length)) return 'menu';
    return hopState(node.id, 'down', visibleIds, reveals);
}

/*
 * Which of the menu's kinds are already on the canvas — one flag per item, in
 * menu order, as a string.
 *
 * The menu's ticks answer "did I open this", which is not the same question as
 * "is this on screen". The depth stepper reaches the same cards under a
 * `<id>|down` key the menu does not own, and a search or a filter can put them
 * there under no key at all — so the menu offered pages the reader was already
 * looking at, unticked, as though nothing had happened.
 *
 * Computed here because this is the only place the visible set exists. A string
 * rather than an array so React Flow's by-reference data cache can compare it,
 * the same trick the tick string in the menu itself uses.
 */
function shownKinds(node, visibleIds) {
    const options = revealOptions(node.id, node.kind, ADJ, DATA.nodes) || [];
    return options
        .map(o => (o.ids.length && o.ids.every(id => visibleIds.has(id)) ? '1' : '0'))
        .join('');
}

/** Depth stepper — set a number, walk that many hops from the focused node. */
/*
 * Open or close every card's column list in one press.
 *
 * Scope follows the selection, because that is the difference between the two
 * things a reader wants. With a trace on canvas, "expand" means show me the
 * columns along this path — opening the untouched half of the graph at the same
 * time would bury it. With nothing selected there is no path to respect, so it
 * opens what is on canvas.
 *
 * Sits with the depth stepper: both are bulk canvas moves, and neither belongs
 * in the per-card chevron next to a single count.
 */
function ExpandAll({ visible }) {
    const expanded = useStore(s => s.expanded);
    const highlight = useStore(s => s.highlight);
    const setExpandedMany = useStore(s => s.setExpandedMany);

    const targets = useMemo(
        () => visible.filter(n =>
            n.columns?.length && (!highlight || highlight.nodes.has(n.id))),
        [visible, highlight]);

    if (!targets.length) return null;
    const open = targets.every(n => expanded.has(n.id));
    const columnCount = targets.reduce((sum, n) => sum + n.columns.length, 0);
    const scope = highlight ? 'on the highlighted path' : 'on canvas';

    const press = () => {
        // Every column is a row in the DOM. A few hundred is fine; ten thousand
        // is a frozen tab, and the reader deserves the number before that
        // rather than a spinner afterwards.
        if (!open && columnCount > BULK_COLUMN_LIMIT &&
            !window.confirm(`This will show ${columnCount} columns across ${targets.length} tables. Expand anyway?`)) return;
        setExpandedMany(targets.map(n => n.id), !open);
    };

    return (
        <button
            data-testid="expand-all"
            onClick={press}
            aria-pressed={open}
            title={open
                ? `Collapse the ${targets.length} table${targets.length === 1 ? '' : 's'} ${scope}`
                : `Expand columns on the ${targets.length} table${targets.length === 1 ? '' : 's'} ${scope} (${columnCount} columns)`}
            className="px-3 py-2 grid place-items-center border-l"
            style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
        >{open ? <IconChevronDown size="md" /> : <IconChevronRight size="md" />}</button>
    );
}

function Stepper({ nodeId, visible }) {
    const depth = useStore(s => s.depth);
    const setDepth = useStore(s => s.setDepth);
    const expandFrom = useStore(s => s.expandFrom);
    const previewExpand = useStore(s => s.previewExpand);
    const data = useStore(s => s.data);
    const [note, setNote] = useState('');

    const node = nodeId ? data.nodes[nodeId] : null;

    const go = direction => {
        if (!node) return;
        const added = previewExpand(nodeId, direction, depth);
        if (!added) {
            setNote(`nothing further ${direction === 'up' ? 'upstream' : 'downstream'}`);
            setTimeout(() => setNote(''), 2200);
            return;
        }
        // Unbounded walks reach the whole Power BI surface. Worth allowing —
        // upstream cones are usually tiny — but not without saying the size.
        if (added > LARGE_EXPANSION &&
            !window.confirm(`This will add ${added} nodes. Expand anyway?`)) return;
        setNote('');
        expandFrom(nodeId, direction, depth);
    };

    const arrow = (direction, Glyph, label) => (
        <button
            onClick={() => go(direction)}
            disabled={!node}
            aria-label={`Expand ${label}`}
            title={node
                ? `Expand ${depth === Infinity ? 'all' : depth} hop(s) ${label} from ${node.name}`
                : 'Select a node to expand from'}
            className="px-3 py-2 grid place-items-center"
            style={{ color: node ? 'var(--text)' : 'var(--muted)', opacity: node ? 1 : .45 }}
        ><Glyph size="md" /></button>
    );

    return (
        <div data-testid="stepper" className="flex flex-col items-center gap-1.5">
            {note && (
                <div className="px-2.5 py-1 rounded-md flex items-center gap-1.5"
                    style={{
                        background: 'var(--panel)', border: '1px solid var(--border)',
                        color: 'var(--muted)', fontSize: 'var(--fs-sm)', boxShadow: 'var(--sh-1)',
                    }}>
                    <IconInfo size="sm" />{note}
                </div>
            )}
            <div className="flex items-center rounded-[var(--r-md)] border overflow-hidden"
                style={{ background: 'var(--panel)', borderColor: 'var(--border)', boxShadow: 'var(--sh-2)' }}>
                {arrow('up', IconArrowLeft, 'upstream')}
                <select
                    value={depth === Infinity ? 'inf' : depth}
                    onChange={e => setDepth(e.target.value === 'inf' ? Infinity : Number(e.target.value))}
                    title="How many hops each press expands"
                    aria-label="Expansion depth"
                    className="px-2 py-2 border-x tnum"
                    style={{ borderColor: 'var(--border)', background: 'var(--panel)', color: 'var(--text)' }}
                >
                    {DEPTHS.map(d => (
                        <option key={String(d)} value={d === Infinity ? 'inf' : d}>{d === Infinity ? '∞' : d}</option>
                    ))}
                </select>
                {arrow('down', IconArrowRight, 'downstream')}
                <ExpandAll visible={visible} />
            </div>
            <div className="truncate max-w-[260px] px-2 py-0.5 rounded"
                style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', background: 'var(--bg)' }}>
                {node ? node.name : 'select a node to expand from'}
            </div>
        </div>
    );
}

function Canvas() {
    const { nodes: visibleNodes, edges: visibleEdges } = useVisibleGraph();
    const blank = useStore(s => s.blank);
    const showEverything = useStore(s => s.showEverything);
    const setPaletteOpen = useStore(s => s.setPaletteOpen);
    const layerOrder = useStore(s => s.layerOrder);
    const expanded = useStore(s => s.expanded);
    const highlight = useStore(s => s.highlight);
    const selection = useStore(s => s.selection);
    const select = useStore(s => s.select);
    const moved = useStore(s => s.moved);
    const moveNode = useStore(s => s.moveNode);
    const resetLayout = useStore(s => s.resetLayout);
    const focusRoot = useStore(s => s.focusRoot);
    const resultSet = useStore(s => s.resultSet);
    const clearFocus = useStore(s => s.clearFocus);
    const data = useStore(s => s.data);

    // The ELK result, tagged with the node array it was computed from. Tagging
    // rather than trusting a boolean means a stale solve arriving late can be
    // ignored by identity instead of by a cancellation flag.
    const [order, setOrder] = useState(null);
    const [slow, setSlow] = useState(false);
    const { fitView } = useReactFlow();

    const solving = !order || order.nodes !== visibleNodes;
    // Set when a solve finishes, consumed once its layout has been painted.
    const wantFit = React.useRef(false);

    const lanes = useMemo(() => laneOrder(layerOrder), [layerOrder]);
    const fit = useCallback(
        () => fitView({ padding: 0.12, duration: 300, minZoom: 0.45, maxZoom: 1 }),
        [fitView]
    );

    /**
     * Solve the ordering. Depends on the node and edge *sets* only.
     *
     * Expanding a node's columns is deliberately absent from this dependency
     * list: it changes one node's height, nothing else, and heights are handled
     * entirely by the synchronous place() below. Re-running ELK for it was the
     * lag — one click re-solved the whole graph and then re-fitted the viewport.
     */
    useEffect(() => {
        let cancelled = false;

        const run = () => elkOrder(visibleNodes, visibleEdges)
            .then(elkY => {
                if (cancelled) return;
                setOrder({ nodes: visibleNodes, elkY });
                globalThis.__LINEAGE_DEBUG__ = { visible: visibleNodes.length, positioned: elkY.size };
                /*
                 * Ask for a fit; do not perform one here.
                 *
                 * fitView measures the nodes React Flow currently holds, and at
                 * this point that is still the *previous* layout — setOrder has
                 * not been committed, let alone rendered. The fit therefore
                 * framed the old graph, which is why filtering or focusing left
                 * the surviving card stranded at the top and "Reset layout",
                 * arriving a render later, appeared to be the thing that
                 * centred it. The effect below fits once the new positions are
                 * on screen.
                 */
                wantFit.current = true;
            })
            .catch(err => {
                if (cancelled) return;
                globalThis.__LINEAGE_DEBUG__ = { visible: visibleNodes.length, error: String(err?.message || err) };
                console.error('layout failed', err);
                setOrder({ nodes: visibleNodes, elkY: new Map() });
            });

        /*
         * elkjs is synchronous under its Promise: once it starts, the main
         * thread is blocked and the browser cannot paint. A loading overlay
         * shown "while it runs" therefore never appears at all — on this
         * project a 152-node solve froze the page for 2.4s with no feedback.
         *
         * So above the size where that is perceptible, paint the overlay first
         * and only start the solve after two frames have actually gone out.
         */
        if (visibleNodes.length > BUSY_THRESHOLD) {
            setSlow(true);
            let inner;
            const outer = requestAnimationFrame(() => {
                inner = requestAnimationFrame(() => { if (!cancelled) run(); });
            });
            return () => {
                cancelled = true;
                cancelAnimationFrame(outer);
                if (inner) cancelAnimationFrame(inner);
            };
        }

        run();
        return () => { cancelled = true; };
    }, [visibleNodes, visibleEdges, fit]);

    /*
     * Cheap, synchronous, and re-run freely on every expand.
     *
     * While a new solve is in flight the *previous* layout stays on screen,
     * blurred. Returning null here emptied the canvas for the whole solve, so
     * the wait was spent staring at nothing — which is what made a slow layout
     * read as a crash rather than as work in progress.
     */
    const lastGood = React.useRef({ nodes: [], edges: [], positions: new Map() });
    const positions = useMemo(() => {
        if (solving) return null;
        const next = place(visibleNodes, order.elkY, lanes, expanded);
        lastGood.current = { nodes: visibleNodes, edges: visibleEdges, positions: next };
        return next;
    }, [solving, order, visibleNodes, visibleEdges, lanes, expanded]);

    // Edges come from the same snapshot as the nodes. Rebuilding them from the
    // new filter while the solve is in flight costs a pass over every edge in
    // the graph — a few thousand of them on a large project — before the
    // overlay can paint,
    // and produces edges pointing at nodes that are not on screen yet.
    //
    // Memoised for identity, not for cost: `rfNodes` derives from this, and the
    // drag mirror below re-syncs whenever `rfNodes` changes. A fresh object
    // literal each render would make that sync fire on every render, and each
    // sync renders again — an unbreakable loop.
    const shown = useMemo(
        () => (positions ? { nodes: visibleNodes, edges: visibleEdges, positions } : lastGood.current),
        [positions, visibleNodes, visibleEdges]);

    /*
     * Fit once the new layout is actually on screen.
     *
     * Two frames, not one: the first commits the nodes at their new positions,
     * the second lets React Flow measure them. Fitting any earlier frames the
     * layout that is being replaced.
     *
     * It will not always succeed, and that is not a bug to chase: "show all"
     * can land 21 expanded cards, 1,789px tall at the 0.45 floor in a 950px
     * window. fitView clamps to minZoom and centres what it cannot frame,
     * which is the right answer — the alternative is text too small to read.
     *
     * Guarded by `wantFit`, so this fires only after a solve — expanding a
     * card's columns must still hold the viewport still, because you are
     * reading the node you just clicked.
     */
    useEffect(() => {
        if (!positions || !wantFit.current) return;
        wantFit.current = false;
        let inner;
        const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(fit); });
        return () => {
            cancelAnimationFrame(outer);
            if (inner) cancelAnimationFrame(inner);
        };
    }, [positions, fit]);

    // Small graphs solve inside a frame; blurring for 40ms reads worse than no
    // feedback at all, so the overlay is raised by the effect above only when
    // the graph is big enough to actually stall, and cleared here on arrival.
    useEffect(() => { if (!solving) setSlow(false); }, [solving]);

    // React Flow memoises node wrappers and compares `data` by reference, so a
    // freshly built object for every node on every expand re-renders all of
    // them — well over a hundred cards for one click. Handing back the same object when nothing
    // about that node changed leaves only the toggled card to re-render.
    const dataCache = React.useRef(new Map());
    const nodeData = useCallback(node => {
        const cached = dataCache.current.get(node.id);
        if (cached && cached.node === node && cached.up === node._up && cached.down === node._down
            && cached.shown === node._shown) {
            return cached;
        }
        const fresh = { node, up: node._up, down: node._down, shown: node._shown };
        dataCache.current.set(node.id, fresh);
        return fresh;
    }, []);

    const rfNodes = useMemo(() => shown.nodes.map(node => ({
        id: node.id,
        type: 'lineage',
        // A dragged position wins until the reader resets the layout.
        position: moved[node.id] || shown.positions.get(node.id) || { x: 0, y: 0 },
        data: nodeData(node),
        className: shown.nodes.length > GLIDE_LIMIT ? 'no-glide' : undefined,
        width: WIDTH,
        height: nodeHeight(node, expanded.has(node.id)),
    })), [shown, expanded, moved, nodeData]);

    /*
     * One curve per pair of nodes, not per column.
     *
     * Column lineage means a table feeding four of another table's columns is
     * four edges, and they are drawn between the same two anchors — four curves
     * stacked in the same place, indistinguishable from one and four times the
     * cost. On a large project that is a few thousand edges rendering as a few
     * hundred
     * legible paths. The columns are not lost: selecting one traces it, and the
     * count on the bundle says how many there are to find.
     */
    const rfEdges = useMemo(() => {
        const bundles = new Map();
        for (const edge of shown.edges) {
            const key = `${edge.source}|${edge.target}`;
            if (!bundles.has(key)) bundles.set(key, []);
            bundles.get(key).push(edge);
        }
        return [...bundles.values()].map(group => {
            const first = group[0];
            // Lit if any member is on the path, at the shallowest member's depth
            // so the reveal still runs outward from the selection.
            let depth = null;
            let anyExact = false;
            for (const e of group) {
                const d = highlight?.edges.get(e._i);
                if (d == null) continue;
                depth = depth == null ? d : Math.min(depth, d);
                if (!highlight.inferredEdges.has(e._i)) anyExact = true;
            }
            const lit = depth != null;
            const named = group.filter(e => e.sourceColumn || e.targetColumn).length;
            return {
                id: `e${first._i}`,
                source: first.source,
                target: first.target,
                type: 'lineage',
                className: [
                    group.some(e => e.provenance === 'declared') ? 'is-declared' : '',
                    lit ? 'is-lit' : '',
                    // Drawn faintly: a real dependency, established without the
                    // columns to prove which one.
                    lit && !anyExact ? 'is-inferred' : '',
                    highlight && !lit ? 'is-dim' : '',
                ].filter(Boolean).join(' '),
                data: { count: group.length, named },
                /*
                 * How many columns the bundle carries, as weight rather than a
                 * number. A React Flow label is an SVG text node per edge, which
                 * measures itself with getBBox — hundreds of extra nodes and
                 * measurements on a graph this size, for a figure that is
                 * already exact in the side panel. Weight reads at a glance
                 * without asking the canvas to render type.
                 */
                style: {
                    '--edge-weight': Math.min(1 + Math.log2(named + 1) * 0.5, 3).toFixed(2),
                    ...(lit
                        // Reveal staggers outward from the selected node, capped
                        // so a deep path still finishes drawing inside a beat.
                        ? { '--reveal-delay': `${Math.min(depth * 40, 240)}ms` }
                        : null),
                },
            };
        });
    }, [shown, highlight]);

    /*
     * Drag is transient: React Flow owns the node's position for the length of
     * the gesture, and the store only hears about it on drop.
     *
     * `rfNodes` is derived from the layout and from `moved`, so feeding it to
     * ReactFlow directly made the canvas fully controlled — every in-flight
     * `position` change was discarded and the node re-rendered at its old
     * coordinates, so nothing appeared to move until the mouse came up. Mirroring
     * it into local state and applying changes here lets the node follow the
     * cursor without a store write per mousemove, which would re-render every
     * subscriber of the graph. applyNodeChanges keeps the identity of untouched
     * nodes, so the GraphNode memo still holds across a drag.
     *
     * Only `position` changes are applied. Feeding React Flow's `dimensions`
     * changes back in produces a new array on every measurement, which triggers
     * another measurement — a render loop that leaves the canvas too busy to
     * answer a click. Sizes already come from nodeHeight(), which is what the
     * layout solved against.
     */
    const [liveNodes, setLiveNodes] = useState(rfNodes);
    useEffect(() => { setLiveNodes(rfNodes); }, [rfNodes]);

    const onNodesChange = useCallback(changes => {
        const moves = changes.filter(c => c.type === 'position');
        if (moves.length) setLiveNodes(current => applyNodeChanges(moves, current));
        for (const change of changes) {
            if (change.type === 'position' && change.position && change.dragging === false) {
                moveNode(change.id, change.position);
            }
        }
    }, [moveNode]);

    const movedCount = Object.keys(moved).length;
    // One chip for both pins — they are the same promise to the reader ("this
    // is all there is, and filters are off"), so two chips would be two ways of
    // saying it and a second thing to learn how to dismiss.
    const pin = resultSet
        ? <>Showing <b>{resultSet.label}</b> · {resultSet.ids.size} on canvas</>
        : focusRoot && data.nodes[focusRoot]
            ? <>Focused: <b>{data.nodes[focusRoot].name}</b> · filters suspended</>
            : null;

    return (
        <div className="relative h-full">
            {/*
             * The opening screen, and the only one that has to teach anything.
             * Three ways in, in the order a reader is likely to want them:
             * search when they know the name, the rail when they want to
             * browse, and everything when the project is small enough that the
             * whole picture is the answer.
             */}
            {blank && (
                <div data-testid="canvas-blank"
                    className="absolute inset-0 z-10 grid place-items-center p-6">
                    <div className="blank-card">
                        <IconSearch size="lg" style={{ color: 'var(--accent)' }} />
                        <div className="blank-title">What do you want to trace?</div>
                        <p className="blank-body">
                            This project has <b className="tnum">{Object.keys(data.nodes).length}</b> objects.
                            Drawn at once they are a texture rather than a diagram, so the canvas
                            starts empty and fills with whatever you ask for.
                        </p>
                        <div className="blank-actions">
                            <button className="blank-primary" onClick={() => setPaletteOpen(true)}>
                                <IconSearch size="sm" /> Search for a model or column
                            </button>
                            <button className="blank-secondary" data-testid="show-everything"
                                onClick={showEverything}>
                                Show everything
                            </button>
                        </div>
                        <p className="blank-foot">Or pick anything from the rail on the left.</p>
                    </div>
                </div>
            )}
            {slow && (
                <div data-testid="canvas-busy"
                    className="canvas-busy absolute inset-0 z-10 grid place-items-center pointer-events-none">
                    <div className="busy-card">
                        <IconSpinner size="md" className="spin" style={{ color: 'var(--accent)' }} />
                        <div>
                            <div className="font-semibold">Laying out {visibleNodes.length} nodes</div>
                            <div className="busy-bar"><span /></div>
                        </div>
                    </div>
                </div>
            )}
            <div className={`h-full ${slow ? 'is-blurred' : ''}`}
                style={{ transition: 'filter var(--dur-base) var(--ease), opacity var(--dur-base) var(--ease)' }}>
            <ReactFlow
                nodes={liveNodes}
                edges={rfEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={onNodesChange}
                onPaneClick={() => select(null)}
                minZoom={0.05}
                maxZoom={2.5}
                proOptions={{ hideAttribution: true }}
                nodesConnectable={false}
                // elementsSelectable must stay true: React Flow marks node wrappers
                // pointer-events:none when it is false, killing every click inside a node.
                elementsSelectable
            >
                {pin && (
                    <Panel position="top-left">
                        <div data-testid="focus-chip"
                            className="flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-[var(--r-md)] border"
                            style={{
                                background: 'var(--accent-soft)', borderColor: 'var(--accent)',
                                color: 'var(--accent)', fontSize: 'var(--fs-sm)', boxShadow: 'var(--sh-2)',
                            }}>
                            <span>{pin}</span>
                            <button onClick={clearFocus} title="Back to the filtered view"
                                aria-label="Clear focus" className="p-1 rounded">
                                <IconX size="sm" />
                            </button>
                        </div>
                    </Panel>
                )}

                <Panel position="top-right">
                    <button
                        data-testid="reset-layout"
                        onClick={() => { resetLayout(); setTimeout(fit, 60); }}
                        title="Re-align every node by layer and fit to view"
                        className="flex items-center gap-2 px-3 py-2 rounded-[var(--r-md)] border"
                        style={{
                            background: 'var(--panel)', borderColor: 'var(--border)',
                            color: 'var(--text)', fontSize: 'var(--fs-sm)', boxShadow: 'var(--sh-2)',
                        }}
                    >
                        <IconFit size="sm" />
                        Reset layout{movedCount ? ` (${movedCount} moved)` : ''}
                    </button>
                </Panel>

                <Panel position="bottom-center">
                    <Stepper nodeId={selection?.nodeId || null} visible={shown.nodes} />
                </Panel>

                <Background gap={22} size={1} color="var(--border)" />
                <Controls showInteractive={false} />
                <MiniMap
                    pannable zoomable
                    nodeColor={n => (n.data?.node ? KIND_COLOR[n.data.node.kind] : 'transparent')}
                    nodeStrokeWidth={0}
                    maskColor="rgba(0,0,0,.06)"
                    style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
                />
            </ReactFlow>
            </div>
        </div>
    );
}

export default function LineageGraph() {
    return (
        <ReactFlowProvider>
            <Canvas />
        </ReactFlowProvider>
    );
}
