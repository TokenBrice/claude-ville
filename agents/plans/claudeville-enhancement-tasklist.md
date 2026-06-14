# ClaudeVille Enhancement Tasklist

> **Status:** active (analysis + parallel-execution roadmap; re-baseline named files/line-refs before executing)
> **Date:** 2026-06-14 · **Version reviewed:** v0.9.1.1
> **Scope:** Whole app — World canvas (interactivity, embodiment, performance, metaphor), Dashboard + shared DOM, data pipeline. Frontend *chrome typography/legibility* is owned by the sibling plan [`ui-enhancement-plan.md`](ui-enhancement-plan.md); see [§9 Coordination](#9-coordination-with-ui-enhancement-planmd).
> **Goal register:** make ClaudeVille **more interactive, more compelling, more performant, with sharper metaphors** — without touching the brand. World mode is the product's soul (per [`PRODUCT.md`](../../PRODUCT.md)); enhancements must protect it, not generic-SaaS it.
> **Method:** produced by a 6-phase evaluation workflow — 8 parallel recon readers across every subsystem → 5 improvement lenses (interactivity / compelling / performance / metaphor / polish) → cluster+dedup (45 raw → 35 candidates) → per-candidate adversarial feasibility review against the hard constraints → synthesis into file-ownership-partitioned workstreams → an adversarial completeness+conflict critic. Critic corrections are folded in and marked **[critic]**.

---

## 1. How to read this

Every task is a self-contained unit a subagent can execute without further design: it names the **real files**, a **verifiable goal**, a **concrete approach**, the **exact validation**, **dependencies**, and whether it is **parallel-safe**.

The plan is partitioned by **file ownership**, not by feature. The three giant files — `IsometricRenderer.js` (8029 lines), `AgentSprite.js` (4720), `ActivityPanel.js` (940) — are merge-collision hot-spots, so **all tasks touching a hot file live in one workstream with a single owner that serializes them**. Workstreams with disjoint `ownedPaths` run fully concurrently.

**Effort:** `S` < 2h · `M` ≈ half-day · `L` multi-day. **Impact:** high / med / low.

---

## 2. Hard constraints (every task respects these)

- **Zero build step** — vanilla ES modules served as-is. No bundler/transpiler/JSX/TS. Any 3rd-party lib = a single vendored ES-module file imported relatively.
- **Dependency-free runtime** — server uses only Node built-ins. No new runtime npm deps.
- **Desktop-only** — assume viewport ≥1280px. No media queries / responsive / mobile work. (A fixed 320px panel cap is a desktop layout decision, not responsive.)
- **Read-only adapters** — never write provider session files. New data must come from the existing normalized session model.
- **~50fps World mode** — honor the motion-budget + pulse-band policy; ship a static fallback for `prefers-reduced-motion`.
- **English-only** UI/copy.
- **Canvas = spatial state at a glance; DOM = dense detail.** Metaphor must answer a real question, never decorate. Surgical edits, match existing style.

**[critic] constraint audit:** no task introduces a build step, runtime dep, adapter write, or media query. All `--cv-status-*` custom props reused by topbar tasks are confirmed present in `reset.css`. One perf flag exists (`tool-confidence-cue`, see §B) and is resolved in-spec.

---

## 3. Protect these (do not break)

The recon pass confirmed a strong, deliberately-engineered baseline. Enhancements must preserve:

- **Render economy** — sky composited to a 5 Hz offscreen frame; static terrain blit from one cached canvas; depth-sort reuses a pre-allocated array with in-place viewport cull; palette-swaps cached for the session; agent render mode degrades full → compact (80+) → minimal (96+); `CanvasBudget` hard pixel ceilings + backing-store release on hide.
- **Embodiment fidelity** — effort-tier aura, context-pressure ring, congestion gait, retry glyph, plan-mode triangle, arrival wisp/sigil (boat vs carriage), full path-recovery, complete `prefers-reduced-motion` fallbacks everywhere.
- **Metaphor wins already shipped** — `HarborTraffic` (ship class ∝ commits, push status ∝ colour, release convoys), mine seam hue ∝ token quota, observatory clock accelerating on WebFetch, watchtower fire→red on failed push, `ChronicleMonuments` weight ∝ commit weight, deterministic mood-weighted lore, static-pulse crowd badges, scenery sightlines subordinate to landmark silhouettes.

Every task below is additive or a targeted fix; none rewrites these systems.

---

## 4. Workstreams (parallel execution model)

> **Chrome/UI surfaces are NOT in this plan.** All TopBar, Sidebar (search/filter/grouping), focus-ring, status-shape, FPS-chip, and other DOM-chrome/typography/IA tasks were extracted to [`ui-enhancement-second-pass.md`](ui-enhancement-second-pass.md) because they overlap the chrome plan ([`ui-enhancement-plan.md`](ui-enhancement-plan.md), issues I1–I10). This plan keeps the **canvas / world / performance / metaphor / data-surfacing** work. See [§9](#9-coordination-with-the-ui-plans).

| WS | Name | Owned paths (exclusive) | Tasks | Concurrency |
|----|------|-------------------------|-------|-------------|
| **A** | Shared formatter seam | `shared/Formatters.js` (+ a one-line `Sidebar.js` extraction) | 1 | enabling, then parallel |
| **B** | Agent sprite metaphor & status | `character-mode/AgentSprite.js`, `domain/services/ToolIdentity.js` | 5 | parallel (serial inside) |
| **C** | Activity panel enrichment (content) | `shared/ActivityPanel.js`, `css/activity-panel.css`, `presentation/App.js`, `application/AgentManager.js`, `domain/entities/Agent.js` | 9 | parallel (serial inside) |
| **D** | Dashboard cards (data chips) | `dashboard-mode/DashboardRenderer.js`, `css/dashboard.css` | 4 | parallel (serial inside) |
| **E** | World renderer (interactivity → perf) | `character-mode/IsometricRenderer.js`, `RitualConductor.js` | 6 | **single serial owner, 2 internal phases** |
| **F** | Independent single-file fixes | `MonumentRules.js`, `config/loreDialogue.js`, `SeasonalAmbience.js`, `ParticleSystem.js`, `CrowdClusterOverlay.js`, `Chronicler.js`, `AtmosphereState.js` | 6 | **fully parallel from T0** |

**Three structural rules (load-bearing — [critic]):**

1. **E is ONE owner, not two.** Renderer interactivity and renderer performance both fully own `IsometricRenderer.js` and *cannot run concurrently*. Model them as a single serial owner with an internal phase boundary: **Phase 1 (interactivity) → merge → Phase 2 (perf)**. Do not fan them out.
2. **`index.html` is touched by one stream here (C: panel meta rows + token cells).** All other `index.html` edits (topbar badges/chips, sidebar inputs, version tabindex, FPS hover) live in the second-pass UI plan and the chrome plan — coordinate the merge across the three plans so two owners never edit `index.html` in the same window.
3. **No `Sidebar.js` feature work in this plan.** The Sidebar halves three tasks once wanted (empty-state metaphor legend, staleness age suffix, subagent parent link) are deferred to the second-pass sidebar work ([`ui-enhancement-second-pass.md`](ui-enhancement-second-pass.md) §S, bundled with I6) so all Sidebar IA lands in one place. The canvas/dashboard half of each task stays here. WS-A still makes one trivial mechanical `Sidebar.js` edit (delete the local `formatRelative`, import it) — coordinate with the chrome plan's I6 Sidebar rework; apply whichever lands first.

---

## 5. Dispatch waves

```
WAVE 0  (enabling — tiny, land first)
  A:shared-formatrelative-extract        (unblocks C:panel-meta-enrichment, D:dashboard-card-staleness)
  C:agent-data-plumbing                  (unblocks C:panel-meta-enrichment, C:panel-message-edges)

WAVE 1  (full parallel — 5 streams concurrent, each serial internally)
  F  (6 independent single-file tasks — assign 1–6 agents)
  B  (AgentSprite + ToolIdentity; bash-routing-fallback BEFORE tool-confidence-cue)
  C  (ActivityPanel enrichment; meta-enrichment & message-edges after Wave 0)
  D  (Dashboard data chips — DashboardRenderer + dashboard.css only)
  E-Phase1  (keyboard-command-layer, world-empty-onboarding)

WAVE 2  (after Wave 1 merges)
  E-Phase2  (perf chain: scratch → water-cache → crowd-throttle → ritual-degrade)

index.html: only WS-C edits it here (panel meta rows + token cells). Coordinate that
single region patch against the second-pass UI plan + chrome plan before merge.
```

**Quick wins (high-impact, low-effort — do these even if nothing else):** `waiting-on-user-ring`, `errored-route-watchtower`, `dashboard-tool-exit-chip`, `keyboard-command-layer`, `crowd-cluster-status-color`, `monument-district-fix`, `bash-routing-fallback`, `panel-chronicle-dossier`, `mine-lore-pool`, `winter-snow-particle`, `perf-spatial-bucket-scratch`.

---

## 6. Tasks by workstream

> Line numbers (`≈`) are hints from a v0.9.1.1 baseline — **re-read the file before editing**.

### WS-A · Shared formatter seam (enabling)

| id | title | dim | impact | effort | deps | ‖-safe |
|----|-------|-----|--------|--------|------|--------|
| `shared-formatrelative-extract` | Lift `formatRelative` into Formatters | polish | med | S | — | no (enabling) |

#### `shared-formatrelative-extract`
**Goal.** `formatRelative` is a named export of `Formatters.js`; `Sidebar.js` imports it; harbor relative-times render identically.
**Why.** It lives privately in `Sidebar.js:≈25`; two downstream tasks (`panel-meta-enrichment`, `dashboard-card-staleness`) need it. Extract once to avoid duplicate/cross-import.
**Approach.** Add `export function formatRelative(ts, now = Date.now()) {…}` to `Formatters.js`, copied verbatim incl. its threshold table. Delete the local fn in `Sidebar.js`, add to the existing Formatters import. Confirm the harbor row at `Sidebar.js:≈269` still resolves. No signature change. **This is the only `Sidebar.js` edit in this plan** — a mechanical move; coordinate with the chrome plan's I6 Sidebar rework (apply whichever lands first).
**Files.** `shared/Formatters.js`, `shared/Sidebar.js`.
**Validate.** `node --check` both; sidebar harbor section shows unchanged relative times.

> **Moved out:** `sidebar-search-filter` and all Sidebar feature halves (empty-state metaphor legend, activity-age suffix, subagent parent link) → [`ui-enhancement-second-pass.md`](ui-enhancement-second-pass.md) §S (overlaps chrome plan **I6**).

---

### WS-B · Agent sprite metaphor & status

Owner serializes all `AgentSprite.js` edits. **[critic risk] `AgentSprite.js` has a pre-existing uncommitted local edit — preserve it; add only assigned tasks, do not reformat surrounding lines.** Internal order: `bash-routing-fallback` → `tool-confidence-cue`.

| id | title | dim | impact | effort | deps |
|----|-------|-----|--------|--------|------|
| `waiting-on-user-ring` | Amber "INPUT" identity for WAITING_ON_USER | metaphor | med | S | — |
| `errored-route-watchtower` | Route errored/rate-limited/waiting to exception landmark | metaphor | high | S | — |
| `mood-posture-cue` | Head-droop/lift posture + faint shadow mood tint | metaphor | high | S | — |
| `bash-routing-fallback` | Route generic Bash to a building (not null) | metaphor | high | S | — |
| `tool-confidence-cue` | "?" suffix on low-confidence destination bubble | metaphor | med | M | `bash-routing-fallback` |

#### `waiting-on-user-ring`
**Goal.** WAITING_ON_USER renders an amber ring + "INPUT" bubble (not idle cyan/"IDLE"); the "?" emote stays.
**Why.** An agent blocked on the user looks identical to a dormant idle one — the state operators most need to spot. Amber is already canonical in `AgentPresentation`.
**Approach.** Add one entry to `STATUS_VISUALS` (`AgentSprite.js:≈53`, after RATE_LIMITED): `[AgentStatus.WAITING_ON_USER]: { color:'#facc15', glow:'rgba(250,204,21,0.34)', label:'INPUT' }`. `_statusVisualFor` falls through to the map. **[critic] verified:** the entry is genuinely missing and RATE_LIMITED is blue-grey `#8fa6bd`, so amber does not clash.
**Files.** `AgentSprite.js`. **Validate.** `node --check`; a `waiting_on_user` agent shows amber ring + INPUT.

#### `errored-route-watchtower`
**Goal.** ERRORED & RATE_LIMITED fall back to `watchtower`; WAITING_ON_USER to `command` — instead of the generic seed walk.
**Why.** Spatial congregation at the watchtower turns a shared rate-limit / multi-error swarm into a glanceable alarm, compounding the red watchtower beacon. Answers "where are my broken agents?"
**Approach.** In `_ambientBuildingTypeForState` (`AgentSprite.js:≈708`) add three branches just before the lastKnown seed-walk fallback (`≈719`): ERRORED→`watchtower`, RATE_LIMITED→`watchtower`, WAITING_ON_USER→`command`. Match the existing if-chain style. No render/motion change.
**Files.** `AgentSprite.js`. **Validate.** `node --check`; errored agent walks toward watchtower (DebugOverlay path inspect).

#### `mood-posture-cue`
**Goal.** Tired agents bob with reduced amplitude (sag), proud bob slightly more (spring); reduced-motion gets a static ±1px offset; a faint mood tint blends into the ground shadow (never the status ring).
**Why.** Two WORKING agents look identical even when one is tired from 4M tokens and one just shipped a streak. Mood already drives gait and lore — posture is the missing visible third leg.
**Approach.** At the bob formula (`≈1830-1836`) multiply amplitude by a mood factor (tired ×(1−0.5·intensity), proud ×(1+0.25·intensity)). Under `motionScale===0` apply a static dy of +1px (tired)/−1px (proud) at `≈1841`. Tint: **skip entirely when `status===ERRORED`**; else blend `MOOD_ACCENTS` colour at ~0.06 alpha into the ground shadow ellipse (`≈2341-2344`, the `rgba(5,8,12,0.56)` fill) — do **not** touch the status grounding ring; omit tint under reduced motion (posture suffices).
**Files.** `AgentSprite.js`. **Validate.** `node --check`; tired vs proud bob differs; toggle reduced-motion → static offset, no tint, ~50fps.

#### `bash-routing-fallback`
**Goal.** `classifyShellInput` returns a `forge` (code-like) or `command` (default) classification instead of `null`, so unclassified shell commands give the agent a spatial address.
**Why.** Bash is the most frequent Claude Code tool; unmatched shell input returns null → first-tool agents freeze at no building. The most-trafficked verb needs a home.
**Approach.** In `ToolIdentity.js` `classifyShellInput`, replace the bare `return null` (`≈435`) with: if `isCodeToolInput(input)` → `{building:'forge', reason:'run-shell', confidence:0.6, label: compactToolLabel(text,'run')}`; else `{building:'command', reason:'run-shell', confidence:0.55, label: compactToolLabel(text,'run')}`. Use `compactToolLabel` (text already lowercased), not `compactShellInputPreview`. `command` is already in `MULTI_TOOL_PRIORITY` — do not touch it.
**Files.** `ToolIdentity.js`. **Validate.** `node --check`; `node scripts/smoke/adapters.mjs`; an arbitrary Bash agent walks to forge/command.

#### `tool-confidence-cue` — **[critic] RE-SPEC'D (data flow was wrong; per-frame cost flagged)**
**Goal.** When tool classification confidence < 0.72, the destination bubble text gets a trailing "?"; high-confidence routes render unchanged — **without** adding per-frame `classifyTool` cost.
**Why.** The metaphor asserts false certainty: a 0.64 LS→archive walk looks as sure as a 0.96 Edit→forge walk. Surfacing doubt is honest and useful.
**Corrected approach.** The original premise (confidence available at `≈1307`) is false — `≈1307` is `_classifyToolReason`, not the bubble path. Actual flow: the tool entry is built in **`_activityEntryForAgent` (`≈3958`)** via `_toolActivityLabel`/`compactToolInput` and does **not** call `classifyTool`; the head bubble at **`≈3398`** draws `head.text` from the activity trail. So: (a) add a `classifyTool(agent.currentTool, agent.currentToolInput)` call in `_activityEntryForAgent`, **memoized per `(tool,input)` key** (module-level small Map, or only compute for selected/on-screen sprites) to protect the 50fps budget — `classifyTool` does regex/host parsing; (b) store `confidence` on the `'tool'` entry; (c) thread it through `_rememberActivitySnapshot`/`_activityTrail` to the head entry; (d) in `_drawBubble` append "?" when stored confidence is finite and < 0.72. No new draw pass.
**Files.** `AgentSprite.js`. **Validate.** `node --check`; low-confidence tool (LS/Glob) shows "?", high-confidence Edit does not; ~50fps held with 50+ agents (Shift+D).

---

### WS-C · Activity panel enrichment (content)

Owner serializes `ActivityPanel.js` (940-line section/signature machinery). Also owns the `Agent` entity + `AgentManager` + `App.js` wiring (prerequisites live here; `DashboardRenderer` only *reads* the new fields).

> **⚠ Panel-IA overlap with the chrome plan (I2).** These tasks ADD content to the same panel the chrome plan is simultaneously DISTILLING (collapse Journey, progressive disclosure, two-column rows, legible body font, de-chrome). This is a genuine tension, not just a styling clash. **Rule:** every new section here must be authored to the chrome plan's target IA — default-collapsed `<details>` where it isn't the headline, two-column `label · value` rows, the new ≥10px body font (not Press Start 2P at 5–7px). Land **after** (or co-design with) the chrome plan's I1 (font) + I2b (panel restructure), so new data lands legible instead of re-bloating the wall the chrome plan is thinning. These are content/feature additions (the "compelling" dimension); the chrome plan owns *how the panel reads*, this plan owns *what it shows*.

| id | title | dim | impact | effort | deps |
|----|-------|-----|--------|--------|------|
| `agent-data-plumbing` | Thread `permissionMode` + `sendMessages` into Agent | compelling | med | S | — |
| `panel-cache-create-cell` | Cache Write cell **+ cache-hit ratio** | polish | med | S | — |
| `panel-harbor-log` | Per-agent git-event accomplishment ledger | compelling | med | S | — |
| `panel-chronicle-dossier` | Lifetime biography + earned nickname | compelling | high | S | — |
| `clickable-building-occupants` | Occupant current-tool label + keyboard access | interactivity | med | S | — |
| `panel-meta-enrichment` | Mood + last-active + PLAN/ACT chip | compelling | high | S | `shared-formatrelative-extract`, `agent-data-plumbing` |
| `panel-pin-compare` | Pin ≤2 agents for a comparison strip | interactivity | med | M | — |
| `panel-building-semantics` | Building-mode: purpose/district/capacity | metaphor | med | S | — |
| `panel-message-edges` | Consume `sendMessages` (who→whom list) | compelling | med | S | `agent-data-plumbing` |

#### `agent-data-plumbing`
**Goal.** `agent.permissionMode` (string|null) and `agent.sendMessages` (array) populated end-to-end with safe defaults for non-Claude providers.
**Why.** `adapters/index.js` already normalizes both (`≈91-92`) but `AgentManager` drops them, so PLAN/ACT mode and message edges never reach the UI. **[critic] both fields MUST have a consumer** — `permissionMode`→`panel-meta-enrichment`, `sendMessages`→`panel-message-edges`. Don't ship plumbing without them.
**Approach.** `AgentManager._sessionToAgentPayload` (after the gitEvents line `≈144`): add `permissionMode: session.permissionMode ?? null` and `sendMessages: Array.isArray(session.sendMessages) ? session.sendMessages : []`. `Agent.js` constructor: destructure both (`≈17-43`) and set `this.permissionMode = permissionMode ?? null; this.sendMessages = Array.isArray(sendMessages) ? sendMessages : []` (after `≈66`, mirroring gitEvents). `update()`/`Object.assign` + `_upsertAgent` already propagate new keys.
**Files.** `AgentManager.js`, `Agent.js`. **Validate.** `node --check` both; `node scripts/smoke/adapters.mjs`; no console errors, select works.

#### `panel-cache-create-cell` (+ cache-hit ratio — **[critic] added**)
**Goal.** A "Cache Write" cell renders `cacheCreate` between Cache Read and Turns; **plus a derived "Cache Hit" % = `cacheRead / (input + cacheRead)`** so a cheap-reuse session is distinguishable from a cold-token burn.
**Why.** `cacheCreate` is already priced into `estimateCost` but never shown; the raw cells don't answer the interpretive cost question the ratio does.
**Approach.** `index.html`: add `panelCacheCreate` (label "Cache Write") after Cache Read, and `panelCacheHit` (label "Cache Hit"). `ActivityPanel.js`: register both in `this.dom`; in `_renderTokenUsage` set `panelCacheCreate.textContent = formatTokens(normalizedUsage.cacheCreate)` and `panelCacheHit.textContent` = computed `%` (guard divide-by-zero → "—"). Keep the 2-column cadence. No CSS, no new imports.
**Files.** `index.html`, `ActivityPanel.js`. **Validate.** `node --check`; select an agent → both cells show values, grid stays 2-per-row.

#### `panel-harbor-log` — **[critic] CORRECTED (false import + section-registration)**
**Goal.** A self-injecting section lists ≤6 recent git events (success/fail dot, short SHA, subject, force chip), newest-first, hidden when empty — and correctly hidden in building mode.
**Why.** "What did this session ship?" is the clearest output signal; `gitEvents` is on every Agent but never shown in the panel.
**Corrected approach.** Mirror `_ensureJourneySection()`: add `_ensureHarborLogSection()` + `_updateHarborLog(agent)` called from `show()` and `_updateInfo()`, gated on `mode==='agent'`. **[critic] add the import** `import { normalizeGitEvent } from '../shared/GitEventIdentity.js'` (it is **not** currently imported); call it directly on `this.currentAgent.gitEvents` (not `collectCommitEvents`). Build rows via `el()` reusing `.activity-panel__token-row/-label/-value`; force chip on truthy `force`; mute inferred events via inline opacity; `hashRows([e.id,e.status,e.label])` signature; hide when `events.length===0`. **[critic] push the self-injected section node into `this._agentSections`** (built once at `≈105` from existing DOM) or it will leak into building mode.
**Files.** `ActivityPanel.js`. **Validate.** `node --check`; agent with pushes shows subjects+SHAs; absent for non-git agent; switch to building mode → section hidden.

#### `panel-chronicle-dossier`
**Goal.** A section shows the persistent biography (nickname, sessions, lifetimeTokens, pushes, errorsRecovered, latest milestone) when non-empty; hidden for fresh agents.
**Why.** No panel answers "who is this villager across all sessions?" Biography accrues in IndexedDB but only surfaces as a faint zoom≥2 name-tag. **[critic] verified:** `biographyService` is passed to `IsometricRenderer` but **not** to `ActivityPanel` yet — the wiring below is genuinely needed.
**Approach.** `App.js`: add `biographyService: () => this.biographyService` to the `ActivityPanel` constructor call (`≈164-168`). `ActivityPanel.js`: accept it; add `_ensureChronicleSection()` mirroring `_ensureJourneySection()`; in `show(agent)` call async `_fetchAndRenderChronicle(agent)` guarded by `currentAgent.id` before DOM write; subscribe to `biography:updated` in `_bind()`, match via `AgentBiography.identityKeyFor(currentAgent)`, unsubscribe in `destroy()`. `_renderChronicleBody` hides when biography null or all stats 0 & milestones≤1; else nickname subtitle + 2×2 token-row grid + latest-milestone row. **Include in `this._agentSections`** so it hides in building mode.
**Files.** `App.js`, `ActivityPanel.js`. **Validate.** `node --check` both; agent with history → dossier renders; brand-new agent → hidden.

#### `clickable-building-occupants`
**Goal.** Each occupant row shows current tool, is keyboard-focusable (tabindex + Enter/Space → select+follow), and the list no longer rebuilds when tool/status unchanged.
**Why.** Click-to-navigate works; the gaps are "what is each occupant doing" + keyboard a11y + a poll-wipe guard.
**Approach.** In `_renderBuildingOccupants`: (a) signature `occupants.map(a=>a.id+a.currentTool+a.status).join('|')`, short-circuit if unchanged (reuse `hashRows`); (b) tool-label span via `currentToolPresentation(agent).name` (already imported); (c) `tabindex="0"` + keydown(Enter/Space) calling existing `emitAgentSelected(agent)`. `activity-panel.css`: `:focus-visible` outline — **use the chrome plan's global `--cv-focus` token (I9)** rather than a one-off, so focus styling stays consistent. Drop the phantom `_buildingVisitorTooltip` reference.
**Files.** `ActivityPanel.js`, `css/activity-panel.css`. **Validate.** `node --check`; click building → rows show tool; Tab+Enter selects+follows.

#### `panel-meta-enrichment`
**Goal.** Meta block shows mood (non-neutral), relative last-active, and a PLAN/ACT chip (only when `permissionMode` is set).
**Why.** "Is this stuck / when did it last act / proposing or executing" are real operator questions; `mood` + `activityAgeMs` already on Agent, `permissionMode` arrives via `agent-data-plumbing`.
**Approach.** `index.html`: add three rows to `.activity-panel__meta`. `ActivityPanel.js`: register `panelMood/panelLastActive/panelMode` in `this.dom`; in `_updateInfo` set Mood = `agent.mood.type==='neutral'?'—':capitalize(agent.mood.type)`; Last active = `formatRelative(Date.now()-agent.activityAgeMs)` via imported `Formatters.formatRelative`; Mode chip = `permissionMode ? PLAN/ACT label : hidden`.
**Files.** `index.html`, `ActivityPanel.js`. **Validate.** `node --check`; Mood + Last active populate; Mode chip appears for a Claude plan-mode session.

#### `panel-pin-compare` — **[critic] add missing-agent cell state + hydration guard**
**Goal.** A persistent strip shows pinned agents (status dot, short name, tool icon, context %, cost), persisted to localStorage, refreshed on `agent:updated` + the 2s batch poll.
**Why.** No surface compares N sessions at a glance with cost/context.
**Approach.** `ActivityPanel.js`: `this._pinned=new Set()` (**cap 2** for the 320px panel) under `'claudeville.pinnedAgents'`; a header pin-toggle (agent-mode only, inserted dynamically). Each poll: `sessionDetailsService.fetchSessionDetailsBatch(pinned)`. Render `.activity-panel__pin-strip` above the header (persists across mode switches) — one flex cell per pin: status dot, name (≤8 chars), tool icon, thin context% bar (`agent.tokens.contextWindow`), cost (`agent.cost`). **[critic] specify the missing-agent state:** on cold reload pins exist in localStorage before `world.agents` hydrates, and a pinned id may be removed — when `world.agents.get(pinnedId)` is undefined render a muted "—" placeholder cell (do not drop the pin); context% reads 0 until the first batch returns (acceptable). `activity-panel.css`: strip + cell styles, no animation (reduced-motion-safe).
**Files.** `ActivityPanel.js`, `css/activity-panel.css`. **Validate.** `node --check`; pin 2, confirm strip persists across selection + reload, missing-agent cell shows placeholder, cells show status/tool/cost/context.

#### `panel-building-semantics` — **[critic] added (building mode is the weakest panel view)**
**Goal.** Building-mode panel shows the building's purpose/district/capacity, not just its occupant list.
**Why.** `buildings.js` carries `description`, `district`, capacity breakdown, and named `visitTile` reasons; building click currently surfaces none of it.
**Approach.** In the building-mode render path, add a small purpose block sourced from the building config already available to the panel (description + district label + occupied/capacity count). Reuse `.activity-panel__token-row` styling; register the node in the building-mode section set so it clears on deselect. No new fetch, no CSS file change beyond reuse.
**Files.** `ActivityPanel.js`. **Validate.** `node --check`; click a building → purpose/district/capacity render; deselect clears them.

#### `panel-message-edges` — **[critic] added (gives `sendMessages` a consumer)**
**Goal.** A compact "Messages" section lists this agent's inter-agent `sendMessages` (target name + short text), hidden when empty.
**Why.** Without this, `agent-data-plumbing`'s `sendMessages` is dead data; with it, a team run shows who is talking to whom.
**Approach.** Mirror `_ensureJourneySection()`: `_ensureMessagesSection()` + `_updateMessages(agent)`, gated on `mode==='agent'`, hidden when `agent.sendMessages.length===0`; resolve target ids to names via `world.agents` (fallback to id). Register in `this._agentSections`. Cap at ~5 newest. No CSS file change.
**Files.** `ActivityPanel.js`. **Validate.** `node --check`; an agent with message edges shows the list; agent without → hidden.

---

### WS-D · Dashboard cards (data chips)

Owner serializes `DashboardRenderer.js` + `css/dashboard.css`. **No TopBar/World/index.html edits here** — those moved to the second-pass UI plan (see note below). These four are data/correctness additions, not chrome restyling; coordinate `dashboard.css` selectors with the chrome plan's I8 (shared dash-card sub-components) so chips adopt its tokens.

| id | title | dim | impact | effort | deps |
|----|-------|-----|--------|--------|------|
| `dashboard-tool-exit-chip` | Non-zero tool exit-code chip on cards | compelling | high | S | — |
| `dashboard-section-health-attention` | Count rate-limited/waiting in section "attention" | polish | med | S | — |
| `dashboard-card-staleness` | "last active Xh ago" chip + dim aged idle cards | metaphor | med | S | `shared-formatrelative-extract` |
| `dashboard-subagent-parent-chip` | Clickable "parent: <name>" lineage chip | interactivity | med | S | — |

> **Moved out:** `fleet-exception-badges` (incl. its `World.getStats` change), `topbar-connection-chip`, `topbar-status-shape-a11y`, `topbar-focus-rings`, `perf-health-readout` → [`ui-enhancement-second-pass.md`](ui-enhancement-second-pass.md) (all are TopBar chrome/IA/a11y overlapping chrome plan **I5/I9**).

#### `dashboard-tool-exit-chip` — **[critic] added (biggest missed opportunity)**
**Goal.** Dashboard cards show a chip for a non-zero `toolExitCode`, **and `toolExitCode` is added to the card re-render signature** so a late failure repaints the card.
**Why.** `_renderToolHistory` omits exit codes entirely *and* drops them from the signature, so a late non-zero exit never repaints — a high-value "is anything failing?" gap on a file WS-D already owns.
**Approach.** In `DashboardRenderer._renderToolHistory` add a small exit chip when `toolExitCode` is truthy/non-zero (reuse the existing tool-row styling, red tone via `--cv-status-errored`). Add `toolExitCode` to the per-card signature computation so a changed exit code invalidates the cache. `dashboard.css`: chip style, no animation.
**Files.** `DashboardRenderer.js`, `css/dashboard.css`. **Validate.** `node --check`; a tool with a non-zero exit shows the chip and the card repaints when the code changes.

#### `dashboard-section-health-attention`
**Goal.** Section headers count `rate_limited`/`waiting_on_user` in the errored (attention) bucket, not idle — so the header stops contradicting the card's amber/red dot.
**Why.** A card shows red/amber while the section header counts it idle — a self-contradicting summary users notice instantly.
**Approach.** In `_updateSectionHealth` (`≈233-256`) extend the if-else: after `if (status==='errored')` add `else if (status==='rate_limited' || status==='waiting_on_user')` → `counts.errored`. Keep waiting/completed in idle. Reuse the existing `--errored` DOM slot + CSS. Do **not** mirror `World.getStats`.
**Files.** `DashboardRenderer.js`. **Validate.** `node --check`; a rate-limited agent increments the section errored count, not idle.

#### `dashboard-card-staleness`
**Goal.** Cards show a "last active Xh ago" chip; long-idle idle cards dim to 0.7. (The optional sidebar age-suffix half is deferred to the second-pass sidebar work.)
**Why.** An idle-all-morning agent looks identical to one active 10s ago; `activityAgeMs`/`lastSessionActivity` are populated but unread in DOM.
**Approach.** `_createCard`: add `<span class="dash-card__activity-age">` to the meta row, cache it. `_updateCard`: render the chip **outside** the signature gate (like the stale badge) via `formatRelative(agent.lastSessionActivity)`; toggle `.dash-card--aged` when `activityAgeMs > 15*60000`. `dashboard.css`: `.dash-card--idle.dash-card--aged{opacity:0.7}` + chip style (no animation, no media query).
**Files.** `DashboardRenderer.js`, `css/dashboard.css`. **Validate.** `node --check`; chip shows relative age; long-idle card dims.

#### `dashboard-subagent-parent-chip`
**Goal.** Subagent cards show a clickable parent chip → selects + scrolls to the root session card (muted/non-clickable when the parent ended).
**Why.** A swarm's flat dashboard gives no lineage cue; `parentSessionId` already drives world clustering.
**Approach.** `_createCard`: add `<span class="dash-card__parent-chip" style="display:none">` after the workflow badge; cache. Click: stopPropagation, resolve `this.world.agents.get(parentId)`, `emitAgentSelected(parent)` + `parentCard.scrollIntoView({block:'nearest'})` + brief flash class; muted if absent. `_updateCard`: extend signature with `agent.parentSessionId||''`; when `isSubagent && parentSessionId` set chip `↑ ${parent?.name||'parent'}`. `dashboard.css`: amber workflow-badge clone, `--clickable` hover, `.dash-card--parent-flash` with reduced-motion fallback. (The optional sidebar parent-link half is deferred to the second-pass sidebar work.)
**Files.** `DashboardRenderer.js`, `css/dashboard.css`. **Validate.** `node --check`; during a swarm click a subagent's parent chip → selects+scrolls to parent.

---

### WS-E · World renderer — **SINGLE serial owner, two internal phases**

Owns `IsometricRenderer.js` (8029 lines), `RitualConductor.js`. **[critic] do not fan out** — one owner runs Phase 1, merges, then Phase 2. The perf chain is strictly ordered to keep one clean edit sequence on the giant file.

**Phase 1 — interactivity / onboarding**

| id | title | dim | impact | effort |
|----|-------|-----|--------|--------|
| `keyboard-command-layer` | Tab cycle, arrow pan, +/− zoom, F fit, Esc deselect | interactivity | high | S |
| `world-empty-onboarding` | Legible empty-state canvas card (canvas half only) | compelling | high | S |

**Phase 2 — performance (chained: scratch → water → crowd → ritual)**

| id | title | dim | impact | effort | deps |
|----|-------|-----|--------|--------|------|
| `perf-spatial-bucket-scratch` | Reuse class-level scratch in nearby-pair avoidance | performance | high | S | — |
| `perf-water-descriptor-cache` | Cache visible water/shore subsets behind a bounds key | performance | med | S | ↑ |
| `perf-crowd-cluster-throttle` | Throttle crowd summarization to ~4Hz | performance | med | S | ↑ |
| `perf-ritual-pose-degrade` | Tier ritual pose-sync by render mode + surface overflow | performance | med | S | ↑ |

#### `keyboard-command-layer`
**Goal.** In World mode (not when typing in an input, not with a modal open): Tab/Shift-Tab cycles selection, arrows pan, +/− zoom, F fits, Esc deselects.
**Why.** Hands-free monitoring; Tab-cycle is especially valuable when sprites overlap. Each binding maps 1:1 to an existing operation. **With the minimap removed, this is now the primary spatial-navigation aid** — F (fit) and arrow-pan recover orientation that the minimap used to provide, so it rises in priority.
**Approach.** Extend `_onKeyDown` (`≈1298`). Guards: skip if `!this._worldModeActive` or `activeElement` is INPUT/TEXTAREA. Tab/Shift-Tab: `Array.from(this.agentSprites.keys())`, advance/wrap, `selectAgentById(id)` then `this.onAgentSelect?.(this.selectedAgent)` (mirror the click handler `≈2289-2299`, **not** a direct eventBus emit), preventDefault. Arrows: `camera.stopFollow()`, nudge `camera.x/y` by ±(PAN_STEP/zoom), `camera._clampToBounds()`. +/−/=: replicate the Camera zoom-step index logic → `camera._setZoomAboutCenter(target)`. F: `stopFollow()`+`centerOnMap()`. Esc: `if (this.modal?.overlay?.style?.display==='flex') return;` else `selectAgentById(null)`+`onAgentSelect(null)`. No Camera.js change.
**Files.** `IsometricRenderer.js`. **Validate.** Tab cycles, arrows pan, +/− zoom, F recenters, Esc deselects; typing in any focused input/textarea does not trigger bindings; ~50fps.

#### `world-empty-onboarding`
**Goal.** With zero visible agents the canvas draws a readable centered text card (not the ~10% dashed arc). (The empty-**sidebar** metaphor legend — "THE VILLAGE AWAITS" + 4-row building legend + the existing `noActiveAgentsSub` CTA — is deferred to the second-pass sidebar work, since the chrome plan's I6 reworks the sidebar.)
**Why.** World is the default; a first-time user with no sessions sees a silent village with no explanation — make-or-break first impression. The canvas card alone delivers most of the value.
**Approach.** Replace the body of `_drawEmptyStateWorldCue`: when `visibleAgentCount===0`, `_resetScreenTransform(ctx)` (precedent `_drawSkyCanopy ≈7075`, debug overlay `≈7699`), draw a centered static `fillRect`+`fillText` card at `globalAlpha 0.85` (no animation → reduced-motion-safe); make the 1-agent branch a no-op. Legend values from `buildings.js`: Forge=Code work, Archive=Reading/search, Harbor=Commit ships, Mine=Token usage. No i18n change.
**Files.** `IsometricRenderer.js`. **Validate.** no active sessions → centered card clearly visible; reduced-motion still renders (no animation); ~50fps.

#### `perf-spatial-bucket-scratch`  — **[critic] verified safe (non-nested call sites)**
**Goal.** `_forEachNearbySpritePair` reuses three class-level collections cleared per call instead of allocating new Map/Map/Set each frame; behavior unchanged.
**Why.** At 50fps with 50+ agents this allocates ~150 short-lived collections/sec — avoidable GC pressure on the hot path.
**Approach.** Constructor (`≈384` near `_movingSprites`): add `this._pairBuckets=new Map(); this._pairIds=new Map(); this._pairVisited=new Set()`. In `_forEachNearbySpritePair` (`≈2812`): replace the three `new` allocations with the fields + `.clear()` at entry. Leave the per-cell bucket `[]` arrays fresh. **[critic]** both call sites (`_applyLocalAvoidance ≈2490`, `_resolveStationaryOverlaps ≈2495`) run sequentially in `update()`, never nested → clear-at-entry is semantically identical.
**Files.** `IsometricRenderer.js`. **Validate.** avoidance/overlap behavior unchanged; ~50fps with many agents (Shift+D).

#### `perf-water-descriptor-cache`
**Goal.** `_visibleWaterTileDescriptors` and `_visibleShoreWaterEdgeDescriptors` return cached reusable arrays, rebuilt only when the camera-bounds key (or descriptor length) changes.
**Why.** Both `filter()` over hundreds of descriptors every frame; the visible subset only changes on pan/zoom. Camera-idle monitoring is the dominant case.
**Approach.** Constructor (`≈596`): `this._visibleWaterFrame=[]; this._visibleShoreFrame=[]; this._waterCullKey=''`. In each method build `key=\`${startX},${endX},${startY},${endY}|${this._waterTileDescriptors.length}\`` (length suffix self-invalidates on terrain regen); on hit return cached; else set key, `out.length=0`, repush filtered items (mirror `_staticPropVisibleFrameDrawables ≈1510`).
**Files.** `IsometricRenderer.js`. **Validate.** pan/zoom → water highlights still track viewport; idle → frame cost drops / ~50fps (Shift+D).

#### `perf-crowd-cluster-throttle`
**Goal.** `_summarizeCrowdClusters` runs ~every 250ms (or immediately on agent-count change) instead of every frame; the dead `localAvoidance` field is removed from `_crowdStats`.
**Why.** At 50fps/80 agents it allocates ~4000 short-lived objects/sec for an ambient overlay that needs no 50Hz refresh.
**Approach.** Constructor (`≈431`): `this._crowdStatsAccumulator=0; this._lastAgentCount=0`. In `update()` (`≈2491`) accumulate dt; call when accumulator≥250 (reset) OR `agentSprites.size !== _lastAgentCount`; store size. Drop `localAvoidance` from `_crowdStats` (`CrowdClusterOverlay` never reads it; `getMetrics` spreads `_localAvoidanceMetrics` independently). Keep `_emptyCrowdStats()` as the frame-0 value.
**Files.** `IsometricRenderer.js`. **Validate.** dense crowd → cluster aura/badge still appears/disappears promptly on add/remove; ~50fps.

#### `perf-ritual-pose-degrade`
**Goal.** `_syncToolRitualPoses` runs full / every-other / skipped by render mode; `_replayActiveToolRituals` throttles to every 4th frame in compact/minimal; `RitualConductor` exposes an overflow counter (read by the DebugOverlay; also available to the deferred perf-health-readout).
**Why.** Both run unconditionally every frame regardless of agent-count tier; rituals past `MAX_CONCURRENT_RITUALS=6` drop silently → invisible flicker under 8+ working agents.
**Approach.** `RitualConductor.js`: `this._overflowCount=0`; increment in `enqueue()` before the shift when `length>=MAX`; add `getOverflowCount()/resetOverflowCount()` (no eventBus emit — keep it dumb). `IsometricRenderer.js`: `this._ritualSyncFrame=0` incremented each `_update()`; gate `_syncToolRitualPoses` by render mode and `_replayActiveToolRituals` to every 4th frame in compact/minimal via `_ritualSyncFrame % N`. Surface `getOverflowCount()` in the existing Shift+D DebugOverlay. (The `perf:snapshot` emit that fed the TopBar FPS readout moved to the second-pass UI plan with `perf-health-readout`.)
**Files.** `RitualConductor.js`, `IsometricRenderer.js`. **Validate.** `node --check` RitualConductor; 8+ working agents → building rituals stay stable; ~50fps.
**Files.** `IsometricRenderer.js`. **Validate.** hover the FPS chip → particles/agents/terrain strategy/render mode populate; ~50fps.

---

### WS-F · Independent single-file fixes — **fully parallel from T0**

Each task owns one isolated file (or a tight pair) with zero overlap with any hot file or each other. Assign 1–6 agents.

| id | title | dim | impact | effort | file |
|----|-------|-----|--------|--------|------|
| `monument-district-fix` | Refactor monuments belong at the forge | metaphor | med | S | `MonumentRules.js` |
| `mine-lore-pool` | Add missing "mine" lore + portal time variants | metaphor | med | S | `loreDialogue.js` |
| `winter-snow-particle` | Winter snow ≠ summer fireflies | metaphor | med | S | `ParticleSystem.js`,`SeasonalAmbience.js` |
| `crowd-cluster-status-color` | Color crowd auras by dominantStatus | metaphor | high | S | `CrowdClusterOverlay.js` |
| `chronicler-pilgrimage` | Chronicler walks toward new monuments | metaphor | med | S | `Chronicler.js` |
| `perf-atmosphere-cloud-memo` | Memoize only `buildCloudLayers` | performance | med | S | `AtmosphereState.js` |

#### `monument-district-fix`
**Goal.** `DISTRICT_BY_TYPE` maps `refactor → 'forge'`; refactor monuments plant at the forge.
**Why.** Archive = "reading/search" lore; a refactor cairn there contradicts every other forge=code-mutation signal.
**Approach.** `MonumentRules.js:11` change `refactor: 'archive'` → `refactor: 'forge'`. Nothing else (forge is a valid type; existing IndexedDB monuments are append-only, unaffected).
**Files.** `MonumentRules.js`. **Validate.** `node --check`; a refactor milestone monument sits in the forge district.

#### `mine-lore-pool`
**Goal.** `LORE_DIALOGUE` gains a `mine` key (extraction/quota themed, ≤24 chars, mood + dawn/night variants); `portal` gains 2 time variants.
**Why.** Agents at the Token Mine (busiest under token pressure) currently speak generic fallback chatter — the metaphor breaks exactly where it matters most.
**Approach.** `loreDialogue.js`: add a `mine` key mirroring the existing shape — 2-3 neutral base lines + distressed/proud/tired (weight 3) + dawn/night (weight 2), all ≤24 chars, themed to seams/veins/quota. Add dawn+night to `portal`. No logic change (`pickLoreLine` resolves by key).
**Files.** `loreDialogue.js`. **Validate.** `node --check`; route an agent to the mine → mine-specific lore appears.

#### `winter-snow-particle`
**Goal.** Winter spawns a downward-drifting pale-blue/white snow particle; the reduced-motion static fallback shifts to pale blue.
**Why.** A December viewer currently sees July's exact upward golden firefly motion — the season reads wrong.
**Approach.** `ParticleSystem.js`: add a `snow` preset after firefly: `{ colors:['#e8f4ff','#cce8ff','#ffffff'], size:[1,2], life:[60,120], speed:[0.06,0.18], gravity:false, direction:'down' }` (the existing `'down'` branch already gives slow downward drift + jitter — no `Particle.update` change). `SeasonalAmbience.js`: winter → `{ type:'snow', label:'snow', staticColor:'#d0eaff', staticSize:2 }`. Budget ~7-8 alive, well under `MAX_PARTICLES`.
**Files.** `ParticleSystem.js`, `SeasonalAmbience.js`. **Validate.** force winter → downward snow drift; reduced-motion → pale-blue static dot; ~50fps.

#### `crowd-cluster-status-color`
**Goal.** Dense clusters tint aura + badge border by `cluster.dominantStatus` (errored=red, rate_limited=amber-orange, waiting=cool, healthy=gold), zero added per-frame allocation.
**Why.** A 5+ agent collision on a shared rate limit currently shows the identical healthy gold glow — the exact "aggregation hides critical outliers" failure the file's own contract warns against.
**Approach.** `CrowdClusterOverlay.js`: a frozen `STATUS_AURA` map of constant rgba `{fill,stroke,badge}` triples covering all 7 `AgentStatus` values + gold fallback. In `drawCrowdClusterAuras` look up `STATUS_AURA[cluster.dominantStatus]` (string assignment to `ctx.fillStyle/strokeStyle`, no new objects); in `drawCrowdClusterBadges` tint the border from the same map. Keep the pulse band static + the `globalAlpha` modulation unchanged.
**Files.** `CrowdClusterOverlay.js`. **Validate.** cluster 5+ errored/rate-limited → aura+badge red/amber while a healthy crowd stays gold; ~50fps.

#### `chronicler-pilgrimage`
**Goal.** On `chronicle:milestone` the Chronicler queues a pilgrimage to the monument tile (queue cap 2), pauses a short recording beat on arrival, then resumes its ambient loop; reduced-motion holds position.
**Why.** The Chronicler orbits the archive obliviously while monuments plant elsewhere — the clearest decorative-only element. Walking toward new history makes it a legible signal.
**Approach.** `Chronicler.js` only: `import { eventBus }`; `this._pilgrimQueue=[]`; subscribe in constructor to `chronicle:milestone → _onMilestone(record)` pushing `{tileX,tileY}` (cap 2 via splice). In `update()`, after the `motionScale===0` early return, if `_pilgrimQueue.length` use `[0]` as target; on arrival (`dist<0.04`) shift it + `pauseUntil=now+PAUSE_MS*0.6`; when drained fall through to the existing `WAYPOINTS` loop. Unsubscribe in `destroy()` if present. No IsometricRenderer change.
**Files.** `Chronicler.js`. **Validate.** trigger a commit milestone → Chronicler walks toward the new monument then resumes; ~50fps.

#### `perf-atmosphere-cloud-memo` — **[critic] highest visual-regression risk among parallel tasks**
**Goal.** `buildCloudLayers` reuses a cached layer array when `localDateKey + weather.type + cloudBucket` are unchanged; continuous fields (`clockDriftPx`, `dayProgress`, `phaseProgress`, `clock`) are **always recomputed**.
**Why.** The 14-iteration cloud loop is the only structurally repetitive per-frame computation. Broad snapshot memoization would freeze star parallax / cloud drift — explicitly rejected. Narrow memo is the safe win.
**Approach.** `AtmosphereState.js`: module-level `_cloudLayerCache={key:'',layers:null}`. Before the `buildCloudLayers` call (`≈868`) compute `subKey = localDateKey(effectiveDate)+weather.type+cloudBucket`; on hit return cached layers, else rebuild + store. Do **not** clone or hold the snapshot; leave every continuous field recomputed each frame. **[critic] if `subKey` accidentally captures a continuous field, drift freezes** — verify in validation.
**Files.** `AtmosphereState.js`. **Validate.** clouds, stars, sky drift still animate continuously (watch several minutes); ~50fps (Shift+D).

---

## 7. Deferred / out of scope (do not dispatch now)

- **`perf-chunked-terrain-cache` (L)** — **[critic] cut from active scope.** A large refactor of the single largest file to factor 6 global-surface layers onto a shared base canvas + per-chunk LRU caches keyed by `chunk.key+asset-string`. The current 40×40 map never trips the 7M-pixel `console.warn` at `≈4558`, so it delivers **zero measurable payoff today** and **cannot be validated** (the over-budget path isn't triggerable). Re-open only when a real map/viewport actually trips the fallback. Owned-paths if revived: `IsometricRenderer.js`, `CanvasBudget.js`.

---

## 8. Risk register

1. **`IsometricRenderer.js` (8029 lines)** is the dominant merge-collision risk. WS-E must run as ONE serial owner (interactivity → merge → perf). Concurrent dispatch = hard conflicts.
2. **`AgentSprite.js` has a pre-existing uncommitted local edit** (≈2 ins / 17 del). The WS-B owner must preserve it and only ADD assigned tasks — no revert/reformat of surrounding lines.
3. **`index.html` is touched by one stream here (WS-C: panel meta rows + token cells).** The other DOM regions (topbar, sidebar, FPS hover) now live in the second-pass UI plan + chrome plan — coordinate the single WS-C region patch across the three plans so two owners never edit `index.html` in the same window.
4. **`perf-atmosphere-cloud-memo`** carries visual-regression risk: the subKey must exclude continuous fields or sky drift freezes.
5. **`Formatters.formatRelative` is a shared seam.** If `panel-meta-enrichment` or `dashboard-card-staleness` start before `shared-formatrelative-extract` merges, they duplicate the function — enforce the `dependsOn`.
6. **`tool-confidence-cue`** adds a `classifyTool` call on the bubble path — must be memoized/gated or it threatens 50fps (see corrected approach).
7. **`panel-pin-compare`** in a 320px panel is tight — cap 2 pins, verify the body font doesn't overflow, render a placeholder for missing/unhydrated agents.
8. **WS-C panel-IA overlap** with the chrome plan's I2 — new sections must adopt the chrome plan's restructured IA (progressive disclosure, two-column rows, legible font), not re-bloat the panel. See WS-C header note + §9.
9. **Three-plan `Sidebar.js` / `TopBar.js` contention** — the second-pass UI plan owns the TopBar/Sidebar tasks extracted from here, and the chrome plan reworks the same files. Sequence: chrome plan font/IA → second-pass UI tasks → (this plan only touches `Sidebar.js` once, mechanically). See §9.

---

## 9. Coordination with the UI plans

There are now **three** plans touching the frontend; this one is deliberately scoped to **canvas / world / performance / metaphor / data-surfacing** and hands all chrome work to the other two:

- **[`ui-enhancement-plan.md`](ui-enhancement-plan.md)** (the chrome plan, another agent) — typography/legibility/IA/de-chrome of the DOM surfaces; issues I1–I10, phases A–D.
- **[`ui-enhancement-second-pass.md`](ui-enhancement-second-pass.md)** (extracted from THIS plan) — the 6 UI tasks that overlapped the chrome plan's scope (sidebar search/filter, topbar badges/chips/shape/focus, FPS readout), mapped to the chrome plan's issue IDs so they fold into its phases.

**What stays here vs. what moved:**

| Surface | Stays in THIS plan | Moved to second-pass UI plan (maps to) |
|---|---|---|
| TopBar (`TopBar.js`/`topbar.css`) | nothing | `fleet-exception-badges` (I5), `topbar-connection-chip` (I5), `topbar-status-shape-a11y` (I5), `topbar-focus-rings` (I9), `perf-health-readout` (I5) |
| Sidebar (`Sidebar.js`/`sidebar.css`) | one mechanical `formatRelative` extraction | `sidebar-search-filter` (I6) + the empty-legend / age-suffix / parent-link halves (I6) |
| Activity panel (`ActivityPanel.js`/`activity-panel.css`) | all **content** enrichment (WS-C) | nothing — but new sections must adopt I1/I2 IA (see WS-C note) |
| Dashboard (`DashboardRenderer.js`/`dashboard.css`) | data chips: staleness, parent, exit-code, section-health | nothing — chips reuse the chrome plan's I8 tokens |
| `index.html` | WS-C panel meta rows + token cells only | all topbar/sidebar/FPS regions |

**Sequencing across the three plans:** chrome plan **I1 (font) + I2b (panel restructure)** land first → then this plan's WS-C panel enrichment (so new data lands legible) and the second-pass UI tasks (which fold into chrome phases C/D). This plan's canvas/perf/metaphor work (WS-B, WS-E, WS-F) is independent of all chrome work and can proceed in parallel immediately.

---

## 10. Validation reference

Match the check to the files touched (per `claudeville/CLAUDE.md`):

| Touched | Smoke check |
|---|---|
| `server.js` / `adapters/*` / `services/*` | `node --check <file>`; discovery → `node scripts/smoke/adapters.mjs` |
| Anything under `src/` | open `http://localhost:4000`, test World + Dashboard, agent select/deselect, resize sanity |
| World building/terrain config | `npm run world:validate-buildings` / `npm run world:validate-terrain` |
| Sprite/manifest | `npm run sprites:audit-refresh` (+ `sprites:capture-fresh` / `sprites:visual-diff` for visuals) |
| Broad non-runtime regression | `npm run validate:quick` |
| Reduced-motion tasks | toggle OS `prefers-reduced-motion`, confirm static fallback + ~50fps (Shift+D) |
| Perf tasks | Shift+D overlay p50/p95 before & after; hold ~50fps under a dense crowd |

**Per-WS quick gate:** WS-A/C/D/F → `node --check` changed files + open both modes. WS-B/E → `node --check` + World-mode visual + Shift+D for ~50fps. Run `npm run validate:quick` before any merge to `main`.

---

## 11. Provenance

Evaluation workflow `wf_047e98bc-f72` (51 agents): 8 recon areas → 45 raw proposals → 35 clustered candidates → 35 passed adversarial feasibility review (line/symbol refs checked against v0.9.1.1 source) → 7 synthesized workstreams → 1 completeness+conflict critic. This document folds in the critic's 4 corrections (collapse E, re-spec `tool-confidence-cue`, fix `panel-harbor-log`, cut `perf-chunked-terrain-cache`), 5 added opportunities (`dashboard-tool-exit-chip`, cache-hit ratio, `topbar-connection-chip`, `panel-building-semantics`, `panel-message-edges`), and the `perf-health-readout` split.

**Revision (2026-06-14):** the minimap was removed from the product, so `minimap-drag-fit` was dropped and `keyboard-command-layer` re-prioritized as the primary spatial-nav aid. Then 6 UI/chrome tasks that overlapped the chrome plan ([`ui-enhancement-plan.md`](ui-enhancement-plan.md) I5/I6/I9) were extracted to [`ui-enhancement-second-pass.md`](ui-enhancement-second-pass.md): `sidebar-search-filter`, `fleet-exception-badges`, `topbar-connection-chip`, `topbar-status-shape-a11y`, `topbar-focus-rings`, `perf-health-readout`. This plan now holds **31 active tasks** (canvas/world/perf/metaphor/data) across 6 workstreams. **Re-baseline every `≈` line reference before editing.**
