/**
 * Getting a folder off the desktop and into memory.
 *
 * Two routes, because neither covers everyone. `<input webkitdirectory>` is the
 * one that works everywhere — despite the vendor prefix, every current browser
 * implements it — and drag-and-drop uses the DataTransfer entry API, which is
 * the only way a dropped *folder* can be walked at all. The File System Access
 * API is deliberately not used: it is Chromium-only, and read-only access is
 * all this tool ever wants.
 */

/**
 * Only these are read.
 *
 * A .Report folder carries images, and a semantic model can carry a cached
 * .abf; decoding those as UTF-8 would cost a copy of every byte to produce
 * something no parser looks at. The extractor reads TMDL and JSON, so that is
 * what gets loaded.
 */
const WANTED = /\.(tmdl|json)$/i;

export const isWanted = path => WANTED.test(path);

/**
 * Read a `<input webkitdirectory>` selection into `{ rootName, files }`.
 *
 * `webkitRelativePath` is always `<selectedFolder>/…`, so the first segment is
 * the folder the user actually picked — which is the name the extractor needs
 * to recognise someone who pointed at a .SemanticModel directly.
 */
export async function readDirectoryInput(fileList) {
    const all = [...fileList];
    if (!all.length) return { rootName: '', files: {} };

    const rootName = (all[0].webkitRelativePath || all[0].name).split('/')[0];
    const files = {};
    await Promise.all(all.map(async file => {
        const full = file.webkitRelativePath || file.name;
        // Relative to the picked folder, not including it.
        const rel = full.startsWith(`${rootName}/`) ? full.slice(rootName.length + 1) : full;
        if (!isWanted(rel)) return;
        files[rel] = await file.text();
    }));
    return { rootName, files };
}

/**
 * Read a dropped folder into the same shape.
 *
 * The entries have to be claimed synchronously — a DataTransferItemList is
 * emptied as soon as the drop handler yields — so the caller passes
 * `event.dataTransfer.items` straight through and the awaiting starts after.
 */
export async function readDroppedEntries(items) {
    const entries = [...items]
        .map(item => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
        .filter(Boolean);

    const dir = entries.find(e => e.isDirectory);
    if (!dir) return null;

    const files = {};
    // Paths are relative to the dropped folder, so its own name is not in them.
    await walkChildren(dir, '', files);
    return { rootName: dir.name, files };
}

async function walkChildren(dirEntry, prefix, files) {
    // readEntries returns at most 100 per call and signals the end with an
    // empty batch — a single call silently truncates a large report.
    const reader = dirEntry.createReader();
    for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) {
            const rel = prefix ? `${prefix}/${child.name}` : child.name;
            if (child.isDirectory) await walkChildren(child, rel, files);
            else if (isWanted(rel)) {
                const file = await new Promise((res, rej) => child.file(res, rej));
                files[rel] = await file.text();
            }
        }
    }
}

/** Human file size, for the slot that just accepted one. */
export function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
