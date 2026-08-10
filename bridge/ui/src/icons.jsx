/**
 * The icon set, in one place.
 *
 * Sourced from Lucide (ISC licence) rather than hand-copied paths: the spec
 * called for an inline SVG subset, and this is that — lucide-react renders
 * inline `<svg>` with `stroke: currentColor` and tree-shakes to only the
 * glyphs imported here. Nothing is fetched at runtime, so the report stays
 * self-contained. Hand-transcribing 30 path definitions would have been the
 * same output with more opportunities to get a `d` attribute subtly wrong.
 *
 * Components import from here, never from lucide-react directly, so the size
 * scale and stroke weight stay in one file.
 */
import React from 'react';
import {
    Database, Table2, Box, Camera, Layers, Sigma, BarChart3,
    ChevronRight, ChevronDown, Plus, Minus, ArrowLeft, ArrowRight,
    Search, X, Maximize2, Sun, Moon, AlertTriangle, CheckCircle2,
    Info, GripVertical, Link2, FileCode, Hash, Type, Calendar,
    HelpCircle, Eye, EyeOff, ListFilter, CircleDot,
    Sprout, ExternalLink, ShieldCheck, Grid3x3, CopyPlus, Ghost,
    TrendingUp, Rows3, MessageSquare, Palette, Crosshair, RotateCcw,
    Loader2, Flame, LayoutDashboard,
    FileJson, FileSpreadsheet, FolderOpen, Lock, Upload, Download,
} from 'lucide-react';

/** Matches --icon-sm / --icon-md / --icon-lg in styles.css. */
export const SIZE = { sm: 14, md: 18, lg: 22, xl: 26 };

const wrap = Component => function Icon({ size = 'md', className = '', style, ...rest }) {
    const px = typeof size === 'number' ? size : SIZE[size];
    return (
        <Component
            width={px}
            height={px}
            strokeWidth={px >= 24 ? 1.75 : 2}
            className={`flex-none ${className}`}
            style={style}
            aria-hidden="true"
            {...rest}
        />
    );
};

export const IconDatabase = wrap(Database);
export const IconTable = wrap(Table2);
export const IconModel = wrap(Box);
export const IconSnapshot = wrap(Camera);
export const IconLayers = wrap(Layers);
export const IconMeasure = wrap(Sigma);
export const IconVisual = wrap(BarChart3);
export const IconChevronRight = wrap(ChevronRight);
export const IconChevronDown = wrap(ChevronDown);
export const IconPlus = wrap(Plus);
export const IconMinus = wrap(Minus);
export const IconArrowLeft = wrap(ArrowLeft);
export const IconArrowRight = wrap(ArrowRight);
export const IconSearch = wrap(Search);
export const IconX = wrap(X);
export const IconFit = wrap(Maximize2);
export const IconSun = wrap(Sun);
export const IconMoon = wrap(Moon);
export const IconWarn = wrap(AlertTriangle);
export const IconCheck = wrap(CheckCircle2);
export const IconInfo = wrap(Info);
export const IconGrip = wrap(GripVertical);
export const IconLink = wrap(Link2);
export const IconCode = wrap(FileCode);
export const IconNumeric = wrap(Hash);
export const IconText = wrap(Type);
export const IconDate = wrap(Calendar);
export const IconUnknown = wrap(HelpCircle);
export const IconShow = wrap(Eye);
export const IconHide = wrap(EyeOff);
export const IconFilter = wrap(ListFilter);
export const IconDot = wrap(CircleDot);

export const IconSeed = wrap(Sprout);
export const IconExposure = wrap(ExternalLink);
export const IconTest = wrap(ShieldCheck);
export const IconView = wrap(Eye);
export const IconPhysical = wrap(Grid3x3);
export const IconIncremental = wrap(CopyPlus);
export const IconEphemeral = wrap(Ghost);
export const IconAxis = wrap(TrendingUp);
export const IconCategory = wrap(Rows3);
export const IconTooltip = wrap(MessageSquare);
export const IconFormat = wrap(Palette);
export const IconTarget = wrap(Crosshair);
export const IconReset = wrap(RotateCcw);
export const IconSpinner = wrap(Loader2);
export const IconBlast = wrap(Flame);
export const IconPage = wrap(LayoutDashboard);

// The landing page: what you hand the tool, and the promise about where it goes.
export const IconJson = wrap(FileJson);
export const IconSheet = wrap(FileSpreadsheet);
export const IconFolder = wrap(FolderOpen);
export const IconLock = wrap(Lock);
export const IconUpload = wrap(Upload);
// The header's Export control: the graph on screen, saved as one file.
export const IconDownload = wrap(Download);

/** One glyph per node kind — the signal that keeps colour from being the only cue. */
export const KIND_ICON = {
    source: IconDatabase,
    model: IconModel,
    snapshot: IconSnapshot,
    pbiTable: IconTable,
    page: IconPage,
    measure: IconMeasure,
    visual: IconVisual,
    unknown: IconUnknown,
};

/**
 * The glyph for a *node*, which is finer-grained than its kind.
 *
 * `kind` is only ever model | source | pbiTable | measure | visual — every dbt
 * resource that is not a source arrives as `model`. What actually distinguishes
 * a seed from a snapshot from an incremental table lives in meta.resourceType
 * and meta.materialized, so resolve against those first.
 *
 * Shape carries materialization; colour stays keyed to kind (see theme.js), so
 * nine glyphs do not become nine colours.
 */
const RESOURCE_ICON = {
    seed: IconSeed,
    snapshot: IconSnapshot,
    exposure: IconExposure,
    test: IconTest,
    source: IconDatabase,
};

const MATERIALIZED_ICON = {
    view: IconView,
    table: IconPhysical,
    incremental: IconIncremental,
    ephemeral: IconEphemeral,
    materialized_view: IconPhysical,
};

export function nodeIcon(node) {
    const m = node.meta || {};
    return RESOURCE_ICON[m.resourceType]
        || MATERIALIZED_ICON[m.materialized]
        || KIND_ICON[node.kind]
        || IconUnknown;
}

/*
 * A glyph for a Power BI visual type, for the page-layout wireframe.
 *
 * Matched on substrings rather than exhaustively: a real report is mostly
 * custom visuals — `ChicletSlicer1448559807354` is the single most common type
 * on the project this was built against — and a table of exact names would be
 * a table of one project's imports. The families below are the ones whose
 * shape a reader recognises; everything else is honestly a rectangle.
 */
const VISUAL_ICON = [
    [/slicer|chiclet/i, IconFilter],
    [/table|matrix|pivot/i, IconTable],
    [/card|kpi/i, IconNumeric],
    [/textbox|text/i, IconText],
    [/shape|image/i, IconFormat],
    [/navigator|button|action/i, IconTarget],
    [/line|area|waterfall/i, IconAxis],
    [/bar|column|combo|histogram/i, IconVisual],
    [/pie|donut|treemap|funnel|gauge/i, IconCategory],
];

export function visualIcon(visualType) {
    for (const [re, Icon] of VISUAL_ICON) if (re.test(visualType || '')) return Icon;
    return IconVisual;
}

/** What a Power BI visual does with a field. Unknown roles fall back to a dot. */
export const ROLE_ICON = {
    Y: IconAxis,
    Y2: IconAxis,
    Category: IconCategory,
    Series: IconLayers,
    Tooltips: IconTooltip,
    filter: IconFilter,
    conditionalFormatting: IconFormat,
    Values: IconAxis,
    Data: IconAxis,
    measure: IconMeasure,
    Rows: IconCategory,
    Columns: IconCategory,
    category: IconCategory,
    Group: IconLayers,
    containerObjects: IconModel,
};

/** Column data types, coarsely bucketed from whatever the catalog reported. */
export function columnIcon(dataType) {
    const t = String(dataType || '').toLowerCase();
    if (/int|num|dec|float|double|real|money|bignum/.test(t)) return IconNumeric;
    if (/date|time|stamp/.test(t)) return IconDate;
    if (/char|string|text|utf/.test(t)) return IconText;
    return IconDot;
}
