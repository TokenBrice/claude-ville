# World Visual QA Checklist

Use the maintained local server at `http://localhost:4000`.
World scenarios are deterministic fixtures for `?sim=1&scenario=<id>`.

## Frozen Renderer Baselines

- Read [`rendering-baselines.md`](rendering-baselines.md) before renderer, trail, PostFX, atmosphere, or material changes.
- Run `npm run world:capture-render-baselines -- --dry-run` after changing the capture matrix.
- Capture the affected manifest IDs in `webgl`, `postfx`, and `canvas` modes. Do not compare a forced-FULL PostFX source frame with an adaptive performance level without reporting both values.
- Every performance claim must include Chromium build, GPU/driver, OS, machine label, viewport, DPR, browser zoom, and power state from the capture metadata.
- Review and approve the clear-day, torchlit-night, and action-needed storm north-star frames before broad material or asset production.
- Use `npm run world:benchmark-trails` after trail, camera, or cache changes; manual pan, follow, and director glide must produce zero historical trail-cache repaints.

## Baseline

- `no-agents`: map loads with stable building labels, idle harbor, no empty-state errors, and no console errors.
- `one-working-agent`: selected worker has readable name, current tool, route/trail, and completion state.
- `mixed-tools`: read, edit, bash, web, plan-mode, chat, retry, and subagent cues remain distinct without visual noise.

## Crowd And Relationships

- `dense-24-agents`: at least 20 agents remain selectable; dense labels do not cover building labels or each other excessively.
- `dense-100-agents`: stress scenario for label, trail, drawable-culling, and terrain-cache readability at high agent counts.
- `team-gather`: team members cluster around intended Command/Task Board areas with readable chat pairing.
- `parent-subagents`: parent/child agents are visually distinguishable; completed child cleanup leaves no stale label or marker.
- `building-inspection-replay`: Command building opens selected, replay is active, and selected-building route lines are more prominent than hover previews.

## Harbor And Git

- `git-harbor`: commit, push, fetch, and pull fixture events are available for harbor reducer and ship checks.
- `failed-push`: failed/rejected push state is visible at the harbor/watchtower and does not look like a successful departure.
- `release-parade`: harbor release ribbons and parade label appear from scenario metadata without requiring a real tag push.
- Release sails (8.2): in `release-parade` at 1920×1080, 1600×900 and 5120×1440 (fresh context each) the release's sloop appears at the Harbor slip in front of the jetty's east arm in four Bayer steps of whole texels (never a translucent ghost), hoists a gold pennant in three steps, flashes a cream rim round its sails for one frame (the peal's first note, with sound on), casts off bow-first no steeper than 30° below screen-right with two foam chevrons astern while the gold crown (2-texel spokes, filled core, jewels; no stem) blooms just above its pennant staff (full radius inside the safe area, off chrome and plaques) and dissolves on a Bayer order, and carries the crown seal out past the buoys; the Harbor's top signal pennant is white before the release and gold after the crown ends, for the rest of the local day. A plain `git tag v1.2.0 && git push origin v1.2.0` (or `git push origin v1.2.0`) plants the release; a branch push never does. `failed-push` shows no sloop, crown or gold pennant; reduced motion keeps the sloop tied up under a static seal and clears it with the seal.
- Harbor labels, dock tiles, ships, wakes, and building labels remain readable at desktop viewport widths.

## Director Incidents And Signals

- `waiting-on-user`: the waiting agent carries one `NEEDS YOU` attention plate (docked at the frame edge when the agent is out of view), the top bar lights `NEEDS YOU`, and the agent remains inspectable in the Activity Panel.
- `quota-rate-limit`: mine-side quota/rate-limit pressure creates a Director incident and building Signal rows. The weather does not change: the snapshot reports `weather.cause === 'timeline'` with the same type, cloud cover and precipitation as `no-agents` at that minute (the same holds for `many-waiting` and `failed-push`).
- Building hover should show a light signal/route preview; clicking the building should promote that to the full selected-building route treatment and Signal panel.
- Press `R` in any World scenario to toggle the last-minute replay badge and trails; `building-inspection-replay` starts with replay already enabled.

## Occlusion And Selection

- `selected-behind-building`: selected agent remains discoverable when partially hidden by a split building sprite.
- Selection ring, label, route/trail, and detail panel state agree after select/deselect.
- World to Dashboard toggle preserves agent identity and does not leave stale selected-agent visuals.

## Building Ground Integration

- Run `npm run world:validate-buildings` and confirm all nine types have valid grounding profiles.
- Run `npm run sprites:capture-baseline` and `npm run sprites:capture-fresh`; every named day/night closeup must assert its target near frame center before `npm run sprites:visual-diff`.
- Press `Shift+D`: cyan is the logical footprint, white is the sprite anchor/world center, magenta is the sprite canvas, yellow is `horizonY`, red is structural contact/shadow extent, and green is the entrance marker and its line to the anchor.
- At zoom 1 and 2, no land building shows a continuous raised lawn/stone perimeter or a renderer pad outside its site.
- Roads meet the physical threshold, stairs, rails, or posts. Terrain texture remains visible between sparse apron marks and reaches structure footings.
- Shadows begin under structural mass, not at the footprint edge. Harbor uses piling/water contacts; Lighthouse keeps a supported quay; Portal keeps a stair-connected dais.
- Hover and active-state marks communicate state without creating a platform at rest. Check idle and `mixed-tools`/active scenarios.
- Verify a selected agent both behind and in front of each split sprite after any `structureMask`, anchor, or `horizonY` change.
- Review clear day, fixed night, and reduced motion at integer zoom 1, 2, and 3 on a desktop viewport at least 1280px wide.

## Atmosphere And Motion

- Clear day: landmarks, terrain, roads, water edges, bridges, and docks have clear contrast.
- Night: building lights, lighthouse, water reflections, and labels stay legible without washing out agents.
- Weather truth (0.2): the weather is the village's own timeline (`resolveWeather` of the local date and minute); no agent, mood, director, push, release or Chronicle input reaches cloud, rain, fog, wind, sky, sea, grade, tint, birds or ambient particles. A push or release changes no sky, gull or fog pixel; a director glide or Ambient chapter never tints the frame (letterbox bars are neutral brass `#b8893f`); the empty-village tour at 12:00 clear matches the static noon hue. Winter snow falls only while the timeline precipitates.
- Fog/rain/storm: weather communicates the village's weather while preserving selected-agent, harbor, and building readability. Fog and dawn ground haze are world-locked stepped courses with ordered-dither seams (no gradient; they pan with the ground); the overcast and fog screen washes step in flat courses. Lightning is a pixel bolt on `round(zoom)` cells (cream core, checker halo, 0–2 forks) that lands only on open sea (with a stepped 2:1 splash ring) or ends in the sky, never on the island; the flash steps 0.30 → 0.035 with a 0.16 re-strike as an exposure step on both backends; the sun disc is a flat stepped disc with no outline and is hidden under a storm.
- Wind (C-W3): trees, chimney smoke, rain lean, cloud-shadow drift and the horizon cloud deck agree in direction; a pinned storm flattens smoke and moves cloud shadows over twice as fast as a clear day; in fog smoke rises and the gusts are still.
- Ground remembers (5.2, C-W2): pin a rain knot ending 14:00 (`__claudeVilleAtmosphere.setTimelineKnots([{minute:0,type:'clear'},{minute:600,type:'clear'},{minute:660,type:'rain'},{minute:780,type:'rain'},{minute:840,type:'clear'}])`, `setHour(14.5)` …): the street is wet and puddled at 14:30, holds only a few puddle cores at 15:15, is dry by about 16:00, and a reload at the same minute shows the same ground. Puddles lie only on paths and paving, reflect the graded sky in stepped opaque courses (dark far lip, sky body, shallow rim, sparse near-rim glints) and are never the brightest thing on the street. Clear with `setTimelineKnots(null)`.
- Winter (5.2, M9): snow lies only after the village's own winter precipitation (a dry January minute with no snow in the last two days shows bare winter ground; a clear January night shows grass-tip frost). Snow covers grass in drifts, slush on trodden earth, joints only on paving, thin under crowns and at walls; it never covers doors, banners, status marks or plates; `many-waiting` in a snowy January keeps every amber and red plate and ring distinct.
- Roofs (5.2 roofs, 6.6): after a December snowfall (pinned snow knots + a December date) every landmark roof carries stepped snow on its slate only — course lips first (1/2/3 rows per quarter of cover), the whole roof with its joints still reading at a full cover, eave rows left as slate — plus thin caps on silhouette tops (crenels, ridges, the arch, the rock); walls, doors, glass, banners, gold trim and status marks stay bare, and a dry winter day shows no roof snow. In rain the roofs' upper-left edges (ridge, verge) carry a 1-art-px `wetSlate` course and 3–4 eave points per landmark drip (never under reduced motion); after the rain the course steps down a stop per wetness quantum and is gone when the ground is dry. Clear weather draws the authored roofs unchanged. Canvas and WebGL match.
- Sky (5.7/5.8): survey and opening shots show the three-strip horizon cloud deck above the sea horizon and nothing cloud-like below it (no icon clouds on the sea); the deck is stepped cumulus on `round(zoom)` cells with sun-side rims (dusk `#f6be96` over `#a07492`), coverage follows the weather, and a night deck is a dim moonlit silhouette. On a clear night within a day of an IMO shower peak (e.g. 12 August) meteors come every 20–70 s from the radiant as whole 2 px cells; for the 20 minutes after the timeline turns from rain to clearing with the sun below 42°, a six-band stepped rainbow stands opposite the sun above the horizon (alpha ≤ 0.35, three fade quanta; none after snow).
- `storm-night-reduced-motion`: reduced-motion metadata disables or freezes nonessential motion while keeping semantic state visible: no lightning strike and no flash; fog banks, cloud shadows and gusts hold still.

## Frontier Instruments

- Hold `B` (or the READ button): occupied-building plaques show work verbs from the canonical classifier (`FORGE` reads `WRITING · 8`); the verb counts must equal the working count in the top bar; release restores names without moving the camera or changing selection.
- Press `A`: every action-needed agent is framed or the overlay states the exact excluded count (`N waiting outside view`); no waiting agent is silently omitted. In `waiting-on-user` after `A`, speech rectangles for non-selected agents are absent and every primary mark is present.
- AMBIENT CAM: in `dense-24-agents` it produces at most one move per 20–30 s hold and returns to the same wide; a wheel event stops it and the control enters its resume state; Auto behaviour is unchanged. Reduced motion holds one static overview with the same counts.
- SCORE (Activity Panel, selected agent with recorded rows): nodes land at semantic building anchors, long approvals read as brackets, unknown time reads as gaps; scrubbing changes no domain state; at most 24 nodes with an exact overflow count; reduced motion offers no PLAY.
- Select Command at zoom 2 and 3: the interior aperture opens with the same identities and counts as the building panel; at zoom 1 it does not; closing restores the exterior immediately; `dense-100-agents` shows at most the seat count plus an exact overflow.
- Night (`midnight-oil`): the selected building lights exactly one room per working occupant and leaving work extinguishes only that room; `2 working · 1 waiting` states both facts.
- Mine (`cache-ore`): the assay bench states exact input and cache-read counts for the last 60 s — no percentage anywhere; a provenance flip resets coverage visibly.
- Forge (`mixed-tools`): billets scale with fixture edit calls (`N edit calls · last 60s`); the result shelf stamps intact `exit 0`, cracked non-zero exits, and nothing without a provider-reported outcome; a Codex fixture with `toolExitCode: 1` cracks, a Claude fixture (no exit data) shows none.
- Shared-file knot: two fixture agents writing one path show one thread, the double-pencil knot, and panel bench tiles naming the overlap; 100 agents draw no pairwise lines.
- Empty village (`no-agents` at noon): canonical `READY_EMPTY` shows the banked Forge ember and no work effects; degraded-provider fixtures keep the degraded treatment, not rest.
- Rest seats (7.1): `dense-24-agents` with 8 agents set idle after the village settles: within 15 s every idle body not named by a live `SendMessage` sits still on a seat (sit strip, or the lowered fallback) facing its authored SE/SW; no working body sits; plaques and building light read the same with the sitters as without; an empty Command step or fountain rim draws no stone. At 4× on every occupied bench the backrest paints behind the sitter's torso and the front slice over its legs, also where the sitter sorts behind a split building (the Task Board's west side).
- Petitioners (7.2): `many-waiting` at z1/z2: bodies stand along the Command queue in the sidebar's NEEDS YOU order, each holding the raised-hand wait row on an E/W/SE/SW facing beside a floor candle whose wax matches its wait bucket (< 1 min 12, 1–4 min 9, 4–16 min 6, ≥ 16 min 3 texels), and the group plate reads the exact total with the oldest name on both backends. With 13 or more petitioners the plaza overflow bodies have candles too and join the same group plate (`14 · oldest …`), never a second one.
- Atmosphere: dusk/night frames must read cores-first (window cores before spill, halo never outgrowing the work); at hour 1, a full-moon and a new-moon date differ by one reviewed night course and both keep the waiting beacon as the brightest pool; rain shows source-coloured wet reflections under admitted lights only, contracting as rain stops.
- Shift-D on the resident GPU world: the shed list names each effect and mode, pass timings report for `upload`, `occlusion`, `scene`, `bloom`, `present` after `renderer.gpuWorld.setPassSamplingEnabled(true)`, and texture bytes split pinned/evictable.
- Top bar witness clock matches the forced hour and shows `FIXED`/`SIM` when overridden; the Sidebar exception shelf shows exact `N NEEDS YOU · N ERROR · N LIMIT` counts, the two oldest names, and hides at zero.

## Terrain Cache Scalability

- Run `npm run world:validate-terrain` and confirm the terrain cache plan reports chunk coverage for the current `MAP_SIZE`.
- Run `npm run world:validate-buildings` after building layout or visit-tile changes.
- In the debug overlay or console diagnostics, confirm terrain cache strategy is `single-surface` for the current 40x40 map. Console diagnostics are exposed at `window.__claudeVillePerf.canvasBudget().terrainCache`.
- Before increasing `MAP_SIZE`, confirm the single-surface estimate remains under the world cache budget or implement chunked terrain caches first.
- `MAP_SIZE` remains fixed at 40 for the semantic-diorama program. Package 0 measures a 6,560,000-pixel single-surface estimate against the 7,000,000-pixel reserve (440,000 pixels / about 6.3% remaining) with a 3x3 chunk plan; re-record the validator output when this changes.

## Sprite Refresh Audit

- Run `npm run sprites:audit-refresh` before any provider, building, ship, terrain, or atmosphere sprite refresh.
- Do not regenerate or replace sprite image assets until manifest ID audit and manifest validation are clean.
- Record contact-sheet or visual-diff evidence for any broad sprite refresh before merging asset changes.

## Regression Notes

- Check browser console after each scene.
- Keep viewport desktop-only, at least 1280px wide.
- Record any scene ID, viewport size, and observed failure with enough detail to reproduce.
