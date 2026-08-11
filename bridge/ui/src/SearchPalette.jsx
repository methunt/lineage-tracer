import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, DATA } from './store';
import { KIND_COLOR } from './theme';
import { nodeIcon, columnIcon, IconSearch, IconX, IconChevronDown, IconCheck } from './icons';

/*
 * What a result can be, and what the attribute facet offers.
 *
 * A node and one of its columns are different results with different actions —
 * "take me to dim_customer" and "take me to dim_customer.CustomerKey" are
 * not the same request — so the index holds both, and the facet is the vocabulary
 * a reader already uses for them. Measures, visuals and pages are included
 * rather than left out: they are searchable, people hunt for a measure by name,
 * and a palette that cannot find `# Orders` gets abandoned.
 */
const ATTRS = [
    { key: 'dbtModel', label: 'model', group: 'dbt' },
    { key: 'dbtColumn', label: 'column', group: 'dbt' },
    { key: 'pbiTable', label: 'table', group: 'Power BI' },
    { key: 'pbiColumn', label: 'column', group: 'Power BI' },
    { key: 'measure', label: 'measure', group: 'Power BI' },
    { key: 'visual', label: 'visual', group: 'Power BI' },
    { key: 'page', label: 'report page', group: 'Power BI' },
];

/* The result row still has to say which side it came from with no header above
 * it to lean on, so it keeps the qualified name the grouped menu can drop. */
const ATTR_FULL = {
    dbtModel: 'dbt model', dbtColumn: 'dbt column',
    pbiTable: 'Power BI table', pbiColumn: 'Power BI column',
    measure: 'measure', visual: 'visual', page: 'report page',
};

/* Fixed row height, in px. The virtual list positions by arithmetic, so a row
   that could grow taller than this would overlap its neighbour — the row below
   is one line, clipped, by construction. */
const ROW_H = 34;
const OVERSCAN = 6;      // rows built above and below the viewport

function attrOf(node, isColumn) {
    if (node.origin === 'pbi') {
        if (node.kind === 'measure') return 'measure';
        if (node.kind === 'visual') return 'visual';
        if (node.kind === 'page') return 'page';
        return isColumn ? 'pbiColumn' : 'pbiTable';
    }
    return isColumn ? 'dbtColumn' : 'dbtModel';
}

/**
 * The names a field is read under in the report, lowercased for matching.
 *
 * A field renamed inside a visual is known to its readers by a name the model
 * has never heard of, and that name is the only one they can tell you. Absent on
 * everything that is not renamed, and on every graph built before renames were
 * extracted, so `|| []` is the whole compatibility story.
 */
const aliasesOf = source => (source?.aliases || []).map(a => a.name);

/** Every node and every column, flattened once — a few thousand entries on a large project. */
function buildIndex() {
    const rows = [];
    for (const node of Object.values(DATA.nodes)) {
        rows.push({
            id: node.id,
            column: null,
            label: node.name,
            hint: node.kind === 'measure' ? node.meta?.homeTable || '' : node.meta?.relation || node.layer,
            attr: attrOf(node, false),
            layer: node.layer,
            tags: node.meta?.tags || [],
            /*
             * Searchable, but never the label. Emitting one row per alias would
             * put the same measure in the list three times under three names,
             * and the prefix-and-length sort would interleave them; folding the
             * aliases into the label would corrupt both the display and the
             * sort. So the row keeps its real identity and matches on the side.
             */
            aliases: aliasesOf(node.meta),
            node,
        });
        for (const col of node.columns || []) {
            rows.push({
                id: node.id,
                column: col.name,
                label: col.name,
                hint: node.name,
                attr: attrOf(node, true),
                layer: node.layer,
                tags: node.meta?.tags || [],
                aliases: aliasesOf(col),
                node,
                dataType: col.dataType,
            });
        }
    }
    return rows;
}

/** A facet button with a checklist under it. All values on = no restriction. */
function Facet({ label, values, chosen, onToggle, onGroup, note }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
        if (!open) return;
        const away = e => { if (!ref.current?.contains(e.target)) setOpen(false); };
        document.addEventListener('mousedown', away);
        return () => document.removeEventListener('mousedown', away);
    }, [open]);

    const active = chosen.size > 0 && chosen.size < values.length;
    return (
        <div className="relative" ref={ref}>
            <button
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border"
                style={{
                    borderColor: active ? 'var(--accent)' : 'var(--border)',
                    color: active ? 'var(--accent)' : 'var(--muted)',
                    background: 'var(--panel-2)', fontSize: 'var(--fs-sm)',
                }}
            >
                {label}{active ? ` · ${chosen.size}` : ''}
                <IconChevronDown size="sm" />
            </button>
            {open && (
                <div className="absolute z-20 mt-1 rounded-md border max-h-[280px] overflow-auto scrollbar-thin"
                    style={{
                        background: 'var(--panel)', borderColor: 'var(--border)',
                        boxShadow: 'var(--sh-2)', minWidth: 200,
                    }}>
                    {note && (
                        <div className="px-3 pt-2 pb-1" style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                            {note}
                        </div>
                    )}
                    {values.map((v, i) => (
                        <React.Fragment key={v.key}>
                            {v.group && v.group !== values[i - 1]?.group && (
                                /* The header is a control, not a caption: grouping
                                   only pays for itself if "everything dbt" is one
                                   click rather than four. */
                                <button
                                    data-facet-group={v.group}
                                    onClick={() => onGroup?.(v.group)}
                                    className="w-full flex items-center justify-between px-3 pt-2 pb-1 text-left"
                                    style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}
                                >
                                    <span className="uppercase tracking-wide">{v.group}</span>
                                    <span>all</span>
                                </button>
                            )}
                            <button
                                data-facet-option={v.key}
                                onClick={() => onToggle(v.key)}
                                className="w-full flex items-center gap-2 px-3 py-1.5 text-left"
                                style={{ color: 'var(--text)' }}
                            >
                                <span className="w-4 flex-none" style={{ color: 'var(--accent)' }}>
                                    {chosen.has(v.key) ? <IconCheck size="sm" /> : null}
                                </span>
                                <span className="flex-1 truncate">{v.label}</span>
                                {v.count != null && (
                                    <span className="tnum" style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                                        {v.count}
                                    </span>
                                )}
                            </button>
                        </React.Fragment>
                    ))}
                </div>
            )}
        </div>
    );
}

export default function SearchPalette() {
    const open = useStore(s => s.paletteOpen);
    const setOpen = useStore(s => s.setPaletteOpen);
    const traceOnCanvas = useStore(s => s.traceOnCanvas);
    const setExpandedMany = useStore(s => s.setExpandedMany);
    const showResults = useStore(s => s.showResults);
    const layerOrder = useStore(s => s.layerOrder);

    const [q, setQ] = useState('');
    const [attrs, setAttrs] = useState(() => new Set());
    const [layers, setLayers] = useState(() => new Set());
    const [tags, setTags] = useState(() => new Set());
    const [cursor, setCursor] = useState(0);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewH, setViewH] = useState(400);
    const inputRef = useRef(null);
    const listRef = useRef(null);

    const index = useMemo(() => (open ? buildIndex() : []), [open]);

    const tagValues = useMemo(() => {
        const counts = new Map();
        for (const node of Object.values(DATA.nodes)) {
            for (const t of node.meta?.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1])
            .map(([key, count]) => ({ key, label: key, count }));
    }, [open]);

    const results = useMemo(() => {
        const needle = q.trim().toLowerCase();
        if (!needle && !attrs.size && !layers.size && !tags.size) return [];
        const out = [];
        for (const row of index) {
            if (attrs.size && !attrs.has(row.attr)) continue;
            if (layers.size && !layers.has(row.layer)) continue;
            if (tags.size && !row.tags.some(t => tags.has(t))) continue;
            if (needle) {
                const hay = row.label.toLowerCase();
                if (hay.includes(needle)) {
                    // Prefix matches first, then shorter names: `Region` should not put
                    // `RegionCategoryGlobalKey` above `Region`.
                    out.push([hay.startsWith(needle) ? 0 : 1, row.label.length, row]);
                    continue;
                }
                /*
                 * Then the names the report renamed it to. Ranked below every
                 * real-name match, because the model's own name is the stronger
                 * signal — someone typing a word that is also a real measure
                 * name wants that measure before one merely labelled that way in
                 * a card. The matched alias rides on a copy of the
                 * row: the index is memoised and shared, and writing the match
                 * onto it would leak one query's alias into the next.
                 */
                const alias = row.aliases?.find(a => a.toLowerCase().includes(needle));
                if (!alias) continue;
                const rank = alias.toLowerCase().startsWith(needle) ? 2 : 3;
                out.push([rank, row.label.length, { ...row, matchedAlias: alias }]);
            } else {
                out.push([1, row.label.length, row]);
            }
        }
        out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].label.localeCompare(b[2].label));
        return out.map(r => r[2]);
    }, [index, q, attrs, layers, tags]);

    // What will actually land: two columns of the same model are two matches
    // and one card, so counting matches would promise a canvas twice its size.
    const cardCount = useMemo(
        () => new Set(results.map(r => r.id)).size, [results]);

    /*
     * Only the rows in view are built.
     *
     * Every row used to be a real element, so a broad query like `a` built
     * ~800 buttons between one keystroke and the next and threw them away on
     * the following one. That was what the old 60-row cap protected against,
     * at the price of a list that silently stopped short of the answer.
     *
     * The spacer below carries the full height, so the scrollbar is honest and
     * scrolling is continuous — this is not pagination, and nothing reflows as
     * you drag. Rows are a fixed height, which is what makes the arithmetic
     * exact rather than a guess.
     */
    const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(results.length,
        Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
    const window_ = results.slice(first, last);

    // A new query is a new list: back to the top, both cursor and scroll.
    useEffect(() => {
        setCursor(0);
        if (listRef.current) listRef.current.scrollTop = 0;
        setScrollTop(0);
    }, [q, attrs, layers, tags]);
    useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 0); }, [open]);

    /*
     * Keep the cursor visible — by arithmetic, not by asking the element.
     * scrollIntoView cannot work here: arrowing past the last built row means
     * the row to reveal does not exist yet, and the list would simply stop
     * following the cursor at the edge of the rendered window.
     */
    useEffect(() => {
        const list = listRef.current;
        if (!list) return;
        const top = cursor * ROW_H;
        if (top < list.scrollTop) list.scrollTop = top;
        else if (top + ROW_H > list.scrollTop + list.clientHeight) {
            list.scrollTop = top + ROW_H - list.clientHeight;
        }
    }, [cursor]);

    /*
     * The list is sized in vh and grows with its content, so its height must be
     * watched rather than read once. Measuring only on open caught it holding
     * the empty state: 100px, which built a 10-row window in a 494px list and
     * left arrow-down running off the end of the rendered rows.
     */
    useEffect(() => {
        const list = listRef.current;
        if (!open || !list) return;
        const obs = new ResizeObserver(() => setViewH(list.clientHeight));
        obs.observe(list);
        setViewH(list.clientHeight);
        return () => obs.disconnect();
    }, [open]);

    if (!open) return null;

    const toggle = (set, update) => key => update(prev => {
        const next = new Set(prev);
        next.has(key) ? next.delete(key) : next.add(key);
        return next;
    });

    /* Whole side on, unless it already is — then off, so the header is a
       toggle rather than a one-way door. */
    const toggleGroup = group => setAttrs(prev => {
        const keys = ATTRS.filter(a => a.group === group).map(a => a.key);
        const next = new Set(prev);
        const all = keys.every(k => next.has(k));
        for (const k of keys) all ? next.delete(k) : next.add(k);
        return next;
    });

    /*
     * Picking a result is navigation, not filtering: focus the node the way the
     * database tree does, and select the column if one was picked so the trace
     * runs and the card opens on it. Filtering is the rail's job and it already
     * does it with layers and eyes.
     */
    const go = row => {
        if (!row) return;
        setOpen(false);
        /* One action: it switches to the lineage tab, focuses and traces. Done
           as setTab-then-focus, the tab moved before history recorded where you
           were, so Back returned you to the tab you were already on. */
        traceOnCanvas(row.id, row.column || null);
        // Open, not toggle: after "show all" the card is already open, and
        // toggling closed the very column that was picked.
        if (row.column) setExpandedMany([row.id], true);
    };

    /* The set is what the reader asked for, so it is what lands — not the
       lineage of any one member. Picking one afterwards traces normally. */
    const goAll = () => {
        setOpen(false);
        showResults(results, q.trim() || 'this filter');
    };

    const onKeyDown = e => {
        if (e.key === 'Escape') { setOpen(false); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, results.length - 1)); }
        if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
        if (e.key === 'Enter') {
            e.preventDefault();
            (e.ctrlKey || e.metaKey) ? goAll() : go(results[cursor]);
        }
    };

    const attrValues = ATTRS.map(a => ({ ...a, count: index.filter(r => r.attr === a.key).length }));
    const layerValues = layerOrder.map(l => ({ key: l, label: l }));

    return (
        <div
            className="fixed inset-0 z-50 flex items-start justify-center palette-scrim"
            /*
             * The blur is set here rather than in the stylesheet: the CSS
             * minifier rewrote the declaration to only its -webkit- form, and
             * the standard property never reached the browser — the rule looked
             * present and did nothing. An inline style is not rewritten.
             *
             * It blurs what is already painted, so it costs one compositor pass
             * rather than re-rendering a canvas of several hundred nodes, and the tint alone is
             * the fallback wherever backdrop-filter is unsupported.
             */
            style={{
                paddingTop: '12vh',
                background: 'rgba(0,0,0,.45)',
                backdropFilter: 'blur(4px)',
                WebkitBackdropFilter: 'blur(4px)',
            }}
            onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false); }}
        >
            <div
                data-testid="search-palette"
                /* Not overflow-hidden: it clipped the facet menus at the modal
                   edge, so a list of seven attributes showed five and the rest
                   were cut off mid-row. The results list does its own
                   scrolling, so nothing else here needs clipping. */
                className="w-[min(680px,92vw)] rounded-[var(--r-md)] border flex flex-col"
                style={{ background: 'var(--panel)', borderColor: 'var(--border)', boxShadow: 'var(--sh-2)' }}
                onKeyDown={onKeyDown}
            >
                <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                    <IconSearch size="md" style={{ color: 'var(--muted)' }} />
                    <input
                        ref={inputRef}
                        value={q}
                        onChange={e => setQ(e.target.value)}
                        placeholder="Search for models and columns…"
                        aria-label="Search models and columns"
                        data-testid="palette-input"
                        className="flex-1 bg-transparent outline-none"
                        style={{ color: 'var(--text)', fontSize: 'var(--fs-h3)' }}
                    />
                    <button onClick={() => setOpen(false)} aria-label="Close search"
                        style={{ color: 'var(--muted)' }}><IconX size="md" /></button>
                </div>

                <div className="flex items-center gap-2 px-4 py-2.5 border-b" style={{ borderColor: 'var(--border)' }}>
                    <Facet label="attributes" values={attrValues} chosen={attrs}
                        onToggle={toggle(attrs, setAttrs)} onGroup={toggleGroup} />
                    <Facet label="layers" values={layerValues} chosen={layers}
                        onToggle={toggle(layers, setLayers)} />
                    <Facet label="tags" values={tagValues} chosen={tags}
                        onToggle={toggle(tags, setTags)}
                        note="dbt tags — Power BI objects carry none" />
                    {(attrs.size || layers.size || tags.size) > 0 && (
                        <button
                            onClick={() => { setAttrs(new Set()); setLayers(new Set()); setTags(new Set()); }}
                            style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}
                        >clear</button>
                    )}
                </div>

                <div ref={listRef} className="overflow-auto scrollbar-thin"
                    onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
                    style={{ maxHeight: '52vh' }}>
                    {results.length === 0 ? (
                        <div className="px-4 py-10 text-center" style={{ color: 'var(--muted)' }}>
                            {/* No glyph: an inline SVG in a centred block sat
                                against the left edge, and the magnifier is
                                already in the input two rows above. */}
                            <div className="font-semibold" style={{ color: 'var(--text)' }}>Search</div>
                            <div className="mt-1" style={{ fontSize: 'var(--fs-sm)' }}>
                                {q || attrs.size || layers.size || tags.size
                                    ? 'Nothing matches. Try clearing a filter.'
                                    : 'Across models, columns, measures, visuals and pages'}
                            </div>
                        </div>
                    ) : (
                        // The spacer holds the full height so the scrollbar
                        // measures the whole result set, not the built window.
                        <div style={{ height: results.length * ROW_H, position: 'relative' }}>
                            {window_.map((row, n) => {
                                const i = first + n;
                                const Icon = row.column
                                    ? columnIcon(row.dataType)
                                    : nodeIcon(row.node);
                                return (
                                    <button
                                        key={`${row.id}|${row.column ?? ''}`}
                                        data-active={i === cursor}
                                        data-testid="palette-result"
                                        onMouseEnter={() => setCursor(i)}
                                        onClick={() => go(row)}
                                        className="absolute left-0 right-0 flex items-center gap-2.5 px-4 text-left"
                                        style={{
                                            top: i * ROW_H, height: ROW_H,
                                            background: i === cursor ? 'var(--accent-soft)' : 'transparent',
                                        }}
                                    >
                                        <Icon size="sm" style={{ color: KIND_COLOR[row.node.kind] }} />
                                        <span className="truncate mono" style={{ color: 'var(--text)' }}>{row.label}</span>
                                        {/* The row is found under a name the model
                                            does not use, so say which — otherwise
                                            it reads as a result that does not
                                            match what was typed. Appended to the
                                            hint rather than replacing it: a bare
                                            column name with the alias in place of
                                            its table says what it is called but
                                            not where it lives. Both share the one
                                            line the virtual list positions by, so
                                            the fixed row height still holds. */}
                                        <span className="truncate flex-1" style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                                            {row.hint}
                                            {row.matchedAlias && (
                                                <span data-testid="palette-aka">
                                                    {row.hint ? ' · ' : ''}aka “{row.matchedAlias}”
                                                </span>
                                            )}
                                        </span>
                                        <span className="flex-none" style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                                            {ATTR_FULL[row.attr]}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                {results.length > 0 && (
                    <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t"
                        style={{ borderColor: 'var(--border)', color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                        <span data-testid="palette-count" data-count={results.length}>
                            {results.length} match{results.length === 1 ? '' : 'es'}
                            {' · '}<kbd>↵</kbd> to open, <kbd>Ctrl ↵</kbd> for all
                        </span>
                        <button
                            data-testid="palette-show-all"
                            onClick={goAll}
                            className="px-2.5 py-1.5 rounded-md border flex-none"
                            style={{
                                borderColor: 'var(--accent)', color: 'var(--accent)',
                                background: 'var(--accent-soft)',
                            }}
                        >
                            Show all {cardCount} on canvas
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
