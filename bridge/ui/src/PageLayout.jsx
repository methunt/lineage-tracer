import React from 'react';
import { useStore, DATA } from './store';
import { IconHide, IconPage, IconTarget, IconPlus, IconMinus, IconFit, visualIcon } from './icons';
import Resizer from './Resizer';

/*
 * The report as its author drew it, rather than as a graph.
 *
 * "Which visuals break?" has an answer in the lineage tab already — a list of
 * names. This is the same answer pointed at: that box, on that page, in that
 * corner. A name tells you what to look for; a position tells you where to
 * look, and whether it is the headline number or a footnote.
 *
 * Deliberately a wireframe. Real fidelity — fills, fonts, actual rendered
 * values — would invite the reader to treat it as a preview and then judge it
 * for being wrong. A box promises structure, which is all `position` can
 * honestly deliver.
 */

/** Pages in the order the author put them, straight from pages.json. */
function pageNodes() {
    return Object.values(DATA.nodes)
        .filter(n => n.kind === 'page')
        .sort((a, b) => (a.meta?.order ?? 1e9) - (b.meta?.order ?? 1e9)
            || a.name.localeCompare(b.name));
}

/**
 * The visuals on a page, in the order Power BI paints them.
 *
 * Group containers are dropped: the author drew them around other visuals, and
 * a box around boxes says nothing about what breaks. Their children are here in
 * their own right, already carrying absolute coordinates.
 *
 * Ordering compares the ancestor chain of z values outermost-first, so a
 * group's background stays behind its own members and still above whatever
 * sits under a lower-ranked group. See pbi-graph.js.
 */
function visualsOf(pageId) {
    const zPath = n => n.meta?.position?.zPath || [n.meta?.position?.z ?? 0];
    return Object.values(DATA.nodes)
        .filter(n => n.kind === 'visual' && n.meta?.pageId === pageId && !n.meta?.isGroup)
        .sort((a, b) => {
            const [p, q] = [zPath(a), zPath(b)];
            for (let i = 0; i < Math.max(p.length, q.length); i++) {
                const d = (p[i] ?? -1) - (q[i] ?? -1);
                if (d) return d;
            }
            return 0;
        });
}

/** One page in the rail. */
function PageRow({ node, active, hits, anyHits, onPick }) {
    const m = node.meta || {};
    return (
        <button
            data-testid="page-row"
            data-page-id={m.pageId}
            onClick={() => onPick(node.id)}
            /* A page name can outrun any rail width the reader is willing to
               give it, so the full name is always one hover away. */
            title={node.name}
            className="w-full flex items-center gap-2 px-3 py-2 text-left rounded-md"
            style={{
                background: active ? 'var(--accent-soft)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text)',
            }}
        >
            <IconPage size="sm" style={{ color: active ? 'var(--accent)' : 'var(--muted)' }} />
            <span className="flex-1 truncate">{node.name}</span>
            {/*
             * With something selected, the number that matters is how many of
             * this page's visuals it reaches — otherwise "3 visuals on 3 pages"
             * means opening all eleven pages to find which three. The visual
             * count is what tells a real page from a tooltip stub (38 against
             * 1), so it stays when nothing is selected.
             */}
            {anyHits ? (
                <span data-testid="page-hits" data-hits={hits}
                    className="tnum flex-none px-1.5 rounded-full"
                    style={{
                        background: hits ? 'var(--accent-soft)' : 'transparent',
                        color: hits ? 'var(--accent)' : 'var(--muted)',
                        fontSize: 'var(--fs-sm)',
                    }}>
                    {hits || '—'}
                </span>
            ) : (
                <span className="tnum flex-none" style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                    {m.visualCount ?? 0}
                </span>
            )}
            {m.hidden && (
                <IconHide size="sm" data-testid="page-hidden"
                    style={{ color: 'var(--muted)' }}
                    aria-label="Hidden in view mode" />
            )}
        </button>
    );
}

/** One visual, drawn at its real coordinates inside the page frame. */
function VisualBox({ node, scale, order, lit, dim, selected, pulse, onPick }) {
    const p = node.meta?.position || {};
    const Icon = visualIcon(node.meta?.visualType);
    /*
     * Page coordinates, unscaled: the frame carries the zoom as a CSS
     * transform, so scaling here too rendered everything at scale² and packed
     * the whole report into the top-left third of its own page.
     *
     * `scale` is still needed to decide what is legible, which is a question
     * about pixels on screen rather than about the page.
     */
    const w = p.width || 0;
    const h = p.height || 0;
    // Below this a label is unreadable and the box reads better as a plain
    // rectangle than as clipped text.
    const roomy = w * scale > 90 && h * scale > 34;
    return (
        <button
            data-testid="layout-visual"
            data-lit={lit || undefined}
            data-pulse={pulse || undefined}
            data-selected={selected || undefined}
            onClick={e => { e.stopPropagation(); onPick(node.id); }}
            title={`${node.name}${node.meta?.visualType ? ` · ${node.meta.visualType}` : ''}`}
            className={`absolute overflow-hidden rounded-[3px] text-left${pulse ? ' is-arrived' : ''}`}
            style={{
                left: p.x || 0,
                top: p.y || 0,
                width: w,
                height: h,
                // Hairlines, not hairlines-times-zoom: a 2px border at 34%
                // would vanish, and at 300% would read as a frame.
                border: `${(lit || selected ? 2 : 1) / scale}px solid ${lit || selected ? 'var(--accent)' : 'var(--border)'}`,
                background: lit ? 'var(--accent-soft)' : 'var(--panel)',
                /*
                 * Dimming is a step back, not a fade to nothing. At 0.45 the
                 * page went so pale that the surrounding layout — the thing
                 * that makes a position mean anything — stopped being legible,
                 * which defeats the point of showing the page at all.
                 */
                opacity: dim ? 0.72 : 1,
                // The report's own paint order, except that a lit box is never
                // buried under the backdrop that happens to sit above it.
                zIndex: pulse ? 100001 : lit || selected ? 100000 : order,
                transition: 'opacity var(--dur-base) var(--ease), background var(--dur-base) var(--ease)',
            }}
        >
            {roomy && (
                /*
                 * The label is counter-scaled so it stays the same size on
                 * screen at any zoom. Inside the transformed frame it would
                 * otherwise shrink with the page — 12px text at a 34% fit is
                 * 4px, which is a smudge, not a name.
                 */
                <span className="flex items-center gap-1.5 px-1.5 py-1 origin-top-left"
                    style={{ transform: `scale(${1 / scale})`, width: `${100 / scale}%` }}>
                    <Icon size={14} style={{ color: lit ? 'var(--accent)' : 'var(--muted)' }} />
                    <span className="truncate" style={{
                        fontSize: 'var(--fs-sm)',
                        color: lit ? 'var(--accent)' : 'var(--muted)',
                    }}>{node.name}</span>
                </span>
            )}
        </button>
    );
}

export default function PageLayout() {
    const pages = React.useMemo(pageNodes, []);
    const [pageId, setPageId] = React.useState(() => pages[0]?.id || null);
    /* Local: a click here opens the panel, it does not retrace the lineage
       canvas next door. The button on the panel does that, deliberately. */
    const select = useStore(s => s.selectLocal);
    const selection = useStore(s => s.selection);
    const highlight = useStore(s => s.highlight);
    const frameRef = React.useRef(null);
    const [box, setBox] = React.useState({ w: 0, h: 0 });
    /*
     * The viewport, as a canvas rather than a scroll box.
     *
     * `view` is null while the page is framed to fit — the fit is recomputed
     * from the window, so it survives a resize or a panel opening. The moment
     * you zoom or pan it becomes an explicit {k, x, y} and stays where you put
     * it. Modelled on the lineage canvas next door, which is the interaction
     * anyone opening this report has already learned.
     */
    const [view, setView] = React.useState(null);
    const [pulse, setPulse] = React.useState(null);
    const reveal = useStore(s => s.reveal);
    /* The same width as the lineage rail, and the same handle. Two navigation
       rails that resize differently are two things to learn. */
    const railW = useStore(s => s.railW);
    const setRailW = useStore(s => s.setRailW);
    const panRef = React.useRef(null);

    const page = pages.find(p => p.id === pageId) || pages[0] || null;
    const visuals = React.useMemo(
        () => (page ? visualsOf(page.meta.pageId) : []), [page]);

    /*
     * How many of each page's visuals the current trace reaches. This is the
     * whole point of the view: the lineage tab can already say "3 visuals on 3
     * pages", and this says which three, and where on each.
     */
    const hitsByPage = React.useMemo(() => {
        const out = new Map();
        if (!highlight?.nodes) return out;
        for (const id of highlight.nodes) {
            const n = DATA.nodes[id];
            if (n?.kind !== 'visual') continue;
            const pid = `pbi:page:${n.meta?.pageId}`;
            out.set(pid, (out.get(pid) || 0) + 1);
        }
        return out;
    }, [highlight]);
    const anyHits = hitsByPage.size > 0;

    /*
     * Follow the selection. A page or visual picked in the lineage tab opens
     * here directly; a *column* has no page of its own, so open the first page
     * its trace actually reaches — landing on page one showing nothing lit is
     * indistinguishable from the feature being broken.
     */
    React.useEffect(() => {
        const sel = selection?.nodeId && DATA.nodes[selection.nodeId];
        if (!sel) return;
        const direct = sel.kind === 'page' ? sel.id
            : sel.kind === 'visual' ? `pbi:page:${sel.meta?.pageId}` : null;
        if (direct && DATA.nodes[direct]) { setPageId(direct); return; }
        if (!hitsByPage.size) return;
        setPageId(current => (hitsByPage.get(current)
            ? current                                  // already on a page with hits
            : pages.find(p => hitsByPage.get(p.id))?.id || current));
    }, [selection, hitsByPage, pages]);

    // Each page is fitted on its own: a 980×157 tooltip is a different medium
    // from a 1750×2326 report page, not a small version of one.
    React.useEffect(() => {
        const el = frameRef.current;
        if (!el) return;
        const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
        const obs = new ResizeObserver(measure);
        obs.observe(el);
        measure();
        return () => obs.disconnect();
    }, []);

    // A new page gets a fresh fit: carrying 180% from a tooltip onto a
    // 1750×2396 page drops the reader into its top-left corner.
    React.useEffect(() => { setView(null); }, [pageId]);

    /*
     * Arriving from an "affected visuals" list. Landing on a page with four
     * lit boxes and no idea which one you clicked is barely better than not
     * travelling at all, so the one you asked for pulses — motion for "here",
     * rather than a second permanent state to decode against `lit`. Back to
     * the fitted view too, or a box you zoomed away from is off-screen.
     */
    React.useEffect(() => {
        if (!reveal?.visualId) return;
        const pid = `pbi:page:${reveal.pageId}`;
        if (DATA.nodes[pid]) setPageId(pid);
        setView(null);
        setPulse(reveal.visualId);
        const t = setTimeout(() => setPulse(null), 1600);
        return () => clearTimeout(t);
    }, [reveal?.nonce]);

    if (!pages.length) {
        return (
            <div className="flex-1 grid place-items-center" style={{ color: 'var(--muted)' }}>
                <div className="text-center">
                    <div className="font-semibold" style={{ color: 'var(--text)' }}>No report pages</div>
                    <div className="mt-1" style={{ fontSize: 'var(--fs-sm)' }}>
                        This build has no PBIP report folder, or it holds no pages.
                    </div>
                </div>
            </div>
        );
    }

    const pw = page?.meta?.width || 1280;
    const ph = page?.meta?.height || 720;
    /*
     * Fit both dimensions, not just the width.
     *
     * Pages differ in shape as well as size — 1750×2396 next to 980×157 — and
     * fitting width alone left the tall ones running off the bottom with no
     * way to see the page as a whole, which is the one thing this view is for.
     * Above the fit, scrolling takes over.
     */
    const fit = box.w && box.h
        ? Math.min((box.w - 48) / pw, (box.h - 48) / ph, 1)
        : 0;
    // The framed view, centred. Both the initial state and what "fit" returns
    // to, so the button and the default can never disagree.
    const fitView = {
        k: fit,
        x: (box.w - pw * fit) / 2,
        y: (box.h - ph * fit) / 2,
    };
    const { k: scale, x: panX, y: panY } = view || fitView;

    /** Zoom about a point in viewport space, so the cursor stays put. */
    const zoomAt = (factor, cx, cy) => setView(v => {
        const cur = v || fitView;
        const k = Math.min(4, Math.max(0.05, cur.k * factor));
        if (k === cur.k) return cur;
        // Keep the page coordinate under the cursor fixed: solve
        // (c - x)/k for the old view and put it back at the new k.
        return {
            k,
            x: cx - (cx - cur.x) * (k / cur.k),
            y: cy - (cy - cur.y) * (k / cur.k),
        };
    });

    const onWheel = e => {
        e.preventDefault();
        const r = frameRef.current.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };

    // Drag anywhere on the canvas pans. Buttons stop the event themselves, so
    // dragging never starts on a visual.
    const onPointerDown = e => {
        if (e.button !== 0) return;
        const cur = view || fitView;
        panRef.current = {
            px: e.clientX, py: e.clientY, x: cur.x, y: cur.y, moved: false,
            onVisual: Boolean(e.target.closest?.('[data-testid="layout-visual"]')),
        };
    };
    const onPointerMove = e => {
        const p = panRef.current;
        if (!p) return;
        const dx = e.clientX - p.px;
        const dy = e.clientY - p.py;
        if (!p.moved && Math.hypot(dx, dy) < 3) return;   // a click, not a drag
        /*
         * Capture starts here, not on pointerdown.
         *
         * Capturing up front retargets the whole gesture to the canvas,
         * including the `click` that follows — so pressing a visual panned
         * nothing and selected nothing, because its own click never fired.
         * Claiming the pointer only once the gesture is provably a drag leaves
         * a plain press to behave like a plain press.
         */
        if (!p.moved) e.currentTarget.setPointerCapture?.(e.pointerId);
        p.moved = true;
        setView(v => ({ k: (v || fitView).k, x: p.x + dx, y: p.y + dy }));
    };
    const onPointerUp = e => {
        const p = panRef.current;
        panRef.current = null;
        if (p?.moved) e.currentTarget.releasePointerCapture?.(e.pointerId);
        /*
         * A press on the background does nothing.
         *
         * It used to clear the selection, the way the lineage canvas does, and
         * on a page layout that reads as a misfire rather than as a command. The
         * blank space here is not blank: a report's own empty area is full of
         * unlabelled boxes, group containers and stretched backdrops, so a press
         * meant for nothing frequently lands on something. And when it did clear,
         * it half-cleared — the panel and the caption went while a stale trace
         * stayed lit — which reads as the page ignoring you.
         *
         * Escape is the deliberate way to clear this view, and being deliberate
         * is the point: nothing is lost to a stray click on a canvas whose empty
         * space cannot be identified by eye.
         */
    };

    // Anything the current trace reaches. With nothing selected there is no
    // "lit" and no "dim" — every box is simply itself.
    const litSet = highlight?.nodes;
    /*
     * What the note names. The column when one was traced, because
     * `ProductSizeKey` is the thing the reader picked and `map_products…`
     * is only where it lives.
     */
    const tracedNode = selection?.nodeId && DATA.nodes[selection.nodeId];
    const traced = tracedNode
        ? (selection.column ? `${tracedNode.name}.${selection.column}` : tracedNode.name)
        : null;
    const hitsHere = visuals.filter(v => litSet?.has(v.id)).length;
    /* A press on this tab, so it may clear the trace: what the rule forbids is
       a click changing a tab you cannot see, not one you asked for here. */
    // The same action Escape runs. On this tab that is exactly what the caption
    // offers: drop what is marking this page, and leave the other tab's filters
    // where the reader set them.
    const clearTrace = useStore(s => s.escape);

    return (
        <div className="flex-1 min-h-0 flex">
            <aside className="surface flex-none flex flex-col overflow-hidden"
                style={{ width: railW ?? 'var(--rail-w)' }}>
                <div className="px-3 py-2.5 border-b flex items-center justify-between"
                    style={{ borderColor: 'var(--border)' }}>
                    <span className="font-semibold">Pages</span>
                    <span className="tnum" style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                        {pages.length}
                    </span>
                </div>
                <div className="flex-1 overflow-auto scrollbar-thin p-1.5" role="tablist"
                    aria-label="Report pages">
                    {pages.map(p => (
                        <PageRow key={p.id} node={p} active={p.id === page?.id}
                            hits={hitsByPage.get(p.id) || 0} anyHits={anyHits}
                            onPick={setPageId} />
                    ))}
                </div>
                <div className="px-3 py-2 border-t" style={{
                    borderColor: 'var(--border)', color: 'var(--muted)', fontSize: 'var(--fs-sm)',
                }}>
                    Order and hidden flags come from the report, not from us.
                </div>
            </aside>
            <Resizer side="left" width={railW} onChange={setRailW} min={200} max={520} />

            <div className="surface flex-1 min-w-0 flex flex-col overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-2.5 border-b flex-none"
                    style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
                    <span className="font-semibold truncate">{page?.name}</span>
                    {page?.meta?.hidden && (
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full border"
                            style={{
                                borderColor: 'var(--border)', color: 'var(--muted)',
                                fontSize: 'var(--fs-sm)',
                            }}>
                            <IconHide size="sm" /> hidden in view mode
                        </span>
                    )}
                    {page?.meta?.isLanding && (
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full border"
                            style={{
                                borderColor: 'var(--accent)', color: 'var(--accent)',
                                fontSize: 'var(--fs-sm)',
                            }}>
                            <IconTarget size="sm" /> report landing page
                        </span>
                    )}
                    <span className="flex-1" />
                    <span className="tnum" style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                        {visuals.length} visual{visuals.length === 1 ? '' : 's'} · {pw}×{ph}
                    </span>
                </div>

                {/*
                 * Why these boxes are lit.
                 *
                 * The lighting is this tab's reason to exist — "3 visuals on 3
                 * pages" is a list until you can see which three, and where.
                 * But arriving to find it already applied, with nothing on
                 * screen accounting for it, reads as the two tabs being wired
                 * together behind your back. The pixels are the same; the
                 * caption is what turns them from something that happened to
                 * your tab into an answer to your question. And it carries the
                 * way out, so the automatic behaviour is never a trap.
                 */}
                {litSet && traced && (
                    <div className="trace-note" data-testid="trace-note">
                        <IconTarget size="sm" className="flex-none" />
                        <span className="flex-1 min-w-0">
                            Showing what <b>{traced}</b> affects —{' '}
                            <b className="tnum">{hitsHere}</b> of {visuals.length} visual
                            {visuals.length === 1 ? '' : 's'} on this page
                        </span>
                        {/* Clears the marks on this view, not just the trace.
                            As `select(null)` it dropped the trace and the
                            selection and left the travelled-to box outlined —
                            "clear" that visibly does not clear reads as the
                            page ignoring the press. */}
                        <button data-testid="trace-note-clear" onClick={clearTrace}
                            className="trace-note-clear">clear</button>
                    </div>
                )}

                <div
                    ref={frameRef}
                    className="relative flex-1 min-h-0 overflow-hidden page-canvas"
                    onWheel={onWheel}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    onDoubleClick={() => setView(null)}
                    style={{ cursor: panRef.current ? 'grabbing' : 'grab', touchAction: 'none' }}
                >
                    {/* The page frame. Its aspect ratio is the report's, so a
                        tall page reads as tall rather than being squashed into
                        a viewport it was never designed for. Positioned by
                        transform rather than by layout: the browser composites
                        it, so panning a 38-visual page does not relayout. */}
                    <div
                        data-testid="page-frame"
                        className="absolute top-0 left-0 origin-top-left rounded-[var(--r-md)]"
                        style={{
                            width: pw,
                            height: ph,
                            transform: `translate(${panX}px, ${panY}px) scale(${scale})`,
                            background: 'var(--panel)',
                            border: '1px solid var(--border)',
                            boxShadow: 'var(--sh-1)',
                        }}
                    >
                        {scale > 0 && visuals.map((v, i) => (
                            <VisualBox
                                key={v.id}
                                node={v}
                                scale={scale}
                                order={i + 1}
                                lit={Boolean(litSet?.has(v.id))}
                                dim={Boolean(litSet && !litSet.has(v.id))}
                                /* The pulse says "here" and then stops. What
                                   you came for still has to be findable a
                                   minute later, so the box you arrived at
                                   keeps the outline until the next trip —
                                   without being *selected*, which would swap
                                   the panel and lose the list you are
                                   walking. */
                                selected={selection?.nodeId === v.id
                                    || reveal?.visualId === v.id}
                                pulse={pulse === v.id}
                                onPick={id => select(id)}
                            />
                        ))}
                    </div>

                    {/* Floating, over the canvas, the way the lineage tab does
                        it — a toolbar in the header spends a strip of page on
                        three buttons and reads as a document, not a canvas. */}
                    <div className="canvas-dock" onPointerDown={e => e.stopPropagation()}>
                        <button onClick={() => zoomAt(1 / 1.25, box.w / 2, box.h / 2)}
                            aria-label="Zoom out"><IconMinus size="sm" /></button>
                        <button onClick={() => setView(null)} data-testid="layout-fit"
                            title="Fit the page to the window"
                            className="tnum" style={{ minWidth: 52 }}>
                            {Math.round(scale * 100)}%
                        </button>
                        <button onClick={() => zoomAt(1.25, box.w / 2, box.h / 2)}
                            aria-label="Zoom in"><IconPlus size="sm" /></button>
                        <span className="canvas-dock-sep" />
                        <button onClick={() => setView(null)} aria-label="Fit to window">
                            <IconFit size="sm" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
