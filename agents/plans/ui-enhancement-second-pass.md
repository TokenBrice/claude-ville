# ClaudeVille UI Enhancement — Second Pass

> **Status:** active (UI tasks extracted from the broader enhancement tasklist; reconcile with the chrome plan before executing)
> **Date:** 2026-06-14 · **Version reviewed:** v0.9.1.1
> **Scope:** Desktop-only frontend **chrome** (TopBar + Sidebar DOM/CSS, `index.html`, focus/a11y, FPS readout). Canvas/world art is out of scope.
> **Why this file exists:** these tasks originated in [`claudeville-enhancement-tasklist.md`](claudeville-enhancement-tasklist.md) but are fundamentally **DOM-chrome / IA / accessibility** work that **overlaps the chrome plan** ([`ui-enhancement-plan.md`](ui-enhancement-plan.md), issues I1–I10). They were pulled out so the enhancement tasklist stays focused on canvas/world/performance/metaphor/data, and so all chrome work converges in one place. Each task is mapped to the chrome-plan issue it implements or extends, and should **fold into that plan's phase** rather than be executed as a separate, colliding pass.

---

## 1. Relationship to the other two plans

| Plan | Owns | This file's relationship |
|---|---|---|
| [`ui-enhancement-plan.md`](ui-enhancement-plan.md) (chrome plan, another agent) | typography (I1), panel distill (I2), de-chrome (I3), topbar tiering (I5), sidebar grouping+filter (I6), focus rings (I9), copy (I10) | **These tasks implement/extend its issues.** Fold each into the named chrome phase; do not run a parallel topbar/sidebar pass. |
| [`claudeville-enhancement-tasklist.md`](claudeville-enhancement-tasklist.md) (source) | canvas/world/perf/metaphor + DOM **data** enrichment (panel content, dashboard data chips) | Supplies one cross-touch: the `perf-health-readout` emit lives in `IsometricRenderer.js`, that plan's serialized hot file (see §4.5). |

**Decision principle that put a task here:** it is primarily *presentation/IA/accessibility chrome* (how the DOM looks, is styled, is navigated as chrome, or is made accessible) and maps to a chrome-plan issue. Tasks whose substance is data-surfacing, world rendering, performance, or metaphor stayed in the source tasklist even when they touch a DOM file.

---

## 2. Constraints (inherit the chrome plan's brand rules)

All of the source tasklist's hard constraints (zero build step, dependency-free runtime, desktop-only, read-only adapters, ~50fps, English-only) **plus** the chrome plan's two brand constraints:

- **Keep `Press Start 2P`** as the committed brand/display face — do not replace it. Data set in the new legible companion face (chrome plan I1) at ≥10px.
- **Anti-reference:** no drift toward generic SaaS (Inter / cool grays / chart-card grids).
- Reuse `--cv-*` tokens (and the chrome plan's proposed `--cv-focus`, `--cv-surface-*`, `--fs-*` tokens once they land).

---

## 3. Task → chrome-issue map

| id | task | chrome issue | fold into phase | dim | impact | effort |
|----|------|--------------|-----------------|-----|--------|--------|
| `sidebar-search-filter` | Sidebar agent search + status/provider filter | **I6** (sidebar filter) | C | interactivity | high | M |
| `sidebar-content-halves` | Empty-legend + age-suffix + parent-link sidebar rows | **I6** (sidebar IA) | C | metaphor/interactivity | med | S |
| `fleet-exception-badges` | Errored + attention counts in the topbar pulse | **I5** (topbar badge tier) | C | compelling | high | S |
| `topbar-connection-chip` | Durable WS connection-state chip | **I5** (topbar content tier) | C | polish | med | S |
| `topbar-status-shape-a11y` | Status dots differ by shape, not color alone | **I5** + consistency | C | polish | med | S |
| `topbar-focus-rings` | `:focus-visible` on mode buttons + version chip | **I9** (focus token) | D | polish | med | S |
| `perf-health-readout` | FPS chip color + hover readout (contingent on I5) | **I5** (FPS handling) | C | performance | med | S |

> **Note on I5 tension:** the chrome plan wants the alarm-colored FPS chip **quieter / behind a debug toggle**. `fleet-exception-badges` (add errored/attention to the *primary* pulse) and `perf-health-readout` (color + hover the FPS chip) both touch the topbar-badge IA the chrome plan is re-tiering — so the chrome-plan owner makes the final call on prominence. Specs below give the behavior; the *tier* is theirs to set.

---

## 4. Tasks

> Line refs (`≈`) are v0.9.1.1 hints — **re-read before editing**. All checked against source in the evaluation workflow (see §7).

### 4.1 `sidebar-search-filter` — implements I6 (filter half)
**Goal.** A search input + filter-chip row above the sidebar list narrows agents by name/project/status/provider; Enter on a single visible match routes through `agent:selected` → camera focus.
**Why.** Sidebar is the primary selection surface; with >20 agents there is no way to narrow. The chrome plan's heuristic #7 names this exact gap ("no search/filter over a 56-item list").
**Approach.** `index.html`: add `<input id="agentSearch">` + `<div class="sidebar__filters" id="sidebarFilters">` inside `.sidebar__header` after `.sidebar__heading`. `Sidebar.js`: add `this._query=''` and `this._activeFilters=new Set()`; wire input + delegated chip clicks; on change set state, force `_renderSignature=''`, call `render()`. In `render()` append `|${this._query}|${[...this._activeFilters].sort().join(',')}` to the computed signature **before** the early-return; apply a `matchesFilter` predicate before `groupAgentsByProject`; on Enter with exactly one match call `emitAgentSelected(match)`. `sidebar.css`: style `.sidebar__filters/.sidebar__filter-chip(--active)/.sidebar__search` + `.sidebar--collapsed .sidebar__filters{display:none}`. Drop the phantom `sidebar:filter-status` subscriber (no emitter exists).
**Coordinate.** I6 also wants workflow-subagent **grouping** (collapse subagents under their workflow). Build the filter to operate on the grouped structure I6 introduces — co-design the DOM hooks so filter + grouping share one render pass.
**Files.** `index.html`, `Sidebar.js`, `css/sidebar.css`. **Validate.** type to filter, click chips, Enter on single match → select+camera-focus; collapse hides the filter row; select/deselect still works.

### 4.2 `sidebar-content-halves` — extends I6 (sidebar IA)
Three small sidebar content additions whose canvas/dashboard halves stayed in the source tasklist; the sidebar halves live here so all Sidebar IA lands together.
- **Empty-state metaphor legend** — when the agent list is empty, render a "THE VILLAGE AWAITS" header + a 4-row building legend (Forge = Code work, Archive = Reading/search, Harbor = Commit ships, Mine = Token usage) + the existing `noActiveAgentsSub` CTA. CSS mirrors `.sidebar__harbor-empty` (`.sidebar__agent-empty`). (Pairs with the source plan's `world-empty-onboarding` canvas card.)
- **Activity-age suffix** — a muted "· Xh" suffix on idle sidebar rows via `Formatters.formatRelative` (after the source plan's `shared-formatrelative-extract` lands); add `activityAgeMs` to the sidebar render signature. (Pairs with `dashboard-card-staleness`.)
- **Subagent parent link** — a clickable `↑ parent` link on subagent rows → `emitAgentSelected(parent)`; muted when the parent has ended. (Pairs with `dashboard-subagent-parent-chip`.)
**Files.** `Sidebar.js`, `css/sidebar.css` (+ depends on `shared-formatrelative-extract` for the age suffix). **Validate.** empty world shows the legend; idle rows show age; a subagent row's parent link selects the parent.

### 4.3 `fleet-exception-badges` — implements I5 (badge tier)
**Goal.** `World.getStats` returns `errored` and `attention` counts; the topbar shows an errored badge + an attention badge, each hidden at zero, **shape+glyph** differentiated (not color-only).
**Why.** ERRORED / RATE_LIMITED / WAITING_ON_USER currently fall through the 3-bucket `getStats` loop and vanish from the global summary — the worst "is anything on fire?" gap. (The dashboard half of this — section-health rollup — stayed in the source plan as `dashboard-section-health-attention`.)
**Approach.** `World.getStats` (`≈62-78`): add `errored` (ERRORED) + `attention` (RATE_LIMITED + WAITING_ON_USER) accumulators in the existing loop using the imported `AgentStatus` constants. `index.html`: append `badgeErrored`/`badgeAttention` to `.topbar__badges`, each with a glyph span ("!" square / "?" diamond) not a dot, `display:none`. `TopBar.js`: set textContent, toggle `display:none` at 0. `topbar.css`: `.topbar__badge--errored` (`var(--cv-status-errored)`), `--attention` (`var(--cv-status-rate-limited)`). **[critic] don't double-encode** the shape channel with `topbar-status-shape-a11y`.
**Coordinate.** I5 defines which badges are the *primary* pulse — errored/attention belong in that primary tier. Fold into the I5 topbar re-tiering rather than appending raw badges to the old layout.
**Files.** `World.js` (domain — trivial), `TopBar.js`, `index.html`, `css/topbar.css`. **Validate.** `node --check` World+TopBar; induce an errored/rate-limited agent → badge appears and hides at zero in both modes.

### 4.4 `topbar-connection-chip` — implements I5 (content tier)
**Goal.** A durable topbar chip reflects WebSocket connection state (connected / reconnecting / disconnected), driven by `ws:connected`/`ws:disconnected`.
**Why.** For a monitoring app "am I still live?" is a glanceable-health gap; today those events only fire a transient toast.
**Approach.** `index.html`: add a `topbarConnection` chip span. `TopBar.js`: subscribe to `ws:connected`/`ws:disconnected`, set chip text + a state class; `off()` in `destroy()`. `topbar.css`: connected (calm) vs disconnected (amber/red) static tint, no animation. Reuse `--cv-status-*`.
**Coordinate.** I5 reduces topbar chip count/chrome — place this in the primary/at-a-glance tier (connection state is high-priority), styled with the single consolidated chip token I5 introduces.
**Files.** `TopBar.js`, `index.html`, `css/topbar.css`. **Validate.** kill/restore the dev-server WS → chip flips state.

### 4.5 `topbar-status-shape-a11y` — implements I5 + consistency
**Goal.** working = filled circle, idle = hollow ring, waiting = rounded square — a color-independent shape channel, CSS only.
**Why.** working (green) vs waiting (orange) collapse under common color-vision deficiencies; the dot becomes a redundant shape channel alongside the text labels.
**Approach.** `topbar.css` only: `.topbar__badge--idle .topbar__badge-dot{background:transparent;border:2px solid currentColor}`; `.topbar__badge--waiting .topbar__badge-dot{border-radius:1px}`; leave working unchanged. **[critic] don't double-encode** with `fleet-exception-badges` (the errored/attention badges already use a glyph).
**Files.** `css/topbar.css`. **Validate.** the badge dots differ by shape (color-blind sim optional).

### 4.6 `topbar-focus-rings` — implements I9
**Goal.** `.topbar__mode-btn` and `.topbar__version` show a visible focus ring on keyboard focus; the version-chip span gets `tabindex="0"`.
**Why.** Keyboard-only operators have no visible cursor on the two most-used controls (WCAG 2.4.7).
**Approach.** Prefer the chrome plan's **global `--cv-focus` token (I9)** rather than a one-off: `index.html:≈26` add `tabindex="0"` to the version-chip span (a bare span — CSS alone can't focus it); `topbar.css` (or the I9 global rule) applies `box-shadow: var(--cv-focus)` / `outline` on `:focus-visible`. This task is the topbar slice of I9's global focus-ring sweep.
**Files.** `css/topbar.css` (or I9 global), `index.html`. **Validate.** Tab through the topbar → visible rings; the chip still opens the changelog on Enter.

### 4.7 `perf-health-readout` — contingent on I5 (FPS handling)
**Goal.** Emit a `perf:snapshot` event ~2Hz and surface it in the topbar: color-code the FPS chip green/amber/red at the ~50fps budget (48/30 thresholds) and a hover readout (fps, particles, agents, terrain-cache strategy, render mode).
**Why.** Operators currently need Shift+D to see anything beyond a smoothed integer.
**⚠ Tension with I5.** The chrome plan wants the FPS chip **quieter / behind a debug toggle**. Resolve before building: **(a)** if FPS stays visible, do the color + hover here; **(b)** if I5 moves FPS to a dev/debug tier, put the hover readout in that tier and skip the alarm coloring. The chrome-plan owner decides; this task implements whichever.
**Approach (two pieces):**
- *Emit (cross-plan):* in `IsometricRenderer._trackFps`, once per existing ~500ms window (NOT per frame), emit `{ fps, particles: particleSystem.particles.length, agents: agentSprites.size, terrainStrategy: getTerrainCacheDiagnostics().strategy, renderMode: _agentRenderMode() }` (+ the RitualConductor `getOverflowCount()` from the source plan's `perf-ritual-pose-degrade`, when present). **This one-line emit touches `IsometricRenderer.js`, which is the source plan's WS-E serialized hot file — the WS-E owner adds it (or you coordinate a single sequenced edit), never a concurrent edit.**
- *Present (chrome):* `TopBar.js` subscribes to `perf:snapshot`, stores the last value, renders the hover `<div>`; `TopBar.renderFps` thresholds → 48/30 (was 45/25); `off()` in `destroy()`. `topbar.css` hover-panel style; `index.html` hover element.
**Files.** `IsometricRenderer.js` (emit, via WS-E), `TopBar.js`, `css/topbar.css`, `index.html`. **Validate.** chip recolors at thresholds (if option a); hover shows particles/agents/terrain strategy/render mode; ~50fps held.

---

## 5. Sequencing

These fold into the chrome plan's phases — they are **not** an independent pass:

- **Chrome Phase C (Layout & IA)** absorbs: `sidebar-search-filter`, `sidebar-content-halves`, `fleet-exception-badges`, `topbar-connection-chip`, `topbar-status-shape-a11y`, and `perf-health-readout` (per the I5 decision). They share the topbar/sidebar re-tiering work I5/I6 are already doing.
- **Chrome Phase D (Polish)** absorbs: `topbar-focus-rings` (part of the I9 global focus-ring sweep).
- **Cross-plan ordering:** the `perf-health-readout` emit must be sequenced with the source plan's **WS-E** owner (shared `IsometricRenderer.js`). The `sidebar-content-halves` age-suffix needs the source plan's `shared-formatrelative-extract` merged first.
- **`index.html`:** topbar + sidebar regions are edited here; the source plan only edits the panel region (WS-C). Serialize the three plans' `index.html` patches so two owners never edit it in the same window.

---

## 6. Validation

- Any `src/`/css change: open `http://localhost:4000`, test World + Dashboard, resize, agent select/deselect, sidebar collapse, panel open/close.
- `World.js`/`TopBar.js` JS: `node --check`.
- Keep copy English-only (the Hangul-range `rg` check in `claudeville/CLAUDE.md`).
- Re-screenshot the topbar + sidebar surfaces and diff against `agents/research/ui-enhancement-plan/` baselines after each change (shared with the chrome plan).
- Color-vision sanity for `topbar-status-shape-a11y`; keyboard-only sweep for `topbar-focus-rings`.

---

## 7. Provenance

Extracted 2026-06-14 from [`claudeville-enhancement-tasklist.md`](claudeville-enhancement-tasklist.md) (evaluation workflow `wf_047e98bc-f72`). These 6 tasks (plus the bundled sidebar content halves) were identified as overlapping the chrome plan's issue register (I5/I6/I9) and moved here so the enhancement tasklist stays scoped to canvas/world/performance/metaphor/data. All line/symbol refs were checked against v0.9.1.1 source during synthesis and feasibility review; **re-baseline before editing.**
