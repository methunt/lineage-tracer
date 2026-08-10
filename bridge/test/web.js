/**
 * The hosted app, driven end to end in a real browser.
 *
 * This is the only test that can prove the thing the whole web build exists
 * for: that a user who drops four files on the page gets the same graph the
 * CLI would have produced from the same four files. Everything between those
 * two points — Pyodide, sqlglot compiled to wasm, colibri, the CommonJS
 * parsers put through a bundler — is machinery that can only be wrong in a
 * browser, so it is only tested in one.
 *
 * The reference is built by the CLI in this same run rather than committed:
 * a golden file would have to be regenerated whenever a parser improves, and
 * a stale one fails as loudly as a real regression while meaning nothing.
 *
 * Both delivery paths are covered, because they are not the same program. The
 * built bundle and the dev server convert the CommonJS parsers with different
 * tools — Vite's own pass at build time, a serve-time plugin in dev — and each
 * produces a different module shape. Testing one has twice now left the other
 * broken in a way nothing else could see.
 *
 *   node test/web.js            the built app in ui/dist-web
 *   node test/web.js --dev      the dev server, started and stopped here
 *   node test/web.js --headed   watch either of them happen
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'ui', 'dist-web');
const SAMPLES = path.resolve(ROOT, '..', 'samples');

const MANIFEST = path.join(SAMPLES, 'dbt-sqlserver', 'manifest.json');
const CATALOG = path.join(SAMPLES, 'dbt-sqlserver', 'catalog.json');
const MAPPING = path.join(SAMPLES, 'mapping-example.csv');

// Pyodide downloads ~7 MB before it can run a line of Python. On a cold cache
// that is the whole budget; the extraction itself is seconds.
const TIMEOUT = 240_000;

let failures = 0;
const check = (ok, label, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures++;
};

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm',
    '.woff2': 'font/woff2', '.whl': 'application/octet-stream',
};

/** A static server, because a file:// origin has no workers and no fetch. */
function serve(dir) {
    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
        const file = path.join(dir, rel);
        if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404).end('not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

/** What the CLI makes of the same four inputs. */
function referenceGraph() {
    const out = path.join(require('os').tmpdir(), `lineage-web-ref-${process.pid}.json`);
    const run = spawnSync(process.execPath, [
        path.join(ROOT, 'src', 'cli.js'), 'graph',
        '--manifest', MANIFEST, '--catalog', CATALOG,
        '--pbip', SAMPLES, '--mapping', MAPPING, '--out', out,
    ], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`reference build failed:\n${run.stderr || run.stdout}`);
    const graph = JSON.parse(fs.readFileSync(out, 'utf8'));
    fs.unlinkSync(out);
    return graph;
}

/**
 * Start `vite --mode web` and wait for it to say where it is listening.
 *
 * Its own server rather than the one the developer may already have running:
 * a test that silently passes against a stale dev server left open in another
 * terminal is worse than no test.
 */
function startDevServer() {
    return new Promise((resolve, reject) => {
        // Vite's own entry, not `npm run dev`: spawning a .cmd shim on Windows
        // fails with EINVAL unless a shell is involved, and a shell is one more
        // process between this test and the thing it is supposed to kill.
        const ui = path.join(ROOT, 'ui');
        // Reached by path rather than by `require.resolve`: vite's package
        // exports map does not expose its own bin, which is normal and not
        // something to work around by pretending it does.
        const bin = path.join(ui, 'node_modules', 'vite', 'bin', 'vite.js');
        const child = spawn(
            process.execPath,
            [bin, '--mode', 'web', '--port', '0'],
            { cwd: ui, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const fail = setTimeout(() => reject(new Error('dev server did not start')), 90_000);
        let out = '';
        child.stdout.on('data', chunk => {
            // Vite colours the URL, and the escape codes land in the middle of
            // it — the port is bold, so a plain match for the address finds
            // nothing and the wait times out looking like a server that never
            // started.
            out += String(chunk).replace(/\[[0-9;]*m/g, '');
            const at = out.match(/http:\/\/localhost:(\d+)/);
            if (!at) return;
            clearTimeout(fail);
            resolve({ origin: at[0], stop: () => child.kill() });
        });
        child.stderr.on('data', c => { out += c; });
        child.on('exit', code => reject(new Error(`dev server exited (${code}):\n${out}`)));
    });
}

async function main() {
    const dev = process.argv.includes('--dev');

    if (!dev && !fs.existsSync(path.join(DIST, 'index.html'))) {
        console.error('No ui/dist-web — run `npm run build:web` first.');
        process.exit(1);
    }

    const { chromium } = require('playwright');
    const reference = referenceGraph();
    console.log(`${dev ? 'dev server' : 'built app'} · reference: ` +
        `${Object.keys(reference.nodes).length} nodes, ${reference.edges.length} edges\n`);

    const target = dev ? await startDevServer() : null;
    const { server, port } = target ? { server: null, port: null } : await serve(DIST);
    const origin = target ? target.origin : `http://127.0.0.1:${port}`;
    const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
    const page = await browser.newPage();

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    try {
        await page.goto(`${origin}/`, { waitUntil: 'load' });

        // The app is mounted from the first paint and the upload page sits on
        // it as a modal, so `.react-flow` existing proves nothing on its own
        // here — the card being up, and later gone, is what this tracks.
        check(await page.locator('.landing-card').isVisible(), 'the app opens on the upload page');
        check(await page.locator('.landing-card[role=dialog][aria-modal=true]').count() === 1,
            'the upload page is a modal over the app');
        check(await page.locator('.slot').count() === 4, 'four inputs are asked for');
        check(await page.locator('.landing-build').isDisabled(), 'nothing to build until they are filled');

        /*
         * The demo way in, checked as plumbing rather than driven.
         *
         * Clicking it runs the same build this test already drives from the four
         * slots, and a second Pyodide download to reach an identical graph buys
         * nothing. What a click would catch and nothing else does is the sample
         * tree going missing from the deployed artifact — it lives outside ui/
         * and is copied in by a build plugin — so that is what is asserted: the
         * button is there, and every file it fetches answers.
         */
        check(await page.locator('.landing-sample').isEnabled(), 'a sample project is offered');
        const sample = await page.evaluate(async () => {
            const at = rel => new URL(`sample/${rel}`, document.baseURI).href;
            const index = await (await fetch(at('index.json'))).json();
            const codes = await Promise.all(index.map(async rel => (await fetch(at(rel))).status));
            return { index, bad: index.filter((_, i) => codes[i] !== 200) };
        });
        check(sample.bad.length === 0, 'every sample file it fetches is served',
            sample.bad.join(', ') || `${sample.index.length} files`);
        for (const needed of ['dbt-sqlserver/manifest.json', 'dbt-sqlserver/catalog.json',
            'mapping-example.csv']) {
            check(sample.index.includes(needed), `the sample ships ${needed}`);
        }
        check(sample.index.some(p => p.startsWith('SampleProject.SemanticModel/')),
            'the sample ships its semantic model');

        // Hidden by design — the slot is the control, the input is plumbing.
        const inputs = page.locator('.slot input[type=file]');

        /*
         * The two dbt artifacts, the wrong way round.
         *
         * Both are `<name>.json` holding a `nodes` object out of the same
         * `target/` directory, so this is the mistake the slots most need to
         * catch — and catching it here rather than 40 seconds into an
         * extraction is the entire point. Checked before the good files go in,
         * so the recovery is covered too: a refused slot must accept the right
         * file afterwards and clear its own complaint.
         */
        await inputs.nth(0).setInputFiles(MANIFEST);
        await inputs.nth(1).setInputFiles(CATALOG);
        await page.waitForFunction(
            () => document.querySelectorAll('.slot[data-state="bad"]').length === 2,
            null, { timeout: 10_000 });
        check(/wrong way round/.test(await page.locator('.slot').nth(0).innerText()),
            'a swapped catalog and manifest are refused, and named as swapped');
        check(await page.locator('.landing-build').isDisabled(),
            'a refused slot does not count towards the build');

        await inputs.nth(0).setInputFiles(CATALOG);
        await inputs.nth(1).setInputFiles(MANIFEST);
        await inputs.nth(2).setInputFiles(MAPPING);
        await inputs.nth(3).setInputFiles(SAMPLES);

        await page.waitForFunction(
            () => document.querySelectorAll('.slot[data-state="ok"]').length === 4,
            null, { timeout: 30_000 });
        check(true, 'every input validated in the browser');
        check(await page.locator('.landing-build').isEnabled(), 'the build becomes available');

        await page.locator('.landing-build').click();

        // The graph lands on window at the moment the app adopts it.
        await page.waitForFunction(() => Boolean(globalThis.__LINEAGE__), null, { timeout: TIMEOUT });
        const built = await page.evaluate(() => globalThis.__LINEAGE__);

        check(Object.keys(built.nodes).length === Object.keys(reference.nodes).length,
            'the browser builds the same nodes as the CLI',
            `${Object.keys(built.nodes).length} vs ${Object.keys(reference.nodes).length}`);
        check(built.edges.length === reference.edges.length,
            'the browser builds the same edges as the CLI',
            `${built.edges.length} vs ${reference.edges.length}`);

        // Ids, not just counts: equal totals with different members would be a
        // coincidence that this test exists to rule out.
        const ids = g => Object.keys(g.nodes).sort().join('\n');
        check(ids(built) === ids(reference), 'node for node, the same graph');

        const edgeKey = e => `${e.source}|${e.sourceColumn}|${e.target}|${e.targetColumn}`;
        const edges = g => g.edges.map(edgeKey).sort().join('\n');
        check(edges(built) === edges(reference), 'edge for edge, the same lineage');

        check(JSON.stringify(built.summary) === JSON.stringify(reference.summary),
            'the same summary is reported');

        // The canvas was already there, behind the modal; what has to be true
        // now is that it survived the swap and that nothing of the upload page
        // — card or decorative backdrop — is left over it.
        await page.waitForSelector('.react-flow', { timeout: 30_000 });
        check(true, 'the canvas is still standing on the real graph');
        check(!(await page.locator('.landing-card').count()), 'the upload page is gone');
        check(!(await page.locator('.landing-art').count()), 'the stand-in lineage is gone');
        check(!(await page.locator('[inert]').count()), 'the app is interactive again');

        /*
         * Staged reveal: table → page → what is on the page.
         *
         * One press of `+` on a Power BI table used to add its pages, its
         * measures and the visuals behind them at once, because `walk()` follows
         * every edge kind. The two cards where "one hop" is an ambiguous
         * question now answer it with a menu instead, and the three things worth
         * asserting are the three that make it worth the extra click: the
         * heading changes meaning on a page card, the counts are real, and each
         * kind retracts on its own.
         */
        /*
         * Anchored at the start of the card, not "contains".
         *
         * A visual's subtitle carries the page it is on — `visual · card · Sales
         * Overview` — so a plain hasText for a page name matches the page card
         * and every visual on it.
         */
        const card = name => page.locator('.node-card', { hasText: new RegExp(`^${name}`) });
        const menuOn = async name => {
            await card(name).locator('[data-testid=hop-menu-button]').click();
            await page.locator('[data-testid=hop-menu]').waitFor();
        };
        const menuText = async () => (await page.locator('[data-testid=hop-menu]').innerText())
            .replace(/\s+/g, ' ').trim();
        const pick = async kind => {
            await page.locator(`[data-testid=hop-menu] [data-kind=${kind}]`).click();
            // The reveal re-solves the layout; the card count is what settles.
            await page.waitForTimeout(1200);
        };
        const cardNames = () => page.evaluate(() => [...document.querySelectorAll('.node-card')]
            .map(c => c.innerText.split('\n')[0].trim()));

        // Rail → Power BI → Tables → Product: a table with both a page and a
        // measure downstream, which is what makes the menu worth opening.
        await page.getByRole('button', { name: 'Expand Power BI' }).click();
        await page.getByRole('button', { name: 'Expand Tables' }).click();
        await page.locator('[data-testid=tree-leaf]', { hasText: 'Product' }).first().click();
        await card('Product').waitFor();

        await menuOn('Product');
        check((await menuText()) === 'Downstream Pages 1 Measures 1',
            'a table offers its kinds separately, with counts', await menuText());
        // The sticky default, and the fallback when the default is the greyed
        // one — a table with pages and no measures is common, and so is the
        // reverse, so a pre-highlight that cannot be pressed is a dead Enter.
        check(await page.evaluate(() => document.activeElement?.disabled === false),
            'the keyboard lands on something that can be pressed');

        await pick('page');
        const withPage = await cardNames();
        check(withPage.includes('Sales Overview') && !withPage.includes('Product Count'),
            'the chosen kind arrives and the other does not', withPage.join(', '));
        // It used to stay open, sitting over the cards it had just added — and
        // opening a second card's menu left the first one up as well, because
        // React Flow stops mousedown from reaching a document-level listener.
        check(!(await page.locator('[data-testid=hop-menu]').count()),
            'the menu closes once a kind is chosen');

        await menuOn('Sales Overview');
        check(await page.locator('[data-testid=hop-menu]').count() === 1,
            'only one menu is ever open');
        check((await menuText()) === 'On this page Visuals 2 Measures 2',
            'a page asks what is on it, not what is downstream', await menuText());

        await pick('visual');
        await menuOn('Sales Overview');
        await pick('measure');
        const onPage = await cardNames();
        /*
         * Every measure on the page, not only the ones this table feeds.
         *
         * `Order Count` is on the page and is *not* fed by Product — it is
         * exactly the card a table-filtered reveal would drop, and dropping it
         * would make a page with two dependencies look like a page with one.
         * The trace marking is what says which is which.
         */
        check(onPage.includes('Order Count') && onPage.includes('Total Revenue'),
            'a page shows every measure it uses, not just the ones from this table',
            onPage.join(', '));

        await menuOn('Sales Overview');
        await pick('measure');
        const afterDrop = await cardNames();
        check(!afterDrop.includes('Order Count') && afterDrop.includes('Revenue by Category'),
            'each kind retracts on its own, leaving the others in place',
            afterDrop.join(', '));

        /*
         * A card that leaves the canvas forgets where it was dragged to.
         *
         * `moved` beat the solved layout for as long as its entry lived, so a
         * revealed card that had been dragged, retracted and revealed again came
         * back at its old coordinates — between lanes, with long diagonals to
         * neighbours that were laid out properly, which reads as the graph having
         * put it in the wrong place rather than as the reader having put it
         * there. Positions are read off React Flow's own transforms, because that
         * is what the reader sees.
         */
        const lanesOf = () => page.evaluate(() => Object.fromEntries(
            [...document.querySelectorAll('.react-flow__node')].map(n => {
                const m = /translate\(([-\d.]+)px/.exec(n.style.transform) || [];
                return [n.innerText.split('\n')[0].trim(), Math.round(+m[1])];
            })));
        const home = (await lanesOf())['Revenue by Category'];
        const box = await card('Revenue by Category').boundingBox();
        await page.mouse.move(box.x + 60, box.y + 12);
        await page.mouse.down();
        await page.mouse.move(box.x - 260, box.y + 260, { steps: 10 });
        await page.mouse.up();
        await page.waitForTimeout(600);
        check((await lanesOf())['Revenue by Category'] !== home, 'a card can be dragged off its lane');

        await menuOn('Sales Overview');
        await pick('visual');            // retract
        await menuOn('Sales Overview');
        await pick('visual');            // and reveal again
        check((await lanesOf())['Revenue by Category'] === home,
            'and comes back in its lane when revealed again, not where it was dropped',
            `lane ${home}, got ${(await lanesOf())['Revenue by Category']}`);

        /*
         * Folding a card's pages away folds what those pages opened.
         *
         * Without the cascade the visuals stayed behind as orphans — in a lane
         * whose other occupants had just left, joined to the table by the column
         * edge that was always underneath, and with no control left to close them
         * because the card that opened them was gone. It looked like the graph
         * had wired a visual straight to a table.
         */
        /*
         * Selecting a visual says which page it is on.
         *
         * `page_to_visual` is containment, and following it downstream would
         * claim every visual on a page is affected because one of them is — so
         * it was skipped in both directions. Upstream from a visual it is the
         * one piece of context that makes the rest legible: "this column reaches
         * that chart" means little until you know which page the chart is on.
         */
        await card('Revenue by Category').click();
        await page.waitForTimeout(900);
        const litNames = () => page.evaluate(() => [...document.querySelectorAll(
            '.node-card.is-lit, .node-card.is-selected')].map(c => c.innerText.split('\n')[0].trim()));
        check((await litNames()).includes('Sales Overview'),
            'selecting a visual lights the page it sits on', (await litNames()).join(', '));

        /*
         * And the same question asked from the other end.
         *
         * Containment reads both ways for a reader: a visual is on a page, and a
         * page holds visuals. Selecting the page lit the table it reads from and
         * greyed every chart on it, which is the opposite of what "show me this
         * page" means.
         */
        await card('Sales Overview').click();
        await page.waitForTimeout(900);
        const onSelectedPage = await litNames();
        check(onSelectedPage.includes('Total Orders') && onSelectedPage.includes('Revenue by Category'),
            'selecting a page lights the visuals on it', onSelectedPage.join(', '));

        /*
         * But only when the page is the thing that was asked about.
         *
         * This is the invariant the exclusion existed for: a trace that arrives
         * at a page through a column must not then claim every visual on that
         * page is affected. `Total Orders` reads a measure, not this table, so a
         * trace from the table must reach the page and stop there.
         */
        await card('Product').click();
        await page.waitForTimeout(900);
        const fromTable = await litNames();
        check(fromTable.includes('Sales Overview') && !fromTable.includes('Total Orders'),
            'but a page reached mid-trace does not light everything on it',
            fromTable.join(', '));

        await menuOn('Product');
        await pick('page');
        const folded = await cardNames();
        check(folded.length === 1 && folded[0] === 'Product',
            'folding the pages away takes the visuals they opened with them',
            folded.join(', '));
        await page.keyboard.press('Escape');

        /*
         * The menu tells the truth about what is already on the canvas.
         *
         * The depth stepper reaches the same cards the menu offers, by a route
         * the menu does not own: it keys its reveal `<id>|down`, not
         * `<id>|kind:page`. So the ticks stayed empty while every page and
         * visual sat there in plain sight, and the menu read as an unopened
         * thing you were already looking at.
         *
         * Ticking them instead would be worse. A tick is a retract control, and
         * `retractKind` can only delete its own key — pressing it would remove
         * nothing, leave the cards where they are, and snap the tick back on. A
         * third state is the honest answer: present, counted, and not yours to
         * fold away.
         */
        await card('Product').click();
        await page.selectOption('[aria-label="Expansion depth"]', '5');
        await page.getByRole('button', { name: 'Expand downstream' }).click();
        await page.waitForTimeout(1500);
        const deep = await cardNames();
        check(deep.includes('Sales Overview') && deep.includes('Revenue by Category'),
            'the depth stepper reaches pages and visuals without the menu', deep.join(', '));

        await menuOn('Product');
        const pagesRow = page.locator('[data-testid=hop-menu] [data-kind=page]');
        check(await pagesRow.isDisabled(),
            'a kind already on the canvas cannot be pressed');
        check((await pagesRow.getAttribute('aria-checked')) === 'false',
            'and is not ticked, because the menu did not put it there');
        check(/already shown/i.test(await menuText()),
            'the menu says why the row is greyed', await menuText());
        await page.keyboard.press('Escape');

        /*
         * A node that reaches nothing does not grey out the canvas.
         *
         * Some Power BI visuals bind no fields at all — a shape, a text box —
         * and so do a few dbt models. Tracing one produced a highlight of
         * exactly itself, which dimmed every other card on screen to make a
         * point about a node with nothing to point at, and read as a broken
         * trace rather than an empty one.
         *
         * "Linked only" is on by default and hides anything off a dbt→Power BI
         * path, which is precisely what an isolated model is — so it comes off
         * first, or there is nothing to select.
         */
        // Reset first: it belongs to the rail's filters and puts "linked only"
        // back on, so unchecking before it would be undone. The "show
        // everything" button belongs to the empty state, so the canvas has to be
        // back at its opening question for it to exist at all.
        await page.locator('[data-testid=reset-view]').click();
        await page.locator('[data-testid=linked-only]').uncheck();
        await page.locator('[data-testid=show-everything]').click();
        await page.waitForFunction(
            () => document.querySelectorAll('.node-card').length > 20, null, { timeout: 60_000 });
        await card('stg_source_freshness').first().click();
        await page.waitForTimeout(900);
        const greyed = await page.evaluate(() => ({
            cards: document.querySelectorAll('.node-card').length,
            dim: document.querySelectorAll('.node-card.is-dim').length,
        }));
        check(greyed.dim === 0 && greyed.cards > 20,
            'a node with no lineage leaves the rest of the graph readable',
            `${greyed.dim} of ${greyed.cards} dimmed`);

        // And a node that does reach something still dims the rest, or the fix
        // above would have cost the trace its whole point.
        await card('stg_products').first().click();
        await page.waitForTimeout(900);
        const traced = await page.evaluate(() => document.querySelectorAll('.node-card.is-dim').length);
        check(traced > 0, 'a node that does reach something still dims what it does not',
            `${traced} dimmed`);
        await page.locator('[data-testid=linked-only]').check();

        /*
         * The rail and the panel at their narrowest.
         *
         * Both minimums used to be set below the width of the tab track inside
         * them, so dragging either one all the way in cut the last tab in half —
         * reachable only by a scroll nobody could see. A minimum that cannot
         * show a panel's own controls is not a minimum, and the two numbers are
         * the kind that drift the moment a tab is renamed, so they are asserted
         * rather than trusted.
         */
        const squeeze = async (testid, to) => {
            const box = await page.locator(`[data-testid=${testid}]:visible`).first().boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            // Well past the minimum on purpose: the clamp is what is under test.
            await page.mouse.move(to, box.y + box.height / 2, { steps: 8 });
            await page.mouse.up();
        };
        await squeeze('resizer-left', 0);
        // Database tab, then a schema, then a table: the shortest route from a
        // blank canvas to a side panel, and it exercises the rail's own tabs at
        // their new minimum on the way.
        await page.locator('[data-testid=nav-tabs] .pill').nth(1).click();
        await page.locator('[data-testid=tree-schema]').first().click();
        await page.locator('[data-testid=tree-table]').first().click();
        await page.locator('[data-testid=side-panel] .pill-track').waitFor();
        await squeeze('resizer-right', await page.evaluate(() => innerWidth));

        const cramped = await page.evaluate(() => [...document.querySelectorAll('.pill-track')]
            .filter(t => t.offsetParent)
            .filter(t => t.scrollWidth > t.clientWidth + 0.5)
            .map(t => t.innerText.replace(/\s+/g, ' ').trim()));
        check(cramped.length === 0,
            'the tab tracks still fit when the rail and the panel are dragged shut',
            cramped.join(' | '));

        /*
         * Export, end to end, which is the only way this is worth testing.
         *
         * The failure mode is a file that downloads and does not open: the app
         * is chunked ESM and a module script will not run from `file://`, so an
         * export assembled out of the running page would pass every check up to
         * the moment someone double-clicks it. Hence a second page on a real
         * `file://` URL, with no server and nothing cached, asserting the same
         * graph is there and drawn.
         */
        const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 120_000 }),
            page.locator('[data-testid="export-graph"]').click(),
        ]);
        const saved = path.join(ROOT, '.work', 'exported.html');
        fs.mkdirSync(path.dirname(saved), { recursive: true });
        await download.saveAs(saved);
        check(/^lineage-.*\.html$/.test(download.suggestedFilename()),
            'the export downloads as an .html file', download.suggestedFilename());
        const bytes = fs.statSync(saved).size;
        check(bytes > 1_000_000, 'and it is self-contained, not a stub',
            `${(bytes / 1048576).toFixed(1)} MB`);

        const offline = await browser.newPage();
        const openErrors = [];
        offline.on('pageerror', e => openErrors.push(e.message));
        offline.on('console', m => { if (m.type() === 'error') openErrors.push(m.text()); });
        await offline.goto(pathToFileURL(saved).href, { waitUntil: 'load' });
        await offline.waitForFunction(() => Boolean(globalThis.__LINEAGE__), null, { timeout: 60_000 });
        const opened = await offline.evaluate(() => Object.keys(globalThis.__LINEAGE__.nodes).length);
        check(opened === Object.keys(reference.nodes).length,
            'the exported file opens from file:// on the same graph',
            `${opened} vs ${Object.keys(reference.nodes).length} nodes`);
        // Drawn, not merely present: the canvas opens on its question, so
        // answer it and count what lands.
        await offline.waitForSelector('[data-testid="show-everything"]', { timeout: 60_000 });
        await offline.locator('[data-testid="show-everything"]').click();
        await offline.waitForSelector('.node-card', { timeout: 60_000 });
        await offline.waitForTimeout(2000);
        const drawn = await offline.locator('.node-card').count();
        check(drawn > 0, 'and renders the graph off disk', `${drawn} node cards`);
        // The viewer is the export's destination, not another place to export
        // from — there is no template to fetch beside a file on someone's desk.
        check(!(await offline.locator('[data-testid="export-graph"]').count()),
            'the exported file does not offer to export itself');
        check(openErrors.length === 0, 'no runtime errors in the exported file',
            openErrors.slice(0, 3).join(' | '));
        await offline.close();

        check(errors.length === 0, 'no runtime errors', errors.slice(0, 3).join(' | '));
    } finally {
        await browser.close();
        if (server) server.close();
        if (target) target.stop();
    }

    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
    process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
