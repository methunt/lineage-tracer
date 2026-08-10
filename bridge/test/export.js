/**
 * The export injection, and specifically its escaping.
 *
 * Writing JSON into an HTML `<script>` element is a script-injection sink, and
 * every string in a lineage graph — model names, column names, report page
 * titles — is data this tool did not write. A dbt model called
 * `</script><img onerror=...>` is a perfectly legal dbt model.
 *
 * So the fixture below is a graph whose names carry every sequence that can
 * break out of, or corrupt, a script element, and the assertions are the two
 * that matter: the document must parse with the payload still inside its own
 * element, and the data read back out of it must be identical to what went in.
 *
 * Delete the `.replace` in export-viewer.js and this file goes red — which is
 * the point of it.
 *
 *   node test/export.js
 */
const { JSDOM } = require('jsdom');

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/** Everything that has ever ended a script element early, plus the separators. */
const HOSTILE = [
    '</script>',
    '</script >',
    '</SCRIPT>',
    '</script\t>',
    '<script>alert(1)</script>',
    '<!--',
    '-->',
    '<!--<script>',
    `line${LS}separator`,
    `paragraph${PS}separator`,
    '&amp; & <>',
    '\\u003c not really escaped',
    '"quotes" and \\backslashes\\',
];

/** A graph shaped like a real one, with hostile text in every name field. */
function hostileGraph() {
    const nodes = {};
    HOSTILE.forEach((text, i) => {
        nodes[`dbt:model.evil_${i}`] = {
            id: `dbt:model.evil_${i}`,
            kind: 'model',
            name: text,
            columns: [{ name: text, description: text, dataType: 'varchar' }],
            meta: { resourceType: 'model', tags: [text] },
        };
    });
    return {
        metadata: { generatedAt: '2026-01-01T00:00:00.000Z', model: HOSTILE[0], inputs: {} },
        summary: { crossLinks: 0 },
        layers: ['sources', 'powerbi'],
        nodes,
        edges: [{ source: 'a', target: 'b', sourceColumn: HOSTILE[0], targetColumn: HOSTILE[5] }],
        impact: { node: {}, column: {}, bands: { high: 10, medium: 3, low: 1 } },
        diagnostics: { notes: HOSTILE },
    };
}

const TEMPLATE = '<!doctype html><html lang="en"><head><title>Lineage Tracer</title></head>' +
    '<body><div id="root"></div><script>window.__RAN__=true;</script></body></html>';

async function run() {
    const { injectGraph, escapeJsonForScript, exportFilename } =
        await import('../ui/src/web/export-viewer.js');

    let failures = 0;
    const check = (name, pass, detail) => {
        console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
        if (!pass) failures++;
    };

    const data = hostileGraph();
    const html = injectGraph(TEMPLATE, data);

    // The element must end where we ended it, not at the first `</script` a
    // model name happens to contain.
    const OPEN = '<script id="lineage-data" type="application/json">';
    const at = html.indexOf(OPEN) + OPEN.length;
    const expected = escapeJsonForScript(JSON.stringify(data));
    check('the payload element ends where the injector ended it',
        html.indexOf('</script', at) === at + expected.length,
        `first terminator at +${html.indexOf('</script', at) - at} of ${expected.length}`);
    const payload = /<script id="lineage-data" type="application\/json">([\s\S]*?)<\/script>/
        .exec(html);
    check('the payload sits in exactly one script element', !!payload);
    check('the separators are escaped, not embedded',
        !!payload && !payload[1].includes(LS) && !payload[1].includes(PS));
    check('angle brackets and ampersands are escaped',
        !!payload && !/[<>&]/.test(payload[1]));

    // And it must actually be a document, with the graph still on the global
    // where the viewer looks for it — parsed by the real HTML parser, not by a
    // regex that might disagree with one.
    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    const win = dom.window;
    check('the document parses and its own script still runs', win.__RAN__ === true);
    check('nothing from the graph escaped into the DOM',
        win.document.querySelectorAll('img, iframe, object').length === 0 &&
        win.document.querySelectorAll('script').length === 3,
        `${win.document.querySelectorAll('script').length} script elements`);

    const back = win.__LINEAGE__;
    check('the graph reaches the global the viewer reads', !!back);
    check('and it is identical to the graph that went in',
        JSON.stringify(back) === JSON.stringify(data));
    // Named explicitly, because "identical JSON" would still pass if every
    // hostile string had been mangled the same way on both sides.
    check('every hostile name survives verbatim',
        HOSTILE.every((text, i) => back.nodes[`dbt:model.evil_${i}`].name === text),
        `${HOSTILE.length} names`);
    win.close();

    // A name that is nothing but punctuation must not produce a filename that
    // an OS refuses, or an empty one.
    check('the filename survives a hostile model name',
        /^lineage-[A-Za-z0-9._-]*-\d{4}-\d{2}-\d{2}\.html$/.test(exportFilename(data)),
        exportFilename(data));

    // The escaping is only ever applied inside JSON string literals, so the
    // structure has to come back out unchanged on its own.
    const plain = JSON.parse(escapeJsonForScript(JSON.stringify({ a: [1, 2], b: { c: true } })));
    check('structural JSON is untouched', JSON.stringify(plain) === '{"a":[1,2],"b":{"c":true}}');

    return failures;
}

module.exports = { run };

if (require.main === module) {
    run().then(failures => {
        console.log(failures ? `\n${failures} check(s) failed.` : '\nAll export checks passed.');
        process.exit(failures ? 1 : 0);
    }).catch(err => { console.error(err); process.exit(1); });
}
