/**
 * The one job this service worker has: make the second visit instant.
 *
 * A first visit pulls roughly 7 MB before any lineage can be resolved — the
 * Pyodide wasm runtime and the Python stdlib from jsDelivr, plus the sqlglot
 * wheel and the extractor sources we ship ourselves. None of that changes
 * between visits: the runtime is pinned to an exact version and the wheel is
 * vendored, so re-downloading it is pure waste. Cached, the second visit costs
 * nothing and Python is ready before the user has picked their files.
 *
 * What it deliberately does NOT do is cache the app. GitHub Pages deploys on
 * every push to main, and a service worker that serves a stale shell turns a
 * fixed bug into a bug the user cannot get rid of. HTML, JS and CSS are left
 * entirely alone — the browser's own HTTP cache already handles them, and it
 * respects the hashes Vite puts in the filenames. Only the two immutable,
 * expensive things are held here.
 *
 * There is no offline story and none is intended. This is a cache, not an
 * install.
 */

// Bump this to abandon everything cached under the old name. That is the whole
// invalidation strategy, and it is enough precisely because the cached URLs are
// version-pinned already — the only reason to bump is if this file's own logic
// changes.
const VERSION = 'v2';
const CACHE = `lineage-runtime-${VERSION}`;

// The Pyodide CDN, pinned in dbt-worker.js.
//
// Origin and pathname are checked separately, never as a string prefix on the
// full href: `href.startsWith('https://cdn.jsdelivr.net/pyodide/')` is a
// substring test on a value an attacker partly controls, and a single loosened
// character in the constant would silently start matching lookalike hosts such
// as `cdn.jsdelivr.net.evil.example`. `URL.origin` is parsed by the browser and
// cannot be spoofed that way.
//
// The path below the version prefix is still matched loosely, on purpose:
// Pyodide fetches its own pieces (pyodide.asm.mjs, the wasm, the stdlib zip) on
// its own schedule, and enumerating them here would mean this file needing an
// edit every time the runtime rearranges its internals.
const PYODIDE_ORIGIN = 'https://cdn.jsdelivr.net';
const PYODIDE_PATH = '/pyodide/';

const isPyodideAsset = url =>
    url.origin === PYODIDE_ORIGIN && url.pathname.startsWith(PYODIDE_PATH);

/*
 * Our own heavy assets: the vendored sqlglot wheel and the packed extractor
 * sources, both emitted into a `py/` directory beside the app.
 *
 * Matched on the final path segment rather than on `pathname.includes('/py/')`.
 * A substring test anywhere in the path would also accept `/py/../something`
 * before normalisation quirks, or any future same-origin route that happens to
 * contain those three characters — and an entry written into this cache is
 * served ahead of the network on every later visit until VERSION changes, so
 * the set of URLs that can get in wants to be the smallest one that works.
 *
 * The base is deliberately not pinned: GitHub Pages serves the app from a
 * repository subpath, so only the tail of the path is knowable here.
 */
const OWN_PYTHON_ASSET = /(^|\/)py\/(python-sources\.json|sqlglot-[0-9][0-9A-Za-z.]*-py3-none-any\.whl)$/;

const isOwnPythonAsset = url =>
    url.origin === self.location.origin && OWN_PYTHON_ASSET.test(url.pathname);

const shouldCache = url => isPyodideAsset(url) || isOwnPythonAsset(url);

// No waiting for every tab to close. The worker being replaced only ever served
// runtime bytes, so there is nothing in flight that a newer version could break.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        // Anything from a previous VERSION is dead weight in the user's storage
        // quota, and quota pressure is what makes cache writes start failing.
        const names = await caches.keys();
        await Promise.all(
            names
                .filter(name => name.startsWith('lineage-runtime-') && name !== CACHE)
                .map(name => caches.delete(name)),
        );
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const request = event.request;

    // GET only. A cache keyed by URL cannot meaningfully answer anything else,
    // and there is nothing else here to answer.
    if (request.method !== 'GET') return;

    let url;
    try {
        url = new URL(request.url);
    } catch {
        return;
    }
    if (!shouldCache(url)) return;

    event.respondWith(serve(request));
});

/**
 * Cache first, unconditionally.
 *
 * No revalidation, no staleness check: every URL that reaches here is
 * immutable by construction — a pinned Pyodide version, or a wheel whose
 * version is in its own filename. If either changes, the URL changes with it,
 * and the old entry simply stops being asked for.
 */
async function serve(request) {
    const cached = await caches.match(request, { cacheName: CACHE });
    if (cached) return cached;

    const response = await fetch(request);

    // jsDelivr sends CORS headers, so its responses come back as `type: 'cors'`
    // with a real status we can trust. An opaque response (`type: 'opaque'`,
    // status 0) would be a redirect somewhere we did not expect, and caching a
    // body we cannot inspect means potentially pinning an error page forever.
    // Same for anything that is not a plain 200 — a 404 cached is a 404 for
    // good.
    if (response.status === 200 && (response.type === 'basic' || response.type === 'cors')) {
        // Deliberately not awaited: the user gets their bytes now, and the copy
        // lands whenever it lands.
        storeQuietly(request, response.clone());
    }

    return response;
}

/**
 * Write to the cache, and shrug if it fails.
 *
 * Private browsing, a full disk, or a storage policy that forbids us can all
 * make this throw. Every one of those should cost the user a slow second visit
 * and nothing more — a broken app would be a far worse trade than a repeated
 * download.
 */
async function storeQuietly(request, response) {
    try {
        const cache = await caches.open(CACHE);
        await cache.put(request, response);
    } catch {
        /* No cache today. The app works exactly as it did on the first visit. */
    }
}
