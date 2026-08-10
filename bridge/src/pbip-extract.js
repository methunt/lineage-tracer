/**
 * Headless PBIP extractor.
 *
 * The parsers under ./pbip are this project's own, adopted from pbip-documenter
 * under MIT (see pbip/LICENSE). They were vendored until the report needed
 * parser changes — page order, visibility, visual geometry — that a
 * "no other file is changed" promise could not accommodate.
 *
 * Emits the payload shape the merge and the embedded Power BI view both read.
 *
 * Two entry points over one implementation. `extractPbipFromFiles` takes the
 * project as a flat `{ 'Model.SemanticModel/definition/model.tmdl': '<text>' }`
 * map and touches no Node API — it is what the browser calls with the files
 * dropped on the page. `extractPbip` reads a directory into that shape and
 * hands it over, which is what the CLI and the tests call. Everything that
 * decides *anything* lives on the map side, so the two paths cannot drift.
 */
const { inlineCustomSources } = require('./m-inline');
const { TMDLParser, DAXReferenceExtractor } = require('./pbip/tmdl-parser');
const VisualParser = require('./pbip/visual-parser');
const MExpressionParser = require('./pbip/m-parser');
// lineage-engine is required inside extractPbip, not here: in the browser its
// collaborators are globals from separate <script> tags, and it resolves them
// off the global scope. They have to be published before it loads.

// ---------------------------------------------------------------------------
// File map primitives
//
// Keys are project-relative POSIX paths. A directory is not a thing here — it
// exists exactly as far as some file's path mentions it, which is all the
// extractor ever asked of one.
// ---------------------------------------------------------------------------

const join = (...parts) => parts.filter(p => p !== '' && p != null).join('/');

const baseName = p => p.slice(p.lastIndexOf('/') + 1);

const stripExt = (p, ext) => (p.endsWith(ext) ? p.slice(0, -ext.length) : p);

/** Immediate child directory names under `prefix` ('' for the project root). */
function childDirs(files, prefix) {
    const at = prefix ? `${prefix}/` : '';
    const out = new Set();
    for (const p of Object.keys(files)) {
        if (!p.startsWith(at)) continue;
        const rest = p.slice(at.length);
        const slash = rest.indexOf('/');
        if (slash > 0) out.add(rest.slice(0, slash));
    }
    return [...out];
}

/** Every file under `prefix` whose name ends with `ext`, recursively. */
function filesUnder(files, prefix, ext) {
    const at = prefix ? `${prefix}/` : '';
    return Object.keys(files).filter(p => p.startsWith(at) && p.endsWith(ext));
}

/** Does anything at all live under this directory? */
const dirExists = (files, prefix) => Object.keys(files).some(p => p.startsWith(`${prefix}/`));

/**
 * Locate the .SemanticModel and .Report folders inside a PBIP project.
 *
 * @param {object} files      project-relative path -> text
 * @param {string} rootName   the dropped folder's own name, so a user who
 *                            selected the .SemanticModel folder itself still works
 */
function resolveProjectFolders(files, rootName = '') {
    // The root itself may already be a .SemanticModel folder, in which case
    // every path is relative to it and its prefix is the empty string.
    if (rootName.endsWith('.SemanticModel')) {
        return { semanticModel: '', report: null, modelName: stripExt(rootName, '.SemanticModel') };
    }

    let semanticModel = null;
    let report = null;
    for (const entry of childDirs(files, '')) {
        if (entry.endsWith('.SemanticModel')) semanticModel = entry;
        else if (entry.endsWith('.Report')) report = entry;
    }

    if (semanticModel === null) {
        throw new Error(
            `No *.SemanticModel folder found in ${rootName || 'the project'}. ` +
            `Point at the PBIP project root (the folder holding <name>.SemanticModel and <name>.Report).`
        );
    }
    return { semanticModel, report, modelName: stripExt(baseName(semanticModel), '.SemanticModel') };
}

function readTMDLFiles(files, modelRoot) {
    const definitionDir = join(modelRoot, 'definition');
    if (!dirExists(files, definitionDir)) {
        throw new Error(
            `No definition/ folder in ${modelRoot || 'the semantic model'} ` +
            `— is this a TMDL-format semantic model?`);
    }

    const parseInput = {};
    for (const name of ['database', 'model', 'relationships', 'expressions']) {
        const p = join(definitionDir, `${name}.tmdl`);
        if (files[p] != null) parseInput[`${name}.tmdl`] = files[p];
    }

    // tables/ and roles/ may be nested (large models use subfolders), so walk.
    for (const sub of ['tables', 'roles']) {
        for (const file of filesUnder(files, join(definitionDir, sub), '.tmdl')) {
            parseInput[`${sub}/${stripExt(baseName(file), '.tmdl')}.tmdl`] = files[file];
        }
    }
    return parseInput;
}

/** Parse JSON, warning rather than throwing — one bad page is not a bad report. */
function readJson(files, p, warn) {
    if (files[p] == null) return null;
    try {
        return JSON.parse(files[p]);
    } catch (e) {
        warn(`Unreadable ${p}: ${e.message}`);
        return null;
    }
}

/**
 * Report-level page metadata: the author's tab order, and which page opens.
 *
 * Without this, pages arrive in directory order — alphabetical by folder name,
 * which is not the order anyone sees in Power BI and looks plausible enough to
 * go unnoticed.
 */
function readPagesMetadata(files, reportRoot, warn) {
    const pj = readJson(files, join(reportRoot, 'definition', 'pages', 'pages.json'), warn);
    if (!pj) return { order: [], active: null, landing: null };
    return {
        order: pj.pageOrder || [],
        active: pj.activePageName || null,
        landing: pj.landingPageName || null,
    };
}

function readReportPages(files, reportRoot, warn) {
    const pages = [];
    if (!reportRoot) return pages;
    const pagesDir = join(reportRoot, 'definition', 'pages');
    if (!dirExists(files, pagesDir)) return pages;
    const meta = readPagesMetadata(files, reportRoot, warn);

    for (const pageId of childDirs(files, pagesDir)) {
        const pageDir = join(pagesDir, pageId);

        let pageName = pageId;
        let pageWidth = 1280;
        let pageHeight = 720;
        let pageBinding = null;
        let hidden = false;
        let displayOption = null;
        /*
         * The identity `pages.json` uses is the page's `name`, not its folder.
         * A folder is usually `<DisplayName>_<name>` but may be the bare name,
         * so matching on the folder silently ordered one page of eleven
         * correctly and left the rest to fall back to alphabetical.
         */
        let pageKey = pageId;
        const pj = readJson(files, join(pageDir, 'page.json'), warn);
        if (pj) {
            pageName = pj.displayName || pageId;
            pageKey = pj.name || pageId;
            pageWidth = pj.width || pageWidth;
            pageHeight = pj.height || pageHeight;
            pageBinding = pj.pageBinding || null;
            // Anything other than the default counts as hidden: Power BI
            // writes "HiddenInViewMode" and omits the key when visible.
            hidden = Boolean(pj.visibility) && pj.visibility !== 'AlwaysVisible';
            displayOption = pj.displayOption || null;
        }
        // Pages missing from pageOrder sort last rather than first, so a
        // malformed report degrades to "appended" instead of "promoted".
        const order = meta.order.indexOf(pageKey);

        const visuals = [];
        const visualsDir = join(pageDir, 'visuals');
        for (const visualId of childDirs(files, visualsDir)) {
            // VisualParser.parseReport expects {visualId, visualData} wrappers.
            const visualData = readJson(files, join(visualsDir, visualId, 'visual.json'), warn);
            if (visualData) visuals.push({ visualId, visualData });
        }
        pages.push({
            pageId, pageName, displayName: pageName,
            pageWidth, pageHeight, pageBinding, visuals,
            hidden, displayOption,
            order: order === -1 ? Number.MAX_SAFE_INTEGER : order,
            isLanding: pageKey === meta.landing,
        });
    }
    // Authored order, not folder order — this is the order the report shows.
    pages.sort((a, b) => a.order - b.order || a.displayName.localeCompare(b.displayName));
    return pages;
}

/**
 * Parse a PBIP project held in memory and build its lineage graph.
 *
 * @param {object} files                project-relative POSIX path -> file text
 * @param {object} [options]
 * @param {string} [options.rootName]   the project folder's own name
 * @param {function} [options.warn]     called with each recoverable problem
 * @returns {{payload: object, engine: object, physicalIndex: Array}}
 */
function extractPbipFromFiles(files, { rootName = '', warn = m => console.warn(`  ! ${m}`) } = {}) {
    // See the note at the top: publish the collaborators before lineage-engine
    // loads, because it reads them off the global scope.
    globalThis.DAXReferenceExtractor = DAXReferenceExtractor;
    globalThis.MExpressionParser = MExpressionParser;
    globalThis.TMDLParser = TMDLParser;
    globalThis.VisualParser = VisualParser;

    const LineageEngine = require('./pbip/lineage-engine');

    const { semanticModel, report, modelName } = resolveProjectFolders(files, rootName);

    const parser = new TMDLParser();
    const parsedModel = parser.parseAll(readTMDLFiles(files, semanticModel));
    const measureRefs = parser.extractAllReferences();

    // Expand user-defined M source functions so the upstream parser can see the
    // navigation chain hidden inside them. No-op for models that don't use one.
    const inlining = inlineCustomSources(parsedModel);

    const visualParser = new VisualParser();
    const visualData = visualParser.parseReport(readReportPages(files, report, warn));

    const engine = new LineageEngine(parsedModel, visualData, measureRefs);
    engine.buildGraph();

    const payload = {
        parsedModel,
        measureRefs,
        visualData,
        fieldUsageMap: visualParser.getFieldUsageMap(),
        _meta: {
            exportedAt: new Date().toISOString(),
            modelName,
            source: rootName,
            note: 'Generated by lineage-bridge from a PBIP project'
        }
    };

    return {
        payload, engine, inlining,
        physicalIndex: buildPhysicalIndex(engine),
        mComputed: buildComputedIndex(parsedModel, MExpressionParser),
    };
}

/**
 * Read a PBIP project off disk and extract it. Node only.
 *
 * @param {string} projectRoot  PBIP project folder
 */
function extractPbip(projectRoot) {
    const fs = require('fs');
    const path = require('path');

    const root = path.resolve(projectRoot);
    if (!fs.statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);

    const files = {};
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            // Keys are POSIX-relative regardless of platform, because the
            // browser side only ever produces those and one path shape is the
            // point of sharing the implementation.
            else files[path.relative(root, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
        }
    };
    walk(root);

    return extractPbipFromFiles(files, { rootName: path.basename(root) });
}

/**
 * Columns computed in Power Query, and the columns their expressions read.
 *
 * `Table.AddColumn(prev, "Key", each if [a] = null then [b] else [c])` produces
 * a column that exists in no source table. Without this, the columns behind it
 * look untouched by it — and if that computed column is a join key, dropping
 * one of its inputs breaks the join with nothing anywhere to warn you.
 *
 * The reads are a set, not a structure: enough to answer "does dropping this
 * break that", which is the question. An expression whose shape the parser does
 * not recognise contributes nothing rather than something wrong.
 */
function buildComputedIndex(parsedModel, MExpressionParser) {
    const out = new Map();   // tableName -> { computedColumn: [sourceColumn] }
    for (const table of parsedModel.tables || []) {
        for (const partition of table.partitions || []) {
            if (!partition.source) continue;
            const lineage = MExpressionParser.extractTableLineage(partition.source);
            const sources = lineage?.addedColumnSources;
            if (!sources || !Object.keys(sources).length) continue;
            const existing = out.get(table.name) || {};
            for (const [column, reads] of Object.entries(sources)) {
                existing[column] = [...new Set([...(existing[column] || []), ...reads])];
            }
            out.set(table.name, existing);
        }
    }
    return out;
}

/**
 * Flatten the engine's physicalColumn nodes into join-ready rows.
 *
 * `maps_to_physical_column` edges carry the model-side column, so this is the
 * authoritative warehouse-column -> model-column list the merge joins against.
 */
function buildPhysicalIndex(engine) {
    const rows = [];
    for (const edge of engine.edges) {
        if (edge.type !== 'maps_to_physical_column') continue;
        const phys = engine.nodes.get(edge.to);
        if (!phys) continue;
        const modelTable = edge.from.slice('column:'.length, edge.from.lastIndexOf('.'));
        // A navigation chain names its own scopes differently on every platform
        // — account/zone, project/dataset, catalog/schema — so the segments are
        // read by position from the end rather than by name. The last step is
        // the table; the two enclosing steps occupy the schema and database
        // slots that dbt's own relation names use.
        const chain = phys.navigationPath || [];
        const back = n => (chain.length >= n ? chain[chain.length - n] : null);

        rows.push({
            physicalDatabase: back(3),
            physicalSchema: phys.physicalSchema || back(2),
            physicalTable: phys.physicalTable,
            physicalColumn: phys.name,
            modelTable,
            modelColumn: edge.modelName,
            modelColumnId: edge.from,
            physicalColumnId: edge.to
        });
    }
    return rows;
}

module.exports = {
    extractPbip, extractPbipFromFiles,
    buildPhysicalIndex, resolveProjectFolders,
};
