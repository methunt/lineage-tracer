import React from 'react';

/**
 * The product mark: a warehouse cylinder whose base breaks into three ascending
 * bars — storage becoming a report, which is the whole tool in one silhouette.
 *
 * One shape rather than two glyphs side by side: at favicon size two marks turn
 * to mush, and this has to survive 16px. The gradient runs indigo → cyan, the
 * same sweep as --kind-model → --layer-0, so the mark belongs to the palette
 * rather than sitting next to it.
 *
 * The gradient id is instance-scoped: two <Logo/>s on one page with the same id
 * would have the second silently reuse the first's stops.
 */
export default function Logo({ size = 28, title = 'Lineage Tracer', className }) {
    const id = React.useId().replace(/:/g, '');
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={title} className={className}>
            <defs>
                <linearGradient id={`lg-${id}`} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#6366f1" />
                    <stop offset="55%" stopColor="#3b82f6" />
                    <stop offset="100%" stopColor="#22d3ee" />
                </linearGradient>
            </defs>
            {/* Cylinder: top disc plus the body it sits on. */}
            <ellipse cx="12" cy="5" rx="7.5" ry="2.9" fill={`url(#lg-${id})`} />
            <path d="M4.5 5v4.4c0 1.6 3.36 2.9 7.5 2.9s7.5-1.3 7.5-2.9V5"
                fill={`url(#lg-${id})`} opacity=".55" />
            {/* Base breaking into a bar chart. */}
            <rect x="4" y="17" width="3.6" height="4.6" rx="1.1" fill={`url(#lg-${id})`} />
            <rect x="10.2" y="14.4" width="3.6" height="7.2" rx="1.1" fill={`url(#lg-${id})`} />
            <rect x="16.4" y="11.6" width="3.6" height="10" rx="1.1" fill={`url(#lg-${id})`} />
        </svg>
    );
}
