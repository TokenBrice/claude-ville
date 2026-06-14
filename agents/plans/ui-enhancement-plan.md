# ClaudeVille UI Enhancement Plan

> **Status:** active (analysis + roadmap; re-baseline the named files before executing)
> **Date:** 2026-06-14 · **Version reviewed:** v0.9.1.1
> **Scope:** Desktop-only frontend chrome (`claudeville/css/*`, `claudeville/src/presentation/*`, `claudeville/index.html`). World-canvas *art* is out of scope; world-canvas *overlays* (minimap) are in scope.
> **Governing context:** [`PRODUCT.md`](../../PRODUCT.md) is the source of truth for brand and intent. Register is **brand** ("the village is the product"), not generic product UI. Two surface classes follow from it:
> - **Brand surfaces** — World mode, topbar, section headers, empty states. Design *is* the product; lush retro craft is the point. Protect and celebrate.
> - **Escape-hatch surfaces** — Dashboard mode + activity panel, PRODUCT.md's "product-shaped escape hatch for when someone needs to read exact state." Legibility and scanning win here.
>
> Two hard constraints from PRODUCT.md: `Press Start 2P` is **committed brand identity** (preserve it, don't replace it), and "generic SaaS dashboard — cool grays, Inter, chart-card grids" is an explicit **anti-reference** (no fix may drift toward it).
> **Evidence:** live capture at `http://localhost:4000` (56 live agents, World + Dashboard + activity panel). Screenshots in [`agents/research/ui-enhancement-plan/`](../research/ui-enhancement-plan/).

---

## 1. Method

Read every chrome stylesheet (`reset`, `layout`, `topbar`, `sidebar`, `dashboard`, `activity-panel`, `modal`, `character`), the activity-panel renderer (`ActivityPanel.js`), the minimap module and its wiring, and `index.html`. Inspected the running app at 1440×900: World mode, Dashboard mode, and the live activity panel for an Opus agent. Ran the slop detector (flags `single-font`). Scored against Nielsen heuristics and a cognitive-load checklist.

**One-line verdict:** This is the *opposite* of AI slop. It has a strong, hand-crafted, committed brand identity (warm-gold medieval palette, bespoke isometric pixel art, `Press Start 2P`) — exactly what the brand register rewards. The problem is not "too much personality"; it is two narrow defects: (1) a display-only pixel font is doing body-text work at 5-8px on the escape-hatch surfaces, and (2) every surface carries a *duplicated* second decoration pass that fights the first. So: **keep the brand loud where it's the product (World, topbar, headers); make it legible and de-duplicated where the job is reading exact state (Dashboard, panel).** Useful verbs: *typeset / distill / layout* on the escape hatch; leave *bolder / colorize* alone — the brand is already committed.

---

## 2. Design health score

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of system status | 3/4 | Strong: status dots, badges, context bar, live polling, toasts |
| 2 | Match system / real world | 2/4 | Internal jargon leaks: `RESERVATION`, `slot mine 14,36, queue 2/2, overflow`, raw reason `+135490` |
| 3 | User control & freedom | 3/4 | Close/switch/collapse all work; no destructive paths to guard |
| 4 | Consistency & standards | 3/4 | Two parallel vocabularies (dash-card vs activity-panel) render the same data differently |
| 5 | Error prevention | 3/4 | Read-only viewer; little to get wrong |
| 6 | Recognition vs recall | 2/4 | Tiny labels + heavy truncation force squinting; 56 near-duplicate agent names are indistinguishable |
| 7 | Flexibility & efficiency | 2/4 | No keyboard shortcuts, no search/filter over a 56-item list |
| 8 | Aesthetic & minimalist | 2/4 | The core complaint: over-decoration + density + redundancy + sub-legible type |
| 9 | Error recovery | 3/4 | Tool exit-code chips, detail-fetch error state, stale badge |
| 10 | Help & documentation | 3/4 | Changelog viewer, building purpose text, empty-state hints, tooltips |
| **Total** | | **26/40** | **Acceptable** — solid, crafted foundation; density + legibility hold it back |

Cognitive-load checklist (8 items): **fails 4** (chunking, visual hierarchy, minimal choices, progressive disclosure) → high load on the activity panel and topbar specifically. World mode passes cleanly.

---

## 3. What's working (protect these)

1. **World mode is genuinely delightful.** The isometric harbor/village (lighthouse, water, palms, buildings) is clean, readable, and characterful. It is the product's soul; do not touch it. See `world-mode.png`.
2. **A real, committed palette.** The `--cv-*` token set in `reset.css` is coherent: warm gold on near-black, with disciplined semantic status/tool colors. The palette is an asset, not a problem.
3. **Engineering hygiene under the chrome.** Render signatures to skip no-op re-renders, `contain`/`content-visibility` on lists and cards, skeleton + error + stale states on dash cards, `prefers-reduced-motion` blocks. The substance is there; it is over-dressed.

---

## 4. Root causes (fix these and most symptoms dissolve)

### R1 — One display font is doing every job, at illegible sizes
`reset.css:53` sets `font-family: 'Press Start 2P', monospace` globally. Press Start 2P is a bitmap *display* face designed for multiples of ~8px and is very wide per glyph; as the brand face it is correct and load-bearing. The defect is using it for **data** at **5px, 6px, 7px, 8px** (e.g. `activity-panel.css` token-cell-label `5px`, journey label `6px`, most values `7-8px`). Consequences cascade:
- Near-illegibility at those sizes (noise, not text) — directly undercuts the escape hatch's one job.
- Wide glyphs force `white-space: nowrap; text-overflow: ellipsis` *everywhere*, so real information is amputated: "Atlas" → "Atl…", role "main…", tool names cut mid-word (visible in `activity-panel.png`).
- The detector independently flags this (`single-font`).

This single decision drives the "packed/dense/hard-to-parse" feeling more than anything else. The fix preserves identity: keep Press Start 2P as the brand/display face; give *data* a legible companion (see §6.6).

### R2 — Every surface carries a duplicated second decoration pass
Lush craft is on-brand and welcome. The problem is that it ships *twice*: open any chrome stylesheet and you find a base rule block, then a second appended block literally commented `Worker C … refinement layer` (`topbar.css:265`, `sidebar.css:316`, `dashboard.css:572`, `activity-panel.css:414`) that re-declares the same backgrounds, borders, and shadows on top. The net per surface:
- 3-4 stacked backgrounds (radial highlight + linear + linear + a `repeating-linear-gradient` scanline texture),
- 2-4 `inset` shadows plus an outer drop shadow,
- `::before`/`::after` pseudo-elements adding a second inset border and corner brackets.

Two issues, not one: (a) the *duplication* is a maintenance hazard — two layers fight, so every tweak means editing both; and (b) on the escape-hatch surfaces the scanline/glow sits *behind already-tiny data text*, taxing the exact-state read. The fix is not to flatten the brand: consolidate each surface to **one** intentional treatment, keep it rich on brand surfaces (topbar, headers, world frame), and quiet it specifically behind dense data.

### R3 — Data is shown raw and redundant instead of summarized
The activity panel Journey section (`ActivityPanel.js:478-534`) emits up to 8 rows that re-state the same fact. Live example from `activity-panel.png`:
- `WHY: Working at MINE for quota check` (already a complete sentence),
- `BUILDING: MINE` (repeat), `ROUTE: On site, target tile 14,36`, `REASON: +135490` (raw numeric code, unmapped), `RESERVATION: slot mine 14,36, tile 14,36, overflow` (tile 14,36 a **3rd** time), `BREADCRUMB: PORTAL > PORTAL > MINE > MINE > MINE` (consecutive duplicates).

The user is asked to read ~20 label/value pairs to learn roughly two facts.

---

## 5. Prioritized issue register

Severity: **P0** blocks understanding · **P1** major friction · **P2** minor · **P3** polish.

| ID | Sev | Issue | Primary fix | Files | impeccable verb |
|----|-----|-------|-------------|-------|-----------------|
| I1 | P1 | Data set in Press Start 2P at 5-8px (illegible, forces truncation) on escape-hatch surfaces | Keep pixel font as the brand/display face; add a legible companion face for data only | `reset.css`, `index.html`, all css | `typeset` |
| I2 | P1 | Activity panel is a 7-section, ~20-row wall (Journey redundant; raw codes leak; a tiny-caps label above almost every row = scaffolding) | Collapse Journey to 1 sentence + progressive disclosure; suppress raw/dup data; thin the eyebrow labels | `ActivityPanel.js`, `activity-panel.css` | `distill` |
| I3 | P1 | Duplicated second decoration pass per surface ("refinement layer" blocks) — the "heavy" feel + a maintenance hazard | Consolidate each surface to one token-driven treatment; keep it rich on brand surfaces, quiet behind dense data; delete the duplicate blocks | `topbar/sidebar/dashboard/activity-panel.css` | `quieter` |
| I4 | P2 | Toasts (`position: fixed; right:16px`) overlap and hide the panel header | Offset toasts when panel open, or anchor bottom-right | `modal.css`, panel toggle logic | `layout` |
| I5 | P2 | Topbar packs ~10 equally-weighted info groups; FPS chip alarms by default | Tier into primary/secondary/dev; hide FPS behind debug; reduce per-chip chrome | `index.html`, `topbar.css` | `layout` |
| I6 | P2 | 56-agent sidebar, many duplicate workflow-subagent names, no search/group/filter | Group workflow subagents (collapsed); add filter; visually separate | `Sidebar.js`, `sidebar.css` | `layout` |
| I7 | P2 | Minimap adds little value (user-flagged) | Remove (see §6.4); keep pan/zoom; optional toggle alternative | see §6.4 file list | `distill` |
| I8 | P3 | Two component vocabularies for identical data (dash-card vs panel) | Share tokens/sub-components for tool-row, current-tool, token-usage | dashboard + panel css/js | `extract` |
| I9 | P3 | Inconsistent `:focus-visible` coverage (mode buttons, close, version chip lack it) | Add one global focus-ring token | `reset.css` + targeted rules | `audit` |
| I10 | P3 | Jargon in user-facing strings (`RESERVATION`, `slot…overflow`, `BREADCRUMB`) | Plain-language relabel or hide behind details | `ActivityPanel.js` | `clarify` |

Contrast note: the gold-on-near-black scheme is high-contrast and mostly passes ratio checks. The legibility failure is **size and typeface**, not color. Do not "fix" contrast; fix type.

---

## 6. Surface deep-dives

### 6.1 Activity panel (the headline) — `ActivityPanel.js`, `activity-panel.css`, `index.html:134-216`

**Now:** 320px wide, 7 stacked sections, ~20 rows, every label a 6-7px uppercase eyebrow, values truncated, Journey redundant, raw codes leaking. See `activity-panel.png`.

**Target information hierarchy** (what a watcher actually wants, in order):
1. **Identity** — name (no truncation), status, model (one line). Keep.
2. **What it's doing right now** — one plain sentence + current tool. This is the headline; give it the most weight.
3. **Cost/context** — context bar + cost, compacted to ~2 lines (the 2×2 token grid is fine but over-chromed).
4. **History** — tool history (the genuinely useful scroll), messages.
5. **Journey internals** — collapsed behind a `Details ▸` disclosure, off by default.

**Concrete moves:**
- **Collapse Journey.** Render only the one `_journeyExplanation()` sentence by default (it already composes action + destination + purpose). Move Goal / Route / Itinerary / Reason / Reservation / Breadcrumb into a `<details>` that is closed by default. Most sessions need none of it.
- **Kill redundancy at the source** (`_agentJourneyRows`): if `WHY` already names the building, drop the standalone `BUILDING` row; don't print `target tile X,Y` in both Route and Reservation.
- **Dedupe the breadcrumb** (`_formatBreadcrumb`): collapse consecutive duplicates (`PORTAL > MINE`, not `PORTAL > PORTAL > MINE > MINE > MINE`).
- **Suppress raw reasons** (`_formatReasonLabel`): if the value is purely numeric / unmapped (e.g. `+135490`), return `''` rather than surfacing the code.
- **Row pattern:** switch stacked label-over-value to a compact two-column `label · value` row (label muted/left, value right) for meta + token cells. Recovers vertical space and scannability.
- **De-chrome:** remove the `activity-panel.css:414` "quest log refinement layer" override; one background, one border, one section divider.
- **Sizing:** with the new body font (I1), values at 11-12px, labels at 10px. No more 5-7px.

### 6.2 Topbar — `index.html:23-82`, `topbar.css`

**Now:** logo, version, FPS, TOKENS, COST, TIME, 3 badges, account tier, msg count, 2 quota bars, mode toggle — ~10 groups, all equally chromed. See `topbar.png`. The FPS chip rendered red "3 FPS" during capture; an alarm-colored dev metric in the permanent chrome is noise for the typical user.

**Moves:**
- **Tier the content.** Primary: mode toggle + the working/idle/waiting badges (the at-a-glance pulse). Secondary: tokens/cost/time. Tertiary/dev: FPS, msg count → behind a debug toggle or a single quieter cluster.
- **One chip style.** Delete the `topbar.css:265` "premium HUD refinement layer"; collapse to a single bordered chip token. Drop the `::before` inner border on every stat.
- **Quota bars** are useful but visually loud; align them to the secondary tier.

### 6.3 Sidebar — `index.html:89-111`, `sidebar.css`, `Sidebar.js`

**Now:** 240px flat list of 56 agents; workflow subagents (`WNova`, `WEcho`, … repeated 4-6×) sit inline with top-level agents; no search/filter; selected name truncates.

**Moves:**
- **Group + collapse workflow subagents** under their workflow (the data already tags `agentType: 'workflow-subagent'` and carries `workflowId`/`workflowName` per the adapter notes). Default collapsed with a count.
- **Add a filter input** (name/model/status) at the top of the list.
- **De-chrome** the per-row `::after` hairline + double background; one hover state.

### 6.4 Minimap removal — user-flagged, cleanly scoped

The minimap is `Minimap.js` (517 lines, vector parchment art, 150px, bottom-right) plus heavy CSS chrome (corner brackets, inner border, hover glow in `layout.css:50-100` + `character.css:7-16`). It provides: world overview, agent dots, **click-to-navigate** (`onNavigate` pans the camera), and a founding-lore tooltip. Value is low because the world is small, already pannable/zoomable, and selection happens via the sidebar.

**Brand caveat:** the minimap is genuine on-brand craft (parchment art that "rewards a closer look") and sits on a *brand* surface, so the brand register itself leans toward keeping characterful pieces. The user has asked to remove it, so removal is the primary recommendation; the collapsed-toggle alternative below is the brand-faithful middle path if that pull wins.

**Recommended: remove.** Touch points (re-baseline before editing):
- `IsometricRenderer.js:378` (`new Minimap()`), `:1256-1257` (`attach` + `onNavigate`), `:1317` (`detach`), `:1447` (`releaseStaticLayer`), `:7654-7674` (CanvasBudget reporting).
- `WorldFrameRenderer.js:197-206` (per-frame `minimap.draw(...)`) + `markFrameTiming`.
- `layout.css:50-100` and `character.css:7-16` (`.content__minimap` rules).
- Delete `Minimap.js`.
- Leave `ModelVisualIdentity.minimapColor` / `AgentPresentation` color fallback (they double as provider/agent dot colors elsewhere).

**Tradeoff to confirm:** removal drops click-to-navigate. Mitigation if that matters: keep pan/zoom (unchanged) and/or add double-click-to-center on the main canvas. **Alternative to full removal:** keep the module but ship it collapsed/off by default behind a small toggle. Recommendation stands at *remove* unless click-to-navigate is valued.

Bonus: removing the per-frame minimap draw returns canvas budget (relevant to the documented 50fps target).

### 6.5 Style + token consolidation — all chrome css

Establish a small **elevation/surface system** and apply it once, replacing the per-file *double* declaration (not the richness itself):
- `--cv-surface-1/2/3` (panel backgrounds at three depths), `--cv-elev-1/2` (shadow tiers), `--cv-divider`, and a `--cv-texture` reserved for **brand surfaces** (topbar + world frame + section headers) where the scanline/glow is the point.
- Remove all four `Worker C … refinement layer` blocks; fold the values worth keeping into the single base rule so there is one source of truth per surface.
- **Brand surfaces keep their craft.** Escape-hatch *data regions* (panel rows, dashboard card bodies, token cells, tool history) get a calmer surface — single border, no scanline behind text — so the exact-state read stays clean. This is a redistribution of decoration, not a removal of it.

### 6.6 Type system — `reset.css`, `index.html`

Identity-preservation governs here: `Press Start 2P` stays as the brand face. Restore legibility with a two-face system on a contrast axis (bitmap display + a legible companion).
- **Display (Press Start 2P, unchanged):** logo, mode buttons, section titles/eyebrows, world UI, empty-state hero, changelog/version. Only at ≥10px and only for short strings. This is where the brand lives; do not touch it.
- **Body/data companion:** panel values, meta, token cells, tool history, messages, dashboard card bodies, journey text. The companion must honor two PRODUCT.md constraints — *no Inter / no generic-SaaS sans* (anti-reference), and mono only because the brand is genuinely retro/terminal-adjacent (not as lazy "developer" costume). Best fit is a **pixel-adjacent legible face** that bridges the bitmap aesthetic with small-size readability:
  - **Departure Mono** (lead pick) — a modern pixel/mono drawn for legibility at small sizes; reads as a sibling of Press Start 2P, not a contrast clash.
  - **JetBrains Mono** (fallback) — highly legible, not on the reflex-reject list.
  - Avoid **IBM Plex Mono** and **Space Mono** — both are on the brand reflex-reject (training-data default) list.
- Self-host the companion (one woff2) or add a second Google Fonts link, matching the existing `Press Start 2P` load.
- Define a fixed (non-fluid) type scale token set: `--fs-display`, `--fs-title`, `--fs-body` (12), `--fs-data` (11), `--fs-label` (10). Nothing below 10px.

---

## 7. Proposed tokens (sketch, to live in `reset.css`)

```css
:root {
  /* type */
  --font-display: 'Press Start 2P', monospace;     /* brand face: short labels, ≥10px only */
  --font-body: 'Departure Mono', monospace;        /* legible companion: all data/body */
  --fs-title: 12px; --fs-body: 12px; --fs-data: 11px; --fs-label: 10px;

  /* spacing scale */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 24px;

  /* surfaces / elevation (replace per-file triple-stacks) */
  --cv-surface-1: rgba(33, 22, 16, 0.96);
  --cv-surface-2: rgba(48, 31, 22, 0.98);
  --cv-divider: rgba(214, 169, 81, 0.16);
  --cv-elev-1: 0 6px 16px rgba(0,0,0,0.2);
  --cv-elev-2: 0 8px 22px rgba(0,0,0,0.25);
  --cv-focus: 0 0 0 2px rgba(255,229,141,0.75);  /* global focus ring */
}
```

---

## 8. Phased roadmap

**Phase A — Quick wins (low risk, high relief):**
1. I7 Minimap removal (self-contained; instant decongestion of World mode).
2. I4 Toast offset (small CSS/logic fix; stops hiding the panel header).
3. I2a Journey dedupe + raw-code suppression + breadcrumb collapse (pure `ActivityPanel.js` logic; no visual rework yet).

**Phase B — The type + chrome reset (the big legibility/density win):**
4. I1 Two-face type system + `--fs-*` scale; sweep css to use tokens, nothing < 10px.
5. I3 Delete the four "refinement layer" blocks; introduce `--cv-surface-*` / `--cv-elev-*` and apply once.

**Phase C — Layout & IA:**
6. I2b Activity panel restructure (progressive-disclosure Journey, compact rows, tiered hierarchy).
7. I5 Topbar tiering + single chip style.
8. I6 Sidebar grouping + filter.

**Phase D — Polish:**
9. I8 shared sub-components, I9 focus rings, I10 copy/clarify pass. Finish with a full `polish` sweep.

Each phase is shippable alone; A and B deliver most of the perceived improvement.

---

## 9. Validation (matches CLAUDE.md table)

- Any `src/` or css change: open `http://localhost:4000`, test World + Dashboard, resize, agent select/deselect, panel open/close, sidebar collapse.
- Minimap removal: `node --check` touched JS; confirm World renders, pan/zoom intact, no console errors, `/api/perf` still responds; re-screenshot.
- Re-screenshot the four captured surfaces after each phase and diff against `agents/research/ui-enhancement-plan/` baselines.
- Keep copy English-only (run the Hangul-range `rg` check from `claudeville/CLAUDE.md`).
- Before any push: prepend `CHANGELOG.md`, bump `.topbar__version` and `package.json` per the changelog policy.

---

## 10. Decisions

**Confirmed 2026-06-14:**
1. **Type system → two-face, `Departure Mono`.** Keep `Press Start 2P` as the brand/display face; add `Departure Mono` (pixel-adjacent, legible) as the data companion. Identity preserved; anti-reference (Inter / generic SaaS) avoided.
3. **Minimap → remove fully.** Per §6.4 touch points. Pan/zoom stays; click-to-navigate is dropped (optionally add double-click-to-center on the main canvas as a follow-up).
4. **Execution → not yet.** This plan is the deliverable for now; no code changes made. Pick up at Phase A when ready.

**Still open (defaulted, change anytime):**
2. **Companion-font reach.** Default: data regions only (panel rows, card bodies, tool history, messages, token cells); headers/labels/world/topbar stay in the pixel face. Tighten to panel-only or extend further on request.

Note: this stays inside the brand register throughout — no move flattens the warm palette, the craft, or the pixel identity; the anti-reference (generic SaaS / Inter / chart-cards) is avoided by construction.
