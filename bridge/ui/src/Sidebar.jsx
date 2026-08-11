import React, { useMemo, useState } from 'react';
import { useStore, DEFAULT_KINDS } from './store';
import { resourceTree, databaseTree } from './tree';
import { KIND_COLOR, layerColor } from './theme';
import {
    KIND_ICON, nodeIcon, IconLayers, IconDatabase, IconTable, IconFilter,
    IconChevronDown, IconChevronRight, IconShow, IconHide, IconReset,
    IconSnapshot, IconSeed, IconExposure, IconTest, IconCode,
} from './icons';

/**
 * Navigation rail, two tabs over the same node set.
 *
 *   Stage    — where a node sits in the pipeline (derived dbt layers)
 *   Database — where it physically lives (database → schema → table)
 *
 * The filter box narrows whichever tree is showing and never touches the
 * canvas: the tree drives the canvas by click, not by text.
 */

/**
 * One tree row.
 *
 * Expanding and showing are two different actions and now have two different
 * controls: the chevron opens the folder, the row toggles visibility, and the
 * eye on the right says which state it is in. Previously one click did both
 * and you could not tell from looking which it would do.
 */
function Row({
    depth = 0, icon, label, count, on = true, bold, onClick, title, mono, active,
    testid, expandable, open, onToggleOpen, disabled, note, eye,
}) {
    return (
        <div
            className="w-full flex items-center gap-1.5 rounded-md group"
            style={{
                paddingLeft: 4 + depth * 14,
                paddingRight: 6,
                opacity: disabled ? .5 : (on ? 1 : .45),
                background: active ? 'var(--accent-soft)' : 'transparent',
                transition: 'background var(--dur-fast) var(--ease), opacity var(--dur-fast) var(--ease)',
            }}
            onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--panel-2)'; }}
            onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
        >
            {expandable ? (
                <button
                    onClick={onToggleOpen}
                    aria-expanded={open}
                    aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
                    className="p-1 rounded flex-none"
                    style={{ color: 'var(--muted)' }}
                >
                    {open ? <IconChevronDown size="sm" /> : <IconChevronRight size="sm" />}
                </button>
            ) : (
                <span className="flex-none" style={{ width: 22 }} />
            )}

            <button
                onClick={disabled ? undefined : onClick}
                data-testid={testid}
                disabled={disabled}
                title={note || title || label}
                className="flex-1 min-w-0 flex items-center gap-2 py-2 text-left"
                style={{ color: active ? 'var(--accent)' : undefined, cursor: disabled ? 'default' : undefined }}
            >
                {icon}
                <span className={`flex-1 truncate ${bold ? 'font-semibold' : ''} ${mono ? 'mono' : ''}`}
                    style={{ fontSize: mono ? undefined : 'var(--fs-body)' }}>
                    {label}
                </span>
                {count != null && <span className="badge tnum">{count}</span>}
            </button>

            {eye && !disabled && (
                <button
                    onClick={onClick}
                    aria-label={on ? `Hide ${label}` : `Show ${label}`}
                    aria-pressed={on}
                    className="p-1 rounded flex-none"
                    style={{ color: on ? 'var(--accent)' : 'var(--muted)' }}
                >
                    {on ? <IconShow size="sm" /> : <IconHide size="sm" />}
                </button>
            )}
        </div>
    );
}

/** The glyph for a resource-type folder, matching the node glyphs on canvas. */
const RESOURCE_ICON = {
    model: KIND_ICON.model,
    source: KIND_ICON.source,
    snapshot: IconSnapshot,
    seed: IconSeed,
    exposure: IconExposure,
    analysis: IconCode,
    test: IconTest,
    unknown: KIND_ICON.unknown,
};

const RESOURCE_TONE = {
    model: 'var(--kind-model)', source: 'var(--kind-source)',
    snapshot: 'var(--kind-snapshot)', seed: 'var(--ok)',
    exposure: 'var(--kind-visual)', analysis: 'var(--muted)',
    test: 'var(--ok)', unknown: 'var(--muted)',
};

/**
 * The leaf level: individual tables, models, pages, visuals.
 *
 * Clicking one focuses it on the canvas, exactly as the Database tab does — a
 * name in a tree that cannot be clicked through to the thing it names is a
 * label, not navigation.
 */
function Leaves({ depth, nodes, q }) {
    const focusOn = useStore(s => s.focusOn);
    const focusRoot = useStore(s => s.focusRoot);
    const shown = q ? nodes.filter(n => n.name.toLowerCase().includes(q)) : nodes;
    if (!shown.length) return null;

    return shown.map(node => {
        const Icon = nodeIcon(node);
        return (
            <Row
                key={node.id}
                depth={depth}
                mono
                testid="tree-leaf"
                icon={<Icon size="sm" style={{ color: KIND_COLOR[node.kind] }} />}
                label={node.name}
                active={focusRoot === node.id}
                onClick={() => focusOn(node.id)}
                title="Show this on the canvas"
            />
        );
    });
}

/**
 * dbt by resource type, Power BI by object kind. Everything starts collapsed:
 * on a large production project the tree runs to hundreds of models across
 * several layers plus hundreds of Power BI objects, and opening on all of it is
 * a wall, not navigation.
 */
/**
 * One folder, and its subfolders, to whatever depth the project nests.
 *
 * The eye acts on the subtree, never on the folder alone: a closed eye on
 * `staging` that leaves `staging/crm` on canvas is a control that appears not to
 * work. So `on` is true when any descendant layer is visible, and pressing it
 * switches every descendant to the opposite of that.
 *
 * Power BI children and source folders have no nesting and reach the same
 * component, because a second rendering path for the flat case is a second
 * place for the two to drift apart.
 */
function Folder({ child, depth, isPbi, groupOn, q, hit, open, toggleOpen }) {
    const layers = useStore(s => s.layers);
    const kinds = useStore(s => s.kinds);
    const layerOrder = useStore(s => s.layerOrder);
    const toggleIn = useStore(s => s.toggleIn);
    const setAll = useStore(s => s.setAll);

    const isSourceFolder = Boolean(child.sourceName);
    const subtree = child.descendants || (child.layer ? [child.layer] : []);
    const on = isPbi ? kinds.has(child.kind)
        : (isSourceFolder ? groupOn : subtree.some(l => layers.has(l)));

    const Icon = isPbi ? KIND_ICON[child.kind]
        : (isSourceFolder ? KIND_ICON.source : IconLayers);
    const tone = isPbi ? KIND_COLOR[child.kind]
        : (isSourceFolder ? 'var(--kind-source)' : layerColor(child.layer, layerOrder));

    const kids = child.children || [];
    const matchedInside = q && (child.nodes?.some(n => hit(n.name)) || kids.some(k => hit(k.label)));
    const isOpen = open.has(child.key) || Boolean(matchedInside);

    const press = () => {
        if (isPbi) return toggleIn('kinds', child.kind);
        if (isSourceFolder) return toggleOpen(child.key);
        // Whole subtree together, to whatever the folder is not already.
        const next = new Set(layers);
        for (const l of subtree) on ? next.delete(l) : next.add(l);
        setAll('layers', [...next]);
    };

    return (
        <div>
            <Row
                depth={depth}
                eye={!isSourceFolder}
                title={child.title || child.layer}
                icon={<Icon size="sm" style={{ color: tone }} />}
                label={child.label}
                count={child.count}
                on={on}
                expandable={child.nodes?.length > 0 || kids.length > 0}
                open={isOpen}
                onToggleOpen={() => toggleOpen(child.key)}
                onClick={press}
            />
            {isOpen && kids.map(kid => (
                <Folder
                    key={kid.key}
                    child={kid}
                    depth={depth + 1}
                    isPbi={false}
                    groupOn={groupOn}
                    q={q}
                    hit={hit}
                    open={open}
                    toggleOpen={toggleOpen}
                />
            ))}
            {isOpen && child.nodes?.length > 0 && (
                <Leaves depth={depth + 1} nodes={child.nodes} q={q} />
            )}
        </div>
    );
}

function StageTree({ q }) {
    const data = useStore(s => s.data);
    const layerOrder = useStore(s => s.layerOrder);
    const layers = useStore(s => s.layers);
    const kinds = useStore(s => s.kinds);
    const resources = useStore(s => s.resources);
    const toggleIn = useStore(s => s.toggleIn);
    const setAll = useStore(s => s.setAll);

    const tree = useMemo(
        () => resourceTree(data.nodes, layerOrder,
            data.metadata?.dbt?.declaredResources, data.metadata?.dbt?.declaredNames),
        [data, layerOrder]
    );

    // The dbt root opens by default: the resource types are the navigation, and
    // a rail whose first paint is two collapsed words is not one.
    const [open, setOpen] = useState(() => new Set(['root:dbt']));
    const toggleOpen = key => setOpen(prev => {
        const next = new Set(prev);
        next.has(key) ? next.delete(key) : next.add(key);
        return next;
    });

    const hit = text => !q || text.toLowerCase().includes(q);
    const rows = tree.filter(t => hit(t.label) || t.children.some(c => hit(c.label)));

    if (!rows.length) {
        return <div className="px-3 py-5" style={{ color: 'var(--muted)' }}>No resource matches.</div>;
    }

    /*
     * Two systems, not six peers.
     *
     * The top level used to be five dbt resource types sitting beside one Power
     * BI group, which put `snapshots` (1 node) on the same footing as the whole
     * Power BI side (313). The question this report answers spans two systems,
     * so those are the two roots, and the resource types become what they
     * actually are: a subdivision of dbt.
     */
    const dbtGroups = rows.filter(g => g.key !== 'powerbi');
    const pbiGroups = rows.filter(g => g.key === 'powerbi');
    const dbtOpen = open.has('root:dbt') || Boolean(q);
    const dbtOn = dbtGroups.some(g => resources.has(g.resource));

    const renderGroup = (group, depth) => {
        const isPbi = group.key === 'powerbi';
        // A filter narrowing the tree also opens what it matched, otherwise the
        // match is hidden inside a closed folder.
        const isOpen = open.has(group.key) || Boolean(q && group.children.some(c => hit(c.label)));
        const groupOn = isPbi
            ? group.children.some(c => kinds.has(c.kind))
            : resources.has(group.resource);

        const Icon = isPbi ? IconLayers : (RESOURCE_ICON[group.resource] || KIND_ICON.unknown);
        const tone = isPbi ? 'var(--layer-pbi)' : (RESOURCE_TONE[group.resource] || 'var(--muted)');

        const toggleGroup = () => {
            if (!isPbi) return toggleIn('resources', group.resource);
            // One switch for the whole Power BI side; the children stay
            // individually controllable underneath.
            setAll('kinds', groupOn
                ? [...kinds].filter(k => !group.children.some(c => c.kind === k))
                : [...new Set([...kinds, ...group.children.map(c => c.kind)])]);
        };

        return (
            <div key={group.key}>
                <Row
                    depth={depth}
                    icon={<Icon size="md" style={{ color: tone }} />}
                    label={group.label}
                    count={group.count}
                    on={groupOn}
                    bold
                    eye
                    disabled={group.empty}
                    note={group.note}
                    expandable={group.children.length > 0 || group.nodes?.length > 0
                        || group.ghosts?.length > 0}
                    open={isOpen}
                    onToggleOpen={() => toggleOpen(group.key)}
                    onClick={toggleGroup}
                    testid={`tree-group-${group.key}`}
                />
                {/* Resource types with no layer subdivision open straight to
                    their tables. */}
                {isOpen && group.nodes?.length > 0 && <Leaves depth={depth + 1} nodes={group.nodes} q={q} />}
                {isOpen && group.ghosts?.map(name => (
                    (!q || name.toLowerCase().includes(q)) && (
                        <Row
                            key={name}
                            depth={depth + 1}
                            mono
                            disabled
                            testid="tree-ghost"
                            icon={<IconCode size="sm" style={{ color: 'var(--muted)' }} />}
                            label={name}
                            note={group.note}
                        />
                    )
                ))}

                {isOpen && group.children.map(child => (
                    <Folder
                        key={child.key}
                        child={child}
                        depth={depth + 1}
                        isPbi={isPbi}
                        groupOn={groupOn}
                        q={q}
                        hit={hit}
                        open={open}
                        toggleOpen={toggleOpen}
                    />
                ))}
            </div>
        );
    };

    return (
        <>
            {dbtGroups.length > 0 && (
                <div>
                    <Row
                        icon={<IconDatabase size="md" style={{ color: 'var(--kind-model)' }} />}
                        label="dbt"
                        count={dbtGroups.reduce((n, g) => n + (g.count || 0), 0)}
                        on={dbtOn}
                        bold
                        eye
                        expandable
                        open={dbtOpen}
                        onToggleOpen={() => toggleOpen('root:dbt')}
                        // One switch for the warehouse side, the resource types
                        // still individually controllable underneath — the same
                        // contract the Power BI root already had.
                        onClick={() => setAll('resources',
                            dbtOn ? [] : dbtGroups.map(g => g.resource))}
                        testid="tree-root-dbt"
                    />
                    {dbtOpen && dbtGroups.map(group => renderGroup(group, 1))}
                </div>
            )}
            {pbiGroups.map(group => renderGroup(group, 0))}
        </>
    );
}

function DatabaseTree({ q }) {
    const data = useStore(s => s.data);
    const focusOn = useStore(s => s.focusOn);
    const focusRoot = useStore(s => s.focusRoot);
    const tree = useMemo(() => databaseTree(data.nodes, data.metadata?.model), [data]);

    // Schemas are visible on open, tables are not — a 114-table dataset
    // expanded by default is a wall, not a navigation aid.
    const [open, setOpen] = useState(() => new Set());
    const toggle = key => setOpen(prev => {
        const next = new Set(prev);
        next.has(key) ? next.delete(key) : next.add(key);
        return next;
    });

    const match = name => !q || name.toLowerCase().includes(q);
    const shown = tree
        .map(db => ({
            ...db,
            schemas: db.schemas
                .map(s => ({ ...s, tables: s.tables.filter(t => match(t.name)) }))
                .filter(s => match(db.name) || match(s.name) || s.tables.length),
        }))
        .filter(db => db.schemas.length);

    if (!shown.length) {
        return <div className="px-3 py-5" style={{ color: 'var(--muted)' }}>No table matches.</div>;
    }

    return shown.map(db => (
        <div key={db.name}>
            <Row
                icon={<IconDatabase size="md"
                    style={{ color: db.synthetic ? 'var(--layer-pbi)' : 'var(--accent)' }} />}
                label={db.name}
                count={db.count}
                bold
                onClick={() => toggle(db.name)}
                title={db.synthetic ? 'Semantic model tables — no warehouse relation' : db.name}
            />
            {db.schemas.map(schema => {
                const key = `${db.name}/${schema.name}`;
                const isOpen = open.has(key) || Boolean(q && schema.tables.length);
                return (
                    <div key={key}>
                        <Row
                            depth={1}
                            testid="tree-schema"
                            icon={isOpen
                                ? <IconChevronDown size="sm" style={{ color: 'var(--muted)' }} />
                                : <IconChevronRight size="sm" style={{ color: 'var(--muted)' }} />}
                            label={schema.name}
                            count={schema.tables.length}
                            onClick={() => toggle(key)}
                        />
                        {isOpen && schema.tables.map(table => {
                            // Materialization-aware: a view and an incremental
                            // table are both kind `model`, and which one it is
                            // changes what a change to it costs.
                            const TIcon = nodeIcon(table) || IconTable;
                            return (
                                <Row
                                    key={table.id}
                                    depth={2}
                                    testid="tree-table"
                                    mono
                                    icon={<TIcon size="sm" style={{ color: KIND_COLOR[table.kind] }} />}
                                    label={table.name}
                                    active={focusRoot === table.id}
                                    onClick={() => focusOn(table.id)}
                                    title="Show this table on the canvas"
                                />
                            );
                        })}
                    </div>
                );
            })}
        </div>
    ));
}

export default function Sidebar() {
    const data = useStore(s => s.data);
    const tab = useStore(s => s.sidebarTab);
    const setTab = useStore(s => s.setSidebarTab);
    const filter = useStore(s => s.treeFilter);
    const setFilter = useStore(s => s.setTreeFilter);
    const layerOrder = useStore(s => s.layerOrder);
    const layers = useStore(s => s.layers);
    const setAll = useStore(s => s.setAll);
    // Still needed by "Hide all"/"Show all", which drops the selection without
    // being a reset — the eyes it toggles are the point of that press.
    const select = useStore(s => s.select);
    const linkedOnly = useStore(s => s.linkedOnly);
    const setLinkedOnly = useStore(s => s.setLinkedOnly);
    const escape = useStore(s => s.escape);
    const railW = useStore(s => s.railW);

    const q = filter.trim().toLowerCase();
    const resources = useStore(s => s.resources);
    const allResources = useStore(s => s.allResources);
    const allOn = layerOrder.every(l => layers.has(l)) && allResources.every(r => resources.has(r));

    const TabPill = ({ id, icon, label }) => (
        <button onClick={() => setTab(id)}
            className={`pill flex-1 justify-center ${tab === id ? 'is-active' : ''}`}
            title={label}>
            {icon}{label}
        </button>
    );

    return (
        <aside data-testid="layer-nav"
            className="surface flex-none flex flex-col overflow-hidden h-full"
            style={{ width: railW ?? 'var(--rail-w)' }}>

            <div className="p-2.5 border-b flex flex-col gap-2.5" style={{ borderColor: 'var(--border)' }}>
                <div className="pill-track flex" data-testid="nav-tabs">
                    <TabPill id="stage" icon={<IconLayers size="sm" />} label="Stage" />
                    <TabPill id="db" icon={<IconDatabase size="sm" />} label="Database" />
                </div>
                <div className="relative flex items-center">
                    <IconFilter size="sm"
                        className="absolute left-2.5" style={{ color: 'var(--muted)' }} />
                    <input
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                        placeholder={tab === 'stage' ? 'Filter resources…' : 'Filter tables…'}
                        className="w-full pl-8 pr-2.5 py-2 rounded-md border"
                        style={{
                            borderColor: 'var(--border)', background: 'var(--panel-2)',
                            color: 'var(--text)', fontSize: 'var(--fs-body)',
                        }}
                    />
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-auto scrollbar-thin py-1.5 px-1.5">
                {tab === 'stage' ? <StageTree q={q} /> : <DatabaseTree q={q} />}
            </div>

            {/* Reset lives here rather than over the canvas: it acts on the same
                axis as "Show all", and the header had no room to explain what a
                floating "Reset view" chip reset.

                "Linked only" joined it when the toolbar strip above the canvas
                was removed. It is a filter, and every other filter is already
                in this rail — it sat in the header only because search did. */}
            <div className="px-3 py-2 border-t flex flex-col gap-1.5"
                style={{ borderColor: 'var(--border)' }}>
                <label className="flex items-center gap-2 cursor-pointer"
                    style={{ color: 'var(--text-2)', fontSize: 'var(--fs-sm)' }}
                    title="Hide anything that is not on a path crossing into Power BI">
                    <input type="checkbox" data-testid="linked-only"
                        checked={linkedOnly}
                        onChange={e => setLinkedOnly(e.target.checked)} />
                    Linked only
                </label>
                <div className="flex items-center justify-between gap-2">
                    {tab === 'stage' ? (
                        <button className="flex items-center gap-1.5"
                            style={{ color: 'var(--accent)', fontSize: 'var(--fs-sm)' }}
                            onClick={() => {
                                setAll('layers', allOn ? [] : layerOrder);
                                setAll('resources', allOn ? [] : allResources);
                                select(null);
                            }}>
                            {allOn ? <IconHide size="sm" /> : <IconShow size="sm" />}
                            {allOn ? 'Hide all' : 'Show all'}
                        </button>
                    ) : (
                        <span style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                            Click a table to focus
                        </span>
                    )}
                    <button
                        data-testid="reset-view"
                        className="flex items-center gap-1.5"
                        style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}
                        title="Clear search, focus and every filter — back to the empty canvas the report opens on (Esc)"
                        /*
                         * The same action the Escape key runs, rather than a
                         * second copy of the same eight calls. As two copies they
                         * had already begun to differ — the key cleared the marks
                         * and left the eyes alone — and a button and a shortcut
                         * that promise one thing while doing two is worse than
                         * having only one of them.
                         */
                        onClick={escape}>
                        <IconReset size="sm" />Reset
                    </button>
                </div>
                <span className="tnum" style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                    {Object.keys(data.nodes).length} nodes
                </span>
            </div>
        </aside>
    );
}
