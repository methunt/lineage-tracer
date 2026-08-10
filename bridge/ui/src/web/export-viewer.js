/**
 * Export the graph on screen as one self-contained HTML file.
 *
 * The hosted app is chunked ESM with hashed lazy chunks and a module worker —
 * none of which a browser will run from a `file://` origin. So the exported file
 * is not this app: it is the *viewer* build (vite.config.js, default mode), the
 * same single-file IIFE artifact that has always been openable off disk, shipped
 * alongside the web app as a static asset and fetched on demand.
 *
 * Injecting the graph into it needs no code on the viewer's side: `src/main.jsx`
 * reads `globalThis.__LINEAGE__` while the store's module body evaluates, and the
 * data block below is written into <head>, ahead of the bundle in <body>.
 *
 * Split into pure functions so the escaping can be tested in Node, where the
 * only interesting failure — a node name that closes the script element — is
 * cheap to reproduce.
 */

/** Where the viewer template lands next to the app (public/ → dist-web/). */
export const VIEWER_ASSET = 'viewer.html';

/*
 * Why this exists, and why `JSON.stringify` on its own is not enough.
 *
 * Everything injected below comes from a dbt manifest or a PBIP project: table
 * names, column names, report page titles, descriptions. As far as this code is
 * concerned that is attacker-influenced text, and it is about to be written
 * *inside an HTML element*, where the HTML parser — not the JSON parser — reads
 * it first. `JSON.stringify` escapes for JavaScript; it leaves `<` alone.
 *
 * The sequences that matter, every one of which JSON.stringify passes through
 * intact:
 *
 *   </script   ends the element early — everything after it is parsed as markup,
 *              so a column named `</script><img onerror=...>` is script injection.
 *   <script    opens a nested element the parser can mis-nest.
 *   <!--       starts a comment: it moves the HTML tokenizer into its
 *              script-data-escaped state, which changes where the element ends.
 *   -->        the closing half of that same trick.
 *   U+2028/9   line separators. Legal inside a JSON string, but line terminators
 *              inside a JavaScript string literal, so anything that re-reads
 *              this payload as JS rather than JSON breaks on them.
 *
 * Escaping `<`, `>`, `&` and the two separators as `\uXXXX` covers all of them:
 * none of those characters can then appear literally in the output, so neither
 * can any sequence built out of them. The escapes only ever land inside JSON
 * *string literals* — JSON's structural characters are `{}[]",:` — and
 * `JSON.parse` turns each one back into the original character, so the viewer
 * receives exactly the data that left here.
 *
 * If you are here to simplify this: don't. Dropping the replace re-opens the
 * hole, and test/export.js will go red.
 */
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const DANGEROUS = new RegExp(`[<>&${LS}${PS}]`, 'g');
const ESCAPED = {
    '<': '\\u003c',
    '>': '\\u003e',
    '&': '\\u0026',
    [LS]: '\\u2028',
    [PS]: '\\u2029',
};

/** JSON text, safe to place between `<script>` and `</script>`. */
export function escapeJsonForScript(json) {
    return json.replace(DANGEROUS, c => ESCAPED[c]);
}

/**
 * Put a graph into the viewer template.
 *
 * The payload is a `type="application/json"` block — inert to the HTML parser,
 * never executed — plus one line of real script that parses it onto the global
 * the viewer already reads. Nothing from the graph is ever evaluated as code.
 */
export function injectGraph(template, data) {
    const head = template.indexOf('<head>');
    if (head === -1) throw new Error('viewer template has no <head> — cannot inject data.');

    const payload =
        '<script id="lineage-data" type="application/json">' +
        escapeJsonForScript(JSON.stringify(data)) +
        '</script>' +
        '<script>globalThis.__LINEAGE__=' +
        'JSON.parse(document.getElementById("lineage-data").textContent);</script>';

    const at = head + '<head>'.length;
    return template.slice(0, at) + payload + template.slice(at);
}

/** A filename every filesystem will take, naming the model and the day. */
export function exportFilename(data) {
    const name = String(data?.metadata?.model || 'lineage')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'lineage';
    const day = new Date().toISOString().slice(0, 10);
    return `lineage-${name}-${day}.html`;
}

/**
 * Fetch the template, inject, hand the browser a download.
 *
 * Fetched on click rather than with the landing page: the template is the whole
 * app plus its embedded fonts, several megabytes, and most sessions never
 * export. Resolved against `document.baseURI` so it also works from GitHub
 * Pages' project subpath, where the app is not at the root.
 */
export async function exportViewer(data, { fetch: fetchImpl, document: doc = document } = {}) {
    const get = fetchImpl || ((...a) => fetch(...a));
    const url = new URL(VIEWER_ASSET, doc.baseURI).href;
    const response = await get(url);
    if (!response.ok) throw new Error(`could not load the viewer template (${response.status})`);

    const html = injectGraph(await response.text(), data);
    const href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const a = doc.createElement('a');
    a.href = href;
    a.download = exportFilename(data);
    doc.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked a turn later, not synchronously: revoking while the click's
    // download is still starting hands the browser an empty file.
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
    return a.download;
}
