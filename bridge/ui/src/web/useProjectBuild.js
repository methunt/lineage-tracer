import React from 'react';
import { useStore } from '../store';

/**
 * The build, from four files to a rendered graph.
 *
 * Two halves. The dbt half runs in the Pyodide worker because it is Python and
 * because it is seconds of solid CPU; the Power BI half and the merge run here,
 * on the same modules the CLI uses, because they are already pure JavaScript
 * over strings and shipping them into the worker as well would mean two copies
 * of every parser.
 *
 * The worker is started — and told to download its runtime — as soon as this
 * mounts, not when the user presses Build. Picking four files takes long enough
 * to hide most of a 7 MB download behind it, and a progress bar you never see
 * is worth more than a fast one you do.
 */
export function useProjectBuild() {
    const loadGraph = useStore(s => s.loadGraph);

    const workerRef = React.useRef(null);
    const [runtimeReady, setRuntimeReady] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [lines, setLines] = React.useState([]);
    const [error, setError] = React.useState(null);

    const say = React.useCallback(message => {
        setLines(prev => [...prev, message]);
    }, []);

    React.useEffect(() => {
        const worker = new Worker(new URL('./dbt-worker.js', import.meta.url), { type: 'module' });
        workerRef.current = worker;
        return () => worker.terminate();
    }, []);

    const nextId = React.useRef(0);

    /**
     * One request/response over the worker, with its log lines relayed.
     *
     * Replies are matched by id, because two requests really are in flight at
     * once whenever someone picks their files faster than the runtime
     * downloads: the warm-up is still running when Build is pressed, and a
     * handler that took the first reply it saw would take the warm-up's.
     */
    const askWorker = React.useCallback((message, onLog) => new Promise((resolve, reject) => {
        const worker = workerRef.current;
        const id = ++nextId.current;
        const handler = ({ data }) => {
            // Logs are the worker's, not any one request's — the runtime
            // download narrates itself and belongs on screen either way.
            if (data.type === 'log') { onLog?.(data.message); return; }
            if (data.id !== id) return;
            worker.removeEventListener('message', handler);
            if (data.type === 'error') reject(new Error(data.message));
            else resolve(data);
        };
        worker.addEventListener('message', handler);
        // The worker is served from the hashed assets directory and cannot work
        // out where the page's own `py/` assets are; only the document knows.
        worker.postMessage({ ...message, id, baseUrl: document.baseURI });
    }), []);

    // Warm-up runs on its own, quietly: it has nothing to say unless it fails,
    // and a failure here is not fatal until a build actually needs the runtime.
    React.useEffect(() => {
        let live = true;
        askWorker({ type: 'warm' }).then(
            () => { if (live) setRuntimeReady(true); },
            () => { /* reported when a build asks for it */ },
        );
        return () => { live = false; };
    }, [askWorker]);

    const run = React.useCallback(async slots => {
        setBusy(true);
        setError(null);
        setLines([]);
        try {
            const dbt = await askWorker({
                type: 'extract',
                manifestText: slots.manifest.text,
                catalogText: slots.catalog.text,
            }, say);

            // Loaded here, on demand: the bridge modules are the whole parser
            // set and don't belong in the bundle that renders the landing page.
            //
            // `.default || m`: this is a CommonJS module, and the two halves of
            // the build interop with it differently. The bundler synthesises
            // named exports, so a build gets `{ buildInBrowser }` directly; the
            // dev server's converter puts `module.exports` on `default` and
            // nothing else — where destructuring quietly yields undefined and
            // fails one call later as "not a function".
            const bridge = await import('../../../src/build-browser.js').then(m => m.default || m);
            const { buildInBrowser, toReportData } = bridge;

            const graph = await buildInBrowser({
                files: slots.pbip.files,
                rootName: slots.pbip.rootName,
                dbtGraph: dbt.graph,
                mappingData: slots.mapping.data,
                mappingName: slots.mapping.name,
                log: say,
            });

            loadGraph(toReportData(graph));
        } catch (e) {
            setError(e?.message || String(e));
            setBusy(false);
        }
    }, [askWorker, say, loadGraph]);

    return { run, busy, lines, error, runtimeReady };
}
