# Lineage Bridge — design system

The contract for how the report looks and moves. Written before the components,
so that "modern" means a set of decisions rather than a set of opinions.

Every value here is a CSS custom property in `ui/src/styles.css`. Components
reference tokens, never literals — a colour or size that appears inline in a
`.jsx` file is a bug in this spec's application.

**Governing constraint.** The report is a single self-contained HTML file with
no network access. Fonts, icons and images are inlined as bytes. Nothing may be
fetched at runtime. Every decision below pays for itself in kilobytes.

---

## 1. Typeface

| Role | Family | Inlined size |
|---|---|---|
| UI | **Inter Variable**, Latin subset, wght 400–700 | ~48 KB woff2 |
| Code, identifiers | **JetBrains Mono**, Latin subset, wght 400–500 | ~35 KB woff2 |

Both OFL-1.1; licence text ships in `docs/NOTICES`. Fallback stacks stay in
place for the dev server, which loads the fonts as files rather than base64.

```css
--font-ui:   "Inter var", -apple-system, "Segoe UI", Roboto, sans-serif;
--font-mono: "JetBrains Mono var", ui-monospace, "Cascadia Mono", Consolas, monospace;
```

Mono is not decoration. It marks **things that are identifiers** — relations,
column names, SQL, DAX, M — because those are strings the reader may need to
copy exactly, and proportional rendering of `net_revenue_amt` invites
misreading.

**Inter settings:** `font-feature-settings: "cv05" 1, "ss03" 1` (single-storey
`l` disambiguated from `1`, and a squarer `g`), `font-variant-numeric:
tabular-nums` on every count, KPI and metric so digits do not jitter as they
change.

---

## 2. Type scale

12px floor. A scale that bottoms out at 10px uppercase is the actual legibility
failure — small *and* tracked *and* low-contrast at once.

| Token | Size / line | Weight | Used for |
|---|---|---|---|
| `--fs-display` | 30 / 34 | 650 | KPI figures |
| `--fs-h1` | 19 / 26 | 640 | App title |
| `--fs-h2` | 16 / 22 | 620 | Side-panel node name |
| `--fs-h3` | 14 / 20 | 600 | Section headers, node card title |
| `--fs-body` | 13 / 20 | 400 | Panel prose, table cells |
| `--fs-sm` | 12 / 18 | 400 | Subtitles, chips, tree rows, KPI labels |
| `--fs-code` | 12.5 / 20 | 400 | Mono identifiers, SQL blocks |

**Nothing renders below 12px.** Section labels keep uppercase and `0.06em`
tracking but sit at 12px / weight 600 / `--text-2` rather than 10px / `--muted`
— the combination is what makes them vanish.

Node card title is `--fs-h3` (14px), subtitle `--fs-sm` (12px). The card is
**64px** collapsed and `WIDTH` **248px**, which keeps long model names on one
line. That fits roughly 25% fewer nodes per screen; accepted deliberately in
exchange for a canvas you can read without zooming.

---

## 3. Colour

Neutral slate ground, one indigo accent, semantic colours reserved for meaning.
**Every value below was measured, not estimated** — ratios are WCAG 2.1 against
both surface tokens.

### 3.1 Light (default)

```css
--bg:            #eef1f6;   /* canvas ground */
--panel:         #ffffff;
--panel-2:       #f1f4f8;   /* insets, hover, code blocks */
--border:        #dfe4ec;
--border-strong: #c6ceda;   /* resize handles, focus outlines */
--text:          #0f1826;   /* 17.8 : 1 */
--text-2:        #47536b;   /*  7.7 : 1  — secondary prose, section labels */
--muted:         #626e82;   /*  5.2 : 1  — never below this grey */
--accent:        #4f46e5;   /*  6.3 : 1 */
--accent-soft:   #eef0fe;
--ok:            #047857;   /*  5.5 : 1 */
--warn:          #b45309;   /*  5.0 : 1 */
--bad:           #be123c;   /*  6.3 : 1 */
```

`--muted` is the floor for any grey text. The obvious slate at `#64748b`
measures **4.23 : 1** on `--panel-2` — below AA for normal text, and a grey at
that level ends up carrying almost every label in the chrome.

### 3.2 Dark

```css
--bg: #0e131a;  --panel: #161c24;  --panel-2: #1e252f;
--border: #2b333f;  --border-strong: #3d4756;
--text: #e8eef7;  --text-2: #a7b4c6;  --muted: #8b98ab;   /* 5.3 : 1 */
--accent: #8b9dff;  --accent-soft: #1d2440;
--ok: #34d399;  --warn: #fbbf24;  --bad: #fb7185;
```

Declared three times: bare `:root`, `@media (prefers-color-scheme: dark)`
guarded by `:root:not([data-theme="light"])`, and `:root[data-theme="dark"]`.
No colour gets its only definition inside a media query.

### 3.3 Layer ramp

There is no metallurgy ramp. Bronze/silver/gold encodes medallion architecture,
and a project's layers are as likely to be `staging → intermediate → marts` —
so the metaphor communicates nothing, and two of its steps fail contrast.

Instead, a cool→warm sweep. Position in the sweep maps to position in the
pipeline, so colour reinforces the left-to-right reading of the canvas. Layers
are assigned by index into the derived order (§3 of `ui-spec.md`), so a
`bronze/silver/gold` project gets the same treatment.

| Step | Light | ratio | Dark |
|---|---|---|---|
| 0 | `#0e7490` | 5.4 | `#22d3ee` |
| 1 | `#1d4ed8` | 6.7 | `#60a5fa` |
| 2 | `#4f46e5` | 6.3 | `#a5b4fc` |
| 3 | `#7c3aed` | 5.7 | `#c4b5fd` |
| 4 | `#a21caf` | 6.3 | `#f0abfc` |
| Power BI | `#b45309` | 5.0 | `#fbbf24` |

Power BI sits outside the sweep in warm amber because it is not another dbt
stage — it is the other side of the boundary.

### 3.4 Kind colours

| Kind | Light | Dark | Icon |
|---|---|---|---|
| source | `#0f766e` | `#2dd4bf` | `database` |
| model | `#1d4ed8` | `#60a5fa` | `box` |
| snapshot | `#0e7490` | `#22d3ee` | `camera` |
| pbiTable | `#b45309` | `#fbbf24` | `table-2` |
| page | `#7c2d92` | `#e879f9` | `page` |
| measure | `#be123c` | `#fb7185` | `sigma` |
| visual | `#7c3aed` | `#c4b5fd` | `bar-chart-3` |

All ≥ 4.5 : 1 on both surfaces in both themes. **Colour is never the only
signal** — every kind also carries a distinct glyph, which is what keeps the
teal/blue pair usable for deuteranopic readers.

---

## 4. Icons

Inline SVG, drawn from **Lucide** (ISC licence) and re-exported through a single
`ui/src/icons.jsx`. No network, `stroke: currentColor` so every icon inherits
its context's colour and theme.

Emoji is removed everywhere — 🗂/🗄 render as a different picture per OS and
cannot take a colour. So are text glyphs such as `◇ ◆ ▦ Σ ▤ ⤢`, which is why
glyph-based "icons" never look like icons.

### 4.1 Size scale

Icons have their own scale and real optical weight, rather than rendering at
10–13px inside a 16px box:

| Token | Size | Stroke | Used for |
|---|---|---|---|
| `--icon-sm` | 14 | 2 | inline in 12px rows, chips |
| `--icon-md` | **18** | 2 | tree rows, node cards, buttons — the default |
| `--icon-lg` | 22 | 2 | panel header, tab rail, empty states |

Minimum interactive target is **32 × 32px** regardless of icon size, so an 18px
icon in a button gets 7px of padding on each side.

### 4.2 Inventory

Around 46 glyphs, all exported from `icons.jsx` under `Icon*` names:

`database` `table-2` `box` `camera` `layers` `git-branch` `sigma` `bar-chart-3`
`chevron-right` `chevron-down` `plus` `minus` `arrow-left` `arrow-right`
`search` `filter` `x` `maximize-2` `sun` `moon` `alert-triangle` `check-circle-2`
`info` `grip-vertical` `panel-left` `link-2` `file-code` `hash` `type` `calendar`
`eye` `eye-off` `shield-check` `sprout` `ghost` `copy-plus` `external-link`
`rotate-ccw` `lock` `crosshair` `flame` `loader` `folder-open` `list-filter`
`upload` `page`

Column-type icons (`hash` numeric, `type` text, `calendar` date) replace `#` /
`Aa` / date glyphs in expanded column lists.

### 4.3 Nine glyphs, six colours

`kind` is coarse — every dbt resource that is not a source arrives as `model`.
What distinguishes a seed from a snapshot from an incremental table lives in the
node's resource type and materialisation, so `nodeIcon()` resolves against those
first and falls back to the kind.

Shape carries materialisation — view (eye), table (grid), incremental
(copy-plus), ephemeral (ghost), seed (sprout), snapshot (camera), exposure
(external link), test (shield). Colour stays keyed to `kind`, so nine glyphs do
not become nine colours.

### 4.4 The product mark

`Logo.jsx` is one silhouette: a warehouse cylinder whose base breaks into three
ascending bars, filled with an indigo → cyan gradient. One shape rather than two
glyphs joined, because it also has to be the favicon and two marks turn to mush
at 16px. The favicon is the same drawing inline in `index.html` as a
percent-encoded `data:` URI, kept in sync by hand — a `data:` URI is the only
way a single-file report can carry an icon at all.

---

## 5. Motion

```css
--ease:        cubic-bezier(.22, .61, .36, 1);   /* decelerate */
--ease-spring: cubic-bezier(.34, 1.3, .64, 1);   /* slight overshoot */
--dur-fast:   120ms;   /* hover, chip, checkbox */
--dur-base:   220ms;   /* panel content, dim/undim, chevrons */
--dur-slow:   420ms;   /* lineage path reveal, layout glide */
```

**Path reveal.** Selecting a node animates the lit edges in with
`stroke-dasharray` / `stroke-dashoffset` over `--dur-slow`, staggered by graph
depth (`delay = depth × 40ms`, capped at 240ms) so lineage visibly *travels*
outward from the node rather than appearing at once.

**Node response.** Lit nodes lift (`translateY(-1px)`, shadow up one step) over
`--dur-base`; dimmed nodes fall to `opacity: .28`. Selected node scales to
`1.015` with `--ease-spring`.

**Layout glide.** Nodes transition `transform` over `--dur-slow` when filters
change — but **only under 200 visible nodes**. Above that it snaps, because
animating hundreds of transforms drops frames and a stuttering canvas reads as
broken, not as polished.

**No continuous animation.** No marching ants, no pulsing, no looping flow. A
permanent animation on 50+ edges repaints forever and becomes noise the reader
stops seeing inside a minute; the thing that should hold attention indefinitely
is the data.

**Reduced motion.** `@media (prefers-reduced-motion: reduce)` sets every
duration to `1ms` and disables the reveal stagger. Not negotiable. The two
looping animations in the loading state — the spinner and the indeterminate bar
— are switched **off** there rather than left to the blanket override, which
would spin them a thousand times a second rather than calm them.

---

## 6. Space, radius, elevation

4px base grid: `2 4 6 8 12 16 20 24 32 48`.

```css
--r-sm: 6px;    /* chips, inputs, small buttons */
--r-md: 10px;   /* node cards, panels, code blocks */
--r-lg: 14px;   /* KPI tiles, modals */
--r-full: 999px;

--sh-1: 0 1px 2px rgb(15 24 40 / .06);
--sh-2: 0 2px 8px rgb(15 24 40 / .08), 0 1px 2px rgb(15 24 40 / .04);
--sh-3: 0 8px 24px rgb(15 24 40 / .12);
```

Dark theme raises shadow alpha to `.35/.45/.55` — the same shadow is invisible
on a dark ground.

Elevation is meaning, not decoration: `--sh-1` resting card, `--sh-2` hovered or
selected card and floating canvas controls, `--sh-3` overlays only.

---

## 7. Components

### 7.1 Chips

12px, weight 500, fully rounded, `4px 10px` padding, `gap: 6px`,
`min-height: 24px`, 1px border, optional 14px leading icon. **One spec
everywhere** — a rail that overrides the padding inline to `1px 8px` is exactly
why its counts stop matching the panel's chips. Counts use `.badge`, which is
narrower on purpose: a number needs no room to breathe sideways.

Three tones:

| Tone | Use |
|---|---|
| neutral | resource type, materialization |
| accent | active state (selected tab pill) |
| semantic | `--ok` ≥1 test, `--muted` 0 tests, `--bad` broken |

**dbt node chip row — exactly three, no tags:**

```
[⬒ model]  [⬓ view]  [✓ 1 test]
```

resource type · materialization · test count. Tags are dropped because they
duplicate: a column tagged `["warehouse","dimension","mapping"]` *also* sits in
layer `warehouse`, so the row prints `warehouse` twice for no gain. Layer leaves
the chip row and becomes a **3px coloured left border on the panel header** in
the lane colour — present, free, and consistent with the canvas.

Description stays in **Metadata only**. Some run to three sentences and would
dominate the header.

Power BI keeps its own three: storage mode · column count · measure count.

### 7.2 Tab pills

Overview / Definition / Metadata, and the nav rail's Stage / Database, are pills
in a `--panel-2` track: fully rounded, active pill `--panel` with `--sh-1` and
`--text`, inactive `--muted`. The active pill slides between positions over
`--dur-base`.

### 7.3 Provenance pill

The resolved/mapped block is a **collapsible pill**, in the **Overview tab
only** — it is impact context, and it has no business sitting above a SQL
listing or a metadata table.

```
▸ 🔗 Resolved from the M expression · 28 columns
```

Collapsed by default above 6 entries, expanded at or below. Chevron rotates
90° over `--dur-base`; the body reveals by animating `grid-template-rows` 0fr→1fr,
which animates height without a hardcoded pixel value. Expanded body is capped
at 50% of the tab area and scrolls internally (`ui-spec.md` §5.3).

### 7.4 Resizable panels

Both the nav rail and the details panel get a 6px hit-area drag handle
(`grip-vertical`, visible on hover, `--border-strong` while dragging), full
panel height, `cursor: col-resize`.

**Sizing uses `clamp()` rather than px or % alone** — neither works on its own:

```css
--rail-w:  clamp(200px, 18vw, 380px);
--panel-w: clamp(320px, 35vw, 720px);
```

Percentage alone breaks at both ends: 35% of a 1280px laptop is 448px (fine) but
35% of a 3440px ultrawide is 1204px of side panel against a squeezed canvas,
and 35% of a 1024px window leaves the canvas unusable. `clamp()` gives the
proportional behaviour in the middle, where it is right, and holds a sane floor
and ceiling at the extremes. The percentage is the preferred term.

Dragging overrides with an explicit px value for the session. **Not persisted**
— reload returns to the responsive default. Double-clicking a handle resets
immediately.

No panel has a hardcoded height. Every column is `height: 100%` with
`flex: 1; min-height: 0` on its scrolling child, which is what lets the SQL
block and the affected-visuals list use the full window.

### 7.5 Loading state

`.is-blurred` is `blur(2.5px) saturate(.7)` at 75% opacity over the canvas, with
a `.busy-card` above it carrying a spinner, the node count and an indeterminate
bar. The previous layout stays on screen underneath, blurred, rather than
emptying — which is what makes the wait legible as work rather than as a crash.
See `ui-spec.md` §7.2 for why the overlay has to be painted before the solve
begins.

### 7.6 Focus ring

`outline: 2px solid var(--accent); outline-offset: 2px` on `:focus-visible`
everywhere. Never removed, never replaced with a colour change alone.

---

## 8. What this rules out

| Not this | This |
|---|---|
| 10px uppercase `--muted` labels | 12px / 600 / `--text-2` |
| A grey at 4.23 : 1 on insets | `#626e82`, 5.2 : 1 |
| Text glyphs `◇ ◆ ▦ Σ ▤` at ~11px | 18px Lucide SVG, `currentColor` |
| Emoji nav tabs 🗂 🗄 | `layers` / `database` icons |
| Bronze/silver/gold ramp, 2 steps failing AA | 5-step cool→warm sweep, all ≥ 5.0 : 1 |
| Tags in the dbt chip row (duplicating the layer) | three chips; layer as a coloured header border |
| Fixed `w-[230px]` / `w-[400px]` panels | `clamp()` widths, drag to resize, double-click to reset |
| System font stack | Inter Variable + JetBrains Mono, inlined |
| No motion | reveal / lift / glide, all reduced-motion aware |

---

## 9. Implementation notes

**Icons come from `lucide-react`, not hand-copied paths.** The spec calls for an
inline SVG subset and this is one: lucide-react renders inline `<svg>` with
`stroke: currentColor` and tree-shakes to the glyphs imported in
`ui/src/icons.jsx`. Nothing is fetched at runtime, so the single-file guarantee
holds. Transcribing 46 `d` attributes by hand would produce the same output with
more chances to get one subtly wrong. Components import from `icons.jsx` only,
never from `lucide-react`, so the size scale lives in one file.

**Fonts inline automatically** via `build.assetsInlineLimit`, which is already
set high for the single-file build. Only the *latin* woff2 is referenced — the
fontsource index CSS would pull cyrillic, greek and vietnamese for four times
the bytes. Verified in the browser suite: `document.fonts.check('16px "Inter
var"')` must pass, because a report that silently falls back to the system stack
looks different on every machine and nothing else would catch it.

**Do not name the disclosure wrapper `.collapse`.** It is a Tailwind utility, so
`visibility: collapse` silently wins, hiding the provenance body while leaving
its box on screen — visible only as an assertion failure, not as a
broken-looking page. The class is `.disclosure`.

**Layer colour is assigned by index into the derived order**, in
`theme.js:layerColor()`, so the ramp reads left-to-right as the pipeline does
whatever a project names its folders. Every component that shows a layer — node
accent bar, rail icon, panel header border — calls the same function.
