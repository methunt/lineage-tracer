# Unified Lineage UI — Specification

Status: **built**. This is the contract the implementation follows.

The goal in one sentence: **one graph that runs from a dbt source to the Power BI
visual that renders it**, so that selecting a column answers "if I change this,
what breaks?".

Everything below is UI. Token values — colour, type, spacing, motion, icon
sizes — live in `design-system.md` and are referenced, never restated.

---

## 1. Node kinds

The five kinds the UI ever renders, plus `page`, which aggregates visuals:

| Kind | Face of the node | Expands |
|---|---|---|
| dbt source | name · source system · tags | ✓ columns |
| dbt model | name · materialization · layer · test count | ✓ columns |
| PBI table | name · storage mode · column count | ✓ columns |
| PBI page | title · visual count | ✓ visuals |
| PBI measure | name · home table | ✗ |
| PBI visual | title · type icon · page | ✗ |

Columns are **nested inside table nodes, never separate graph nodes**. That is
what keeps a project's graph in the hundreds rather than the thousands of nodes,
and it is what makes the expand interaction natural.

`kind` is coarse: every dbt resource that is not a source arrives as `model`, so
a snapshot and an incremental table share a kind. Shape carries the difference
(`design-system.md` §4.3); colour stays keyed to `kind`.

---

## 2. UI structure

### 2.1 Top level — two tabs

| Tab | Purpose |
|---|---|
| **Lineage** (default) | The graph |
| **Diagnostics** | What didn't link, and why |

The header is a three-track grid rather than a flex row, so the tabs are centred
against the window instead of against whatever the brand block and the controls
happen to measure. A longer report name cannot drag them off centre. Search
lives in the header.

There is no metric strip and no filter strip. Together they cost the canvas
about 110px — most of a node card — on every screen, permanently, for four
numbers and one checkbox. Nothing was lost that could not go somewhere better:
the issue count sits on the Diagnostics tab, blast radius is a property of a
column and the details panel states it on selection, and "Linked only" is a
filter that sits in the rail with every other filter.

### 2.2 Canvas

React Flow + ELK `layered`, left-to-right, one explicit column per layer.

Default kinds are `source, model, pbiTable, page`; measures and visuals stay off
until asked for. Opening with every measure and visual on screen buries the
structure, and the other kinds are one click away.

`fitView` is clamped to `minZoom: 0.45`. Fitting several hundred nodes
edge-to-edge produces an unreadable wall; it lands at a legible scale and the
reader pans.

**Nodes are draggable**, with a `Reset layout` control in the canvas — readers
rearrange to reason about a specific path. Drag is transient state owned by
React Flow for the length of the gesture, through a local mirror of the derived
nodes; the store records only the final position on drop, so the durable "the
reader moved this" record, and the Reset that clears it, stay simple. Two
constraints on that mirror, both learned the hard way:

* Only `position` changes are mirrored. Feeding React Flow's `dimensions`
  changes back in produces a new array on every measurement, which triggers
  another measurement — the canvas never stops rendering and stops answering
  clicks entirely.
* The derived node array must be memoised. A fresh object literal per render
  re-syncs the mirror on every render, and each sync renders again.

`elementsSelectable` must stay true. React Flow marks node wrappers
`pointer-events: none` when it is false: the page looks perfect and no click
inside a node ever lands.

### 2.3 Selection behaviour

- Select a **node** → panel scopes to the whole node; highlight its full
  upstream/downstream subgraph.
- Expand a table → columns list, each with a lineage mark.
- Select a **column** → dim everything except that column's path; highlight every
  edge it flows through, through measures, to visuals.

Edges: solid = derived (the tool read the definition and followed it), dashed =
declared (the reader asserted the link, possibly across layers the tool never
saw). These must never render identically. Highlight colour distinguishes
upstream from downstream. Thickness is deliberately constant — varying it would
imply a volume that is not measured.

---

## 3. Layers and lanes

### 3.1 Lane order is derived

Layer names are project-specific (`bronze/silver/gold` is as valid as
`staging/marts`), so the left-to-right order cannot be a constant. It is a
weighted topological sort of layers over the dbt edges, alphabetical for ties,
`powerbi` pinned last.

Layer graphs are **not acyclic in practice** — a handful of edges usually run
backwards between two layers. An unweighted sort deadlocks and leaves a layer
unemitted, which a naive fallback appends last, to the right of the layer it
feeds. When the sort deadlocks, the layer with the least incoming weight is
forced out next, so the heavy forward flow survives and the light back-reference
is the one sacrificed.

Colour follows the same order (`design-system.md` §3.3), so the ramp reads
left-to-right as the pipeline does.

### 3.2 Lane columns are assigned by the app, not by ELK

ELK's `partitioning` does not hold a declared layer order — Power BI lands left
of staging. ELK decides only the *vertical* ordering, which is the valuable part
(crossing minimisation); each layer gets an explicit column.

**Power BI renders as three lanes.** `pbiTable`, `measure` and `visual` all
carry the same layer, and a hundred-plus nodes in one column is unreadable. The
split is presentational only — the node's layer is untouched. Lane order within
Power BI is Tables → Measures → Pages → Visuals.

**No swimlane bands.** Heavy boxes around sparse columns read worse than the
ordering itself; layer position is conveyed by left-to-right position and by the
node accent colour.

### 3.3 Pages are aggregating endpoints

A report with hundreds of visuals cannot be read one visual at a time, so `page`
is a node kind carrying **the same data edges its visuals carry**. A measure
feeding eight visuals across two pages shows two nodes, not eight.

This aggregates rather than invents: a change that breaks a visual does break
the page it sits on.

`page → visual` edges exist so that expanding a page reveals what is on it, and
are **excluded from the impact walk and from path highlighting**. Following them
would mean one affected visual made every other visual on the same page count as
affected, inflating every number in the report.

---

## 4. Navigation rail

### 4.1 One filter axis, not two

Layers and kinds are never orthogonal in real data: layer `sources` is exactly
kind `source`, the model layers are all kind `model`, and layer `powerbi` is
exactly `pbiTable` + `measure` + `visual`. Two controls, one axis — so no
combination of them tells the reader anything a single control could not.

They are **one hierarchical tree** in the rail. There are no kind pills in the
toolbar. This also stops the rail reporting a single "Power BI" lump when it is
tables, pages, measures and visuals in very different quantities.

### 4.2 Two navigation tabs

| Tab | Question it answers |
|---|---|
| Stage | where does this sit in the pipeline |
| Database | where does this physically live |

Power BI has no warehouse relation, so the database tree groups it under a
**synthetic root** — a fallback key computed in the grouper, never written to
the node. The graph, the impact walk and the export stay unaware of it, and a
Power BI table that ever does carry a real database lands in that database
automatically.

The tree's filter box narrows **the tree only**. It deliberately does not drive
the canvas: two boxes each filtering the other is a loop the reader cannot back
out of — narrowing the tree narrows the canvas, which narrows the tree, and the
node you wanted is no longer reachable. The tree drives the canvas by *click* —
one direction, one explicit action, always reversible.

### 4.3 Resource type is the top level, layers a subdivision

Listing layers first puts `sources` beside `staging` as if they were the same
kind of thing. They are not: one is a resource type, the other is a folder name.
dbt's own shape is resource type first, with layers as a subdivision of models
only.

```
models      N   →  staging N · intermediate N · warehouse N · marts N
sources     N
snapshots   N
analyses    N   (greyed — declared in the manifest, no column lineage)
tests       N   (greyed)
Power BI    N   →  Tables N · Pages N · Measures N · Visuals N
```

Each `N` is that project's own count. On a large production project the models
group runs to the hundreds and Power BI visuals to a couple of hundred, which is
why the group rows carry counts at all.

Model layers keep the derived pipeline order, so the tree reads in the same
direction as the canvas.

**Declared but empty is still shown.** Resource types with no column lineage get
a greyed, non-interactive row carrying the count and the reason, and list their
members by name rather than showing only a number. A reader who knows the
project declares analyses and sees no `analyses` row cannot tell whether the
tool ignored them or lost them.

**A layer filter applies only to nodes whose resource type is `model`.** A layer
is just a folder name, and a folder is free to be called anything — a
`models/sources/` folder collides with the `sources` resource type, and a
`models/models/` folder with a snapshot inside it collides with `models`.
Without the restriction, the eye beside a layer hides resources that already
have their own row and their own eye further down the rail, which is where their
visibility belongs.

**Sources subdivide by their declared source name**, exactly as models subdivide
by layer — `crm 17 · web_events 16 · billing 4 · reference 2`. A source folder
is a grouping, not a filter: its eye is absent, and visibility belongs to the
`sources` row above it. Two controls that look identical and mean different
things are worse than one.

### 4.4 Expanding and showing are different actions

Each row has three parts: a **chevron** that opens the folder, the **row** that
toggles visibility, and an **eye** that shows which state it is in. One click
doing both leaves nothing on screen saying which.

Every folder starts **collapsed** — a tree of a hundred-plus models across five
layers plus a few hundred Power BI objects is a wall rather than navigation. The
canvas is unaffected: it still opens on sources, models, tables and pages. A
report someone opens cold should not have to be explained before it shows
anything.

Typing in the filter box opens whatever it matched, since a match hidden inside
a closed folder is the same as no match at all.

### 4.5 The tree reaches the objects

Both tabs navigate to individual objects, not just to folders:

```
models ▸ staging ▸ stg_orders
sources ▸ raw_customers
Power BI ▸ Pages ▸ Quarterly Summary
```

Models subdivide by layer and then by table; every other resource type opens
straight to its tables, because a second folder holding one list is a click that
buys nothing. Clicking a leaf focuses it on the canvas. A name in a tree that
cannot be clicked through to the thing it names is a label, not navigation.

Leaves render only when their folder is open, so a several-hundred-visual list
costs nothing until it is asked for.

### 4.6 One reset, in the rail footer

Reset sits beside `Show all / Hide all`, which is the same axis it acts on. It
clears everything at once — search, tree filter, focus, layers, kinds,
selection. It is the only escape from a state assembled from four different
controls, so it cannot simply be deleted.

---

## 5. Side panel

### 5.1 Three tabs

| Tab | dbt node | Power BI node |
|---|---|---|
| **Overview** | Impact band + exact counts; affected measures; affected visuals grouped by page; `BROKEN` chips where provable | Same, plus upstream: which dbt model/column feeds it and how the link was established |
| **Definition** | Compiled SQL, toggle to raw | Table: the M expression **and** its inlined resolution side by side. Measure: DAX. Visual: field list |
| **Metadata** | description · tags · materialization · database/schema/relation · path · tests with severity | description · storage mode · source relation · column renames · provenance |

**Not included:** row counts, PII flags, History — no data exists behind any of
them.

### 5.2 Header

Kind and layer are printed once, not twice. The chip row carries them (plus
materialisation, storage mode, tests, tags); the subtitle carries the
**relation** — `analytics_warehouse.dim_customer` — so "where does this come
from" is answered on sight instead of requiring the Metadata tab.

The subtitle is the "where does this live" slot for every kind. For a visual,
its page *is* its location, so the page goes in the subtitle and the chip row
shows the field count instead of repeating it.

### 5.3 Provenance region

A grouped, height-capped region between the tabs and the tab content:

- **Resolved from the M expression (n)** — one line per column, `A → B`, because
  each may carry a rename and the rename is the point. `CustNo → Customer
  Number` is why a Power BI author cannot guess which dbt column breaks their
  table.
- **Mapped in the mapping file (n)** — one comma-separated sentence. The reader
  wrote these, so they need no per-line scrutiny. Omitted entirely when empty.

Both the provenance region and the tab content scroll independently, and
neither may exceed **half the panel's tab area**. Without the cap, a table with
28 crossing columns pushes the impact analysis off screen entirely, which loses
the answer to the question the tool exists to answer.

---

## 6. Impact analysis

The one place where it would be easy, and wrong, to invent information.

### 6.1 Two separate concepts

| Concept | Basis | Certainty |
|---|---|---|
| **Blast radius** | Downstream traversal of the merged graph | Exact |
| **Breakage** | A report reference that does not resolve; a PBI column mapped to a dbt column absent from the manifest | Provable, narrow |

Blast radius is always shown. A `BROKEN` chip appears **only** when breakage is
proven. Severity is never inferred — no `CRITICAL`, no `DATA MISMATCH`, no
`VISUAL ERROR` unless something in the artifacts actually says so.

> Rationale: a lineage tool that labels a healthy measure `CRITICAL` on a guess
> loses its reader the first time they check and find nothing wrong.

### 6.2 Impact band

Banded on **downstream visual count** — a visual is what a human sees break.
Raw counts always render beside the band, so the band is never load-bearing.

| Band | Visuals |
|---|---|
| High | ≥ 10 |
| Medium | 3–9 |
| Low | 1–2 |
| None | 0 |

Thresholds live in one config constant. A busy fact column such as
`fct_orders.order_total` lands High; most dimension attributes are Low.

### 6.3 Scope follows selection

- **Table selected** → union of every column's impact: "if I drop this model".
- **Column selected** → that column only: "if I rename this field".

A breadcrumb states which is in view.

### 6.4 Impact does not travel through a join, and does not travel far

Two deliberate stops, both to keep the numbers meaningful:

**Joins are not edges.** With a couple of dozen relationships over thirty-odd
tables the graph would be close to complete, every column would land in the high
band, and a blast radius that says "everything" says nothing. The question is
what breaks if this column changes, and for a key the honest answer is "a join,
and here is which one".

**A derivation mark travels exactly one hop.** A column computed in Power Query
from two others makes both of those load-bearing, and a dbt column linked to any
of them is the same column one system earlier, so crossing the warehouse
boundary is transparent rather than a hop of its own. Walking further up dbt's
own lineage was considered and rejected: an id traces back through staging into
sources, and by the time it arrives almost every column "feeds a key" — the same
failure as propagating impact through joins.

Whatever the tool cannot resolve contributes nothing rather than something
wrong, and the UI never implies that nothing depends on a column it simply could
not read.

---

## 7. Metrics, loading and layout cost

### 7.1 Metrics answer two questions, not six

A census of six ratios — how many nodes, tables, columns and visuals exist —
changes nothing a reader would do next. The four tiles that replace it answer
*can I trust this report* and *where is the danger*:

| Tile | Value | Clickable |
|---|---|---|
| Traced | linked ÷ **warehouse-backed** model columns, as a % | no |
| Widest blast radius | max visuals downstream of any one dbt column | yes — selects it |
| High-impact columns | columns in the `high` band | no |
| Issues | count | yes — opens Diagnostics |

The denominator matters. A Power BI table loaded from a spreadsheet is not
supposed to have dbt lineage, and counting it as a miss makes a healthy report
look broken. Only tables whose M expression resolved to a warehouse relation are
in the ratio; the rest are reported beneath it as *excluded*, never as failures.
On a typical project that is the difference between reading 76% and reading 94%
— and the second is the true number.

Traced is deliberately not clickable. "Untraced" could mean thirty tables and
has no single honest destination; a tile that navigates somewhere vague is worse
than one that sits still.

### 7.2 The loading state has to be raised before the work starts

elkjs is synchronous underneath its Promise. Once it begins, the main thread is
blocked and the browser cannot paint, so an overlay rendered "while it runs"
never appears at all — the first implementation showed nothing during a
multi-second freeze and looked exactly like a hang. A CSS `animation-delay`
cannot help, because no frames are painted during the block.

So: above a node-count floor the overlay is raised **first** and the solve
starts two animation frames later, once a paint has actually gone out. Below the
floor the solve fits in a frame and no overlay is shown, because a blur that
flashes for 40 ms reads worse than no feedback at all.

The canvas must not empty for the duration of a solve. The previous layout stays
on screen, blurred, until the new one is ready — which is what makes the
remaining wait legible as work rather than as a crash. Overlay appearance is
specified in `design-system.md` §7.5.

### 7.3 Expanding a node must not re-solve the graph

`layout()` is split in two:

- `elkOrder(nodes, edges)` — expensive, async, depends on the node and edge
  **sets** only
- `place(nodes, elkY, lanes, expanded)` — cheap, synchronous, consumes heights

Expanding a node's columns changes one node's height and nothing else, so it
runs `place()` alone. At around 150 visible nodes a full re-solve takes seconds;
an expand takes about 100 ms.

The viewport follows the same rule. `fitView` fires only when the visible set
changes — new nodes would otherwise land off-screen — and never when a node
merely resizes, because you are reading the node you just clicked.

ELK is configured for the phase whose output is actually consumed: crossing
minimisation. Precise coordinate assignment and spline edge routing are both
turned down, because `place()` discards every coordinate and React Flow draws
its own edges. That one setting is the difference between a four-second solve
and a half-second one.

---

## 8. Canvas interaction

### 8.1 Neighbour expansion

**Per-node handles.** `+` bottom-left is one hop upstream, bottom-right one hop
downstream. Rendered only when that direction has neighbours *not already on
canvas* — a button that visibly does nothing reads as broken. Flips to `−`,
retracting exactly what that press added.

**Depth stepper**, bottom-centre: `1…10, ∞` with `← N →`. It expands from the
**focused node** — the existing selection, nothing new to learn — and is greyed
with "select a node to expand from" when nothing is focused. Expanding from
every node on canvas at once was rejected: one press can go from three nodes to
several hundred with no undo.

Expansions are keyed `nodeId|direction`, so one press can be retracted without
unpicking an overlapping walk from a different node.

**Revealed nodes bypass every filter.** Pressing `+` on a search result exists
precisely to see what the search is hiding. A **new search wipes them**:
expansion is scoped to the search that produced it, so the canvas can never
accumulate state the reader cannot see.

**`∞` runs, but confirms** past 150 added nodes, naming the count. Upstream
cones are usually small; downstream reaches the whole Power BI surface.

### 8.2 Focus mode

Clicking a table in the tree puts it alone on the canvas and **suspends the
filters**, with a chip reading `Focused: <name> · filters suspended · ✕`.
Half-applying the filters would mean a tree click sometimes shows nothing with
no explanation. `✕` returns to the filtered view untouched.

### 8.3 Theme toggle

Two states, light by default, stamped on `<html>` before the first paint so the
page never renders in the OS preference and then contradicts it.

A three-state cycle (system → dark → light) was tried and dropped: on a machine
already in dark mode the first press sets `dark` and changes nothing visible, so
the button reads as broken and "works" on the second or third press. The single
preference this loses — handing the theme back to the OS — is not worth a
control that can appear dead.

---

## 9. Columns and fields

### 9.1 Columns as cards

A three-column table puts a `linked` chip on every row: on a 28-column table
that is 28 chips stacked in a gutter, which is noise, not signal. Lineage is a
coloured left edge instead — the same information as a pattern to scan down
rather than a label to read across — and the space it frees goes to the
description.

A **Find…** box appears at 8 columns or more; below that it is furniture. It
matches name and description. Hidden columns keep an icon; the data type is
right-aligned in mono.

Calculated columns show their DAX behind a disclosure. Recording that a column
is calculated without recording the expression tells a reader a column is
calculated without telling them whether their change breaks it.

### 9.2 Two facts, one glyph

A key column appears in no visual and no measure, so an impact walk reports zero
for it and that reads as "safe to drop". It is not — dropping a key raises no
error anywhere, it silently changes the numbers. So each column carries the
relationships it takes part in, and the panel names the other side. "Used in a
relationship" is not actionable; "joins `Customers[CustomerKey]`" is.

Being a key and feeding one are different facts, and a column row has space for
one mark. So it is the same glyph at two weights — solid for the key, faint for
a feeder — because someone scanning for "can I touch this" wants both to catch
the eye at the same threshold. The panel spells out which, and names the join.

A key can join many tables. The chip list shows five, then offers the rest in a
box capped at about five rows: most keys have one or two joins, where a scroll
container would be a box around nothing.

Inactive relationships are shown on the same footing and marked. They are
reachable only through `USERELATIONSHIP` inside a measure, which makes them the
easiest dependency to miss and no less real.

### 9.3 Tests are a mark, not a lane

Tests are a property of a model, not a step in the flow. A test lane is a fifth
more graph for something with no downstream, and putting tests in a lane implies
data moves through them.

So a card carries a shield and a count — coloured when tested, faded at zero,
and only on dbt cards, since a Power BI table has no dbt tests and a badge
reading zero there would be a lie by omission.

### 9.4 Fields used, grouped by role

A visual's fields as a `<pre>` blob scroll sideways, which puts the role — the
thing the reader is scanning for — past the right edge. They are grouped under
role headings in visual-encoding order, each with an icon and a count,
`Table[Field]` wrapping rather than scrolling.

The role list is taken from what real visuals contain, not from what the schema
suggests. Unrecognised roles keep their own heading and sort last, so a role the
tool has never seen is still visible rather than silently dropped.

---

## 10. Diagnostics

A worklist, ordered by actionability. Every row links back to its node in the
Lineage tab.

1. Unresolved mapping rows
2. Invalid mapping rows
3. Semantic model tables with no warehouse source
4. Broken report references
5. Ambiguous matches
6. Semantic model columns not traced to dbt
7. dbt models not consumed by this report
8. Join keys with no dbt column behind them
9. Widest reach, no dbt test

Sections 3 and 6 say "semantic model" rather than "model", because *model* alone
is ambiguous in a tool whose other half is dbt models. Both hints open by naming
which side they are about.

**Empty sections are one quiet line.** A heading, an explanation and the word
"None" for eight mostly-empty sections pushes the first real finding below the
fold. Only sections with rows get a card.

Each card carries a severity dot, a count, a one-line explanation of what the
section means, and a filter box once it passes eight rows. Identifier columns
are monospaced, because `Regional Sales Group` and `Regional  Sales Group` are
indistinguishable in a proportional face and telling them apart is the entire
job. Rows are capped at 100 with an explicit "show the remaining N" rather than
a silent truncation.

The tally reconciles itself against the tab's own count: errors plus warnings
are what the header count counts, and the info total is named as context so it
does not read as a discrepancy.

Two of the findings are deliberately scoped rather than exhaustive:

- *Join keys with no dbt column behind them* is scoped to tables that do resolve
  to a warehouse relation, because on a table whose source was never found every
  column is unlinked and the keys add nothing.
- *Widest reach, no dbt test* is scoped to the high-impact band. Every model is
  a candidate for a test and most will never have one, so an unscoped list is
  noise; tied to the blast radius already computed, it is a short list of what
  would be felt furthest.

---

## 11. Non-goals

- Diagram export (draw.io / Mermaid) — the deliverable is an HTML report
- Row counts, PII flags, change history — no data behind them
- Multiple reports or multiple dbt projects in one graph — the schema is
  namespaced so it can be added, but it is not in scope
- Inferred severity of any kind (§6.1)
- Continuous animation of any kind (`design-system.md` §5)
