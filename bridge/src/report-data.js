/**
 * The projection of a merged graph that the views actually read.
 *
 * Its own module because two builders produce it — the CLI's `build.js` and the
 * browser's `build-browser.js` — and a view that renders one shape from one and
 * a slightly different shape from the other is the kind of divergence nobody
 * finds until a user reports it.
 */

/** Everything the UI needs, and nothing it doesn't. */
function toReportData(graph) {
    return {
        metadata: graph.metadata,
        summary: graph.summary,
        layers: graph.layers,
        nodes: graph.nodes,
        edges: graph.edges,
        impact: graph.impact,
        diagnostics: graph.diagnostics,
    };
}

module.exports = { toReportData };
