import React, { useCallback, useEffect, useRef, useState } from 'react';
import { IconGrip } from './icons';

/**
 * Drag handle between a side panel and the canvas.
 *
 * Widths are session-only by design: the default is a clamp() that already
 * suits the window, and persisting a pixel value would mean a report opened on
 * a laptop remembers a size chosen on an ultrawide. Double-click clears the
 * override and hands control back to the clamp.
 */
export default function Resizer({ side, width, onChange, min, max }) {
    const [dragging, setDragging] = useState(false);
    const state = useRef(null);

    const onPointerDown = useCallback(e => {
        const el = e.currentTarget.parentElement;
        const panel = side === 'left' ? el.firstElementChild : el.lastElementChild;
        state.current = { x: e.clientX, w: width ?? panel.getBoundingClientRect().width };
        setDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
    }, [side, width]);

    useEffect(() => {
        if (!dragging) return;
        const move = e => {
            const delta = e.clientX - state.current.x;
            const next = state.current.w + (side === 'left' ? delta : -delta);
            onChange(Math.round(Math.min(max, Math.max(min, next))));
        };
        const up = () => setDragging(false);
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        // The canvas swallows the cursor otherwise, and text selects mid-drag.
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        return () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
    }, [dragging, side, min, max, onChange]);

    return (
        <div
            data-testid={`resizer-${side}`}
            className={`resizer ${dragging ? 'is-active' : ''}`}
            role="separator"
            aria-orientation="vertical"
            onPointerDown={onPointerDown}
            onDoubleClick={() => onChange(null)}
            title="Drag to resize · double-click to reset"
        >
            <IconGrip size={14} />
        </div>
    );
}
