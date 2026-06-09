# ClaudeVille Consolidated Upgrade Plan

Date: 2026-06-09
Status: active — largely executed 2026-06-09 by swarm run `wf_1c61637e-605` (37/44 tasks landed, uncommitted). Unchecked: 2.6 skipped per operator note; 2.5/3.12/4.7/4.9/4.12 deferred. 2.3 was interrupted mid-swarm but post-review (2026-06-09) found it complete: hello/resync handshake, 20s snapshot floor, 500-op size guard, both compatibility directions, and a 5000-case fuzz round-trip of patch generate/apply passed — activates on next dev-server restart. 1.1 and 1.8 checked because their outcomes already existed (sheet generated out-of-band; pull/fetch fixed pre-baseline). Not done from the run plan: metaphor-rendering integration join (2.2/2.4/3.13/4.8 are domain-side only, not yet visualized), reviewer pass, and browser smoke in the user's real Chrome.
Baseline HEAD: `ec205cacc576572135b0835cf6c802a188bf9490`
Initial `git status --short`: uncommitted Fable-rollout edits on `claudeville/adapters/sessionPresentation.js`, `claudeville/assets/sprites/manifest.yaml`, `claudeville/src/presentation/character-mode/AgentSprite.js`, `claudeville/src/presentation/character-mode/Minimap.js`, `claudeville/src/presentation/dashboard-mode/AvatarCanvas.js`, `claudeville/src/presentation/shared/ModelVisualIdentity.js`; untracked `.claude/skills/impeccable/`
Final expected `git status --short`: unchanged by this artifact (planning only)

## Scope

Owned paths: none yet — each task claims its own paths when picked up.

Source docs:

- Five parallel codebase explorations (World mode, Dashboard/shared UI, server/adapters/services, domain/metaphor layer, assets/widgets/prior artifacts), 2026-06-09.
- `agents/plans/claudeville-world-enhancement-swarm-2026-05-18.md` (125-idea world backlog — this plan does not re-list it; see Non-Goals).
- `agents/handover/agent-work-streamlining-execution.md` (deferred refactor batches — folded in where they block new work).

## Goal

A single ranked backlog of the most promising upgrades across visuals, performance, metaphor depth, data richness, and widgets — deduplicated against prior plans and in-flight work — so any future session can pick the top unclaimed task and execute.

## Non-Goals

- Re-listing the 125-idea world-enhancement backlog (use the 2026-05-18 swarm plan for fine-grained world ideas; items here either rank above it or come from areas it didn't cover).
- Duplicating the in-flight Fable rollout edits (uncommitted on baseline). Task 1.1 only covers the missing piece (the sprite sheet PNG).
- Mobile/responsive work (desktop-only per `claudeville/CLAUDE.md`).
- Localization (English-only copy policy).

## Verified Corrections From Exploration

- Terrain manifest/disk mismatch reported by one explorer is **false**: all 6 `terrain.*` manifest IDs have matching `sheet.png` directories on disk. Dropped.
- `agent.claude.fable` sprite sheet is **confirmed missing**: manifest (uncommitted) and `ModelVisualIdentity.js` reference it, `claudeville/assets/sprites/characters/agent.claude.fable/` does not exist → checkerboard placeholder in World mode.

---

## Tier 1 — High impact, S/M effort (do these first)

- [x] **1.1 Generate the missing Fable character sheet** — `manifest.yaml` (uncommitted) and `ModelVisualIdentity.js` already reference `agent.claude.fable`, but no `sheet.png` exists, so Fable agents render as checkerboard. Generate via PixelLab per the manifest's own note (generation size 76, canvas ~108, engine cell 92; `mode: v3`), assemble, run `npm run sprites:audit-refresh`, and visually compare against Opus/Sonnet for palette coherence (v3 vs pro mode saturation drift is a known risk). *Effort S · completes in-flight work.*
- [x] **1.2 Error and rate-limit status visuals in World mode** — `AgentStatus.ERRORED` and `AgentStatus.RATE_LIMITED` exist in the domain (`src/domain/AgentStatus.js`) but have no entry in `STATUS_VISUALS` (`character-mode/AgentSprite.js:21-42`); failures are currently invisible in the village. Add red pulsing glow + warning sigil + "ERROR" label for errored, frozen/darkened tint + hourglass for rate-limited. The single biggest "telemetry exists but isn't shown" gap. *Effort S–M.*
- [x] **1.3 Cost and token metrics on dashboard cards** — `adapters/sessionPresentation.js` computes `estimatedCost` and full token breakdowns, and the Activity Panel renders them (`ActivityPanel.js:356-390`), but dashboard cards show only tool history. Add a compact footer row ("1.2M tokens · $0.18") reusing `Formatters.js` helpers, fetched alongside `_fetchAllDetails()` in `DashboardRenderer.js`. *Effort M.*
- [x] **1.4 Context-window drain warning on agents** — context-window fullness is tracked (`LandmarkActivity.js:46-61`, `VisitIntentManager.js:56-71`) but never visualized. Add a warning ring around the agent that shifts yellow→orange→red above 75% full. Users see context pressure without opening the dashboard. *Effort M.*
- [x] **1.5 Chat direction indicators** — `AgentSprite.startChat(target)` animates a bubble but nothing shows who is talking to whom. Draw a faint animated line/arrow (provider-colored, fading with message age) from sender to recipient during SendMessage chats. Makes team collaboration legible at a glance. *Effort S.*
- [x] **1.6 Crowd cluster group visuals** — `CrowdClusters.js` computes clusters but rendering just z-sorts overlapping sprites; 20+ agent sessions (swarms/workflows) become unreadable. When 3+ agents cluster, draw a shared aura and an "×N" badge. Pairs naturally with the recent swarm-agent surfacing work (commit `82ba321`). *Effort M.*
- [x] **1.7 Tail-offset caching for transcript reads** — adapters re-read up to 8MB of JSONL per session per 2–5s poll (`adapters/codex.js:34`, `adapters/claude.js:203`). Cache last-read byte offset keyed on `{path, size, mtime}`, seek and read only new bytes, back off when the file hasn't grown. Biggest backend CPU/IO win. *Effort M · verify with `node --check` + `scripts/smoke/adapters.mjs`.*
- [x] **1.8 Harbor pull/fetch normalization fix** — known correctness gap carried from the 2026-05-18 swarm plan: backend git extraction recognizes `commit/push/pull/fetch` but the shared frontend normalization only admits `push` and `commit`, so pull/fetch events are silently dropped. Small fix, closes a data-loss hole. *Effort S.*
- [x] **1.9 Dashboard accessibility pass** — cards are mouse-only with no `role`, `tabindex`, or `aria-label` (`DashboardRenderer.js:263-266`), and no CSS respects `prefers-reduced-motion` (pulse/spin/fade in `css/dashboard.css`, `css/activity-panel.css`). Add keyboard selection (Enter/Space), ARIA labels matching the Sidebar pattern, and a reduced-motion media block across the CSS files. *Effort M.*
- [x] **1.10 KDE widget quota/tier parity + sprite map sync** — KDE widget fetches `/api/usage` but discards account tier and 5h/7d quota (macOS shows both); its hardcoded `spriteFrame()` map (`widget/kde/.../main.qml:375-391`) is missing Fable and all three DeepSeek variants (wrong-scale fallback). Add quota pills/bars mirroring macOS and complete the 15-sprite frame map. *Effort M · verify `npm run widget:kde:check`.*
- [x] **1.11 Agent shadows from sun position** — buildings cast shadows but agents don't, which visually un-grounds them. Compute a simple directional oval from the existing time-of-day phase (`AtmosphereState.js` + `SkyRenderer.js`): elongated at dawn/dusk, tight at noon, off at night. Cheap, large depth win. *Effort M.*

## Tier 2 — High impact, L effort (flagship projects)

- [x] **2.1 Agent biography & cross-session persistence** — agents currently have no memory: `Agent.js` holds only ephemeral runtime state, and nothing accumulates across restarts. Add an `AgentBiography` (sessions completed, commits pushed, lifetime tokens, first-seen date, milestones) persisted via the existing `ChronicleStore` (IndexedDB + BroadcastChannel, `infrastructure/ChronicleStore.js:48-80`). This is the highest-leverage metaphor upgrade — it turns the village from a live readout into a place with history, and unlocks 2.2, plus earned nicknames, founding lore, and monument narratives later. *Effort M–L.*
- [x] **2.2 Mood system: telemetry → emotion mapping** — agent state is binary (working/idle); weather cycles on a deterministic clock unconnected to anything real (`AtmosphereState.js:235-244`). Map telemetry to mood (errors → distress, commit streaks → pride, heavy token spend → fatigue) and blend an event-influence layer into weather (error spikes → storm clouds, commit streaks → clearing skies). Render via gait speed, idle pose choice, bubble tone, ambient particles. The village starts *reacting* to the work. *Effort M–L · depends loosely on 2.1 for persistence of arcs.*
- [x] **2.3 WebSocket delta broadcasting** — every broadcast re-serializes the full sessions+teams+usage payload (multi-MB) even for one-field changes (`server.js:661-666, 840-845`). Move to JSON-Patch-style deltas with client-side state patching; ~80% payload reduction, lower GC pressure both sides. Also fold in the cheap cache-TTL alignment fix (5s adapter cache vs 2s broadcast cadence, `adapters/index.js:44-45`). *Effort L · verify with `scripts/smoke/adapters.mjs` + browser console.*
- [x] **2.4 Relationship affinity & interaction memory** — `RelationshipState.js:12-151` tracks only presence (parent/child, team membership, recent arrivals). Add per-pair affinity (meetings, shared commits, last interaction) with decay; render as proximity preference (allies cluster, strangers keep distance) and chat frequency. Emergent social texture. *Effort L · builds on 2.1's persistence.*
- [ ] **2.5 Render-layer extraction (deferred-work payoff)** — `IsometricRenderer.js` is ~7,500 lines, `AgentSprite.js` ~4,200, `BuildingSprite.js` ~3,300; this is the standing blocker the streamlining handover already flagged (full layer extraction, `buildingVisuals` registry migration, AgentSprite movement/visual/equipment split). Most Tier 1/2 visual tasks land in these files — schedule the extraction before or alongside the second wave of visual work, per the swarm plan's "render instrumentation before broad refactors" vote. *Effort L · enabler, not user-visible.*
- [ ] **2.6 New provider adapters (aider, cursor-agent, amp)** — 5 adapters exist (`adapters/index.js:24-30`); popular CLIs are invisible. Includes formalizing the adapter contract first (optional methods like `getSessionDetail`/`getWatchPaths` are currently duck-typed) so third adapters get cheaper. One adapter at a time; aider first (largest install base). *Effort L · verify `node scripts/smoke/adapters.mjs`.* [OPERATOR NOTE = IGNORE NEW PROVIDER]

## Tier 3 — Medium impact, mostly M effort

- [x] **3.1 CSS theme variables consolidation** — only 8 `--cv-*` custom properties exist (`css/reset.css:7-18`); status and tool-category colors are hardcoded across files. Consolidate into variables under a `data-theme` attribute. Enabler for any future light/dark theme; immediate maintainability win. *Effort M.*
- [x] **3.2 Tool failure visibility** — exit codes/stderr are partially present in provider payloads (Codex `completion_metadata`) but never surfaced; users can't see *why* a shell command failed. Add optional `toolExitCode`/`toolStderr` to tool history items and render "⚠ exit 1" chips in the Activity Panel. *Effort M.*
- [x] **3.3 Reasoning-token extraction** — OpenCode SQLite exposes `tokens_reasoning` (`adapters/opencode.js:213`) and Codex emits reasoning metadata, but reasoning cost is invisible. Normalize into the token schema, price it, display it separately. *Effort M.*
- [x] **3.4 JSONL robustness diagnostics** — `adapters/shared.js:111-121` silently skips malformed lines. Track per-adapter skipped-line counts, expose in `/api/perf`, optional debug logging with byte offsets. Catches silent data loss. *Effort S–M.*
- [x] **3.5 Git event latency** — unpushed-commit cache TTL is 30s (`adapters/gitEvents.js:63-141`), so harbor ships lag commits by up to ~32s. Tighten TTL for projects with active sessions and trigger refresh on `HEAD` mtime change. *Effort M.*
- [x] **3.6 Harbor lore: commit messages on ships** — `HarborTraffic.js` maps commits→ships with 7 ship classes but the commit itself is invisible. Show commit message as cargo label on hover/click, link ship → commit detail. Connects the prettiest system in the app back to the real work. *Effort M.*
- [x] **3.7 Tool ritual animations** — `RitualConductor.js` (417 lines) exists as a stub for tool-specific visuals; manifest sheets already reserve animation rows. Wire 2–3 simple poses (reading for search, typing for edit, thinking for chat) with reduced-motion variants. *Effort M.*
- [x] **3.8 Provider-colored selection & status glow** — provider colors are defined (`PROVIDER_BADGE_COLORS` in `AgentSprite.js`) but the selection ring and glow are generic. Small change, strengthens at-a-glance identity. *Effort S.*
- [x] **3.9 Deep linking** — selecting an agent updates nothing in the URL; add `#agent=<id>` via `history.replaceState` and auto-select on load. Enables sharing "look at this agent" links. *Effort M.*
- [x] **3.10 Dashboard stale/error/skeleton states** — detail fetch failures render as an eternal spinner (`DashboardRenderer.js:368-392`); no stale-data badge, no skeleton on first load. Add error state, "stale" badge past TTL, and a `data-loading` skeleton class. *Effort M.*
- [x] **3.11 Avatar canvas redraw batching** — `DashboardRenderer.js:354-359` redraws avatar canvases synchronously during 3s detail polling; batch via `requestAnimationFrame` and skip unchanged signatures. *Effort S–M.*
- [ ] **3.12 macOS widget settings UI** — server URL and 5s poll interval are hardcoded (`widget/Sources/main.swift:19,42`); KDE has a settings panel. Add a small preferences surface persisted to `UserDefaults`. *Effort M · verify `npm run widget:build` + `widget:check`.*
- [x] **3.13 Building congestion mechanics** — `Building.js` tracks capacity and `VisitIntentManager` allocates visits, but overflow has no consequence. Add a congestion state (slower movement, "overwhelmed" bubbles) when buildings exceed visit capacity. *Effort S–M.*
- [x] **3.14 Quota visibility chain** — backend quota fetch is a disabled stub (`services/usageQuota.js:218-264`): either enable it or remove it; then surface village-level quota pressure (amber/red ambient state at 75%/90%) and high-cost-agent highlighting when quota is tight. *Effort M.*
- [x] **3.15 Plan-mode and SendMessage-recipient modeling** — Claude plan/act phases and SendMessage recipient chains aren't extracted, so team conversations can't be fully drawn (blocks richer versions of 1.5). Add `mode` extraction and sender→recipient edges. *Effort M.*

## Tier 4 — Polish backlog (low impact or speculative; pick up opportunistically)

- [x] **4.1 Lore dialogue pool** — replace tool-label-only speech bubbles with a config-driven pool keyed by building × mood × time-of-day. Low effort, high delight. *Effort S.*
- [x] **4.2 Camera polish** — ease-out on follow initiation, momentum on drag release, snap-zoom on far-zoom selection (`Camera.js:28-96`). *Effort M.*
- [x] **4.3 Team badges + project health dots on dashboard** — `Agent.teamName` exists but cards omit it; section headers could show errored/working rollups. *Effort S–M.*
- [x] **4.4 Copy agent/session ID affordance + empty-state copy** — small UX conveniences in cards and the dashboard empty state. *Effort S.*
- [x] **4.5 Weather→agent particle responses** — rain splashes under feet, tint washes in storms. Atmospheric only. *Effort M.*
- [x] **4.6 Effort-tier auras** — distinct particle fields per reasoning-effort tier (low→mythic). Visually rich but expensive; the equipment system already covers the core signal. *Effort L.*
- [ ] **4.7 Dirty-rect rendering** — `WorldFrameRenderer.js:40` clears the full canvas per frame; terrain is cached but dynamic layers always redraw. Profile first — only invest if frame budget actually suffers at high agent counts. *Effort L.*
- [x] **4.8 Earned nicknames, monument detail overlays, founding narrative** — narrative garnish on top of 2.1; do after biography lands. *Effort S each.*
- [ ] **4.9 macOS avatar sprite strip** — backport the KDE compact sprite panel to the macOS popover. *Effort L.*
- [x] **4.10 Docs/process small fixes** — PixelLab generation-size-vs-cell-size note in `docs/pixellab-reference.md` (the Fable manifest note is currently the only place this is written down); `assetVersion` bump policy; clarify that `widget/Resources/widget.html` is not the live macOS popover surface. *Effort S each.*
- [x] **4.11 Pathfinding debug overlay** — optional shift-key overlay showing planned paths/destinations; dev-facing. *Effort M.*
- [ ] **4.12 Token-spend-as-economy system** — market stall exists as a prop only; full supply/demand narrativization is the most speculative idea surfaced. Revisit after 2.1/2.2 prove the persistence layer. *Effort L.*

---

## Execution Readiness

Safe to execute: partial

Required preflight per task:

- Re-run `git status --short`; the Fable rollout edits may have been committed or extended since this baseline.
- Re-verify file:line references at current `HEAD` (they were collected by exploration agents on 2026-06-09 at `ec205ca`).
- For World-mode tasks touching `IsometricRenderer.js`/`AgentSprite.js`, check whether 2.5 (extraction) has landed first.
- Multi-task batches → follow `docs/swarm-orchestration-procedure.md`.

## Validation

Per the matrix in `claudeville/CLAUDE.md`: `node --check` for backend files, `scripts/smoke/adapters.mjs` for adapter work, browser smoke at `http://localhost:4000` (World + Dashboard, select/deselect) for anything under `src/`, `sprites:audit-refresh` + visual diff for assets, widget checks for `widget/`.

Validation run: not run; planning artifact only.

## Residual Risks

- File:line references come from agent exploration and one round of spot-verification (2 of 2 spot-checked claims: 1 confirmed, 1 refuted); verify each before editing.
- Impact estimates are judgment calls, not measurements; 4.7 and 2.3 especially warrant profiling before commitment.
- Tier 2 metaphor work (2.1/2.2/2.4) layers new persistent state onto `ChronicleStore` — agree on a schema/versioning approach before the first of the three lands.

## Supersession Policy

If this plan becomes stale, update `agents/README.md` with the replacement source of truth and mark this artifact `historical` or `superseded`. This plan supersedes nothing — the 2026-05-18 world-enhancement swarm plan remains the source for fine-grained world backlog items.
