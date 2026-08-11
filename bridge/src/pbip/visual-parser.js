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
 * Visual Parser Module
 * Parses PBIR visual.json files to extract field references
 * Maps semantic model objects to their consuming visuals
 */

class VisualParser {
    constructor() {
        this.pages = [];
        this.visuals = [];
        this.fieldUsageMap = new Map(); // "type|table|field" → [{ visualName, pageName, visualType }]
    }

    /**
     * Parse all report pages and visuals
     * @param {Array} pagesData - Array of { pageId, pageName, visuals: [{ visualId, visualData }] }
     */
    parseReport(pagesData) {
        this.pages = [];
        this.visuals = [];
        this.fieldUsageMap = new Map();

        for (const page of pagesData) {
            const pageBinding = page.pageBinding || null;
            const pageInfo = {
                id: page.pageId,
                name: page.pageName || page.displayName || page.pageId,
                displayName: page.displayName || page.pageName || page.pageId,
                pageWidth: page.pageWidth || null,
                pageHeight: page.pageHeight || null,
                // Layout metadata: authored tab order, whether the page is
                // hidden in view mode, and how the canvas is scaled.
                order: page.order ?? null,
                hidden: Boolean(page.hidden),
                isLanding: Boolean(page.isLanding),
                displayOption: page.displayOption || null,
                isDrillthrough: pageBinding?.type === 'Drillthrough',
                drillthroughFilters: pageBinding?.type === 'Drillthrough'
                    ? (pageBinding.boundFilter || []) : [],
                visuals: []
            };

            for (const visual of (page.visuals || [])) {
                const parsed = this.parseVisual(visual.visualData, pageInfo.displayName);
                parsed.visualId = visual.visualId;
                parsed.pageId = page.pageId;
                pageInfo.visuals.push(parsed);
                this.visuals.push(parsed);
            }

            this.pages.push(pageInfo);
        }

        return {
            pages: this.pages,
            visuals: this.visuals,
            fieldUsageMap: this.getFieldUsageMap()
        };
    }

    /**
     * Parse a single visual.json
     * @param {Object} visualData - Parsed visual.json content
     * @param {string} pageName - Name of the page containing this visual
     * @returns {Object} Parsed visual info
     */
    parseVisual(visualData, pageName) {
        const visualType = visualData.visual?.visualType || visualData.visualType || 'unknown';
        const visualName = this._extractVisualName(visualData) || visualType;
        const { fields, fpSelections } = this._extractFieldReferences(visualData);

        // Register each field in the usage map
        for (const field of fields) {
            const key = `${field.type}|${field.table || field.entity}|${field.name || field.column || field.hierarchy}`;

            if (!this.fieldUsageMap.has(key)) {
                this.fieldUsageMap.set(key, []);
            }

            this.fieldUsageMap.get(key).push({
                visualName,
                visualType,
                pageName,
                projectionName: field.projectionName,
                displayName: field.displayName || null
            });
        }

        return {
            visualType,
            visualName,
            pageName,
            fields,
            fpSelections,
            position: visualData.position || visualData.visual?.position || null,
            /*
             * Layout identity. A visual inside a group stores its position
             * *relative to that group*, so without the parent link the offset
             * cannot be recovered and every grouped visual lands at the page
             * origin. Groups themselves are containers with no fields.
             */
            name: visualData.name || null,
            parentGroupName: visualData.parentGroupName || null,
            isGroup: Boolean(visualData.visualGroup) && !visualData.visual,
            groupName: visualData.visualGroup?.displayName || null
        };
    }

    /**
     * Get the field usage map as a plain object
     * @returns {Object} Map of "type|table|field" → usage array
     */
    getFieldUsageMap() {
        const result = {};
        for (const [key, usages] of this.fieldUsageMap) {
            result[key] = usages;
        }
        return result;
    }

    /**
     * Get visual usage for a specific field
     * @param {string} type - 'measure', 'column', or 'hierarchy'
     * @param {string} table - Table name
     * @param {string} field - Field name
     * @returns {Array} Array of visual usage objects
     */
    getUsageForField(type, table, field) {
        const key = `${type}|${table}|${field}`;
        return this.fieldUsageMap.get(key) || [];
    }

    /**
     * Get all visuals that use any field from a specific table
     * @param {string} tableName
     * @returns {Array} Array of visual usage objects
     */
    getUsageForTable(tableName) {
        const usages = [];
        const seen = new Set();

        for (const [key, visualUsages] of this.fieldUsageMap) {
            const parts = key.split('|');
            if (parts[1] === tableName) {
                for (const usage of visualUsages) {
                    const usageKey = `${usage.pageName}|${usage.visualName}`;
                    if (!seen.has(usageKey)) {
                        seen.add(usageKey);
                        usages.push(usage);
                    }
                }
            }
        }

        return usages;
    }

    /**
     * Extract visual name from visualContainerObjects
     */
    _extractVisualName(visualData) {
        try {
            const containerObjects = visualData.visual?.visualContainerObjects;
            if (!containerObjects) return null;

            // Check title
            if (containerObjects.title?.length > 0) {
                const titleObj = containerObjects.title[0];
                if (titleObj.properties?.text?.expr?.Literal?.Value) {
                    return titleObj.properties.text.expr.Literal.Value.replace(/^['"]|['"]$/g, '');
                }
            }

            // Check general
            if (containerObjects.general?.length > 0) {
                const generalObj = containerObjects.general[0];
                if (generalObj.properties?.title?.expr?.Literal?.Value) {
                    return generalObj.properties.title.expr.Literal.Value.replace(/^['"]|['"]$/g, '');
                }
            }

            return null;
        } catch {
            return null;
        }
    }

    /**
     * Extract all field references from visual data.
     * Returns { fields, fpSelections } where fpSelections maps tableName → { selectedIndex, length }.
     */
    _extractFieldReferences(visualData) {
        const fieldMap = new Map();
        const fpSelections = {};

        try {
            // Query state projections
            this._extractFromQueryState(
                visualData.visual?.query?.queryState || visualData.query?.queryState,
                fieldMap,
                fpSelections
            );

            // Sort definitions
            this._extractFromSortDefinition(visualData.visual?.query?.sortDefinition, fieldMap);

            // Filter config
            this._extractFromFilterConfig(visualData.filterConfig, fieldMap);

            // Visual objects (conditional formatting, etc.)
            this._extractFromVisualObjects(visualData.visual?.objects, fieldMap, 'conditionalFormatting');
            this._extractFromVisualObjects(visualData.visual?.visualContainerObjects, fieldMap, 'containerObjects');
        } catch (err) {
            console.error('Error extracting field references:', err);
        }

        return { fields: Array.from(fieldMap.values()), fpSelections };
    }

    /**
     * Extract from query state projections
     */
    _extractFromQueryState(queryState, fieldMap, fpSelections) {
        if (!queryState) return;

        for (const [projectionName, projection] of Object.entries(queryState)) {
            if (projection.projections) {
                for (const proj of projection.projections) {
                    this._extractFieldFromProjection(proj, projectionName, fieldMap);
                }
            }
            // fieldParameters: used by pivot tables when a field parameter drives Values
            if (projection.fieldParameters) {
                for (const fp of projection.fieldParameters) {
                    if (fp.parameterExpr) {
                        this._extractFieldFromProjection(
                            { field: fp.parameterExpr },
                            projectionName,
                            fieldMap
                        );
                        // Record which FP item index is currently selected
                        if (fpSelections) {
                            const entity = fp.parameterExpr?.Column?.Expression?.SourceRef?.Entity
                                || fp.parameterExpr?.Measure?.Expression?.SourceRef?.Entity;
                            if (entity && fp.index !== undefined) {
                                fpSelections[entity] = {
                                    selectedIndex: fp.index,
                                    length: fp.length ?? null
                                };
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Extract from sort definitions
     */
    _extractFromSortDefinition(sortDefinition, fieldMap) {
        if (!sortDefinition?.sort) return;

        for (const sortItem of sortDefinition.sort) {
            if (sortItem.field) {
                this._extractFieldFromProjection({ field: sortItem.field }, 'sort', fieldMap);
            }
        }
    }

    /**
     * Extract from filter config
     */
    _extractFromFilterConfig(filterConfig, fieldMap) {
        if (!filterConfig?.filters) return;

        for (const filter of filterConfig.filters) {
            if (filter.field) {
                this._extractFieldFromProjection({ field: filter.field }, 'filter', fieldMap);
            }
        }
    }

    /**
     * Extract from visual objects (buttons, conditional formatting)
     */
    _extractFromVisualObjects(objects, fieldMap, role = 'visualObjects') {
        if (!objects) return;

        /*
         * A SourceRef names either the table itself (`Entity`) or an alias
         * (`Source`) declared in the enclosing query's `From` list. Dynamic
         * text — "Data available through <measure>" in a textbox — is written
         * the second way, with the measure wrapped in a subquery, so resolving
         * only `Entity` skipped it and the textbox reported reading nothing.
         *
         * Aliases are collected on the way down and shadow outer ones, which is
         * what a nested subquery reusing the name `m` means.
         */
        /*
         * The depth cap was 10, and a measure inside dynamic text sits about
         * fourteen levels down — objects → values → properties → expr → expr →
         * Min → Expression → Column → Expression → Subquery → Query → Select →
         * Measure. The cap is a guard against pathological nesting, not a
         * statement about how deep a real reference goes, so it is raised
         * rather than removed.
         */
        const search = (obj, depth = 0, aliases = new Map()) => {
            if (!obj || typeof obj !== 'object' || depth > 40) return;

            if (Array.isArray(obj.From)) {
                aliases = new Map(aliases);
                for (const from of obj.From) {
                    if (from?.Name && from?.Entity) aliases.set(from.Name, from.Entity);
                }
            }
            const entityOf = ref => ref?.Entity || aliases.get(ref?.Source) || null;

            if (obj.Column) {
                const entity = entityOf(obj.Column.Expression?.SourceRef);
                const property = obj.Column.Property;
                if (entity && property) {
                    const key = `column|${entity}|${property}`;
                    if (!fieldMap.has(key)) {
                        fieldMap.set(key, {
                            type: 'column',
                            table: entity,
                            column: property,
                            name: property,
                            projectionName: role
                        });
                    }
                }
            } else if (obj.Measure) {
                const entity = entityOf(obj.Measure.Expression?.SourceRef);
                const property = obj.Measure.Property;
                if (entity && property) {
                    const key = `measure|${entity}|${property}`;
                    if (!fieldMap.has(key)) {
                        fieldMap.set(key, {
                            type: 'measure',
                            table: entity,
                            entity: entity,
                            name: property,
                            projectionName: role
                        });
                    }
                }
            }

            for (const value of Object.values(obj)) {
                if (typeof value === 'object') {
                    search(value, depth + 1, aliases);
                }
            }
        };

        search(objects);
    }

    /**
     * The name the author typed over a field *in this visual*, or null.
     *
     * Power BI writes `displayName` on a projection when the reader renames the
     * field in the visual's own field well — the semantic model keeps the
     * original, so the same measure can read "Label A" in one visual and
     * "Label B" in the next. Only `displayName` is trusted: `nativeQueryRef` also
     * changes on rename, but it changes for reasons nobody typed as well — a
     * second reference to one column in a query gains a numeric suffix — and
     * reporting that as a rename would put a fact on screen that no author
     * asserted.
     *
     * Power BI also writes `displayName` when it equals the field name. That is
     * not a rename, and listing it as one would bury the real ones.
     */
    _renameOf(proj, fieldName) {
        const shown = typeof proj?.displayName === 'string' ? proj.displayName.trim() : '';
        if (!shown) return null;
        return shown.toLowerCase() === String(fieldName).trim().toLowerCase() ? null : shown;
    }

    /**
     * Record one field reference, merging into any entry already collected.
     *
     * A field can be projected more than once in a single visual — the Values
     * well and the sort definition name the same measure — and only one of those
     * carries the rename. Merging rather than first-write-wins means the order
     * the extractors run in cannot decide whether a rename is seen.
     */
    _record(fieldMap, key, entry, rename) {
        const existing = fieldMap.get(key) || (fieldMap.set(key, entry), entry);
        if (rename && !(existing.displayNames || []).includes(rename)) {
            existing.displayNames = [...(existing.displayNames || []), rename];
            // The first rename seen is the one a single-label surface shows.
            existing.displayName = existing.displayNames[0];
        }
        return existing;
    }

    /**
     * Extract field from a projection object
     */
    _extractFieldFromProjection(proj, projectionName, fieldMap) {
        if (proj.field?.Column) {
            const entity = proj.field.Column.Expression?.SourceRef?.Entity;
            const property = proj.field.Column.Property;
            if (entity && property) {
                this._record(fieldMap, `column|${entity}|${property}`, {
                    type: 'column',
                    table: entity,
                    column: property,
                    name: property,
                    projectionName
                }, this._renameOf(proj, property));
            }
        } else if (proj.field?.Measure) {
            const entity = proj.field.Measure.Expression?.SourceRef?.Entity;
            const property = proj.field.Measure.Property;
            if (entity && property) {
                this._record(fieldMap, `measure|${entity}|${property}`, {
                    type: 'measure',
                    table: entity,
                    entity: entity,
                    name: property,
                    projectionName
                }, this._renameOf(proj, property));
            }
        } else if (proj.field?.Hierarchy) {
            const entity = proj.field.Hierarchy.Expression?.SourceRef?.Entity;
            const hierarchy = proj.field.Hierarchy.Hierarchy;
            if (entity && hierarchy) {
                this._record(fieldMap, `hierarchy|${entity}|${hierarchy}`, {
                    type: 'hierarchy',
                    table: entity,
                    hierarchy: hierarchy,
                    name: hierarchy,
                    projectionName
                }, this._renameOf(proj, hierarchy));
            }
        }
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = VisualParser;
}
