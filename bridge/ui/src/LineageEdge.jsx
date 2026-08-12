import React from 'react';
import { BaseEdge, getBezierPath, Position } from '@xyflow/react';

/*
 * The same control-point formula getBezierPath uses internally, replicated
 * here because @xyflow/system does not export it. Needed to find the curve's
 * tangent at its midpoint — getBezierPath only hands back the midpoint's
 * coordinates, not its direction.
 */
function controlOffset(distance, curvature) {
    return distance >= 0 ? 0.5 * distance : curvature * 25 * Math.sqrt(-distance);
}
function control(pos, x1, y1, x2, y2, curvature) {
    switch (pos) {
        case Position.Left: return [x1 - controlOffset(x1 - x2, curvature), y1];
        case Position.Right: return [x1 + controlOffset(x2 - x1, curvature), y1];
        case Position.Top: return [x1, y1 - controlOffset(y1 - y2, curvature)];
        case Position.Bottom: return [x1, y1 + controlOffset(y2 - y1, curvature)];
        default: return [x1, y1];
    }
}

// Cubic bezier derivative at t=0.5, i.e. the curve's direction through its
// own midpoint — the angle a chevron sitting there has to match to look like
// part of the line rather than a sticker on top of it.
function tangentAngle(p0, p1, p2, p3) {
    const dx = 0.75 * (p1[0] - p0[0]) + 1.5 * (p2[0] - p1[0]) + 0.75 * (p3[0] - p2[0]);
    const dy = 0.75 * (p1[1] - p0[1]) + 1.5 * (p2[1] - p1[1]) + 0.75 * (p3[1] - p2[1]);
    return Math.atan2(dy, dx) * (180 / Math.PI);
}

// A slim open chevron, stroke-only so it reads as a kink in the line rather
// than a separate glyph. Sized in local units, then translated/rotated onto
// the edge's midpoint.
const CHEVRON = 'M -3.5 -4 L 3.5 0 L -3.5 4';

export default function LineageEdge({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, style, markerEnd,
}) {
    const curvature = 0.25;
    const [path, labelX, labelY] = getBezierPath({
        sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature,
    });

    const p0 = [sourceX, sourceY];
    const p3 = [targetX, targetY];
    const p1 = control(sourcePosition, sourceX, sourceY, targetX, targetY, curvature);
    const p2 = control(targetPosition, targetX, targetY, sourceX, sourceY, curvature);
    const angle = tangentAngle(p0, p1, p2, p3);

    return (
        <>
            <BaseEdge path={path} style={style} markerEnd={markerEnd} />
            <path
                d={CHEVRON}
                className="lineage-edge-arrow"
                transform={`translate(${labelX} ${labelY}) rotate(${angle})`}
            />
        </>
    );
}
