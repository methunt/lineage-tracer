import React, { useMemo, useState } from 'react';
import { useStore } from './store';
import { IconSearch, IconWarn, IconCheck, IconChevronRight } from './icons';

/**
 * The worklist: every gap between the two graphs, one table per kind of gap.
 *
 * Ordered by how actionable each section is. `severity` drives the badge and
 * the summary counts, and is a property of the section rather than the row —
 * an unresolved mapping row is always something to fix, a dbt node nobody
 * consumes is usually fine.
 *
 * `mono` marks columns holding identifiers rather than prose. Table and field
 * names are compared character by character by whoever reads them, and a
 * proportional typeface makes `Global Region Group` and `Global  Region
 * Group` look identical — which is exactly the sort of difference this tab
 * exists to surface.
 */
const SECTIONS = [
    {
        key: 'unresolvedMappingRows', title: 'Mapping rows that could not be resolved',
        severity: 'error', hint: 'Fix these in the mapping file.',
        cols: [['Row', r => r.row, { width: '5rem', mono: true }], ['Reason', r => r.reason]],
    },
    {
        key: 'mappingErrors', title: 'Invalid mapping rows',
        severity: 'error', hint: 'The row could not be read at all.',
        cols: [['Row', r => r.row, { width: '5rem', mono: true }], ['Problem', r => r.message]],
    },
    {
        key: 'brokenRefs', title: 'Broken report references',
        severity: 'error',
        hint: 'A visual points at a field the semantic model does not define. Usually a rename that the report never caught up with.',
        cols: [
            ['Page', r => r.page, { width: '18%' }],
            ['Visual', r => r.visual, { width: '22%' }],
            ['Field', r => r.field, { mono: true }],
            ['Reason', r => r.reason, { muted: true }],
        ],
    },
    {
        key: 'relationshipKeysUnlinked', title: 'Join keys with no dbt column behind them',
        severity: 'error',
        hint: 'The table resolves to a warehouse relation but this key did not match a dbt column. Unlike a broken visual, a broken join raises no error — the report keeps rendering, with different numbers.',
        cols: [
            ['Table', r => r.table, { mono: true }],
            ['Key', r => r.column, { mono: true }],
            ['Joins', r => r.joins, { mono: true }],
            ['State', r => r.state, { width: '7rem', muted: true }],
        ],
        link: r => `pbi:table:${r.table}`,
    },
    {
        key: 'multiSourceColumns', title: 'Columns declared to come from more than one place',
        severity: 'info',
        hint: 'Legitimate for a column built from several fields, and also what a typo in "To Column" looks like. Both sources are kept.',
        cols: [
            ['Table', r => r.table, { mono: true }],
            ['Column', r => r.column, { mono: true }],
            ['Declared sources', r => r.sources, { mono: true }],
            ['Rows', r => r.rows, { width: '7rem', muted: true }],
        ],
        link: r => `pbi:table:${r.table}`,
    },
    {
        key: 'untestedHighImpact', title: 'Widest reach, no dbt test',
        // Context, not a defect. Plenty of models are legitimately untested —
        // a passthrough view, a scratch model, anything whose correctness is
        // asserted upstream — so 38 rows of this would swamp the count of
        // things that are actually wrong.
        severity: 'info',
        hint: 'Models and sources in the high-impact band with no test of any kind. Not every model needs one; this is here so the ones whose failure would be felt furthest are at least visible.',
        cols: [
            ['Name', r => r.name, { mono: true }],
            ['Layer', r => r.layer, { width: '10rem', muted: true }],
            ['Visuals downstream', r => r.visuals, { width: '11rem' }],
        ],
        link: r => r.id,
    },
    {
        key: 'modelTablesWithoutSource', title: 'Semantic model tables with no warehouse source',
        severity: 'warning',
        hint: 'Power BI tables, not dbt models. Loaded from a spreadsheet, typed by hand, or built by a query this parser could not follow.',
        cols: [['Table', r => r.table, { mono: true }], ['Reason', r => r.reason, { muted: true }]],
        link: r => `pbi:table:${r.table}`,
    },
    {
        key: 'ambiguousMatches', title: 'Ambiguous matches',
        severity: 'warning',
        hint: 'More than one dbt model builds a relation with this name. The first was used.',
        cols: [
            ['Where', r => r.source], ['Relation', r => r.relation, { mono: true }],
            ['Matched on', r => r.matchLevel, { muted: true }],
        ],
    },
    {
        key: 'modelColumnsUnlinked', title: 'Semantic model columns not traced to dbt',
        severity: 'info',
        hint: 'Columns of Power BI tables. Expected for calculated columns and for anything outside the warehouse.',
        cols: [['Table', r => r.table, { mono: true }], ['Column', r => r.column, { mono: true }]],
        link: r => `pbi:table:${r.table}`,
    },
    {
        key: 'dbtNodesNotUsed', title: 'This report does not read these tables',
        severity: 'info',
        hint: 'Nothing here reaches a visual, a measure or a page — directly or through '
            + 'anything built on it. That is a statement about this report only: another '
            + 'report, a notebook or an export may well read them, and this tool sees one '
            + 'report at a time. Not a list of things to drop.',
        cols: [
            ['Name', r => r.name, { mono: true }], ['Kind', r => r.kind, { width: '8rem' }],
            ['Layer', r => r.layer, { width: '10rem', muted: true }],
        ],
        link: r => r.id,
    },
    {
        key: 'mappingWarnings', title: 'Ignored mapping rows',
        severity: 'info', hint: 'Read, understood, and deliberately skipped.',
        cols: [['Row', r => r.row, { width: '5rem', mono: true }], ['Note', r => r.message, { muted: true }]],
    },
];

const SEVERITY = {
    error: { label: 'Error', colour: 'var(--bad)' },
    warning: { label: 'Warning', colour: 'var(--warn)' },
    info: { label: 'Info', colour: 'var(--muted)' },
};

// Long tables get a filter box rather than a scroll and a hope.
const FILTER_AT = 8;
// Rows rendered before the "show the rest" button. High enough that most
// sections never hit it, low enough that 5,000 unconsumed nodes cannot stall
// the tab on open.
const PAGE = 100;

export default function Diagnostics() {
    const data = useStore(s => s.data);
    /* One action, so Back knows you came from here: as select-then-setTab the
       snapshot was taken after the tab had moved, and Back returned you to the
       canvas you were already looking at, still carrying the trace this row
       put there. */
    const traceOnCanvas = useStore(s => s.traceOnCanvas);

    const jump = id => {
        if (!data.nodes[id]) return;
        traceOnCanvas(id);
    };

    const sections = useMemo(
        () => SECTIONS.map(s => ({ ...s, rows: data.diagnostics[s.key] || [] })),
        [data]);
    // Split rather than sorted: a clean section is a one-line reassurance and
    // has no business occupying a card-sized slot in the grid.
    const clean = sections.filter(s => s.rows.length === 0);
    const found = sections.filter(s => s.rows.length > 0);

    const totals = useMemo(() => {
        const out = { error: 0, warning: 0, info: 0 };
        for (const s of sections) out[s.severity] += s.rows.length;
        return out;
    }, [sections]);

    const actionable = totals.error + totals.warning;

    return (
        <div className="flex-1 overflow-auto scrollbar-thin p-6" data-testid="diagnostics">
            <div className="dt-page">
                <header className="mb-6">
                    <h1 className="font-semibold tracking-tight" style={{ fontSize: 'var(--fs-h1)' }}>
                        Diagnostics
                    </h1>
                    <p className="mt-1" style={{ color: 'var(--muted)' }}>
                        Every gap between the two graphs. Errors and warnings are worth acting on;
                        the rest is context. Rows with a chevron open that node on the canvas.
                    </p>

                    {/* The tab's own count is errors + warnings. Saying so here
                        stops the info total from reading as a discrepancy. */}
                    <div className="dt-summary mt-4">
                        {actionable === 0 ? (
                            <span className="dt-tally" style={{ color: 'var(--ok)' }}>
                                <IconCheck size="sm" /> Nothing to act on
                            </span>
                        ) : (
                            <>
                                {['error', 'warning'].map(key => (
                                    <span key={key} className="dt-tally">
                                        <span className="dt-dot" style={{ background: SEVERITY[key].colour }} />
                                        <span className="tnum font-semibold">{totals[key]}</span>
                                        <span style={{ color: 'var(--muted)' }}>
                                            {SEVERITY[key].label.toLowerCase()}{totals[key] === 1 ? '' : 's'}
                                        </span>
                                    </span>
                                ))}
                                <span className="dt-rule" />
                                <span className="dt-tally" style={{ color: 'var(--muted)' }}>
                                    <span className="tnum font-semibold">{actionable}</span> to act on,
                                    <span className="tnum font-semibold">&nbsp;{totals.info}</span> for context
                                </span>
                            </>
                        )}
                    </div>
                </header>

                {/*
                  * Two columns where the window allows it, and the clean
                  * sections gathered into one strip above them.
                  *
                  * Stacked one per row, a report with three findings and eight
                  * "none"s made the reader scroll past eight reassurances to
                  * reach them, on a page two thirds of which was empty margin.
                  * Cards are packed masonry-style into columns rather than laid
                  * out in grid rows: a grid row is as tall as its tallest card,
                  * which left a one-row section standing beside a wall of empty
                  * space. The column count follows a minimum width rather than a
                  * breakpoint, so a narrow window gets one column, and a section
                  * with wide rows still claims the full width.
                  */}
                {clean.length > 0 && (
                    <div className="dt-clean-strip">
                        {clean.map(section => (
                            <Section key={section.key} section={section} nodes={data.nodes} onJump={jump} />
                        ))}
                    </div>
                )}
                <div className="dt-grid">
                    {found.map(section => (
                        <div key={section.key}
                            className={section.cols.length > 4 ? 'dt-grid-wide' : ''}>
                            <Section section={section} nodes={data.nodes} onJump={jump} />
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function Section({ section, nodes, onJump }) {
    const [query, setQuery] = useState('');
    const [expanded, setExpanded] = useState(false);
    const { rows, cols, severity } = section;

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return rows;
        return rows.filter(row =>
            cols.some(([, get]) => String(get(row) ?? '').toLowerCase().includes(q)));
    }, [rows, cols, query]);

    const shown = expanded ? filtered : filtered.slice(0, PAGE);
    const tone = SEVERITY[severity];

    /*
     * An empty section is one line, not a card with a heading, an explanation
     * and the word "None". Eight sections are usually mostly empty, and giving
     * each of them a full card pushed the first real finding below the fold —
     * the tab's job is to show what is wrong, not to enumerate what is fine.
     */
    if (rows.length === 0) {
        return (
            <p className="dt-clear" data-testid={`diag-${section.key}`}>
                <IconCheck size="sm" style={{ color: 'var(--ok)' }} />
                <span>{section.title}</span>
                <span style={{ color: 'var(--muted)' }}>none</span>
            </p>
        );
    }

    return (
        <section className="dt-card" data-testid={`diag-${section.key}`}>
            <header className="dt-card-head">
                <span className="dt-dot" style={{ background: tone.colour }} />
                <h2 className="font-semibold" style={{ fontSize: 'var(--fs-h3)' }}>{section.title}</h2>
                <span className="dt-count tnum">{rows.length}</span>
                <span className="flex-1" />
                {rows.length >= FILTER_AT && (
                    <div className="dt-find">
                        <IconSearch size="sm" style={{ color: 'var(--muted)' }} />
                        <input
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            placeholder={`Filter ${rows.length} rows…`}
                            aria-label={`Filter ${section.title}`}
                        />
                    </div>
                )}
            </header>

            {section.hint && <p className="dt-hint">{section.hint}</p>}

            {filtered.length === 0 ? (
                <p className="dt-empty"><IconWarn size="sm" /> No row matches “{query}”</p>
            ) : (
                <>
                    <div className="dt-scroll">
                        <table className="dt">
                            <thead>
                                <tr>
                                    {cols.map(([label, , opt = {}]) => (
                                        <th key={label} style={opt.width ? { width: opt.width } : undefined}>
                                            {label}
                                        </th>
                                    ))}
                                    {section.link && <th className="dt-act" aria-label="Open" />}
                                </tr>
                            </thead>
                            <tbody>
                                {shown.map((row, i) => (
                                    <tr key={i}>
                                        {cols.map(([label, get, opt = {}]) => {
                                            const value = get(row);
                                            const text = value == null || value === '' ? '—' : String(value);
                                            return (
                                                <td key={label}
                                                    className={opt.mono ? 'mono' : undefined}
                                                    style={{ color: opt.muted ? 'var(--muted)' : undefined }}
                                                    title={text.length > 60 ? text : undefined}>
                                                    {text}
                                                </td>
                                            );
                                        })}
                                        {section.link && (
                                            <td className="dt-act">
                                                {nodes[section.link(row)] && (
                                                    <button className="dt-open"
                                                        data-testid="diagnostic-open"
                                                        onClick={() => onJump(section.link(row))}
                                                        title="Show on the canvas">
                                                        Open <IconChevronRight size="sm" />
                                                    </button>
                                                )}
                                            </td>
                                        )}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {filtered.length > shown.length && (
                        <button className="dt-more" onClick={() => setExpanded(true)}>
                            Show the remaining {filtered.length - shown.length}
                        </button>
                    )}
                </>
            )}
        </section>
    );
}
