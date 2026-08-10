import { create } from 'zustand';
import { deriveLayerOrder, walk } from './tree';
import { REVEAL_MENUS, defaultPick, revealKey, revealNeighbours } from './reveal';

/**
 * An empty graph, so the app can mount before there is anything to show.
 *
 * The web app opens on the landing page and calls `loadGraph` once the browser
 * has finished building; the dev server has no data at all. Both need the
 * module to evaluate without a graph.
 */
const EMPTY = () => ({
    metadata: { generatedAt: null, model: null, inputs: {} },
    summary: {},
    layers: ['sources', 'powerbi'],
    nodes: {},
    edges: [],
    impact: { node: {}, column: {}, bands: { high: 10, medium: 3, low: 1 } },
    diagnostics: {},
});

const KINDS = ['source', 'model', 'pbiTable', 'page', 'measure', 'visual'];

// Opening on the whole graph buries the structure under measures and visuals.
// Start with the spine — sources, dbt models, the semantic model tables, and
// pages: a dozen page cards answer "what breaks?" where hundreds of visual cards do
// not, and the visuals are one expansion away.
const DEFAULT_KINDS = ['source', 'model', 'pbiTable', 'page'];

/** Adjacency, built once — every traversal in the UI reads these. */
function buildAdjacency(edges) {
    const out = new Map();
    const inn = new Map();
    edges.forEach((edge, i) => {
        const e = { ...edge, _i: i };
        if (!out.has(e.source)) out.set(e.source, []);
        if (!inn.has(e.target)) inn.set(e.target, []);
        out.get(e.source).push(e);
        inn.get(e.target).push(e);
    });
    return { out, inn };
}

/**
 * dbt resource types present in the graph. A third filter axis, because the
 * tree groups by resource type and `kind` cannot express it: dbt_extract maps
 * every non-source resource to kind `model`, so a snapshot and an incremental
 * table are the same `kind` and different resources.
 */
const resourceOf = node => (node.kind === 'unknown'
    ? 'unknown'
    : (node.meta?.resourceType || 'model'));

/*
 * The graph and everything derived from it.
 *
 * `let` rather than `const`, and exported as such deliberately: ES module
 * exports are live bindings, so the views can keep importing `DATA` and `ADJ`
 * directly — as they did when the graph was baked into the HTML — and see the
 * uploaded one the moment `loadGraph` swaps it in. The alternative was
 * threading the graph through every traversal helper in five components to
 * support a page that mounts before its data exists.
 *
 * Nothing re-renders off these; the views are driven by store state, and the
 * app only reaches them after `loadGraph` has set `data`.
 */
export let DATA = globalThis.__LINEAGE__ || EMPTY();
export let ADJ = buildAdjacency(DATA.edges);
// Lane order is derived from the dbt edges, never hardcoded — a project using
// bronze/silver/gold must lay out as correctly as one using staging/marts.
export let LAYER_ORDER = deriveLayerOrder(DATA.nodes, DATA.edges);
export let RESOURCES = deriveResources(DATA);

function deriveResources(data) {
    return [...new Set(
        Object.values(data.nodes).filter(n => n.origin !== 'pbi').map(resourceOf)
    )];
}

/** Swap in a new graph and rebuild every index derived from it. */
function adoptGraph(data) {
    DATA = data;
    ADJ = buildAdjacency(data.edges);
    LAYER_ORDER = deriveLayerOrder(data.nodes, data.edges);
    RESOURCES = deriveResources(data);
}

/** Does this node have any neighbour at all in that direction? */
function hasNeighbours(id, direction) {
    const list = (direction === 'up' ? ADJ.inn : ADJ.out).get(id) || [];
    return list.some(e => DATA.nodes[direction === 'up' ? e.source : e.target]);
}

const lower = s => String(s ?? '').toLowerCase();

// The filters focus mode overrides. Touching any of them means the reader has
// gone back to filtering, so the focus pin comes off.
const FILTER_KEYS = new Set(['layers', 'resources', 'kinds']);

/**
 * Walk the graph from a node (optionally pinned to one column) and collect the
 * nodes and edge indices on that path. Column identity is carried while edges
 * name a column, and released once the path reaches a measure or visual — past
 * that point the column is consumed and everything downstream is affected.
 *
 * Not every edge names a column. A table-level mapping row, or a dbt edge where
 * sqlglot resolved nothing, carries the whole relation. Following one is still
 * correct — the node really is downstream — but from that hop on the answer is
 * table-grade, not column-grade, and this used to be indistinguishable from a
 * column-precise path. So the walk keeps going and records where the precision
 * was lost: `inferred` holds the nodes reached only that way, and `columns`
 * holds the column each node was reached *by*, which is what a card can light
 * up when its columns are expanded.
 */
function trace(startId, column, direction) {
    const nodes = new Set([startId]);
    // index -> hop distance from the selected node, so the reveal animation can
    // stagger outward instead of lighting the whole path at once.
    const edgeIdx = new Map();
    const columns = new Map();      // nodeId -> Set of column names reached exactly
    const exactNodes = new Set([startId]);
    const exactEdges = new Set();
    const seen = new Set();
    const queue = [[startId, column || null, 0, true]];
    const adj = direction === 'up' ? ADJ.inn : ADJ.out;
    // With no column picked the whole trace is table-grade by definition, and
    // marking any of it "inferred" would be noise.
    /*
     * Column marks are collected whenever there is a column to collect.
     *
     * With a column picked that is the picked one, carried along the path. With
     * a measure or visual picked there is no column to start from — they have
     * none — but every edge into one names the column it reads, so the walk
     * still has something to record: selecting a measure marks the columns that
     * measure is built from, and follows each of them upstream. That question
     * ("which columns does this measure actually use") had no answer before.
     *
     * A table is deliberately not included: it would mark every column of every
     * card on its path, which is the same as marking nothing.
     */
    const start = DATA.nodes[startId];
    const columnless = !(start?.columns?.length);
    const tracking = Boolean(column) || columnless;
    // Keyed lowercase throughout. dbt edges carry identifiers as colibri
    // lowercased them while a card renders the catalog's original case, so
    // `CustomerName` on the card never matched `customername` from the edge and
    // every dbt hop in a trace looked unmarked.
    if (column) columns.set(startId, new Set([lower(column)]));

    while (queue.length) {
        const [id, col, depth, exact] = queue.shift();
        const key = `${id}|${col ?? ''}|${exact ? 1 : 0}`;
        if (seen.has(key)) continue;
        seen.add(key);

        for (const edge of adj.get(id) || []) {
            /*
             * Containment, not lineage — and the distinction is depth, not
             * direction.
             *
             * A page holds its visuals, so following this edge downstream from a
             * page reached *mid-trace* would claim every visual on that page is
             * affected because one of them is. That is the over-claim the
             * exclusion was written for, and it still holds.
             *
             * But when the page or the visual is the thing the reader actually
             * selected, containment is the answer to the question they asked.
             * "Show me this page" that greys every chart on it is the opposite of
             * what it says, and a visual lit next to its table with its own page
             * dimmed leaves out the one fact that makes the rest legible — which
             * report the chart is on.
             *
             * So it is followed from the selected node only, and as a terminal:
             * the walk never continues out the far side. Carrying on from a page
             * would pull in every measure and table feeding *any* visual on it,
             * and the reader asked about one.
             */
            if (edge.kind === 'page_to_visual') {
                // Upstream (visual → its page) is safe at any depth: a visual is
                // on exactly one page, so it cannot fan out. Downstream (page →
                // its visuals) fans out by definition, so it is allowed only
                // from the selected node itself.
                if (direction === 'down' && depth !== 0) continue;
                const reachedId = direction === 'up' ? edge.source : edge.target;
                if (!DATA.nodes[reachedId]) continue;
                if (!edgeIdx.has(edge._i)) edgeIdx.set(edge._i, depth);
                nodes.add(reachedId);
                // Containment is exact by construction — the visual really is on
                // that page — so it is never marked inferred. It carries no
                // column, which is what an `exactNodes` entry with no `columns`
                // entry already means.
                exactEdges.add(edge._i);
                exactNodes.add(reachedId);
                continue;
            }
            const nearCol = direction === 'up' ? edge.targetColumn : edge.sourceColumn;
            const farCol = direction === 'up' ? edge.sourceColumn : edge.targetColumn;
            if (col && nearCol && lower(nearCol) !== lower(col)) continue;

            const nextId = direction === 'up' ? edge.source : edge.target;
            const next = DATA.nodes[nextId];
            if (!next) continue;

            // Precision survives a hop only if the edge named the column we are
            // carrying. Once lost it never comes back on that path.
            const stillExact = exact && (!tracking || !col || Boolean(nearCol));

            if (!edgeIdx.has(edge._i)) edgeIdx.set(edge._i, depth);
            if (stillExact) exactEdges.add(edge._i);
            nodes.add(nextId);
            if (stillExact) {
                exactNodes.add(nextId);
                if (tracking && farCol) {
                    if (!columns.has(nextId)) columns.set(nextId, new Set());
                    columns.get(nextId).add(lower(farCol));
                }
            }
            const consumed = next.kind === 'measure' || next.kind === 'visual' || next.kind === 'page';
            queue.push([nextId, consumed ? null : (farCol || null), depth + 1, stillExact]);
        }
    }
    const inferred = tracking
        ? new Set([...nodes].filter(id => !exactNodes.has(id)))
        : new Set();
    const inferredEdges = tracking
        ? new Set([...edgeIdx.keys()].filter(i => !exactEdges.has(i)))
        : new Set();
    return { nodes, edgeIdx, columns, inferred, inferredEdges };
}

/*
 * What Back rewinds: where you were, not how you had things set up.
 * `expanded` is in because focusing and "show all" open cards for you, so a
 * return that left them open would not be the view you left.
 */
const SNAPSHOT_KEYS = ['tab', 'selection', 'selectionView', 'highlight', 'panelTab',
    'focusRoot', 'resultSet', 'reveals', 'expanded', 'depth',
    /*
     * `reveal` is where the layout tab is standing — which page, which box.
     * Left out, Back rewound everything else and the layout stayed on the last
     * page you travelled to: the history was working, and the one view that
     * could show it did not move. `reveals` above is a different thing
     * entirely (revealed neighbours on the canvas); the near-collision is why
     * this was missed.
     */
    'reveal', 'blank'];
const snapshot = s => Object.fromEntries(SNAPSHOT_KEYS.map(k => [k, s[k]]));
// Deep enough for any real trail, bounded so a long session cannot pin every
// highlight set it ever built in memory.
const HISTORY_CAP = 30;

/**
 * Retract a press, and everything opened *from* what it removes.
 *
 * Without the cascade, folding a table's pages away left the visuals those pages
 * had opened standing on the canvas — orphans, positioned in a lane whose other
 * occupants had just gone, and joined to the table by the column edge that
 * always existed underneath. It read as the graph wiring a visual straight to a
 * table, and the reader had no way to fold it: the card that opened it was gone.
 *
 * A press is folded only when nothing else is still holding it. A node revealed
 * twice over keeps its own reveals, because the reader can still see it and
 * still has a control for it.
 *
 * The one imprecision, stated rather than hidden: "still holding" means held by
 * another reveal. A card that is also on canvas through a filter or a search
 * loses its children here, costing one press to get them back. Duplicating the
 * visibility rules — which live in useVisibleGraph, over four different sources —
 * to avoid that would be a second copy of them, and a second copy is how the two
 * stop agreeing.
 */
function retractCascade(reveals, key) {
    const next = { ...reveals };
    const removed = new Set(next[key] || []);
    delete next[key];

    // To a fixpoint: dropping a page's reveals can orphan the visuals *those*
    // opened, on a graph deep enough to have them.
    for (let changed = true; changed;) {
        changed = false;
        const held = new Set();
        for (const ids of Object.values(next)) for (const id of ids) held.add(id);
        for (const other of Object.keys(next)) {
            const owner = other.slice(0, other.lastIndexOf('|'));
            if (!removed.has(owner) || held.has(owner)) continue;
            for (const id of next[other]) removed.add(id);
            delete next[other];
            changed = true;
        }
    }
    return { reveals: next, removed: [...removed] };
}

/**
 * A card that leaves the canvas forgets where it was put.
 *
 * `moved` is keyed by node id and beat the solved layout, for as long as the
 * entry lived — which was until the reader pressed Reset. So a revealed card
 * that had been dragged, retracted, and revealed again came back at its old
 * coordinates: between lanes, with long diagonal edges to neighbours that were
 * laid out properly, which reads as the graph having put it in the wrong place.
 *
 * Scoped to the ids the retracted press was holding, and only those it was the
 * last holder of: a card revealed twice over stays put, and a card the reader
 * dragged while it was on canvas for some other reason — a filter, a search — is
 * not disturbed by an unrelated retract elsewhere.
 */
function forgetDragged(removed, reveals, moved) {
    if (!removed?.length || !Object.keys(moved).length) return moved;
    const held = new Set();
    for (const ids of Object.values(reveals)) for (const id of ids) held.add(id);
    const gone = removed.filter(id => !held.has(id) && id in moved);
    if (!gone.length) return moved;
    const next = { ...moved };
    for (const id of gone) delete next[id];
    return next;
}

export const useStore = create((set, get) => ({
    data: DATA,
    /*
     * Is there anything to look at?
     *
     * Not derived from `data.nodes` being empty: a project really can extract
     * to nothing — a manifest with no compiled SQL does exactly that — and the
     * reader needs to see that emptiness reported by the app, not be silently
     * returned to the upload page as though the build never happened.
     */
    hasGraph: Boolean(globalThis.__LINEAGE__),
    tab: 'lineage',
    // Light by default, and stamped on <html> at startup so the page never
    // renders in whatever the OS happens to prefer before the first press.
    theme: 'light',

    /*
     * The canvas opens empty.
     *
     * A dbt project with a thousand models rendered at once is a texture, not
     * a diagram — and nobody arrives asking to see everything. So nothing is
     * drawn until the reader says what they are after: a search, a node from
     * the rail, a filter, or the button on the empty state itself. Every one
     * of those clears this.
     */
    blank: true,
    showEverything: () => set({ blank: false }),
    // Reset means "as it opened", and it opens on the question.
    resetToBlank: () => set({ blank: true }),

    /*
     * Adopt a graph built in the browser.
     *
     * Everything derived from the old graph goes with it — filters are keyed by
     * layer and resource names that a different project does not share, and a
     * selection is a node id that may not exist any more. So this resets the
     * whole navigable state rather than merging into it: loading a second
     * project has to leave the app exactly as a first one would.
     */
    loadGraph: data => {
        adoptGraph(data);
        /*
         * Publish the graph where a report publishes its own.
         *
         * The single-file report arrives with `window.__LINEAGE__` already set;
         * a browser build arrives having just computed the same thing. Writing
         * it here means both routes leave the page in one state, and anything
         * that inspects a rendered report — the jsdom render test, a browser
         * test, someone in a console — works the same on either.
         */
        globalThis.__LINEAGE__ = data;
        set({
            data,
            hasGraph: true,
            layers: new Set(LAYER_ORDER),
            kinds: new Set(DEFAULT_KINDS),
            resources: new Set(RESOURCES),
            allResources: RESOURCES,
            layerOrder: LAYER_ORDER,
            tab: 'lineage',
            blank: true,
            selection: null, selectionView: null, highlight: null,
            focusRoot: null, resultSet: null, reveals: {},
            expanded: new Set(), moved: {}, reveal: null,
            panelTab: null, treeFilter: '', history: [],
        });
    },

    selection: null,            // { nodeId, column }
    /*
     * Which view the selection was made in. The highlight is deliberately
     * shared — the layout tab's hit badges are drawn from the trace you
     * started on the canvas — but the *panel* is not: a dbt model's panel
     * has nothing to say on a page layout, and one left open there reads as
     * a stuck window. So the panel renders only in the view that opened it.
     */
    selectionView: null,
    highlight: null,            // { nodes:Set, edges:Set }

    layers: new Set(LAYER_ORDER),
    kinds: new Set(DEFAULT_KINDS),
    resources: new Set(RESOURCES),
    allResources: RESOURCES,
    layerOrder: LAYER_ORDER,
    // Node positions the user has dragged; cleared by "Reset layout".
    moved: {},
    linkedOnly: true,
    expanded: new Set(),
    panelTab: null,      // null = the panel picks by node kind

    // Navigation rail.
    sidebarTab: 'stage',        // 'stage' | 'db'
    treeFilter: '',             // narrows the tree only — never the canvas

    // Neighbour expansion. Keyed `${nodeId}|${direction}` so one press can be
    // retracted without unpicking overlapping walks from other nodes.
    reveals: {},
    depth: 2,
    focusRoot: null,            // set by the database tree; suspends filters
    /*
     * A whole search result on the canvas, rather than one node from it.
     *
     * "Show me every model that has a CustomerID" is a different question
     * from "take me to this one", and clicking 34 results one at a time is not
     * an answer to it. Same suspension of filters as focusRoot — the set is the
     * view — and mutually exclusive with it: two pins would each claim the
     * canvas. { ids, columns, label } where columns maps a node to the matched
     * column, so each card can open on the column that put it here.
     */
    resultSet: null,

    // Panel widths. null = the responsive clamp() default from styles.css;
    // a number is an explicit drag for this session only. Not persisted, so a
    // reload always returns to the size that fits the current window.
    railW: null,
    panelW: null,
    setRailW: railW => set({ railW }),
    setPanelW: panelW => set({ panelW }),

    // Command palette. Replaces the header's live filter box: two search inputs
    // with different behaviours in one header is how people stop trusting both.
    paletteOpen: false,
    setPaletteOpen: paletteOpen => set({ paletteOpen }),

    /*
     * Travel to a visual on the page layout without re-selecting it.
     *
     * The list you clicked from — "3 visuals on 3 pages" — exists *because*
     * of the current selection. Selecting the visual would recompute the
     * highlight from the visual, darkening the other two pages: the click
     * would destroy the answer it was part of. So this moves the view and
     * leaves the trace alone. Clicking the box on the layout still selects
     * it, for when the visual itself is the question.
     *
     * `nonce` so travelling twice to the same visual pulses twice.
     */
    reveal: null,
    revealVisual: visualId => set(s => ({
        history: [...s.history, snapshot(s)].slice(-HISTORY_CAP),
        tab: 'layout',
        // The panel came with you: without this the list you are walking
        // disappears at the moment you start walking it.
        selectionView: 'layout',
        reveal: {
            visualId,
            pageId: DATA.nodes[visualId]?.meta?.pageId || null,
            nonce: (s.reveal?.nonce || 0) + 1,
        },
    })),

    setTab: tab => set({ tab }),
    setSidebarTab: sidebarTab => set({ sidebarTab }),
    setTreeFilter: treeFilter => set({ treeFilter }),
    setDepth: depth => set({ depth }),
    setPanelTab: panelTab => set({ panelTab }),

    // A new search wipes revealed neighbours: expansion is scoped to the search
    // that produced it, so the canvas can never accumulate state you cannot see.
    setLinkedOnly: linkedOnly => set({ linkedOnly }),

    /*
     * Two states, and light is where a report opens.
     *
     * This used to cycle system → dark → light → system. Starting from
     * `system`, the first press set `dark`, which on a machine already in dark
     * mode changed nothing visible — so the button read as broken and took two
     * or three presses to "work". A control whose first press can do nothing is
     * not worth the one preference it served.
     */
    toggleTheme: () => set(s => {
        const next = s.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        return { theme: next };
    }),

    /*
     * Changing a filter leaves focus mode.
     *
     * Focus pins the canvas to one node and deliberately suspends every filter,
     * so that a table clicked in the tree always appears. The cost is that
     * while focused, the eyes, the layer switches and "Hide all" all do
     * nothing — they set state that nothing reads. A control that visibly does
     * nothing is indistinguishable from a broken one, and the palette made this
     * reachable in one click by focusing whatever you pick.
     */
    toggleIn: (key, value) => set(s => {
        const next = new Set(s[key]);
        next.has(value) ? next.delete(value) : next.add(value);
        const filtering = FILTER_KEYS.has(key);
        return {
            [key]: next,
            blank: false,
            focusRoot: filtering ? null : s.focusRoot,
            resultSet: filtering ? null : s.resultSet,
        };
    }),

    setAll: (key, values) => set(s => ({
        [key]: new Set(values),
        blank: false,
        focusRoot: FILTER_KEYS.has(key) ? null : s.focusRoot,
        resultSet: FILTER_KEYS.has(key) ? null : s.resultSet,
    })),

    moveNode: (id, position) => set(s => ({ moved: { ...s.moved, [id]: position } })),
    resetLayout: () => set({ moved: {} }),

    /** Open or close a set of cards at once. See the canvas footer control. */
    setExpandedMany: (ids, open) => set(s => {
        const next = new Set(s.expanded);
        for (const id of ids) open ? next.add(id) : next.delete(id);
        return { expanded: next };
    }),

    toggleExpanded: id => set(s => {
        const next = new Set(s.expanded);
        next.has(id) ? next.delete(id) : next.add(id);
        return { expanded: next };
    }),

    /*
     * Where you were before this press.
     *
     * Navigation here is destructive by design — focusing wipes revealed
     * neighbours, a trace replaces the last one, "show all" replaces both —
     * and the alternative to Back is reconstructing the previous view by
     * hand: re-search the node, re-expand, re-focus. One press instead.
     *
     * The snapshot is the navigable state only. Filters, theme and panel
     * widths are settings rather than places, so Back does not rewind them
     * — pressing Back and finding your rail filters reset would be its own
     * kind of surprise.
     */
    history: [],
    pushHistory: () => set(s => ({ history: [...s.history, snapshot(s)].slice(-HISTORY_CAP) })),
    goBack: () => set(s => {
        if (!s.history.length) return {};
        const history = s.history.slice(0, -1);
        return { ...s.history[s.history.length - 1], history };
    }),

    /*
     * Trace something on the lineage canvas, from wherever you are.
     *
     * One action rather than `setTab` then `focusOn` at each call site, because
     * the snapshot has to be taken before *any* of it moves. Composed from the
     * outside, the tab had already changed by the time history recorded it, so
     * Back returned you to the lineage tab you were already looking at — it
     * re-ran the trace and looked like a refresh.
     */
    traceOnCanvas: (nodeId, column = null) => {
        get().pushHistory();
        set({ blank: false, tab: 'lineage', focusRoot: nodeId, resultSet: null, reveals: {}, moved: {} });
        get().select(nodeId, column, { record: false });
    },

    /*
     * Inspect something without touching the other tab.
     *
     * A click changes the view you are looking at; moving a trace to the
     * lineage canvas takes a deliberate press. Picking a box on the page
     * layout used to recompute `highlight`, which is the lineage tab's state
     * — so you switched over and found a canvas lit up around a visual you
     * never traced, with nothing on screen accounting for it. The panel opens
     * either way; only the trace is left alone.
     */
    selectLocal: (nodeId, column = null) => set(s => (
        nodeId
            ? {
                history: [...s.history, snapshot(s)].slice(-HISTORY_CAP),
                selection: { nodeId, column }, panelTab: null, selectionView: s.tab,
            }
            : { selection: null }
    )),

    select: (nodeId, column = null, { record = true } = {}) => {
        if (!nodeId) return set({ selection: null, highlight: null });
        // focusOn records its own snapshot before it moves anything, so the
        // select it makes on the way must not record a second one — Back would
        // then need two presses to undo one.
        if (record) get().pushHistory();
        const down = trace(nodeId, column, 'down');
        const up = trace(nodeId, column, 'up');
        // Merged so a node reached exactly in one direction is not marked
        // inferred because the other direction reached it loosely.
        const columns = new Map();
        for (const src of [down.columns, up.columns]) {
            for (const [id, set_] of src) {
                if (!columns.has(id)) columns.set(id, new Set());
                for (const c of set_) columns.get(id).add(c);
            }
        }
        const inferred = new Set(
            [...down.inferred, ...up.inferred].filter(id => !columns.has(id)));

        /*
         * A node that reaches nothing does not dim the canvas.
         *
         * Some Power BI visuals genuinely have no lineage — a shape, a text box,
         * a background image bind no fields, and the panel says so. Tracing one
         * produced a highlight of exactly itself, which greyed every other card
         * on screen to make a point about a node that has nothing to point at.
         * That reads as a broken trace rather than as an empty one.
         *
         * So an empty result clears the highlight instead: the selection still
         * stands, the card still reads as selected, the panel still explains,
         * and the rest of the graph stays legible.
         */
        const reached = down.edgeIdx.size + up.edgeIdx.size;

        set({
            selection: { nodeId, column },
            selectionView: get().tab,
            // null, not 'overview': which tab a node opens on depends on what
            // that kind of node is usually opened for, and the panel is what
            // knows that. See tabsFor() in SidePanel.
            panelTab: null,
            highlight: reached ? {
                nodes: new Set([...down.nodes, ...up.nodes]),
                edges: new Map([...down.edgeIdx, ...up.edgeIdx]),
                columns,
                inferred,
                inferredEdges: new Set([...down.inferredEdges, ...up.inferredEdges]),
            } : null,
        });
    },

    /**
     * Reveal `hops` of neighbours from a node. Revealed nodes bypass every
     * filter — the whole point is to see what search would otherwise hide.
     */
    expandFrom: (nodeId, direction, hops) => set(s => ({
        reveals: {
            ...s.reveals,
            [`${nodeId}|${direction}`]: [...walk(nodeId, direction, hops, ADJ, DATA.nodes)],
        },
    })),

    /** Undo one press, leaving neighbours revealed by other presses in place. */
    retract: (nodeId, direction) => set(s => {
        const { reveals, removed } = retractCascade(s.reveals, `${nodeId}|${direction}`);
        return { reveals, moved: forgetDragged(removed, reveals, s.moved) };
    }),

    /*
     * Which menu item is pre-highlighted, per card kind.
     *
     * Sticky, and *only* pre-highlighting: the menu always opens, so this never
     * silently applies a choice made twenty minutes ago on a different card. It
     * exists because someone auditing measures does it to ten tables in a row
     * and should not have to move the cursor ten times. Not persisted — session
     * only, for the same reason.
     */
    revealPick: Object.fromEntries(
        Object.keys(REVEAL_MENUS).map(k => [k, defaultPick(k)])),

    /** Reveal one kind from one card, and remember the choice for that kind. */
    revealKind: (nodeId, cardKind, item) => set(s => ({
        reveals: {
            ...s.reveals,
            [revealKey(nodeId, item.kind)]: revealNeighbours(nodeId, item, ADJ, DATA.nodes),
        },
        revealPick: { ...s.revealPick, [cardKind]: item.kind },
    })),

    /** Drop one kind, leaving the other kinds this card revealed in place. */
    retractKind: (nodeId, kind) => set(s => {
        const { reveals, removed } = retractCascade(s.reveals, revealKey(nodeId, kind));
        return { reveals, moved: forgetDragged(removed, reveals, s.moved) };
    }),

    /** How many nodes a press would add — drives the large-expansion guard. */
    previewExpand: (nodeId, direction, hops) => {
        const already = get().revealedIds();
        let added = 0;
        for (const id of walk(nodeId, direction, hops, ADJ, DATA.nodes)) {
            if (!already.has(id)) added++;
        }
        return added;
    },

    revealedIds: () => {
        const out = new Set();
        for (const ids of Object.values(get().reveals)) for (const id of ids) out.add(id);
        return out;
    },

    /** Database-tree click: put one table on an otherwise empty canvas. */
    focusOn: nodeId => {
        get().pushHistory();
        set({ blank: false, focusRoot: nodeId, resultSet: null, reveals: {}, moved: {} });
        get().select(nodeId, null, { record: false });
    },

    /*
     * Put a whole result set on the canvas.
     *
     * The column marks are handed to `highlight` rather than to a new mechanism:
     * a card already knows how to light the columns it was reached by, and this
     * is the same question asked of a set instead of a path. There are no edges
     * to light — these nodes were matched by name, not by lineage, and drawing
     * them as a path would claim a relationship that does not exist.
     */
    showResults: (rows, label) => {
        const ids = new Set();
        const columns = new Map();
        for (const row of rows) {
            ids.add(row.id);
            if (!row.column) continue;
            if (!columns.has(row.id)) columns.set(row.id, new Set());
            columns.get(row.id).add(lower(row.column));
        }
        if (!ids.size) return;
        get().pushHistory();
        set({
            // Same reason as traceOnCanvas: the tab moves as part of the
            // navigation, after the snapshot, not before it.
            tab: 'lineage',
            blank: false,
            resultSet: { ids, columns, label },
            focusRoot: null,
            selection: null,
            reveals: {},
            moved: {},
            // Only the cards that matched on a column open; a card matched by
            // its own name has nothing to show yet.
            expanded: new Set(columns.keys()),
            highlight: {
                nodes: new Set(ids),
                edges: new Map(),
                columns,
                inferred: new Set(),
                inferredEdges: new Set(),
            },
        });
    },

    clearFocus: () => set({ focusRoot: null, resultSet: null, reveals: {} }),

    hasNeighbours,

    /** Selected node's impact, scoped to the column when one is picked. */
    currentImpact: () => {
        const { selection, data } = get();
        if (!selection) return null;
        return selection.column
            ? data.impact.column[`${selection.nodeId}|${selection.column}`]
            : data.impact.node[selection.nodeId];
    },
}));

export { KINDS, DEFAULT_KINDS, resourceOf, hasNeighbours };
