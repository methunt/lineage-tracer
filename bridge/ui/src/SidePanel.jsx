import React, { useState } from 'react';
import { useStore, DATA, ADJ } from './store';
import { walk } from './tree';
import { KIND_COLOR, KIND_LABEL, layerColor } from './theme';
import {
    KIND_ICON, ROLE_ICON, nodeIcon, IconX, IconLink, IconChevronRight, IconCheck,
    IconWarn, IconArrowLeft, IconInfo, IconCode, IconLayers, IconDot,
    IconSearch, IconHide, IconAxis, IconTarget,
} from './icons';

// Column names arrive from two places that disagree about case: a card renders
// the catalog's spelling, an edge carries the extractor's, and colibri
// lowercases dbt identifiers. Every comparison between them goes through here.
const lower = s => String(s ?? '').toLowerCase();

/*
 * A key can join many tables at once, so the list is bounded.
 *
 * Most keys have one or two joins, where a scroll box would be a container
 * around nothing — the cap only appears when it is needed. Expanded, the box is
 * short enough to be visibly scrollable rather than silently cut off.
 */
const CHIP_CAP = 5;

function RelationshipChips({ column }) {
    const [open, setOpen] = useState(false);
    const joins = column.relationships || [];
    const feeds = column.keysFed || [];
    if (!joins.length && !feeds.length) return null;

    const shown = open ? joins : joins.slice(0, CHIP_CAP);
    const hidden = joins.length - shown.length;

    return (
        <div className="mt-1">
            <div className={`flex flex-wrap gap-1.5 ${open ? 'rel-scroll' : ''}`}>
                {shown.map((r, k) => (
                    <span key={k}
                        className={`rel-chip ${r.active ? '' : 'is-inactive'}`}
                        title={r.active
                            ? `Joins ${r.otherTable}[${r.otherColumn}]${r.cardinality ? ` (${r.cardinality})` : ''}`
                            : `Inactive relationship to ${r.otherTable}[${r.otherColumn}] — reachable only through USERELATIONSHIP in a measure`}>
                        <IconLink size="sm" />
                        <span className="mono">{r.otherTable}[{r.otherColumn}]</span>
                        {!r.active && <span className="rel-off">inactive</span>}
                    </span>
                ))}
                {/* Feeding a key is a weaker fact than being one, so it is drawn
                    lighter — but it is the same warning: drop this and a join
                    stops working. */}
                {feeds.map((k, i) => (
                    <span key={`f${i}`} className="rel-chip is-feeder"
                        title={`Feeds the join key ${k.table}[${k.column}], which joins ${k.joins}`}>
                        <IconLink size="sm" />
                        <span className="mono">feeds {k.table}[{k.column}]</span>
                    </span>
                ))}
            </div>
            {hidden > 0 && (
                <button className="rel-more" onClick={() => setOpen(true)}>
                    +{hidden} more join{hidden === 1 ? '' : 's'}
                </button>
            )}
        </div>
    );
}

/**
 * "This reaches no visual, and a join depends on it."
 *
 * Shown for the selected column only. At table scope the sentence would have to
 * summarise several keys at once, which is what the Metadata list already does
 * one card at a time.
 */
function KeyNote({ node, column }) {
    if (!column) return null;
    const col = (node.columns || []).find(c => c.name === column);
    if (!col) return null;

    const joins = (col.relationships || [])
        .map(r => `${r.otherTable}[${r.otherColumn}]`);
    const feeds = (col.keysFed || [])
        .map(k => `${k.table}[${k.column}]`);
    if (!joins.length && !feeds.length) return null;

    return (
        <div className="mt-2 flex items-start gap-1.5"
            style={{ color: 'var(--text-2)', fontSize: 'var(--fs-sm)' }}>
            <IconLink size="sm" className="mt-0.5 flex-none" />
            <span>
                {joins.length > 0 ? (
                    <>Used as a join key with <b className="mono">{joins.join(', ')}</b>.</>
                ) : (
                    <>Feeds the join key <b className="mono">{feeds.join(', ')}</b>.</>
                )}{' '}
                A broken join changes the numbers without raising an error, so this
                does not show up in the visual count above.
            </span>
        </div>
    );
}

const BAND_STYLE = {
    high: { label: 'High', color: 'var(--bad)' },
    medium: { label: 'Medium', color: 'var(--warn)' },
    low: { label: 'Low', color: 'var(--ok)' },
    none: { label: 'None', color: 'var(--muted)' },
};

const Chip = ({ children, tone, icon }) => (
    <span className="chip" style={tone ? { borderColor: tone, color: tone, background: 'transparent' } : undefined}>
        {icon}{children}
    </span>
);

/* `note` says where a section's rows lead, when they lead off this tab. A row
   that changes which tab you are on has to say so before it is pressed —
   discovering it by being moved is how the two tabs read as wired together. */
const Section = ({ title, count, note, children }) => (
    <div className="mb-5">
        <div className="label mb-2">{title}{count != null && ` (${count})`}</div>
        {note && (
            <div className="mb-2" style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                {note}
            </div>
        )}
        {children}
    </div>
);

const Code = ({ text }) => (
    <pre className="mono p-3 rounded-[var(--r-md)] overflow-auto scrollbar-thin whitespace-pre"
        style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', lineHeight: 1.65 }}>
        {text}
    </pre>
);

/**
 * The chip row. Three facts, no tags.
 *
 * Tags were dropped because they duplicate what is already on screen:
 * dwh_region_rate_pct carries tags ["warehouse","dimension","mapping"] *and* sits
 * in layer warehouse, so the row printed "warehouse" twice for no gain. The
 * layer itself moved to the coloured border on this header.
 */
function chipsFor(node) {
    const m = node.meta || {};
    const out = [];
    if (node.origin === 'pbi') {
        if (node.kind === 'pbiTable') {
            out.push([m.storageMode || 'import', null]);
            if (m.columnCount != null) out.push([`${m.columnCount} columns`, null]);
            if (m.measureCount) out.push([`${m.measureCount} measures`, null]);
        } else if (node.kind === 'page') {
            out.push([`${m.visualCount} visual${m.visualCount === 1 ? '' : 's'}`, null]);
        } else if (node.kind === 'measure') {
            // Not the home table: the header subtitle already carries it, the
            // same way a visual's page is not repeated as a chip.
            if (m.formatString) out.push([m.formatString, null]);
        } else if (node.kind === 'visual') {
            // Not the page: the header subtitle is the "where does this live"
            // slot for every kind, and for a visual its page *is* its location.
            // Printing it in both places said the same thing twice.
            out.push([m.visualType || 'visual', null]);
            const fields = node.definition?.fields?.length;
            if (fields) out.push([`${fields} field${fields === 1 ? '' : 's'}`, null]);
        }
        return out;
    }
    out.push([m.resourceType || node.kind, null]);
    if (m.materialized) out.push([m.materialized, null]);
    out.push([
        `${m.testCount || 0} test${m.testCount === 1 ? '' : 's'}`,
        m.testCount ? 'var(--ok)' : 'var(--muted)',
    ]);
    return out;
}

/**
 * How the boundary was crossed, grouped by provenance and collapsible.
 *
 * Overview only: it is impact context, and it has no business sitting above a
 * SQL listing or a metadata table. Derived links are one per line because each
 * may carry a rename and the rename is the point — `RegionNameNew → Region` is
 * why a Power BI author cannot guess which dbt column breaks their table.
 * Declared links the reader wrote themselves, so they collapse to one sentence.
 */
function Provenance({ edges }) {
    const derived = edges.filter(e => e.provenance !== 'declared');
    const declared = edges.filter(e => e.provenance === 'declared');
    // Small lists are more useful open than tidy.
    const [open, setOpen] = useState(edges.length <= 6);
    if (!edges.length) return null;

    const pair = e => (e.sourceColumn === e.targetColumn
        ? e.sourceColumn
        : `${e.sourceColumn} → ${e.targetColumn}`);

    return (
        <div data-testid="provenance" className="mb-5 rounded-[var(--r-md)] border overflow-hidden"
            style={{ borderColor: 'var(--accent)', background: 'var(--accent-soft)' }}>
            <button
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
                style={{ color: 'var(--accent)' }}
            >
                <IconLink size="sm" />
                <span className="flex-1 font-semibold" style={{ fontSize: 'var(--fs-sm)' }}>
                    Crosses the warehouse boundary · {edges.length} column{edges.length === 1 ? '' : 's'}
                </span>
                <IconChevronRight size="sm"
                    style={{ transform: `rotate(${open ? 90 : 0}deg)`, transition: 'transform var(--dur-base) var(--ease)' }} />
            </button>

            <div className={`disclosure ${open ? 'is-open' : ''}`}>
                <div>
                    <div className="px-3 pb-3 max-h-[38vh] overflow-auto scrollbar-thin">
                        {derived.length > 0 && (
                            <div className={declared.length ? 'mb-3' : ''}>
                                <div className="label mb-1.5" style={{ color: 'var(--accent)' }}>
                                    Resolved from the M expression ({derived.length})
                                </div>
                                {derived.map((e, i) => (
                                    <div key={i} className="mono truncate" style={{ lineHeight: 1.8 }}
                                        title={`${e.sourceColumn} → ${e.targetColumn} · matched on ${e.matchLevel}`}>
                                        {pair(e)}
                                    </div>
                                ))}
                            </div>
                        )}
                        {declared.length > 0 && (
                            <div>
                                <div className="label mb-1.5" style={{ color: 'var(--accent)' }}>
                                    Mapped in the mapping file ({declared.length})
                                </div>
                                <div className="mono" style={{ lineHeight: 1.8 }}>
                                    {declared.map(pair).join(', ')}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

/**
 * One downstream visual, as a way to go and look at it.
 *
 * The lineage tab can say "Customers, on Region and Segment". Where that
 * sits on the page — headline card or footnote in the corner — is the part
 * that decides whether you care, and only the layout can answer it.
 */
function VisualRow({ node, broken }) {
    const revealVisual = useStore(s => s.revealVisual);
    return (
        <button
            data-testid="affected-visual"
            onClick={() => revealVisual(node.id)}
            title={`Show ${node.name} on ${node.meta?.page || 'its page'}`}
            className="field-row is-linked w-full mb-1"
        >
            <KIND_ICON.visual size="sm" style={{ color: KIND_COLOR.visual }} />
            <span className="flex-1 truncate text-left">{node.name}</span>
            <span style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                {node.meta?.visualType}
            </span>
            {broken && <Chip tone="var(--bad)">BROKEN</Chip>}
            <IconChevronRight size="sm" className="field-go" />
        </button>
    );
}

/**
 * A measure that reads this. Goes to the lineage canvas rather than to the
 * layout: a measure has no place on a page, and a dead chip beside a live
 * visual row reads as a bug rather than as a decision.
 */
function MeasureChip({ node }) {
    const traceOnCanvas = useStore(s => s.traceOnCanvas);
    return (
        <button
            data-testid="affected-measure"
            /* One action, so Back knows you came from the layout: composed as
               setTab-then-focus, the tab had already moved before history
               recorded where you were. */
            onClick={() => traceOnCanvas(node.id)}
            title={`Trace ${node.meta?.homeTable}[${node.name}]`}
            className="chip-link"
        >
            <KIND_ICON.measure size="sm" style={{ color: KIND_COLOR.measure }} />
            {node.meta?.homeTable}[{node.name}]
        </button>
    );
}

/**
 * The way out of a leaf.
 *
 * Nothing on a visual's panel says that the lineage tab holds the rest of
 * the answer, and nobody discovers that by guessing — the two tabs read as
 * two features. A field row is a way through, but only if you already know
 * which field you want. This is the whole-object version, stated: press it
 * and the visual lands on the lineage canvas with everything it stands on
 * traced behind it.
 *
 * Only on leaves. On a dbt model the canvas *is* the panel's subject, so the
 * button would point at where you already are.
 */
function TraceCta({ node }) {
    const tab = useStore(s => s.tab);
    const traceOnCanvas = useStore(s => s.traceOnCanvas);
    if (node.kind !== 'visual' && node.kind !== 'page') return null;
    if (tab === 'lineage') return null;   // already there

    const what = node.kind === 'page' ? 'this page' : 'this visual';
    return (
        <button
            data-testid="trace-cta"
            onClick={() => traceOnCanvas(node.id)}
            className="trace-cta"
        >
            <IconTarget size="sm" />
            <span className="flex-1 text-left">
                See everything {what} depends on
                <span className="trace-cta-sub">upstream columns, models and sources, on the lineage canvas</span>
            </span>
            <IconChevronRight size="sm" />
        </button>
    );
}

/**
 * What a page holds.
 *
 * A page is a leaf like a visual — nothing reads it, so "what breaks" could
 * only answer zero. Unlike a visual it has a real summary of its own: the
 * visuals on it, and how far back they collectively reach. Each row travels
 * to the layout, which is where a page is best answered anyway.
 */
function PageContents({ node, data }) {
    const revealVisual = useStore(s => s.revealVisual);
    const visuals = React.useMemo(() => Object.values(data.nodes)
        .filter(n => n.kind === 'visual' && n.meta?.pageId === node.meta?.pageId
            && !n.meta?.isGroup)
        .sort((a, b) => a.name.localeCompare(b.name)), [data, node]);

    // Everything the page's visuals stand on, counted once rather than per
    // visual — eleven visuals over one model is one dependency, not eleven.
    const upstream = React.useMemo(() => {
        const models = new Set(), tables = new Set(), measures = new Set();
        for (const v of visuals) {
            for (const id of walk(v.id, 'up', Infinity, ADJ, DATA.nodes)) {
                const kind = DATA.nodes[id]?.kind;
                if (kind === 'model') models.add(id);
                else if (kind === 'pbiTable') tables.add(id);
                else if (kind === 'measure') measures.add(id);
            }
        }
        return { models: models.size, tables: tables.size, measures: measures.size };
    }, [visuals]);

    const broken = new Set((data.diagnostics.brokenRefs || []).map(r => `${r.page}|${r.visual}`));

    return (
        <>
            <div className="mb-4" data-testid="page-summary">
                <b className="tnum">{visuals.length}</b> visual{visuals.length === 1 ? '' : 's'}
                {upstream.measures > 0 && <> · <b className="tnum">{upstream.measures}</b> measure{upstream.measures === 1 ? '' : 's'}</>}
                {upstream.tables > 0 && <> · <b className="tnum">{upstream.tables}</b> model table{upstream.tables === 1 ? '' : 's'}</>}
                {upstream.models > 0 && <> · <b className="tnum">{upstream.models}</b> dbt model{upstream.models === 1 ? '' : 's'} upstream</>}
            </div>
            <Section title="Visuals on this page" count={visuals.length}
                note="Pick one to see it on the page layout.">
                {visuals.length === 0
                    ? <div style={{ color: 'var(--muted)' }}>Nothing on this page.</div>
                    : visuals.map(v => (
                        <VisualRow key={v.id} node={v}
                            broken={broken.has(`${v.meta.page}|${v.name}`)} />
                    ))}
            </Section>
        </>
    );
}

function Overview({ node, impact, data, selection, crossing }) {
    const band = BAND_STYLE[impact?.band] || BAND_STYLE.none;
    const scope = selection.column ? `column ${selection.column}` : `all ${node.columns?.length || 0} columns`;

    const measures = (impact?.measures || []).map(id => data.nodes[id]).filter(Boolean);
    const visuals = (impact?.visuals || []).map(id => data.nodes[id]).filter(Boolean);
    const byPage = {};
    for (const v of visuals) (byPage[v.meta.page || '—'] ||= []).push(v);

    // Breakage is only ever shown when the artifacts prove it (spec §6.1).
    const broken = new Set((data.diagnostics.brokenRefs || []).map(r => `${r.page}|${r.visual}`));

    return (
        <>
            <Provenance edges={crossing} />

            {!impact ? (
                <div style={{ color: 'var(--muted)' }}>No impact data for this node.</div>
            ) : (
                <>
                    <div className="rounded-[var(--r-md)] p-3.5 mb-5 border"
                        style={{
                            borderColor: band.color,
                            background: `color-mix(in srgb, ${band.color} 9%, transparent)`,
                        }}>
                        <div className="flex items-center gap-2 font-semibold"
                            style={{ color: band.color, fontSize: 'var(--fs-h3)' }}>
                            <IconWarn size="sm" />
                            Potential impact: {band.label}
                            {/*
                              * A band raised off the visual count needs its
                              * reason on the same line. "Medium" on something
                              * with no visuals downstream reads as a bug
                              * otherwise — the whole point is that this risk
                              * does not show up as a broken visual.
                              */}
                            {impact.bandRaisedFrom && (
                                <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 'var(--fs-sm)' }}>
                                    raised from {impact.bandRaisedFrom} — {impact.bandReason}
                                </span>
                            )}
                        </div>
                        <div className="mt-1.5">
                            <b className="tnum">{impact.measures.length}</b> measure{impact.measures.length === 1 ? '' : 's'} and{' '}
                            <b className="tnum">{impact.visuals.length}</b> visual{impact.visuals.length === 1 ? '' : 's'} downstream
                            {impact.pages?.length > 0 && <> on <b className="tnum">{impact.pages.length}</b> page{impact.pages.length === 1 ? '' : 's'}</>}
                            {impact.tables.length > 0 && <> · <b className="tnum">{impact.tables.length}</b> model table{impact.tables.length === 1 ? '' : 's'}</>}
                            {impact.models.length > 0 && <> · <b className="tnum">{impact.models.length}</b> dbt model{impact.models.length === 1 ? '' : 's'}</>}
                            {/*
                              * The one dependency in this sentence that does not
                              * announce itself. Every visual counted above stops
                              * working visibly; a broken join leaves them all
                              * rendering, with different numbers. Only shown when
                              * there is one, so the sentence does not carry a
                              * zero for the many nodes that hold no key.
                              */}
                            {impact.relationships > 0 && (
                                <> · <b className="tnum">{impact.relationships}</b> relationship{impact.relationships === 1 ? '' : 's'}
                                    {impact.relationshipsInactive > 0 && (
                                        <span style={{ color: 'var(--muted)' }}>
                                            {' '}({impact.relationshipsInactive} inactive)
                                        </span>
                                    )}
                                </>
                            )}
                            {/*
                              * Deliberately not the same word. "Holds up" means
                              * break this and the join breaks now; "reaches"
                              * means it flows into something that does, several
                              * hops away. Never both — the two are mutually
                              * exclusive by construction upstream.
                              */}
                            {!impact.relationships && impact.relationshipsDownstream > 0 && (
                                <> · reaches <b className="tnum">{impact.relationshipsDownstream}</b> join{' '}
                                    relationship{impact.relationshipsDownstream === 1 ? '' : 's'} downstream
                                    {impact.relationshipsDownstreamInactive > 0 && (
                                        <span style={{ color: 'var(--muted)' }}>
                                            {' '}({impact.relationshipsDownstreamInactive} inactive)
                                        </span>
                                    )}
                                </>
                            )}
                        </div>
                        {/*
                          * Without this line the sentence above reads "0 visuals"
                          * for a key column, which is true and reads as "safe to
                          * drop". A key breaks a join, and a broken join raises
                          * no error — the report keeps rendering with different
                          * numbers. The counts stay as they are; the join is
                          * stated beside them rather than folded into them.
                          */}
                        <KeyNote node={node} column={selection.column} />
                        {/*
                          * Part of the count above may have been reached through
                          * a hop that names no columns — a table-level mapping
                          * row, or a dbt edge sqlglot could not resolve. Those
                          * are real dependencies, so they stay in the number;
                          * what would be wrong is presenting the whole number as
                          * column-precise when some of it is table-grade.
                          * Silent when the two agree, which is the common case.
                          */}
                        {selection.column && impact.visualsExact < impact.visuals.length && (
                            <div className="mt-1.5" style={{ fontSize: 'var(--fs-sm)' }}>
                                <b className="tnum">{impact.visualsExact}</b> of those are traced column by column;
                                the rest are reached through a step that names no columns, so they are
                                the whole table's downstream rather than this column's.
                            </div>
                        )}
                        <div className="mt-2 flex items-start gap-1.5"
                            style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                            <IconInfo size="sm" className="mt-0.5" />
                            <span>
                                Scope: {scope}. Band from downstream visual count
                                (high ≥ {data.impact.bands.high}, medium ≥ {data.impact.bands.medium}).
                            </span>
                        </div>
                    </div>

                    <Section title="Affected measures" count={measures.length}
                        note={measures.length ? 'Pick one to trace it on the lineage canvas.' : null}>
                        {measures.length === 0
                            ? <div style={{ color: 'var(--muted)' }}>None.</div>
                            : <div className="flex flex-wrap gap-1.5">
                                {measures.map(m => <MeasureChip key={m.id} node={m} />)}
                            </div>}
                    </Section>

                    <Section title="Affected visuals" count={visuals.length}
                        note={visuals.length ? 'Pick one to see where it sits on the page layout.' : null}>
                        {visuals.length === 0
                            ? <div style={{ color: 'var(--muted)' }}>None.</div>
                            : Object.entries(byPage).map(([page, list]) => (
                                <div key={page} className="mb-3">
                                    <div className="font-medium mb-1.5">{page}</div>
                                    {list.map(v => (
                                        <VisualRow key={v.id} node={v}
                                            broken={broken.has(`${v.meta.page}|${v.name}`)} />
                                    ))}
                                </div>
                            ))}
                    </Section>
                </>
            )}
        </>
    );
}

// Visual-encoding order: what the reader is looking at, then what shapes it,
// then what merely constrains it. Anything unrecognised keeps its own heading
// and sorts after these.
// Roles as Power BI actually writes them, in visual-encoding order. Taken from
// the roles present across a large production report's visuals rather than guessed —
// `Data`, `Group` and `containerObjects` are all real and all common.
const ROLE_ORDER = ['Y', 'Y2', 'Values', 'Data', 'Category', 'category', 'Rows',
    'Columns', 'Series', 'Group', 'Tooltips', 'measure', 'filter',
    'conditionalFormatting', 'containerObjects'];

const ROLE_LABEL = {
    Y: 'Y axis', Y2: 'Secondary Y axis', Values: 'Values', Data: 'Data',
    Category: 'Category (X axis)', category: 'Category (X axis)',
    Rows: 'Rows', Columns: 'Columns', Series: 'Legend / series',
    Group: 'Group', Tooltips: 'Tooltips', measure: 'Measure',
    filter: 'Filters', conditionalFormatting: 'Conditional formatting',
    containerObjects: 'Container objects',
};

/*
 * Colour by what the field does, borrowed from the palette the canvas already
 * uses rather than a new one — a reader who has learned that measures are
 * crimson on a node card should not have to learn a second scheme three
 * clicks away. Roles that plot share the layer ramp; roles that narrow or
 * annotate sit apart on the state colours.
 */
const ROLE_COLOR = {
    Y: 'var(--layer-0)', Y2: 'var(--layer-1)', Values: 'var(--layer-0)',
    Data: 'var(--layer-1)', Category: 'var(--layer-2)', category: 'var(--layer-2)',
    Rows: 'var(--layer-2)', Columns: 'var(--layer-3)', Series: 'var(--layer-3)',
    Group: 'var(--layer-3)', Tooltips: 'var(--layer-4)',
    measure: 'var(--kind-measure)', filter: 'var(--warn)',
    conditionalFormatting: 'var(--kind-visual)', containerObjects: 'var(--muted)',
};

/**
 * The graph node a field refers to, or null when the report names something
 * the semantic model does not hold. A small fraction of the fields on a large
 * production project — a field parsed from a visual whose table was renamed or
 * removed.
 */
function resolveField(field, data) {
    const table = lower(field.table);
    const name = lower(field.name);
    for (const node of Object.values(data.nodes)) {
        if (field.type === 'measure') {
            if (node.kind === 'measure' && lower(node.name) === name
                && lower(node.meta?.homeTable) === table) return { node, column: null };
        } else if (node.kind === 'pbiTable' && lower(node.name) === table) {
            const col = (node.columns || []).find(c => lower(c.name) === name);
            return col ? { node, column: col.name } : null;
        }
    }
    return null;
}

/*
 * How far back a field goes, in the only two units that matter here: dbt
 * models and the sources under them. This is what a separate "Depends on"
 * tab would have shown — the same rows walked one hop further — so it lives
 * on the row instead. Memoised: a walk to the sources is cheap, but a visual
 * can carry two dozen fields and this renders on every panel open.
 */
const DEPTH_CACHE = new Map();
function upstreamDepth(nodeId) {
    if (DEPTH_CACHE.has(nodeId)) return DEPTH_CACHE.get(nodeId);
    let models = 0, sources = 0;
    for (const id of walk(nodeId, 'up', Infinity, ADJ, DATA.nodes)) {
        const kind = DATA.nodes[id]?.kind;
        if (kind === 'model') models++;
        else if (kind === 'source') sources++;
    }
    const depth = { models, sources };
    DEPTH_CACHE.set(nodeId, depth);
    return depth;
}

/** "4 dbt models · 2 sources", or nothing when a field reaches neither. */
function depthLabel(nodeId) {
    const { models, sources } = upstreamDepth(nodeId);
    const parts = [];
    if (models) parts.push(`${models} dbt model${models === 1 ? '' : 's'}`);
    if (sources) parts.push(`${sources} source${sources === 1 ? '' : 's'}`);
    return parts.join(' · ');
}

/**
 * Fields used, grouped by what the visual does with each one.
 *
 * Was a single <pre> that scrolled sideways, which put the role — the thing you
 * are actually scanning for — past the right edge. On a real visual here, 23
 * fields collapse into a handful of labelled blocks, eight of them "filter".
 * Grouping also lets long field names wrap instead of scroll, which is the
 * right failure mode now that the panel is resizable.
 */
function FieldsUsed({ fields }) {
    const data = useStore(s => s.data);
    const traceOnCanvas = useStore(s => s.traceOnCanvas);

    /*
     * A field is a way into the lineage, not a label.
     *
     * "Which of these five fields is the one that breaks?" was previously
     * answered by reading the name, going to the Lineage tab, opening the
     * palette and typing it back in. Clicking focuses that node and traces it,
     * both directions, and switches tab — a click that changes state on a tab
     * you cannot see is indistinguishable from one that did nothing.
     */
    const open = hit => {
        if (!hit) return;
        traceOnCanvas(hit.node.id, hit.column || null);
    };

    const groups = new Map();
    for (const field of fields) {
        const role = field.role || 'Other';
        if (!groups.has(role)) groups.set(role, []);
        groups.get(role).push(field);
    }

    const rank = role => {
        const i = ROLE_ORDER.indexOf(role);
        return i < 0 ? ROLE_ORDER.length : i;
    };
    const ordered = [...groups.entries()]
        .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));

    return ordered.map(([role, list]) => {
        const RoleIcon = ROLE_ICON[role] || IconDot;
        const tint = ROLE_COLOR[role] || 'var(--muted)';
        return (
            <div key={role} className="mb-4">
                <div className="role-head" style={{ '--role': tint }}>
                    <span className="role-chip"><RoleIcon size="sm" /></span>
                    <span className="role-name">{ROLE_LABEL[role] || role}</span>
                    <span className="role-count tnum">{list.length}</span>
                </div>
                {list.map((f, i) => {
                    const isMeasure = f.type === 'measure';
                    const FieldIcon = isMeasure ? KIND_ICON.measure : KIND_ICON.pbiTable;
                    const hit = resolveField(f, data);
                    const depth = hit ? depthLabel(hit.node.id) : '';
                    return (
                        <button
                            key={`${f.table}.${f.name}.${i}`}
                            data-testid="field-row"
                            data-resolved={hit ? 'true' : 'false'}
                            className={`field-row ${hit ? 'is-linked' : 'is-orphan'}`}
                            disabled={!hit}
                            onClick={() => open(hit)}
                            title={hit
                                ? `Trace ${f.table}[${f.name}] — role ${f.role || 'none'}`
                                : `${f.table}[${f.name}] is not in the semantic model, so it cannot be traced`}
                        >
                            <FieldIcon size="sm" style={{
                                color: isMeasure ? KIND_COLOR.measure : KIND_COLOR.pbiTable,
                            }} />
                            <span className="mono field-name">
                                <span style={{ color: 'var(--muted)' }}>{f.table}</span>[{f.name}]
                            </span>
                            {hit && depth && (
                                <span className="field-depth" data-testid="field-depth">{depth}</span>
                            )}
                            {hit
                                ? <IconChevronRight size="sm" className="field-go" />
                                : <span className="field-orphan-tag">not in model</span>}
                        </button>
                    );
                })}
            </div>
        );
    });
}

function Definition({ node }) {
    const d = node.definition || {};
    const blocks = [];
    if (d.compiledSql) blocks.push(['Compiled SQL', d.compiledSql]);
    if (!d.compiledSql && d.rawSql) blocks.push(['Raw SQL', d.rawSql]);
    if (d.dax) blocks.push(['DAX', d.dax]);
    if (d.m) blocks.push(['M (as authored)', d.m]);
    if (d.mInlined) blocks.push(['M (source function resolved by lineage-bridge)', d.mInlined]);

    if (!blocks.length && !d.fields?.length) {
        return (
            <div className="flex items-center gap-2" style={{ color: 'var(--muted)' }}>
                <IconCode size="sm" /> No definition available for this node.
            </div>
        );
    }
    return (
        <>
            {d.fields?.length > 0 && (
                <Section title="Fields used" count={d.fields.length}>
                    <FieldsUsed fields={d.fields} />
                </Section>
            )}
            {blocks.map(([title, text]) => (
                <Section key={title} title={title}><Code text={text} /></Section>
            ))}
        </>
    );
}

/** Below this a search box is furniture, not help. */
const FIND_AT = 8;

/**
 * The column list.
 *
 * Was a three-column table with a `linked` chip per row: on a 28-column table
 * that is 28 chips stacked in a gutter, which reads as noise rather than as a
 * signal. Lineage is now a coloured left edge — the same information as a
 * pattern you can scan down instead of read across — and the space it freed
 * goes to the description, which is the part a reader actually needs when
 * deciding whether a column is the one they mean.
 */
function Columns({ columns }) {
    const [q, setQ] = useState('');
    const needle = q.trim().toLowerCase();
    const shown = needle
        ? columns.filter(c => c.name.toLowerCase().includes(needle)
            || (c.description || '').toLowerCase().includes(needle))
        : columns;

    return (
        <div className="mb-5">
            <div className="flex items-center gap-2 mb-2">
                <div className="label flex-1">Columns ({columns.length})</div>
                {columns.length >= FIND_AT && (
                    <div className="relative flex items-center">
                        <IconSearch size="sm" className="absolute left-2.5" style={{ color: 'var(--muted)' }} />
                        <input
                            value={q}
                            onChange={e => setQ(e.target.value)}
                            placeholder="Find…"
                            aria-label="Find a column"
                            data-testid="column-find"
                            className="pl-8 pr-2.5 py-1.5 rounded-md border w-[150px]"
                            style={{
                                borderColor: 'var(--border)', background: 'var(--panel-2)',
                                color: 'var(--text)', fontSize: 'var(--fs-sm)',
                            }}
                        />
                    </div>
                )}
            </div>

            <div className="rounded-[var(--r-md)] border overflow-hidden"
                style={{ borderColor: 'var(--border)' }}>
                {shown.length === 0 && (
                    <div className="px-3 py-4" style={{ color: 'var(--muted)' }}>
                        No column matches “{q}”.
                    </div>
                )}
                {shown.map((c, i) => (
                    <div key={c.name} className="col-card"
                        style={{ borderTop: i ? '1px solid var(--border)' : undefined }}>
                        <span className="col-card-edge"
                            style={{ background: c.hasLineage ? 'var(--ok)' : 'transparent' }}
                            title={c.hasLineage ? 'Traced back to dbt' : undefined} />
                        <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2">
                                <span className="font-semibold" style={{ overflowWrap: 'anywhere' }}>
                                    {c.name}
                                </span>
                                <span className="flex-1" />
                                {c.isHidden && (
                                    <IconHide size="sm" style={{ color: 'var(--muted)' }} title="Hidden" />
                                )}
                                <span className="mono uppercase flex-none"
                                    style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                                    {c.dataType || '—'}
                                </span>
                            </div>
                            {c.description && (
                                <div className="mt-0.5" style={{ color: 'var(--text-2)' }}>{c.description}</div>
                            )}
                            {/* A key is load-bearing without appearing in a
                                single visual, so nothing else on this card would
                                tell you it matters. Naming the other side is the
                                point: "used in a relationship" is not actionable,
                                "joins Site Performance[DateKey]" is. */}
                            <RelationshipChips column={c} />
                            {/* "Calculated" alone says nothing about whether a
                                change breaks it — the DAX does. */}
                            {c.expression && <CalculatedColumn dax={c.expression} />}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function CalculatedColumn({ dax }) {
    const [open, setOpen] = useState(false);
    return (
        <div className="mt-1.5">
            <button onClick={() => setOpen(o => !o)} aria-expanded={open}
                className="flex items-center gap-1.5"
                style={{ color: 'var(--accent)', fontSize: 'var(--fs-sm)' }}>
                <IconCode size="sm" />
                calculated column
                <IconChevronRight size="sm" style={{
                    transform: `rotate(${open ? 90 : 0}deg)`,
                    transition: 'transform var(--dur-base) var(--ease)',
                }} />
            </button>
            <div className={`disclosure ${open ? 'is-open' : ''}`}>
                <div><div className="pt-1.5"><Code text={dax} /></div></div>
            </div>
        </div>
    );
}

function Metadata({ node }) {
    const m = node.meta || {};
    const rows = [
        ['Kind', KIND_LABEL[node.kind]],
        ['Layer', node.layer],
        ['Materialization', m.materialized],
        ['Storage mode', m.storageMode],
        ['Relation', m.relation],
        ['Path', m.path],
        ['Home table', m.homeTable],
        ['Page', m.page],
        ['Visuals on page', m.visualCount],
        ['Visual type', m.visualType],
        ['Format string', m.formatString],
        ['Columns', node.columns?.length || null],
        ['Measures', m.measureCount],
    ].filter(([, v]) => v != null && v !== '');

    return (
        <>
            {/* Descriptions can run to a paragraph in real models, so they live
                here rather than in the header. */}
            {m.description && (
                <Section title="Description">
                    <div style={{ color: 'var(--text-2)' }}>{m.description}</div>
                </Section>
            )}

            <table className="w-full mb-5">
                <tbody>
                    {rows.map(([k, v]) => (
                        <tr key={k} className="border-b" style={{ borderColor: 'var(--border)' }}>
                            <td className="py-1.5 pr-3 align-top w-[120px]" style={{ color: 'var(--muted)' }}>{k}</td>
                            <td className="py-1.5 break-words">{String(v)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>

            {m.tags?.length > 0 && (
                <Section title="Tags"><div className="flex flex-wrap gap-1.5">{m.tags.map(t => <Chip key={t}>{t}</Chip>)}</div></Section>
            )}

            {m.renames?.length > 0 && (
                <Section title="Column renames" count={m.renames.length}>
                    {m.renames.map(r => (
                        <div key={r.modelName} className="mono py-0.5">
                            {r.sourceName} <span style={{ color: 'var(--muted)' }}>→</span> {r.modelName}
                        </div>
                    ))}
                </Section>
            )}

            {m.tests?.length > 0 && (
                <Section title="Tests" count={m.tests.length}>
                    <div className="flex flex-wrap gap-1.5">
                        {m.tests.map((t, i) => (
                            <Chip key={i} icon={<IconCheck size="sm" style={{ color: 'var(--ok)' }} />}>
                                {t.name} · {t.severity}
                            </Chip>
                        ))}
                    </div>
                </Section>
            )}

            {node.columns?.length > 0 && <Columns columns={node.columns} />}
        </>
    );
}

/*
 * Tabs name what the node actually has.
 *
 * "Overview / Definition / Metadata" is dbt's vocabulary, and on a visual it
 * asked the reader to guess that the fields and filters it uses live under
 * "Definition" — a word that means compiled SQL two nodes earlier. The panes
 * are the same; the labels are the node's own, and the first tab is whatever
 * that kind is usually opened for.
 *
 * A visual opens on its fields, a measure on its DAX, a table on its impact.
 */
const TABS_BY_KIND = {
    /*
     * No "What breaks" here. A visual is a leaf — nothing reads it, so the
     * pane could only ever say "0 measures and 0 visuals downstream". What it
     * depends on is the real question, and that is the fields list, one hop
     * further out: each row now carries how far back it reaches.
     */
    visual: [
        ['definition', 'Fields & filters', IconAxis],
        ['metadata', 'Details', IconInfo],
    ],
    measure: [
        ['definition', 'DAX & fields', IconCode],
        ['overview', 'What breaks', IconWarn],
        ['metadata', 'Details', IconInfo],
    ],
    page: [
        ['overview', "What's on this page", IconLayers],
        ['metadata', 'Details', IconInfo],
    ],
};

const DEFAULT_TABS = [
    ['overview', 'Overview', IconLayers],
    ['definition', 'Definition', IconCode],
    ['metadata', 'Metadata', IconInfo],
];

const tabsFor = node => TABS_BY_KIND[node.kind] || DEFAULT_TABS;

export default function SidePanel() {
    const data = useStore(s => s.data);
    const selection = useStore(s => s.selection);
    const panelTab = useStore(s => s.panelTab);
    const setPanelTab = useStore(s => s.setPanelTab);
    const select = useStore(s => s.select);
    const selectLocal = useStore(s => s.selectLocal);
    const tab = useStore(s => s.tab);
    const goBack = useStore(s => s.goBack);
    const canGoBack = useStore(s => s.history.length > 0);
    const impact = useStore(s => s.currentImpact());
    const layerOrder = useStore(s => s.layerOrder);
    const panelW = useStore(s => s.panelW);

    if (!selection) return null;
    const node = data.nodes[selection.nodeId];
    if (!node) return null;

    const Icon = nodeIcon(node);

    /*
     * The store keeps one tab across selections, so a reader who was on
     * "Metadata" for a model and then clicks a visual would land on a tab that
     * kind may not even offer. Fall back to that kind's first tab rather than
     * rendering an empty pane or a pill with nothing selected.
     */
    const tabs = tabsFor(node);
    const active = tabs.some(([id]) => id === panelTab) ? panelTab : tabs[0][0];

    /*
     * Case-insensitively, like every other column comparison: the selection
     * carries the card's spelling and an edge carries the extractor's, and on
     * the dbt side colibri lowercases identifiers. Nothing on the reference
     * project differs today — the crossing edges are built from the dbt column
     * objects themselves — but every other place these two spellings met has
     * turned out to be a bug, and this one would fail the same silent way: an
     * empty provenance list, indistinguishable from a column that crosses
     * nowhere.
     */
    const wanted = lower(selection.column);
    const crossing = data.edges.filter(e =>
        e.kind === 'dbt_to_pbi' && (e.source === node.id || e.target === node.id) &&
        (!selection.column ||
            (e.source === node.id && lower(e.sourceColumn) === wanted) ||
            (e.target === node.id && lower(e.targetColumn) === wanted))
    );

    return (
        <aside data-testid="side-panel"
            className="surface flex-none flex flex-col overflow-hidden h-full"
            style={{
                width: panelW ?? 'var(--panel-w)',
            }}>

            {/* Layer, without spending a chip on it. A strip inside the card
                rather than a border on it: as a border it followed the rounded
                corners all the way round and read as a selection ring. */}
            <div className="flex-none" style={{
                height: 3, background: layerColor(node.layer, layerOrder),
            }} />

            <header className="p-3.5 border-b flex-none" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-start gap-2.5">
                    {/*
                     * Back, where the icon would otherwise sit.
                     *
                     * Every way into this panel is destructive — focusing wipes
                     * the reveals, a trace replaces the last one — so the only
                     * route back used to be rebuilding the view by hand:
                     * re-search the node, re-expand it, re-focus. It takes the
                     * kind's slot rather than a row of its own, because a panel
                     * that is one press deep does not need a toolbar.
                     */}
                    {canGoBack ? (
                        <button onClick={goBack} data-testid="panel-back"
                            title="Back to where you were"
                            aria-label="Back to where you were"
                            className="panel-back">
                            <IconArrowLeft size="md" />
                        </button>
                    ) : (
                        <Icon size="lg" style={{ color: KIND_COLOR[node.kind], marginTop: 2 }} />
                    )}
                    <div className="flex-1 min-w-0">
                        <div className="font-semibold truncate" style={{ fontSize: 'var(--fs-h2)' }} title={node.name}>
                            {node.name}
                        </div>
                        {/* Where it comes from. Kind and layer are the chip row
                            and the header border — printing them here too said
                            the same thing twice. */}
                        <div className="truncate mono" title={node.meta.relation || ''}
                            style={{ color: 'var(--muted)' }}>
                            {node.meta.relation || node.meta.homeTable || node.meta.page || '—'}
                        </div>
                    </div>
                    {/* On the layout tab this cleared the lineage canvas's
                        highlight — closing a window is not a reason to throw
                        away the trace on a tab you are not looking at. */}
                    <button className="p-1.5 rounded-md" style={{ color: 'var(--muted)' }}
                        onClick={() => (tab === 'lineage' ? select(null) : selectLocal(null))}
                        title="Close" aria-label="Close panel">
                        <IconX size="md" />
                    </button>
                </div>

                {selection.column && (
                    <button className="mt-2.5 flex items-center gap-1.5"
                        style={{ color: 'var(--accent)', fontSize: 'var(--fs-sm)' }}
                        onClick={() => (tab === 'lineage'
                            ? select(node.id, null)
                            : selectLocal(node.id, null))}>
                        <IconArrowLeft size="sm" />
                        column <b className="mono">{selection.column}</b> — back to the whole {KIND_LABEL[node.kind]}
                    </button>
                )}

                <div className="flex flex-wrap gap-1.5 mt-3">
                    {chipsFor(node).map(([text, tone], i) => (
                        <Chip key={i} tone={tone}>{text}</Chip>
                    ))}
                </div>

                <div className="pill-track mt-3" role="tablist">
                    {tabs.map(([id, label, TabIcon]) => (
                        <button key={id} role="tab" aria-selected={active === id}
                            onClick={() => setPanelTab(id)}
                            className={`pill ${active === id ? 'is-active' : ''}`}>
                            <TabIcon size="sm" />{label}
                        </button>
                    ))}
                </div>
            </header>

            <div className="p-3.5 overflow-auto scrollbar-thin flex-1 min-h-0">
                <TraceCta node={node} />
                {active === 'overview' && (node.kind === 'page'
                    ? <PageContents node={node} data={data} />
                    : <Overview node={node} impact={impact} data={data}
                        selection={selection} crossing={crossing} />)}
                {active === 'definition' && <Definition node={node} />}
                {active === 'metadata' && <Metadata node={node} />}
            </div>
        </aside>
    );
}
