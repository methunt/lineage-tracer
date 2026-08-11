#!/usr/bin/env node
/**
 * Real-browser checks, run against an exported file opened from file://.
 *
 *   npm run test:browser              # builds from samples/, exports, checks it
 *   node test/browser.js <export.html>
 *
 * The file under test is the viewer template with a graph injected into it —
 * exactly what the app's Export button hands a user, assembled here by the same
 * function the app calls. `file://` is the point: that origin is why the viewer
 * is a single classic-script file at all.
 *
 * This exists alongside the jsdom check in test/run.js because jsdom cannot
 * execute ES modules and does not enforce pointer-event layering — two failures
 * that shipped a blank or unclickable page while every other check passed.
 * Requires `npx playwright install chromium` once.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const SAMPLES = path.resolve(ROOT, '..', 'samples');

/*
 * Reset now means "as the report opened", and it opens on the question rather
 * than on the whole graph — so anything that presses Reset has to answer the
 * question again before it can look at nodes.
 */
const showAll = async page => {
    const button = page.locator('[data-testid="show-everything"]');
    if (await button.count()) {
        await button.click();
        await page.waitForTimeout(900);
    }
};

let failures = 0;
const check = (name, pass, detail) => {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
    if (!pass) failures++;
};

async function buildSampleReport() {
    const { build, toReportData } = require('../src/build');
    const { injectGraph } = await import('../ui/src/web/export-viewer.js');
    const template = path.join(ROOT, 'ui', 'dist', 'index.html');
    if (!fs.existsSync(template)) {
        console.error(`Viewer template missing. Run:  npm run build:viewer`);
        process.exit(1);
    }
    const graph = await build({
        pbip: SAMPLES,
        manifest: path.join(SAMPLES, 'dbt-sqlserver', 'manifest.json'),
        catalog: path.join(SAMPLES, 'dbt-sqlserver', 'catalog.json'),
        mapping: path.join(SAMPLES, 'mapping-example.csv'),
        colibriRepo: path.resolve(ROOT, '..', 'dbt-colibri'),
        layers: ['staging', 'marts'],
        log: () => {},
    });
    const out = path.join(ROOT, '.work', 'browser-test.html');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, injectGraph(fs.readFileSync(template, 'utf8'), toReportData(graph)), 'utf8');
    return out;
}

(async () => {
    let chromium;
    try {
        ({ chromium } = require('playwright'));
    } catch {
        console.error('playwright is not installed — skipping browser checks.');
        process.exit(0);
    }

    const target = process.argv[2] || await buildSampleReport();
    if (!fs.existsSync(target)) { console.error(`No export at ${target}`); process.exit(1); }

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => m.type() === 'error' && errors.push(m.text()));

    await page.goto(pathToFileURL(target).href, { waitUntil: 'networkidle' });

    /*
     * The canvas opens empty and asks what you want to trace: a thousand-model
     * project drawn at once is a texture, not a diagram. Everything below this
     * is about the populated canvas, so the suite answers the question once and
     * then behaves as it always did.
     */
    await page.waitForSelector('[data-testid="canvas-blank"]', { timeout: 30000 });
    const blankText = await page.locator('[data-testid="canvas-blank"]').innerText();
    check('the canvas opens by asking what to trace',
        (await page.locator('.node-card').count()) === 0 && /trace/i.test(blankText),
        blankText.split(String.fromCharCode(10))[0]);
    await page.locator('[data-testid="show-everything"]').click();

    await page.waitForSelector('.node-card', { timeout: 30000 });
    await page.waitForTimeout(2500);

    const cards = await page.locator('.node-card').count();
    check('the export renders from file://', cards > 0, `${cards} node cards`);
    check('and the first screen is gone once it has been answered',
        (await page.locator('[data-testid="canvas-blank"]').count()) === 0);

    // The canvas begins directly under the header: no metric strip, no filter
    // strip. Both bands were spending a node card's worth of height each.
    const chrome = await page.evaluate(() => {
        const header = document.querySelector('header');
        const canvas = document.querySelector('.react-flow');
        return {
            gap: canvas.getBoundingClientRect().top - header.getBoundingClientRect().bottom,
            kpis: document.querySelectorAll('.kpi').length,
        };
    });
    // 8px became 24: the views are cards on a ground now, so there is a
    // deliberate gutter between the header and the canvas. Still far short of
    // a band of metrics, which is what this guards against.
    check('no metric strip above the canvas', chrome.kpis === 0 && chrome.gap < 24,
        `${chrome.kpis} kpi cards, ${Math.round(chrome.gap)}px gap`);

    // Search sits in the header, to the left of the theme button.
    // The box is a button now — it opens the palette rather than filtering as
    // you type — but it keeps its place, which is what this check is about.
    const headerOrder = await page.evaluate(() => {
        const header = document.querySelector('header');
        const search = header.querySelector('[data-testid="open-search"]');
        const theme = header.querySelector('[aria-label="Toggle theme"]');
        if (!search || !theme) return null;
        return { search: search.getBoundingClientRect().left, theme: theme.getBoundingClientRect().left };
    });
    check('search sits in the header before the theme button',
        !!headerOrder && headerOrder.search < headerOrder.theme);

    /*
     * The command palette. It searches names across everything in the report,
     * narrows by attribute / layer / tag, and navigates rather than filters —
     * you type a name because you already know what you want.
     */
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(400);
    check('ctrl-k opens the palette',
        (await page.locator('[data-testid="search-palette"]').count()) === 1);
    await page.locator('[data-testid="palette-input"]').fill('customer');
    await page.waitForTimeout(400);
    const hits = await page.locator('[data-testid="palette-result"]').allInnerTexts();
    check('the palette finds models and columns together',
        hits.length > 1, `${hits.length} results: ${hits.slice(0, 3).map(h => h.split('\n')[0]).join(' | ')}`);
    // Every result names what kind of thing it is, so two identical names from
    // two systems are told apart without opening either.
    check('results say what kind of object they are',
        hits.every(h => /(dbt model|dbt column|Power BI table|Power BI column|measure|visual|report page)/.test(h)),
        hits[0]?.replace(/\n/g, ' · ') || '');

    /*
     * The list is virtualised, so the number of rendered rows is a function of
     * the window height, not of how many things matched. Counts come from the
     * footer, which reports the whole result set.
     */
    const matchCount = async () => Number(await page.locator('[data-testid="palette-count"]')
        .getAttribute('data-count'));
    const total = await matchCount();
    check('the list builds a window, not every match',
        total > hits.length && hits.length > 5,
        `${hits.length} rows built for ${total} matches`);
    // And the scrollbar is sized for all of them, so scrolling is continuous
    // rather than a page that stops short.
    const scrollH = await page.evaluate(() => {
        const el = [...document.querySelectorAll('[data-testid="search-palette"] .overflow-auto')].pop();
        return { scroll: el.scrollHeight, client: el.clientHeight };
    });
    check('the scrollbar measures the whole result set',
        scrollH.scroll > scrollH.client && scrollH.scroll >= total * 30,
        `${scrollH.scroll}px for ${total} rows in a ${scrollH.client}px list`);

    // Arrowing past the built window must drag the list with it — the row to
    // reveal does not exist in the DOM yet, so scrollIntoView cannot do this.
    for (let i = 0; i < total - 1; i++) await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(400);
    check('the keyboard cursor stays rendered past the built window',
        (await page.locator('[data-active="true"]').count()) === 1,
        `cursor at row ${total - 1} of ${total}`);
    await page.locator('[data-testid="palette-input"]').fill('customer');
    await page.waitForTimeout(400);

    // A facet narrows the results rather than the matched field: an empty list
    // then means "none of this kind", not "no such name".
    const beforeFacet = await matchCount();
    await page.locator('[data-testid="search-palette"] button', { hasText: 'attributes' }).click();
    await page.waitForTimeout(300);
    // The rows are grouped under dbt / Power BI headers and read `column` on
    // both sides, so they are picked by key rather than by label.
    await page.locator('[data-facet-option="dbtColumn"]').click();
    await page.waitForTimeout(400);
    const narrowed = await matchCount();
    const narrowedRows = await page.locator('[data-testid="palette-result"]').allInnerTexts();
    check('an attribute facet narrows the results',
        narrowed > 0 && narrowed < beforeFacet &&
        narrowedRows.every(h => /dbt column/.test(h)),
        `${beforeFacet} → ${narrowed}, all dbt columns`);

    // The group header is a control: one click takes the whole side.
    await page.locator('[data-facet-group="Power BI"]').click();
    await page.waitForTimeout(400);
    // Counted, not read off the rows: a Power BI match may rank below the
    // built window, and its absence from the DOM would prove nothing.
    check('a group header selects every attribute on that side',
        (await matchCount()) > narrowed, `${narrowed} → ${await matchCount()}`);
    await page.locator('[data-facet-group="Power BI"]').click();   // and gives it back
    await page.waitForTimeout(400);
    check('clicking the group header again clears that side',
        (await matchCount()) === narrowed);

    /*
     * "Show all" answers a different question from "take me there": every model
     * carrying a column of that name, side by side, each opened on it. It works
     * on the whole match set rather than the rows built, so the count on the
     * button is the count that lands.
     */
    const shownRows = (await page.locator('[data-testid="palette-result"]').count());
    const allLabel = await page.locator('[data-testid="palette-show-all"]').textContent();
    const promised = Number(allLabel.match(/\d+/)[0]);
    await page.locator('[data-testid="palette-show-all"]').click();
    await page.waitForTimeout(2500);
    const landed = await page.locator('.node-card').count();
    check('show all puts the whole result set on the canvas',
        landed === promised, `promised ${promised}, landed ${landed} (${shownRows} rows rendered)`);
    check('every card it lands is opened on the matched column',
        (await page.locator('.col-row.is-traced').count()) >= landed,
        `${await page.locator('.col-row.is-traced').count()} marked rows on ${landed} cards`);
    check('the chip says what is pinned', /Showing/.test(
        await page.locator('[data-testid="focus-chip"]').textContent()));
    // Same escape hatch as focus: one click back to the filtered canvas.
    await page.locator('[data-testid="focus-chip"] button').click();
    await page.waitForTimeout(1500);
    check('clearing the chip releases the result set',
        (await page.locator('.node-card').count()) > landed);

    // Picking a single result still navigates: focus that node, select the column.
    await page.keyboard.press('Control+k');
    await page.locator('[data-testid="palette-input"]').fill('customer');
    await page.waitForTimeout(400);
    await page.locator('[data-testid="palette-result"]').first().click();
    await page.waitForTimeout(1200);
    check('picking a result closes the palette',
        (await page.locator('[data-testid="search-palette"]').count()) === 0);
    check('picking a column result selects it',
        (await page.locator('.col-row.is-selected').count()) > 0);

    /*
     * A field renamed inside a visual, found by the name only the report uses.
     *
     * The label on a chart is often the one thing a reader can quote, and the
     * model has never heard of it. jsdom cannot stand in for this: the palette
     * positions its rows by arithmetic against a fixed row height, so a match
     * that renders but overlaps its neighbour is a real failure that only a
     * layout engine sees.
     */
    await page.keyboard.press('Control+k');
    /* The palette keeps its facets between openings and the attribute test above
       left it narrowed to dbt columns, which no measure can match through — the
       check would fail on the test's own state. Same trap as the layout check
       further down. */
    const clearForAlias = page.locator('[data-testid="search-palette"] button', { hasText: /^clear$/ });
    if (await clearForAlias.count()) await clearForAlias.click();
    await page.locator('[data-testid="palette-input"]').fill('Grand Total');
    await page.waitForTimeout(500);
    const aliasHit = page.locator('[data-testid="palette-result"]')
        .filter({ has: page.locator('[data-testid="palette-aka"]') });
    check('the palette finds a field by the label a visual renamed it to',
        (await aliasHit.count()) === 1,
        (await page.locator('[data-testid="palette-result"]').allInnerTexts()).join(' / '));
    // The model's name, not the label — the row has to name what a change breaks.
    check('an alias match still shows the model\'s own name',
        (await aliasHit.first().innerText()).includes('Total Revenue'));
    await aliasHit.first().click();
    await page.waitForTimeout(1400);

    const shownAs = await page.locator('[data-testid="shown-as-row"]').allInnerTexts();
    /*
     * Three labels from two places: two typed into field wells, and one authored
     * as a field parameter's caption. The reader needs all of them — fixing the
     * two visuals and leaving the parameter fixes two charts out of three.
     */
    check('the measure lists every label it is read under',
        shownAs.length === 3
        && ['Grand Total', 'Revenue', 'Total Sales'].every(l => shownAs.join(' ').includes(l)),
        shownAs.map(r => r.replace(/\n/g, ' ')).join(' / '));
    /*
     * And says which is which. A caption is authored once and reaches every
     * visual on the parameter; a rename stops at one visual. Told apart wrongly,
     * a reader changes the caption expecting to move one chart and moves eight.
     */
    const sources = await page.locator('[data-testid="shown-as-source"]').allInnerTexts();
    check('and says where each label is authored',
        sources.filter(s => /parameter/.test(s)).length === 1
        && sources.filter(s => /visual rename/.test(s)).length === 2,
        sources.join(' / '));

    /*
     * And on the visual: the label beside the model's name, not instead of it.
     * A row that named only the label would name something the click cannot act
     * on — the trace works on the real identity.
     */
    await page.keyboard.press('Control+k');
    // The visual holding both renamed fields, by its own title.
    await page.locator('[data-testid="palette-input"]').fill('Total Orders');
    await page.waitForTimeout(500);
    await page.locator('[data-testid="palette-result"]').first().click();
    await page.waitForTimeout(1500);
    const renamed = (await page.locator('[data-testid="field-row"]').allInnerTexts())
        .filter(r => r.includes('aka'));
    check('a visual\'s field row carries the label after the model\'s name',
        renamed.length === 2
        // A measure and a column, so both paths through the row are covered.
        && renamed.some(r => r.includes('Grand Total')) && renamed.some(r => r.includes('Price per Unit'))
        // The model's name first: the click traces that, not the label.
        && renamed.every(r => r.indexOf('[') < r.indexOf('aka')),
        renamed.map(r => r.replace(/\n/g, ' ')).join(' / '));

    /*
     * Focus mode suspends every filter so a node picked by name always appears.
     * The palette focuses whatever you pick, which put the reader one click
     * from a rail whose eyes and "Hide all" did nothing at all — they set state
     * that nothing was reading. Touching a filter now lifts the focus pin.
     */
    const focusedCards = await page.locator('.node-card').count();
    await page.locator('[data-testid="layer-nav"] [aria-label^="Hide"]').first().click();
    await page.waitForTimeout(1600);
    const afterHide = await page.locator('.node-card').count();
    check('a filter works after the palette focuses something',
        afterHide !== focusedCards,
        `${focusedCards} card(s) focused → ${afterHide} after hiding a folder`);
    // Put the folder back: everything after this needs the full canvas.
    await page.locator('[data-testid="layer-nav"] [aria-label^="Show"]').first().click();
    await page.waitForTimeout(1600);

    /*
     * A filtered or focused canvas must arrive already framed.
     *
     * fitView measures the nodes React Flow currently holds, so fitting inside
     * the solve callback framed the layout being replaced — the surviving card
     * was left stranded at the top and "Reset layout", arriving a render later,
     * looked like the thing that centred it. Two steps for one action.
     *
     * The test for that is exactly the two steps: whatever Reset produces is
     * the correct framing, so the viewport must already equal it.
     */
    const viewport = () => page.evaluate(() =>
        document.querySelector('.react-flow__viewport')?.style.transform || '');
    await page.locator('[data-testid="layer-nav"] [aria-label^="Hide"]').first().click();
    await page.waitForTimeout(2000);
    const afterFilter = await viewport();
    await page.locator('[data-testid="reset-layout"], button:has-text("Reset layout")').first()
        .click().catch(() => {});
    await page.waitForTimeout(1600);
    const afterReset = await viewport();
    check('a filtered canvas is framed without pressing Reset layout',
        afterFilter === afterReset, `${afterFilter} vs ${afterReset}`);
    await page.locator('[data-testid="layer-nav"] [aria-label^="Show"]').first().click();
    await page.waitForTimeout(1800);
    // Focus mode is how it navigates, so clear it before anything else runs.
    await page.locator('[data-testid="focus-chip"] button').click().catch(() => {});
    await page.waitForTimeout(1200);

    // The tabs are centred against the window, not against the brand block.
    const centring = await page.evaluate(() => {
        const nav = document.querySelector('header nav');
        const box = nav.getBoundingClientRect();
        return Math.abs((box.left + box.right) / 2 - window.innerWidth / 2);
    });
    check('tabs are centred in the header', centring < 4, `${centring.toFixed(1)}px off centre`);

    // Two states, and the first press must change something.
    const themed = await page.evaluate(async () => {
        const before = document.documentElement.getAttribute('data-theme');
        document.querySelector('[aria-label="Toggle theme"]').click();
        await new Promise(r => setTimeout(r, 120));
        return { before, after: document.documentElement.getAttribute('data-theme') };
    });
    check('the export opens light', themed.before === 'light', String(themed.before));
    check('one press flips the theme', themed.after === 'dark', `${themed.before} → ${themed.after}`);
    await page.evaluate(() => document.querySelector('[aria-label="Toggle theme"]').click());
    await page.waitForTimeout(150);
    /*
     * Only the dbt root is open on first paint. It has to be — the resource
     * types under it are the navigation, and a rail opening as two collapsed
     * words is not one. Everything below stays shut: a folder of hundreds of models
     * expanded by default is a wall, not a navigation aid.
     */
    const openRows = await page.evaluate(() => [...document.querySelectorAll(
        '[data-testid="layer-nav"] button[aria-expanded="true"]')]
        // The chevron and the label are siblings inside a row, so the row's
        // testid is beside the expanded button, not above it.
        .map(b => b.parentElement?.querySelector('[data-testid]')?.dataset.testid || '?'));
    check('only the dbt root opens by default',
        openRows.length === 1 && openRows[0] === 'tree-root-dbt', openRows.join(', ') || 'none open');
    check('the dbt root holds the resource types',
        (await page.locator('[data-testid="tree-group-model"]').count()) > 0);
    check('layer navigation rendered', (await page.locator('[data-testid="layer-nav"] button').count()) > 0,
        `${await page.locator('[data-testid="layer-nav"] button').count()} layers`);

    // A node must be the topmost element at its own coordinates: React Flow
    // silently makes node wrappers pointer-events:none under some prop
    // combinations, which looks fine and is entirely unusable.
    const clickable = await page.evaluate(() => {
        const btn = document.querySelector('.node-card button');
        if (!btn) return 'no expander button found';
        const r = btn.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return btn.contains(top) || top === btn ? true : `covered by ${top?.className}`;
    });
    check('nodes are clickable, not covered', clickable === true, clickable === true ? '' : String(clickable));

    // Expand a table and select a column — the core interaction.
    //
    // This must NOT re-solve the graph: expanding columns changes one node's
    // height, and re-running ELK for it was the canvas lag. The proof is that
    // the viewport does not move — a full re-layout re-fits the view, so a
    // changed transform on the pane means the fast path was skipped.
    const paneBefore = await page.evaluate(() =>
        document.querySelector('.react-flow__viewport').style.transform);
    const expander = page.locator('.node-card button[aria-expanded="false"]').first();
    if (await expander.count()) {
        await expander.click({ timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1200);
    }
    const paneAfter = await page.evaluate(() =>
        document.querySelector('.react-flow__viewport').style.transform);
    check('expanding columns does not re-fit the viewport', paneBefore === paneAfter,
        paneBefore === paneAfter ? '' : `${paneBefore} → ${paneAfter}`);

    // This sample solves inside a frame, so the overlay must never appear: a
    // blur that flashes for 40ms reads worse than no feedback at all. The
    // large-graph case is the opposite and is asserted by the threshold itself.
    check('no loading flash on a graph that solves instantly',
        (await page.locator('[data-testid="canvas-busy"]').count()) === 0);
    const columns = await page.locator('.col-row').count();
    check('table expands to columns', columns > 0, `${columns} column rows`);

    if (columns) {
        await page.locator('.col-row').first().click();
        await page.waitForTimeout(900);
    }
    // Scope to the side panel: the layer rail is also an <aside>.
    const panel = await page.evaluate(() =>
        document.querySelector('[data-testid="side-panel"]')?.innerText || '');
    check('side panel opens on selection', panel.length > 0);
    check('impact analysis shown', /Potential impact:/i.test(panel), panel.split('\n')[3] || '');
    check('impact states its scope', /Scope: column/i.test(panel));
    check('path highlighting applied', (await page.locator('.node-card.is-dim').count()) > 0);

    /*
     * Cards open collapsed, so "this table is affected" is all a trace shows
     * until one is expanded. Expanding a downstream table has to answer the
     * next question — which column did mine become — and the sample declares
     * exactly that: orders[order_id] → Sales[OrderID].
     *
     * Cards are located by name rather than narrowed with a filter: the header
     * box opens the palette now, and the palette navigates instead of hiding
     * what it does not match.
     */
    const ordersCard = page.locator('.node-card', { hasText: /^orders/ }).first();
    if (await ordersCard.count()) {
        await ordersCard.locator('button[aria-expanded="false"]').first().click().catch(() => {});
        await page.waitForTimeout(600);
        await ordersCard.locator('.col-row', { hasText: 'order_id' }).first().click().catch(() => {});
        await page.waitForTimeout(900);
    }
    const salesCard = page.locator('.node-card', { hasText: 'Sales' }).first();
    if (await salesCard.count()) {
        await salesCard.locator('button[aria-expanded="false"]').first().click().catch(() => {});
        await page.waitForTimeout(800);
    }
    const traced = await salesCard.locator('.col-row.is-traced').allInnerTexts().catch(() => []);
    check('expanding a downstream table marks the column this one became',
        traced.some(t => /OrderID/i.test(t)), traced.join(', ') || 'nothing marked');
    // The point of marking one column is that it is not every column.
    check('the mark is the traced column, not the whole table',
        traced.length > 0 && traced.length < 5, `${traced.length} of the table's columns marked`);

    /*
     * Every card on the path, not just the first and last.
     *
     * dbt edges carry identifiers as colibri lowercased them, while a card
     * renders the catalog's original case. The mark was keyed by the edge's
     * spelling and looked up by the card's, so `CustomerName` never matched
     * `customername` and every intermediate dbt model in a trace appeared
     * untouched — while the two ends, which come from the Power BI side and
     * keep their case, marked correctly and made it look like it worked.
     */
    const bulk = page.locator('[data-testid="expand-all"]');
    await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.waitForTimeout(500);
    await bulk.click();
    await page.waitForTimeout(1400);
    // The catalog spells it TAX_PAID_CENTS and colibri's edges say
    // tax_paid_cents — the only column in the sample where the two disagree,
    // and therefore the only one that reproduces this.
    const picked = await page.evaluate(() => {
        const row = [...document.querySelectorAll('.col-row')]
            .find(r => /^TAX_PAID_CENTS$/i.test(r.innerText.trim()));
        if (!row) return null;
        row.click();
        return row.innerText.trim();
    });
    await page.waitForTimeout(1400);
    const markedCards = await page.evaluate(() => [...document.querySelectorAll('.node-card')]
        .filter(c => c.querySelector('.col-row.is-traced, .col-row.is-selected'))
        .map(c => c.querySelector('.font-semibold')?.textContent?.trim()));
    check('a column whose case differs between edge and card still marks',
        Boolean(picked) && markedCards.length > 1,
        `picked ${picked}; ${markedCards.length} card(s) marked: ${markedCards.join(', ')}`);
    await bulk.click();
    await page.waitForTimeout(800);

    /*
     * Selecting a measure marks the columns it is built from.
     *
     * A measure has no columns of its own, so a selection on one used to carry
     * no column identity at all and every upstream card lit whole — "these
     * tables are involved" without ever saying which fields. Every edge into a
     * measure names the column it reads, so the walk has something to record
     * even when the starting point does not.
     */
    // Measures are off the canvas by default (DEFAULT_KINDS), so switch them on
    // through the rail before there is one to click.
    await page.locator('[data-testid="layer-nav"] [aria-label="Expand Power BI"]').first()
        .click().catch(() => {});
    await page.waitForTimeout(500);
    await page.locator('[data-testid="layer-nav"] [aria-label="Show Measures"]').first()
        .click().catch(() => {});
    await page.waitForTimeout(1800);
    /*
     * A named measure, not "the first one on canvas": `Revenue YoY %` is built
     * only from another measure, so it reads no columns directly and would make
     * this check fail for a reason that is not a bug.
     */
    const measure = page.locator('.node-card', { hasText: 'Customer Count' }).first();
    if (await measure.count()) {
        /*
         * Expand-all is a toggle, and earlier steps leave cards open. Pressing
         * it blind collapsed the path instead of opening it, and the marks were
         * present but hidden — a test failure that looked exactly like the
         * feature being broken. aria-pressed says which way the next press goes.
         */
        const openAll = async () => {
            if (await bulk.getAttribute('aria-pressed') === 'true') {
                await bulk.click();
                await page.waitForTimeout(700);
            }
            await bulk.click();
            await page.waitForTimeout(1400);
        };
        await measure.locator('.cursor-pointer').first().click().catch(() => {});
        await page.waitForTimeout(900);
        await openAll();
        const fields = await page.evaluate(() => [...document.querySelectorAll('.node-card')]
            .flatMap(c => [...c.querySelectorAll('.col-row.is-traced')]
                .map(r => `${c.querySelector('.font-semibold')?.textContent?.trim()}.${r.innerText.trim()}`)));
        const state = await page.evaluate(() => ({
            lit: document.querySelectorAll('.node-card:not(.is-dim)').length,
            open: document.querySelectorAll('.node-card button[aria-expanded="true"]').length,
            rows: document.querySelectorAll('.col-row').length,
            sel: document.querySelector('[data-testid="side-panel"] header')?.innerText.split('\n')[0] || 'none',
        }));
        check('selecting a measure marks the columns it reads',
            fields.length > 0,
            fields.slice(0, 4).join(', ') || `no columns marked (${JSON.stringify(state)})`);
        // Not the whole table: that is the claim a lit card already makes.
        const everyColumn = await page.evaluate(() => [...document.querySelectorAll('.node-card')]
            .some(c => {
                const rows = c.querySelectorAll('.col-row');
                const lit = c.querySelectorAll('.col-row.is-traced');
                return rows.length > 2 && lit.length === rows.length;
            }));
        check('a measure marks the fields it uses, not every column',
            !everyColumn);
        await bulk.click();
        await page.waitForTimeout(600);
    } else {
        check('selecting a measure marks the columns it reads', false, 'no measure card found');
    }

    /*
     * Bulk expand, both scopes.
     *
     * With a trace live it must open the path and leave the rest alone —
     * opening everything would bury the thing just traced. With nothing
     * selected there is no path to respect, so it opens what is on canvas.
     */
    const openCards = () => page
        .locator('.node-card button[aria-expanded="true"]:not([aria-haspopup])').count();
    const expandAll = page.locator('[data-testid="expand-all"]');

    // No selection first: it also leaves the canvas fully collapsed, which the
    // path-scoped case below needs as its starting point. Cards expanded by
    // hand earlier in this run are still open, and bulk expand deliberately
    // does not force them shut — so collapse-all is what clears them.
    await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.waitForTimeout(600);
    await expandAll.click();
    await page.waitForTimeout(1200);
    const openedAll = await openCards();
    /*
     * Column chevrons only. The hop `+` button carries `aria-expanded` too —
     * correctly, for its own dropdown menu, which is closed — and counting those
     * as unopened column lists failed the check on any canvas where a card had
     * hidden neighbours to offer. Expand-all targets cards that have columns, so
     * that is what this has to count.
     */
    const withColumns = await page
        .locator('.node-card button[aria-expanded]:not([aria-haspopup])').count();
    check('expand-all with no selection opens everything on canvas',
        openedAll > 0 && openedAll === withColumns,
        `${openedAll} of ${withColumns} cards with columns`);
    await expandAll.click();
    await page.waitForTimeout(900);
    check('the same button collapses what it opened', (await openCards()) === 0,
        `${await openCards()} still open`);

    await page.locator('.node-card', { hasText: 'Sales' }).first()
        .locator('.cursor-pointer').first().click().catch(() => {});
    await page.waitForTimeout(800);
    const litCount = await page.locator('.node-card:not(.is-dim)').count();
    const dimCount = await page.locator('.node-card.is-dim').count();
    await expandAll.click();
    await page.waitForTimeout(900);
    const openedOnPath = await openCards();
    check('expand-all with a selection opens the highlighted path',
        openedOnPath > 0 && openedOnPath <= litCount,
        `${openedOnPath} opened, ${litCount} lit, ${dimCount} dim`);
    const dimOpen = await page.locator('.node-card.is-dim button[aria-expanded="true"]').count();
    check('expand-all with a selection leaves the rest closed', dimOpen === 0,
        `${dimOpen} dimmed cards opened`);
    await expandAll.click();
    await page.waitForTimeout(700);

    // A boundary node's provenance list must never crowd out the impact
    // analysis: it is capped at half the panel and scrolls inside itself.
    // Power BI tables are the boundary nodes — one of them must carry the
    // mapping rows this sample declares.
    await page.locator('.node-card', { hasText: 'PBI table' }).first().click();
    await page.waitForTimeout(900);
    const prov = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="provenance"]');
        if (!el) return null;
        const panel = document.querySelector('[data-testid="side-panel"]');
        return {
            ratio: el.getBoundingClientRect().height / panel.getBoundingClientRect().height,
            text: el.innerText,
        };
    });
    check('crossing provenance rendered', !!prov, prov ? prov.text.split('\n')[0] : 'none');
    check('crossing provenance capped at half the panel',
        !!prov && prov.ratio <= 0.55, prov ? `${(prov.ratio * 100).toFixed(0)}%` : '');
    check('declared links grouped as a mapping-file sentence',
        !!prov && /Mapped in the mapping file/i.test(prov.text));

    // Nodes must be movable, and the reset must put them back.
    const nodeBox = await page.locator('.react-flow__node').first().boundingBox();
    const before = await page.evaluate(() => document.querySelector('.react-flow__node').style.transform);
    await page.mouse.move(nodeBox.x + nodeBox.width / 2, nodeBox.y + 8);
    await page.mouse.down();
    await page.mouse.move(nodeBox.x + nodeBox.width / 2 + 160, nodeBox.y + 120, { steps: 10 });
    // Read the transform with the button still down. The bug this guards against
    // was invisible to a before/after check: a fully controlled `nodes` array
    // discarded React Flow's in-flight position changes, so the card stayed put
    // under the cursor and only jumped into place on release.
    const during = await page.evaluate(() => document.querySelector('.react-flow__node').style.transform);
    await page.mouse.up();
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => document.querySelector('.react-flow__node').style.transform);
    check('nodes are draggable', before !== after);
    check('a dragged node follows the cursor before release', during !== before,
        `${before} → ${during}`);

    await page.locator('button', { hasText: /Reset layout/ }).click();
    await page.waitForTimeout(1400);
    const restored = await page.evaluate(() => document.querySelector('.react-flow__node').style.transform);
    check('reset layout restores alignment', restored === before);

    // Database tab: focus one table, then walk out from it with the stepper.
    await page.locator('[data-testid="nav-tabs"] button').nth(1).click();
    await page.waitForTimeout(400);
    await page.locator('[data-testid="tree-schema"]').first().click();
    await page.waitForTimeout(300);
    // Table rows sit two levels in; the last rows in the rail are tables.
    const tableRows = page.locator('[data-testid="tree-table"]');
    check('database tree lists tables', (await tableRows.count()) > 0,
        `${await tableRows.count()} tables`);

    await tableRows.first().click();
    await page.waitForTimeout(1800);
    check('focus chip appears', (await page.locator('[data-testid="focus-chip"]').count()) === 1);
    const focused = await page.locator('.node-card').count();
    check('focus shows one table only', focused === 1, `${focused} cards`);

    // Whichever direction this table actually has neighbours in — a leaf table
    // legitimately offers only one, and the handles are the source of truth.
    const handles = await page.locator('.hop-btn').count();
    check('per-node hop handles rendered', handles > 0, `${handles} handles`);
    const hasDown = await page.locator('.hop-btn[title*="downstream"]').count() > 0;

    await page.locator(`[data-testid="stepper"] button[aria-label="Expand ${hasDown ? 'downstream' : 'upstream'}"]`).click();
    await page.waitForTimeout(1800);
    const afterStep = await page.locator('.node-card').count();
    check(`stepper expands ${hasDown ? 'downstream' : 'upstream'}`, afterStep > focused,
        `${focused} → ${afterStep}`);

    await page.locator('[data-testid="focus-chip"] button').click();
    await page.waitForTimeout(1500);
    check('clearing focus restores the filtered view',
        (await page.locator('[data-testid="focus-chip"]').count()) === 0 &&
        (await page.locator('.node-card').count()) > afterStep);

    // The rail must be draggable, and double-click must hand the width back to
    // the responsive clamp() rather than leaving a stale pixel value.
    const railWidth = async () =>
        Math.round((await page.locator('[data-testid="layer-nav"]').boundingBox()).width);
    const w0 = await railWidth();
    // Both views are mounted, so both rails have a handle; this is the visible
    // one. The layout's rail shares the same width, deliberately.
    const grip = await page.locator('[data-testid="resizer-left"]:visible').boundingBox();
    await page.mouse.move(grip.x + 3, grip.y + 150);
    await page.mouse.down();
    await page.mouse.move(grip.x + 123, grip.y + 150, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const w1 = await railWidth();
    check('navigation rail resizes', w1 > w0 + 80, `${w0} → ${w1}`);
    await page.locator('[data-testid="resizer-left"]:visible').dblclick();
    await page.waitForTimeout(400);
    check('double-click resets the rail width', (await railWidth()) === w0);

    /* A visual opens on its fields, grouped by role rather than printed as a
       sideways-scrolling blob, and the page name appears once, not twice. The
       tab is "Fields & filters": a visual has no compiled SQL, so calling that
       pane "Definition" asked the reader to guess. */
    await page.locator('[data-testid="nav-tabs"] button').first().click();
    await page.locator('[data-testid="reset-view"]').click();
    await page.waitForTimeout(300);
    await showAll(page);
    await page.waitForTimeout(800);
    // Visuals are off by default and the folder starts collapsed, so open it
    // first: chevron to expand, row to show.
    await page.locator('button[aria-label="Expand Power BI"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="layer-nav"] button', { hasText: /^Visuals/ }).first().click();
    await page.waitForTimeout(1600);
    const visualCard = page.locator('.node-card', { hasText: 'visual ·' }).first();
    if (await visualCard.count()) {
        await visualCard.click();
        await page.waitForTimeout(600);
        const visualTabs = await page.locator('[data-testid="side-panel"] [role="tab"]').allInnerTexts();
        check('a visual gets tabs named for what a visual has',
            visualTabs.join('|') === 'Fields & filters|Details', visualTabs.join(' | '));
        check('and opens on its fields rather than on an impact summary',
            (await page.locator('[data-testid="side-panel"] [role="tab"][aria-selected="true"]')
                .innerText()) === 'Fields & filters');
        const def = await page.evaluate(() => {
            const el = document.querySelector('[data-testid="side-panel"]');
            const scroller = [...el.querySelectorAll('*')]
                .find(n => n.scrollWidth > n.clientWidth + 4);
            return { text: el.innerText, overflows: !!scroller };
        });
        check('fields used are grouped by role', /FIELDS USED/i.test(def.text));

        /* Each row says how far back it reaches — the answer a separate
           "Depends on" tab would have given, without the second list. */
        const depths = await page.locator('[data-testid="field-depth"]').allInnerTexts();
        check('a field row says how far upstream it goes',
            depths.length > 0 && depths.every(d => /\d+ (dbt model|source)/.test(d)),
            depths[0] || '(none)');

        /* A field is a way into the lineage, not a label: clicking one focuses
           that node and switches to the tab where the trace lives. */
        const linked = page.locator('[data-testid="field-row"][data-resolved="true"]');
        if (await linked.count()) {
            await linked.first().click();
            await page.waitForTimeout(1500);
            const onLineage = await page.locator('header button[role="tab"]', { hasText: 'Lineage' })
                .getAttribute('aria-selected');
            check('clicking a field drills through to its lineage',
                onLineage === 'true' && (await page.locator('[data-testid="focus-chip"]').count()) === 1,
                await page.locator('[data-testid="focus-chip"]').textContent().catch(() => ''));
            /* Put the visual back. The drill-through left the *measure*
               selected, and the header checks below are about a visual —
               reading them off a measure would test the wrong node. */
            await page.locator('[data-testid="focus-chip"] button').click();
            await page.waitForTimeout(1200);
            await visualCard.click();
            await page.waitForTimeout(800);
        } else {
            check('clicking a field drills through to its lineage', true, 'no resolvable field in this sample');
        }
        check('field list does not scroll sideways', !def.overflows);

        const header = await page.evaluate(() => {
            const el = document.querySelector('[data-testid="side-panel"] header');
            return el ? el.innerText : '';
        });
        const page_ = header.split('\n')[1] || '';
        const repeats = page_ && header.split(page_).length - 1 > 1;
        check('page name is not printed twice', !repeats, header.replace(/\n/g, ' | '));
    } else {
        check('fields used are grouped by role', true, 'no visual in this sample');
        check('field list does not scroll sideways', true, 'skipped');
        check('page name is not printed twice', true, 'skipped');
    }

    // Pages replace visuals as the default endpoint: a report with a couple of
    // hundred visuals
    // cannot be read one visual at a time. Back to defaults first — the block
    // above switched visuals on.
    await page.locator('[data-testid="reset-view"]').click();
    await page.waitForTimeout(300);
    await showAll(page);
    await page.waitForTimeout(1600);
    const pageCards = await page.locator('.node-card', { hasText: 'report page' }).count();
    check('pages are on the canvas by default', pageCards > 0, `${pageCards} page cards`);
    check('visuals are not', (await page.locator('.node-card', { hasText: 'visual ·' }).count()) === 0);

    /*
     * The page-layout tab: the report drawn as its author drew it.
     *
     * "3 visuals downstream" is a fact the lineage tab already gives; this
     * turns it into a place — that box, on that page, in that corner. The
     * sample has no pages.json, so it also exercises the fallback where page
     * order and visibility are simply absent.
     */
    await page.locator('button[role="tab"]', { hasText: 'Page layout' }).click();
    await page.waitForTimeout(1000);
    const rowCount = await page.locator('[data-testid="page-row"]').count();
    check('the page-layout tab lists the report pages', rowCount > 0, `${rowCount} page(s)`);

    // Boxes are drawn from the real position, not laid out by us. Two visuals
    // at the same coordinates would mean the geometry never arrived.
    const boxes = await page.locator('[data-testid="layout-visual"]').count();
    const geometry = await page.evaluate(() => {
        const frame = document.querySelector('[data-testid="page-frame"]').getBoundingClientRect();
        return [...document.querySelectorAll('[data-testid="layout-visual"]')].map(el => {
            const r = el.getBoundingClientRect();
            return {
                x: Math.round(r.left - frame.left), y: Math.round(r.top - frame.top),
                w: Math.round(r.width), h: Math.round(r.height),
            };
        });
    });
    check('each visual is drawn at its own position and size',
        boxes > 1 && geometry.every(g => g.w > 0 && g.h > 0) &&
        new Set(geometry.map(g => `${g.x},${g.y}`)).size === boxes,
        geometry.map(g => `${g.w}×${g.h}@${g.x},${g.y}`).join(' '));

    // Clicking a box is a way into the lineage, not just a picture.
    await page.locator('[data-testid="layout-visual"]').first().click();
    await page.waitForTimeout(800);
    const panelText = await page.locator('aside').last().innerText().catch(() => '');
    check('picking a visual on the layout selects it',
        /visual|Fields used/i.test(panelText), panelText.split('\n')[0] || '(no panel)');

    /* Nobody discovers that the two tabs are one answer by guessing at it. The
       panel has to say so, and the saying has to work. */
    const cta = page.locator('[data-testid="trace-cta"]');
    check('the layout panel offers a way into the lineage',
        (await cta.count()) === 1,
        (await cta.innerText().catch(() => '')).split('\n')[0] || '(no button)');
    await cta.click();
    await page.waitForTimeout(1200);
    const ctaLanded = await page.locator('header button[role="tab"][aria-selected="true"]')
        .first().innerText();
    check('and pressing it lands the visual on the canvas',
        /lineage/i.test(ctaLanded) &&
        (await page.locator('[data-testid="trace-cta"]').count()) === 0, ctaLanded);

    /*
     * Back returns you to the tab you pressed from, not to the one you landed
     * on. Composed as setTab-then-focus at the call site, the snapshot was
     * taken after the tab had already changed, so Back re-ran the trace on the
     * lineage tab and read as a refresh.
     */
    await page.locator('[data-testid="panel-back"]').click();
    await page.waitForTimeout(1200);
    const backTab = await page.locator('header button[role="tab"][aria-selected="true"]')
        .first().innerText();
    check('Back returns to the tab you came from', /layout/i.test(backTab), backTab);

    await page.locator('header button[role="tab"]', { hasText: 'Page layout' }).click();
    await page.waitForTimeout(900);
    // The button selected on the lineage tab, so the panel now belongs there.
    // Pick the box again to put the next checks back on known ground.
    await page.locator('[data-testid="layout-visual"]').first().click();
    await page.waitForTimeout(800);

    /* The panel belongs to the view that opened it. Carrying it across meant a
       visual's panel hung over the lineage canvas — and a dbt model's panel over
       a page layout, where it has nothing to say. */
    await page.locator('button[role="tab"]', { hasText: 'Lineage' }).click();
    await page.waitForTimeout(600);
    // Both views stay mounted now, so the hidden one still holds its panel in
    // the DOM. Visibility is the question, not presence.
    const visiblePanels = () => page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="side-panel"]')]
            .filter(el => el.getBoundingClientRect().width > 0).length);
    const strayPanel = await visiblePanels();
    check('the panel does not follow you to another view', strayPanel === 0,
        `${strayPanel} panel(s) on lineage`);
    await page.locator('button[role="tab"]', { hasText: 'Page layout' }).click();
    await page.waitForTimeout(600);
    const backPanel = await visiblePanels();
    check('and is still there when you come back', backPanel === 1,
        `${backPanel} panel(s) back on layout`);

    await page.locator('button[role="tab"]', { hasText: 'Lineage' }).click();
    await page.waitForTimeout(600);

    /*
     * The payoff: pick a column in the lineage tab, come back here, and the
     * boxes that read it are lit — with the rail saying which pages to look at,
     * because a report has more pages than one screen.
     */
    await page.locator('button[role="tab"]', { hasText: 'Lineage' }).click();
    await page.waitForTimeout(1200);
    await page.keyboard.press('Control+k');
    /* The palette keeps its facets between openings, and the attribute test
       above left it narrowed to dbt columns — a measure search under that
       filter returns nothing and the check would fail on the test's own state.
       `Total Revenue`, not any column: in this sample the visuals are fed by
       measures, so most columns reach no visual at all and the check would be
       asserting the absence of a feature rather than its presence. */
    const clearFacets = page.locator('[data-testid="search-palette"] button', { hasText: /^clear$/ });
    if (await clearFacets.count()) await clearFacets.click();
    await page.locator('[data-testid="palette-input"]').fill('Total Revenue');
    await page.waitForTimeout(500);
    await page.locator('[data-testid="palette-result"]').first().click();
    await page.waitForTimeout(1500);
    await page.locator('button[role="tab"]', { hasText: 'Page layout' }).click();
    await page.waitForTimeout(1000);
    const lit = await page.locator('[data-testid="layout-visual"][data-lit="true"]').count();
    const railHits = await page.locator('[data-testid="page-hits"]').first().getAttribute('data-hits');
    check('a traced column lights the visuals that read it',
        lit > 0 && Number(railHits) === lit, `${lit} lit box(es), rail says ${railHits}`);

    /*
     * And says why. Boxes lighting up on a tab you just arrived at, with
     * nothing on screen accounting for them, reads as the two tabs being
     * silently wired together — the lighting is the feature, the silence was
     * the bug. The note names the trace and offers the way out of it.
     */
    const note = page.locator('[data-testid="trace-note"]');
    const noteText = await note.innerText().catch(() => '');
    check('the layout says whose trace it is showing',
        (await note.count()) === 1 && /Total Revenue/.test(noteText),
        noteText.replace(/\n/g, ' ') || '(no note)');
    check('and counts what it reached on this page',
        new RegExp(`${lit} of \\d+`).test(noteText), noteText.replace(/\n/g, ' '));

    await page.locator('[data-testid="trace-note-clear"]').click();
    await page.waitForTimeout(600);
    check('clearing the note puts the page back',
        (await page.locator('[data-testid="layout-visual"][data-lit="true"]').count()) === 0 &&
        (await page.locator('[data-testid="trace-note"]').count()) === 0);

    // Re-trace: the checks below read a lit canvas.
    await page.locator('button[role="tab"]', { hasText: 'Lineage' }).click();
    await page.waitForTimeout(1000);
    await page.keyboard.press('Control+k');
    await page.locator('[data-testid="palette-input"]').fill('Total Revenue');
    await page.waitForTimeout(500);
    await page.locator('[data-testid="palette-result"]').first().click();
    await page.waitForTimeout(1500);
    await page.locator('button[role="tab"]', { hasText: 'Page layout' }).click();
    await page.waitForTimeout(1000);

    /*
     * A click changes the tab you are looking at, and no other. Picking a box
     * here used to recompute the lineage highlight, so you switched over to a
     * canvas lit around a visual you never traced, with nothing on screen
     * accounting for it. The trace moves only on a deliberate press.
     */
    // Measured on the lineage tab: the canvas is unmounted while the layout is
    // showing, so counting from here would compare zero with zero.
    await page.locator('button[role="tab"]', { hasText: 'Lineage' }).click();
    await page.waitForTimeout(1200);
    // The lit set, not the dimmed one: a focused canvas can hold a single card
    // with nothing to dim, and zero-equals-zero would pass without proving it.
    // is-lit and is-selected together: a card carries one or the other, so the
    // selected card would look like it left the lit set when it is only wearing
    // the other class.
    const litIds = () => page.evaluate(() =>
        [...document.querySelectorAll('.node-card.is-lit, .node-card.is-selected')]
        .map(el => el.getAttribute('data-id') || el.textContent.trim().slice(0, 40))
        .sort().join(','));
    const litBeforeTrip = await litIds();
    await page.locator('button[role="tab"]', { hasText: 'Page layout' }).click();
    await page.waitForTimeout(900);
    await page.locator('[data-testid="layout-visual"]').first().click();
    await page.waitForTimeout(900);
    await page.locator('button[role="tab"]', { hasText: 'Lineage' }).click();
    await page.waitForTimeout(1200);
    const litAfterTrip = await litIds();
    check('picking a box on the layout leaves the lineage canvas alone',
        litAfterTrip === litBeforeTrip && litBeforeTrip.length > 0,
        `lit before: ${litBeforeTrip || '(none)'} · after: ${litAfterTrip || '(none)'}`);
    await page.locator('button[role="tab"]', { hasText: 'Page layout' }).click();
    await page.waitForTimeout(900);

    /*
     * The panel's own controls are the ones that leaked. They live on both
     * tabs, so each was written as if it were always on the lineage tab:
     * closing the panel cleared the highlight, and the column link retraced.
     * Both fire while the canvas they were rewriting is off screen.
     */
    await page.locator('[data-testid="side-panel"] [aria-label="Close panel"]').click();
    await page.waitForTimeout(600);
    await page.locator('button[role="tab"]', { hasText: 'Lineage' }).click();
    await page.waitForTimeout(1200);
    check('closing the panel on the layout does not clear the trace',
        (await litIds()) === litBeforeTrip, `lit after close: ${await litIds() || '(none)'}`);
    await page.locator('button[role="tab"]', { hasText: 'Page layout' }).click();
    await page.waitForTimeout(900);

    /*
     * The chip that went nowhere. Pressed from the layout it re-pinned the
     * lineage canvas, discarded reveals and drag positions, and left you
     * standing on the layout with nothing visibly changed — the worst shape a
     * cross-tab write can take, because there is no way to notice it.
     */
    await page.locator('[data-testid="layout-visual"]').first().click();
    await page.waitForTimeout(700);
    const chip = page.locator('[data-testid="affected-measure"]');
    if (await chip.count()) {
        await chip.first().click();
        await page.waitForTimeout(1200);
        const wentTo = await page.locator('header button[role="tab"][aria-selected="true"]')
            .first().innerText();
        check('an affected measure says where it is taking you', /lineage/i.test(wentTo), wentTo);
        await page.locator('button[role="tab"]', { hasText: 'Page layout' }).click();
        await page.waitForTimeout(900);
    } else {
        check('an affected measure says where it is taking you', true,
            'no measure chip on this panel');
    }

    /*
     * Back. Every route into this panel replaces what was on screen, and
     * rebuilding the previous view by hand — re-search, re-expand, re-focus —
     * is the cost this button removes.
     */
    const back = page.locator('[data-testid="panel-back"]');
    check('the panel offers a way back', (await back.count()) === 1);
    const beforeBack = await page.locator('[data-testid="side-panel"] .font-semibold')
        .first().innerText();
    await page.locator('[data-testid="layout-visual"]').nth(1).click();
    await page.waitForTimeout(700);
    const moved = await page.locator('[data-testid="side-panel"] .font-semibold')
        .first().innerText();
    await page.locator('[data-testid="panel-back"]').click();
    await page.waitForTimeout(700);
    const returned = await page.locator('[data-testid="side-panel"] .font-semibold')
        .first().innerText();
    check('and pressing it returns to what you were looking at',
        moved !== beforeBack && returned === beforeBack,
        `${beforeBack} → ${moved} → ${returned}`);

    // Hand the canvas back: every check below this one reads the lineage tab.
    await page.locator('button[role="tab"]', { hasText: 'Lineage' }).click();
    await page.waitForSelector('[data-testid="reset-view"]', { timeout: 15000 });
    await page.waitForTimeout(1200);

    /*
     * A layer is a folder name, and the sample has a model folder called
     * `sources` — the same string as the sources resource type's layer. Hiding
     * that folder must hide models in it and nothing else. It used to hide
     * every dbt source too, because the layer axis was applied to every node
     * rather than to models.
     */
    await page.locator('[data-testid="reset-view"]').click();
    await page.waitForTimeout(300);
    await showAll(page);
    await page.waitForTimeout(1200);
    const countByKind = () => page.evaluate(() => {
        const out = { source: 0, model: 0 };
        for (const el of document.querySelectorAll('.node-card')) {
            const t = el.innerText;
            if (/\bsource\b/.test(t)) out.source++;
            else if (/\bmodel\b/.test(t)) out.model++;
        }
        return out;
    });
    // "Linked only" is on by default and the folder's model reaches no visual,
    // so it has to come off for the folder to have anything to hide.
    await page.locator('[data-testid="linked-only"]').uncheck();
    await page.waitForTimeout(1600);
    await page.locator('button[aria-label="Expand models"]').click();
    await page.waitForTimeout(300);
    // Two rows are labelled "sources": the folder under models comes first,
    // the sources resource group second. The folder is the one under test.
    const folderEye = page.locator('[data-testid="layer-nav"] [aria-label="Hide sources"]').first();
    if (await folderEye.count()) {
        const before = await countByKind();
        await folderEye.click();
        await page.waitForTimeout(1600);
        const after = await countByKind();
        check('hiding a model folder leaves the sources resource alone',
            after.source === before.source && after.model < before.model,
            `sources ${before.source}→${after.source}, models ${before.model}→${after.model}`);
        await folderEye.click();
        await page.waitForTimeout(1200);

        /*
         * A parent folder governs its whole subtree. Hiding `staging` while
         * `staging/base` stays on canvas is a control that appears not to work
         * — the same shape as the sources/models name collision this block
         * already guards. The sample nests one model for exactly this check.
         */
        const staging = page.locator('[data-testid="layer-nav"] [aria-label="Hide staging"]').first();
        if (await staging.count()) {
            const beforeNest = await countByKind();
            await staging.click();
            await page.waitForTimeout(1600);
            const afterNest = await countByKind();
            const onCanvas = await page.evaluate(() =>
                [...document.querySelectorAll('.node-card')].some(c => /stg_supplies/.test(c.innerText)));
            check('hiding a folder hides its subfolders too',
                !onCanvas && afterNest.model < beforeNest.model,
                `models ${beforeNest.model}→${afterNest.model}, nested model still shown: ${onCanvas}`);
            // The eye's label flips once it is off, so this is a new locator,
            // not the same one clicked again.
            await page.locator('[data-testid="layer-nav"] [aria-label="Show staging"]').first().click();
            await page.waitForTimeout(1400);
            check('showing it again brings the subtree back',
                (await countByKind()).model === beforeNest.model,
                `models back to ${(await countByKind()).model} of ${beforeNest.model}`);
        } else {
            check('hiding a folder hides its subfolders too', false, 'no staging folder row');
        }
    } else {
        check('hiding a model folder leaves the sources resource alone', false,
            'no "sources" folder row under models — the fixture no longer covers this');
    }
    await page.locator('[data-testid="reset-view"]').click();
    await page.waitForTimeout(300);
    await showAll(page);
    await page.waitForTimeout(1400);

    // Containment must never inflate impact: reaching one visual on a page
    // cannot make the other visuals on it count as affected.
    const inflated = await page.evaluate(() => {
        const d = window.__LINEAGE__;
        const pageOf = new Map();
        for (const n of Object.values(d.nodes)) {
            if (n.kind === 'visual') pageOf.set(n.id, `pbi:page:${n.meta.pageId}`);
        }
        const perPage = new Map();
        for (const [, p] of pageOf) perPage.set(p, (perPage.get(p) || 0) + 1);
        // Any impact claiming more visuals than exist on the pages it reaches
        // means a page_to_visual edge was followed.
        for (const imp of Object.values(d.impact.column)) {
            const pages = new Set((imp.visuals || []).map(v => pageOf.get(v)));
            let ceiling = 0;
            for (const p of pages) ceiling += perPage.get(p) || 0;
            if ((imp.visuals || []).length > ceiling) return true;
        }
        return false;
    });
    check('page containment does not inflate impact counts', !inflated);

    // The column list: cards with descriptions, lineage as an edge stripe.
    await page.locator('.node-card', { hasText: 'PBI table' }).first().click();
    await page.waitForTimeout(500);
    await page.locator('[data-testid="side-panel"] button', { hasText: 'Metadata' }).click();
    await page.waitForTimeout(400);
    const cols = await page.locator('.col-card').count();
    check('columns render as cards', cols > 0, `${cols} column cards`);
    // A key column appears in no visual, so the chip naming its join is the
    // only thing on the card that says it is load-bearing.
    const rel = await page.evaluate(() => {
        const chips = [...document.querySelectorAll('.rel-chip')];
        return {
            count: chips.length,
            first: chips[0]?.innerText.replace(/\n/g, ' ') || '',
            inactive: chips.filter(c => c.classList.contains('is-inactive')).length,
        };
    });
    check('relationship keys name their other side', rel.count > 0, rel.first);
    // Open the table that actually has feeder columns and check they render as
    // feeders rather than as keys — the two facts must stay distinguishable.
    const feederTable = await page.evaluate(() => {
        for (const n of Object.values(window.__LINEAGE__.nodes)) {
            if (n.kind !== 'pbiTable') continue;
            if ((n.columns || []).some(c => c.keysFed?.length && !c.relationships?.length)) return n.name;
        }
        return null;
    });
    check('some column is recorded as feeding a key', !!feederTable, feederTable || 'none');
    if (feederTable) {
        // Matched on the card's exact title rather than narrowed with a filter,
        // so the click cannot land on a neighbour with a similar name.
        await page.evaluate(name => {
            const card = [...document.querySelectorAll('.node-card')]
                .find(c => c.innerText.split('\n')[0].trim() === name);
            // The click handler sits on the card's inner header, not on the
            // card itself, so clicking the outer element selects nothing.
            (card?.querySelector('.cursor-pointer') || card)?.click();
        }, feederTable);
        await page.waitForTimeout(700);
        await page.locator('[data-testid="side-panel"] button', { hasText: 'Metadata' }).click();
        await page.waitForTimeout(600);
        const counts = await page.evaluate(() => ({
            on: document.querySelector('[data-testid="side-panel"] header')?.innerText.split('\n')[0] || '',
            keys: document.querySelectorAll('.rel-chip:not(.is-feeder)').length,
            feeders: document.querySelectorAll('.rel-chip.is-feeder').length,
        }));
        check('feeding a key renders differently from being one',
            counts.feeders > 0 && counts.keys > 0,
            `on ${counts.on}: ${counts.keys} key chips, ${counts.feeders} feeder chips`);
    } else {
        check('feeding a key renders differently from being one', false, 'no feeder column in the sample');
    }

    // The impact sentence must not leave a key column reading "0 visuals" with
    // nothing to say why that is not the same as "safe to drop".
    const keyNote = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.col-card')];
        const keyed = rows.find(r => r.querySelector('.rel-chip'));
        const name = keyed?.querySelector('.font-semibold')?.textContent?.trim();
        return name || null;
    });
    if (keyNote) {
        await page.locator('[data-testid="side-panel"] button', { hasText: 'Overview' }).click();
        await page.waitForTimeout(400);
        const said = await page.evaluate(() =>
            document.querySelector('[data-testid="side-panel"]')?.innerText || '');
        check('the panel explains a key at table scope without inventing one',
            !/A broken join changes the numbers/.test(said) || /join key/i.test(said),
            keyNote);
        /*
         * A join is the dependency that breaks without breaking anything: the
         * visuals counted in the same sentence keep rendering. So the count
         * belongs in that sentence, not only in the note below it.
         */
        check('the impact sentence counts the joins this table holds up',
            /\d+ relationships?/.test(said),
            (said.match(/.*relationships?.*/) || ['not in the sentence'])[0].trim());
    } else {
        check('the panel explains a key at table scope without inventing one',
            true, 'no keyed column here');
    }

    /*
     * An affected visual is a place, not just a name: clicking one travels to
     * the page layout and rings the box. The trace must survive the trip — the
     * list you clicked from exists because of the current selection, so
     * re-selecting the visual would darken the other pages in the same list.
     */
    const affected = page.locator('[data-testid="affected-visual"]');
    if (await affected.count()) {
        const litBefore = await page.evaluate(() =>
            document.querySelector('[data-testid="side-panel"]').innerText);
        await affected.first().click();
        await page.waitForTimeout(900);
        // The panel has tabs of its own, so this is the app header's row.
        const onLayout = await page.locator('header button[role="tab"][aria-selected="true"]')
            .first().innerText();
        check('an affected visual travels to the page layout', /layout/i.test(onLayout), onLayout);
        check('and rings the box you asked for',
            (await page.locator('[data-testid="layout-visual"][data-pulse="true"]').count()) === 1);
        /* The ring fades after ~1.6s. What you travelled for still has to be
           findable a minute later, so the outline stays. */
        await page.waitForTimeout(2200);
        check('and the box stays marked once the ring fades',
            (await page.locator('[data-testid="layout-visual"][data-pulse="true"]').count()) === 0 &&
            (await page.locator('[data-testid="layout-visual"][data-selected="true"]').count()) === 1);
        // Same panel, same list: the trace was not replaced by the visual.
        const after = await page.evaluate(() =>
            document.querySelector('[data-testid="side-panel"]')?.innerText || '');
        check('the trace survives the trip', after === litBefore,
            after.split('\n')[0] || '(no panel)');
        /* Travel twice, then step back: the second trip must be undone, not
           just counted. `reveal` was missing from the snapshot, so the history
           advanced while the one view that could show it stayed put. */
        const rows = page.locator('[data-testid="affected-visual"]');
        if (await rows.count() > 1) {
            const firstPage = await page.locator('[data-testid="page-row"][data-page-id]')
                .evaluateAll(els => els.findIndex(e => e.style.background !== 'transparent'));
            await rows.nth(1).click();
            await page.waitForTimeout(1200);
            const movedTo = await page.locator('[data-testid="layout-visual"][data-selected="true"]')
                .first().innerText().catch(() => '');
            await page.locator('[data-testid="panel-back"]').click();
            await page.waitForTimeout(1200);
            const backTo = await page.locator('[data-testid="layout-visual"][data-selected="true"]')
                .first().innerText().catch(() => '');
            check('Back steps the layout back to the visual before it',
                backTo !== movedTo && backTo.length > 0, `${movedTo} → back → ${backTo}`);
        } else {
            check('Back steps the layout back to the visual before it', true,
                'only one affected visual here');
        }

        /* Arriving this way leaves a *table's* panel open on the layout tab —
           the one state where the affected-measure chips are reachable from
           there. Pressed, they used to re-pin the lineage canvas while you
           stood on the layout with nothing visibly changed. */
        const strandedChip = page.locator('[data-testid="affected-measure"]');
        if (await strandedChip.count()) {
            await strandedChip.first().click();
            await page.waitForTimeout(1200);
            const went = await page.locator('header button[role="tab"][aria-selected="true"]')
                .first().innerText();
            check('a measure chip pressed from the layout takes you with it',
                /lineage/i.test(went), went);
            // It focused the canvas on that measure; hand the full graph back
            // to the checks below.
            await page.locator('[data-testid="reset-view"]').click();
            await page.waitForTimeout(300);
            await showAll(page);
    await page.waitForTimeout(300);
    await showAll(page);
            await page.waitForTimeout(1500);
        } else {
            check('a measure chip pressed from the layout takes you with it',
                true, 'no measure chip in this arrival');
        }

        await page.locator('header button[role="tab"]', { hasText: 'Lineage' }).click();
        await page.waitForTimeout(900);
    } else {
        check('a measure chip pressed from the layout takes you with it', true, 'skipped');
        check('an affected visual travels to the page layout', true, 'no affected visual here');
        check('and rings the box you asked for', true, 'skipped');
        check('the trace survives the trip', true, 'skipped');
    }


    const findShown = await page.locator('[data-testid="column-find"]').count();
    check('find box tracks the column count', findShown === (cols >= 8 ? 1 : 0),
        `${cols} columns, find ${findShown ? 'shown' : 'hidden'}`);

    // Fonts must actually be embedded — a report that silently falls back to
    // the system stack looks different on every machine.
    const fontsOk = await page.evaluate(async () => {
        await document.fonts.ready;
        return getComputedStyle(document.body).fontFamily.includes('Inter var')
            && document.fonts.check('16px "Inter var"');
    });
    check('bundled typeface loaded from the inlined bytes', fontsOk);

    // Diagnostics must be reachable and populated.
    await page.locator('nav button', { hasText: /Diagnostics/ }).first().click();
    await page.waitForTimeout(700);
    const diag = await page.evaluate(() => document.body.innerText);
    check('diagnostics tab renders', /Mapping rows that could not be resolved/i.test(diag));

    /*
     * A diagnostics row is a way onto the canvas, and Back has to be a way out
     * of it: the row leaves a focus pin and a trace behind, and reconstructing
     * "the list I was reading" by hand is the cost Back exists to remove.
     */
    const openRow = page.locator('[data-testid="diagnostic-open"]');
    if (await openRow.count()) {
        await openRow.first().click();
        await page.waitForTimeout(1500);
        const wentTo = await page.locator('header button[role="tab"][aria-selected="true"]')
            .first().innerText();
        check('a diagnostics row opens the node on the canvas', /lineage/i.test(wentTo), wentTo);
        await page.locator('[data-testid="panel-back"]').click();
        await page.waitForTimeout(1200);
        const backOn = await page.locator('header button[role="tab"][aria-selected="true"]')
            .first().innerText();
        check('and Back returns to the diagnostics it came from',
            /diagnostics/i.test(backOn) &&
            (await page.locator('[data-testid="focus-chip"]').count()) === 0,
            backOn);
    } else {
        check('a diagnostics row opens the node on the canvas', true, 'no linkable row here');
        check('and Back returns to the diagnostics it came from', true, 'skipped');
    }

    // Tests are a property of a model, so they get a mark on the card rather
    // than nodes of their own. Both states must be legible.
    await page.locator('nav button', { hasText: /Lineage/ }).first().click();
    await page.waitForTimeout(900);
    const badges = await page.evaluate(() => {
        const all = [...document.querySelectorAll('.test-badge')];
        return {
            total: all.length,
            tested: all.filter(e => e.dataset.tested === 'yes').length,
            onPbi: [...document.querySelectorAll('.node-card')]
                .filter(c => /PBI table|report page|visual ·/.test(c.innerText))
                .filter(c => c.querySelector('.test-badge')).length,
        };
    });
    check('dbt cards carry a test count', badges.total > 0 && badges.tested > 0,
        `${badges.tested} of ${badges.total} tested`);
    check('Power BI cards do not', badges.onPbi === 0, `${badges.onPbi} pbi cards badged`);

    /*
     * A field parameter, from the search box to the panel.
     *
     * The whole point is that none of this is in the report file: the visual
     * names one field, and the parameter's other rows are reachable only by a
     * reader moving a slicer. So the checks are about what the tool *adds* — the
     * list of what can be swapped in, the label a reader can search for, and the
     * fact that the table is not an ordinary table of data.
     */
    await page.locator('header button[role="tab"]', { hasText: 'Lineage' }).click();
    await page.waitForTimeout(700);
    await page.keyboard.press('Control+k');
    const clearForParam = page.locator('[data-testid="search-palette"] button', { hasText: /^clear$/ });
    if (await clearForParam.count()) await clearForParam.click();
    // The caption, not the field: a label authored in the model, which the
    // measure behind it has never been called.
    await page.locator('[data-testid="palette-input"]').fill('Total Sales');
    await page.waitForTimeout(500);
    const captionHit = page.locator('[data-testid="palette-result"]')
        .filter({ has: page.locator('[data-testid="palette-aka"]') });
    check('the palette finds a field by the label its parameter gives it',
        (await captionHit.count()) === 1,
        (await page.locator('[data-testid="palette-result"]').allInnerTexts()).join(' / '));
    check('and the row still names the measure a change would break',
        (await captionHit.first().innerText()).includes('Total Revenue'),
        (await captionHit.first().innerText()).replace(/\n/g, ' '));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    await page.keyboard.press('Control+k');
    const clearForTable = page.locator('[data-testid="search-palette"] button', { hasText: /^clear$/ });
    if (await clearForTable.count()) await clearForTable.click();
    await page.locator('[data-testid="palette-input"]').fill('Metric Chooser');
    await page.waitForTimeout(500);
    await page.locator('[data-testid="palette-result"]').first().click();
    await page.waitForTimeout(1500);
    // A table opens on Overview; the list sits beside the expression that states
    // it, one tab across.
    await page.locator('[data-testid="side-panel"] [role="tab"]', { hasText: 'Definition' }).click();
    await page.waitForTimeout(600);

    const swaps = await page.locator('[data-testid="swaps-row"]').allInnerTexts();
    check('the panel lists every field the parameter can swap in',
        swaps.length === 4, swaps.map(r => r.replace(/\n/g, ' ')).join(' / '));
    check('each row names the label and the field behind it',
        swaps.join(' ').includes('Total Sales') && swaps.join(' ').includes('Sales[UnitPrice]'),
        swaps.map(r => r.replace(/\n/g, ' ')).join(' / '));
    /* A row pointing at a field the model no longer has breaks the visual for
       whoever picks it, and warns nobody at open time — so it is kept and
       marked rather than quietly dropped from the list. */
    check('a row pointing at nothing is shown as such, not dropped',
        swaps.some(r => /not found/.test(r)),
        swaps.map(r => r.replace(/\n/g, ' ')).join(' / '));
    check('the table is marked as a parameter, not left looking like data',
        /field parameter/i.test(await page.locator('[data-testid="side-panel"]').innerText()));

    /*
     * And it is downstream of the fields it offers, reachable from the card.
     *
     * Drawn with no upstream at all, a parameter read as a table out of nowhere —
     * the opposite of the truth, since renaming any field it names breaks a row.
     * The hop menu is checked as well as the edge: a table downstream of a table
     * had no row in that menu, so the link existed with no way to reveal it.
     */
    const paramCard = page.locator('.node-card', { hasText: 'Metric Chooser' }).first();
    check('a parameter card offers the fields it comes from',
        (await paramCard.locator('.hop-btn, [data-testid="hop-menu-button"]').count()) > 0
        || (await paramCard.locator('button[title*="pstream" i]').count()) > 0,
        'no upstream control on the card');

    await page.keyboard.press('Control+k');
    const clearForHop = page.locator('[data-testid="search-palette"] button', { hasText: /^clear$/ });
    if (await clearForHop.count()) await clearForHop.click();
    await page.locator('[data-testid="palette-input"]').fill('Sales');
    await page.waitForTimeout(500);
    await page.locator('[data-testid="palette-result"]').first().click();
    await page.waitForTimeout(1500);
    const tableCard = page.locator('.node-card', { hasText: 'Sales' }).first();
    const hopBtn = tableCard.locator('[data-testid="hop-menu-button"]');
    if (await hopBtn.count()) {
        await hopBtn.first().click();
        await page.waitForTimeout(500);
        const menu = await page.locator('[data-testid="hop-menu"]').innerText();
        check('the downstream menu can name a table, not only pages and measures',
            /tables/i.test(menu), menu.replace(/\n/g, ' · '));
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
    } else {
        check('the downstream menu can name a table, not only pages and measures',
            false, 'no hop menu on the table card');
    }

    /*
     * Escape is the rail's Reset on a key: back to the state the report opened
     * in.
     *
     * Checked from the layout tab in particular, because it is the tab that
     * needed it. Its rail is the page list rather than the one holding Reset, so
     * a visual selected here had no control on screen that would release it —
     * and "Reset layout" is not that control, since it restores dragged
     * positions and leaves the selection alone by design.
     *
     * Last in the file on purpose: this key puts the whole view back to the state
     * the report opened in, so anything asserted after it would be reading a
     * canvas that had just been emptied underneath it.
     */
    await page.locator('header button[role="tab"]', { hasText: 'Page layout' }).click();
    await page.waitForTimeout(900);
    await page.locator('[data-testid="layout-visual"]').first().click();
    await page.waitForTimeout(800);
    const markedBoxes = () => page.locator(
        '[data-testid="layout-visual"][data-selected], [data-testid="layout-visual"][data-lit]').count();
    const markedBefore = await markedBoxes();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    const markedAfter = await markedBoxes();
    // Naming the survivors, not counting them: "1 left" sends the next reader
    // hunting, and which box it is says immediately whether a selection or a
    // stale trace is the thing that would not let go.
    const survivors = await page.$$eval('[data-testid="layout-visual"]', els => els
        .map(e => ({ n: (e.getAttribute('title') || '').split(' · ')[0],
                     lit: e.getAttribute('data-lit'), sel: e.getAttribute('data-selected') }))
        .filter(r => r.lit || r.sel));
    check('Escape clears the selection the layout tab cannot otherwise release',
        markedBefore > 0 && markedAfter === 0 && (await visiblePanels()) === 0,
        `${markedBefore} marked before, ${markedAfter} after${
            survivors.length ? ` — left: ${JSON.stringify(survivors)}` : ''}`);

    /*
     * But a find box owns its own Escape. Someone clearing a filter they just
     * typed is not asking for the canvas to change underneath them, so the key
     * is only the canvas's when the caret is not in a field.
     */
    await page.locator('header button[role="tab"]', { hasText: 'Lineage' }).click();
    await page.waitForTimeout(600);
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(400);
    const clearForEsc = page.locator('[data-testid="search-palette"] button', { hasText: /^clear$/ });
    if (await clearForEsc.count()) await clearForEsc.click();
    await page.locator('[data-testid="palette-input"]').fill('customer');
    await page.waitForTimeout(500);
    await page.locator('[data-testid="palette-result"]').first().click();
    await page.waitForTimeout(1400);
    const railFilter = page.locator('aside input[placeholder^="Filter"]').first();
    await railFilter.fill('cust');
    await railFilter.press('Escape');
    await page.waitForTimeout(600);
    check('Escape typed into a filter box is left to the box',
        (await visiblePanels()) === 1);
    // And with the caret out of the field, the same key resets the view.
    await page.locator('header').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(900);
    /*
     * A reset, not a clear: the canvas is back to the question it opens on, the
     * rail's filter box is empty, and the panel is gone. Asserting the empty
     * state rather than a card count is the point — "0 cards" would also pass on
     * a canvas that had merely been filtered down to nothing.
     */
    const railBox = page.locator('aside input[placeholder^="Filter"]').first();
    check('Escape outside a filter box resets to the state the report opened in',
        (await visiblePanels()) === 0
        && (await page.locator('[data-testid="show-everything"]').count()) === 1
        && (await railBox.inputValue()) === '',
        `panel ${await visiblePanels()}, filter "${await railBox.inputValue()}"`);

    check('no runtime errors', errors.length === 0, errors[0]?.slice(0, 160) || '');

    await page.screenshot({ path: path.join(ROOT, '.work', 'browser-test.png') });
    await browser.close();

    console.log(`\n${failures === 0 ? 'All browser checks passed.' : `${failures} check(s) failed.`}`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
    console.error('Browser test failed:', err.message);
    process.exit(1);
});
