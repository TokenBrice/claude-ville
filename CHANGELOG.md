# ClaudeVille Changelog

---

## v0.16.0 — *Home Waters* · Jun 15, 2026

The village gains a memory of its **people** and its **place**: the bonds it has always quietly tracked become visible, and your repositories surface as named anchorages out in the harbor.

### Kith — relationships made visible

- **Kinship panel** — selecting a villager now shows a *Kinship* section listing their allies and acquaintances, warmest first: each bond shows a tier badge, the meetings / chats / shared-commits behind it, and how long since they last worked together. This surfaces the affinity the village already computed (and persisted across sessions) but never displayed.
- **Ally tethers** — when long-standing allies idle near one another in the world, a warm thread is drawn between them, the visible counterpart to the parent/child family tethers.

### Home — repos as harbor anchorages

- **Repo anchorages** — every active repository (one with a live agent, or with commit ships in the harbor) now gets a persistent **anchorage** in the harbor sea: a crest buoy in the repo's signature colour, a name label, and a softly tinted patch of water. Busy repos read as lit and lively; quiet ones dim. The harbor becomes a glanceable map of which projects are alive.
- **Overflow anchorage** — when more repos are active than the harbor has slots, the remainder fold into a single "+N" chip rather than being dropped silently.
- **House colours** — each villager on the mainland wears a faint ground ring in their repo's colour, tying the agents at the forge, archive, and mine back to their home waters offshore. Repo identity is a layer *over* the activity metaphor — agents still walk to buildings by what they are doing.

---

## v0.15.0 — *The Living Village* · Jun 15, 2026

A two-part release that makes Claudeville cohere *and* come alive: every landmark rebuilt to one art standard, then the world between them filled with flora, fauna, and a real coastline.

### Buildings — harmonized

Every building was rebuilt to one art standard — cool stone, slate-blue roofs, painterly shading, and a grounded base under each — so the village reads as one place instead of a patchwork.

- **Rebuilt landmarks** — the Task Board (now an open-air quest board, not a cottage), Code Forge (slate roof, glowing furnace), Token Mine (cyan ore veins on a proper isometric base, no more hexagon), Pharos Lighthouse (taller, cool stone, no more washed-out lilac), and Research Observatory (now grounded, with its live clock hands re-aligned) were regenerated to a new building style contract
- **Everything is grounded** — each building sits on a baked isometric base tile; nothing floats anymore
- **One rendering path** — buildings are now single-image sprites (the old tile-grid `composeGrid` system is retired), simpler to generate and validate
- **Single style source** — the sprite bake script reads its style and prompts from the manifest, so there is one source of truth
- Regenerated buildings no longer render inside a grey rectangle (their transparent backgrounds are keyed out)

### Atmosphere & life

The world between the buildings now feels alive and tended, and the island reads as a real coastline.

- **Living ground.** The grass between buildings is no longer a flat fill: a procedural micro-detail layer bakes pebble and soil flecks, moss into the cobble joints, leaf litter under the northern canopy, and worn dirt where grass meets the roads — with wildflowers dabbing the meadows in colour.
- **Flower meadows & gardens.** New flower-clump scatter blooms across the lived-in districts, plus cultivated plants — flower beds, planters, and hedges — framing the civic plaza, the gate avenue, and the workshop row.
- **Butterflies by day, fireflies by night.** Summer ambience now drifts butterflies over the village while the sun is up and fireflies after dark.
- **Songbirds & waterfowl.** Songbirds flit on looping paths between the trees of the inhabited belt; ducks paddle the calm lagoon and herons wade at the shoreline — the land and lagoon now carry the same life the open sea always had.
- **A real coastline.** Beyond the walls the flat void is gone: a distant sea now stretches to a hazy horizon, tinted to the time of day, so Claudeville sits on a coast rather than floating on nothing.
- **The wall, lit and overgrown.** The southern palisade gained mounted torches with warm light, trailing ivy, and shrubs at its footing; the gate is now framed by flanking fire-baskets.

### Fixes

- Clustered agent **name tags no longer overlap** — the label de-overlap was measuring each tag at ~60% of its real pill width, so neighbouring name pills collided on the same slot (e.g. two "RATE-LIMIT WATCH" tags mashing over the Mine). The width estimate now matches the rendered pill, so close tags stack onto clear, separated slots while distant ones stay put.

---

## v0.14.0 — *Deep Reserves* · Jun 15, 2026

The token limit indicator becomes a place in the world: the Token Mine now shows how much limit is left as ore in the ground, and the crowded top bar gets a slim chip in place of its twin progress bars.

- **Mine reserves** — the mine renders remaining 5-hour limit as a stockpile of glowing ore crystals over a five-segment gauge, across five tiers from brimming to depleted. More limit left means a richer, brighter mine; a depleted reserve raises a pulsing red warning (with a static reduced-motion fallback)
- **Slimmer top bar** — the twin 5H/7D quota progress bars collapse into a single compact chip that still reports both windows' usage (the familiar figures), colored by whichever window sits closest to its limit, so the readout stays available in Dashboard mode too
- **Top bar tidy** — the redundant subscription tier and message-count chips are removed, the working/idle/waiting counts merge into one segmented status tag, and the LIVE indicator tucks neatly under the ClaudeVille wordmark
- **Consistent signal** — the mine glow and the building signal label now speak in terms of reserves remaining rather than usage pressure

---

## v0.13.0 — *Hearthsong* · Jun 14, 2026

The village gets a calmer sonic backdrop. v0.12's per-event beeps are replaced by a gentle procedural ambience that stays local, opt-in, and off by default.

- **Gentle ambient bed** — the sound toggle now starts a small Web Audio graph with warm low pads, filtered air/water texture, and quiet bell tones. There are no samples, build steps, or external assets
- **No reactive pile-up** — agent updates, tool calls, and village scenes no longer spawn sounds, so busy sessions cannot turn into a wall of beeps or motifs
- **Safer audio lifecycle** — ambience fades in and out, pauses when the tab is hidden, resumes only after a user gesture, and keeps the top-bar opt-in behavior from v0.12

---

## v0.12.0 — *The Grand Faire* · Jun 14, 2026

ClaudeVille gets a village-wide stage manager. The world now turns routine CLI state into short readable scenes while keeping the app local, opt-in, and smooth.

- **Village Director** — a bounded scene controller now coordinates team huddles, handoff trails, arrival/departure sparks, incident rings, release parades, building signals, and work-driven weather nudges
- **Last-minute replay** — World mode can show the past 60 seconds of agent movement as lightweight trails, with `R` toggling the view and a quiet screen badge while replay is active
- **Inspectable buildings** — building mode now opens with a Signal panel that summarizes load, queues, inbound routes, recent tools, and Director events before the occupant and state rows
- **Buildings feel busier** — footprints pulse with load pips, while the mine, forge, command center, harbor, and watchtower gain status-specific markers driven by existing presence, quota, and harbor state
- **Optional sound** — the top bar adds an opt-in Web Audio toggle; audio stays off by default, waits for a user gesture, and plays subtle cues for agent and village events
- **Final polish** — label text snaps to whole pixels for crisper unzoomed rendering, and sidebar header type now respects the 10px legibility floor

---

## v0.11.0 — *Watchtower Bells* · Jun 14, 2026

The village gets clearer signals, richer dossiers, and faster world controls. This release combines the UI legibility pass with a full world/dashboard enhancement wave.

- **World signals sharpened** — waiting-for-user agents now read as amber `INPUT`, errored and rate-limited agents route to the watchtower, low-confidence tool bubbles show `?`, and mood posture adds subtle tired/proud body language
- **Keyboard world control** — Tab cycles agents, arrow keys pan, `+/-` zoom, `F` recenters, and `Esc` deselects in World mode
- **Activity panel deepens** — mood, last-active, PLAN/ACT mode, cache write, cache hit ratio, harbor logs, chronicle dossiers, team message edges, building purpose/capacity, and two-agent pin comparison are now visible
- **Dashboard attention chips** — cards show last-active age, non-zero tool exit codes, clickable parent lineage, and section health counts rate-limited / waiting-for-user sessions as attention
- **Village metaphors extended** — mine lore, winter snow, chronicler pilgrimages, status-colored crowd clusters, forge refactor monuments, and richer building semantics make state easier to read at a glance
- **World render economy** — reused spatial-pair scratch collections, cached water/shore visibility, throttled crowd summaries, and render-mode-aware ritual pose sync reduce hot-path work

---

## v0.10.0 — *Fair Hand* · Jun 14, 2026

A legibility and restraint pass across the whole interface. The pixel font stays where it belongs (the village, the brand), and the data you actually read gets a clear hand.

- **Two-face type system** — `Press Start 2P` is now the display/brand face only; a new self-hosted companion, **Departure Mono**, carries all dense data (panel values, tool history, messages, dashboard card bodies, the agent list). A fixed type scale enforces a 10px floor, so nothing renders sub-legible anymore
- **Design-token foundation** — shared surface, elevation, spacing, divider, and focus-ring tokens in `reset.css`; a single global focus ring replaces the inconsistent per-control styles
- **Lighter chrome** — removed the duplicated second decoration pass ("refinement layer" blocks) that every surface carried; topbar, sidebar, dashboard cards, and the activity panel now use one consistent, token-driven treatment
- **Activity panel rebuilt** — leads with one plain-language line of what the agent is doing; the rest of the journey (route, reservation, breadcrumb, goal) moves into a collapsed "More detail" disclosure. Redundant rows removed, consecutive-duplicate breadcrumbs collapsed, and raw reason codes suppressed. Meta and token cells use compact `label · value` rows
- **Topbar tiered** — one unified chip style; status badges read as primary, with FPS and version quieted into a calm tertiary cluster
- **Sidebar** — a live filter input plus collapsible grouping of workflow subagents (collapsed by default), and a far more legible agent list
- **Minimap removed** — the parchment overlay is gone; pan and zoom are unchanged, and the per-frame draw returns canvas budget
- **Toasts** no longer overlap the open activity panel

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
