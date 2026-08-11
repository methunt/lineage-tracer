import React from 'react';
import {
    IconCheck, IconWarn, IconUpload, IconDatabase, IconJson, IconSheet, IconFolder,
} from '../icons';
import { readDirectoryInput, readDroppedEntries, formatSize } from './files';

/**
 * One input the tool needs, as a target you can click or drop on.
 *
 * A slot is either empty, filled or refused, and says which without a legend:
 * filled turns its rule green and shows what it accepted, refused turns it red
 * and says what was wrong with the thing you gave it. "Required" is not marked,
 * because all four are — a badge on every slot is a badge on none.
 */
export default function FileSlot({ slot, value, error, onValue, onError, disabled }) {
    const inputRef = React.useRef(null);
    const [over, setOver] = React.useState(false);

    const accept = React.useCallback(async payload => {
        try {
            onError(slot.key, null);
            const parsed = await slot.read(payload);
            onValue(slot.key, parsed);
        } catch (e) {
            onValue(slot.key, null);
            onError(slot.key, e?.message || String(e));
        }
    }, [slot, onValue, onError]);

    const onDrop = React.useCallback(async event => {
        event.preventDefault();
        setOver(false);
        if (disabled) return;
        // Claimed synchronously: a DataTransfer is emptied the moment the
        // handler yields, so `items` cannot be read after the first await.
        const { items, files } = event.dataTransfer;
        await accept(slot.folder ? { items } : { files });
    }, [accept, slot.folder, disabled]);

    const Icon = slot.icon;
    const state = error ? 'bad' : value ? 'ok' : 'empty';

    return (
        <div
            className={`slot ${over ? 'is-over' : ''}`}
            data-state={state}
            onDragOver={e => { e.preventDefault(); if (!disabled) setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
        >
            <button
                type="button"
                className="slot-hit"
                disabled={disabled}
                onClick={() => inputRef.current?.click()}
            >
                <span className="slot-icon"><Icon size="lg" /></span>
                <span className="slot-body">
                    <span className="slot-name">{slot.label}</span>
                    <span className="slot-what">{slot.hint}</span>
                </span>
                <span className="slot-mark">
                    {state === 'ok' && <IconCheck size="md" style={{ color: 'var(--ok)' }} />}
                    {state === 'bad' && <IconWarn size="md" style={{ color: 'var(--bad)' }} />}
                    {state === 'empty' && <IconUpload size="md" style={{ color: 'var(--muted)' }} />}
                </span>
            </button>

            {/* The status line is always in the flow, so filling a slot cannot
                reflow the grid under the reader's cursor. */}
            <div className="slot-status" data-state={state}>
                {error || (value ? value.summary : slot.empty)}
            </div>

            <input
                ref={inputRef}
                type="file"
                hidden
                accept={slot.accept}
                {...(slot.folder ? { webkitdirectory: '', directory: '' } : {})}
                onChange={e => { accept({ files: e.target.files }); e.target.value = ''; }}
            />
        </div>
    );
}

// ---------------------------------------------------------------------------
// The four inputs.
//
// Each reader returns `{ summary, ... }` — the summary is what the slot shows
// once it is filled, and the rest is what the build consumes. Validation is
// here rather than at build time on purpose: finding out that a catalog was
// actually a manifest after a 40-second extraction is the worst possible place
// to find it out.
// ---------------------------------------------------------------------------

const oneFile = ({ files }) => {
    const list = [...(files || [])];
    if (list.length !== 1) throw new Error('Drop a single file here.');
    return list[0];
};

/**
 * Which dbt artifact is this, really?
 *
 * Both files are called `<something>.json`, both are a `nodes` object, and both
 * come out of the same `target/` directory seconds apart — so putting the
 * catalog in the manifest slot is an ordinary mistake, not a careless one. A
 * name check cannot catch it either: people rename these (`manifest_prod.json`,
 * `catalog (1).json`) and dbt itself does not require the default names.
 *
 * So the answer comes from the content. `metadata.dbt_schema_version` is dbt's
 * own declaration of what it wrote — `.../dbt/manifest/v12.json` versus
 * `.../dbt/catalog/v1.json` — and is authoritative when present. When it is
 * absent (hand-trimmed fixtures, a very old dbt) the shape still tells them
 * apart: only a manifest carries `parent_map`/`child_map`/`macros`, and only a
 * catalog puts `stats` on every node.
 *
 * Returns 'manifest', 'catalog', or null when it is neither recognisably.
 */
function identifyDbtArtifact(parsed) {
    const version = parsed?.metadata?.dbt_schema_version;
    if (typeof version === 'string') {
        if (/\/manifest\//.test(version)) return 'manifest';
        if (/\/catalog\//.test(version)) return 'catalog';
    }
    if (parsed?.parent_map || parsed?.child_map || parsed?.macros) return 'manifest';
    const nodes = Object.values(parsed?.nodes || {});
    if (nodes.length > 0 && nodes.every(n => n && 'stats' in n)) return 'catalog';
    return null;
}

const ARTIFACT_NAME = { manifest: 'a dbt manifest', catalog: 'a dbt catalog' };

/** A dbt artifact: parsed once here so a wrong file is refused immediately. */
function dbtArtifact({ kind, needs, extra }) {
    return async payload => {
        const file = oneFile(payload);
        if (!file.name.toLowerCase().endsWith('.json')) {
            throw new Error(`${file.name} is not a .json file.`);
        }
        const text = await file.text();
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            throw new Error(`${file.name} is not valid JSON: ${e.message}`);
        }
        if (!parsed[needs]) {
            throw new Error(
                `${file.name} has no "${needs}" — is this really ${ARTIFACT_NAME[kind]}?`);
        }

        /*
         * Named before the generic complaint, because the two failures deserve
         * different sentences. "These are the wrong way round" is a fix the
         * reader can carry out in one drag; "this is not a manifest" leaves
         * them looking for a file they may already have picked.
         */
        const actual = identifyDbtArtifact(parsed);
        if (actual && actual !== kind) {
            throw new Error(
                `${file.name} is ${ARTIFACT_NAME[actual]}, not ${ARTIFACT_NAME[kind]} — ` +
                'the two slots are the wrong way round.');
        }
        if (!actual) {
            throw new Error(
                `${file.name} does not look like a dbt artifact — ` +
                `expected ${ARTIFACT_NAME[kind]} from your project's target/ directory.`);
        }

        return {
            text,
            summary: `${file.name} · ${formatSize(file.size)}${extra ? extra(parsed) : ''}`,
        };
    };
}

export const SLOTS = [
    {
        key: 'catalog',
        icon: IconDatabase,
        label: 'catalog.json',
        hint: 'dbt target/catalog.json',
        empty: 'Column types and the warehouse schema.',
        accept: '.json,application/json',
        read: dbtArtifact({ kind: 'catalog', needs: 'nodes' }),
    },
    {
        key: 'manifest',
        icon: IconJson,
        label: 'manifest.json',
        hint: 'dbt target/manifest.json',
        empty: 'Must contain compiled SQL — run dbt compile first.',
        accept: '.json,application/json',
        read: dbtArtifact({
            kind: 'manifest',
            needs: 'nodes',
            /*
             * The one check worth making before a build rather than after.
             *
             * A parse-only manifest is structurally perfect and yields zero
             * column lineage, and the resulting empty graph looks like a bug in
             * this tool rather than a missing `dbt compile`. Said here, it costs
             * the reader one line; said afterwards, it costs them the run.
             */
            extra: parsed => (
                Object.values(parsed.nodes || {}).some(n => n?.compiled_code)
                    ? ''
                    : ' · no compiled SQL — run `dbt compile` and re-export'
            ),
        }),
    },
    {
        key: 'mapping',
        icon: IconSheet,
        label: 'mapping.csv',
        hint: 'warehouse → Power BI mapping',
        // Spelled out on this one slot only: it is the input a reader is most
        // likely to think of as a nice-to-have, and it is not — the renames it
        // carries are links no amount of parsing can derive.
        empty: 'Required. Rows for renames automatic matching cannot find.',
        accept: '.csv',
        read: async payload => {
            const file = oneFile(payload);
            if (!/\.csv$/i.test(file.name)) {
                throw new Error(`${file.name} is not a .csv file.`);
            }
            // Headers are validated by the reader that owns them, at build
            // time — duplicating that rule here is how the two drift apart.
            return {
                name: file.name,
                data: await file.text(),
                summary: `${file.name} · ${formatSize(file.size)}`,
            };
        },
    },
    {
        key: 'pbip',
        icon: IconFolder,
        label: 'Power BI project folder',
        hint: 'the folder holding .Report and .SemanticModel',
        empty: 'Read in place — nothing is uploaded.',
        folder: true,
        read: async payload => {
            const picked = payload.items
                ? await readDroppedEntries(payload.items)
                : await readDirectoryInput(payload.files);

            if (!picked) throw new Error('Drop the project folder itself, not the files inside it.');
            const { rootName, files } = picked;

            const model = rootName.endsWith('.SemanticModel')
                ? rootName
                : [...new Set(Object.keys(files).map(p => p.split('/')[0]))]
                    .find(d => d.endsWith('.SemanticModel'));
            if (!model) {
                throw new Error(
                    `No .SemanticModel folder in ${rootName} — pick the project root, ` +
                    'the folder holding <name>.SemanticModel and <name>.Report.');
            }

            const count = Object.keys(files).length;
            return { rootName, files, summary: `${rootName} · ${count} files read` };
        },
    },
];
