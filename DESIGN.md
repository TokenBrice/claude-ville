---
name: ClaudeVille
description: A torchlit medieval-keep HUD wrapped around a living pixel-art village of AI coding agents.
colors:
  bg-0: "#0b0908"
  bg-1: "#15100d"
  bg-2: "#1d1612"
  bg-3: "#2a2019"
  line-1: "#3a2c20"
  line-2: "#5a4330"
  brass: "#b8893f"
  ink-1: "#eee3cb"
  ink-2: "#bfae8f"
  ink-3: "#97876e"
  ink-4: "#5f5344"
  gold: "#f2c75c"
  gold-hi: "#ffe08a"
  harbor-teal: "#7ac8d8"
  status-working: "#79d975"
  status-idle: "#86bfe0"
  status-waiting: "#df8c3f"
  status-rate-limited: "#f06ae0"
  status-errored: "#e06c5b"
  status-waiting-user: "#e8d44d"
typography:
  display:
    fontFamily: "'Press Start 2P', monospace"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "16px"
  label:
    fontFamily: "'Press Start 2P', monospace"
    fontSize: "8px"
    fontWeight: 400
    lineHeight: "8px"
    letterSpacing: "1px"
  body:
    fontFamily: "'Departure Mono', ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "16px"
  numeral:
    fontFamily: "'Departure Mono', ui-monospace, monospace"
    fontSize: "22px"
    fontWeight: 400
    lineHeight: "22px"
rounded:
  none: "0px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "24px"
components:
  topbar:
    backgroundColor: "{colors.bg-1}"
    height: "48px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.ink-3}"
    size: "28px"
  icon-button-engaged:
    backgroundColor: "{colors.bg-3}"
    textColor: "{colors.gold-hi}"
  well:
    backgroundColor: "{colors.bg-0}"
    textColor: "{colors.ink-3}"
    height: "28px"
  button-mode-active:
    backgroundColor: "{colors.gold}"
    textColor: "#241812"
  tooltip:
    backgroundColor: "{colors.bg-2}"
    textColor: "{colors.ink-1}"
    padding: "3px 5px"
  modal:
    backgroundColor: "{colors.bg-1}"
    textColor: "{colors.ink-2}"
    padding: "16px"
  toast:
    backgroundColor: "{colors.bg-2}"
    textColor: "{colors.ink-1}"
    padding: "6px 12px"
---

# Design System: ClaudeVille

## 1. Overview

**Creative North Star: "The Keep at Night"** *(the chrome only)*

"The Keep at Night" describes the DOM **frame**, not the whole app. The chrome is the interior of a darkened keep: walls of near-black timber, parchment-coloured lettering, and at the center a window onto the village below. The chrome is never bright by default. It is meant to be left lit in the corner of a second monitor: quiet when the work is quiet, warm to glance at, and only loud when a single agent genuinely needs a person. Every chrome surface is *milled, not carved*: flat timber planes separated by a single 1px lit bevel and a 1px black seam, so the frame reads as one quiet instrument around the living world.

The window the frame surrounds is a *living* world. The canvas village runs on the real clock and weather: bright blue sky and lit water at midday, torchlit and moonlit at 2am. A permanently-dark keep framing a window onto a world that changes with the hour is the deliberate two-mood idea at the heart of ClaudeVille; do not flatten either half toward the other.

This system serves a `brand`-register product: the village is the point, and the chrome is its frame, not a competing dashboard. It is built for one developer at a desktop (1280px and wider; no mobile, no fluid breakpoints). Density is high and type is small because the reward is a dense, hand-made little world, not a roomy app shell. Color is rationed: gold is light, not fill, and saturated hues belong to agent status alone.

This spec documents the DOM chrome only. The canvas village's own visual system (terrain and water palette, the nine buildings, sprite identity, and a real-time atmosphere engine for day/dusk/night, weather, and seasons) is canonical in `claudeville/src/config/artPalette.js` (the master palette and value ladder), `claudeville/src/config/theme.js`, the [World mode README](claudeville/src/presentation/character-mode/README.md) (grade, pixel grid, effect language, and label tiers), `docs/visual-experience-crafting.md`, `docs/motion-budget.md`, and `docs/world-visual-qa-checklist.md`. Treat those as the reference for anything drawn on canvas. The two systems share the type grid (Press Start 2P 8/16, Departure Mono 11/22, no bold) and the rule that saturated colour belongs to status.

It explicitly rejects the look of a **generic SaaS dashboard** (cool grays, Inter, chart-card grids), **neon cyberpunk / synthwave** (glowing neon grids, purple-and-cyan), **corporate gamification** (badges, points, XP bars bolted onto a business app), and **mobile / casual-game UI** (bubbly buttons, candy gradients, juicy CTAs). It is a game world, hand-pixelled, not a gamified spreadsheet and not an App Store toy.

**Key Characteristics:**
- A two-face type system on the glyph grid: `Press Start 2P` at 8/16px, `Departure Mono` at 11/22px.
- Parchment ink on warm near-black; gold is light, reserved for four things (wordmark, selected, active tab, focus).
- Two frame recipes: the three big columns keep one milled edge (flat surface + 1px `--line-2` bevel + 1px black seam); everything that floats, hangs or is lit wears the hand-drawn 9-slice frame kit. No radial highlights, texture stripes, glows or double frames.
- Saturated color reserved for agent status and provider identity, never decoration.
- Square corners.
- Calm at rest; motion is a status signal, with a reduced-motion fallback everywhere.
- The canvas village is a separate, real-time visual system (day/night, weather); it is documented in `theme.js` and the world docs, not in this spec.

## 2. Colors

A warm timber frame around a cool, living world: four surfaces, two lines, one brass, a four-step parchment ink ramp, and gold held back as light. Every chrome colour resolves to a token in `claudeville/css/reset.css`; legacy `--cv-*` names alias onto this ramp.

### Surfaces and lines
- **`--bg-0` #0b0908**: void, inputs, tab wells.
- **`--bg-1` #15100d**: panel body (top bar, sidebar, activity panel, modals).
- **`--bg-2` #1d1612**: hover row, toasts, popovers.
- **`--bg-3` #2a2019**: selected row, engaged icon plate.
- **`--line-1` #3a2c20**: internal dividers and hairlines.
- **`--line-2` #5a4330**: the outer bevel, the one lit edge of a panel.
- **`--brass` #b8893f**: metal accents (an engaged switch rim), never text.

### Ink (text)
- **`--ink-1` #eee3cb**: primary text; the default for the whole document.
- **`--ink-2` #bfae8f**: secondary text and counts.
- **`--ink-3` #97876e**: labels, captions, meta (≥ 4.5:1 on every `--bg-*`, including the selected-row `--bg-3`).
- **`--ink-4` #5f5344**: zeros, dashes, disabled; non-essential only.

### Light
- **`--gold` #f2c75c** and **`--gold-hi` #ffe08a**: the wordmark, a selected row or name, the active mode tab, the focus ring, and an engaged toggle's glyph.

### Status (the fenced spectrum)
Canonical in `STATUS_VISUALS` (`claudeville/src/config/theme.js`), stamped onto `--cv-status-*` at boot: working #79d975, idle #86bfe0, waiting #df8c3f, rate-limited #f06ae0, errored #e06c5b, waiting on user #e8d44d. Rate-limited is a magenta orchid (HSL hue 307, 7.4:1 on `--bg-0`): it sits in the widest gap of the repo pennant palette, 105° from idle, and at OKLab ΔE ≥ 0.09 from every tool, accent and pennant hue, so a quota stop never reads as idle or as a repo. The World's incident colours (`INCIDENT_COLORS_RGB` quota and `rate_limited`) use the same orchid. Tool-category colours are canonical in `TOOL_CATEGORY_COLORS` (same file) and mirrored as `--cv-tool-*`: status-free hues (teal, rose, violet, plum, azure) so a tool chip never reads as a status.

### Named Rules
**The Ink-and-Light Rule.** Text is ink, not gold. Parchment ink (`--ink-1..4`) carries every word and number; gold appears only on the wordmark, the selected item, the active tab and focus. A zero or an unknown recedes to `--ink-4`; an unknown count is shown as `–`, never as a fabricated `0`.

**The Status-Only Color Rule.** The saturated spectrum (green, blue, orange, red, yellow, orchid) is reserved for agent status and provider identity. It never decorates. If red means "errored," nothing else may be red for flavor. In notices the status colour lives on a 3px rail, not on the text.

**The Warm-Frame Rule.** The frame stays warm; do not tint it cool to match the world. The two moods are the design.

## 3. Typography

**Display / Label Font:** `Press Start 2P` (with `monospace` fallback)
**Body / Data / Numeral Font:** `Departure Mono` (with system monospace fallbacks)

**Character:** ClaudeVille uses exactly two local faces, and both are bitmap fonts on fixed grids: `Press Start 2P` is 8px per em, `Departure Mono` is 11px per em. `Press Start 2P` carries the wordmark, titles, eyebrows, captions and short controls; `Departure Mono` carries everything readable: prose, paths, names, timestamps, inputs and numbers. Do not introduce a third face.

### Hierarchy (tokens in `reset.css`)
- **Display** `--fs-display` (PS2P 16px / 16px): the `ClaudeVille` wordmark, the activity-panel agent name, modal titles.
- **Label** `--fs-label` (PS2P 8px / 8px, letter-spacing 1px, UPPERCASE): eyebrows, section titles, KPI captions, mode tabs, short buttons.
- **Body** `--fs-body` (DM 11px / 16px): all prose, data, paths, names, toasts, inputs.
- **Numeral** `--fs-numeral` (DM 22px / 22px, tabular): hero numbers only (top-bar KPIs, token and cost totals, Chronicle stats).

### Named Rules
**The Whole-Pixel Rule.** Every text size is an integer multiple of its face's glyph grid: Press Start 2P at 8, 16 or 24px; Departure Mono at 11, 22 or 33px. Line-heights are integer pixels. Whole pixels are not enough: a 10, 12 or 13px bitmap face drops or doubles glyph rows and columns. Font smoothing is turned off once, on `body`; never fluid `clamp()` sizing.

**The No-Bold Rule.** Each face ships one weight. Never set `font-weight: 700` (or `bold`) on either face; the browser would smear a synthesized bold. `font-synthesis: none` is set on `body` as a backstop. Emphasis is ink (`--ink-1` over `--ink-2/3`), never weight.

**The Breathing-Label Rule.** Small labels get `letter-spacing: 1px` and uppercase so the heavy glyphs have air. Uppercase is for short labels only (a few words), never for sentences or messages.

## 4. Elevation

Depth is a single milled edge, not a carving. A panel is a flat `--bg-1` plane; where it meets another plane it shows one 1px `--line-2` lit bevel on its own side and one 1px black seam on the outside. Tonal steps (`--bg-0` wells below the panel, `--bg-2` and `--bg-3` plates above it) do the rest.

### Shadow Vocabulary
- **Bevel** (`--bevel-bottom: inset 0 -1px 0 var(--line-2), 0 1px 0 #000`; `--bevel-top` mirrors it): the top bar, the sidebar and the activity panel (the three big columns).
- **Well**: the frame kit's recessed `well` slice (below) around segmented tab groups; inputs keep a `--bg-0` fill with a 1px `--line-1` inset.
- **Plate** (`--bg-2` on hover, `--bg-3` when engaged): ghost buttons have no plate at rest.

### Frame kit (plan 9.5)
Six hand-authored 9×9 PNGs in `claudeville/assets/ui/`, drawn pixel by pixel on the chrome palette (no generated art), applied as nine-slice borders by `claudeville/css/frame-kit.css`: `class="cv-frame cv-frame--<name>"` sets `border-image: url(…) 3 fill / 3px / 0 stretch; image-rendering: pixelated` and removes the element's own background, border and box-shadow (the frame's face is its fill). Slice equals width, so every frame pixel is an exact 1× copy at DPR 1 and 2× at DPR 2; edge slices are uniform along their length, so `stretch` never resamples.

Raised frames (3 px): a black seam with a 1 px notch at each corner, the walnut lit edge `#6e533a` on the top and left, the shade `#2a1f16` on the bottom and right, and a 1 px cast line inside the lit edge (one ramp step below the face), so light comes from the upper left like the world's sun key:

```
.KKKKKKK.   K seam #000   L lit (top/left)   S shade (bottom/right)
KKLLLLLKK   I cast line   F face              . transparent notch
KLIIIIISK
KLIFFFFSK   walnut: L #6e533a  S #2a1f16  I #0b0908  F #15100d (--bg-1)
KLIFFFFSK   bg2:    L #6e533a  S #2a1f16  I #15100d  F #1d1612 (--bg-2)
KLIFFFFSK   attn / attn-error / attn-limit: L = the status hue, S = 60 % hue,
KLIFFFFSK     I = 8 % hue, F = 16 % hue over --bg-1 (the lit slot's old mix)
KKSSSSSKK
.KKKKKKK.
```

The recessed `well` (2 px slice, so a well stays 28 px tall) is the raised bevel inverted, a sunken channel under the same upper-left light: seam with a notch, the shade `#2a1f16` on the top and left (the channel's shadowed walls), the walnut lit edge `#6e533a` on the bottom and right (the lip that catches the light), `--bg-0` face.

| Slice | Where |
| --- | --- |
| `walnut` | the World dock (left, right and bottom; it hangs from the bar's seam), modals, the active mode tab's rim (no fill: the gold face shows through), the activity-panel hero portrait |
| `bg2` | the World-controls popover, the first-run hint, the chrome tooltip |
| `well` | the `WORLD \| DASHBOARD` and `FREE \| AUTO \| AMBIENT` wells |
| `attn`, `attn-error`, `attn-limit` | the top bar's lit slot (the slice of the first lit bucket), the World call card, the Dashboard's bell-lane call cards and the sidebar's attention shelf (the slice of its status or lead bucket), and attention, summons and reminder toasts |

Editing a frame means editing its 9×9 PNG: keep the edge rows and columns uniform, the notch transparent, and the attn faces equal to their `--cv-attn-fill-*` tokens in `frame-kit.css`; if a status hue changes in `theme.js`, redraw its attn slice.

### Named Rules
**The Single-Bevel Rule.** The three big columns carry one 1px lit bevel plus one 1px black seam per edge, nothing more. No soft drop shadows, no glows, no radial highlights, no texture stripes, no inset double frames; they blur the pixel grid and make the three columns read as different objects.

**The Hand-Drawn Frame Rule.** A floating, hanging or lit surface is framed by a kit slice, never by stacked box-shadows, `corner-shape` or a scaled image. A new frame is a new hand-drawn 9×9 PNG on the chrome palette, lit from the upper left, applied with slice = width.

## 5. Components

Affordances are consistent across the keep: the same surfaces, the same bevel, the same `:focus-visible` gold outline (2px `--gold-hi`, 2px offset).

### Top bar
- 48px, `--bg-1`, bottom bevel. Left: wordmark over a one-line `--ink-3` meta line (connection · version · FPS · village clock). The connection chip says `SYNCING` while the village starts or syncs (never a green `LIVE` before the first snapshot) and `DEGRADED` when a source is unreadable.
- Centre: KPI stacks, a 22px numeral over an 8px caption, coloured by status only when non-zero; zeros and unknowns recede to `--ink-4`. The attention slot is the only framed, lit slot: one part per non-zero bucket (**NEEDS YOU**, **ERROR**, **LIMIT**), each a KPI stack like its neighbours (the bucket's 8×8 motif at 2× beside the exact numeral, over the word), in its status colour, inside the attn slice of the first lit bucket; it exists only while a count is above zero and hides while counts are pending. `TOKENS SEEN TODAY` (new tokens this page observed today) is its own KPI after a hairline rule. At 1280px with all three buckets lit, every count and the spend KPI fit on the bar.
- Right: ghost 28px icon buttons (Chronicle, desktop alerts, sound and its chevron, settings), then the `WORLD | DASHBOARD` well. The bar has one shape in both modes: every control keeps its x when the mode changes.
- A static 1px red strip on the bevel shows the errored share of the fleet; there is no decorative rail.

### World dock
The World's own camera controls hang from the bar's seam at the world's top-right (12px in from its edge), a 36px walnut tab open at the top, inside `#characterMode` so it follows the world's edge when the activity panel opens and disappears with the world in Dashboard. It holds the `FREE | AUTO | AMBIENT` well (one segment pressed: the camera's owner; a revoked Ambient waits as a hollow gold pip on `AMBIENT`, and the operator's Ambient is a standing choice that returns after a reload or a Dashboard trip), the `READ` hold with its `B` key, and the World-controls compass. It publishes its rect as the reserved rect `world-dock` (`shared/ReservedRects.js`): T1 plates never sit under it.

### Tooltip
One pixel tooltip for the chrome (`#cvTip`, `shared/ChromeTooltip.js`): any `[data-tip]` control in the top bar, the dock, the sidebar or the activity panel shows it 400 ms after hover or keyboard focus (at once while another tip closed within 300 ms), with an optional `<kbd>` shortcut from `data-tip-key`. DM 11/16 `--ink-1` in the `bg2` slice, hung from the control's left edge by CSS anchor positioning and flipped to its right edge or above it at the viewport's edge; no animation, no native `title` on converted controls; Escape or a press hides it.

### Buttons
- **Shape:** square.
- **Ghost button (icons, short text controls):** no plate at rest, `--ink-3` glyph; hover `--bg-2` plate + `--ink-1`; engaged/pressed `--bg-3` plate + `--gold-hi` glyph.
- **Well tab (inactive):** 8px label in `--ink-3` inside the kit's `well` slice.
- **Mode tab (active):** the lit state, a raised key in the well: the `walnut` slice as its rim around a stepped gold face (1px `#fff0b0` highlight, `--gold` upper half, `#d6a951` lower half, 1px `#9c6732` foot) with near-black text (#241812). Gold as a fill is permitted *only* here, on the single active mode tab.
- **Bordered chip (modal actions, date navigation):** `--bg-0` with a 1px `--line-2` inset, 8px label in `--ink-2`.

### Toasts
Bottom-right of the viewport (16px in from the edge and the bottom), moving left of the activity panel while it is open, so bottom-left stays free for the World's lower-third caption. A plain toast is `--bg-2`, 1px `--line-2` border, 11px `--ink-1` text and a 3px status rail; an attention, summons or reminder toast wears the attn slice of its status instead of the border and rail (`Toast.js` `ATTENTION_FRAME`). The stack grows upward and steps in and out in four opacity steps. In Dashboard mode, attention and summons toasts are hidden visually (the bell lane already shows those agents) and stay in the live region. Joins stay silent until the first snapshot has been applied, departures use the info rail, and switching modes raises no toast.

### Chips & Badges
- **Count chips** (sidebar count, section count): plain `--ink-3` tabular numerals; a zero recedes to `--ink-4`.
- **Provider / model badges:** plain `--ink-2` text; identity colour lives on rails and swatches, not on badge fills. Team badges take their colour inline from `TeamColor.js`.
- **Stale badge:** a 1px `--line-2` border around 11px DM text in the waiting status colour.

### Dashboard rows and call cards
- **Corner Style:** square.
- **Background:** rows sit flat on one `--bg-1` section panel separated by `--line-1` hairlines; no per-row gradient, shadow, radial highlight, scanline texture or hover lift.
- **Status spine:** a 5px left spine in the agent's status colour whose *shape* also encodes the status (solid working, dashed waiting, long-dash waiting on you, double rule rate-limited, notched errored), so the spine never relies on hue alone. This is a functional status encoding, not decorative trim (see the rule below). Idle and aged rows dim only the portrait niche (62%) and the name (`--ink-2`), so the facts beside them stay at full strength; the selected row carries a static 1px gold rim. A bell-lane call card has no spine: it wears the attn slice of its status (one ask, one frame), which is its border and face.
- **Portrait:** every row has a static 44×40 niche; call cards and the selected detail use a 96px hero portrait. No walking avatars.
- **Internal Padding:** on the 4/8px rhythm.
- **Ground:** the Dashboard sits on flat `--bg-0` at every hour; it takes no time-of-day tint and no hearth glow from the world.

### Panels (Guild Ledger & Quest Log)
- **Sidebar (240px) and activity panel (320px, plus its 1px seam as its own left border so the seam never covers the world's last column):** `--bg-1`, the Single-Bevel edge on the side facing the world; no texture, no radial highlight.
- **Entrance:** the activity panel fades in; reduced-motion removes the animation.
- **Selected row:** `--bg-3` plus a gold 3px rail and a `--gold-hi` name.

### Modals (Settings, Chronicle, Changelog)
The `walnut` frame-kit slice around a `--bg-1` body; 16px PS2P title in `--ink-1`; sections carry an 8px PS2P eyebrow in `--ink-3` and `--line-1` dividers. Chronicle stats are 22px numerals over 8px captions; slider readouts never wrap and use tabular figures. Settings selects and sliders drop the native look (`appearance: none`): the select carries a stepped 8×4 pixel chevron; a slider is 88px wide with a 2px track, a hard-stop gold fill that ends on a whole pixel, and a square 8px thumb; every switch shares one rim rule. The Chronicle has no native date input: its controls are one text line, `PREVIOUS · Fri 25 Sep 2026 · NEXT · TODAY`, with export on the right.

**HDR highlights (plan 10.2).** SET's CONTROLS section carries one display select, *HDR highlights*: `Off · Subtle · Full`, **Subtle** by default, persisted as `claudeville.display.hdrHighlights` (`shared/DisplaySettings.js`) and applied live through `display:hdr-highlights`. It changes World pixels only, never the chrome: on the WebGPU renderer with an HDR screen, lamps, fires, action-needed marks and the verified-success peak rise above white (emitters capped below the NEEDS YOU mark; lamp halos drop out), and Subtle lifts less than Full. Its detail line states what this renderer and screen can show; under Canvas or WebGL, or a browser without HDR tone mapping, the select is `aria-disabled` (dimmed, still focusable so the reason is reachable) and the World shows the standard picture. The chrome stays sRGB on every screen; on a P3 screen only the World's reserved status and emission hues widen (plan 10.3).

### First-run hint and World popovers
The first-run hint and the World-controls popover wear the `bg2` slice and hang under the dock's compass (CSS anchor positioning); the pressed READ state, the world-empty card and the boot action use the same surfaces, lines, gold, bevel and seam as the rest of the chrome: no blur shadows, gradients or raw hex. The hint appears once, in World mode, after the village is usable; it sits at z-index 90 (below modals), points at the compass with a hand-drawn 14×10 stepped arrow that continues the frame's own pixels (seam on both slopes, lit left slope, shaded right slope), and folds away while a modal, the World-controls popover or an agent panel is open. Its × or opening the World controls dismisses it for good. While an empty-state card shows, the failure banner is hidden and the card carries the failure detail and `TRY AGAIN`.

### Inputs / Fields
ClaudeVille is a read-only observatory; its only inputs are the Settings switches, select and sliders, and the sidebar search. Build any new control from the well vocabulary (`--bg-0`, 1px `--line-2` inset, 11px `--ink-1` text); do not invent new input chrome.

### Progress Meters
- **Context bar (activity panel):** a 4px `--bg-0` track with a square-cornered solid fill: working green, then amber, then errored red by threshold. It is a *usage gauge*, not a score bar; keep it functional.
- **Quota gauge (Dashboard call card):** 12 square segments in the rate-limited colour, shown only when the provider reports a context window.

### Status Dots & Skeletons
- **Status dot:** a small square mark in its status hue, no glow. Only waiting-on-you and errored dots blink, on a stepped 1.6s cadence with a static reduced-motion fallback; every other status is still.
- **Skeleton:** static `--bg-2` bars for first-fetch loading, in place of spinners; no shimmer.

## 6. Do's and Don'ts

### Do:
- **Do** size every glyph on its face's grid (PS2P 8/16/24, DM 11/22/33) with integer line-heights; smoothing off once on `body`.
- **Do** write text in parchment ink and keep gold for the wordmark, selected, active tab and focus. Solid gold fill is allowed only on the active mode tab.
- **Do** reserve the saturated spectrum for agent status and provider identity, and pair every status color with a second cue (a dot, a label, a position), never color alone.
- **Do** separate the three big columns with the single bevel (1px `--line-2` plus a 1px black seam), and frame everything else with a frame-kit slice.
- **Do** keep corners square.
- **Do** ship a `@media (prefers-reduced-motion: reduce)` fallback for every animation (attention-dot blink, toast and modal steps, panel fade-in, the World reveal fade), and keep chrome motion stepped (`steps()`), never smooth loops.

### Don't:
- **Don't** let it read as a **generic SaaS dashboard**: no cool grays, no Inter, no chart-card grids, no analytics-tool look.
- **Don't** drift toward **neon cyberpunk / synthwave**: no glowing neon grids, no purple-and-cyan techno sheen.
- **Don't** add **corporate gamification**: no XP bars, points, streaks, or achievement badges bolted on. The quota and context bars are usage gauges, not scores; keep them so.
- **Don't** adopt **mobile / casual-game UI**: no bubbly rounded buttons, candy gradients, big juicy CTAs, or freemium sheen.
- **Don't** introduce a third typeface or set either face bold.
- **Don't** apply fluid `clamp()` sizing or off-grid sizes (10, 12, 13, 14px) to either face.
- **Don't** flood a surface with solid gold, or use gold as a text colour for ordinary content.
- **Don't** add radial highlights, glows, texture stripes or soft drop shadows to the chrome.
- **Don't** reuse the left status spine (5px on Dashboard rows) or the 3px rail (sidebar, toasts, selected row) as decorative trim. They mean status or selection, nothing else.
