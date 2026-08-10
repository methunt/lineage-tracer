import React from 'react';
import Logo from '../Logo';
import FileSlot, { SLOTS } from './FileSlot';
import { useProjectBuild } from './useProjectBuild';
import { loadSampleValues } from './sample';
import {
    IconLock, IconArrowRight, IconSpinner, IconWarn, IconCheck,
    IconLink, IconBlast, IconPage, IconLayers, IconSeed,
} from '../icons';

/* What can be reached with Tab inside the card. The file inputs are hidden by
   design — the slot button is the control — so anything not laid out is
   filtered out below rather than listed here. */
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Where the tool opens.
 *
 * One card, the same card the views sit on — but now over the app rather than
 * instead of it: the canvas, the rail and the header are behind the blur, so
 * what the reader is being asked for four files *for* is on screen while they
 * are asked. The ordering inside is still the reader's question first — what
 * does this do, and where do my files go — then the four inputs, then the one
 * button.
 *
 * There is no marketing above the fold and no tour: the four slots are the
 * interface, and anything that pushes them below the first screen is asking
 * someone to scroll past the product to reach it.
 *
 * There is deliberately no close affordance. All four inputs are required and
 * there is nothing behind this to use, so a dismiss — a button, an Escape, a
 * click on the backdrop — could only ever strand someone in an app with no
 * graph and no way back.
 */
export default function Landing() {
    const [values, setValues] = React.useState({});
    const [errors, setErrors] = React.useState({});
    const [sampleError, setSampleError] = React.useState(null);
    const [loadingSample, setLoadingSample] = React.useState(false);
    const { run, busy, lines, error, runtimeReady } = useProjectBuild();
    const cardRef = React.useRef(null);

    /*
     * Modal for real, not just visually.
     *
     * `inert` on the app (see web/main.jsx) is what takes the background out of
     * the tab order and out of the accessibility tree; this adds the two things
     * inert does not do — put focus *into* the card on mount, and stop the page
     * behind from scrolling under it — plus a Tab cycle of its own, so the trap
     * holds even where `inert` is not supported.
     */
    React.useEffect(() => {
        const card = cardRef.current;
        if (!card) return undefined;
        // The card itself, not the first slot: opening focus on a control skips
        // past the title and the four claims that explain what the slot is for.
        card.focus({ preventScroll: true });
        document.documentElement.classList.add('landing-open');

        const onKey = e => {
            if (e.key !== 'Tab') return;
            const stops = [...card.querySelectorAll(FOCUSABLE)]
                .filter(el => !el.disabled && el.offsetParent !== null);
            const first = stops[0];
            const last = stops[stops.length - 1];
            // Nothing to move to (every control disabled mid-build): hold focus
            // on the card rather than letting Tab escape to the browser chrome
            // and back into a page that is not supposed to be reachable.
            if (!first) { e.preventDefault(); card.focus(); return; }
            const at = document.activeElement;
            if (e.shiftKey && (at === first || at === card)) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && at === last) {
                e.preventDefault();
                first.focus();
            }
        };
        card.addEventListener('keydown', onKey);
        return () => {
            card.removeEventListener('keydown', onKey);
            document.documentElement.classList.remove('landing-open');
        };
    }, []);

    const onValue = React.useCallback((key, value) => {
        setValues(prev => ({ ...prev, [key]: value }));
    }, []);
    const onError = React.useCallback((key, message) => {
        setErrors(prev => ({ ...prev, [key]: message }));
    }, []);

    const ready = SLOTS.every(s => values[s.key]);
    const missing = SLOTS.filter(s => !values[s.key]).length;

    /*
     * Fill the four slots and build, in one press.
     *
     * It runs rather than stopping at four filled slots on purpose: someone who
     * clicked this is asking to see the tool work, and leaving them in front of
     * a second button is asking them to confirm the thing they just asked for.
     * The slots still fill visibly first, so what the build ran on is on screen
     * and swapping one of them for a real file is an ordinary next step.
     */
    const trySample = React.useCallback(async () => {
        setLoadingSample(true);
        setSampleError(null);
        try {
            const sample = await loadSampleValues();
            setErrors({});
            setValues(sample);
            await run(sample);
        } catch (e) {
            setSampleError(e?.message || String(e));
        } finally {
            setLoadingSample(false);
        }
    }, [run]);

    const working = busy || loadingSample;

    return (
        <>
            <BackdropGraph />
            <div className="landing">
            <div
                className="landing-card"
                ref={cardRef}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-labelledby="landing-title"
                aria-describedby="landing-sub"
            >
                <header className="landing-head">
                    <Logo size={44} />
                    <h1 className="landing-title" id="landing-title">Lineage Tracer</h1>
                    <p className="landing-sub" id="landing-sub">
                        Trace a column from the dbt model that builds it to the Power BI
                        visual that renders it — through Power Query renames, measures
                        and calculation groups.
                    </p>
                </header>

                <ul className="landing-points">
                    <Point icon={IconLink} title="Source to visual">
                        One click from a warehouse column to every report that shows it.
                    </Point>
                    <Point icon={IconBlast} title="Impact analysis">
                        What breaks if this column changes, before it changes.
                    </Point>
                    <Point icon={IconPage} title="Page layout">
                        The affected visuals, in place on the pages they live on.
                    </Point>
                    <Point icon={IconLayers} title="Diagnostics">
                        Every table, column and mapping row that resolved to nothing.
                    </Point>
                </ul>

                <div className="landing-privacy">
                    <IconLock size="sm" />
                    <span>
                        Everything runs in this tab. Your manifest, catalog, mapping and
                        report are read in the browser and never uploaded.
                    </span>
                </div>

                <div className="landing-slots">
                    {SLOTS.map(slot => (
                        <FileSlot
                            key={slot.key}
                            slot={slot}
                            value={values[slot.key]}
                            error={errors[slot.key]}
                            onValue={onValue}
                            onError={onError}
                            disabled={working}
                        />
                    ))}
                </div>

                <div className="landing-go">
                    <button
                        type="button"
                        className="landing-build"
                        disabled={!ready || working}
                        onClick={() => run(values)}
                    >
                        {busy
                            ? <><IconSpinner size="md" className="spin" /> Building…</>
                            : <>Build lineage <IconArrowRight size="md" /></>}
                    </button>

                    {/* Secondary, and quiet: the four slots are still the way in
                        for anyone who brought their own project. This is for the
                        reader who has none of the four to hand and would
                        otherwise leave without seeing anything. */}
                    <button
                        type="button"
                        className="landing-sample"
                        disabled={working}
                        onClick={trySample}
                    >
                        {loadingSample
                            ? <><IconSpinner size="sm" className="spin" /> Loading sample…</>
                            : <><IconSeed size="sm" /> Try with sample data</>}
                    </button>

                    <span className="landing-note">
                        {/* Counted up, not down: "4 of 4 still needed" on an
                            untouched page reads as a warning about something
                            you have already done wrong. */}
                        {working ? null : ready
                            ? 'Nothing leaves your browser.'
                            : `${SLOTS.length - missing} of ${SLOTS.length} ready`}
                    </span>

                    {/* The runtime download is the one thing happening that the
                        reader did not start, so it is the one thing worth
                        reporting unasked — quietly, and only once it is done. */}
                    <span className="landing-runtime" data-ready={runtimeReady || undefined}>
                        {runtimeReady
                            ? <><IconCheck size="sm" /> Python runtime ready</>
                            : <><IconSpinner size="sm" className="spin" /> Fetching Python runtime…</>}
                    </span>
                </div>

                {(error || sampleError) && (
                    <div className="landing-error">
                        <IconWarn size="md" />
                        <div>{error || sampleError}</div>
                    </div>
                )}

                {(busy || lines.length > 0) && (
                    <pre className="landing-log mono">{lines.join('\n')}</pre>
                )}
            </div>
            </div>
        </>
    );
}

/*
 * The picture behind the blur.
 *
 * The app really is mounted underneath, but with no graph the canvas is its own
 * empty state on a dotted ground, and an empty state blurred to 14px is a grey
 * rectangle — worse than the flat panel it replaced. So a small lineage runs
 * across the ground: source, two models, a table, a measure, a visual, in the
 * kind colours the real canvas uses.
 *
 * Drawn, not seeded. Putting a demo graph through `loadGraph` would have made
 * this the same eight lines of JSX and a much worse idea: `hasGraph` would flip,
 * the rail and the tabs would fill with fiction, and the first thing the reader
 * did after building would be to wonder which of the two graphs was theirs. This
 * is one inert SVG — no store, no ids, nothing that can survive the modal
 * closing, `aria-hidden` and `pointer-events: none` so it can be neither
 * reached nor clicked, and unmounted with the landing page the moment a real
 * graph arrives.
 */
function BackdropGraph() {
    return (
        <div className="landing-art" aria-hidden="true">
            {/* `slice`, and a viewBox the shape of a laptop window: the point of
                this drawing is the part of it the card does *not* cover, so it
                has to reach the edges of the screen rather than be letterboxed
                into the middle where the card is. */}
            <svg viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" focusable="false">
                {/* Edges first so the cards sit on them, as on the canvas. */}
                <g className="landing-art-edges">
                    {EDGES.map(([a, b], i) => <path key={i} d={link(CARDS[a], CARDS[b])} />)}
                </g>
                {CARDS.map((card, i) => (
                    <g key={i} className="landing-art-card" style={{ color: card.color }}>
                        <rect x={card.x} y={card.y} width={CARD_W} height={CARD_H} rx="10" />
                        <rect x={card.x} y={card.y} width="4" height={CARD_H} rx="2"
                            className="landing-art-edge-mark" />
                        <rect x={card.x + 18} y={card.y + 16} width={card.w1} height="9" rx="4.5"
                            className="landing-art-line is-strong" />
                        <rect x={card.x + 18} y={card.y + 34} width={card.w2} height="7" rx="3.5"
                            className="landing-art-line" />
                    </g>
                ))}
            </svg>
        </div>
    );
}

const CARD_W = 168;
const CARD_H = 58;

/*
 * Five lanes, left to right, exactly as the canvas lays a pipeline out — but
 * placed against where the card lands rather than against the middle of the
 * drawing. At 1440x900 the card covers x 290–1150, so lanes 0 and 4 sit clear
 * of it in the gutters, lane 1 straddles its left edge, and the two inner lanes
 * are deliberately behind it: a pipeline that visibly continues under the card
 * reads as a graph the card is sitting on, which is the whole idea.
 */
const CARDS = [
    { x: 30, y: 118, color: 'var(--kind-source)', w1: 96, w2: 62 },
    { x: 30, y: 430, color: 'var(--kind-source)', w1: 82, w2: 74 },
    { x: 30, y: 706, color: 'var(--kind-source)', w1: 88, w2: 56 },
    { x: 244, y: 196, color: 'var(--kind-model)', w1: 104, w2: 58 },
    { x: 244, y: 578, color: 'var(--kind-model)', w1: 88, w2: 70 },
    { x: 620, y: 386, color: 'var(--kind-table)', w1: 100, w2: 66 },
    { x: 930, y: 214, color: 'var(--kind-measure)', w1: 84, w2: 54 },
    { x: 930, y: 560, color: 'var(--kind-table)', w1: 92, w2: 60 },
    { x: 1218, y: 132, color: 'var(--kind-visual)', w1: 92, w2: 60 },
    { x: 1218, y: 424, color: 'var(--kind-visual)', w1: 78, w2: 68 },
    { x: 1218, y: 704, color: 'var(--kind-measure)', w1: 86, w2: 52 },
];

const EDGES = [
    [0, 3], [1, 3], [1, 4], [2, 4],
    [3, 5], [4, 5],
    [5, 6], [5, 7],
    [6, 8], [6, 9], [7, 9], [7, 10],
];

/** A right-to-left bezier between two cards, the shape the canvas draws. */
function link(a, b) {
    const x1 = a.x + CARD_W;
    const y1 = a.y + CARD_H / 2;
    const x2 = b.x;
    const y2 = b.y + CARD_H / 2;
    const bend = (x2 - x1) / 2;
    return `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
}

function Point({ icon: Icon, title, children }) {
    return (
        <li className="landing-point">
            <Icon size="md" />
            <div>
                <div className="landing-point-title">{title}</div>
                <div className="landing-point-body">{children}</div>
            </div>
        </li>
    );
}
