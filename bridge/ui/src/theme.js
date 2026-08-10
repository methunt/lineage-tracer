/**
 * Colour lookups shared by the canvas, the rail and the panel, so a layer is
 * the same colour everywhere it appears.
 */

export const KIND_COLOR = {
    source: 'var(--kind-source)',
    model: 'var(--kind-model)',
    snapshot: 'var(--kind-snapshot)',
    pbiTable: 'var(--kind-table)',
    page: 'var(--kind-page)',
    measure: 'var(--kind-measure)',
    visual: 'var(--kind-visual)',
    unknown: 'var(--muted)',
};

export const KIND_LABEL = {
    source: 'source', model: 'model', snapshot: 'snapshot',
    pbiTable: 'PBI table', page: 'report page', measure: 'measure',
    visual: 'visual', unknown: 'unresolved',
};

/**
 * Layers take their colour from their *position* in the derived order, not
 * their name — so the ramp reads left to right as the pipeline does, whatever
 * a project calls its folders. Power BI sits outside the sweep.
 */
export function layerColor(layer, layerOrder) {
    if (layer === 'powerbi') return 'var(--layer-pbi)';
    // Position among top folders, not among every path: a card in
    // `staging/crm/base` belongs to the same stage as one in `staging`, and
    // giving each subfolder its own colour would make the ramp read as five
    // stages when there are two.
    const tops = [...new Set(layerOrder.map(topLayer))];
    const i = tops.indexOf(topLayer(layer));
    return `var(--layer-${Math.max(0, Math.min(i < 0 ? 0 : i, 4))})`;
}

/**
 * The top folder of a layer path — `staging/crm/base` -> `staging`.
 *
 * `node.layer` is the full folder chain so the navigation tree can nest, but
 * the canvas axis and the colour ramp are both about stages, and a stage is the
 * top folder. Everything that groups *visually* goes through here; the tree is
 * the only thing that uses the whole path.
 */
export function topLayer(layer) {
    const at = String(layer ?? '').indexOf('/');
    return at < 0 ? layer : layer.slice(0, at);
}
