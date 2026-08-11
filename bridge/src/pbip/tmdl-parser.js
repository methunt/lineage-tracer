/*
 * Adopted from pbip-documenter — https://github.com/JonathanJihwanKim/pbip-documenter
 *
 * MIT License. Copyright (c) 2026 Jihwan Kim. See LICENSE in this directory for
 * the full text, which must travel with this file.
 *
 * Maintained here rather than vendored: the report needs parser changes this
 * project owns, and a promise not to change a vendored tree is a promise that
 * has to be broken to ship anything.
 */
/**
 * TMDL Parser Module
 * Line-by-line state machine parser for TMDL files
 * Handles: database.tmdl, model.tmdl, tables/*.tmdl, relationships.tmdl, roles/*.tmdl, expressions.tmdl
 */

/*
 * The values a partition may declare after `=` that name its source type rather
 * than open an expression. Anything else after `=` is an expression body.
 */
const PARTITION_SOURCE_TYPES = new Set([
    'm', 'calculated', 'query', 'entity', 'policyRange', 'calculationGroup', 'inferred',
]);

class TMDLParser {
    constructor() {
        this.model = {
            database: null,
            model: null,
            tables: [],
            relationships: [],
            roles: [],
            expressions: []
        };
        this.errors = [];
    }

    /**
     * Parse all TMDL files from a semantic model definition folder
     * @param {Object} files - Map of filename to content
     * @returns {Object} Parsed model
     */
    parseAll(files) {
        // Parse database.tmdl
        if (files['database.tmdl']) {
            this.model.database = this.parseDatabase(files['database.tmdl']);
        }

        // Parse model.tmdl
        if (files['model.tmdl']) {
            this.model.model = this.parseModel(files['model.tmdl']);
        }

        // Parse relationships.tmdl
        if (files['relationships.tmdl']) {
            this.model.relationships = this.parseRelationships(files['relationships.tmdl']);
        }

        // Parse expressions.tmdl
        if (files['expressions.tmdl']) {
            this.model.expressions = this.parseExpressions(files['expressions.tmdl']);
        }

        // Parse table files
        const tableFiles = Object.keys(files).filter(f => f.startsWith('tables/'));
        for (const tableFile of tableFiles) {
            try {
                const table = this.parseTable(files[tableFile], tableFile);
                if (table) {
                    // Tag auto-date tables for optional filtering
                    if (/^LocalDateTable_|^DateTableTemplate_/.test(table.name)) {
                        table._isAutoDate = true;
                    }
                    // Tag calc-group tables
                    if (table.calculationGroup) {
                        table._isCalcGroup = true;
                    }
                    // Tag field-parameter tables. Decided in one place — see
                    // readFieldParameter — so no two callers can disagree.
                    if (table.fieldParameter) {
                        table._isFieldParameter = true;
                    }
                    this.model.tables.push(table);
                }
            } catch (err) {
                this.errors.push({ file: tableFile, line: null, message: err.message });
            }
        }

        // Parse role files
        const roleFiles = Object.keys(files).filter(f => f.startsWith('roles/'));
        for (const roleFile of roleFiles) {
            try {
                const role = this.parseRole(files[roleFile], roleFile);
                if (role) {
                    this.model.roles.push(role);
                }
            } catch (err) {
                this.errors.push({ file: roleFile, line: null, message: err.message });
            }
        }

        // Sort tables alphabetically
        this.model.tables.sort((a, b) => a.name.localeCompare(b.name));

        return this.model;
    }

    /**
     * Parse database.tmdl
     */
    parseDatabase(content) {
        const result = { name: null, compatibilityLevel: null };
        const lines = content.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('database')) {
                result.name = this._extractName(trimmed, 'database');
            } else if (trimmed.startsWith('compatibilityLevel:')) {
                result.compatibilityLevel = trimmed.split(':')[1]?.trim();
            }
        }

        return result;
    }

    /**
     * Parse model.tmdl
     */
    parseModel(content) {
        const result = { name: null, culture: null, defaultPowerBIDataSourceVersion: null, legacyRedirects: null, returnErrorValuesAsNull: null };
        const lines = content.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('model Model')) {
                result.name = 'Model';
            } else if (trimmed.startsWith('culture:')) {
                result.culture = trimmed.split(':')[1]?.trim();
            } else if (trimmed.startsWith('defaultPowerBIDataSourceVersion:')) {
                result.defaultPowerBIDataSourceVersion = trimmed.split(':')[1]?.trim();
            } else if (trimmed.startsWith('legacyRedirects:')) {
                result.legacyRedirects = trimmed.split(':')[1]?.trim();
            } else if (trimmed.startsWith('returnErrorValuesAsNull:')) {
                result.returnErrorValuesAsNull = trimmed.split(':')[1]?.trim();
            }
        }

        return result;
    }

    /**
     * Parse a table .tmdl file using state machine
     */
    parseTable(content, fileName) {
        const lines = content.split('\n');
        const table = {
            name: null,
            description: null,
            isHidden: false,
            columns: [],
            measures: [],
            hierarchies: [],
            partitions: [],
            calculationGroup: null,
            refreshPolicy: null
        };

        let state = 'IDLE';
        let currentObject = null;
        let currentExpression = [];
        let pendingDescription = null;
        let baseIndent = 0;
        let expressionIndent = 0;
        let inBacktickBlock = false;
        // An annotation or extended property whose value is a block: everything
        // indented under it belongs to that value, not to the object.
        let skipBlockIndent = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            const indent = line.search(/\S/);

            if (skipBlockIndent !== null) {
                if (trimmed !== '' && indent > skipBlockIndent) continue;
                skipBlockIndent = null;
            }

            /*
             * Triple-backtick blocks.
             *
             * A fence may open on a line of its own, or at the end of the
             * declaration that introduces it — `measure 'Media Cost' = ``` `.
             * Toggling on a line that is *entirely* a fence saw only the second
             * kind's closing fence, read it as an opening one, and swallowed
             * everything up to the next measure's closing fence. On the
             * large production model that silently dropped most of one table's
             * measures, and every visual using one was then reported as a broken
             * reference. Open and close are tracked separately now, and the
             * declaration handlers below set the flag when they consume a fence.
             */
            if (inBacktickBlock) {
                if (trimmed === '```') {
                    inBacktickBlock = false;
                    if (state === 'EXPRESSION') currentExpression.push(trimmed);
                } else if (state === 'EXPRESSION') {
                    currentExpression.push(line);
                }
                continue;
            }

            if (trimmed === '```') {
                inBacktickBlock = true;
                if (state === 'EXPRESSION') currentExpression.push(trimmed);
                continue;
            }

            // Description comments (/// lines)
            if (trimmed.startsWith('///')) {
                const descText = trimmed.substring(3).trim();
                if (pendingDescription) {
                    pendingDescription += '\n' + descText;
                } else {
                    pendingDescription = descText;
                }
                continue;
            }

            // Skip regular comments
            if (trimmed.startsWith('//') || trimmed === '') {
                continue;
            }

            // Top-level: table declaration
            if (indent === 0 && trimmed.startsWith('table')) {
                this._finishCurrentObject(state, currentObject, currentExpression, table);
                table.name = this._extractName(trimmed, 'table');
                if (pendingDescription) {
                    table.description = pendingDescription;
                    pendingDescription = null;
                }
                state = 'TABLE_BODY';
                baseIndent = 0;
                continue;
            }

            // Object headers at indent level 1 (typically a single tab or spaces)
            if (state !== 'IDLE' && indent > 0 && indent <= 4) {
                // Check for new object declarations
                const objectType = this._detectObjectType(trimmed);

                if (objectType) {
                    // Save previous object
                    this._finishCurrentObject(state, currentObject, currentExpression, table);
                    currentExpression = [];

                    const name = this._extractName(trimmed, objectType);

                    currentObject = {
                        type: objectType,
                        name: name,
                        description: pendingDescription || null,
                        properties: {}
                    };
                    pendingDescription = null;
                    baseIndent = indent;

                    // Check if line contains '=' (expression follows on same line or next)
                    if (trimmed.includes('=')) {
                        const eqIndex = trimmed.indexOf('=');
                        const afterEq = trimmed.substring(eqIndex + 1).trim();
                        /*
                         * `partition X = calculated` declares a source *type*, not
                         * an expression. Read as an expression, it swallowed every
                         * property below it — including the `source =` marker — so
                         * the type went unrecorded and the source arrived wrapped in
                         * the text of its own declaration.
                         *
                         * Kept to partitions and to the known keywords: a one-word
                         * value after `=` is a legitimate expression anywhere else.
                         */
                        if (objectType === 'partition' && PARTITION_SOURCE_TYPES.has(afterEq)) {
                            currentObject.properties.type = afterEq;
                            state = 'PROPERTIES';
                            continue;
                        }
                        if (afterEq) {
                            currentExpression.push(afterEq);
                        }
                        // `measure 'x' = ```   — the fence opens here, not on a
                        // line of its own.
                        if (afterEq.endsWith('```')) inBacktickBlock = true;
                        state = 'EXPRESSION';
                        expressionIndent = indent + 1;
                    } else {
                        state = 'PROPERTIES';
                    }
                    continue;
                }
            }

            // Inside expression (multi-line DAX, M, etc.)
            if (state === 'EXPRESSION') {
                // Expression continues while indent is deeper than object or we're collecting
                if (indent > baseIndent || trimmed === '') {
                    currentExpression.push(line);
                    continue;
                } else {
                    // Expression ended, process this line as a property or new object
                    state = 'PROPERTIES';
                    // Fall through to property handling
                }
            }

            // Properties
            if (state === 'PROPERTIES' || state === 'TABLE_BODY') {
                /*
                 * `source =` opens an expression block, and it does so whether or
                 * not the rest of the line happens to contain a colon. This used to
                 * sit inside the colon branch below, which was accidentally load-
                 * bearing: an M body opens `let Source = Sql.Database(…)` — colon in
                 * the URL — while a calculated table's DAX has none, so a bare
                 * `source =` was dropped along with every line under it.
                 */
                if (indent > baseIndent && /^(?:expression|source|sourceExpression)\s*=/.test(trimmed)) {
                    const afterEq = trimmed.split('=').slice(1).join('=').trim();
                    if (afterEq) {
                        currentExpression.push(afterEq);
                    }
                    // Same inline fence as an object declaration: a
                    // partition's `source = ``` ` opens the block here.
                    if (afterEq.endsWith('```')) inBacktickBlock = true;
                    state = 'EXPRESSION';
                    expressionIndent = indent + 1;
                    continue;
                }
                // Bare boolean flags (no colon, no value) — e.g. isHidden, isNameInferred
                if (indent > baseIndent && /^(isHidden|isNameInferred|isKey|isNullable)$/.test(trimmed)) {
                    if (currentObject) {
                        currentObject.properties[trimmed] = 'true';
                    } else if (state === 'TABLE_BODY') {
                        if (trimmed === 'isHidden') table.isHidden = true;
                    }
                    continue;
                }
                if (indent > baseIndent && trimmed.includes(':')) {
                    const colonIndex = trimmed.indexOf(':');
                    const key = trimmed.substring(0, colonIndex).trim();
                    const value = trimmed.substring(colonIndex + 1).trim();

                    if (state === 'TABLE_BODY' && !currentObject) {
                        // Table-level properties
                        if (key === 'isHidden') {
                            table.isHidden = value === 'true';
                        }
                    } else if (currentObject) {
                        currentObject.properties[key] = value;
                    }
                    continue;
                }

                // Check for annotation or extendedProperty blocks
                if (indent > baseIndent && (trimmed.startsWith('annotation') || trimmed.startsWith('extendedProperty'))) {
                    // Capture PBI_ResultType for partition refresh state
                    if (currentObject && trimmed.startsWith('annotation PBI_ResultType =')) {
                        const val = trimmed.split('=')[1]?.trim().replace(/^['"]|['"]$/g, '');
                        currentObject.properties.pbiResultType = val;
                    }
                    /*
                     * The marker Power BI writes on a field parameter's hidden
                     * reference column. Read as the marker rather than inferred
                     * from the DAX, so a parameter is still recognisable when
                     * its row list is empty.
                     */
                    if (currentObject && /^extendedProperty\s+ParameterMetadata\b/.test(trimmed)) {
                        currentObject.properties.hasParameterMetadata = 'true';
                    }
                    /*
                     * A value written as a block follows on the lines beneath.
                     * Those lines are JSON and look like properties, so left
                     * unread they were written onto the object as keys nobody
                     * declared — one collision away from overwriting a real one.
                     */
                    if (/=\s*$/.test(trimmed)) skipBlockIndent = indent;
                    continue;
                }
            }

            // Handle expression start on property lines
            if ((state === 'PROPERTIES' || state === 'TABLE_BODY') && currentObject) {
                if (indent > baseIndent && trimmed.startsWith('=')) {
                    const afterEq = trimmed.substring(1).trim();
                    if (afterEq) {
                        currentExpression.push(afterEq);
                    }
                    state = 'EXPRESSION';
                    expressionIndent = indent + 1;
                    continue;
                }
            }
        }

        // Finish last object
        this._finishCurrentObject(state, currentObject, currentExpression, table);

        table.fieldParameter = TMDLParser.readFieldParameter(table);

        return table;
    }

    /**
     * A field parameter's rows, or null if the table is not one.
     *
     * The single place this is decided. It used to be decided twice — once here
     * by one regex and once in the lineage engine by a looser one — so the same
     * table could be a parameter to one caller and an ordinary table to the
     * other, with nothing reporting the disagreement.
     *
     * Two independent signals, because either can appear alone: the marker
     * Power BI writes on the hidden reference column (present even when the row
     * list is empty) and rows that reference a field (written by older and
     * hand-edited files that carry no marker).
     *
     * @param {Object} table a parsed table
     * @returns {{items: Array, markerColumn: string|null}|null}
     */
    static readFieldParameter(table) {
        const marker = (table.columns || []).find(c => c.hasParameterMetadata);

        /*
         * Only a calculated partition, and never a measure: `NAMEOF` appears in
         * ordinary DAX to name a field for a function's benefit, and a table
         * holding one of those is not a parameter.
         */
        const bodies = (table.partitions || [])
            .filter(p => p.sourceType === 'calculated' || !p.sourceType)
            .map(p => p.source || '');

        const items = bodies.flatMap(body => TMDLParser.readFieldParameterItems(body));
        if (!marker && items.length === 0) return null;

        return { items, markerColumn: marker ? marker.name : null };
    }

    /**
     * The tuples in a field parameter's body, as `{caption, targetTable,
     * targetName, order, group}`.
     *
     * Each row is a caption, a reference, an order, and optionally a group
     * caption — and both the three- and four-element widths are written in
     * practice, so a pattern fixed to one width silently drops the other. The
     * reference's table name may be quoted or bare; requiring the quotes made
     * a legitimately written parameter invisible.
     *
     * The reference itself comes in three forms, and the third is the one that
     * matters most: a measure is normally written with no table at all,
     * `NAMEOF([Total])`, which is how a parameter over measures is authored.
     * Requiring a table name made every such parameter parse to nothing — and a
     * measure reached only through a parameter has no other reason to look used,
     * so the omission read as "safe to change".
     *
     * The caption is the one part that cannot be recovered from anywhere else:
     * it is authored here, it is what the reader sees in the slicer, and it is
     * frequently nothing like the name of the field behind it.
     */
    static readFieldParameterItems(body) {
        if (!body || !/\bNAMEOF\s*\(/i.test(body)) return [];

        const TUPLE = new RegExp([
            /\(\s*"((?:[^"]|"")*)"\s*,/,                       // caption
            // reference: 'Quoted'[name], Bare[name], or [name] on its own
            /\s*NAMEOF\s*\(\s*(?:'([^']+)'|([^'[\s,()]+))?\s*\[([^\]]+)\]\s*\)/,
            /(?:\s*,\s*(-?\d+))?/,                             // order
            /(?:\s*,\s*"((?:[^"]|"")*)")?/,                    // group caption
        ].map(r => r.source).join(''), 'gi');

        // A quote inside a DAX string literal is written twice.
        const text = s => (s == null ? null : s.replace(/""/g, '"'));

        const items = [];
        for (const m of body.matchAll(TUPLE)) {
            items.push({
                caption: text(m[1]),
                // Null, not the empty string: nothing to resolve against, and a
                // caller matching on a name must not match on a blank one.
                targetTable: m[2] || m[3] || null,
                targetName: m[4],
                order: m[5] != null ? parseInt(m[5], 10) : null,
                group: text(m[6]),
            });
        }
        return items;
    }

    /**
     * Detect object type from a line
     */
    _detectObjectType(line) {
        const types = ['column', 'measure', 'hierarchy', 'partition', 'calculationGroup', 'calculationItem', 'level', 'role', 'refreshPolicy'];
        for (const type of types) {
            if (line === type || line.startsWith(type + ' ') || line.startsWith(type + '\t')) {
                return type;
            }
        }
        return null;
    }

    /**
     * Finish current object and add to table
     */
    _finishCurrentObject(state, currentObject, currentExpression, table) {
        if (!currentObject) return;

        const expressionText = currentExpression.length > 0
            ? this._cleanExpression(currentExpression)
            : null;

        switch (currentObject.type) {
            case 'column':
                table.columns.push({
                    name: currentObject.name,
                    description: currentObject.description,
                    dataType: currentObject.properties.dataType || null,
                    formatString: currentObject.properties.formatString || null,
                    isHidden: currentObject.properties.isHidden === 'true',
                    sourceColumn: currentObject.properties.sourceColumn || null,
                    summarizeBy: currentObject.properties.summarizeBy || null,
                    sortByColumn: currentObject.properties.sortByColumn || null,
                    displayFolder: currentObject.properties.displayFolder || null,
                    dataCategory: currentObject.properties.dataCategory || null,
                    expression: expressionText,
                    hasParameterMetadata: currentObject.properties.hasParameterMetadata === 'true'
                });
                break;

            case 'measure':
                table.measures.push({
                    name: currentObject.name,
                    description: currentObject.description,
                    expression: expressionText,
                    displayFolder: currentObject.properties.displayFolder || null,
                    formatString: currentObject.properties.formatString || null,
                    formatStringExpression: currentObject.properties.formatStringExpression || null,
                    dataCategory: currentObject.properties.dataCategory || null
                });
                break;

            case 'hierarchy':
                table.hierarchies.push({
                    name: currentObject.name,
                    description: currentObject.description,
                    levels: [] // Levels are parsed as sub-objects
                });
                break;

            case 'level':
                // Add to last hierarchy
                if (table.hierarchies.length > 0) {
                    table.hierarchies[table.hierarchies.length - 1].levels.push({
                        name: currentObject.name,
                        column: currentObject.properties.column || null,
                        ordinal: currentObject.properties.ordinal || null
                    });
                }
                break;

            case 'partition':
                table.partitions.push({
                    name: currentObject.name,
                    mode: currentObject.properties.mode || null,
                    source: expressionText,
                    sourceType: currentObject.properties.type || null,
                    lastRefreshState: currentObject.properties.pbiResultType || null
                });
                break;

            case 'calculationGroup':
                table.calculationGroup = {
                    items: [],
                    precedence: currentObject.properties.precedence != null
                        ? parseInt(currentObject.properties.precedence, 10) : null
                };
                break;

            case 'calculationItem':
                if (table.calculationGroup) {
                    table.calculationGroup.items.push({
                        name: currentObject.name,
                        expression: expressionText,
                        ordinal: currentObject.properties.ordinal != null
                            ? parseInt(currentObject.properties.ordinal, 10) : null,
                        formatStringExpression: currentObject.properties.formatStringExpression || null
                    });
                }
                break;

            case 'refreshPolicy':
                table.refreshPolicy = {
                    policyType: currentObject.properties.policyType || null,
                    rollingWindowGranularity: currentObject.properties.rollingWindowGranularity || null,
                    rollingWindowPeriods: currentObject.properties.rollingWindowPeriods != null
                        ? parseInt(currentObject.properties.rollingWindowPeriods, 10) : null,
                    incrementalGranularity: currentObject.properties.incrementalGranularity || null,
                    incrementalPeriods: currentObject.properties.incrementalPeriods != null
                        ? parseInt(currentObject.properties.incrementalPeriods, 10) : null,
                    pollingExpression: currentObject.properties.pollingExpression || null,
                    sourceExpression: expressionText
                };
                break;
        }
    }

    /**
     * Clean a multi-line expression
     */
    _cleanExpression(lines) {
        if (lines.length === 0) return null;

        // Find minimum indentation (excluding empty lines)
        const nonEmptyLines = lines.filter(l => l.trim() !== '');
        if (nonEmptyLines.length === 0) return null;

        const minIndent = Math.min(...nonEmptyLines.map(l => {
            const match = l.match(/^(\s*)/);
            return match ? match[1].length : 0;
        }));

        // Remove common indentation
        const cleaned = lines.map(l => {
            if (l.trim() === '') return '';
            return l.substring(Math.min(minIndent, l.search(/\S/) >= 0 ? l.search(/\S/) : 0));
        });

        // Remove leading/trailing empty lines
        while (cleaned.length > 0 && cleaned[0].trim() === '') cleaned.shift();
        while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') cleaned.pop();

        return cleaned.join('\n');
    }

    /**
     * Parse relationships.tmdl
     */
    parseRelationships(content) {
        const relationships = [];
        const lines = content.split('\n');
        let currentRel = null;

        for (const line of lines) {
            const trimmed = line.trim();
            const indent = line.search(/\S/);

            if (indent === 0 && trimmed.startsWith('relationship')) {
                if (currentRel) relationships.push(this._finalizeRel(currentRel));
                currentRel = {
                    id: this._extractName(trimmed, 'relationship'),
                    fromTable: null,
                    fromColumn: null,
                    toTable: null,
                    toColumn: null,
                    fromCardinality: null,
                    toCardinality: null,
                    crossFilteringBehavior: null,
                    securityFilteringBehavior: null,
                    isActive: true
                };
                continue;
            }

            if (currentRel && indent > 0 && trimmed.includes(':')) {
                const colonIndex = trimmed.indexOf(':');
                const key = trimmed.substring(0, colonIndex).trim();
                const value = trimmed.substring(colonIndex + 1).trim();

                switch (key) {
                    case 'fromColumn':
                        const fromParts = this._parseColumnRef(value);
                        currentRel.fromTable = fromParts.table;
                        currentRel.fromColumn = fromParts.column;
                        break;
                    case 'toColumn':
                        const toParts = this._parseColumnRef(value);
                        currentRel.toTable = toParts.table;
                        currentRel.toColumn = toParts.column;
                        break;
                    case 'fromCardinality':
                        currentRel.fromCardinality = value;
                        break;
                    case 'toCardinality':
                        currentRel.toCardinality = value;
                        break;
                    case 'crossFilteringBehavior':
                        currentRel.crossFilteringBehavior = value;
                        break;
                    case 'securityFilteringBehavior':
                        currentRel.securityFilteringBehavior = value;
                        break;
                    case 'isActive':
                        currentRel.isActive = value !== 'false';
                        break;
                }
            }
        }

        if (currentRel) relationships.push(this._finalizeRel(currentRel));
        return relationships;
    }

    _finalizeRel(rel) {
        const from = rel.fromCardinality || 'many';
        const to   = rel.toCardinality   || 'one';
        rel.cardinality = `${from}:${to}`;
        return rel;
    }

    /**
     * Parse a column reference like "'Table Name'.ColumnName" or "Table.Column"
     */
    _parseColumnRef(value) {
        /*
         * Either side may be quoted, and both sides had to be unquoted.
         *
         * The table was, the column was not — so Customer.'Source System'
         * yielded a column literally named "'Source System'", which matches no
         * column in the model. The relationship parsed and then vanished: it
         * was indexed under a key nothing looks up, so the column that holds
         * the join reported no join at all. On a large production model that
         * hid a relationship outright, and an unmentioned join is one you drop.
         */
        const unquote = s => {
            const t = s.trim();
            return t.startsWith("'") && t.endsWith("'") && t.length > 1
                ? t.slice(1, -1)
                : t;
        };

        // The dot that separates them is the one outside any quotes: a quoted
        // name may contain dots of its own.
        let depth = 0;
        for (let i = 0; i < value.length; i++) {
            if (value[i] === "'") depth ^= 1;
            else if (value[i] === '.' && !depth) {
                return {
                    table: unquote(value.slice(0, i)),
                    column: unquote(value.slice(i + 1)),
                };
            }
        }

        return { table: null, column: unquote(value) };
    }

    /**
     * Parse roles/*.tmdl
     */
    parseRole(content, fileName) {
        const lines = content.split('\n');
        const role = {
            name: null,
            description: null,
            modelPermission: null,
            tablePermissions: []
        };

        let currentPermission = null;
        let inFilterExpression = false;
        let filterLines = [];

        for (const line of lines) {
            const trimmed = line.trim();
            const indent = line.search(/\S/);

            if (indent === 0 && trimmed.startsWith('role')) {
                role.name = this._extractName(trimmed, 'role');
                continue;
            }

            if (trimmed.startsWith('modelPermission:')) {
                role.modelPermission = trimmed.split(':')[1]?.trim();
                continue;
            }

            if (trimmed.startsWith('tablePermission')) {
                if (currentPermission) {
                    if (filterLines.length > 0) {
                        currentPermission.filterExpression = filterLines.join('\n').trim();
                    }
                    role.tablePermissions.push(currentPermission);
                }
                currentPermission = {
                    table: this._extractName(trimmed, 'tablePermission'),
                    filterExpression: null
                };
                filterLines = [];
                inFilterExpression = false;
                continue;
            }

            if (currentPermission && trimmed.startsWith('filterExpression:')) {
                const afterColon = trimmed.split(':').slice(1).join(':').trim();
                if (afterColon) filterLines.push(afterColon);
                inFilterExpression = true;
                continue;
            }

            if (inFilterExpression && indent > 2) {
                filterLines.push(trimmed);
                continue;
            }

            if (trimmed.startsWith('///') && !role.description) {
                role.description = trimmed.substring(3).trim();
            }
        }

        if (currentPermission) {
            if (filterLines.length > 0) {
                currentPermission.filterExpression = filterLines.join('\n').trim();
            }
            role.tablePermissions.push(currentPermission);
        }

        return role;
    }

    /**
     * Parse expressions.tmdl
     */
    parseExpressions(content) {
        const expressions = [];
        const lines = content.split('\n');
        let currentExpr = null;
        let exprLines = [];
        let inExpression = false;
        let inBacktickBlock = false;

        for (const line of lines) {
            const trimmed = line.trim();
            const indent = line.search(/\S/);

            // Triple-backtick fence toggle
            if (trimmed === '```') {
                if (inBacktickBlock) {
                    // End of backtick block — close current expression body
                    inBacktickBlock = false;
                } else if (currentExpr) {
                    // Start of backtick block
                    inBacktickBlock = true;
                    inExpression = true;
                }
                continue;
            }

            if (inBacktickBlock) {
                exprLines.push(line);
                continue;
            }

            if (indent === 0 && trimmed.startsWith('expression')) {
                if (currentExpr) {
                    currentExpr.expression = exprLines.join('\n').trim();
                    expressions.push(currentExpr);
                }
                currentExpr = {
                    name: this._extractName(trimmed, 'expression'),
                    kind: null,
                    expression: null,
                    resultType: null
                };
                exprLines = [];
                inExpression = false;

                // Check for '=' on the same line (may be followed by ``` or inline M)
                if (trimmed.includes('=')) {
                    const afterEq = trimmed.substring(trimmed.indexOf('=') + 1).trim();
                    if (afterEq && afterEq !== '```') {
                        exprLines.push(afterEq);
                        inExpression = true;
                    } else if (afterEq === '```') {
                        inBacktickBlock = true;
                        inExpression = true;
                    } else {
                        inExpression = true;
                    }
                }
                continue;
            }

            if (currentExpr) {
                if (trimmed.startsWith('kind:')) {
                    currentExpr.kind = trimmed.split(':')[1]?.trim();
                    continue;
                }

                if (trimmed.startsWith('annotation ')) {
                    // Capture PBI_ResultType so downstream code can distinguish
                    // table-returning expressions from parameters, functions, lists, etc.
                    const m = trimmed.match(/^annotation\s+PBI_ResultType\s*=\s*(.+)$/);
                    if (m) {
                        currentExpr.resultType = m[1].trim().replace(/^["']|["']$/g, '');
                    }
                    continue;
                }

                if (indent > 0 && (inExpression || trimmed.startsWith('='))) {
                    if (trimmed.startsWith('=')) {
                        const afterEq = trimmed.substring(1).trim();
                        if (afterEq && afterEq !== '```') {
                            exprLines.push(afterEq);
                        } else if (afterEq === '```') {
                            inBacktickBlock = true;
                        }
                    } else {
                        exprLines.push(trimmed);
                    }
                    inExpression = true;
                }
            }
        }

        if (currentExpr) {
            currentExpr.expression = exprLines.join('\n').trim();
            expressions.push(currentExpr);
        }

        return expressions;
    }

    /**
     * Extract name from a declaration line
     * Handles: keyword 'Name With Spaces' and keyword SimpleName
     */
    _extractName(line, keyword) {
        const afterKeyword = line.substring(keyword.length).trim();

        // Remove trailing '=' or content after '='
        const eqIndex = afterKeyword.indexOf('=');
        const nameStr = eqIndex >= 0 ? afterKeyword.substring(0, eqIndex).trim() : afterKeyword;

        // Quoted name
        const quotedMatch = nameStr.match(/^'([^']+)'/);
        if (quotedMatch) return quotedMatch[1];

        // Unquoted name (first word or identifier)
        const unquoted = nameStr.split(/\s/)[0];
        return unquoted || nameStr;
    }

    /**
     * Extract DAX references from all measures
     * @returns {Object} Map of measure name → { measureRefs, columnRefs, tableRefs }
     */
    extractAllReferences() {
        const refs = {};

        for (const table of this.model.tables) {
            for (const measure of table.measures) {
                if (measure.expression) {
                    refs[measure.name] = DAXReferenceExtractor.extract(measure.expression);
                    refs[measure.name].table = table.name;
                }
            }
            // Also extract references from calculated columns
            for (const col of table.columns) {
                if (col.expression) {
                    const key = `${table.name}[${col.name}]`;
                    refs[key] = DAXReferenceExtractor.extract(col.expression);
                    refs[key].table = table.name;
                    refs[key].isCalculatedColumn = true;
                }
            }
        }

        return refs;
    }
}

/**
 * DAX Reference Extractor
 * Regex-based extraction of table, column, and measure references from DAX
 */
class DAXReferenceExtractor {
    /**
     * Extract all references from a DAX expression
     */
    static extract(dax) {
        if (!dax) return { measureRefs: [], columnRefs: [], tableRefs: [] };

        const cleaned = this._cleanDAX(dax);

        return {
            measureRefs: this._extractMeasureRefs(cleaned),
            columnRefs: this._extractColumnRefs(cleaned),
            tableRefs: this._extractTableRefs(cleaned)
        };
    }

    /**
     * Clean DAX by removing comments and string literals
     */
    static _cleanDAX(dax) {
        let cleaned = dax.replace(/\/\*[\s\S]*?\*\//g, '');
        cleaned = cleaned.replace(/\/\/.*/g, '');
        cleaned = cleaned.replace(/"[^"]*"/g, '""');
        return cleaned;
    }

    /**
     * Extract measure references [MeasureName]
     */
    static _extractMeasureRefs(dax) {
        const refs = new Set();
        const pattern = /(?<!'[^']*)\[([^\]]+)\]/g;
        let match;

        while ((match = pattern.exec(dax)) !== null) {
            // Only standalone [Name] without table prefix
            const beforeBracket = dax.substring(Math.max(0, match.index - 1), match.index);
            if (beforeBracket !== '.' && !/\w/.test(beforeBracket) && beforeBracket !== "'") {
                refs.add(match[1].trim());
            }
        }

        return Array.from(refs);
    }

    /**
     * Extract column references Table[Column] or 'Table Name'[Column]
     */
    static _extractColumnRefs(dax) {
        const refs = [];
        const seen = new Set();
        const pattern = /(?:'([^']+)'|(\w+))\[([^\]]+)\]/g;
        let match;

        while ((match = pattern.exec(dax)) !== null) {
            const table = match[1] || match[2];
            const column = match[3].trim();
            const key = `${table}|${column}`;

            if (!seen.has(key)) {
                seen.add(key);
                refs.push({ table, column });
            }
        }

        return refs;
    }

    /**
     * Build a lookup map of measure name → table name
     * @param {Array} tables - Parsed tables from the model
     * @returns {Map<string, string>} Map of measureName → tableName
     */
    static buildMeasureLookup(tables) {
        const lookup = new Map();
        for (const table of tables) {
            for (const measure of table.measures) {
                lookup.set(measure.name, table.name);
            }
        }
        return lookup;
    }

    /**
     * Extract table references from functions like COUNTROWS(Table), ALL(Table)
     */
    static _extractTableRefs(dax) {
        const refs = new Set();
        const pattern = /(?:COUNTROWS|RELATEDTABLE|VALUES|ALL|ALLEXCEPT|ALLSELECTED|ALLNOBLANKROW|REMOVEFILTERS|DISTINCT|SUMMARIZE|SUMMARIZECOLUMNS|ADDCOLUMNS|SELECTCOLUMNS|FILTER|CALCULATETABLE|TOPN|GENERATE|GENERATESERIES|NATURALLEFTOUTERJOIN|NATURALINNERJOIN|CROSSJOIN|UNION|INTERSECT|EXCEPT|TREATAS|LOOKUPVALUE|RELATED|RANKX|SAMPLE|GROUPBY|DATATABLE|WINDOW|OFFSET|INDEX)\s*\(\s*(?:'([^']+)'|(\w+))\s*(?:[,)])/gi;
        let match;

        while ((match = pattern.exec(dax)) !== null) {
            refs.add(match[1] || match[2]);
        }

        return Array.from(refs);
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TMDLParser, DAXReferenceExtractor };
}
