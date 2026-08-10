/**
 * Warehouse -> Power BI mapping workbook.
 *
 * The user maintains one sheet. "From" is always the warehouse object that dbt
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

const SHEET_NAME = 'mapping';

function normHeader(s) {
    return String(s || '').trim().toLowerCase().replace(/[\s_]+/g, ' ');
}

const HEADER_LOOKUP = new Map(COLUMNS.map(c => [normHeader(c.header), c.key]));

/**
 * Read the mapping workbook (.xlsx) or a .csv with the same headers, from
 * memory. Node reads the file first; the browser already has the bytes.
 *
 * ExcelJS is injected rather than required here because it is ~950 KB and only
 * one of the two formats needs it — the browser loads it on demand, and a
 * static require would put it in the initial bundle for every visitor.
 *
 * @param {ArrayBuffer|Buffer|string} data  file bytes, or text for a .csv
 * @param {string} label                    filename, used in error messages
 * @param {object} [deps.ExcelJS]           required for .xlsx
 */
async function readMappingFromBuffer(data, label, { ExcelJS } = {}) {
    const raw = label.toLowerCase().endsWith('.csv')
        ? readCsvRows(typeof data === 'string' ? data : new TextDecoder().decode(data), label)
        : await readXlsxRows(data, label, ExcelJS);

    return { ...validateRows(raw), path: label };
}

/** Read the mapping workbook off disk. Node only. */
async function readMapping(filePath) {
    if (!filePath) return { rows: [], errors: [], warnings: [], path: null };
    const fs = require('fs');
    const path = require('path');
    if (!fs.existsSync(filePath)) throw new Error(`Mapping file not found: ${filePath}`);

    const isCsv = filePath.toLowerCase().endsWith('.csv');
    const data = isCsv ? fs.readFileSync(filePath, 'utf8') : fs.readFileSync(filePath);
    const result = await readMappingFromBuffer(data, path.basename(filePath), {
        ExcelJS: isCsv ? null : require('exceljs'),
    });
    // Callers report the path they were given, not the basename we validate with.
    return { ...result, path: filePath };
}

/*
 * How many bytes of .xlsx we are willing to hand to ExcelJS.
 *
 * ExcelJS 4.4.0 is the newest release there is — there is no patched version to
 * upgrade to — and its XML, formula and shared-string parsing carry published
 * ReDoS advisories. This file is the one place in the project that feeds
 * attacker-supplied bytes into it: the workbook a visitor drops on the web app,
 * parsed on the main thread, where a catastrophic backtrack is a permanently
 * frozen tab rather than a slow one.
 *
 * A byte cap is the only guard that actually works here. A timeout does not: the
 * backtracking happens inside one synchronous regex call, so the event loop is
 * already blocked and no timer, `Promise.race` or abort signal can ever fire to
 * cancel it. Bounding the input is what bounds the damage.
 *
 * 16 MB, because the thing being read is a hand-maintained mapping sheet of a
 * few thousand rows — comfortably under a megabyte in practice — and a cap has
 * to be wrong in the generous direction to never be the reason a legitimate
 * workbook is refused.
 */
const MAX_XLSX_BYTES = 16 * 1024 * 1024;

/** Byte length of whatever shape the caller had the file in. */
function byteLength(data) {
    if (!data) return 0;
    if (typeof data.byteLength === 'number') return data.byteLength;   // ArrayBuffer, TypedArray, Buffer
    if (typeof data.length === 'number') return data.length;
    return 0;
}

async function readXlsxRows(data, label, ExcelJS) {
    if (!ExcelJS) throw new Error(`Cannot read ${label}: no spreadsheet reader supplied.`);

    const bytes = byteLength(data);
    if (bytes > MAX_XLSX_BYTES) {
        throw new Error(
            `${label} is ${(bytes / 1048576).toFixed(1)} MB, over the ` +
            `${MAX_XLSX_BYTES / 1048576} MB limit for a mapping workbook. ` +
            `Export just the mapping sheet, or save it as .csv.`
        );
    }

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data);

    const ws = wb.getWorksheet(SHEET_NAME) || wb.worksheets[0];
    if (!ws) throw new Error(`No worksheet found in ${label}`);

    const rows = [];
    let headerMap = null;

    ws.eachRow((row, rowNumber) => {
        const values = row.values.slice(1).map(cellText);
        if (!headerMap) {
            headerMap = mapHeaders(values, label);
            return;
        }
        if (values.every(v => v === '')) return;
        rows.push({ _row: rowNumber, ...pickByHeader(values, headerMap) });
    });

    if (!headerMap) throw new Error(`${label} is empty — expected a header row.`);
    return rows;
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

function cellText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
        if (v.text !== undefined) return String(v.text).trim();
        if (v.result !== undefined) return String(v.result).trim();
        if (Array.isArray(v.richText)) return v.richText.map(r => r.text).join('').trim();
        return '';
    }
    return String(v).trim();
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
            `Expected headers: ${COLUMNS.map(c => c.header).join(', ')}, ` +
            `on a sheet named \`${SHEET_NAME}\`.`
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
    relationKey, lower, COLUMNS, SHEET_NAME,
};
