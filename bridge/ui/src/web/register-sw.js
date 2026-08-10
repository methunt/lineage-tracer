/**
 * Opt in to the runtime cache in `public/sw.js`.
 *
 * Separated from the app because registration is entirely best-effort: if it
 * fails, or the browser has no service workers, or the page is being served
 * from a non-secure origin, the app is unaffected — the user just pays the ~7 MB
 * runtime download again on their next visit. Nothing here is worth a console
 * error, let alone a thrown one.
 */
export function registerServiceWorker() {
    // `isSecureContext` covers the case that actually bites in practice: opening
    // the built app over plain http on a LAN address, where the API exists but
    // registration always rejects.
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    if (!self.isSecureContext) return;

    // Resolved against the document, not the origin, because Pages serves this
    // from a repository subpath — an absolute '/sw.js' would look for it at the
    // domain root and find someone else's site.
    const url = new URL('sw.js', document.baseURI).href;

    navigator.serviceWorker.register(url).catch(() => {
        /* No cache today. Every visit is a first visit, and that is fine. */
    });
}
