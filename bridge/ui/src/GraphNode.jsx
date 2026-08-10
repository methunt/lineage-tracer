import React from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position } from '@xyflow/react';
import { useStore, ADJ, DATA } from './store';
import { KIND_COLOR, KIND_LABEL, layerColor } from './theme';
import { REVEAL_MENUS, revealKey, revealOptions, LARGE_REVEAL } from './reveal';
import {
    nodeIcon, columnIcon, IconChevronDown, IconChevronRight,
    IconPlus, IconMinus, IconTest, IconLink, IconCheck,
} from './icons';

function subtitle(node) {
    switch (node.kind) {
        case 'source': return node.meta.sourceName || node.meta.schema || 'source';
        case 'snapshot':
        case 'model': return `${node.meta.materialized || 'model'} · ${node.layer}`;
        case 'pbiTable': return `${node.meta.storageMode || 'table'} · ${node.meta.columnCount} cols`;
        case 'page': return `${node.meta.visualCount} visual${node.meta.visualCount === 1 ? '' : 's'}`;
        case 'measure': return node.meta.homeTable;
        case 'visual': return `${node.meta.visualType || 'visual'} · ${node.meta.page}`;
        default: return node.layer;
    }
}

/**
 * One hop, from this node, in one direction. Rendered only when that direction
 * has neighbours not already on canvas — a button that visibly does nothing
 * reads as broken. Flips to − once pressed, retracting exactly what it added.
 */
function HopButton({ side, state, onExpand, onRetract }) {
    if (state === 'none') return null;
    const open = state === 'retract';
    const dir = side === 'left' ? 'upstream' : 'downstream';
    const Glyph = open ? IconMinus : IconPlus;
    return (
        <button
            className="hop-btn"
            title={open ? `Hide the ${dir} hop this added` : `Show one hop ${dir}`}
            aria-label={open ? `Collapse ${dir}` : `Expand ${dir}`}
            onClick={e => { e.stopPropagation(); (open ? onRetract : onExpand)(); }}
        >
            <Glyph size="sm" />
        </button>
    );
}

/**
 * The same hop, but on a card where "one hop" is two questions.
 *
 * A menu rather than a button, because the counts are the decision: `Pages (3)`
 * and `Measures (7)` tell the reader what a press costs before they pay for it,
 * which is exactly what the old all-kinds expand hid. It is also its own `−` —
 * every item toggles, and the ticks show what this card has already added, so
 * dropping the measures while keeping the pages needs no second control and no
 * memory of what order things were pressed in.
 *
 * Rendered in a portal, not in the card. React Flow scales its nodes, and a
 * popover inside one shrinks with the zoom: at the 0.45 floor the labels are
 * three pixels tall. In the portal it stays screen-sized, at the cost of having
 * to place it against the button's own rect.
 */
function HopMenu({ nodeId, cardKind, shown = '' }) {
    const [open, setOpen] = React.useState(false);
    const [at, setAt] = React.useState(null);
    const btnRef = React.useRef(null);
    const menuRef = React.useRef(null);

    const revealKind = useStore(s => s.revealKind);
    const retractKind = useStore(s => s.retractKind);
    const preferred = useStore(s => s.revealPick[cardKind]);

    // ADJ and DATA are module constants, so the options are stable for the life
    // of a graph — recomputing them per render would walk the adjacency of every
    // card on the canvas on every store change.
    const options = React.useMemo(
        () => revealOptions(nodeId, cardKind, ADJ, DATA.nodes) || [], [nodeId, cardKind]);

    /*
     * A string, not the `reveals` object.
     *
     * Same reason as every other selector on this card: subscribing to the
     * object re-renders all several hundred cards whenever any one of them
     * reveals anything. A per-card tick string is compared by value, so only the
     * card that changed re-renders.
     */
    const ticks = useStore(s => options.map(o => (s.reveals[revealKey(nodeId, o.kind)] ? '1' : '0')).join(''));
    const anyOn = ticks.includes('1');

    const place = () => {
        const r = btnRef.current?.getBoundingClientRect();
        if (r) setAt({ left: r.left + r.width / 2, top: r.bottom + 6 });
    };

    React.useEffect(() => {
        if (!open) return undefined;
        // Anything that moves the card out from under the menu closes it: the
        // menu is positioned once, and a menu pointing at where a card used to
        // be is worse than no menu.
        const shut = () => setOpen(false);
        const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
        const onDown = e => {
            if (!menuRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        /*
         * Capture phase, and `contains` rather than `===`.
         *
         * React Flow's node drag handler calls stopPropagation on mousedown, so
         * a bubble-phase listener on the document never hears a press that lands
         * on another card — which is how two of these menus ended up open at
         * once, one of them pointing at a card the reader had moved on from.
         * `contains` because the press usually lands on the glyph inside the
         * button, not the button itself.
         */
        document.addEventListener('mousedown', onDown, true);
        window.addEventListener('resize', shut);
        // Capture phase: React Flow stops wheel and pan events from bubbling.
        window.addEventListener('wheel', shut, { capture: true, passive: true });
        /*
         * The sticky choice, unless it is the greyed one.
         *
         * A table with pages and no measures is common, and so is the reverse —
         * so the pre-highlighted item is regularly the disabled one, where Enter
         * would do nothing and the menu would read as broken. Falling through to
         * the first item that can actually be pressed keeps the keyboard path
         * meaningful without hiding the zero.
         */
        const menu = menuRef.current;
        (menu?.querySelector('[data-preferred=true]:not(:disabled)')
            || menu?.querySelector('[role=menuitemcheckbox]:not(:disabled)'))?.focus();
        return () => {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('mousedown', onDown, true);
            window.removeEventListener('resize', shut);
            window.removeEventListener('wheel', shut, { capture: true });
        };
    }, [open]);

    /*
     * One press, one answer, menu gone.
     *
     * It used to stay open so that adding two kinds was one gesture, and that
     * was the wrong trade: the reader's next move after choosing is almost
     * always to look at what arrived, and a panel sitting over the cards it just
     * added has to be dismissed before they can. Pressing + again is the way
     * back, which is also how the reader discovers that the menu is the retract
     * control.
     */
    const toggle = option => {
        setOpen(false);
        if (ticks[options.indexOf(option)] === '1') { retractKind(nodeId, option.kind); return; }
        if (option.ids.length > LARGE_REVEAL &&
            !window.confirm(`This will add ${option.ids.length} ${option.label.toLowerCase()}. Show them anyway?`)) return;
        revealKind(nodeId, cardKind, option);
    };

    return (
        <>
            <button
                ref={btnRef}
                className="hop-btn"
                aria-haspopup="menu"
                aria-expanded={open}
                data-testid="hop-menu-button"
                title={REVEAL_MENUS[cardKind].heading}
                onClick={e => {
                    e.stopPropagation();
                    if (!open) place();
                    setOpen(o => !o);
                }}
            >
                {anyOn ? <IconMinus size="sm" /> : <IconPlus size="sm" />}
            </button>

            {open && at && createPortal(
                <div
                    ref={menuRef}
                    className="hop-menu"
                    role="menu"
                    data-testid="hop-menu"
                    aria-label={REVEAL_MENUS[cardKind].heading}
                    style={{ left: at.left, top: at.top }}
                    onClick={e => e.stopPropagation()}
                >
                    <div className="hop-menu-head">{REVEAL_MENUS[cardKind].heading}</div>
                    {options.map((option, i) => {
                        const on = ticks[i] === '1';
                        /*
                         * Already on the canvas, but not by this menu's hand.
                         *
                         * The stepper, a search, or a filter can put these cards
                         * on screen, and none of them writes the key this row
                         * would have to delete. Ticking it would offer a retract
                         * that removes nothing and snaps straight back on, so
                         * the row says what it is and stops taking presses.
                         */
                        const elsewhere = !on && shown[i] === '1';
                        return (
                            <button
                                key={option.kind}
                                role="menuitemcheckbox"
                                aria-checked={on}
                                // Kept, not hidden: a table with no measures and
                                // a table whose measures you cannot see look the
                                // same once the row disappears, and "does this
                                // feed any measures at all" is a real question.
                                disabled={option.ids.length === 0 || elsewhere}
                                data-preferred={option.kind === preferred}
                                data-shown={elsewhere || undefined}
                                data-kind={option.kind}
                                onClick={() => toggle(option)}
                            >
                                <span className="hop-menu-tick">{on ? <IconCheck size="sm" /> : null}</span>
                                {React.createElement(nodeIcon({ kind: option.kind }), { size: 'sm' })}
                                <span className="flex-1">{option.label}</span>
                                <span className="tnum hop-menu-count">
                                    {option.ids.length}{elsewhere ? ' · already shown' : ''}
                                </span>
                            </button>
                        );
                    })}
                </div>,
                document.body)}
        </>
    );
}

export default function GraphNode({ id, data }) {
    const { node, up = 'none', down = 'none', shown = '' } = data;
    /*
     * Every selector here resolves to a primitive on purpose.
     *
     * Subscribing to `s.expanded` (a Set) meant every card on the canvas
     * re-rendered whenever any one of them was expanded — well over a hundred
     * renders for one
     * click, which is most of what the expand lag actually was. Zustand
     * compares with Object.is, so a boolean slice re-renders only the cards
     * whose own answer changed.
     */
    const isOpen = useStore(s => s.expanded.has(id));
    const isSelected = useStore(s => s.selection?.nodeId === id);
    const selectedColumn = useStore(s => (s.selection?.nodeId === id ? s.selection.column : null));
    const lit = useStore(s => Boolean(s.highlight?.nodes.has(id)));
    /*
     * Which of this card's columns the current trace arrived at. Tables open
     * collapsed, so this is what makes expanding one downstream worthwhile:
     * instead of "this table is affected" you get the column it became.
     *
     * The Set is rebuilt only when a selection is made, so its identity is
     * stable between renders and Object.is keeps this from re-rendering every
     * card the way subscribing to the whole highlight would.
     */
    const litColumns = useStore(s => s.highlight?.columns.get(id));
    const isInferred = useStore(s => Boolean(s.highlight?.inferred.has(id)));
    const dim = useStore(s => Boolean(s.highlight) && !s.highlight.nodes.has(id));
    const layerOrder = useStore(s => s.layerOrder);
    const select = useStore(s => s.select);
    const toggleExpanded = useStore(s => s.toggleExpanded);
    const expandFrom = useStore(s => s.expandFrom);
    const retract = useStore(s => s.retract);

    /*
     * Bring the marked column into view inside its own list.
     *
     * A card caps its column list at 336px and scrolls — about 14 rows, and on
     * a large production project dozens of cards carry more than that (the
     * widest, several times that). The
     * trace marks the right row, and on those cards the row is simply below the
     * fold, which is indistinguishable from "this model was not marked".
     *
     * scrollTop rather than scrollIntoView: the latter walks up and scrolls the
     * canvas too, which moves the graph out from under the reader.
     */
    const listRef = React.useRef(null);
    React.useEffect(() => {
        const list = listRef.current;
        if (!list) return;
        const row = list.querySelector('.col-row.is-traced, .col-row.is-selected');
        if (!row) return;
        const top = row.offsetTop - list.offsetTop;
        if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) {
            list.scrollTop = Math.max(0, top - list.clientHeight / 2 + row.offsetHeight / 2);
        }
    }, [litColumns, selectedColumn, isOpen]);

    const hasColumns = node.columns?.length > 0;
    const testCount = node.meta?.testCount || 0;
    // Shape carries the materialization, colour carries the kind — nine glyphs
    // without nine colours (design-system.md §4).
    const Icon = nodeIcon(node);
    const color = KIND_COLOR[node.kind];

    return (
        <div className={`node-card ${dim ? 'is-dim' : ''} ${lit && !isSelected ? 'is-lit' : ''} ${isSelected ? 'is-selected' : ''} ${isInferred ? 'is-inferred' : ''}`}
            title={isInferred
                ? 'Reached table-level: the path to here does not name columns, so this is the whole table, not one column'
                : undefined}>
            <Handle type="target" position={Position.Left} />
            <div className="node-accent" style={{ background: layerColor(node.layer, layerOrder) }} />

            <div className="px-3 py-2 cursor-pointer"
                onClick={e => { e.stopPropagation(); select(id, null); }}>
                <div className="flex items-center gap-2">
                    <Icon size="md" style={{ color }} />
                    <span className="font-semibold truncate flex-1"
                        style={{ fontSize: 'var(--fs-h3)' }} title={node.name}>
                        {node.name}
                    </span>
                    {hasColumns && (
                        <button
                            className="flex items-center gap-1 px-1.5 py-1 rounded-md tnum"
                            style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}
                            title={isOpen ? 'Collapse columns' : 'Expand columns'}
                            aria-expanded={isOpen}
                            onClick={e => { e.stopPropagation(); toggleExpanded(id); }}
                        >
                            {isOpen ? <IconChevronDown size="sm" /> : <IconChevronRight size="sm" />}
                            {node.columns.length}
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-1.5"
                    style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                    <span className="truncate flex-1">{KIND_LABEL[node.kind]} · {subtitle(node)}</span>
                    {/*
                      * Tests are a property of a model, not a step in the flow,
                      * so they get a mark rather than a lane of their own — 36
                      * test nodes would be a fifth of the graph carrying no
                      * downstream. Shown for dbt nodes only, and muted at zero
                      * so "untested" is legible without being loud.
                      */}
                    {node.origin !== 'pbi' && node.meta && (
                        <span className="test-badge tnum"
                            data-tested={testCount > 0 ? 'yes' : 'no'}
                            title={testCount > 0
                                ? `${testCount} dbt test${testCount === 1 ? '' : 's'}`
                                : 'No dbt tests'}>
                            <IconTest size="sm" />{testCount}
                        </span>
                    )}
                </div>
            </div>

            {isOpen && hasColumns && (
                <div ref={listRef} className="pb-1.5 max-h-[336px] overflow-auto scrollbar-thin">
                    {node.columns.map(col => {
                        const active = selectedColumn === col.name;
                        // Lowercase: the trace keys marks by the edge's spelling
                        // and dbt edges arrive lowercased, so an exact match
                        // silently failed on every dbt hop.
                        const traced = !active && litColumns?.has(col.name.toLowerCase());
                        const ColIcon = columnIcon(col.dataType);
                        return (
                            <div
                                key={col.name}
                                className={`col-row ${active ? 'is-selected' : ''} ${traced ? 'is-traced' : ''}`}
                                title={col.dataType || ''}
                                onClick={e => { e.stopPropagation(); select(id, col.name); }}
                            >
                                <ColIcon size="sm" style={{ color: col.hasLineage ? color : 'var(--muted)' }} />
                                <span className="truncate flex-1 mono">{col.name}</span>
                                {/*
                                  * One glyph, two weights: solid means this
                                  * column *is* a join key, faint means it feeds
                                  * one. A row has space for a single mark, and
                                  * someone scanning for "can I touch this"
                                  * wants both facts to catch the eye at the same
                                  * threshold — they are the same warning at
                                  * different strengths.
                                  */}
                                {(col.relationships?.length || col.keysFed?.length) > 0 && (
                                    <IconLink size="sm" className="col-key"
                                        data-strength={col.relationships?.length ? 'key' : 'feeder'}
                                        title={col.relationships?.length
                                            ? `Join key: ${col.relationships.map(r => `${r.otherTable}[${r.otherColumn}]`).join(', ')}`
                                            : `Feeds the join key ${col.keysFed.map(k => `${k.table}[${k.column}]`).join(', ')}`} />
                                )}
                                {col.isCalculated && (
                                    <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>fx</span>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {(up !== 'none' || down !== 'none') && (
                <div className="node-hops">
                    <HopButton side="left" state={up}
                        onExpand={() => expandFrom(id, 'up', 1)}
                        onRetract={() => retract(id, 'up')} />
                    <div className="flex-1" />
                    {/* Only the downstream side is staged. Upstream of either
                        card is a plain lineage question — what feeds this — and
                        it has one answer, so it keeps the plain button. */}
                    {down === 'menu'
                        ? <HopMenu nodeId={id} cardKind={node.kind} shown={shown} />
                        : <HopButton side="right" state={down}
                            onExpand={() => expandFrom(id, 'down', 1)}
                            onRetract={() => retract(id, 'down')} />}
                </div>
            )}

            <Handle type="source" position={Position.Right} />
        </div>
    );
}

export { KIND_COLOR, KIND_LABEL };
