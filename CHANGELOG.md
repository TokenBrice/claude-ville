# ClaudeVille Changelog

---

## v0.22.0 — *Warden's Rounds* · Jul 10, 2026

The wardens swept every district of the village: a broad repo-wide survey (8 parallel review agents + a live-app UX pass) picked the highest-impact fixes and polish, all landed in one round.

**Security & data correctness**
- **Path-traversal fix.** Claude session-detail resolution now realpath-contains client-supplied ids; `sessionId=../../../../etc/…` can no longer read arbitrary `*.jsonl`-suffixed files.
- **Account email restored.** `claude auth status` now emits JSON; the usage service parses it (with plaintext fallback), so `/api/usage` reports the account email again.
- **Quota staleness cap.** After 30 minutes without a successful quota fetch, the API stops serving a frozen snapshot as live data — mine reserves and visit throttling degrade honestly.
- **Gemini tokens & pricing.** Gemini sessions now report token usage (previously always $0.00) and price against a real Gemini rate table instead of falling through to Claude Sonnet rates.
- **Reasoning-token billing parity.** The browser cost estimate now includes reasoning tokens exactly like the server, so TopBar totals match `/api/sessions`.
- **`git push --delete` detection.** Branch deletions (`--delete`, `-d`, `:branch`) are flagged as deletions instead of appearing as ordinary pushes.

**Multi-agent & provider coverage**
- **Grok subagents parented.** Sessions spawned by Grok orchestrators are marked `sub-agent` and linked to their parent via on-disk `subagents/<id>/meta.json` (37 previously-flat villagers now group correctly).
- **Codex `custom_tool_call` support.** Tool history and "last tool" now surface custom tool calls — no more "No tool usage yet" on active sessions.
- **No more ciphertext in the village.** Codex `spawn_agent`/`send_message` inputs are summarized to their routing target/task name; encrypted `gAAAA…` blobs no longer render in bubbles or cards.
- **Grok & DeepSeek badges.** Dashboard cards and sidebar icons show their own provider identity instead of falling back to the Claude badge; Grok gets its cyan hue in-world too.
- **`ultra` tier everywhere.** The last two gaps (hero-portrait aura, Activity Panel level label) now recognize the GPT-5.6 `ultra` effort tier.

**World & dashboard polish**
- **Readable crowds.** Speech/status bubbles de-collide in clusters: bubbles stack into free slots (max 3 per cluster) with deterministic priority; extras collapse to a quiet ellipsis dot.
- **Human tool labels.** Orchestration tools read as activities — *Messaging*, *Waiting On*, *Spawning*, *Coordinating* — instead of snake_case, and low-confidence bubbles no longer end in `!?`.
- **Unique villagers.** The fallback name pool grew from 15 to 64 village-flavored names with collision-aware assignment — no more twin Leibnizes.
- **Dashboard card tidy-up.** Meta chips truncate with ellipses instead of sliding under the status pill.
- **Quieter, cheaper client.** Detail polling pauses while the tab is hidden (instant refresh on return), the "Server connected" toast only fires on true reconnects, and World relationship tracking drops a 3×-per-frame array rebuild.
- **Grok sprites rebaked.** `agent.grok.base` and `agent.grok.composer` regenerated at higher quality in the same cosmic-truthseeker lore Grok chose — consistent outfit from every angle, crisp cyan rim light; fixes the composer sheet's baked-background artifact. KDE widget stills refreshed.

**Perf & docs**
- **Claude session scan bounded.** Orphan/team-member discovery caches per-project listings on directory mtime (was: stat every historical session file every poll).
- **Docs sweep.** README version/API table (`/api/changelog`), gpt-5.6 in the troubleshooting cost-model list.

---

## v0.21.0 — *Celestial Vanguard* · Jul 10, 2026

The GPT-5.6 generation marches through the gate as a celestial warrior triad — Sol the radiant sun-warlord, Terra the earth sentinel knight, and Luna the moonlit skirmisher.

- **GPT-5.6 model identities.** `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` get first-class identities (labels, minimap colors, dashboard emblems, context window, pricing) instead of falling back to the GPT-5.4 battle-engineer sprite.
- **Three new warrior sprites (PixelLab pro).** `agent.codex.gpt56sol`, `agent.codex.gpt56terra`, and `agent.codex.gpt56luna` are full 8-direction walk/idle sheets with signature runtime weapons: dawn greatblade, earthbreaker warhammer, and crescent moon saber.
- **Ultra reasoning tier.** The new 6th effort level (`ultra`, Sol/Terra only) gets its own radiant star-crest head overlay, aura, dashboard crest, and label — above `max`.
- **Subagent variant inference.** Codex multi-agent v2 spawns record the parent's model on every child; the Codex adapter now infers the 5.6 variant from the orchestrator's task naming (`/root/luna_*`, `/root/terra_*`), so spawned Luna/Terra agents wear their own colors.
- **GPT-5.6 pricing.** Static rates per announced API pricing: Sol $5/$30, Terra $2.50/$15, Luna $1/$6 per 1M tokens.

---

## v0.20.0 — *Starfall Gate* · Jul 9, 2026

Grok agents walk into the village as cosmic truthseekers — void-black coats, electric cyan constellation trim, and a wry starfarer smirk.

- **Grok CLI provider.** New read-only adapter for `~/.grok/sessions/` (`summary.json`, `updates.jsonl`, `chat_history.jsonl`) with `grok-` session ids, live tool/message parsing, reasoning effort, context-window occupancy, and git-event extraction from shell tools.
- **Cosmic truthseeker identity.** Grok maps to the new sprite class (`agent.grok.base` / `agent.grok.composer`), cyan minimap color, effort floor rings, and xAI pricing rates for cost estimates when token splits exist.
- **Manifest + palette.** `manifest.yaml` and `palettes.yaml` gain the void/cyan Grok palette and character prompts.
- **Grok sprites (PixelLab pro).** `agent.grok.base` and `agent.grok.composer` are full 8-direction walk/idle sheets (void coat, cyan constellation trim / swift scout). A procedural fallback baker remains at `npm run sprites:generate-grok` if PixelLab is offline.

---

## v0.19.2 · Jun 29, 2026 — Hotfix

- **Dependency advisory cleared.** Dev tooling and the browser-vendored YAML parser now use `js-yaml` 4.3.0, closing the moderate Dependabot alert surfaced after GitHub security scanning was enabled.

---

## v0.19.1 · Jun 29, 2026 — Hotfix

- **Canonical repo note.** The README now states that `TokenBrice/claude-ville` is the active maintained repository while it remains a public fork of `honorstudio/claude-ville`.

---

## v0.19.0 — *Guild Charter* · Jun 29, 2026

ClaudeVille opens a clearer front gate for GitHub visitors, contributors, and security reporters.

- **Public README front door.** The README now leads with the local/read-only promise, supported providers, zero-build runtime, current version, changelog link, and simulator-backed screenshots instead of a fragile external attachment.
- **Community trust files.** MIT licensing, contribution guidance, support routing, a security policy, and a code of conduct now live at the repo root so GitHub can surface the project health signals directly.
- **Structured GitHub intake.** Issue forms, contact links, a pull request template, and area/provider/status labels route bugs, provider parsing reports, widget issues, visual regressions, docs fixes, and feature requests into useful lanes.
- **Repository discovery metadata.** Package metadata, GitHub topics, the repo description, discussions, Dependabot alerts, and private vulnerability reporting are now aligned with the active local-first AI coding CLI dashboard.

---

## v0.18.1 — *Steady Gaze* · Jun 22, 2026

The World idle camera trades cinematic cleverness for a sturdier village watch — slower, simpler, and focused on where agents naturally gather.

- **Central-agent focus.** Auto-camera now scores live villager positions every few seconds, favoring the agent most surrounded by nearby agents with only small bonuses for active work and attention states.
- **Patient movement.** Ordinary idle moves use broad frames, long dwell windows, slow glides, no long-jump bridge shots, and no automatic zoom-in.
- **Stronger user control.** Manual camera input, selected-agent context, follow mode, reduced motion, and the Cinema toggle now all gate automatic movement before the director can request a glide.
- **Event cues kept simple.** Incidents, arrivals, releases, and failed-push incidents still use boxed `village:camera-cue` targets, with longer cooldowns and the existing glide grade passed through.

---

## v0.18.0 — *Quiet Watch* · Jun 21, 2026

The World camera becomes a **patient village lookout** — calm when the town is calm, quick only when something needs attention, and always ready to frame the action without a hand on the controls.

- **Action-first idle framing.** The idle camera now scores incidents, waiting agents, release moments, handoffs, building activity, arrivals, departures, and working clusters, then picks the most meaningful place in the village to watch.
- **Calmer cinematic pacing.** Separate urgency profiles let incidents preempt quickly while ordinary work and ambient views dwell longer, so the idle experience feels relaxed instead of restless.
- **Gentler movement language.** The camera now prefers pans over unnecessary zooms, keeps action in a comfortable safe zone rather than dead centre, and uses wide bridge shots for long jumps across the map.
- **Soft follow with memory.** Once focused, the camera eases after active clusters at a low speed, while recent agent and building activity lingers briefly so important spots do not vanish the instant a session quiets down.
- **Clearer control.** The topbar toggle now describes the feature as an idle action camera that frames live action, matching what the automatic view actually does.

Collected from commits `94071c0` through `20127cb`.

---

## v0.17.1 — *The Ledger* · Jun 20, 2026

The town banner becomes **one cohesive ledger** — compact, legible, and quiet where it should be.

- **Brand block.** `ClaudeVille` leads; version, FPS, and a live-connection heartbeat now share one quiet meta line beneath the wordmark instead of three competing chips, giving the bar back its horizontal width.
- **One family at the centre.** Tokens / cost / time fold into a single segmented **ledger tag** built to match the working / idle / waiting status tag, and the metric values move to the legible data face (Departure Mono) so the numbers read first.
- **Less to read.** The redundant 5h / 7d quota chip leaves the bar — those figures already live in the mine and the OS widget — while the living activity rail and reconnect sweep stay.

---

## v0.17.0 — *Lanternlight* · Jun 20, 2026

The village becomes **one lit place, breathing with its fleet** — and every new flicker of light, motion, or colour is a true word about a real session. A 50-item visual upgrade, distilled by a design council and built in dependency-ordered, file-disjoint waves.

### Coherence — one village, under pressure

- **One palette.** A single colour authority in `theme.js` (building accents, status set, provider hues) now feeds the world overlays, council rings, harbor, avatars, and the dashboard — the World and Dashboard finally read as two windows onto the same town.
- **Value hierarchy + grade.** A mark governor keeps the busy scene legible (the one errored agent is never lost in a crowd of twenty-four), and every overlay now tints toward the time-of-day grade instead of floating "day-cold" over a dusk scene.

### The world, lit and honest

- **Dormant promises wired.** Values the engine already computed and threw away now drive the scene: building **beacons breathe** together, **puddles / roof-glint / water-warmth** follow the weather to the ground, building fire **reflects on the night lagoon**, and the **whole sky storms when the fleet struggles** and clears to gold when it's healthy.
- **Forge & archive glow.** Molten light spills from the forge onto the cobble yard; lamplight leaks from the archive doorway when reading is heavy. A **Pharos searchlight** sweeps faster and shifts amber→red as distress rises.

### Legible at a glance

- **Glyph badges** replace the always-dark name pills, busy buildings fold their crowds into a **status tally**, labels **fade by zoom & density**, and overflow crowds raise a **heraldic standard** instead of silently dropping agents.

### Alive

- **Real body language** (distressed hunches, tired slumps, proud uprights), **working rituals at all nine buildings**, drifting **chimney smoke**, **token-flow motes**, **animated surf**, **cloud-shadow parallax**, directional **dawn/dusk shadows**, idle **gossip clusters**, and **seabirds with intent**.

### Epic moments

- **Director-driven cinematic camera** (frames parades, incidents, arrivals; aborts instantly on input), a **session-driven storm** with forked lightning, an **error distress arc** to the watchtower, an **opening establishing shot**, and an idle **Ken-Burns drift**.

### Surface polish

- Dashboard **reskinned to the village house style** with district washes and status rails, a **selection echo** that lights the same agent across panel/card/sidebar, an Activity-Panel **hero portrait** and **director scene-log ribbon**, a **topbar activity rail**, and **felt connection-loss** chrome.

*Built via a council-designed plan ([`agents/claudeville-visual-upgrade-top-50.md`](agents/claudeville-visual-upgrade-top-50.md)) and an orchestrated, file-disjoint parallel build (23 waves). Runtime-verified — zero console errors across World and the 24-agent stress sim, `validate:quick` green; every motion feature ships a reduced-motion fallback. Per-item visual polish QA is ongoing.*

---

## v0.16.1 — *Moonlit Envoys* · Jun 19, 2026

Kimi's newer home is now part of the village, with its child agents and context usage visible alongside legacy Kimi sessions.

- **Kimi Code sessions** — ClaudeVille now scans `~/.kimi-code/` in addition to legacy `~/.kimi/`, reading indexed projects by session id or directory with `state.json` homedir and `config.update.cwd` fallbacks, main sessions, child agents, recent tools, user prompts, assistant messages, token usage, and git commit/push activity with tool-result success/failure metadata from the new wire format
- **Detail parity** — Kimi Code detail responses now carry the same resolved project path used by the session list, and recent tool rows include tool-result exit codes/stderr so failed shell commands get the same warning chips as Codex and OpenCode
- **Child-agent lineage** — Kimi Code `agents/<agent>/wire.jsonl` entries now appear as linked sub-agents, including nested child-to-child lineage from persisted `parentAgentId` metadata when Kimi provides it
- **Quiet parent continuity** — when a Kimi Code child agent is active but the main wire is quiet or missing, the main session remains visible with child-derived model/context metadata and parent detail lookups fall back to the newest child wire so sidebar grouping, tethers, and parent selection keep working
- **Context limits** — Kimi Code model config and per-session `config.update` aliases are read for context-window capacity, so session cards and details can show the same normalized token pressure as other providers before the first usage record arrives
- **Usage normalization** — Kimi Code `usage.record` token fields now tolerate both camelCase and snake_case spellings before being normalized into ClaudeVille's shared input/output/cache counters
- **Live config watching** — legacy Kimi and Kimi Code config files are now part of the watch set, so display-name and context-limit changes refresh through the same near-live path as session updates
- **Detail lookup hardening** — Kimi transcript details, indexed session directories, and child-detail fallback paths now verify resolved paths stay inside known Kimi session roots before reading or trusting them
- **Lunar Kimi look** — the Kimi villager sprite has been refreshed from a horned executor into a lunar oracle silhouette that better matches the provider's softer moonlit identity

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
