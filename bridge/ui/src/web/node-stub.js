/*
 * A stand-in for Node's `fs` and `path` in the web build.
 *
 * The bridge modules are shared with the CLI, and two of them (pbip-extract.js,
 * mapping.js) lazily `require('fs')` / `require('path')` inside functions that
 * only the CLI ever calls — reading a project off disk, resolving a workbook
 * path. The browser build reaches none of those paths, but the bundler still has
 * to resolve the require, so it resolves to this.
 *
 * Deliberately empty rather than throwing: a throwing stub would fail at import
 * time, which is exactly when nothing has gone wrong yet. If a Node-only branch
 * is ever reached from the browser it will fail on the missing method instead,
 * at the call that actually made the mistake.
 */
export default {};
