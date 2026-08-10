import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../App';
import Landing from './Landing';
import { useStore } from '../store';
import { registerServiceWorker } from './register-sw';
import '@xyflow/react/dist/style.css';
import '../styles.css';

// Same reason as src/main.jsx: stamp the default theme before the first paint,
// so a reader on a dark-mode machine does not open a dark page that the toggle's
// first press then fails to visibly change.
document.documentElement.setAttribute('data-theme', 'light');

/**
 * One screen, one store.
 *
 * There is no router: the only transition this app has is "there is now a graph",
 * which the store already knows. A route would add a URL the reader could reload
 * — straight back to a landing page, because the graph lives in memory and their
 * files were never uploaded.
 *
 * The app is mounted from the first paint and the landing page sits on top of it
 * as a modal, so the reader can see the product they are about to get rather
 * than a gate in front of it. `<App/>` renders fine against `EMPTY()` — no
 * nodes, no pages tab, the canvas on its own empty state — so there is nothing
 * to special-case here.
 *
 * `inert` is what makes the app behind the modal genuinely unreachable: no
 * focus, no pointer, and nothing for a screen reader to walk into. The card also
 * traps Tab itself, for the one browser that has not shipped `inert`.
 */
function Root() {
    const hasGraph = useStore(s => s.hasGraph);
    return (
        <>
            {/* Empty string, not `true`: React 18 does not know `inert` as a
                boolean attribute and would render inert="true"/inert="false" —
                and inert="false" is still inert. */}
            <div className="app-under" inert={hasGraph ? undefined : ''}>
                <App />
            </div>
            {!hasGraph && <Landing />}
        </>
    );
}

createRoot(document.getElementById('root')).render(<Root />);

// After mount, never before: the runtime cache is an optimisation for the next
// visit, and nothing on this one should wait behind it.
registerServiceWorker();
