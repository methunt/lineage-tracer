/**
 * Warehouse -> Power BI mapping file.
 *
 * The user maintains one .csv. "From" is always the warehouse object that dbt
 * builds; "To" is always the Power BI semantic model object. A blank From
 * Column means "map the whole table" — columns are then auto-matched by name,
 * so only genuine renames need a row of their own.
 */
const COLUMNS = [
    { key: 'fromDatabase', header: 'From Database', width: 22, required: true },
    { key: 'fromSchema', header: 'From Schema', width: 20, required: true },
    { key: 'fromTable', header: 'From Table', width: 28, required: true },
    { key: 'fromColumn', header: 'From Column', width: 26, required: false },
    { key: 'toTable', header: 'To Table', width: 28, required: true },
    { key: 'toColumn', header: 'To Column', width: 26, required: false }
];

function normHeader(s) {
    return String(s || '').trim().toLowerCase().replace(/[\s_]+/g, ' ');
}

const HEADER_LOOKUP = new Map(COLUMNS.map(c => [normHeader(c.header), c.key]));

/**
 * Read the mapping .csv from memory. Node reads the file first; the browser
 * already has the bytes.
 *
 * @param {ArrayBuffer|Buffer|string} data  file bytes, or text for the .csv
 * @param {string} label                    filename, used in error messages
 */
async function readMappingFromBuffer(data, label) {
    const raw = readCsvRows(typeof data === 'string' ? data : new TextDecoder().decode(data), label);
    return { ...validateRows(raw), path: label };
}

/** Read the mapping file off disk. Node only. */
async function readMapping(filePath) {
    if (!filePath) return { rows: [], errors: [], warnings: [], path: null };
    const fs = require('fs');
    const path = require('path');
    if (!fs.existsSync(filePath)) throw new Error(`Mapping file not found: ${filePath}`);

    const data = fs.readFileSync(filePath, 'utf8');
    const result = await readMappingFromBuffer(data, path.basename(filePath));
    // Callers report the path they were given, not the basename we validate with.
    return { ...result, path: filePath };
}

function readCsvRows(text, label) {
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
    if (!lines.length) throw new Error(`${label} is empty — expected a header row.`);
    const headerMap = mapHeaders(splitCsvLine(lines[0]), label);
    return lines.slice(1).map((line, i) => ({
        _row: i + 2,
        ...pickByHeader(splitCsvLine(line), headerMap)
    }));
}

// Minimal RFC4180-ish splitter — enough for a hand-maintained mapping sheet.
function splitCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (ch === '"') inQuotes = false;
            else cur += ch;
        } else if (ch === '"') inQuotes = true;
        else if (ch === ',') { out.push(cur.trim()); cur = ''; }
        else cur += ch;
    }
    out.push(cur.trim());
    return out;
}

function mapHeaders(values, label) {
    const map = new Map();
    values.forEach((v, i) => {
        const key = HEADER_LOOKUP.get(normHeader(v));
        if (key) map.set(key, i);
    });
    const missing = COLUMNS.filter(c => c.required && !map.has(c.key)).map(c => c.header);
    if (missing.length) {
        throw new Error(
            `${label} is missing required column(s): ${missing.join(', ')}.\n` +
            `Expected headers: ${COLUMNS.map(c => c.header).join(', ')}.`
        );
    }
    return map;
}

function pickByHeader(values, headerMap) {
    const out = {};
    for (const col of COLUMNS) {
        const idx = headerMap.get(col.key);
        out[col.key] = idx === undefined ? '' : (values[idx] || '');
    }
    return out;
}

function validateRows(rows) {
    const errors = [];
    const warnings = [];
    const seen = new Map();
    const clean = [];

    for (const row of rows) {
        const missing = COLUMNS.filter(c => c.required && !row[c.key]).map(c => c.header);
        if (missing.length) {
            errors.push({ row: row._row, message: `missing ${missing.join(', ')}` });
            continue;
        }

        const hasFromCol = !!row.fromColumn;
        const hasToCol = !!row.toColumn;
        if (hasFromCol !== hasToCol) {
            // One side named a column and the other didn't — we cannot guess which
            // column it pairs with, and silently dropping it would look like a match.
            errors.push({
                row: row._row,
                message: 'From Column and To Column must both be filled (column-level row) or both blank (table-level row)'
            });
            continue;
        }

        const entry = {
            ...row,
            level: hasFromCol ? 'column' : 'table',
            fromKey: relationKey(row.fromDatabase, row.fromSchema, row.fromTable)
        };

        const dedupeKey = `${entry.fromKey}|${lower(row.fromColumn)}|${lower(row.toTable)}|${lower(row.toColumn)}`;
        if (seen.has(dedupeKey)) {
            warnings.push({ row: row._row, message: `duplicate of row ${seen.get(dedupeKey)} — ignored` });
            continue;
        }
        seen.set(dedupeKey, row._row);
        clean.push(entry);
    }

    return { rows: clean, errors, warnings };
}

const lower = s => String(s || '').trim().toLowerCase();

/** Case-insensitive, quote-stripped 3-part relation key. */
function relationKey(database, schema, table) {
    return [database, schema, table]
        .map(p => lower(p).replace(/^[`"[]|[`"\]]$/g, ''))
        .join('.');
}

module.exports = {
    readMapping, readMappingFromBuffer,
    relationKey, lower, COLUMNS,
};
