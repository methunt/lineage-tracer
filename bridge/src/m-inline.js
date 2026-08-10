/**
 * Inline user-defined M source functions.
 *
 * The upstream M parser reads navigation out of a partition's own text, but it
 * cannot follow a call into a user-defined function. Models of any size very
 * often wrap their source in one, so the navigation is a call away with the
 * identifying parts passed in as arguments:
 *
 *     expression get_table = (_account, _zone, _table, _columns) =>
 *         let a = Root{[Name=_account]}[Data],
 *             b = a{[Name=_zone,  Kind="Schema"]}[Data],
 *             c = b{[Name=_table, Kind="Table"]}[Data],
 *             d = Table.SelectColumns(c, _columns)
 *         in  d
 *
 *     partition Orders = let Source = get_table(p_account, p_zone, "fct_orders", Fields) ...
 *
 * Nothing here knows what the function is called, what it wraps, or which
 * warehouse is on the other end: any shared expression shaped `(a, b) => body`
 * is a candidate, and the name above is only an example. This module resolves
 * the call's arguments to literals, substitutes them into the function body,
 * and prepends the result to the partition source. The parser then resolves the
 * table exactly as if the chain had been written inline.
 *
 * Purely additive: the original source text is preserved, so `Table.RenameColumns`
 * and everything else the parser reads still works. Models that do not use a
 * wrapper function are returned untouched.
 */

/** Split on commas that are not nested in brackets, braces, parens or strings. */
function splitTopLevel(text) {
    const parts = [];
    let depth = 0;
    let inString = false;
    let cur = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            cur += ch;
            if (ch === '"') inString = text[i + 1] === '"' ? (cur += text[++i], true) : false;
            continue;
        }
        if (ch === '"') { inString = true; cur += ch; continue; }
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim() !== '') parts.push(cur.trim());
    return parts;
}

/** `(a as text, b as list) => body` → {params: ['a','b'], body}. Null if not a function. */
function parseFunction(expression) {
    if (!expression) return null;
    const m = /^\s*\(([^)]*)\)\s*=>\s*([\s\S]*)$/.exec(stripBackticks(expression));
    if (!m) return null;
    const params = splitTopLevel(m[1])
        .map(p => p.trim().split(/\s+as\s+/i)[0].trim())
        .filter(Boolean);
    return params.length ? { params, body: m[2] } : null;
}

function stripBackticks(text) {
    const t = String(text).trim();
    if (t.startsWith('```')) return t.replace(/^```\r?\n?/, '').replace(/\r?\n?```$/, '');
    return t;
}

/** `"value" meta [...]` or `"value"` → value. Null when the expression is not a literal. */
function literalValue(expression) {
    const m = /^\s*"((?:[^"]|"")*)"/.exec(stripBackticks(expression || ''));
    return m ? m[1].replace(/""/g, '"') : null;
}

/** Find `name = <rhs>` inside a `let` block, for resolving locals like `Fields = {...}`. */
function localBinding(source, name) {
    const re = new RegExp(`(?:^|[,\\s])${escapeRe(name)}\\s*=\\s*([^\\n]*)`, 'm');
    const m = re.exec(source);
    return m ? m[1].trim().replace(/,\s*$/, '') : null;
}

const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Rewrite every partition source in place, inlining calls to model-defined functions.
 *
 * @returns {{inlined: number, functions: string[]}} what was expanded, for reporting
 */
function inlineCustomSources(parsedModel) {
    const expressions = new Map();
    for (const expr of parsedModel.expressions || []) {
        if (expr?.name && expr.expression) expressions.set(expr.name, expr.expression);
    }
    if (!expressions.size) return { inlined: 0, functions: [] };

    // Which shared expressions are functions, and which are plain literals (parameters).
    const functions = new Map();
    const literals = new Map();
    for (const [name, body] of expressions) {
        const fn = parseFunction(body);
        if (fn) { functions.set(name, fn); continue; }
        const lit = literalValue(body);
        if (lit !== null) literals.set(name, lit);
    }
    if (!functions.size) return { inlined: 0, functions: [] };

    const callRe = new RegExp(
        `\\b(${[...functions.keys()].map(escapeRe).join('|')})\\s*\\(`, 'g'
    );

    let inlined = 0;
    const used = new Set();

    for (const table of parsedModel.tables || []) {
        for (const partition of table.partitions || []) {
            const source = partition.source;
            if (!source) continue;

            const expansions = [];
            callRe.lastIndex = 0;
            let match;
            while ((match = callRe.exec(source)) !== null) {
                const fnName = match[1];
                const argText = readArgs(source, match.index + match[0].length - 1);
                if (argText === null) continue;

                const fn = functions.get(fnName);
                const args = splitTopLevel(argText);
                const resolved = args.map(a => resolveArg(a, literals, source));

                let body = fn.body;
                fn.params.forEach((param, i) => {
                    if (i >= resolved.length) return;
                    body = body.replace(new RegExp(`\\b${escapeRe(param)}\\b`, 'g'), resolved[i]);
                });
                expansions.push(body);
                used.add(fnName);
            }

            if (expansions.length) {
                // Prepend: the parser reads the whole string with regexes, and the
                // navigation chain must be present before the original steps that
                // rename and reshape the result. The author's own M is preserved so
                // the UI can show what they wrote alongside what we resolved.
                partition._originalSource = source;
                partition.source = `${expansions.join('\n')}\n${source}`;
                inlined++;
            }
        }
    }

    return { inlined, functions: [...used] };
}

/*
 * A `normaliseNavigation` helper used to live here, stripping `Kind="Schema"` /
 * `Kind="Table"` out of the text this module synthesises, because the chain
 * matcher only recognised a bare `[Name="x"]` record. That was a workaround in
 * the wrong place: it fixed the M we generate and left anyone who writes the
 * same chain by hand with no navigation at all. The matcher now tolerates extra
 * record keys, so the substituted body is passed through untouched.
 */

/** Read a balanced argument list starting at the opening paren. */
function readArgs(text, openIndex) {
    let depth = 0;
    let inString = false;
    for (let i = openIndex; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (ch === '"') inString = text[i + 1] === '"' ? (i++, true) : false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0) return text.slice(openIndex + 1, i);
        }
    }
    return null;
}

/**
 * Resolve one call argument to the literal text to substitute.
 * Already-quoted literals pass through; identifiers resolve against model
 * parameters first, then local `let` bindings; anything else is left as written.
 */
function resolveArg(arg, literals, source) {
    const trimmed = arg.trim();
    if (/^"/.test(trimmed)) return trimmed;

    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(trimmed)) {
        if (literals.has(trimmed)) return `"${literals.get(trimmed)}"`;
        const local = localBinding(source, trimmed);
        if (local) {
            const lit = literalValue(local);
            return lit !== null ? `"${lit}"` : local;
        }
    }
    return trimmed;
}

module.exports = { inlineCustomSources, parseFunction, splitTopLevel, resolveArg };
