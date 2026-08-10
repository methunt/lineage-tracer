import React from 'react';
import { useStore } from './store';
import LineageGraph from './LineageGraph';
import SidePanel from './SidePanel';
import Sidebar from './Sidebar';
import Resizer from './Resizer';
import Logo from './Logo';
import Diagnostics from './Diagnostics';
import PageLayout from './PageLayout';
import SearchPalette from './SearchPalette';
import { IconSearch, IconSun, IconMoon, IconLayers, IconWarn, IconPage, IconDownload, IconSpinner } from './icons';
import { exportViewer } from './web/export-viewer';

/*
 * Export belongs to the hosted app only.
 *
 * The same components render the viewer — the artifact an export *produces* —
 * and there the button would be a dead control: it fetches the viewer template
 * from beside the app, and beside an exported file on someone's desk there is
 * no such thing. `MODE` is a build-time constant, so this compiles the whole
 * control out of the viewer bundle rather than hiding it at runtime.
 */
const CAN_EXPORT = import.meta.env.MODE === 'web';

export default function App() {
    const data = useStore(s => s.data);
    const tab = useStore(s => s.tab);
    const setTab = useStore(s => s.setTab);
    const theme = useStore(s => s.theme);
    const toggleTheme = useStore(s => s.toggleTheme);
    const railW = useStore(s => s.railW);
    const setRailW = useStore(s => s.setRailW);
    const panelW = useStore(s => s.panelW);
    const setPanelW = useStore(s => s.setPanelW);
    const selection = useStore(s => s.selection);
    const selectionView = useStore(s => s.selectionView);
    const setPaletteOpen = useStore(s => s.setPaletteOpen);
    const hasGraph = useStore(s => s.hasGraph);
    /*
     * The panel belongs to the view that opened it. The trace still carries
     * across tabs; the window does not.
     *
     * Asked per view rather than once against `tab`, because both views stay
     * mounted now — a single boolean would have put a panel in each tree and
     * left a hidden one in the DOM.
     */
    const panelOn = view => Boolean(selection) && selectionView === view;

    const issues = data.summary?.issues || 0;
    // No report folder means no pages, and a tab that opens on an empty state
    // is worse than no tab.
    const pageCount = React.useMemo(
        () => Object.values(data.nodes).filter(n => n.kind === 'page').length, [data]);

    /*
     * Export: the graph on screen, as one file you can email to someone who has
     * never heard of this tool.
     *
     * Offered only once there is a graph to export — before that the landing
     * page is up and the header behind it is inert anyway.
     */
    const [exportState, setExportState] = React.useState(null);   // null | 'busy' | error text
    const onExport = React.useCallback(async () => {
        setExportState('busy');
        try {
            await exportViewer(data);
            setExportState(null);
        } catch (err) {
            setExportState(err?.message || 'export failed');
        }
    }, [data]);

    // ⌘K / Ctrl-K from anywhere, and never while the reader is typing into
    // something else — the palette owns its own Escape once open.
    React.useEffect(() => {
        const onKey = e => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setPaletteOpen(true);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [setPaletteOpen]);

    return (
        <div className="h-full flex flex-col">
            {/*
              * Three tracks, not a flex row: the tabs sit in the middle column
              * so they are centred against the window rather than against
              * whatever the brand and the controls happen to measure. The outer
              * columns are equal, so a longer report name cannot drag the tabs
              * off centre.
              */}
            <header className="grid items-center gap-5 px-5 py-3 border-b flex-none"
                style={{
                    background: 'var(--panel)', borderColor: 'var(--border)',
                    gridTemplateColumns: '1fr auto 1fr',
                }}>
                {/* Title over subtitle, on 1.4 line-height so the two are
                    clearly separate lines rather than one crowded block, and
                    with room to the right so neither can crowd the tabs. */}
                <div className="flex items-center gap-3 min-w-0 pr-8">
                    <Logo size={34} className="flex-none" />
                    <div className="min-w-0" style={{ lineHeight: 1.4 }}>
                        <div className="font-semibold tracking-tight"
                            style={{ fontSize: 'var(--fs-h1)' }}>Lineage Tracer</div>
                        <div className="truncate"
                            style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}
                            title={`${data.metadata.dbt?.projectName || 'dbt'} → ${data.metadata.model || 'Power BI'}`}>
                            {data.metadata.dbt?.projectName || 'dbt'} → {data.metadata.model || 'Power BI'}
                        </div>
                    </div>
                </div>

                <nav className="pill-track" role="tablist">
                    {[['lineage', 'Lineage', <IconLayers key="i" size="sm" />],
                    ...(pageCount ? [['layout', 'Page layout', <IconPage key="i" size="sm" />]] : []),
                    ['diagnostics', `Diagnostics${issues ? ` (${issues})` : ''}`, <IconWarn key="i" size="sm" />]]
                        .map(([id, label, icon]) => (
                            <button key={id} role="tab" aria-selected={tab === id}
                                onClick={() => setTab(id)}
                                className={`pill ${tab === id ? 'is-active' : ''}`}>
                                {icon}{label}
                            </button>
                        ))}
                </nav>

                {/* Search lives here rather than on a strip of its own: it is a
                    global control, and the strip it used to sit on cost the
                    canvas a node card's worth of height. */}
                <div className="flex items-center justify-end gap-2 min-w-0">
                    {/*
                      * Looks like the box it replaces and keeps its place, so
                      * nothing in the header moves — but it opens the palette
                      * rather than filtering as you type. Filtering the canvas
                      * on every keystroke re-lays-out several hundred nodes; the rail
                      * already filters, with layers and eyes.
                      */}
                    {tab === 'lineage' && (
                        <button
                            onClick={() => setPaletteOpen(true)}
                            aria-label="Search nodes and columns"
                            data-testid="open-search"
                            className="relative flex items-center gap-2 pl-9 pr-3 py-2 rounded-full border w-[260px] max-w-full"
                            style={{ borderColor: 'var(--border)', background: 'var(--panel-2)', color: 'var(--muted)' }}
                        >
                            <IconSearch size="sm" className="absolute left-3" style={{ color: 'var(--muted)' }} />
                            <span className="flex-1 text-left truncate">Search…</span>
                            <kbd className="flex-none px-1.5 py-0.5 rounded border"
                                style={{ borderColor: 'var(--border)', fontSize: 'var(--fs-sm)' }}>
                                {navigator.platform.startsWith('Mac') ? '⌘K' : 'Ctrl K'}
                            </kbd>
                        </button>
                    )}
                    <button onClick={toggleTheme}
                        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                        aria-label="Toggle theme"
                        aria-pressed={theme === 'dark'}
                        className="p-2 rounded-md border flex-none"
                        style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                        {theme === 'dark' ? <IconMoon size="md" /> : <IconSun size="md" />}
                    </button>
                    {/* Same shape as the theme button beside it — this is a
                        header icon control, not a call to action. */}
                    {CAN_EXPORT && hasGraph && (
                        <button onClick={onExport}
                            disabled={exportState === 'busy'}
                            title={exportState && exportState !== 'busy'
                                ? `Export failed: ${exportState}`
                                : 'Download this graph as one self-contained HTML file'}
                            aria-label="Export as a self-contained HTML file"
                            data-testid="export-graph"
                            data-state={exportState === 'busy' ? 'busy' : 'idle'}
                            className="p-2 rounded-md border flex-none"
                            style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                            {exportState === 'busy'
                                ? <IconSpinner size="md" className="animate-spin" />
                                : <IconDownload size="md" />}
                        </button>
                    )}
                </div>
            </header>

            {/*
             * Hidden, not unmounted.
             *
             * Switching tabs used to throw the canvas away: coming back re-ran
             * the ELK solve — seconds on a graph of a few hundred nodes — and refitted the
             * viewport, so every trip to the layout and back cost the zoom, the
             * pan, and the cards you had dragged. `display: none` keeps all of
             * that in place at the cost of two live component trees, which is
             * cheap next to re-solving a graph nobody asked to change.
             *
             * Neither a metric strip nor a filter strip above it: the canvas is
             * the report, and both bands cost it height. "Linked only" joined
             * the other filters in the rail; search moved to the header. See
             * ui-spec §18.
             */}
            <div className="app-body flex-1 min-h-0 flex"
                style={{ display: tab === 'lineage' ? 'flex' : 'none' }}>
                <Sidebar />
                {/* 216, not 200: the rail's own tab track needs 184px and its
                    padding another 20, so 200 left the second tab half out of
                    view before the reader had done anything wrong. A minimum
                    that cannot show the panel's own controls is not a minimum. */}
                <Resizer side="left" width={railW} onChange={setRailW} min={216} max={520} />
                <div className="surface flex-1 min-w-0 overflow-hidden"><LineageGraph /></div>
                {panelOn('lineage') && (
                    <Resizer side="right" width={panelW} onChange={setPanelW} min={344} max={860} />
                )}
                {panelOn('lineage') && <SidePanel />}
            </div>

            {/* The same side panel as the lineage tab, because picking a box
                asks the same question a node card does: what does this read,
                and what breaks if it changes. A second panel would be a second
                vocabulary for one answer. */}
            {pageCount > 0 && (
                <div className="app-body flex-1 min-h-0 flex"
                    style={{ display: tab === 'layout' ? 'flex' : 'none' }}>
                    <PageLayout />
                    {panelOn('layout') && (
                        <Resizer side="right" width={panelW} onChange={setPanelW} min={344} max={860} />
                    )}
                    {panelOn('layout') && <SidePanel />}
                </div>
            )}
            {/* Hidden rather than unmounted, like the two above: rebuilding a
                few hundred rows on every visit costs a visible pause and
                throws away where you had scrolled to. */}
            <div className="app-body flex-1 min-h-0 flex flex-col"
                style={{ display: tab === 'diagnostics' ? 'flex' : 'none' }}>
                <div className="surface flex-1 min-h-0 overflow-auto scrollbar-thin"><Diagnostics /></div>
            </div>
            <SearchPalette />
        </div>
    );
}
