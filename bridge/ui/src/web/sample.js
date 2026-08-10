import { isWanted, formatSize } from './files';

/**
 * The demo project, fetched into the same four values a real pick produces.
 *
 * Someone who has not run `dbt compile` yet, or who has a Power BI project but
 * no mapping sheet, cannot see what this tool does at all — four required
 * inputs is a wall in front of the answer to "is this worth my afternoon".
 * This is the way through it: the sample tree that ships with the repo, loaded
 * from `sample/` on the same origin.
 *
 * Deliberately not a separate code path through the build. This returns exactly
 * the shape FileSlot's readers return, so the slots fill in as though the files
 * had been dropped, `Build lineage` runs the one build there has ever been, and
 * nothing downstream — worker, parsers, store — can tell the difference. The
 * one thing it skips is the validation in those readers, which is there to
 * catch a reader's mistake; the sample cannot make one.
 */

/** Paths within `samples/`. The pbip folder is everything else. */
const CATALOG = 'dbt-sqlserver/catalog.json';
const MANIFEST = 'dbt-sqlserver/manifest.json';
const MAPPING = 'mapping-example.csv';

/* The project folder as the reader would have picked it. `samples/` holds the
   two project folders side by side rather than inside a wrapper, so the name is
   supplied rather than read off a path — it is what the summary shows and what
   the extractor falls back to when it names the report. */
const PBIP_ROOT = 'SampleProject';
const PBIP_PREFIX = `${PBIP_ROOT}.`;

/** Same-origin, and relative to the document — the app is served from a subpath
    on GitHub Pages, so an absolute `/sample/…` would miss. */
const url = rel => new URL(`sample/${rel}`, document.baseURI).href;

async function get(rel) {
    const res = await fetch(url(rel));
    if (!res.ok) throw new Error(`Could not load the sample (${rel}: ${res.status}).`);
    return res;
}

const text = async rel => (await get(rel)).text();

export async function loadSampleValues() {
    const index = await (await get('index.json')).json();

    const pbipPaths = index.filter(p => p.startsWith(PBIP_PREFIX) && isWanted(p));
    if (!pbipPaths.length) throw new Error('The sample project folder is missing from this build.');

    const [catalogText, manifestText, mappingText, pbipTexts] = await Promise.all([
        text(CATALOG),
        text(MANIFEST),
        text(MAPPING),
        Promise.all(pbipPaths.map(p => text(p))),
    ]);

    const files = {};
    pbipPaths.forEach((p, i) => { files[p] = pbipTexts[i]; });

    const size = s => formatSize(new Blob([s]).size);

    return {
        catalog: { text: catalogText, summary: `catalog.json · ${size(catalogText)} · sample` },
        manifest: { text: manifestText, summary: `manifest.json · ${size(manifestText)} · sample` },
        mapping: {
            name: MAPPING,
            data: mappingText,
            summary: `${MAPPING} · ${size(mappingText)} · sample`,
        },
        pbip: {
            rootName: PBIP_ROOT,
            files,
            summary: `${PBIP_ROOT} · ${pbipPaths.length} files read · sample`,
        },
    };
}
