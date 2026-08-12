/**
 * Load an exported file in jsdom and assert it actually rendered.
 *
 * An export is a single HTML file with an inline classic script, so jsdom can
 * execute it end to end. jsdom reports every element as 0x0 and has no
 * ResizeObserver, so both are stubbed — React Flow will not place nodes in a
 * zero-size container.
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const VIEWPORT = { width: 1600, height: 900 };

function renderCheck(htmlPath, { settleMs = 6000 } = {}) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const errors = [];

    class ResizeObserver {
        constructor(cb) { this.cb = cb; }
        observe(el) {
            setTimeout(() => this.cb([{ target: el, contentRect: { ...VIEWPORT, top: 0, left: 0 } }], this), 0);
        }
        unobserve() {}
        disconnect() {}
    }

    class DOMMatrixReadOnly {
        constructor(transform) {
            const m = String(transform || '').match(/matrix\(([^)]+)\)/);
            const p = m ? m[1].split(',').map(Number) : [1, 0, 0, 1, 0, 0];
            [this.a, this.b, this.c, this.d, this.e, this.f] = p;
            this.m22 = this.d;
        }
    }

    const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        beforeParse(win) {
            win.ResizeObserver = ResizeObserver;
            win.DOMMatrixReadOnly = DOMMatrixReadOnly;
            win.DOMMatrix = DOMMatrixReadOnly;
            win.matchMedia = () => ({
                matches: false, addEventListener() {}, removeEventListener() {},
                addListener() {}, removeListener() {},
            });
            win.Element.prototype.getBoundingClientRect = () => ({
                ...VIEWPORT, top: 0, left: 0, right: VIEWPORT.width, bottom: VIEWPORT.height,
                x: 0, y: 0, toJSON() {},
            });
            Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => VIEWPORT.width });
            Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => VIEWPORT.height });
            win.Worker = undefined;   // keep elkjs on its in-process path
            // jsdom does not implement confirm() at all (logs "Not implemented"
            // and returns undefined, i.e. Cancel) — every bulk-action confirm
            // in the app would silently block here otherwise.
            win.confirm = () => true;
            win.TextDecoder = TextDecoder;   // jsdom does not ship one; Node does
            win.addEventListener('error', e => errors.push(String(e.error || e.message)));
            win.addEventListener('unhandledrejection', e => errors.push(`unhandled rejection: ${e.reason?.message || e.reason}`));
            const original = win.console.error;
            win.console.error = (...a) => { errors.push(`console.error: ${a.map(String).join(' ')}`); original(...a); };
        },
    });

    const settle = () => new Promise(r => setTimeout(r, settleMs));

    return (async () => {
        await settle();
        const doc = dom.window.document;
        /*
         * The canvas opens on the question rather than on the whole graph, so
         * there is nothing to assert about nodes until it is answered. Answer
         * it, let the layout settle a second time, then look.
         */
        const showAll = doc.querySelector('[data-testid="show-everything"]');
        const opensBlank = !!showAll && doc.querySelectorAll('.node-card').length === 0;
        if (showAll) showAll.click();
        await settle();

        {
            const text = doc.body.textContent || '';
            const root = doc.getElementById('root');
            const nodeCards = doc.querySelectorAll('.node-card').length;
            const debug = dom.window.__LINEAGE_DEBUG__ || {};

            const checks = [
                ['the canvas opens by asking what to trace', opensBlank],
                ['app mounted', !!root && root.children.length > 0],
                ['header rendered', text.includes('Lineage Tracer')],
                // No metric strip and no filter strip: the canvas starts
                // directly under the header. See ui-spec §18.
                ['canvas is not pushed down by a metric strip', !text.includes('widest blast radius')],
                ['reset lives in the rail footer', !!doc.querySelector('[data-testid="reset-view"]')],
                ['linked-only moved into the rail', !!doc.querySelector('[data-testid="linked-only"]')],
                ['stage tree rendered', text.includes('Power BI')],
                // dbt groups by resource type, the way dbt itself does.
                ['tree groups by resource type',
                    !!doc.querySelector('[data-testid="tree-group-model"]') &&
                    !!doc.querySelector('[data-testid="tree-group-source"]')],
                // Collapsed on open: children exist only once a folder is opened.
                ['tree opens collapsed',
                    !text.includes('Measures') && !text.includes('Visuals')],
                ['every folder offers a chevron',
                    doc.querySelectorAll('[aria-expanded="false"]').length > 0],
                ['depth stepper rendered', !!doc.querySelector('[data-testid="stepper"]')],
                ['navigation has both tabs',
                    doc.querySelectorAll('[data-testid="nav-tabs"] button').length === 2],
                ['layout completed', !text.includes('Laying out'), debug.error || ''],
                ['graph nodes rendered', nodeCards > 0, `${nodeCards} node cards`],
                ['every visible node positioned', debug.visible > 0 && debug.visible === debug.positioned,
                    `${debug.positioned}/${debug.visible}`],
            ];

            dom.window.close();
            return { checks, errors };
        }
    })();
}

module.exports = { renderCheck };

// Also runnable directly:  node test/smoke.js path/to/report.html
if (require.main === module) {
    const target = process.argv[2];
    if (!target) { console.error('usage: node test/smoke.js <report.html>'); process.exit(1); }
    renderCheck(target).then(({ checks, errors }) => {
        let ok = true;
        for (const [name, pass, detail] of checks) {
            console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
            if (!pass) ok = false;
        }
        if (errors.length) { ok = false; console.log('\nERRORS:'); errors.slice(0, 8).forEach(e => console.log(`  ${e.slice(0, 300)}`)); }
        process.exit(ok ? 0 : 1);
    });
}
