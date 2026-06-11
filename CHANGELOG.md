# ClaudeVille Changelog

---

## v0.9.1.1 · Jun 11, 2026 — Hotfix

- Restore the World canvas backing-store budget so unzoomed harbor signs and other pixel text render at full desktop resolution again

---

## v0.9.1 — *The Chronicle* · Jun 11, 2026

The village gets a memory. Click the version chip to browse the full history.

- **In-app changelog viewer** — `GET /api/changelog` serves `CHANGELOG.md`; clicking the version chip opens a wide modal with styled release headers, named entries, and dimmed hotfix rows
- **Markdown renderer** — inline parser in `TopBar` converts the changelog format to HTML (version chip, release name, date, bullet lists, bold/italic/code)
- **Version bumped** — `index.html` and `package.json` corrected from v0.1 to v0.9 to reflect actual project history
- **Agent docs** — `CLAUDE.md` / `AGENTS.md` updated with a `## Changelog` section instructing agents to prepend an entry and update version locations before pushing

---

## v0.9.0 — *Swift Roads* · Jun 11, 2026

Performance pass targeting a stable 50 fps in World mode.

- FPS counter added to the top bar next to the version chip
- Sky aurora/fog layers composited into a cached frame running at 5 Hz instead of redrawing every tick
- World canvas budget reworked to sustain 50 fps under load
- Selected-agent camera follow tightened, reducing overdraw on zoom
- Fable sprite regenerated in pro mode for cross-direction consistency

---

## v0.8.0 — *The Mythweaver* · Jun 9, 2026

Claude Fable joins the village. A 37-task upgrade swarm lands foundational improvements across the stack.

- Claude Fable: new mythweaver sprite class and model identity
- WebSocket delta broadcasting: server now pushes only changed fields
- Harbor housekeeping: stale repo-only entries expire; pushed-branch state correctly clears

---

## v0.7.1.1 · Jun 8, 2026 — Hotfix

- Expire stale harbor entries for repo-only sessions
- Fix pushed-branch harbor state not clearing after merge

---

## v0.7.1 — *Swarm Council* · May 28, 2026

Workflow-mode swarm agents become first-class citizens in the village.

- Workflow-mode swarm agents visible in World and Dashboard views
- DeepSeek agents assigned the rogue/archer sprite class
- Agent label clutter reduced in World view

---

## v0.7.0 — *Guild Halls* · May 22, 2026

Internal structure reorganised into clear guilds; no user-facing features, all user-facing reliability.

- Server routing consolidated into a single layer
- Shared adapter session utilities extracted; session normalisation deduped
- Domain helpers simplified
- Widget display pricing moved server-side via `/api/perf`
- Smoke and sprite utilities shared across scripts

---

## v0.6.2 — *Harbor Lights* · May 18, 2026

Follow-up pass after the Living World swarm: movement polish and git-event enrichment.

- Harbor now refreshes on git state changes and emits push events from transitions
- Agent movement and journey detail improved; mine crowding eased
- Git harbor event semantics expanded (force, pull, fetch, rejected)
- World visual validation and render polish pass
- Unused settings panel removed

---

## v0.6.1 — *Rogue's Arrival* · May 17, 2026

OpenCode and DeepSeek agents join the village under the rogue sprite class.

- OpenCode/DeepSeek provider adapter and session support
- DeepSeek model identity mapped to rogue sprite

---

## v0.6.0.1 · May 17, 2026 — Hotfix

- Fix boot stall when composed sprite cells are missing
- Fix Sky subscriptions lost across World/Dashboard mode toggles
- Fix chat ellipsis and idle bob animating when `motionScale` is zero
- Fix RATE_LIMITED/ERRORED/WAITING_ON_USER not surfaced in dashboard and sidebar
- Fix agent nameplate and indicator glyphs too small at unzoomed level

---

## v0.6.0 — *The Living World* · May 17, 2026

A coordinated 37-agent swarm brings the village to life. Weather, sky events, animated buildings, agent personalities, and a full git-event harbor.

**Sky & weather** — aurora on push; shooting star on subagent completion; crepuscular rays at dawn and dusk; sprite rain impacts; `SeasonalAmbience` module

**Chronicle** — release fireworks, milestone banners, weight-tier milestone stones

**Harbor** — force-push, pull, fetch, rejected, and cancelled push support; lighthouse beam coupled to active push signal; dock layout memoised

**Buildings & scenery** — presence-driven windows, lights, and emitters; 10 hand-placed props across workshop, civic, gate, and arcane districts; phase-coupled water palette; Forge and Mine smoke plumes; foliage sway, watchtower gull, fog beam

**World events** — Archive reads; Portal preview/active state; Observatory clock spin; building detail panel via `building:selected`; team sash, archive fade, heraldry shields

**Agents** — role hats, status glyphs, emotes, and stance per identity; plan-mode indicator, retry glyph, idle stroll, stop-and-look; family tether + family plaza; team-gather choreography; cash-out walks, quota-throttle intent, slot bonus

**Domain** — `RATE_LIMITED`, `ERRORED`, `WAITING_ON_USER` statuses; `pull`/`fetch` adapter types; force flag; push stderr capture

**Portal** — subagents spawn at obelisks and dispatch/return through the Portal; Task→Portal ritual; chat resolver

---

## v0.5.1.1 · May 5–16, 2026 — Hotfix

- Fix visit tiles not spreading around busy buildings
- Agent action bubbles now show history and longer status text; stale actions expire
- Fix subagent detection failing under long-running parent sessions
- Warn once (not per-poll) on team-membership collision

---

## v0.5.1 — *On the Road* · May 3, 2026

Agents learn to navigate the world with purpose.

- Agents route along authored roads instead of straight-line walking
- Related agents cluster at the same building
- Agents face buildings on arrival and add idle fidget animations

---

## v0.5.0 — *The Far Shore* · May 1, 2026

Kimi joins the village, arriving from distant waters.

- Kimi provider: server adapter, character sprite, widget cost mapping, model identity in World and Dashboard

---

## v0.4.2 — *Island Heart* · May 1, 2026

The central plaza transforms into a lush tropical island.

- Central plaza converted to island interior with koi pool; roads rerouted around it
- Koi fish school sprite added to the island pool
- Sign and label readability polished; repo label color contrast improved
- GPT-5.3 Codex sprite identity mapping fixed

---

## v0.4.1.1 · Apr 29–30, 2026 — Hotfix

- Fix pending ships escaping the commit lagoon bounds
- Fix harbor ship overcount on active push events

---

## v0.4.1 — *The Gates* · Apr 29, 2026

The village gate is rebuilt from scratch and the harbor grows into a living shipping lane.

**Gate** — stone-on-wood hybrid tower with teal roof; carved timber lintel, plaque, iron lantern; road threads through the arch; lantern registered with `LightSourceRegistry` for night ambience; doors open/close driven by gate transits and proximity

**Harbor** — ship departures distributed along map edge lanes; commit lagoon handoff animated for busy traffic; portal familiar rituals added

---

## v0.4.0 — *Illuminated* · Apr 26, 2026

Every pixel hand-crafted. The canvas renderer is rebuilt end-to-end on a pixel-art sprite pipeline.

- Sprite primitives: `AssetManager`, `SpriteSheet`, `SpriteRenderer`, `Compositor` (palette swap with ΔE tolerance + accessory overlay)
- `TerrainTileset`: Wang-tile neighbor mask + isometric transform
- `BuildingSprite`: full `BuildingRenderer` API parity, Y-sorted interleave with agents
- `AgentSprite` migrated to sprite blits; integer HiDPI scale; camera translate snap; anti-aliasing off
- Camera zoom clamped to integer steps {1, 2, 3} for pixel-perfect output
- PixelLab MCP integration — `manifest.yaml` as single source of truth; `npm run sprites:validate`
- Aggressive sprite cache headers (public, immutable, 1 year); `pixelmatch` visual-diff smoke script

---

## v0.3.0 — *Harvest Grounds* · Apr 25, 2026

The village gets its land. A handcrafted map replaces the blank canvas.

- `SceneryEngine`: authored water polylines rasterised to tile grid; deep-water tint
- Bridges generated where roads cross water; rendered on minimap
- BFS pathfinder routes agents around water and building footprints
- Trees, boulders, bushes, and grass tufts from authored cluster data; Y-sorted with agent occlusion
- Harbor district: lighthouse, sea basin, docks, props
- Claude session names surfaced in the village; long names wrapped in agent tags
- Distinct Codex model visuals; shared token normalisation; session detail caching

---

## v0.2.1 — *The Living Record* · Feb 23, 2026

Activity counts become truthful.

- Session activity stats now calculated live from `history.jsonl` instead of static snapshots

---

## v0.2.0 — *The Town Crier* · Feb 19–23, 2026

The village learns to watch in real time.

- WebSocket stability: error handling and exponential reconnect back-off (PR #1)
- Agent realtime activity panel: camera follow, conversation animation, token usage display (PR #2)
- Claude usage dashboard: account info and quota surfaced in the top bar
- macOS menu bar widget polling `/api/sessions` and `/api/usage` every 5 s

---

## v0.1.1.1 · Feb 18, 2026 — Hotfix

- Fix Codex and Gemini adapters to match actual session data formats

---

## v0.1.1 — *Three Kingdoms* · Feb 18, 2026

Claude is no longer alone. Two new providers join on day one.

- Codex CLI provider adapter
- Gemini CLI provider adapter

---

## v0.1.0 — *The Founding* · Feb 18, 2026

The village is established.

- Claude Code session visualisation: active agents rendered on a canvas world
- Static HTML/CSS/vanilla ES modules; Node.js server on port 4000; no build step
