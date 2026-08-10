"""Build a README's animated SVGs, one dark and one light variant each.

Why a generator rather than hand-written files: the light and dark variants
differ only by palette, and the figures on them come from the project's own
data. Hand-maintaining both guarantees they drift apart the first time a number
changes. Here one spec plus two palettes produces every variant, and the numbers
are read from the same file that produced them.

Animation notes, learned the hard way about GitHub:

  * GitHub strips <style> and <script> from markdown, so CSS cannot live in the
    README. It DOES run CSS inside an .svg referenced as <img>, which is why the
    animation lives in the asset rather than the page.
  * No external fonts can load - a proxied SVG has no network access - so every
    text element uses a generic system stack.
  * GitHub cannot be forced into dark mode. Both variants are emitted and the
    README picks between them with <picture> and prefers-color-scheme.
  * Entrances animate transform only, never opacity. A renderer that ignores CSS
    must still show a fully legible banner.

Usage:
    python build_readme_assets.py
    python build_readme_assets.py --spec readme-assets.json --out assets

Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import string
import sys
from pathlib import Path

FONT = "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
MONO = "ui-monospace,SFMono-Regular,'SF Mono',Consolas,'Liberation Mono',monospace"

# Light is meant to be replaced with the project's own theme colours, so the
# README and its screenshots read as one piece of work. Dark is tuned to
# GitHub's dark surface rather than being light inverted.
LIGHT = {
    "name": "light",
    "bg": "#FFFFFF", "card": "#F6F8FA", "card2": "#EEF1F5", "border": "#D0D7DE",
    "text": "#1F2328", "muted": "#656D76", "faint": "#8C959F",
    "primary": "#2563EB", "good": "#059669", "warn": "#D97706", "bad": "#DC2626",
    "violet": "#7C3AED", "cyan": "#0891B2", "track": "#E4E8EC",
    "glow": "#2563EB", "glowopacity": "0.07", "ctashadow": "0.34",
    # Section-banner wash. Dark needs more of it: a 10% tint reads as nothing
    # against #0D1117, where the same value is clearly visible against white.
    "wash": "0.10",
}
DARK = {
    "name": "dark",
    "bg": "#0D1117", "card": "#161B22", "card2": "#1C2128", "border": "#30363D",
    "text": "#E6EDF3", "muted": "#8B949E", "faint": "#484F58",
    "primary": "#3B82F6", "good": "#10B981", "warn": "#F59E0B", "bad": "#EF4444",
    "violet": "#8B5CF6", "cyan": "#22D3EE", "track": "#21262D",
    # A coloured drop shadow that reads on white disappears on #0D1117, so dark
    # leans on a stronger one to keep the button lifted off the page.
    "glow": "#3B82F6", "glowopacity": "0.16", "ctashadow": "0.55",
    "wash": "0.22",
}

ACCENTS = {"primary", "good", "warn", "bad", "violet", "cyan"}

# Shared by every asset: entrances move, never fade, and always concede to
# prefers-reduced-motion.
MOTION = """
    .rise  { animation: rise .55s cubic-bezier(.2,.7,.3,1) both; }
    @keyframes rise { from { transform: translateY(9px) } to { transform: translateY(0) } }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important } }"""


def esc(s: str) -> str:
    """Escape XML text. One raw & from a project name breaks the whole file."""
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def esc_attr(s: str) -> str:
    """Escape for an attribute value, not text content.

    esc() is not enough here. A double quote inside an attribute closes it
    early, the SVG stops being well-formed, and GitHub renders a malformed SVG
    as nothing at all - blank space, no error. Titles with quoted phrases and
    any command line carrying shell quotes both hit this.
    """
    return esc(s).replace('"', "&quot;")


def fill(text: str, facts: dict) -> str:
    """Substitute {key} and {key:format} from the facts dict.

    A missing key raises rather than rendering blank, so a renamed field fails
    the build instead of silently shipping a gap in the banner.
    """
    if not isinstance(text, str) or "{" not in text:
        return text
    try:
        return string.Formatter().vformat(text, (), facts)
    except KeyError as e:
        sys.exit(f"error: spec references unknown fact {e} in: {text!r}")
    except (ValueError, TypeError) as e:
        sys.exit(f"error: bad format spec in {text!r}: {e}")


def paint(template: str, p: dict) -> str:
    """Substitute __TOKEN__ placeholders.

    Used instead of str.format so the CSS braces in the templates need no
    escaping.
    """
    out = template
    for k, v in p.items():
        out = out.replace(f"__{k.upper()}__", str(v))
    return out.replace("__FONT__", FONT).replace("__MONO__", MONO)


def wrap(text: str, width: int) -> list[str]:
    """Greedy character-budget wrap. Approximate by design - exact text metrics
    are not available without a font, and banner copy is short enough that a
    character budget is close enough."""
    lines: list[str] = []
    line = ""
    for word in text.split():
        candidate = f"{line} {word}".strip()
        if len(candidate) > width and line:
            lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        lines.append(line)
    return lines


def accent(name: str, where: str) -> str:
    if name not in ACCENTS:
        sys.exit(f"error: {where} has unknown accent {name!r}; "
                 f"expected one of {', '.join(sorted(ACCENTS))}")
    return f"__{name.upper()}__"


# --------------------------------------------------------------------------- #
# Hero
# --------------------------------------------------------------------------- #

def hero(spec: dict, facts: dict) -> str:
    title = esc(fill(spec["title"], facts))
    subtitle = fill(spec.get("subtitle", ""), facts)  # escaped per line after wrapping
    tiles_in = spec.get("tiles", [])
    badges = [esc(fill(b, facts)) for b in spec.get("badges", [])]

    if len(tiles_in) > 4:
        sys.exit("error: hero supports at most 4 tiles; more will not fit 1200px")

    # Everything below the rule is positioned off the subtitle's line count, so a
    # long subtitle grows the canvas instead of colliding with the tile row.
    # See the note in banner(): drawn at 1200, read at ~900, so every size here
    # arrives a third smaller than it looks in the source.
    eyebrow = esc(fill(spec.get("eyebrow", ""), facts))
    col = accent(spec.get("accent", "primary"), "hero")

    # The title sits at hero scale, so the subtitle starts lower than it used to
    # and every downstream row is measured off it rather than hard-coded.
    title_y = 150 if eyebrow else 122
    sub_lines = wrap(subtitle, 100) if subtitle else []
    rule_y = title_y + 34
    last_text_y = (rule_y + 34 + (len(sub_lines) - 1) * 30) if sub_lines else rule_y
    tiles_y = last_text_y + 30
    badge_y = (tiles_y + 122) if tiles_in else tiles_y
    height = (badge_y + 62) if badges else (tiles_y + 124)

    # Tiles share the row evenly so 2, 3 or 4 all look deliberate.
    tiles = []
    if tiles_in:
        gap, left, right = 16, 40, 40
        total = 1200 - left - right - gap * (len(tiles_in) - 1)
        w = total // len(tiles_in)
        x = left
        for i, t in enumerate(tiles_in):
            col = accent(t.get("colour", "primary"), f"hero tile {i + 1}")
            value = esc(fill(t["value"], facts))
            label = esc(fill(t.get("label", ""), facts))
            tiles.append(f"""
  <g class="rise" style="animation-delay:{0.35 + i * 0.11:.2f}s">
    <rect x="{x}" y="{tiles_y}" width="{w}" height="100" rx="10" fill="__CARD__" stroke="__BORDER__"/>
    <rect x="{x}" y="{tiles_y}" width="4" height="100" rx="2" fill="{col}"/>
    <text x="{x + 22}" y="{tiles_y + 50}" font-family="__FONT__" font-size="35" font-weight="700"
          fill="__TEXT__" letter-spacing="-0.5">{value}</text>
    <text x="{x + 22}" y="{tiles_y + 78}" font-family="__FONT__" font-size="16.5"
          fill="__MUTED__">{label}</text>
  </g>""")
            x += w + gap

    bx = 40
    badge_svg = []
    for i, b in enumerate(badges):
        bw = 24 + len(b) * 8.4
        badge_svg.append(f"""
  <g class="rise" style="animation-delay:{0.85 + i * 0.07:.2f}s">
    <rect x="{bx:.0f}" y="{badge_y}" width="{bw:.0f}" height="32" rx="16"
          fill="__CARD2__" stroke="__BORDER__"/>
    <text x="{bx + bw / 2:.0f}" y="{badge_y + 21}" text-anchor="middle"
          font-family="__FONT__" font-size="15.5" fill="__MUTED__">{b}</text>
  </g>""")
        bx += bw + 10

    sub = ""
    for i, line in enumerate(sub_lines):
        sub += (f"""
  <text class="rise" style="animation-delay:{0.2 + i * 0.05:.2f}s" x="40" y="{rule_y + 34 + i * 30}"
        font-family="__FONT__" font-size="21" fill="__MUTED__">{esc(line)}</text>""")

    eyebrow_svg = ""
    if eyebrow:
        eyebrow_svg = f"""
  <text class="rise" x="40" y="72" font-family="__FONT__" font-size="19" font-weight="700"
        letter-spacing="3" fill="{col}">{eyebrow.upper()}</text>"""

    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 {height}"
     width="1200" height="{height}" role="img" aria-label="{esc_attr(fill(spec["title"], facts))}">
  <style>
    /* Entrance animations move things but never fade them. A renderer that does
       not run CSS - GitHub's mobile app, an email digest, a PDF export - would
       otherwise show an empty banner, because the from-state of a fade is
       invisible and fill-mode `both` holds it for the whole delay. Every element
       here is fully legible with the animation stripped out. */{MOTION}
    .sweep {{ animation: sweep .9s cubic-bezier(.2,.7,.3,1) .15s; }}
    .blob  {{ animation: drift 14s ease-in-out infinite alternate; }}
    @keyframes sweep {{ from {{ width: 0 }} to {{ width: 1120px }} }}
    @keyframes drift {{ from {{ transform: translate(0,0) }}
                        to   {{ transform: translate(64px,-22px) }} }}
  </style>
  <defs>
    <radialGradient id="g" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="__GLOW__" stop-opacity="__GLOWOPACITY__"/>
      <stop offset="100%" stop-color="__GLOW__" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="w" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="{col}" stop-opacity="0.10"/>
      <stop offset="55%" stop-color="{col}" stop-opacity="0.03"/>
      <stop offset="100%" stop-color="{col}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <!-- The panel is painted in the theme's own card colour, the same one the
       section banners use, so the hero reads as a deliberate surface on all four
       GitHub backgrounds instead of borrowing whichever one is behind it. -->
  <rect width="1200" height="{height}" rx="16" fill="__CARD__"/>
  <rect width="1200" height="{height}" rx="16" fill="url(#w)"/>
  <rect x="0.5" y="0.5" width="1199" height="{height - 1}" rx="15.5"
        fill="none" stroke="__BORDER__"/>
  <rect width="8" height="{height}" rx="4" fill="{col}"/>
  <g class="blob"><circle cx="1010" cy="70" r="240" fill="url(#g)"/></g>{eyebrow_svg}
  <text class="rise" x="40" y="{title_y}" font-family="__FONT__" font-size="66" font-weight="800"
        fill="__TEXT__" letter-spacing="-1.8">{title}</text>
  <rect class="sweep" x="40" y="{rule_y}" width="1120" height="2"
        rx="1" fill="__BORDER__"/>{sub}{''.join(tiles)}{''.join(badge_svg)}
</svg>
"""


# --------------------------------------------------------------------------- #
# Section banner
# --------------------------------------------------------------------------- #

def banner(spec: dict, facts: dict) -> str:
    eyebrow = esc(fill(spec.get("eyebrow", ""), facts))
    title = esc(fill(spec["title"], facts))
    body = fill(spec.get("body", ""), facts)
    col = accent(spec.get("accent", "primary"), f"banner {spec.get('name')}")
    # Sizes are chosen for the RENDERED result, not the source. The canvas is
    # 1200 wide and GitHub's content column is ~900, so everything here is seen
    # at 0.75x: a 12px source size arrives as 9px. Divide by 1.33 to see what
    # the reader actually gets, and keep the result above 11px.
    lines = wrap(body, 122)
    body_y0 = 108 if eyebrow else 88
    body_step = 26
    height = body_y0 + max(0, len(lines) - 1) * body_step + 30

    body_svg = "".join(f"""
  <text x="40" y="{body_y0 + i * body_step}" font-family="__FONT__" font-size="17.5"
        fill="__MUTED__">{esc(line)}</text>""" for i, line in enumerate(lines))

    eyebrow_svg = ""
    if eyebrow:
        eyebrow_svg = f"""
  <text x="40" y="42" font-family="__MONO__" font-size="17" font-weight="700"
        letter-spacing="1.6" fill="{col}">{eyebrow.upper()}</text>"""

    # The wash is a tint of the accent, not a solid fill: a solid band fights the
    # page on every one of GitHub's four surfaces.
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 {height}"
     width="1200" height="{height}" role="img" aria-label="{esc_attr(fill(spec["title"], facts))}">
  <style>{MOTION}</style>
  <defs>
    <linearGradient id="w" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="{col}" stop-opacity="__WASH__"/>
      <stop offset="100%" stop-color="{col}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="{height}" rx="12" fill="__CARD__"/>
  <rect width="1200" height="{height}" rx="12" fill="url(#w)"/>
  <rect width="6" height="{height}" rx="3" fill="{col}"/>
  <g class="rise">{eyebrow_svg}
  <text x="40" y="{78 if eyebrow else 56}" font-family="__FONT__" font-size="29"
        font-weight="700" fill="__TEXT__" letter-spacing="-0.4">{title}</text>{body_svg}
  </g>
</svg>
"""


# --------------------------------------------------------------------------- #
# Call-to-action button
# --------------------------------------------------------------------------- #

def cta(spec: dict, facts: dict) -> str:
    label = esc(fill(spec["label"], facts))
    sublabel = esc(fill(spec.get("sublabel", ""), facts))
    col = accent(spec.get("accent", "primary"), "cta")
    col2 = accent(spec.get("accent2", spec.get("accent", "primary")), "cta second stop")

    # Rendered at 1320 and displayed at width="660" for a 2x effective
    # resolution. It paints no page background - only the button - so it sits
    # cleanly on all four GitHub surfaces including dark dimmed (#22272E).
    # The fill runs left-to-right across two accents rather than darkening one,
    # so the button reads as a deliberate control instead of a flat slab.
    x0, w = 150, 1020
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1320 152"
     width="1320" height="152" role="img" aria-label="{esc_attr(fill(spec["label"], facts))}">
  <style>{MOTION}
    .sheen {{ animation: sheen 4.5s ease-in-out infinite 1.4s; }}
    @keyframes sheen {{ from {{ transform: translateX(-260px) }}
                        to   {{ transform: translateX(1320px) }} }}
    .nudge {{ animation: nudge 2.4s ease-in-out infinite; }}
    @keyframes nudge {{ 0%,70%,100% {{ transform: translateX(0) }}
                        85% {{ transform: translateX(9px) }} }}
  </style>
  <defs>
    <linearGradient id="btn" x1="0" y1="0" x2="1" y2="0.6">
      <stop offset="0%" stop-color="{col}"/>
      <stop offset="100%" stop-color="{col2}"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.22"/>
      <stop offset="55%" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <filter id="sh" x="-20%" y="-60%" width="140%" height="260%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="{col}"
                    flood-opacity="__CTASHADOW__"/>
    </filter>
    <clipPath id="clip"><rect x="{x0}" y="14" width="{w}" height="100" rx="28"/></clipPath>
    <linearGradient id="sheenfade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0"/>
      <stop offset="50%" stop-color="#FFFFFF" stop-opacity="0.20"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <g class="rise">
    <rect x="{x0}" y="14" width="{w}" height="100" rx="28" fill="url(#btn)" filter="url(#sh)"/>
    <rect x="{x0}" y="14" width="{w}" height="100" rx="28" fill="url(#gloss)"/>
    <rect x="{x0 + 1}" y="15" width="{w - 2}" height="98" rx="27"
          fill="none" stroke="#FFFFFF" stroke-opacity="0.30"/>
    <g clip-path="url(#clip)">
      <rect class="sheen" x="{x0}" y="14" width="190" height="100" fill="url(#sheenfade)"/>
    </g>
    <!-- Font sizes look oversized in the source because the asset is drawn at
         1320 and displayed at width="660" - halve them to judge the result. -->
    <g class="nudge">
      <circle cx="{x0 + 62}" cy="64" r="30" fill="#FFFFFF" fill-opacity="0.18"/>
      <path d="M {x0 + 50} 50 L {x0 + 78} 64 L {x0 + 50} 78 Z" fill="#FFFFFF"/>
    </g>
    <text x="{x0 + 118}" y="{58 if sublabel else 76}" font-family="__FONT__"
          font-size="38" font-weight="800" fill="#FFFFFF" letter-spacing="-0.6">{label}</text>
    <text x="{x0 + 118}" y="92" font-family="__FONT__" font-size="23"
          fill="#FFFFFF" opacity="0.88">{sublabel}</text>
    <g class="nudge">
      <path d="M {x0 + w - 96} 64 h 46 m -18 -17 l 18 17 l -18 17" fill="none"
            stroke="#FFFFFF" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
  </g>
</svg>
"""


# --------------------------------------------------------------------------- #
# Terminal cast
# --------------------------------------------------------------------------- #

# Neither toolkit has a UI to screenshot, so the closest honest equivalent of a
# page tour is the run itself. These are real captured runs against the BigQuery
# report and semantic model in this repo, not mock-ups - which is the only
# reason the numbers on them can be trusted.
CAST_ROLES = {"text", "muted", "faint", "good", "warn", "bad",
              "primary", "violet", "cyan"}


def cast(spec: dict, facts: dict) -> str:
    """A terminal card: a prompt line, then captured output lines.

    Lines rise in sequence to suggest a run in progress. Transform only - a
    renderer that drops the CSS shows the finished output, which is the state
    that carries the information.
    """
    command = esc(fill(spec["command"], facts))
    col = accent(spec.get("accent", "primary"), f"cast {spec.get('name')}")
    lines_in = spec.get("lines", [])
    if not lines_in:
        sys.exit(f"error: cast {spec.get('name')!r} has no lines")

    pad, lh = 30, 26
    top = 100                     # below the title bar and the prompt line
    height = top + len(lines_in) * lh + 18

    rows = []
    for i, item in enumerate(lines_in):
        if isinstance(item, str):
            item = {"t": item}
        role = item.get("c", "muted")
        if role not in CAST_ROLES:
            sys.exit(f"error: cast line role {role!r} not in "
                     f"{', '.join(sorted(CAST_ROLES))}")
        weight = "700" if item.get("bold") else "400"
        text = esc(fill(item.get("t", ""), facts))
        # Stagger is capped so a long capture does not take ten seconds to land.
        delay = min(0.055 * i, 1.25)
        rows.append(f"""
  <g class="ln" style="animation-delay:{delay:.2f}s"><text x="{pad}"
        y="{top + i * lh}" font-family="__MONO__" font-size="15.5"
        font-weight="{weight}" fill="__{role.upper()}__"
        xml:space="preserve">{text}</text></g>""")

    caret_y = top + len(lines_in) * lh - 4
    # The caret is deliberately static. It was the only element animating
    # opacity, and an opacity keyframe is exactly the thing that leaves an asset
    # invisible in a renderer that half-applies the CSS - not worth a blink.
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 {height}"
     width="1200" height="{height}" role="img"
     aria-label="Captured terminal output of: {esc_attr(fill(spec["command"], facts))}">
  <style>{MOTION}
    .ln {{ animation: rise .4s cubic-bezier(.2,.7,.3,1) both; }}
  </style>
  <rect width="1200" height="{height}" rx="12" fill="__CARD__"/>
  <rect x="0.5" y="0.5" width="1199" height="{height - 1}" rx="11.5"
        fill="none" stroke="__BORDER__"/>
  <path d="M0 12a12 12 0 0 1 12-12h1176a12 12 0 0 1 12 12v28H0z" fill="__CARD2__"/>
  <line x1="0" y1="40" x2="1200" y2="40" stroke="__BORDER__"/>
  <circle cx="26" cy="20" r="5" fill="__BAD__" opacity="0.7"/>
  <circle cx="44" cy="20" r="5" fill="__WARN__" opacity="0.7"/>
  <circle cx="62" cy="20" r="5" fill="__GOOD__" opacity="0.7"/>
  <!-- muted, not faint: faint (#484F58) against the dark card (#161B22) is
       effectively invisible - checked against a rasterised preview. -->
  <text x="600" y="25" text-anchor="middle" font-family="__FONT__"
        font-size="15" fill="__MUTED__">{esc(fill(spec.get("caption", ""), facts))}</text>
  <text x="{pad}" y="72" font-family="__MONO__" font-size="15.5"
        xml:space="preserve"><tspan fill="{col}" font-weight="700">$ </tspan><tspan fill="__TEXT__">{command}</tspan></text>
  <rect x="{pad}" y="{caret_y}" width="8" height="2" fill="{col}"/>{"".join(rows)}
</svg>
"""


# --------------------------------------------------------------------------- #
# Feature strip - N cards side by side
# --------------------------------------------------------------------------- #

def cards(spec: dict, facts: dict) -> str:
    items = spec.get("cards", [])
    if not (2 <= len(items) <= 3):
        sys.exit("error: a card strip holds 2 or 3 cards; more will not fit 1200px")

    gap, left, right = 20, 0, 0
    w = (1200 - left - right - gap * (len(items) - 1)) // len(items)
    # Every card is drawn to the tallest card's body, so the strip has one
    # baseline instead of three ragged ones.
    wrapped = [wrap(fill(c.get("body", ""), facts), 42) for c in items]
    height = 150 + max(len(b) for b in wrapped) * 27 + 60

    out = []
    for i, (c, body) in enumerate(zip(items, wrapped)):
        col = accent(c.get("colour", "primary"), f"card {i + 1}")
        x = left + i * (w + gap)
        lines = "".join(
            f"""
    <text x="{x + 28}" y="{150 + j * 27}" font-family="__FONT__" font-size="18"
          fill="__MUTED__">{esc(line)}</text>""" for j, line in enumerate(body))
        foot_y = height - 30
        out.append(f"""
  <g class="rise" style="animation-delay:{0.15 + i * 0.12:.2f}s">
    <rect x="{x}" y="0" width="{w}" height="{height}" rx="14" fill="__CARD__" stroke="__BORDER__"/>
    <rect x="{x}" y="0" width="{w}" height="5" rx="2.5" fill="{col}"/>
    <circle cx="{x + 50}" cy="62" r="26" fill="{col}" fill-opacity="0.14"/>
    <text x="{x + 50}" y="72" text-anchor="middle" font-family="__FONT__"
          font-size="27">{esc(c.get("icon", ""))}</text>
    <text x="{x + 28}" y="118" font-family="__FONT__" font-size="23" font-weight="700"
          fill="__TEXT__" letter-spacing="-0.4">{esc(fill(c.get("title", ""), facts))}</text>{lines}
    <rect x="{x + 28}" y="{foot_y - 21}" width="{w - 56}" height="1" fill="__BORDER__"/>
    <text x="{x + 28}" y="{foot_y}" font-family="__FONT__" font-size="17" font-weight="700"
          fill="{col}" letter-spacing="0.3">{esc(fill(c.get("stat", ""), facts))}</text>
  </g>""")

    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 {height}"
     width="1200" height="{height}" role="img" aria-label="{esc_attr(spec.get("label", "Feature strip"))}">
  <style>{MOTION}</style>
{''.join(out)}
</svg>
"""


# --------------------------------------------------------------------------- #

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--spec", default="readme-assets.json")
    ap.add_argument("--out", default=None, help="overrides out_dir in the spec")
    args = ap.parse_args()

    spec_path = Path(args.spec).resolve()
    if not spec_path.exists():
        sys.exit(f"error: no spec at {spec_path}")
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    root = spec_path.parent

    facts: dict = {}
    if spec.get("facts_from"):
        facts_path = (root / spec["facts_from"])
        if not facts_path.exists():
            facts_path = Path(spec["facts_from"])
        if not facts_path.exists():
            sys.exit(f"error: facts_from not found: {spec['facts_from']}")
        facts = json.loads(facts_path.read_text(encoding="utf-8"))
    facts.update(spec.get("facts", {}))

    out = Path(args.out) if args.out else root / spec.get("out_dir", "assets")
    out.mkdir(parents=True, exist_ok=True)

    jobs: list[tuple[str, str]] = []
    if "hero" in spec:
        jobs.append((spec["hero"].get("name", "hero"), hero(spec["hero"], facts)))
    for b in spec.get("banners", []):
        if "name" not in b:
            sys.exit("error: every banner needs a name")
        jobs.append((b["name"], banner(b, facts)))
    for s in spec.get("strips", []):
        if "name" not in s:
            sys.exit("error: every card strip needs a name")
        jobs.append((s["name"], cards(s, facts)))
    for c in spec.get("casts", []):
        if "name" not in c:
            sys.exit("error: every cast needs a name")
        jobs.append((c["name"], cast(c, facts)))
    if "cta" in spec:
        jobs.append((spec["cta"].get("name", "cta"), cta(spec["cta"], facts)))

    if not jobs:
        sys.exit("error: spec produced nothing - expected hero, banners, casts or cta")

    overrides = spec.get("palette", {})
    written = 0
    for palette in (LIGHT, DARK):
        p = dict(palette)
        p.update({k.lower(): v for k, v in overrides.get(palette["name"], {}).items()})
        for name, template in jobs:
            path = out / f"{name}-{palette['name']}.svg"
            # write_text with an explicit encoding, never PowerShell redirection:
            # a UTF-8 BOM in an SVG makes some renderers reject the file.
            path.write_text(paint(template, p), encoding="utf-8")
            written += 1
            print(f"  {path.relative_to(root) if root in path.parents else path}")

    print(f"{written} files written to {out}")
    print("\nReference each pair in the README as:\n")
    for name, _ in jobs:
        print(f'<picture>\n'
              f'  <source media="(prefers-color-scheme: dark)" '
              f'srcset="{out.name}/{name}-dark.svg">\n'
              f'  <img alt="DESCRIBE THE CONTENT" src="{out.name}/{name}-light.svg">\n'
              f'</picture>\n')


if __name__ == "__main__":
    main()
