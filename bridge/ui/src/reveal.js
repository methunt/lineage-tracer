/**
 * Staged reveals: what one press of `+` adds, on the two cards where "one hop"
 * is an ambiguous question.
 *
 * Every other card on the canvas has exactly one kind of neighbour, so `+` means
 * one thing and needs no menu. A Power BI table does not: downstream of it sit
 * pages *and* measures, and one press used to add both, plus the visuals behind
 * them, in a single flood. A page is worse — it holds visuals and measures, and
 * the reader thinks of both as "on this page" even though the graph points them
 * in opposite directions.
 *
 * So those two cards get a menu instead of a button: named kinds, with counts,
 * one hop each. The counts are the whole point — a reader who can see
 * `Measures (7)` before pressing is making a decision, not a discovery.
 */

/*
 * Direction is per item, not per card, and `page → measure` is why.
 *
 * `page_to_visual` points out of a page (a page contains its visuals) while
 * `measure_to_page` points in (a measure is used *by* a page). Both are "on this
 * page" to anyone reading a report, so this menu reads containment rather than
 * flow — the one place on the canvas where `+` is not a lineage hop. That is
 * what the heading says out loud.
 */
export const REVEAL_MENUS = {
    pbiTable: {
        heading: 'Downstream',
        items: [
            { kind: 'page', label: 'Pages', dir: 'out' },
            { kind: 'measure', label: 'Measures', dir: 'out' },
            /*
             * A table can be downstream of a table, and the menu used to have no
             * row that could say so — the edge existed and there was no way to
             * reveal it.
             *
             * Two things arrive this way. A calculated column reading another
             * table names it as a dependency, and a field parameter is downstream
             * of every field it offers. Both break the table they point at if
             * that field is renamed, and neither is a page or a measure, so
             * neither had a row it could appear in.
             */
            { kind: 'pbiTable', label: 'Tables', dir: 'out' },
        ],
    },
    page: {
        heading: 'On this page',
        items: [
            { kind: 'visual', label: 'Visuals', dir: 'out' },
            { kind: 'measure', label: 'Measures', dir: 'in' },
        ],
    },
};

/** The default item for a card kind: the first, and the one pre-highlighted. */
export const defaultPick = cardKind => REVEAL_MENUS[cardKind]?.items[0].kind;

/*
 * One reveal key per kind, so the kinds retract independently.
 *
 * The plain buttons key their reveals `<id>|up` / `<id>|down`; these sit
 * alongside as `<id>|kind:measure`. Nothing has to distinguish them — every
 * consumer unions the values — but they must not collide, or adding pages would
 * silently drop the measures added a moment earlier.
 */
export const revealKey = (nodeId, kind) => `${nodeId}|kind:${kind}`;

/**
 * The neighbours one menu item would add: one hop, that kind only.
 *
 * Deliberately one hop with no depth parameter. Two hops of a kind-filtered walk
 * has no meaning a reader can predict — pages have no pages below them, so the
 * second hop either adds nothing or silently changes kind and re-creates the
 * flood this exists to replace.
 */
export function revealNeighbours(nodeId, item, adj, nodes) {
    const map = item.dir === 'out' ? adj.out : adj.inn;
    const pick = item.dir === 'out' ? e => e.target : e => e.source;
    const found = [];
    const seen = new Set();
    for (const edge of map.get(nodeId) || []) {
        const id = pick(edge);
        if (seen.has(id) || nodes[id]?.kind !== item.kind) continue;
        seen.add(id);
        found.push(id);
    }
    return found;
}

/** Every item of a card's menu with its count, for rendering and for the state. */
export function revealOptions(nodeId, cardKind, adj, nodes) {
    const menu = REVEAL_MENUS[cardKind];
    if (!menu) return null;
    return menu.items.map(item => ({
        ...item,
        ids: revealNeighbours(nodeId, item, adj, nodes),
    }));
}

/*
 * Above this, a single reveal is worth confirming.
 *
 * The menu already shows the number, so this is not the reader's first warning —
 * it is the guard for the page holding eighty visuals, where the count is easy
 * to read past and the layout solve that follows is not free.
 */
export const LARGE_REVEAL = 60;
