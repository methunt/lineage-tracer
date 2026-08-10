import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import devCommonjs from 'vite-plugin-commonjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Dev server only: the viewer normally has its data injected at export time, so
// `vite dev` would otherwise render an empty app. Read a graph dumped by
// `npm run dev:data` and inject it the same way an export does.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV_DATA = path.resolve(HERE, 'dev-data.json');
const BRIDGE = path.resolve(HERE, '..');
const SAMPLES = path.resolve(HERE, '../../samples');

/**
 * The sample project, served at `sample/` on the hosted app.
 *
 * The demo the landing page's "Try with sample data" button loads is the same
 * tree the CLI's own docs point at (`samples/`), shipped verbatim rather than
 * copied into ui/ — one sample project, not two that drift. It cannot live in
 * ui/public/ for the same reason: public/ is inside the UI package and the
 * sample belongs to the tool.
 *
 * `index.json` is emitted alongside it so the client never carries a hardcoded
 * file list; adding a table to the sample model is a change in one place.
 */
function sampleData() {
    const list = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true })
        .flatMap(entry => {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            return entry.isDirectory()
                ? list(path.join(dir, entry.name), rel)
                : [rel];
        })
        .sort();

    return {
        name: 'lineage-sample-data',
        // Dev serves the files off disk; a build copies them into dist-web.
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = (req.url || '').split('?')[0];
                if (!url.startsWith('/sample/')) return next();
                const rel = decodeURIComponent(url.slice('/sample/'.length));
                if (rel === 'index.json') {
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify(list(SAMPLES)));
                    return undefined;
                }
                // Resolved and then checked: a `..` in the URL must not be able
                // to serve the rest of the repository off the dev server.
                const file = path.resolve(SAMPLES, rel);
                if (!file.startsWith(SAMPLES + path.sep) || !fs.existsSync(file)) return next();
                res.setHeader('Content-Type', 'application/octet-stream');
                res.end(fs.readFileSync(file));
                return undefined;
            });
        },
        generateBundle() {
            const files = list(SAMPLES);
            this.emitFile({
                type: 'asset',
                fileName: 'sample/index.json',
                source: JSON.stringify(files),
            });
            for (const rel of files) {
                this.emitFile({
                    type: 'asset',
                    fileName: `sample/${rel}`,
                    source: fs.readFileSync(path.join(SAMPLES, rel)),
                });
            }
        },
    };
}

function devData() {
    return {
        name: 'lineage-dev-data',
        apply: 'serve',
        transformIndexHtml: {
            order: 'pre',
            handler(html) {
                if (!fs.existsSync(DEV_DATA)) {
                    console.warn(
                        '[lineage] ui/dev-data.json not found — the app will render empty. ' +
                        'Generate it with:  npm run dev:data -- --manifest <f> --catalog <f> --pbip <dir>'
                    );
                    return html;
                }
                const json = fs.readFileSync(DEV_DATA, 'utf8');
                return html.replace('<head>', `<head><script>window.__LINEAGE__=${json};</script>`);
            },
        },
        configureServer(server) {
            // Editing the graph re-renders the page, same as editing a component.
            server.watcher.add(DEV_DATA);
            server.watcher.on('change', file => {
                if (path.resolve(file) === DEV_DATA) {
                    server.ws.send({ type: 'full-reload' });
                }
            });
        },
    };
}

/*
 * The hosted app's Content-Security-Policy, injected at build time.
 *
 * The promise the landing page makes — your files never leave this tab — is
 * copy until the browser is the one enforcing it. `default-src 'none'` plus an
 * explicit `connect-src` is that enforcement: a compromised dependency that
 * tried to POST someone's manifest anywhere would be stopped by the browser
 * rather than noticed afterwards.
 *
 * KNOWN GAP, and it is not a small one. A Worker loaded from a network URL does
 * not inherit the document's CSP — only blob: and data: workers do — and a meta
 * tag cannot reach it because there is no response header to attach a policy
 * to. So dbt-worker.js runs entirely ungoverned: verified in a real browser,
 * where a fetch to an unrelated origin from inside the worker succeeds while
 * the identical fetch on the main thread is blocked. That worker is where the
 * manifest and catalog text actually go, so the strongest claim this policy
 * can honestly make is that the *document* cannot exfiltrate them.
 *
 * Closing it needs one of two things this config cannot do: response headers
 * (impossible on GitHub Pages) or constructing the worker from a blob: URL,
 * which does inherit — a source change, and one that would need
 * 'wasm-unsafe-eval' added back below.
 *
 * GitHub Pages cannot set response headers, which is also why `frame-ancestors`
 * is absent, and it stays absent deliberately. Checked in Chromium rather than
 * assumed: a meta-delivered `frame-ancestors` is not merely ignored, it logs
 *
 *   The Content Security Policy directive 'frame-ancestors' is ignored when
 *   delivered via a <meta> element.
 *
 * as a console *error* — which test/web.js counts, and rightly fails on. So
 * adding it would cost a red test to buy exactly no protection. Clickjacking
 * defence on this app needs `X-Frame-Options`/`frame-ancestors` as a response
 * header, and a static host that cannot set headers cannot have it. Recorded as
 * an open finding in SECURITY.md instead of papered over here.
 *
 * Build only, deliberately. Vite's dev server injects an inline HMR preamble
 * and opens a websocket to itself, so a policy loose enough for dev would have
 * to allow 'unsafe-inline' scripts and a ws: origin — and shipping that to
 * production to keep one meta tag in the source file is the wrong trade. The
 * deployed artifact is what needs the policy; the dev server is not deployed.
 */
const CSP = [
    // Nothing is allowed unless a directive below says so.
    "default-src 'none'",
    /*
     * Our own bundle, plus the one third-party origin the app executes code
     * from: the Pyodide runtime, imported from jsDelivr by dbt-worker.js and
     * pinned to a path prefix so the rest of jsDelivr stays untrusted.
     *
     * The prefix earns its place even though the import happens in the
     * ungoverned worker: it names the single trusted third party in the shipped
     * artifact, and it is already correct if that import ever moves here.
     *
     * No 'wasm-unsafe-eval', and no 'unsafe-eval' either. Both were tested
     * rather than assumed: every line of wasm this app compiles is Pyodide's,
     * inside the worker, which this policy does not govern — so granting the
     * main thread the right to compile wasm buys nothing. The end-to-end
     * browser test passes without it.
     */
    "script-src 'self' https://cdn.jsdelivr.net/pyodide/",
    // The module worker and the service worker are both our own files. Not
    // redundant with script-src: worker-src falls back to script-src, so
    // without this line the jsDelivr prefix above would also be a permitted
    // source of workers.
    "worker-src 'self'",
    /*
     * The privacy claim lives in this line, for everything on the main thread.
     * `'self'` is the vendored sqlglot wheel and the extractor sources; the
     * jsDelivr prefix is Pyodide fetching its own wasm and stdlib zip. There is
     * no endpoint here anything could be uploaded to, and no other origin is
     * reachable from the document.
     */
    "connect-src 'self' https://cdn.jsdelivr.net/pyodide/",
    // Vite emits the Tailwind output as a real stylesheet file, so <style>
    // elements are not needed and injected ones stay blocked.
    "style-src 'self'",
    /*
     * Style *attributes* are the other half, and they are unavoidable: React
     * Flow positions its viewport and every node with an inline transform, and
     * attributes have no nonce mechanism. Split out from style-src so allowing
     * them does not also re-open injected <style> blocks, which is the half
     * that actually carries risk.
     *
     * Worth knowing if this is ever tightened: a blocked style attribute is
     * silent in Chrome — no console error — so test/web.js cannot catch its
     * absence. It would show up only as a visibly broken canvas.
     */
    "style-src-attr 'unsafe-inline'",
    // data: is the inline SVG favicon in web.html.
    "img-src 'self' data:",
    // The two woff2 faces, emitted as hashed same-origin assets.
    "font-src 'self'",
    // Against injection that rewrites where relative URLs resolve, or points a
    // form somewhere off-origin. The app has no forms at all.
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');

/*
 * The exported viewer's policy, which is a different problem to the app's.
 *
 * An export is one HTML file on someone's desk, opened from file://, with the
 * bundle and the stylesheet inlined into it and the graph injected as a second
 * inline <script>. So 'unsafe-inline' is not a weakness that crept in — it is
 * the entire delivery mechanism, and a policy that forbade it would produce a
 * file that downloads and does not open. There is no nonce to use either: the
 * export is assembled by string injection at click time, not served by anything
 * that could mint one per response.
 *
 * Which means this policy is not trying to be an XSS boundary; the escaping in
 * src/web/export-viewer.js is what does that job, with a test behind it. What
 * this policy is for is `connect-src 'none'`.
 *
 * That line is worth having on its own. An export contains somebody's warehouse
 * schema — table names, column names, the shape of their model — and it is the
 * artifact most likely to be mailed around, opened on a machine nobody vetted,
 * or kept for a year after everyone forgot what was in it. `connect-src 'none'`
 * makes "this file never phones home" something the browser enforces rather
 * than something the README asserts: no fetch, no XHR, no WebSocket, no beacon,
 * from a document that has no legitimate reason to make a single request.
 * `form-action` and `base-uri` close the two ways to leave without one.
 */
const VIEWER_CSP = [
    "default-src 'none'",
    // The inlined IIFE bundle and the injected graph. Both are the file itself.
    "script-src 'unsafe-inline'",
    // The stylesheet is inlined as a <style> block; React Flow positions nodes
    // with style attributes, which fall back to this directive.
    "style-src 'unsafe-inline'",
    // assetsInlineLimit is effectively infinite in this build, so the favicon
    // and the two woff2 faces are all data: URIs by the time they ship.
    "img-src data:",
    "font-src data:",
    // The point of the exercise: a self-contained file has nowhere to call, so
    // it is allowed to call nowhere.
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');

/** Inject a policy into the built HTML. Build only — see the note above. */
function csp(policy = CSP) {
    return {
        name: 'lineage-csp',
        apply: 'build',
        transformIndexHtml: {
            order: 'post',
            handler: html => html.replace(
                '<head>',
                `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
            ),
        },
    };
}

/*
 * Two targets out of one app, and one of them is an asset of the other.
 *
 * `--mode web` builds the hosted upload page: the product, chunked ESM, served
 * from a static host. The default mode builds the *viewer* — the same
 * components collapsed into one self-contained HTML file with no data in it.
 * Nobody visits the viewer; it is a template. `npm run build:web` builds it
 * first, stages it at ui/public/viewer.html (scripts/stage-viewer.mjs), and the
 * web build then copies it into dist-web like any other public asset. The app's
 * Export button fetches it on click and injects the current graph
 * (src/web/export-viewer.js).
 *
 * That indirection is the whole reason this mode still exists. An export cannot
 * be assembled out of the running page: the hosted build is chunked ESM with
 * hashed lazy chunks, and module scripts are exactly what browsers refuse to
 * run from a `file://` origin. The single-file build already solves that, so it
 * is kept and repurposed rather than reinvented at runtime.
 */
export default defineConfig(({ mode }) => (mode === 'web' ? webApp() : viewer()));

// One self-contained HTML: no runtime fetch, no sidecar assets.
//
// Output is a classic IIFE, not an ES module, deliberately: an exported file is
// opened straight off disk, and module scripts are the thing browsers get fussy
// about on file:// origins. It also keeps the viewer testable in jsdom.
function viewer() {
    return {
        plugins: [
            react(),
            // `optimize: false`, and it has to stay false. Tailwind 4 runs the
            // bundle through Lightning CSS on a fixed target list, and on that
            // list Lightning deletes every `backdrop-filter` declaration in the
            // stylesheet outright — the canvas dock's blur and the landing
            // page's scrim both shipped as plain translucent panels for as long
            // as this has been built, while looking correct in `vite dev`.
            // Vite still minifies the CSS with esbuild, which does not rewrite
            // properties it has opinions about.
            tailwind({ optimize: false }),
            devData(),
            viteSingleFile({ useRecommendedBuildConfig: false, removeViteModuleLoader: true }),
            // singlefile still emits type="module"; the bundle is an IIFE, so drop it.
            {
                name: 'classic-script-tag',
                // Build only: in dev the entry really is an ES module and must stay one.
                apply: 'build',
                enforce: 'post',
                transformIndexHtml: {
                    order: 'post',
                    handler: html => html.replace(/<script type="module"/g, '<script'),
                },
            },
            // Last, so the meta lands in the HTML singlefile has finished
            // assembling rather than in the shell it started from.
            csp(VIEWER_CSP),
        ],
        build: {
            outDir: 'dist',
            emptyOutDir: true,
            target: 'es2019',
            cssCodeSplit: false,
            assetsInlineLimit: 100000000,
            chunkSizeWarningLimit: 4000,
            rollupOptions: {
                output: { format: 'iife', inlineDynamicImports: true, entryFileNames: 'app.js' },
            },
        },
    };
}

/*
 * The hosted app: ordinary chunked ESM, served from a static host.
 *
 * Everything the viewer build does to collapse itself into one file is wrong
 * here. The Pyodide runtime and ExcelJS are megabytes that most visits never
 * need on the first paint, and the whole point of a hosted build is that they
 * arrive as separate, cacheable requests — so no singlefile, no inlining, and
 * no IIFE, because a module worker needs real modules to import.
 *
 * `base: './'` so the build works from a project subpath on GitHub Pages
 * without the repository name being compiled in.
 */
function webApp() {
    return {
        base: './',
        plugins: [
            react(),
            // `optimize: false`, and it has to stay false. Tailwind 4 runs the
            // bundle through Lightning CSS on a fixed target list, and on that
            // list Lightning deletes every `backdrop-filter` declaration in the
            // stylesheet outright — the canvas dock's blur and the landing
            // page's scrim both shipped as plain translucent panels for as long
            // as this has been built, while looking correct in `vite dev`.
            // Vite still minifies the CSS with esbuild, which does not rewrite
            // properties it has opinions about.
            tailwind({ optimize: false }),
            /*
             * The bridge's parsers are CommonJS and live outside ui/.
             *
             * They are shared verbatim with the CLI, which is the point — a
             * second ESM copy of the Power Query and DAX parsers is a second
             * thing to keep correct. So the bundler converts them instead, and
             * the two halves of the build need different tools to do it.
             *
             * Builds go through Vite's own commonjs pass (build.commonjsOptions
             * below). Dev cannot: `@rollup/plugin-commonjs` is a build-time
             * plugin that reaches for a Rollup module graph the dev server does
             * not have, and asking it to serve a module fails inside the plugin
             * with `Cannot read properties of undefined (reading '_container')`.
             * This one is scoped to `serve` so the two never meet: without
             * `apply`, it runs in builds as well, and two commonjs transformers
             * claiming the same modules is what broke the ExcelJS build before.
             */
            {
                ...devCommonjs({ filter: id => id.includes('bridge') && id.includes('/src/') }),
                apply: 'serve',
            },
            csp(),
            // Hosted app only: the exported viewer ships a real graph and has
            // no landing page, so it has nothing to offer a sample to.
            sampleData(),
            /*
             * The entry is `web.html` in source and `index.html` on the host.
             *
             * Two entry files cannot both be called index.html in one project,
             * and a static host serves index.html at a directory URL — so the
             * name has to change somewhere. Renaming the emitted asset is the
             * cheapest place: the source keeps a name that says which target it
             * belongs to, and the deployed site keeps the only name a bare URL
             * will find.
             */
            /*
             * `/` is the web app while this mode is running.
             *
             * ui/ holds two entry files and the dev server hands out
             * index.html — the viewer's — for a bare URL. In `--mode web` that
             * means opening the address Vite prints and getting the other
             * target: an app with no graph, no upload page, and no clue that
             * you are looking at the wrong one.
             */
            {
                name: 'web-entry-at-root',
                apply: 'serve',
                configureServer(server) {
                    server.middlewares.use((req, _res, next) => {
                        if (req.url === '/') req.url = '/web.html';
                        next();
                    });
                },
            },
            {
                name: 'web-entry-as-index',
                apply: 'build',
                enforce: 'post',
                generateBundle(_options, bundle) {
                    const entry = bundle['web.html'];
                    if (!entry) return;
                    delete bundle['web.html'];
                    entry.fileName = 'index.html';
                    bundle['index.html'] = entry;
                },
            },
        ],
        resolve: {
            alias: {
                /*
                 * pbip-extract.js and mapping.js reach for `fs` and `path` from
                 * inside their read-from-disk entry points, which the browser
                 * build never calls — but a bare `require('fs')` still has to
                 * resolve or the build fails on a code path nobody runs.
                 *
                 * `exceljs` is deliberately absent from this list: it genuinely
                 * runs in the browser and is loaded on demand by the build hook.
                 */
                fs: path.resolve(HERE, 'src/web/node-stub.js'),
                path: path.resolve(HERE, 'src/web/node-stub.js'),
            },
        },
        server: {
            // The dev server's root is ui/; the bridge sources it has to serve
            // are its sibling, and Vite refuses to serve outside the root
            // without being told which parent is intentional.
            fs: { allow: [BRIDGE] },
        },
        build: {
            outDir: 'dist-web',
            emptyOutDir: true,
            target: 'es2020',
            chunkSizeWarningLimit: 4000,
            // Vite's own commonjs pass only looks inside node_modules; the
            // bridge sources are a sibling of ui/ and have to be named.
            commonjsOptions: { include: [/node_modules/, /bridge[\\/]src[\\/]/] },
            rollupOptions: { input: path.resolve(HERE, 'web.html') },
        },
    };
}
