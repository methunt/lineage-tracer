"""Build the README's architecture diagram, one light and one dark variant.

Hand-written rather than spec-driven because its shape is specific to this
project: four inputs, two extractors, one join, one graph. Same rules as
`build_readme_assets.py` — transform-only animation, no external fonts, no
painted page background on the transparent parts, both variants from one source
so they cannot drift.

Usage:  python build_arch_asset.py [--out ../assets]

Stdlib only.
"""

from __future__ import annotations

import argparse
from pathlib import Path

FONT = "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
MONO = "ui-monospace,SFMono-Regular,'SF Mono',Consolas,'Liberation Mono',monospace"

LIGHT = {
    "name": "light",
    "card": "#F6F8FA", "card2": "#EEF1F5", "border": "#D0D7DE",
    "text": "#1F2328", "muted": "#656D76",
    "primary": "#4f46e5", "good": "#047857", "warn": "#b45309",
    "bad": "#be123c", "violet": "#7c3aed", "cyan": "#0f766e",
    "wash": "0.10", "edge": "#9AA4AF",
}
DARK = {
    "name": "dark",
    "card": "#161B22", "card2": "#1C2128", "border": "#30363D",
    "text": "#E6EDF3", "muted": "#8B949E",
    "primary": "#8b9dff", "good": "#34d399", "warn": "#fbbf24",
    "bad": "#fb7185", "violet": "#c4b5fd", "cyan": "#2dd4bf",
    "wash": "0.20", "edge": "#4A5460",
}

W, H = 1200, 372


def esc(s: str) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def paint(t: str, p: dict) -> str:
    for k, v in p.items():
        t = t.replace(f"__{k.upper()}__", str(v))
    return t.replace("__FONT__", FONT).replace("__MONO__", MONO)


def box(x, y, w, h, accent, title, subs, *, rx=10, title_size=17.5, sub_size=15):
    """A card with an accent spine, a title, and zero or more sub-lines."""
    out = [
        f'<g class="rise">',
        f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" '
        f'fill="__CARD__" stroke="__BORDER__"/>',
        f'  <rect x="{x}" y="{y}" width="4" height="{h}" rx="2" fill="{accent}"/>',
        f'  <text x="{x + 18}" y="{y + 27}" font-family="__FONT__" '
        f'font-size="{title_size}" font-weight="700" fill="__TEXT__">{esc(title)}</text>',
    ]
    for i, s in enumerate(subs):
        out.append(
            f'  <text x="{x + 18}" y="{y + 51 + i * 21}" font-family="__FONT__" '
            f'font-size="{sub_size}" fill="__MUTED__">{esc(s)}</text>')
    out.append("</g>")
    return "\n".join(out)


def flow(x1, y1, x2, y2, accent, *, delay=0.0):
    """A dashed bezier whose dashes travel left to right, forever and slowly."""
    bend = max(24, (x2 - x1) / 2)
    d = f"M{x1} {y1}C{x1 + bend} {y1} {x2 - bend} {y2} {x2} {y2}"
    return (f'<path d="{d}" fill="none" stroke="{accent}" stroke-width="2" '
            f'stroke-opacity="0.75" stroke-dasharray="7 7" class="flow" '
            f'style="animation-delay:{delay:.2f}s"/>')


def build() -> str:
    IN_X, IN_W, IN_H = 24, 236, 56
    inputs = [
        (40, "__CYAN__", "catalog.json", ["dbt column types + schema"]),
        (110, "__PRIMARY__", "manifest.json", ["compiled SQL — run dbt compile"]),
        (180, "__WARN__", "mapping.xlsx / .csv", ["links that cannot be derived"]),
        (250, "__VIOLET__", "Power BI project folder", [".Report + .SemanticModel"]),
    ]
    parts = []
    for y, accent, title, subs in inputs:
        parts.append(box(IN_X, y, IN_W, IN_H, accent, title, subs,
                         title_size=16.5, sub_size=15))

    ENG_X, ENG_W = 330, 268
    parts.append(box(ENG_X, 34, ENG_W, 96, "__PRIMARY__",
                     "Python, in your browser",
                     ["dbt-colibri column lineage", "on Pyodide + a vendored sqlglot"]))
    parts.append(box(ENG_X, 226, ENG_W, 96, "__VIOLET__",
                     "JavaScript, in your browser",
                     ["PBIP parsers: TMDL, DAX, M, PBIR", "plus M source-function inlining"]))

    JOIN_X, JOIN_W = 664, 236
    parts.append(box(JOIN_X, 96, JOIN_W, 164, "__GOOD__", "The join",
                     ["warehouse relation read", "back out of the M query,",
                      "matched against dbt —", "your mapping rows win"]))

    OUT_X, OUT_W = 946, 230
    parts.append(box(OUT_X, 60, OUT_W, 236, "__BAD__", "One graph",
                     ["Lineage canvas", "Impact analysis",
                      "Page layout", "Diagnostics", "", "Export → one .html file"]))

    # Edges: inputs into their extractor, extractors and mapping into the join,
    # the join into the graph. Mapping bypasses both extractors by design.
    edges = [
        (IN_X + IN_W, 68, ENG_X, 70, "__CYAN__", 0.0),
        (IN_X + IN_W, 138, ENG_X, 94, "__PRIMARY__", 0.35),
        (IN_X + IN_W, 278, ENG_X, 274, "__VIOLET__", 0.7),
        (IN_X + IN_W, 208, JOIN_X, 168, "__WARN__", 1.05),
        (ENG_X + ENG_W, 82, JOIN_X, 140, "__PRIMARY__", 0.5),
        (ENG_X + ENG_W, 274, JOIN_X, 210, "__VIOLET__", 0.85),
        (JOIN_X + JOIN_W, 178, OUT_X, 178, "__GOOD__", 1.2),
    ]
    edge_svg = "\n  ".join(flow(*e[:5], delay=e[5]) for e in edges)

    footer = (
        f'<text x="24" y="{H - 14}" font-family="__MONO__" font-size="15" '
        f'fill="__MUTED__">Nothing leaves the tab: no server, no API, no upload. '
        f'The runtime is fetched once, then served from cache.</text>')

    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}"
     width="{W}" height="{H}" role="img"
     aria-label="Data flow: dbt catalog and manifest into a Python column-lineage extractor running in the browser, a Power BI project folder into JavaScript PBIP parsers, both plus a mapping workbook into the join at the warehouse boundary, producing one graph with lineage, impact, page layout, diagnostics and an HTML export.">
  <style>
    /* Entrances move, never fade: a renderer that drops the CSS must still
       show a fully legible diagram. Only the dataflow dashes loop. */
    .rise {{ animation: rise .5s cubic-bezier(.2,.7,.3,1) both; }}
    @keyframes rise {{ from {{ transform: translateY(8px) }} to {{ transform: translateY(0) }} }}
    .flow {{ animation: march 1.6s linear infinite; }}
    @keyframes march {{ from {{ stroke-dashoffset: 28 }} to {{ stroke-dashoffset: 0 }} }}
    @media (prefers-reduced-motion: reduce) {{ * {{ animation: none !important }} }}
  </style>
  <!-- No background rect: GitHub has four surfaces and any colour painted
       here is wrong on at least one of them. -->
  {edge_svg}
  {chr(10).join(parts)}
  {footer}
</svg>
"""


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default="../assets")
    args = ap.parse_args()

    out = (Path(__file__).parent / args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    template = build()
    for palette in (LIGHT, DARK):
        path = out / f"architecture-{palette['name']}.svg"
        path.write_text(paint(template, palette), encoding="utf-8")
        print(f"  {path}")


if __name__ == "__main__":
    main()
