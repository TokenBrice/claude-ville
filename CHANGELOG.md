# ClaudeVille Changelog

---

## v0.50.0 — *The Swift Thaw* · Oct 02, 2026

Long working sessions could freeze the village for good: villagers stopped mid-stride, a resize stretched the stale frame, and a reload left only the slate-and-green placeholder until the server was restarted. The freeze had three layers, a server stall that grew with transcript history, a sprite swap that drew a missing image, and a render loop that never restarted after three failed frames, and all three are gone. A full speed pass then made the World, the server and the wire much lighter without changing a single pixel of the look.

- **The village no longer freezes.** Selecting or pinning an Oh My Pi villager whose session had aged past the 120-second active window made the server parse every transcript ever written, synchronously (64.7 s and 6.7 GB for a missing ID, over 150 s for a real resident), so nothing else could be served. Detail lookups now keep verified id-to-path mappings, read only header identities newest-first under a 512-file / 2 MiB cap, remember misses, and parse only the matched transcript: the same real resident resolves in 83 ms on a cold adapter, a missing ID in about 0.18 s and 0.03 ms afterwards. On the client, a villager whose model changed while its new sheet was still loading left a null sprite canvas that every label measurement drew, and three failed frames stopped the loop with nothing to restart it. Sprite profiles now swap as one generation, repeated frame failures retry at 1, 2, 4 and 8 s under one persistent "retrying" notice, overlapping resumes can no longer leave nothing scheduled, fallback preparation can no longer wedge, and Dashboard and context-restore returns reuse retained sprite sources instead of waiting on about 213 refetches. The natural reproduction (a synthetic 30-villager load with model switches, reloads and server restarts) froze 3 of 3 runs before and none after.
- **Lighter frames.** Packed material and occluder geometry was keyed so that it was rebuilt, with synchronous readbacks, on almost every frame; it is now cached per source pair, outline bounds and foot anchors are shared per sheet, and nearby-villager pairs are enumerated once (24× faster at 100 villagers). On the fixed `readme-showcase` simulation (31 villagers across every provider, 1440×900 at DPR 2), mean render time fell from 46.7–50.0 ms to 7.4–8.3 ms on WebGPU (p95 128–151 ms to 16–27 ms; long tasks per 20 s from 95–101 to 16–17) and from 41.2–45.3 ms to 8.1–8.9 ms on WebGL2. On `dense-100-agents` the per-frame update fell from 5.7–6.5 ms to 4.7–5.0 ms.
- **A quieter server.** Oh My Pi passes reuse unchanged transcripts by file identity and reuse the directory topology between 30-second reconciliations: on a real store a warm pass dropped from 155–230 ms and 18–28 MB read to under 2 ms with nothing read. A transcript appended mid-read is retried instead of failing the whole provider pass. Hook signals fold into cached sessions and broadcast at once without rescanning transcripts, git probes share bounded directory snapshots (ref walks per cycle 20 to 1.6, filesystem calls 612 to 441 in the fixture proof), and YAML, HTML, SVG and the web manifest are served gzipped with correct types.
- **Smaller updates, less client work.** WebSocket deltas now patch sessions by identity instead of list position, so an activity reorder no longer rewrites every villager: captured real transitions went from 645.5 KB to 487.3 KB on the wire including the full-snapshot floor (raw state 801 KB to 324 KB). Clients ingest only the sessions that changed while still re-evaluating clock-driven status on every message (100-villager replay: 12,007 to 603 session normalisations, 0.96 to 0.08 ms per message, identical World state). The top bar renders once per frame, spend accounting is incremental, biographies and affinities flush in one transaction (450 writes to 1 in the dense harness), and a closed Activity Panel defers pinned comparisons. Older tabs keep receiving full updates, and a new tab talking to an older server falls back to them.
- **Faster reloads.** The 0.7–1.2 s first-frame terrain bake is persisted with every semantic field in a bounded IndexedDB cache keyed by asset version, configuration, season, snow and frost, and bake revision, and a reload restores it byte for byte. Median reveal on reload: `dense-24-agents` 1.26–1.29 s to 0.70–0.72 s, `readme-showcase` 1.52 s to 0.90–0.94 s, with boot main-thread long tasks cut from 1.1–1.2 s to 0.45–0.55 s. A first-ever boot reveals within about 50 ms of v0.49. WebGL shaders compile as one batch, the first-frame colour reveal no longer blocks the main thread on a GPU readback (4 s in one cold profile), and the renderer, WebGPU and YAML roots are preloaded.
- **The GPU rests when nothing changes.** Each resident backend compares the exact bytes it would send to the GPU with the last presented frame and skips the passes when they match: 30 identical reduced-motion frames went from 120 passes and 2.1 MB of buffer writes to none, pixel-identical. Agent-atlas updates upload only the sampled rectangle of each cell (37.9% of the measured patch bytes were never-sampled padding), glow targets exist only while a frame reads them (about 20 MiB freed at 2400×1704 when unused), and a zero-strength bloom fetch is skipped.
- **Long sessions stay bounded.** Departed sprite tiles are forgotten, the trail cap can evict whole historical villagers, monument selection is cached (60,000 records: 0.97 ms to 0.001 ms per frame), and generated names are stored per identity, so a new name is one 66-byte write instead of a rewrite of the whole history.

Validation: 1519 tests passed; `gate:release`, `verify:render`, `verify:server`, `verify:architecture`, `test:e2e:replay`, `world:validate-buildings`, `world:validate-terrain` and `sprites:validate` clean; WebGPU parity passes on five scenarios plus device loss; all 20 building captures are byte-identical to v0.49.0; restored terrain artifacts match a fresh bake byte for byte across nine season and snow cases; first-frame reveal bands match the synchronous path on Canvas, WebGL2 and WebGPU; frame reuse is pixel-identical on both GPU backends; the freeze reproductions and the forced resume-race and frame-failure scenarios all keep presenting. Before/after figures come from fixed simulations, fixtures and store probes on one machine; live real-session comparisons varied in villager count and are directional only. `scripts/smoke/world-state-bounds.mjs` still fails its pre-existing direct-trail render-cap assertion, unchanged since v0.49.0.

---

## v0.49.0 — *The World-Ash* · Oct 01, 2026

An ancient ash now rises from the northern lagoon, the Portal Gate is cut from the village's own stone, and the small blemishes the eye kept catching are gone: an off-centre gate sign, two awkward wall joins, and fixtures in Command's crowded approach.

- **Yggdrasil on the lagoon islet.** A colossal evergreen world ash (`veg.tree.ash.world`, 240×271, about 2.4× the tall oak) grows on the islet between the Observatory and the Pharos Lighthouse, drawn through the normal tree path: its crown follows the seasons (fresher in spring, deep in winter, never bare), it carries the village's snow like a pine (`ash.world.snow`), leans one texel in the wind and casts a raking shadow. The islet grew to carry it: an authored oval (`scenery.js` `WORLD_TREE.islet`, `inWorldTreeIslet`) that the coast field seeds at sub-tile resolution, so every root stands on grass inside an organic sand ring. The islet stays unreachable and free of generated scenery.
- **A new Portal Gate.** The dark rock heap is replaced by a tall pale-ashlar pointed arch with gold voussoir bands, eleven violet rune glyphs and a swirling vortex, flanked by slate-spired towers on a stepped dais (REST `generate-image-v2` with `building.command` as the style image, palette-snapped to the landmark family; 312×264). The vortex glows every night as a fixture; the runes and crystals light from a new emissive sidecar only with real work, and the work cycle now winds the vortex inward along a two-arm spiral instead of rising in rows. The Portal gains material and surface sidecars, re-authored surface regions and re-anchored lights, pennant and ritual rings; summoned subagents step out at the foot of the dais stairs.
- **A centred gate sign.** The gate towers stood a quarter tile west, which centred the `CLAUDEVILLE` plaque between the drums' full silhouettes but not within the stone visible at the plaque's height (20 texels on the left, 1 on the right). They now stand at −2.33 and 2.41 tiles, leaving 11 texels either side of the plaque and the arch. Both towers rise 8 px so the parapet meets them below the machicolation, and a joint line marks where the gatehouse meets the west drum.
- **The sea tower stands in front of its wall.** Below zoom 1.5, on smaller windows, or whenever a villager came near, the sea tower was drawn in two halves and the back half sorted before the east curtain, so the parapet painted over the drum. It is now always one sprite sorted after the run; `static-prop-depth.test.mjs` guards the order on both prop paths.
- **A clear Command approach.** The rune fountain and the two braziers that stood where villagers crowd in front of Command now form a walk-blocked rune-well shrine on the lawn west of the Archive; the fountain-rim rest seat is gone.
- **One less 404.** Aperture lights fetch `base.rooms.png` only for landmarks that declare a rooms sidecar, so the Portal's new emissive sidecar no longer requests a mask that does not exist.
- **`agents/` is local scratch.** Agent plans, research and handovers no longer ship: the folder is removed from the repository and gitignored, and `check:artifacts` now fails if the ignore rule goes or anything under `agents/` is tracked again. Docs and code comments that linked into it name their plans in plain text instead.

Validation: 1286 tests passed; `gate:release` clean; `verify:render`, `sprites:audit-refresh`, `world:validate-buildings`, `world:validate-terrain` and the gate, surface and room bakes' `--check` clean. `sprites:visual-diff` fails 20/20 on baselines that predate several releases (v0.48.2.2 alone fails them by 28–66 %); against v0.48.2.2 the release's differences are confined to the gate, the sea tower, Command's approach, the Archive lawn, the Portal and the islet, and captures from the maintained server match isolated captures pixel for pixel. PixelLab spend: 71 generations.

---

## v0.48.2.2 · Sep 30, 2026 — Hotfix

- **CI green again: the hook-latency test times the hook, not git's index rebuild.** v0.48.2.1 failed CI on Node 24 (the `SessionStart` hook's median was 200.5 ms and 203.5 ms against the 200 ms budget) although no hook code changed. On a fresh checkout the index's stat data can be stale, so `git status --short` has to re-read the tracked sprites before it answers; the session hook kills it at 150 ms, the refreshed index is never written back, and every timed run cost Node startup plus the whole git timeout. `scripts/tests/agent-hooks.test.mjs` now refreshes the index once (`git update-index -q --refresh`) before timing. The hook itself is unchanged.

Validation: 1285 tests passed; `gate:release` clean. In a fresh clone with a stale index, ten session runs sat at 179–184 ms (Node startup plus the 150 ms git kill); after one refresh they dropped to a 51 ms median.

---

## v0.48.2.1 · Sep 30, 2026 — Hotfix

- **js-yaml 4.3.1 → 4.3.2** (CVE-2026-84375, GHSA-2883-xcg3-v3hh, high): empty mappings in a YAML merge sequence did not count toward `maxTotalMergeKeys`, so a crafted merge could burn CPU without limit. Merged Dependabot PR #9 and refreshed the vendored browser copy at `claudeville/vendor/js-yaml.min.js`, which the dependency bump alone does not touch. 4.3.2 also caps a merge sequence at 100 sources; the sprite manifest parses unchanged.

Validation: 1285 tests passed; `gate:release` and `verify:render` clean; the refreshed vendor file is byte-identical to the npm 4.3.2 `dist/js-yaml.min.js`; a 5,000-source empty merge that the old vendored parser accepted is now rejected (`abnormal merge sequence size`) in Node and in the live page, while ordinary merges and the sprite manifest parse unchanged.

---

## v0.48.2 — *Heralds of Sun and Moon* · Sep 30, 2026

OpenAI's sixth generation reached the gate unannounced. GPT-6 Sol and Luna (Sep 22) and GPT-6.1 Sol (Sep 29) matched no registry row, so every one of them, including OMP's `openai-codex/…` subagents, marched in as a nameless Codex battle-engineer with the `Codex` label and default OpenAI pricing. They now join the celestial guard under their own names.

- **Sol and Luna, sixth generation.** `gpt-6-sol` and `gpt-6.1-sol` wear the radiant sun-warlord armor with the dawn greatblade, labelled `6 Sol` and `6.1 Sol`; `gpt-6-luna` wears the moonlit skirmisher's armor with the crescent saber, labelled `6 Luna`. Each keeps the celestial effort ladder from `low` to `max` in World, Dashboard, and the Activity Panel. Bare, `openai/`-qualified, and `openai-codex/`-qualified IDs all resolve; unknown GPT-6 IDs such as bare `gpt-6` still fall back to the generic Codex identity.
- **Honest prices and context.** Registry revision `2026-09-30`, verified against OpenAI's model pages: GPT-6 Sol $2 input, $10 output, $0.20 cache read, $2.50 cache write per MTok; GPT-6 Luna $0.10, $0.50, $0.01, $0.125; GPT-6.1 Sol $2, $10, $0.10, $2.50. All three carry a 1,050,000-token context window. The static estimate does not apply the >272K-input long-context multipliers.
- **A trap for future rows.** Registry aliases are matched against the normalized model, where dots become hyphens and only `gpt-5-N` is re-dotted, so an alias written in the GPT-5.6 style (`gpt-6.1-sol`) can never match. The new rows use the hyphenated form (`gpt-6-1-sol`), and `docs/design-decisions.md` records the rule.

Validation: 1285 tests passed; `gate:release` (`validate:quick`, integration replay, `verify:server`) and `verify:render` clean; `models:resolve` maps the bare, `openai/`, and `openai-codex/` forms of all three IDs to their rows, with matching server and browser pricing, context, label, and sprite; a reloaded live village shows 16 OMP GPT-6.1 Sol subagents in Sol's armor.

---

## v0.48.1 — *The Keeper's Lamp* · Sep 29, 2026

At night the Lighthouse swept two long fans of light across the sea, yet the lamp that cast them showed only two finger-length wedges at the glass, so the light on the water looked far larger than its source. The lamp now throws its beam through the air as far as it lights the sea.

- **A beam as long as its light on the water.** Each of the lens's two fans has a twin in the air leaving the lantern: the sea fan's own shape (520 px long, widening to 200 px) laid flat at the lamp's height, turning with it at the same 0.45 rad/s. It is translucent silver in the fan's own stepped courses (0.27 near the glass, then 0.18, then a far course stepping down to nothing), on whole pixels and under the lens flash and halo, so the village and the sea stay readable through it. There is still no beam by day or through the dusk settling.
- **Never cropped.** On WebGPU and WebGL2 the lamp's light was clipped to the tower sprite's box; it now draws once, after the tower's occlusion split is released, so the beam reaches as far on every backend as on Canvas.

Validation: 1279 tests passed; `validate:quick`, `verify:render`, `verify:architecture` and `gate:release` clean; headed checks at 23:00 on WebGPU, WebGL2 and Canvas at zoom 1–3 over several headings show each air fan parallel to its sea fan with labels above it, and no beam at 12:00; the lamp's light costs about 0.18 ms a frame.

---

## v0.48.0 — *The Waking Isle* · Sep 29, 2026

The island had its light, but it still told small lies and slept through the day: agents nudged the weather, villagers slid and faced away from their work, the sea was a flat slab, night light fell only on floors, and the wall around the town looked like it came from an older game. This release wakes the whole picture, from the sea at the horizon to the stones of the gate, and moves the world onto WebGPU with HDR highlights.

- **The village keeps its own weather.** Weather, wind, ground wetness, snow and seasons come only from the village's clock and calendar; no agent, push or moment changes the sky, the sea or the grade (a new `smoke:v3-truth` check proves it on every renderer). Rain wets the ground and roofs and dries after; snow lies only after the village's own snowfall, on ground, trees, roofs and the stone wall. Fog, ground haze, lightning, meteor nights and after-rain rainbows follow the same rules.
- **Light that lands.** Lamps, braziers, windows and fires throw stepped, warm pools that climb walls by height and stop at the buildings in front of them. A room lights only when an agent is really working in it, and its window lays a broken, tapering column on the water. The night has a value ladder, so action-needed plates always stay the brightest thing on screen, and fires breathe and climb their own painted flame tongues.
- **A living sea.** Swell sets with lit slopes and troughs, crest clusters around the island, a sun path by day, a golden band at dusk and a moon path at night, cloud shadows and cat's paws on the open sea, rain rings, lapping foam and a drying wet band, shallows you can see into, full-colour mirrors of the harbor, lighthouse and bridge, and ships that sit in the water with their own reflections and wakes. The Lighthouse beam turns in pixel grammar.
- **A town of stone.** The wall, gatehouse and sea tower are rebuilt as one full-stone family: a crenellated curtain wall on the landmarks' own masonry, two round slate-roofed gate towers under a CLAUDEVILLE banner, a sea tower on the rocks and one shared lantern. Buildings open their doors, turn their cranes and bellows, and smoke only while agents work in them; roofs take snow and wet slate; woods grow to forest scale with bare winter trees; the Chronicle dresses the Harbor as releases land, and a verified release sails out from the pier under a gold crown on the peal's first note.
- **Villagers who work and rest.** Bodies walk on whole pixels with honest strides, face their work, strike, tinker, read and gaze with authored work strips, sit on benches, steps and the pier when idle, and queue at Command in the order they started waiting. Crowds walk in loose files instead of stacking, nobody stands on the well, the wall or the gate towers, and the well has moved to a quiet green.
- **A camera that knows the screen.** Shots scale by visible world area, so 5120×1440 gets a true establishing shot with sky room and rests on the panoramic middle tiers; `A` holds on everyone who needs you; glides are one continuous dolly with soft fat-pixel frames in flight and crisp whole-pixel frames at rest.
- **WebGPU, with HDR highlights.** Chromium now renders the world on WebGPU (pixel-identical to WebGL2 within one level, measured cheaper), mounting WebGL2 first and switching live on a cold shader cache; Safari and Firefox stay on WebGL2 and software GPUs get Canvas. On an HDR screen, *Settings → HDR highlights* (Off · Subtle · Full, default Subtle) lets lamps, fires, action-needed marks and release peaks glow above paper white, marks always above flames; P3 screens get richer status hues. A lost GPU recovers without a black frame.
- **Chrome that holds still.** The top bar keeps its layout in every mode, camera controls live in a World dock (*Free · Auto · Ambient*), a call card and pixel tooltips, sidebar busts and faces that read, a *Last 10 min* tape and a session strip, framed in one 9-slice kit, with ultrawide Dashboard columns and calm card transitions.

Validation: 1279 tests passed; `validate:full`, `verify:render`, `verify:server`, `verify:architecture` and `check:artifacts` clean; `smoke:webgpu-parity` 36/36 at ≤ 1 LSB with device loss; `smoke:v3-truth` 225/225 on WebGPU, WebGL2 and Canvas; headed HDR checks on the XDR (headroom 1 → 16 → 1) and the G95C at 5120×1440 (1 → 2.03 → 1); before/after contact sheets at 5120×1440 and DPR 2. Open follow-ups (run gait after the PixelLab reset, a batching and boot-time regression, unrun quiet-host receipts) are in `agents/plans/open-followups.md`.

---

## v0.47.1 — *The Minstrels' Gallery* · Sep 27, 2026

The Town band won, and over a long session it sounded like two tunes: every day piece was the same whistle, lute and marimba over the same arpeggio in A major, and every night piece the same music box and harps in A minor, because the arrangement followed the hour, never the tune. This release keeps one music preset, gives every tune its own players, key and feel, and nearly doubles the book.

- **Three ways to listen.** The SOUND popover is *Off · Signals · Town band*, with one Volume per preset and no mix sliders; the Town band is the default when sound is on, and a profile that listened to the Village now hears the Town band. The Village's sea, weather, wildlife, workshop and thunder layers are retired with their buses; the band already carries the weather, the hour, the village's work and the waiting cadence, and every bell still rings over it. The popover names the tune and its players (`Now · Saltwind Jig · fiddle & concertina`) instead of `loop 2 of 2`, drops its empty rows when sound is off, and `MORE IN SETTINGS` now loads the Settings styles before opening (it used to open an unstyled page).
- **Every tune its own band.** Each piece names its own lead, counter, comp and descant, a feel (straight, lilting or dotted), a comp figure and a key: A, D or E, major by day and minor by night, only keys that hold the bells' pitches. Rain, snow and storm re-dress a tune without swapping its players; night darkens the whole band; the season changes only the closing cadence colour.
- **New players.** A fiddle, a concertina and a hammered dulcimer join the Isle Band.
- **Eight new tunes.** By day *Saltwind Jig* (a 6/8 harbour jig), *Maypole* (a ring-dance waltz), *Shepherd's Hill*, *Tinker's March* and *Greenwood Reel*; by night *Emberwatch*, *Mist Harbor* (a waltz in the fog) and *Owl Lullaby*. The book holds 19 pieces: 11 by day, 8 by night.
- **No déjà vu.** The rotation is a shuffle bag: the whole playlist plays, in a fresh order each round, before any tune comes back.
- **A calibrated mix.** Stems were re-measured for every piece's players, held block chords are levelled by chord size, the bed meter hears the band's reverb so a needs-you call lands in its window over any tune, and the mono fold was re-derived for the narrower band.

Validation: 1183 tests passed; `validate:quick` and `gate:release` clean; the score analyzer holds every invariant across all 19 pieces; the local audio probe (`npm run audio:probe`, re-pointed at Signals and the Town band and re-baselined) passed all 511 checks, including per-piece stems, night darkness, cue margins over every tune, the preset switch, captions and the waiting cadence; the render smoke shows the three-preset popover and the new Now line; the 10/30-minute pressure soak passed.

---

## v0.47.0 — *The Singing Isle* · Sep 27, 2026

ClaudeVille's sound used to lie: it could fail to start, fade out on a busy GPU, ring the wrong bell for an error, stack a dozen chimes for one event, and loop the same tune every half minute. This release rebuilds the audio from the master bus up, so the island sounds like a place, and one bell always means someone needs you.

- **Sound that starts and stays.** The first click starts sound (the very first one opens the presets instead of guessing), a blurred window keeps playing, a hidden tab pauses in place and still wakes for urgent calls, and returning resumes the same piece. Everyone's volume was reset once to a new standard level, with a caption saying so.
- **One ceiling.** A calibrated limiter-only master with separate world, work, music and cue buses; ducks are timed to the note and cancel with their cue; each cue sets its own level from the bed it lands on, so a call is audible over a storm and never blares over a quiet night.
- **The village's voice.** Needs-you is a ship's bell, an error a cracked bell, a rate limit an escapement tick. An unanswered wait climbs a capped reminder ladder, and a soft held note sounds under the Village for as long as someone waits. Outcomes speak in oak, stone, iron and gold, and a burst of events rings once. Captions work with sound off and follow one setting.
- **The island.** A sea with swells, breaking waves, gulls and harbor clinks that steps aside for a bell; gusting wind; rain on roofs, leaves and water; thunder whose distance you can hear; birds by species and hour and a cricket chorus at night; and a day arc that makes night darker and quieter than noon.
- **Workshops at work.** Every building has its own material voice — anvil, parchment, pick, tack and chalk, telescope, rune stone, flag, crates — driven by how busy its agents are, never one sound per tool call, and struck on the drawn hammer blows. Following an agent brings its work forward, the Mine rumbles as the quota fills, and continuous sounds pan and soften with the camera.
- **The Isle Band.** The village's own musicians — lute, harp, upright bass, whistle, marimba, music box and brushes — play every tune, and *The Painted Isle* and the night waltz *Lanternlight* join the book. In Village, music is an occasion: a tune at dawn, noon, dusk and night or when something ships, short fragments between, and silence in rain, at rest or over a long wait. The Town band rotates without déjà-vu, breathes between pieces, hangs on an unresolved cadence while someone waits, drums with the village's work, and re-dresses its tunes for rain and snow. The console chip voice stays one click away.
- **The front door.** A fixed-width sound control opens a SOUND popover: *Off · Signals · Village · Town band*, a volume per preset, what is playing, the mix for the current preset, a test bell and `HUSH FOR 1 HOUR`. `M` toggles sound anywhere. *Signals* is silence until an agent needs you, errors or hits a limit. Settings gain a SOUND section with output (speakers, headphones, mono), tone, quiet hours and *Soften sudden sounds*, and the first time an agent needs you with sound off, a toast offers the bell.

Validation: 1294 tests passed; `validate:full`, `gate:release`, render and lifecycle audio smokes clean; the local audio probe (`npm run audio:probe`, virtual clock) passed all 510 loudness, audibility, timing, honesty and music checks; an audition reel of the before/after scenes was rendered from the shipped code.

---

## v0.46.0 — *The Painted Isle* · Sep 26, 2026

ClaudeVille had plenty of effects but no correct base image: the default renderer never showed the time of day or the weather, the ground was a checkerboard of mis-mapped tiles, three pixel densities stood side by side, and the effect layer was invisible while the labels shouted. This release repairs the picture from the ground up.

- **One light.** One grade (`GradeEvaluator.js`) turns the real clock, weather, moon and season into the whole world's colour on both the WebGL and Canvas renderers. Noon, golden hour, blue hour and night now look different, and rain and storm read at a glance. Night is moonlit rather than grey: grass stays green, stone turns slate-blue, the sea stays blue. Lamps pool as small, warm, stepped rings on the ground, clouds cast world-locked shadows, and low sun throws long violet casts.
- **One pixel grid.** Villagers stand at integer 1:1 (48–75 world px instead of 82–120), trees draw at 1×, and every effect, ring and mark sits on the art-pixel grid; the soft anti-aliased ellipses and glows are gone from the overlay. Bodies share one baked rim and one contact shadow; rings appear only for selection, hover and agents that need you.
- **A baked ground and sea.** The land is one splat bake on a master palette with district yards and worn doorsteps. The coast comes from one continuous field with foam, five depth stops and a stratified cliff, and the island now sits in open sea on every side, with the horizon above its far shore. Inland water is still, with sparse ripple dashes instead of a checker.
- **Coherent architecture.** Archive, Task board, Mine and Forge were re-authored on the Observatory's clean grid, and Command is the hero. Windows light only when someone works inside, including the Harbor and the Lighthouse. Props are fewer and grouped, trees grow in clumps by biome, and the unsourced waterfalls are gone.
- **A calm signal layer.** One attention plate per waiting, errored or rate-limited agent, grouped only with others of the same kind and docked at the frame edge when the agent is out of view. Rate-limited has its own orchid colour instead of the idle blue. District plaques state the exact count of agents routed there (`FORGE │ 8`); routine names appear at closer zoom for the most recent actors, and every label sits on the 8/11 px type grid.
- **Moments with a grammar.** Arrivals rise as a violet column at the gate. Sub-agents fly out as comets and land a few tiles from their parent; their return is captioned `RETURNED`, in stone, never gold. A verified release crowns the Harbor, a failed push leaves a red broken bracket on the jetty, and real tool work strikes small downbeats. Gulls, fireflies, rain, chimney smoke and seasonal drift follow a budget and a static reduced-motion frame.
- **A quieter frame.** The chrome moved to a parchment ink ramp on four flat surfaces, with gold reserved for light. The 48 px top bar has one lit slot for `NEEDS YOU`, `ERROR` and `LIMIT`; the Activity Panel is a character sheet, and the sidebar rows are 44 px. Boot no longer announces every existing session. The Dashboard sits on flat dark ground with one header row per project, a `NOW` column, a portrait on every row, a bell lane of call cards for agents that need you, and a `LAST 10 MIN` observed-call tape that understands every provider's tool names. Sibling repos always get different pennants.
- **Camera.** One motion vocabulary: log-space zoom, a pan at a resting tier, then unhurried 450 ms zoom steps. The follow window uses a critically damped spring, high-DPI screens get a survey tier for the opening and Ambient wide shots, and boot fades in from the sky instead of flashing black.

Validation: 906 tests passed; `validate:full`, `gate:release`, render and server smokes clean; the 10-minute World and 30-minute server pressure soak passed with flat listeners and heap (the 5-minute Chronicle prune now runs as one atomic IndexedDB transaction); a quiet-host soak kept 100 agents at full quality in the survey view; the before/after contact sheet was reviewed and signed off by the maintainer.

---

## v0.45.5 — *The Ranger's Bow* · Sep 10, 2026

DeepSeek Flash used to arrive as a bare-armed rogue that faded next to the other villagers. It now walks in as a hooded forest scout in the Reasoner's teal-runed cloak, and strings a bow as its thinking deepens.

- **Scout to ranger.** `agent.deepseek.flash` was regenerated in pro mode against the Reasoner rig, and two new rungs join it: `agent.deepseek.flash.high` draws a shortbow at high effort, `agent.deepseek.flash.xhigh` carries the longbow at xhigh or max. Each rung ships walk, idle, and a `read` action strip with reviewed emissive rune edging.
- **OMP effort reaches the village.** The OMP adapter now surfaces `thinking_level_change` records as `reasoningEffort`, so every OMP session — not just Codex and Grok — gets effort rings, auras, and the DeepSeek ladder.
- **Ladder policy.** `ModelVisualIdentity` and the server-side presentation select the rung from the effort tier for any row that maps to the Flash sprite; the reported tier, crest, and label stay literal (`max` still reads max). `deepseek-v4-pro` and the Reasoner keep their own sheets.
- **Roster page.** `claudeville/tools/model-roster.html` lists `deepseek-flash` on the full ladder so all three rungs render side by side.

Validation: 903 tests passed, manifest validator and channel audit clean, render and server smokes passed; three live OMP DeepSeek agents at low, high, and max thinking walked the village as scout, shortbow archer, and longbow ranger.

---

## v0.45.4 — *The Open Gate* · Sep 10, 2026

Finished agents no longer haunt the village. A departed villager used to stand as a grey, frozen "DEPARTED" figure for a minute and a half before its walk-out began; now it leaves the moment its session is gone.

- **Departures through the gate.** The instant an agent departs, top-level sessions walk out through the village gate and vanish on arrival, subagents merge back into their parent, and orphans return to the Portal Gate. The ghost tableau survives only as a fallback for a sprite with no exit in flight, so it should never be seen.
- **Sessions that come back.** A session that returns while its villager is still walking turns around where it stands; one that returns after leaving arrives again. Switching into World mode no longer spawns sprites for agents that already left.
- **Unchanged underneath.** The 90-second departed grace still feeds the dashboard, chronicle, and counters; only the visual residency is gone.
- **DeepSeek V4.1 Flash.** The registry recognises `deepseek-flash` with its 1M context and peak-hour rates, the OpenCode adapter reports its context limit, and the legacy DeepSeek V4 Pro, V4 Flash, and Reasoner rows now carry the Flash rates DeepSeek bills them at.
- **Model roster dev page.** `claudeville/tools/model-roster.html` renders every model side by side with its runtime accessories, using the app's own compositor.

Validation: 901 tests passed; on the maintained server a forced departure walked to the gate in about nine seconds with doors open, faded, and was removed, and a session restored mid-walk turned around and resumed.

---

## v0.45.3 — *The Starforged Sovereign* · Sep 09, 2026

Astra now stands apart as the village's heaviest celestial warrior, with a broader silhouette and equipment of her own.

- **Sovereign armor and cape.** Dark gunmetal plate, aged-gold trim, a crowned helmet, and a full violet cape replace Astra's silver armor. Updated walking, idle, reading, and portrait artwork keeps her identity consistent across views.
- **Worldsplitter.** Astra carries a signature halberd at every effort level. Existing effort rings and crests retain their distinctions; the halberd is put away while she reads.
- **Coherent animation.** Repaired rear-facing walking frames preserve the cape, and updated wrist positions keep the weapon attached throughout all eight directions. Luna and the other warriors retain their existing artwork.
- **Reliable sprite repairs.** Targeted direction assembly supports padded exports and explicit reference-frame removal. Manifest updates preserve multiline animation metadata, and frame caches distinguish regenerated poses from their predecessors.

Validation: 899 tests passed, clean sprite audits and browser smoke checks, and exact Canvas/GPU equipment parity across 560 Astra combinations. The separate no-agent building comparison reports 14 mismatches against stored baselines; those baselines were not changed. Visual evidence and production details: `agents/research/astra-epic/` and `agents/plans/lets-make-astra-model-really-epic.md`.

---

## v0.45.2 — *The Lighter Brush* · Sep 08, 2026

The World was never GPU-bound: a headed NVIDIA trace showed the card idle at under a millisecond per frame while Chrome's GPU process spent ~14 ms per commit replaying our own Canvas2D command stream. This release cuts that stream by 75–88 % without changing a pixel of the steady-state village. Plan, evidence, and matched-roster A/B: `agents/plans/claudeville-fps-optimization-plan.md`.

- **One owner per body.** On the resident GPU path the lower Canvas no longer repaints agent bodies, equipment and silhouettes after the GPU frame record is published; the WebGL layer already draws them. Budget and low-zoom impostors draw as one cached stamp each; the rate-limited frozen tint keeps its Canvas owner because no GPU channel carries it.
- **Glyphs and plaques as stamps.** Agent signatures and event silhouettes were rasterized one `fillRect` per pixel every frame (32,000+ per second at 50 agents); they, along with name, compact and chat plaques, now draw from bounded device-scale stamp caches with pixel-snapped placement, released alongside the other shared sprite caches. Fading plaques keep their vector paint so translucent overlaps composite exactly as before.
- **Dead channels stay dead.** The resident path skips the unused PostFx water mask, and the occluder atlas channel is neither painted, uploaded, staged nor cleared while occlusion is off and ground fog is zero; reactivation forces a full occluder upload. Emissive is untouched.
- **Bounded for long sessions.** Wet-reflection stamps gain the same entry/pixel eviction as lantern glows and drop the atmosphere from their key; overlay spatial grids and bubble clusters release every stale member each frame; the WebSocket disconnects even when the app is torn down mid-boot.
- **Shift-D counts the paint.** Per-category lower/upper paint counts appear in the debug overlay and `_lastRenderStats.paintCounts` so backend ownership is observable.

Measured on a headed RTX 5070 Ti at 1245×693 with matched simulator rosters: Canvas2D commands per frame 762/1299/3577 → 429/692/424 (world) and 1734/2597/4263 → 786/898/1092 (overlay) at 24/50/100 agents; renderer JS 4.5/7.2/9.5 → 3.8/5.8/7.6 ms; quality ladder unchanged.

**Not shipped:** dirty-rect uploads for the semantic ground (its mark producers expose no bounds) and dirty-cell coalescing for the agent atlas; the 60-minute headed soak that confirms the hours-old-window slowdown is gone remains to be run.

---

## v0.45.1 — *The Steady Watch* · Sep 08, 2026

- **FPS returns to the header.** A permanent counter beside the village clock shows the World render-loop rate and stays visible as `FPS idle` when rendering is suspended or Dashboard mode is active. Returning to World mode starts a fresh sample.
- **Accurate readings, protected by regression checks.** The first frame establishes the measurement baseline, eliminating the extra frame counted in the initial sample. Tests cover 30, 60, 120, and 144 FPS, slow frames, suspension, and recovery; browser checks guard visibility and mode switching.
- **A simpler status line.** Removed the 5-hour and 7-day quota gauges and percentages from the header.

---

## v0.45.0 — *The Open Door* · Sep 06, 2026

The village becomes more extraordinary by becoming more truthful: bodies whose hands do the work, buildings that open to show who is inside, light that belongs to the architecture, and a frame that steps back until the operator asks for an instrument. Plan and evidence: `agents/plans/claudeville-frontier-visual-plan.md`.

**Instruments**
- Shift-D names every millisecond and every effect: opt-in per-pass GPU timings for `upload`, `occlusion`, `scene`, `bloom`, `present` (one pass per 12 frames in rotation, disjoint samples discarded), atlas accounting split into pinned and evictable bytes, and a measured budget receipt for each optional effect — the shed list prints what was dropped, in which mode, and why. Key order in `EFFECT_BUDGET` is the shedding order; an effect without a measured band is not admitted.
- The sprite manifest gains named animation groups and provenance (`characterId`, `animationGroupId`, `generationSize`) across the roster, a production plan against the live PixelLab balance, and a REST pipeline (`scripts/sprites/pixellab-rest.mjs`, `scripts/sprites/generate-action-strip.mjs`) that works where the MCP mount cannot authenticate.
- OMP sessions now produce a working set (newest canonical paths with read/write and observation time) from real tool arguments; the first-run World Controls tip dismisses on mode switch; the dashboard version no longer synthesizes a Harbor release parade — the parade answers only real release events.

**Read the village**
- A stale worker keeps identity and every primary mark but stops fresh ritual motion and carries a cut-corner last-observed seal; selected copy reads `Last observed 25s ago`, never `Idle 25s`.
- Turn sand replaces progress bars: a three-notch timer beside the selected worker states observed turn age (`2m 18s`), unusually long turns elsewhere get one static notch, and a completed turn briefly states `Last turn 38s` only when the provider reported the duration.
- Hold `B`/READ and routine nameplates yield to short work verbs from the canonical tool classifier (`FORGE` reads `WRITING · 8`); release restores names without touching selection.
- The `A` attention frame is built from the complete action-needed set ranked by real wait age and states the exact excluded count when geometry cannot include everyone; entering focus quiets speech rectangles and duplicate routine names while every primary mark stays.
- One event family, one authored silhouette: edit strike, read page, shell slate, message scroll, incident bracket, child return, release crown, stale seal, turn sand, and per-district seals are shared by Canvas stamps and DOM icons — no family distinguished by colour alone.
- The top bar carries the witness clock (`22:14 NIGHT`, stepped weather glyph, `SIM`/`FIXED` when overridden) and the Sidebar a brass exception shelf (`2 NEED YOU · 1 ERROR · 1 QUOTA`, two oldest names, click to select, hidden at zero).
- The selected building panel renders each fact once — presence, work signal, queue, purpose — through one pure model whose numbers the interior aperture reuses.

**Bodies**
- Sixteen of twenty-four characters carry an authored four-frame `read` action strip — the book opens between both hands, head down, the last frame the legible hold that reduced motion and a stale observation select; the six whose rigs could not land the frames within ±2 px of their feet keep the procedural book, byte-identically; GPU and Canvas resolve the same frames.
- A waiting agent's held palm carries its reason from `waitReason`: an open letter (question), a closed command slip awaiting its seal (approval), or an unrolled plan (plan review); the slip seals only on an observed resolving event, never while the wait is pending, and never from elapsed time.
- Every agent carries a stable signature (pure function of id and family) that survives hero body, compact body, and impostor diamond, so one individual stays followable through zoom.
- Subagent dispatch and return wisps carry a crop of the child's own idle frame plus its signature; bursts fold onto the parent as one miniature with an exact child count and one static receive beat — returned, not succeeded.
- Every character sheet gained an authored portrait crop for the head-and-shoulders view, with the full-body witness (weapons, effort crowns) always beside the name.

**Light**
- One dusk exposure contract allocates motivated light cores-first (window cores, then spill and wet reflection, bloom last) from a small reviewed bucket table; the Lighthouse and Harbor halos stop outranking the work they light.
- The moon changes the night: one `moonFill` scalar from real lunar illumination and cloud transmission selects reviewed night ambient courses, identical in resident, hybrid, and Canvas.
- Rain borrows the lantern's colour: broken source-coloured reflections lie under admitted lights on approved wet materials and contract as rain stops; every effect carries its measured receipt.
- Command's pilot palette ramp quantizes admitted local light to an authored dark/mid/high LUT instead of multiplying toward white — slate stays slate, gold reaches an authored highlight.

**Open door**
- Selecting Command at zoom 2 or closer swaps its front wall for an authored sectional interior: real assigned sessions as identity tokens with their current tool, at most the seat count plus an exact `+N more`, exterior footprint and pathfinding unchanged.
- At night the selected building lights one stable room per real working occupant; leaving work extinguishes only that room, and a waiting agent is not a failed bulb.
- Beside the Mine, an assay bench keeps the last 60 seconds as exact dark-ore and pale-crystal counts with a provenance-aware cost window — counts, never percentages; the transient percent cargo label is gone.
- The Forge stacks workload billets by observed edit calls and keeps a result shelf that stamps only provider-reported command outcomes: intact `exit 0`, cracked `exit 1`, blank while unknown. Codex, Kimi Code, and OpenCode report bounded results; providers without such records carry none, and nothing synthesizes them.
- Selecting a writer reveals one angular ground thread and a double-pencil knot with exact writer counts; the panel's working set becomes four READ/WRITE file tiles with named overlaps behind one exact overflow.
- The task board gains project-coloured plan tabs (`2/7`, `+9 plans`) and a selected chronicle monument a low stone ledger of its last three real milestones; on a confirmed-empty village the Forge banks to an ember and the safety lights stay.

**Broadcast**
- AMBIENT CAM: an explicit, patient broadcast — wide of the active districts, lateral glides to the busiest real work cohort, an earned incident chapter, back to the wide — with factual captions and 20–30 s holds. Any input revokes it until asked for again; nothing re-arms on a timer; reduced motion holds one static overview.
- A rejected push in Ambient earns exactly one Harbor/Watchtower chapter with a held caption and a return to the saved wide; outside Ambient the camera never moves for it.
- Visual accents land on the cue score's real note times — the recovery bracket closes on the first bell, its diamond on the octave, one council notch per gathered member on successive bells — and a muted village gets the same score on the monotonic clock, so nothing waits for sound. BGM thins at the next four-bar boundary when the village rests and states `Working N · Waiting M` beside the music control.
- On request (SCORE), the selected run's last 20 minutes become a badged spatial score over the village: tool glyphs at their semantic buildings, scrubbable cursor, approvals as long brackets, children beside their real parent, unknown time as gaps — one shared pure waterfall with the panel, never a claim that the agent walked there.

**Not shipped:** the authored `wait` held-palm row — four generations across two pilot rigs kept re-drawing the staff into the hand, so waiting agents keep the procedural held pose; six characters are strip-less; 3.3 window light reaching the street was built and cut because its scene-pass apply produced no measurable output ([OF-009](agents/plans/open-followups.md), [OF-010](agents/plans/open-followups.md)).

---

## v0.44.0 — *The Slatekeeper* · Sep 05, 2026

The task board becomes a readable record of live work, from the village overview down to individual checklist items. This release includes all local work since v0.42.0, including the additions documented under v0.43.0 that were not published separately.

- **A slate board that stays legible.** A new flat slate face replaces the pinned parchment. The same phase-aware chalk checklist stays inside its oak frame at every zoom level, scaling with the building instead of switching to an overflowing plaque. The board follows the selected agent's checklist, then a pinned agent, then the most recently changed available plan.
- **Plans keep their phases and progress.** Claude, Codex, and Oh My Pi checklists now carry up to 64 items through the session pipeline, replacing the 12-item limit that cut longer plans short. OMP phase labels survive parsing and WebSocket updates. The board groups phases in declared order and expands the first unfinished phase; the Activity Panel adds phase disclosures and done/total counts.
- **Real prompts and plans reach the village.** Agent updates now forward prompts, todos, and recorded branches to the UI. Codex reads its latest update_plan and genuine user prompt, with bounded backfill beyond the short summary window. OMP folds todo operations into the current checklist and filters reminder-only user content.
- **The night shift lights the village.** After dusk, building windows and authored light respond to working or tool-pending occupants, fading down when buildings empty. Token-mine carts mix cache-read crystal with fresh-input ore using reported token ratios, with a cache percentage and tooltip when the data is available.
- **Unpushed work has a place and an age.** The harbor ledger lists repository branches by their oldest unpushed commit, with its scan limits disclosed. The command-pond bridge carries up to six branch lanterns with age-based brightness and hover details, sized to remain visible at overview zoom. The first two repository anchorages sit in the northern lagoon.
- **Steadier villagers and complete GPU activity.** Annotation congestion no longer shrinks villager bodies in ordinary fleets. Building rituals, occupancy pennants, mine cargo, and bridge lanterns render in the default WebGL path as well as Canvas. The slate material and atlas were refreshed alongside 20 day/night visual baselines; regression checks cover provider plans, phase counts, consistent chalk rendering across zoom levels, lighting, cargo, and overlay rendering.

---

## v0.43.0 — *The Chalk and the Lantern* · Sep 05, 2026

Four additions that put data the adapters already parsed into the village itself, chosen from a sixty-idea ideation round and its critic debate. Every one renders only real session state and shows nothing when the data is absent.

**The task board comes alive**
- The Claude adapter has always projected the last user prompt and the TodoWrite checklist onto each session, and the Activity Panel's Prompt & Plan section was built to render them — but `AgentManager._sessionToAgentPayload` never mapped the fields, so the section stayed empty for every live session. `lastPrompt`, `todos`, and `gitBranch` now cross the boundary with bounded validation, participate in change detection, and survive WebSocket delta snapshots.
- The selected agent's real checklist is drawn in chalk on the TASK BOARD face: a `done/total` header, strike-through only for completed items, an accent tick for the step in progress, six rows plus an overflow count, zoom-gated and static under reduced motion. With nothing selected, the first pinned agent with todos takes the board; with no todos anywhere, the legacy paper ritual returns. Canvas and WebGL show the same board. Scenario `taskboard-live`.

**Midnight oil**
- After dusk a building's windows, static light sources, and GPU authored emissive are gated by live occupancy: lit only while a working or `tool_pending` villager stands at the building. The old 45% empty-building warmth floor is gone at night, so a dark village with two glowing buildings is the true night shift. Daytime rendering is unchanged; the gate rises in 400 ms and falls in 1.6 s, instantly under reduced motion. Scenario `midnight-oil`.

**Cache ore**
- Token-mine carts haul pale crystal for cache-read tokens against raw ore for fresh input, mixed in the session's real per-beat ratio, with a cumulative fallback and honest absence when a provider reports no cache classes. A DepartureMono `NN% CACHE` label and hover tooltip give the exact figure. The cart rides the existing token-delta ritual — no new loop. Landmark items (mine carts, forge handoffs) now register an overlay-safe scene category, so they render in the resident WebGL path for the first time instead of only under `?renderer=canvas`. Scenario `cache-ore`.

**Stale cargo and the lantern-braid bridge**
- Harbor dock summaries now carry the oldest unpushed commit per repo and branch. The sidebar ledger reads `repo · branch: N commits, oldest 2d`, sorted oldest-first, with the best-effort disclosure (newest 120 commits on the current branch, 7-day repo-watch window) on the header.
- The `bridge.ew` sprite, kept unreferenced since plan 2.8 awaiting an east–west hint, becomes the command-pond plank. `BridgeLanterns.js` hangs one lantern per branch holding unpushed work — capped at six, braided oldest to newest, brightness stepped by age, hover naming the branch and count, night-gated light sources, static under reduced motion. `world:validate-terrain` now checks plank bridge hints. Scenario `stale-cargo`.

Regression coverage: `o2-prompt-plan-mapping`, `c10-taskboard-board`, `c16-night-occupancy-gate`, `w11-cache-ore-ratio`, `o10-stale-cargo-ledger`, `w5-bridge-lanterns`, and the scene-category suite.

---

## v0.42.0 — *The Astral Lens* · Sep 05, 2026

The village becomes clearer to watch and more reliable to act on. This release brings 21 coordinated refinements to rendering, provider state, and the desktop interface, while preserving the local, zero-build runtime.

- **A more coherent pixel world.** Authored oak, pine, and willow canopies replace smooth procedural foliage, with quieter planting around work areas. A restrained material pass separates Terra's cloth and armor, Sonnet's fittings and crystal, and Command's masonry and banners without changing their albedo or adding bloom.
- **Graphics carry the meaning.** GPU ground cues now survive terrain composition, while upper annotations and selected-agent x-ray render once. Relationship and lighting changes refresh cached cues even with reduced motion. Building plaques follow visible sprite bounds, water detail stays attached to the world, and Canvas, GPU, and hit testing share snapped camera coordinates.
- **Steadier motion and clearer crowds.** Important agents and direction changes refresh their GPU poses immediately. Dense groups use compact ordinary bodies and fewer overlapping labels, retaining individual access to selected, hovered, and action-needed agents. Automatic camera framing is less aggressive; explicit zoom remains available. Reduced-motion lookups reuse one subscription as new villagers arrive, and completed image loads release their callbacks. Authored height, shadow strength, and material class zero now retain their intended shader meaning.
- **Provider state you can trust.** Broad account quota pressure no longer marks unrelated sessions as rate-limited. Hooks are scoped to the correct CLI and resolve Codex and Gemini session aliases. Grok follows fresh transcript writes inside old directories. Native lifecycle signals retain their source and certainty; stale approval signals expire instead of lingering indefinitely.
- **Honest freshness and usage.** Failed reads preserve the last good roster and detail for a bounded 60 seconds, with visible age. Missing cost stays unavailable and incomplete totals disclose their coverage. Simulation has separate history, channels, and writer leases, never requests live account usage, and clearly identifies itself as SIMULATED.
- **A more useful desktop interface.** NEEDS YOU is counted separately from ordinary waiting. Status and elapsed text stay readable, long details open in native disclosures without losing focus or text selection, and search understands CLI, model vendor, project, and team. Avatars keep their proportions, repeated tool marks use pixel SVGs, and healthy-empty World shows a compact banner.
- **Stronger visual and runtime evidence.** Added provider, persistence, GPU, motion, and crowd regressions; a seven-provider capture fixture; correctly positioned art studies; and 20 refreshed day/night baselines with repeatable capture quality. The Git-worker queue test waits for bounded completion instead of assuming a fixed machine speed. The long soak measures native retained listeners after pending history writes settle and uses a median RSS baseline while retaining its memory-growth limits. The implementation record includes measured performance tradeoffs and preserves the explicit deferrals for larger rendering experiments.

---

## v0.41.3 — *The Steady Blade* · Sep 05, 2026

Codex villagers now keep their weapons in hand as they walk, idle, and turn. The grip pass introduced for Astra extends across the full Codex roster.

- **Grips follow the animation.** Astra, Sol, Terra, Luna, GPT-5.5 and its heavier armor variants, GPT-5.4, Spark, and the generic Codex engineer use authored wrist positions for all eight directions and ten animation frames. Matching gloves, compact weapon placement, and front/back layering keep swords and tools attached to the hand in both Canvas and GPU rendering.
- **Armor and tools stay intact.** Empty-handed character sheets no longer pass through the old weapon cleanup that erased parts of their hands and armor. GPT-5.4's detached baked wrench is removed precisely before accessories are positioned, so higher-effort crowns sit above the helmet and remain complete. Authored engineer grips also prevent duplicate back-layer wrenches.
- **Visual regression coverage.** Equipment capture covers the full roster, every animation frame, and optional Canvas/GPU comparison. Regression checks cover wrist placement, equipment layering, armor preservation, and cleanup before crown placement.

---

## v0.41.2 — *The Astral Vanguard* · Sep 05, 2026

GPT-6 Astra joins the village as a silver-armored star knight, with a violet constellation cape and equipment that grows with reasoning effort.

**Astra identity and current-turn detection**
- `gpt-6-astra`, including normalized and provider-qualified forms, resolves to its own mythic, deliberate model class instead of the generic Codex fallback. World, Dashboard, and Activity Panel share the `6 Astra` label and violet accents. Bare `gpt-6` and `astra` remain unknown rather than guessing an identity.
- Codex now takes model and reasoning effort from the latest `turn_context`, overriding inherited session metadata. File-aware caching follows appended turns and file replacement, including model changes buried beyond the normal transcript tail. Switching to Astra no longer leaves an agent wearing its previous model's identity.
- Registry revision `2026-09-05`: a 1,050,000-token context window and standard per-MTok rates of $10 input, $50 output, $1 cache read, and $12.50 cache write, verified against [OpenAI's Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra). Estimates retain the existing static pricing policy; long-context and service-tier multipliers are not applied.

**A star knight and six effort tiers**
- New PixelLab pro character `agent.codex.gpt6astra`: polished silver plate, a star-crested helmet, pale cyan visor, and violet cape. Its 736×920 sheet includes all eight directions, six walk frames, and four breathing-idle frames. Dashboard's procedural fallback gains a four-point star insignia. Sprite asset version `2026-09-05-astra-v1`.
- Existing runtime weapons provide the progression: low carries a crescent saber, medium a runeblade, high a dawnblade, and xhigh/max/ultra a polearm. Lower tiers show floor rings; the upper tiers have distinct crests. `max` stays separate from `xhigh`, and missing effort uses the light saber without an effort marker. Astra's baked armor remains visible under every loadout.
- Regression coverage checks registry identity, effort equipment, and live Codex model changes. The equipment capture script now includes Astra, max, and ultra across every direction and representative animation poses.

---

## v0.41.1 — *The Evening Gate* · Sep 03, 2026

Finished villagers leave town instead of haunting it. The gate walk was always there; nothing was ever telling it to start.

**Departures run on their own clock**
- `AgentManager` evicted departed villagers only inside `handleWebSocketMessage`, but `broadcastUpdate()` returns early when the payload signature is unchanged — so broadcasts stop the instant the last session goes quiet, which is exactly when the last villagers should be leaving. Their grace never expired and they stood frozen and grey until the page was reloaded; a later session would then flush the whole backlog out at once. The lifecycle now lives in `_sweepDepartedAgents()` and `startDepartureSweep()` re-checks it every 15 seconds regardless of traffic. A timer sweep only expires villagers that are already departed — only a roster update can mark a live one as departed.
- `DEPARTED_AGENT_GRACE_MS` drops from 10 minutes to 90 seconds. With the server's unchanged 2-minute `ACTIVE_THRESHOLD_MS`, a finished agent now walks out through the village gate roughly three and a half minutes after its last activity instead of twelve. A short fan-out is still readable after it finishes; it no longer outlives your interest in it.
- `AgentManager.stop()` clears the sweep and unsubscribes the two `chronicle:milestone` listeners the manager had been holding for the life of the page. `App` starts the sweep on construction and stops it in teardown.

---

## v0.41.0 — *The Vermilion Order* · Sep 02, 2026

Two warrior-monks from z.AI join the village. GLM 5.3 and GLM 5.3 Flash arrive through Oh My Pi and are now recognised, priced, and drawn as their own family instead of falling through to Claude rates and a generic sprite.

**z.AI GLM identity**
- New registry family `zai` with rows `zai.glm-5-3` (label *GLM 5.3*, short *GLM*, apex tier, deliberate) and `zai.glm-5-3-flash` (*GLM 5.3 Flash* / *GLM Flash*, swift tier, quick), plus a `defaults.zai` fallback for future `glm-*` strings. Both carry a 1,000,000-token context window. Rates per MTok — GLM 5.3: $1.40 in / $4.40 out / $0.26 cache read; Flash: $0.15 / $0.50 / $0.03 — taken from omp's bundled `classes/glm.kdl` cost table and cross-checked against per-message `usage.cost` in real transcripts (verified 2026-09-02). Registry revision `2026-09-02`.
- OMP sessions keep `provider: 'omp'`; the `zai/glm-*` model string now resolves the `zai` pricing family in both resolvers, the presentation identity, and the server's `sessionPresentation`, so the Dashboard cost estimate, Activity Panel context bar, and burn-rate tooltips are correct. Without the new `pricingProvider` branch these sessions were billed at Claude Sonnet rates.
- House palette: `zai` takes vermilion (`#ff7a55` badge, `#ffa585` trim), the one warm hue no status or incident colour uses. Sidebar icon `Z`, label `z.AI`, home building Archive, familiar-mote glyph a monk's hexagon, GPU material `fabric`, and a distinct bell voicing.

**Two new character sheets**
- `agent.zai.glm` — the grandmaster: shaved head, vermilion martial robe, peach sash, jade prayer beads (the beads are the authored emissive source). `agent.zai.flash` — the acolyte: sleeveless tunic, peach headband, fists up. Both are PixelLab pro 8-direction rigs with walk and breathing-idle rows, new `zai` palette family in both mirrors, and authored material/emissive/occluder sidecars. Asset version `glm-monks-v1`.
- `generate-character-mcp.mjs` now centres frames that are smaller than the 92px cell: PixelLab's `create_character` takes `size` instead of `image_size` and pro mode returns frames at exactly that size instead of a ~40% padded canvas. Runbook, PixelLab reference, and the `sprite-character` skill say so.
- `npm run models:resolve -- omp <model>` checks the sprite the presentation actually renders, so source-adapter providers (`omp`, `opencode`) no longer fail the sheet check for every model.

---

## v0.40.0.2 · Sep 02, 2026 — Hotfix

- **Hook timing test bounded by the real contract.** `agent-hooks.test.mjs` asserted every hook run under 200 ms; a `session` run that spawns `git status` took 203 ms on a shared CI runner. Each run must now stay under 500 ms (half the 1 s `timeout` in `.claude/settings.json`) and the median over ten runs under 200 ms, so a regression still surfaces before hooks start being killed without failing on runner jitter.

---

## v0.40.0.1 · Sep 02, 2026 — Hotfix

- **Node floor is now 22.7.** The first honest CI run (v0.40.0) was green on Node 24 and red on Node 18: the browser code is `.js` ES modules, and Node only detects that syntax unflagged from 22.7, so `node --check` and the unit suite both fail on 18 (verified with a real Node 18.20.8 binary — `ModelVisualIdentity.js` is loaded as CommonJS). `engines.node` is `>=22.7.0`, CI runs 22.x and 24.x, and the README badge and prerequisites say so. Node 20 is end-of-life; `server.js` itself still runs on older Node, but the repository's checks do not.

---

## v0.40.0 — *The Scriptorium* · Sep 02, 2026

The village's own scribes get a proper workshop, and the river gets a real bridge. Most of this release is invisible at a glance and load-bearing for every agent working on the repository: one source of truth for models, verification a machine can run, docs that match the code, and a CI badge that finally tells the truth. Plan and evidence: `agents/plans/claudeville-agentic-dx-plan.md`.

**The central river footbridge, reforged**
- The 5×5 pontoon deck becomes a 3×3 arched footbridge over a local river narrows (x 15–21, rows 23–25), drawn at native 1× from a new civic sprite (`bridge.landmark.civic.ns`) with stone abutments, oak deck, and post lanterns baked in. The procedural fallback deck, the shadow ribbon, the fake pier foam, the floating accent props, and the elderwood style are removed; the lily pond returns to four tiles beside the north abutment.
- Agents cross *behind* the near rail: the sprite's camera-side handrail is redrawn as six clipped Y-sorted slices, and sprites (with everything anchored to them) rise along the arch while the depth sort keeps their ground Y.
- The avenue runs straight down column 18 through the deck. The Task Board moves to (23,33) with its slots, the chronicler landmark, and the production-row and bridge roads rerouted so its roof no longer overlaps the bridge foot. Bank props (boulders, flowers, lantern, banner, scenic rail points) hug the abutments and vegetation exclusion tightens to the deck. Asset version `footbridge-v1`.

**CI was red on every push since August 25**
- The workflow never installed dev dependencies, so the last step of `validate:quick` failed on `js-yaml` for every release from v0.34.0 to v0.39.1. CI now runs `npm ci` and `validate:full` (quick checks, the integration replay, the isolated server smokes, world and sprite validators) on Node 18 and 24.

**One model registry**
- `claudeville/src/config/models.json` is the canonical table for pricing, context window, mood tier, label, sprite, palette, and colours. `npm run models:generate` emits `models.generated.js` (browser/ESM) and `models.generated.cjs` (server/CJS) from one resolver template; `npm run models:check` fails `validate:quick` on drift. `model-pricing.json` and the hand-mirrored tables in `TokenUsage.js` are gone; the server's `modelIdentity` and the browser's `getModelVisualIdentity` read the same rows, and `mythos-*` models now resolve to the Fable identity instead of falling through to Sonnet.
- `npm run models:resolve -- <provider> <model>` prints how a model resolves on both sides (pricing, context window, label, sprite, manifest entry, sheet dimensions) and exits non-zero on any disagreement; `model-registry.test.mjs` checks every row in both directions against the sprite manifest.
- The burn-rate tooltips read the pricing revision from `TokenUsage.rateRevision` instead of four hard-coded dates.

**Verification an agent can run**
- `npm run verify:render` boots an isolated server on an ephemeral port with a temporary HOME, drives `?sim=1` through World, Dashboard, selection and the Activity Panel with Playwright, and writes `world.png`, `dashboard.png`, `panel.png`, and `diagnostics.json` to a temp directory. `npm run verify:server` composes the boot, security, and fatal smokes; `npm run verify:architecture` checks layers, adapter registration, port binding, the `position: fixed` allowlist, and root-doc parity. None of them touch port 4000.
- `test:unit` is the fast loop again (~5 s): the 20-second pipeline replay moved to `npm run test:integration`, which `gate:release` runs once. A session payload contract test asserts every client-consumed field over HTTP and the WebSocket `init` frame. `CLAUDEVILLE_TEST_TMPDIR` redirects every test and smoke fixture for sandboxes that cannot write to the default temp directory.

**Skills, hooks, release tooling**
- New Claude Code skills: `add-model`, `add-provider`, `sprite-character`, `release` (manual invocation only), `verify-ui`; `verify-architecture` and `verify-server` are rewritten as routers to the scripts above and no longer assert a CORS header the server never sent or ask agents to start port 4000.
- `.claude/settings.json` hooks: a `PreToolUse` guard blocks the destructive git and process-killing commands `AGENTS.md` forbids, `PostToolUse` runs `node --check` on edited JavaScript, `SessionStart` prints the checkout status. An opt-in `ingest` mode (`CLAUDEVILLE_DOGFOOD_HOOKS=1`) forwards redacted tool lifecycle events to `/api/ingest/hook`.
- `scripts/release/prepare.mjs` validates the top changelog entry, bumps `package.json` and the top-bar version (`v<major>.<minor>`), extracts release notes, and prints the exact `gh release` command; `release:verify` runs inside `gate:release`. `scripts/agents/check-artifacts.mjs` keeps `agents/README.md` and the plan status lines in sync.

**Docs that match the code**
- `AGENTS.md`/`CLAUDE.md` shrink to ~700 words with a project map that includes skills, hooks, Codex config, the model registry, tests, and CI; release mechanics move to `CONTRIBUTING.md`. `claudeville/CLAUDE.md` keeps invariants and links owners. The provider/model runbook, the sprite runbook (`generationSize` per character, one canonical "Add One Character" procedure), the test and smoke catalogues, and `docs/README.md` are rewritten against the current tree; stale claims (a deleted minimap, a nonexistent `upstream` remote, a machine-specific path, an unlisted `/api/changelog`) are gone.

---

## v0.39.1 — *Titan Tides* · Sep 02, 2026

The harbor stops drowning in skiffs. Unpushed commits still sail, but a busy repo now sails as a fleet of titans moored at its own stretch of coast.

**Titan-class commit ships**
- A repo branch holding five or more unpushed commits no longer shows one ship per commit. The fleet consolidates into `ceil(n / 50)` balanced stack ships on a 5 / 10 / 20 / 30 / 40 / 50-class hull ladder; each hull badges its exact count (`29x` + `28x` for 57; the buoy label carries the fleet total). Two new hulls — `prop.harborShip.stack40` and `prop.harborShip.stack50` — carry the 40 and 50 tiers; the 20 tier reuses the 20–30 flagship art. Failed, rejected, cancelled, untethered, and detached-HEAD commits keep their own ship so trouble stays visible.
- Hidden pack members inherit their titan's position, so a push still launches the whole fleet from where you saw it, and the titan sails out as one hull instead of a fifty-skiff procession. Small fleets (under five) keep the lead-hull-and-skiffs look.

**Home Waters moved to the coast**
- Repo anchorages leave the harbor basin and spread along the whole east coast — ten named slots (Beacon Shoal, River Mouth, Pharos Reach, Southern Strand, North Shoal, Reed Point, Far North Sea, Wall Tower Bank, Pharos Bank, Strand Shallows) filled alternately north and south of the Harbor Master so even a few repos already line the shore.
- Each repo's commit ships now dock beside **its own buoy**: the buoy, its name-and-count label, and the fleet share one slot allocated in harbor state, so a glance answers "whose ships are those". The Commit Lagoon becomes the overflow anchorage for repos beyond the ten slots (plus the `+N` chip), and the lighthouse pulses for unpushed commits anywhere in home waters.

---

## v0.39.0.1 · Sep 02, 2026 — Hotfix

- **The FPS counter is back on the brand line.** v0.38 demoted it to a danger-only chip with the honest percentiles in Settings → Health; the maintainer wants the live number always visible next to LIVE and the version, so it is. The danger styling below 25 FPS and the Settings detail both stay.
- Corrected the v0.39.0 notes below: the cliff-reflection blackout fix is verified by the render-stage recovery observed live and the reflection bake smoke, not by the GPU lifecycle tests (those pin the unrelated suspend/resume VBO bug from v0.38).

---

## v0.39.0 — *The Chronicler's Tide* · Sep 02, 2026

Wave 4 of *The Commander's Map*: composition and depth. The village learns to remember its days, show its causes, and sit in its sea.

**The Chronicle becomes a day ledger**
- Prev / next / today controls walk the village's history; a failed read keeps your place. Forty same-minute arrivals fold into one `arrivals ×40` row — folding now groups the whole minute by kind, not just adjacent rows, so interleaved events cannot escape it. Per-project subtotals count every raw event beneath the folded view.
- New event kinds label themselves: the ledger derives its labels from the kind, so the forge events below appeared without a single ledger edit.

**The execution tree**
- A Claude session with subagents shows its real hierarchy — primary, subagents, tasks — with `3/5 children done` counts read server-side from the CLI's own task store and marked `exact`. Other providers show honest counts marked `inferred`, and a child that disappears is unknown, never silently "done". `/api/tasks` stays a loopback diagnostic; the browser never fetches it.

**The causal waterfall**
- A collapsed panel section draws the last twenty minutes as proportional bars: turns, permission waits, tools with durations and exit codes, retries, child activity. Long silences dominate the picture — a stall between two timestamp-only events is a stall row, not a stretched tool bar. Secrets in tool commands are redacted by the same rule the blocked banner uses.

**The forge speaks of pull requests**
- `gh pr create`, issue and release outcomes already sitting in transcripts become chronicle events with their real URLs, marked `inferred` — parse-only, no subprocess, no network, secrets scrubbed, bounded per project.

**The island sits in its sea**
- A quantised, palette-safe reflection of the cliff face rests on the water below the island, and the hard island/sea seam is now a stepped, dithered waterline using the same four-cell pattern as the GPU wetness shader. Both are static under reduced motion. A generated distant-shore horizon band was built, measured (0.15 parallax, seamless tiling on both render paths) — and cut on maintainer review: against the flat day sky it read as a detached skyline, and the village is better without it.

**Fixed while shipping**
- A dropped constant in the execution-tree work briefly broke six AgentManager suites; restored.
- The cliff reflection referenced an undeclared variable, blacking out the world canvas; fixed, verified by the live render-stage recovery and the reflection bake smoke. (The GPU suspend/resume lifecycle tests added in the same pass pin a different, earlier VBO bug.)
- `orderedDither4` gained direct coverage: determinism, full bucket set, GPU-formula parity, negative and large coordinates.

---

## v0.38.0 — *The Commander's Map* · Sep 02, 2026

The village told the truth about *state*; it did not yet tell the operator *why*, *how much*, or *where the light went*. This release spends on those three questions, in that order: correct money, actionable signal, and the lighting the project already paid for delivered to the renderer operators actually run.

**Money you can act on**
- **Every current Anthropic model now has a real rate.** Fable and Opus 5 sessions were silently priced at the Sonnet-class default — wrong by roughly 3x in both directions. The pricing table is now revisioned and ordered most-specific-first, verified against the first-party pricing page, including Fable 5.1's unusual $0.25/MTok cache-read rate (0.025x, where every other model uses 0.1x).
- **Provenance on every figure.** Costs carry `source` (provider-reported vs estimate), the matched rate, the table revision, and an `unknownModel` flag. Estimates print `~`; a model the table does not know shows a `default rate` badge instead of a confident number. Claude sessions prefer the CLI's own `totalCostUSD` when present.

**Signal the operator can act on**
- **The adapters stopped ignoring what the CLIs already write.** Claude transcripts now project provider cost, lines added/removed, last-turn duration, the prompt being answered, the todo list, git branch, hook errors and model/effort history. Codex rollouts now project tool durations, exit codes, changed files and approval policy — a full-auto session can no longer show a false "needs approval", and an Esc-aborted call no longer becomes a phantom blocker.
- **Every provider has a turn state.** Kimi Code, OpenCode and OMP now derive turn state through the same machinery as Claude and Codex instead of falling back to file-mtime guessing that flipped generating agents to "idle".
- **Time in state, everywhere.** "Working for 4m12s", "Waiting on you for 38s" next to every status pill, in the sidebar, the Dashboard and the panel — patched once a second with zero node creation.
- **Working set and collision advisory.** Each agent lists the files it recently read or wrote; two live agents writing the same file in one project raise an `OVERLAP` advisory on both rows. Parallel agents most dangerously *succeed incompatibly* — now you see it coming.
- **An exact permission inbox, opt-in.** `POST /api/ingest/hook` (loopback-only, in-memory only, capped, expiring) lets a one-line CLI hook stanza name a blocked prompt within half a second, with a `HOOK` provenance chip. Verified payload mappings for Claude Code, Codex CLI and Gemini CLI are documented; without hooks, nothing changes. No approve button — the terminal remains the only place to answer.
- **Identity truth.** Long-running Claude main sessions no longer degrade into `team-member`; subagents report `sub-agent` plus their kind. Grok, OpenCode, OMP and Kimi stopped re-reading history on every pass, and the git branch lookup no longer spawns synchronous processes on the hot path.

**Light that reaches the screen**
- **The quality ladder reaches FULL in seconds, not half a minute.** Boot-time texture uploads were read as sustained overload, so the WebGL2 world sat at MINIMAL (4 lights, no bloom, no occlusion) for up to 29 s. With elapsed-time budgets, rolling-median scoring and upload grace, the reference machine reaches FULL within 2 s and holds it.
- **The GPU world caught up with the Canvas one.** Building sun shadows, the haze field, cloud shadows, water shimmer, and the entire fauna and harbor layer now appear on the WebGL2 path every operator runs — previously they were drawn under the opaque GPU island and simply never seen.
- **Attention is the brightest light in the village.** Agents that need you, errored agents and quota stops each cast their own protected light pool (light budget raised 16 → 32), readable at overview zoom where nameplates are not.
- **Quieter crowds, honest labels.** Plaques hold a constant screen size instead of growing to 450 px at zoom 3; dense clusters fold routine names into the building's occupancy chip while every needs-you, errored or rate-limited agent keeps its name.
- **A leaner frame.** The GPU lane allocates nothing per frame: one vertex buffer upload, reused batches, cached light ranking, incremental texture accounting with honest resident-vs-cap diagnostics.

**The chrome as an instrument**
- **Exception-first Dashboard.** Dense project rows — status with age, provenance, model, current tool, blocker, working set, tokens, cost — with needs-you rows first, filter chips, sticky headers and one in-place expansion. The same detail is no longer rendered twice on screen.
- **Operations-first Activity Panel.** Current Tool, Tool History, Messages, Cost & Tokens, prompt and todos, and the working set come first; the village flavour collapses into an "IN THE VILLAGE" group. Mood hides when empty; bonds render only with evidence.
- **Type you can read.** A hard 10 px floor for the display face (fourteen sub-floor sizes fixed), Departure Mono at 12-13 px for data, and no inline font sizing left in the app shell.
- **Paths keep their filename.** Tool rows end with the file, not `/Users/…/shar…`; home directories never reach the DOM; full paths on hover.
- **A real Settings & Health surface.** Editable controls, a per-provider watchtower roster, storage ledger, the pricing table revision, and frame p50/p95 health — where the FPS number now lives, appearing in the top bar only when it is in trouble.
- **Keyboard-first.** `/` or `Ctrl/Cmd+K` focuses search; arrows walk the roster; Enter selects and follows; Escape unwinds. Every text token now meets 4.5:1 contrast, enforced by a smoke test, and the raw Tailwind palette is gone from the tokens.

**Fixed while shipping**
- The first-run hint and World Controls popover no longer cover the Activity Panel; the boot status line leaves once the village is live; the empty world shows one card, not two; the first toast is a framed toast.
- Layer hygiene: verified-outcome helpers moved into the domain layer; README, cache figures and plan statuses say what the code does.

---

## v0.37.0 — *The Thaw* · Sep 01, 2026

The village had frozen solid. Not the picture — that still ran at sixty frames — but the ground beneath it: the server spent ninety-three percent of its life locked inside a synchronous filesystem scan, and every request for a stylesheet, a sprite or a session queued behind it. The thaw is measurable. A static file that took 36.9 seconds to arrive now takes 0.26.

**The village was frozen, and the FPS counter never mentioned it**
- **Ninety-three percent of wall time, blocked.** Probing a 156-line stylesheet returned in 18.195 s with a TCP connect of 0.0003 s — the socket was accepted instantly and the handler simply could not run. Over 450 s of continuous sampling the server was unavailable for roughly 418 s, in stalls of 10-37 s separated by three-second windows. That, not rendering, was the 20-30 second dark screen.
- **One watchtower was reading a gigabyte every two seconds.** The `omp` adapter applied its two-minute activity cutoff *after* parsing, so every pass read 941 MB and ran 158,551 `JSON.parse` calls across all 338 historical transcripts — to surface the two that were actually active, totalling 581 KB. A control run with the threshold set to zero, where no file can possibly qualify, still read 941,756,247 bytes and returned nothing. It now stats and rejects before opening: **3,840 ms → 42 ms, 941 MB → 3.8 MB, 158,551 parses → 459**, and a threshold of zero opens no files at all.
- **This is why it got worse over time.** The cost scaled with total history rather than with activity, so every session you ever ran made the next boot slower.

**One scan, not two**
- **A cache that was born expired.** The session list was stamped with the time captured when a scan *started*, so a ten-second scan against a two-second TTL was already eight seconds stale the moment it was stored. A non-forced call issued immediately after a completed scan was measured at 9,804 ms — a full rescan. It is now stamped at completion: **the same call is 0.002 ms.**
- **Two paths that each scanned twice.** A directory event scheduled a refresh *and* a broadcast, and the thirty-second reconciliation forced a scan and then broadcast one; in both cases the second pass missed the expired cache and scanned again. A monotonic dirty generation, an in-flight guard and duration-derived backoff now produce one collection per generation.
- **Invalidation stopped being a blunt instrument.** A dirty mark naming a single provider cleared the entire all-provider list. Scoping it means one chatty provider no longer forces every adapter to rescan.
- **Codex stopped reading the same file three times.** Each active rollout was read at 50, then 500, then 5,000 lines, and growing a cached window discarded the previous read. One shared scan context now serves all three consumers: **35 opens → 9, 105 MB → 56 MB, 23 tail parses → 9** for nine rollouts. The 5,000-record git window is unchanged, so no event is lost.

**Lighter words on the wire**
- **A snapshot that was 96% duplication.** The sessions payload had grown to 859,135 bytes, of which 828,493 were git events — 974 rows carrying just 90 unique event IDs. Unique events are now sent once in a payload-level table and referenced by id, then rehydrated at the single client ingestion funnel, so all thirteen consumers still receive exactly the array they always did. **859,135 B → 149,268 B**, and 7,153 B on the wire once gzipped.
- **Responses are compressed.** JSON, JavaScript and CSS now negotiate gzip; already-compressed sprites and fonts are left alone.
- **A reload stops re-downloading the app.** No validator existed, so every load pulled all 141 modules again — at least 3.94 MB across 154 requests. Static files now carry a strong SHA-256 ETag, memoised per edit, and honour `If-None-Match`; unchanged modules return **304 with an empty body**. A content hash rather than mtime-and-size, because a same-size edit inside one filesystem tick would otherwise serve a stale module and cost someone an afternoon.
- **Boot stopped fetching everything twice.** A REST snapshot and an immediate WebSocket frame carried the same data, roughly 1.72 MB per boot. The socket is now the normal bootstrap; REST remains the fallback.

**A shorter walk to first light**
- **The village no longer waits for twenty-one strangers.** All 21 character sheets loaded before first paint regardless of who was present — 7.76 MiB across 242 requests. Boot now loads the resident cast and fetches the rest on arrival, taking a typical two-to-three agent session to roughly **1.8-2.1 MiB**. A late arrival appears a frame after its sheet lands; it never flashes placeholder art.
- **Less blocking in the head.** Dashboard, activity-panel and modal stylesheets are loaded when their surface is first shown, and `js-yaml` now loads with the manifest that needs it: **123,888 B → 50,984 B** of render-blocking CSS. Audio, the chronicle UI and the debug overlay are deferred behind dynamic imports; targeted `modulepreload` hints flatten the seven-level dependency waterfall.
- **Mode switching stays instant.** Deferring the Dashboard *module* left the panel blank for ~390 ms after a click, so it is fetched concurrently with the renderer module and joined before boot reports ready — deferred bytes, not a deferred switch.

**Frames stop paying for what you cannot see**
- **The harbour stopped rebuilding its own history.** Two thousand retained ships cost 2.21 ms mean and 4.32 ms p95 every frame to emit ten drawables. Packed frames are now cached and only representatives are enumerated: **27.765 ms → 0.006 ms** in an isolated 2,000-ship pass, with the same 84 drawables, stacks, positions and animations.
- **Overlay layout culls first.** Name and bubble placement was worst-case `O(A²)` and ran *before* viewport culling. It now culls to a 420 px apron and buckets spatially above 32 visible agents: at 100 agents, **0.161 ms → 0.029 ms mean, 0.244 ms → 0.056 ms p95**. A 200-layout randomised harness confirms identical slots, suppression and merge representatives.
- **The frame path stopped allocating.** Depth wrappers, closures, diagnostics, arrays, Maps and Sets were rebuilt every frame, and structural diagnostics were computed even with the debug overlay off: **1,778 allocations per frame → 0**. The overlay shows everything it always did when enabled.
- **A narrow idle path.** A genuinely static reduced-motion scene stops redrawing, gated on a long list of conditions — no camera movement, no transition, no weather change, no pending work. Off-screen agents still simulate in full: routing, waypoints, dwell timers, visit reservations and gate transit are load-bearing, and culling them would make agents teleport when scrolled into view. Only particle emission is skipped beyond the apron.
- **The sidebar patches instead of rebuilding.** It replaced its entire tree on every update — up to 5,520 element creations per minute with twenty agents, destroying scroll position and selection each time. A steady-state update now creates **zero nodes**, matching the dashboard cards, and preserves scroll, focus and selection.

**Honest instruments**
- **The frame counter stopped flattering itself.** Displayed FPS was a 500 ms average of animation-frame callbacks: structurally incapable of showing p95 hitches, GC pauses, long tasks or dropped frames — which is exactly how a village could feel slower while reporting sixty. Frame-time p50/p95/p99, over-budget and long-frame counters now sit alongside it, on preallocated typed-array rings that allocate nothing per frame.
- **The loudest adapter was invisible.** `omp` was the only available adapter without `getPerfStats`, so it never appeared in `/api/perf` despite being 98.42% of all parsed lines — anyone ranking cost there would have studied the small adapters and missed the culprit entirely. It now reports discovery, stats, skips, opens, bytes, parsed lines and pass duration.

**Measured after**
- Static asset worst case **36.9 s → 0.26 s**, with no multi-second stall across 100 samples.
- Event-loop delay p99 **~370 ms → 22 ms**.
- Broadcast **3,313 ms → 1 ms**; its session stage was 99.97% of that.
- Full registry scan **10,186 ms → 533 ms** cold, and 0.002 ms when cached.
- Sustained tail read rate **202 MB/s → 36 MB/s**.
- 542 unit tests and 11 smoke suites green, including the end-to-end WebSocket delta replay and the browser UI pass.

---

## v0.36.0.1 · Aug 31, 2026 — Hotfix

- **Dense villages hold the display refresh rate.** Animated agents now update only their changed albedo, material, and emissive atlas cells instead of replacing the complete packed texture. The 30-agent browser profile dropped from roughly 171 ms to 8.8 ms at the median, while the live village sustained about 65 FPS and regularly exceeded 100 FPS without shedding visual detail.
- **Atlas channel pages stay resident.** Atlas-sourced landmarks now keep one page-scoped material/emissive source identity, eliminating repeated full-page uploads and incorrect sidecar sampling at atlas UV coordinates.
- **The top bar is quieter.** Redundant alert-status segments were removed; the shared village counts and existing attention navigation remain authoritative.

---

## v0.36.0 — *The Common Clock* · Aug 31, 2026

The village stops disagreeing with itself. One vocabulary for its own state, one clock for its motion, one measurement for its cost — and celebrations it has actually earned.

**Every surface tells the same truth**
- **One attention vocabulary.** A new `SignalLedger` is the single classifier for needs-you, errors, quota, watchlist, working and quiet. `World.getStats()` previously counted errored agents separately while *excluding* them from the attention total, so the NEEDS YOU badge disagreed with the attention service about who needs a person. Errored agents now count, every legacy key is preserved, and `AttentionService.list()` keeps its longest-waiting-first traversal exactly.
- **The Dashboard stops calling paused work a failure.** The project health strip incremented the *error* counter for rate-limited and waiting-on-user agents, painting an agent awaiting your approval as a crash. Six honest buckets now sit in a stable order, the health bar matches, and the red edge flash is reserved for a genuine error.
- **Four labelled counts in the top bar.** Needs you, Errors, Quota and Watchlist each carry a text and accessible label instead of one number meaning four things. ERRORED is now reachable rather than a dead badge; `A` and NEEDS YOU behave exactly as before.
- **The World summary separates errors from quota.** It previously merged them into one figure and reported only blocked input as needing a person.

**A truthful first ten seconds**
- **`LIVE` is no longer a hardcoded lie.** The shell shipped a connected-looking chip before any server result. A readiness reducer now drives the boot line through OPENING THE VILLAGE and LISTENING FOR LOCAL SESSIONS, and `LIVE` is unreachable until a snapshot is actually fulfilled — an opened socket is not evidence that data arrived.
- **Four different empty states.** "Still syncing", "no providers found", "providers found, nothing active" and "a watchtower is unreadable" were one ambiguous message. Silence and blindness are opposite operational facts and now read differently.
- **Provider health is visible.** The registry silently skipped unavailable adapters and swallowed watch failures. Providers now report unavailable, empty, healthy or degraded, with degraded reserved for a real read or watch failure — an idle provider is calm, not an alarm.
- **A boot failure keeps the village.** It used to replace the whole document with a `BOOT FAILED` tombstone. The branded shell now survives, with short English copy and a working TRY AGAIN. No filesystem path or stack text reaches the DOM.
- **The connection chip became an instrument.** SYNCING, LIVE, POLLING, RECONNECTING with a count, and STALE with the age of the last good snapshot, plus a lazy details popover. The stale clock ticks at most once a second and only while stale.

**One clock for the whole village**
- **Motion no longer depends on your refresh rate.** Camera follow used a fixed per-frame coefficient, the water clock advanced by a constant per update despite a computed delta, and idle stride pauses were counted in update calls — so the village literally ran faster on a 120 Hz display. All three now derive from elapsed milliseconds through a shared `MotionClock`, with 60 Hz output unchanged and reduced motion freezing the clock rather than slowing it.

**Beauty that yields in the right order**
- **Pressure with a moral compass.** One attributed input governs marks, weather, particles and sky. Cost is app-owned; host gap is recorded as evidence and never as a trigger, so another process saturating your machine can no longer make the village throw away detail. The shed order is fixed and tested — ambient weather and fauna, then ambient particles, then secondary glyphs, with the post-effect ladder last. Primary marks keep unbounded limits at every rung.
- **Calm nights are actually calm.** On clear weather with nothing waiting and nothing recent, ambient meteors stop, twinkle goes sparse and ambient sparkle stops, so the next real event is perceptible. Static stars, lanterns, real weather and every attention or event cue always survive.

**Light, ground and material**
- **The sun casts a moving shadow.** A continuous sun position was already computed and then discarded for three constants, so the key light jumped at phase boundaries and contact shadows, roof glints and highlights could disagree. One continuous solar vector now feeds structural and tower shadows, roof glints, agent grounding, the GPU key-facing term and god-ray direction, preserving the authored dawn/noon/dusk calibration and the stepped palette.
- **Mist sits on the ground.** Fog was a canvas-wide gradient plus screen-space bands. A quarter-resolution haze field derived from real water, lowland and road geometry now draws in the ground stage, so mist follows the river when you pan. Alpha is hard-capped and roads and the focused subject are carved open, so silhouettes and incident marks stay legible. No blur kernel; the authored pixel edges are intact.
- **Rain leaves a material memory.** Timber and earth had authored wetness coefficients that nothing consumed. Every non-fire class now responds within bounded, stepped highlights, and a deterministic drying transition reads as weather passing. Fire and emissive runes stay warm.
- **The mine and the portal get their own windows.** Seven landmarks had calibrated window rects; these two fell back to a generic radial blob. Both now have authored sprite-local rects and an occupancy-scaled doorstep spill — no roof cutaway, no interior reveal.
- **Authored channels finally reach the GPU.** Two atlas-only agents were shaded flat because the overlay looked only for individual sidecars, terrain used a procedural class map instead of its authored semantic classes, and props got heuristics. One resolver now serves all of them, sidecar first and atlas second, and derived art is idle-scheduled so a new villager appears immediately while its channels settle in behind it.
- **Sidecar-first resolution stopped being a per-frame texture flood.** That one resolver prefers a per-landmark sidecar over the atlas, but the GPU cache key for material and emissive is scoped to the *atlas page* — so an atlas-sourced landmark bound the shared `world-pilot:channels` key with its own 256×232 companion, and the next batch rebound the same key with the 2048×2048 page. Measured in the browser: 6 full-page re-uploads per frame, 103 MB/frame, `uploadMs` 50.3 against `gpuMs` 5.4, a 53 ms frame gap, and the GPU quality ladder pinned at `disabled:uploadMs` — which shut the direct GPU world off entirely, black canvas included. The fragment shaders also sample both channels with the albedo's `v_uv`, so those companions were being read at atlas sub-rect coordinates: wrong pixels as well as ruinous bandwidth. An atlas albedo now takes that atlas's channel pages with a page-scoped revision, and the per-landmark sidecar path is untouched for individually-sourced art. After: 0 uploads/frame, `uploadMs` 0, `cpuMs` 50.7 → 0.21, `within-budget`, back to the vsync ceiling.

**Memory and honesty**
- **Incidents are findable at a glance.** Zoomed out, the Canvas path drew only the waiting beacon and returned, so a crashed agent looked identical to a busy one. Errors, quota stops and blocked prompts now carry distinct static shapes at overview zoom in both render paths, shape-primary so the encoding is not colour-only.
- **The village no longer celebrates disappearances.** Every `COMPLETED` agent raised its arms, including the ten-minute departed projection that is documented as a *presence* marker rather than a result. Only a verified commit, push, release or milestone can now produce a celebration; a vanished session settles quietly.
- **Idle proximity is no longer rendered as conversation.** Two villagers resting near the same scenic point grew a chat bubble based on nothing but status and a 30-pixel radius — no message, no affinity, no event. That machinery is deleted. Real pairwise chat is untouched, and no canned lines replace the silence.
- **The Chronicler has a reason to walk.** It traced four fixed waypoints on a timer. It now waits at the Archive and makes a bounded errand only when something real was recorded.
- **The Book of Lives is visible.** Ten biography fields persisted while the dossier showed four counters and one milestone. Bounded chronological chapters now show first and last sighting and real history, honest about what was summarised, and scoped to the session when an identity cannot be trusted to be the same person.

**Sound that ranks what it hears**
- **One priority arbiter.** Six arrivals in a moment become one intelligible answer; a summons is never queued behind thunder. Urgent cues get their space by ducking ambience rather than by getting louder, with reserved master headroom.
- **Silence has state.** After a genuinely calm interval the bed settles into perceptible rest, with hysteresis both ways, so the next summons is heard rather than habituated away. Resting is distinguishable from a stalled engine. The generative music system is deliberately untouched.

**Kept honest**
- **A local pre-push gate.** `npm run gate:release` chains the quick validation, the replay smoke, the server security and fatal smokes, and a new boot-contract smoke that starts an isolated child server on an ephemeral port with a temporary HOME and proves the HTTP routes, a WebSocket handshake and initial snapshot, a delta and a resync. Browser and visual verification remain manual; nothing under `.github/` was touched.
- **The pre-push soak gate is now meaningful.** Its WebSocket reconnect probe used a hard 5-second deadline with no retry, but a cold provider scan on a populated HOME legitimately takes longer — an A/B against v0.35.0.1 measured cold `init` at 14.5 s and 8.4 s where the warm path returns in about 100 ms. The gate therefore failed for a pre-existing reason rather than for a regression. The probe now takes a configurable per-attempt deadline with bounded retries, reports init latency and retry counts per checkpoint, and applies its real ceiling to post-warmup steady state, so one cold scan is absorbed while a server that has degraded into multi-second snapshots still fails.
- **Real defects caught by the new tests, not asserted around.** A `Number(null)` coercion let pressure recovery begin before its probe window elapsed; audio aggregation had deferred cue construction so spatial panners and per-provider council bells were momentarily absent; and a `cacheStats()` shape change broke the World-to-Dashboard release contract. All three were fixed at the source rather than worked around in a test.
- **Two defects caught only by driving the real app.** With the whole unit suite green, a populated village still announced NO PROVIDERS FOUND: the provider route gained a health summary but the browser kept reading the legacy list, so every provider normalised to unavailable. And clicking empty ground left a stale Activity Panel open, because the deselection event was published and nothing ever subscribed to it. Both are fixed, and seven cross-surface invariants now make that class of contradiction fail a test instead of reaching an operator.
- **540 unit tests pass, up from 345.** `gate:release` is green end to end.

---

## v0.35.0.1 · Aug 30, 2026 — Hotfix

- **js-yaml 4.3.0 → 4.3.1** (CVE-2026-59870, quadratic CPU in `!!omap` resolution): merged the dependabot bump and refreshed the vendored browser copy at `claudeville/vendor/js-yaml.min.js`, which the dependency bump alone does not touch. Verified in-app YAML parsing against the refreshed vendor build.

---

## v0.35.0 — *The Whetstone* · Aug 30, 2026

Codex villagers get their weapons back under the WebGL world renderer, and every blade is held the way a blade should be.

**Weapons return to the GPU world**
- **Runtime equipment is baked into the GPU sprite sheet.** The WebGL renderer samples villager bodies from a packed sheet texture, so the codex weapons composited per-frame by the Canvas path (wrench, runeblade, dawnblade, crescent saber, earthbreaker, greatswords, heavy armor) never reached the screen. Each sheet cell now bakes back-layer equipment, body, and front-layer equipment with the exact Canvas geometry, preserving behind-the-body carry on away-facing directions and full lighting/grade on the weapon.
- **Blade tips are never truncated.** Cells in the equipped sheet carry 24px of padding per side — an upright dawnblade or polearm tip reaches well past the 92px body cell — and the GPU record's UVs and on-screen quad grow to match. Material/emissive sidecars are re-laid onto the same padded grid so their channels stay aligned.
- **Late-loading weapon art swaps in.** The composed sheet keys on the asset version, so a weapon sprite arriving after a fallback-vector bake rebuilds the sheet and re-uploads the texture.

**Weapons sit right in the hand**
- **Held blades stand near-upright.** Hand-held weapon lean is softened (up to −0.38 rad down to −0.20) so long sabers read as gripped swords instead of shafts tilted across the villager's head. Applies identically to the Canvas and WebGL paths.

**Kept lean under a swarm**
- **Same-profile villagers share one equipped sheet.** Composed sheets (albedo plus padded sidecars) live in a bounded shared cache — a 20-agent audit swarm of one model costs a single ~6 MB sheet, not one per villager — and the cache empties with the other shared sprite caches on renderer release.

---

## v0.34.2 — *The Golden Cord* · Aug 26, 2026

Advisors stop wandering the village as anonymous strangers: the counsel bond between an agent and its advisor is now a visible, living relationship.

**The advisor bond is explicit**
- **Advisors are recognized as such.** An omp advisor thread (a subagent session named `__advisor`) is detected once at the domain layer and carries the pairing with the session it counsels everywhere — world tags, sidebar, inspector, and toasts all read "Advisor" instead of the raw slug.
- **A golden cord links the pair.** A solid tether in the advisor's trim colour joins advisor and advisee, with a counsel mote travelling along the curve toward the advisee. Under reduced motion the cord keeps a static midpoint bead. Advisor pairs are excluded from the faint dashed family-tether pass, so the bond never double-draws.

**Advisors keep counsel at their advisee's side**
- **Shadowed movement.** The advisor's routing intent now pins it to whatever building its advisee works at, outranking the advisor's own tool, git, alert, and token cash-out pulls; only a live conversation may briefly draw it aside. The existing related-agent slot bonus then seats the pair on adjacent tiles.
- **Ordinary subagents are untouched.** Task children keep their previous gentle join/follow behaviour and dashed family tethers; the stronger choreography is gated on the exact advisor identity.

---

## v0.34.1 — *The Namekeepers* · Aug 26, 2026

Villagers reclaim their stature and keep their names in view, from a quiet path to the busiest gathering in town.

**Villagers stand at village scale**
- **Agent sprites are 32% larger.** The authored characters, equipment, silhouettes, and interaction bounds now hold their own beside the village's newer hero-scale landmarks without changing movement or world geometry.
- **Selection stays true to the visible body.** Hit targets grow with the character art, so the larger villagers remain natural to hover and select.

**Every villager keeps their name**
- **Names remain visible at every zoom and crowd density.** Overview and compact render modes use readable compact nameplates instead of status-only glyphs, and dense clusters no longer fade routine labels toward invisibility.
- **Buildings no longer absorb identity.** Agents working at a landmark keep their own nameplate rather than disappearing into a building tally at low zoom.
- **Crowds degrade by overlap, never anonymity.** Label placement still searches for a clear slot; when a cluster exhausts every clean position, the least-overlapped slot is used instead of suppressing the name.

**Checked in the crowded square**
- **Both render paths retain identity.** Canvas fallback and the default GPU overlay share the persistent-name behavior, including compact and minimal annotation modes.
- **Dense-scene verification stays clean.** The deterministic 24-agent label-density scene keeps every name present with no browser warnings or frame errors, and focused salience, sprite-overlay, and dialogue-layout checks pass.
- **The release gate survives a new day.** Chronicle export fixtures now derive today and yesterday from the local calendar instead of expiring after their authored date.

---

## v0.34.0.1 · Aug 25, 2026 — Hotfix

- **Only a real question is held open.** The speech hold introduced in v0.34.0 also matched the plain `waiting` status, which is assigned to any session whose file has merely been quiet for 30 seconds to two minutes. An agent that simply paused could therefore re-surface arbitrarily old prose. The hold is now limited to `waiting_on_user`, the status reserved for an actual question or blocked input; every other state keeps the normal 90-second ceiling.

---

## v0.34.0 — *True Voices* · Aug 25, 2026

Villagers stop reciting written-for-them lines and start saying what the models actually wrote. Around that, the world gains authored lighting that survives the GPU path, native art for every landmark, villagers who keep their faces between restarts, and a backend that stays bounded under load.

**Villagers speak for themselves**
- **Every bubble is the model's own text.** Speech is extracted from Claude, Codex, OMP, Grok, OpenCode, Gemini, and Kimi sessions and carries its origin, authorship, and fidelity. The handwritten intent and lore phrase pools are gone, along with the 24-character cap that reduced real sentences to fragments.
- **Nothing is invented to fill a silence.** With no attributable line, the villager says nothing and status stays legible through glyphs, rings, and the long-wait clock. Reasoning renders as a tailless chip rather than a quote, because an excerpt of a long thought is not something the model said.
- **Speech expires the way the work does.** A working villager's line fades on the normal window, a finished agent's parting summary fades sooner, and an agent blocked on you keeps its question until you answer it — flagged as awaiting a reply so an old question is never passed off as something just said.
- **Extraction is sanitized and gateable.** Secrets, keys, emails, and bidi controls are stripped and home paths rewritten before text ever reaches the browser. `CLAUDEVILLE_DIALOGUE_SOURCES` limits which kinds are read at all, and withheld sources are never serialized.
- **The selected villager keeps a narration log.** Twenty entries over five minutes, each with its untrimmed text and exact source, so a bubble that scrolled past is still readable.

**Light behaves the way it was authored**
- **Authored light colour survives the GPU path.** Forge, lighthouse, portal-rune, and lantern lights keep their RGB instead of collapsing to one warm default, and light identity and priority are retained for culling.
- **Emissive and occluder channels are no longer guessed.** Authored emissive RGBA reaches the GPU texture directly rather than being reconstructed from albedo, and occluder height and strength stay distinct through the shadow trace.
- **Every provider gets its real material.** GPU agent overlays read the shared provider material table and packed companion channels, so Gemini, DeepSeek, and unknown providers no longer inherit a metal-or-fabric guess. District light steps through defined bands instead of sliding.
- **Local weather stays local.** District trouble below a fifth of the scale no longer fogs the whole village; ground haze and lighting bias composite per district over either renderer.

**A village built from native art**
- **All nine landmarks are native sprites.** Archive, Task Board, Forge, Mine, and Observatory are regenerated as structure-only art, retiring the last five hand-drawn mask cutouts. The Observatory becomes grey stone under a blue-slate dome with a brass telescope; the Harbor becomes a steampunk Harbor Masters Guild of stacked timber and stone, copper machinery, catwalks, and a clockwork loading crane.
- **Material coverage reaches the whole roster.** Companion material, emissive, and occluder channels cover the remaining provider and terrain identities, and landmark glow stays restrained enough that daylight never turns a window into a disc.
- **Atlas baking fails before the runtime can.** An oversized page is rejected up front with its required size, limit, overage, and offending frame, and channel tooling reads one registry so adding a channel is a contract edit.

**Villagers you recognise**
- **Faces and names persist.** Appearance and generated names derive from a stable biography identity rather than a session id, so a returning villager looks like itself.
- **Departures linger honestly.** A vanished session stays ten minutes as an explicitly departed villager — static, dimmed, non-emissive, with a `DEPARTED` plaque — then evicts oldest-first, reclaiming its identity if it comes back.
- **Sol paladins carry their blades again.** The Codex dawnblade was drawn behind its own body in every direction, hiding roughly two thirds of the weapon and leaving authored empty hands gripping air. It is now held in view, and tucks behind the body only when the villager faces away.
- **Mood reflects pressure.** Context pressure and long waits feed anxiety, and model-tier pacing varies only slightly so urgency stays the louder signal.

**An operator surface that answers**
- **Sound locates itself.** Cues pan to the agent's real screen position, eight providers get distinct voicings, council bells scale with team size, and captions carry cue identity even with audio off. A hidden-tab summons briefly resumes the audio context and re-suspends.
- **Search, spend, and export do their jobs.** Search indexes tool names, touched paths, and commit messages without detail-fetch storms; the Spend Map rolls costs up by project and provider; Chronicle exports injection-safe Markdown and CSV.
- **Keyboard parity across both modes.** Dashboard gains roving card traversal, Enter/Space activation, Escape deselection, and a jump to the longest-waiting agent, with focus preserved through live reordering.
- **One place for settings.** A SET chip centralizes sound, volume, audio mode, the five-channel mix, auto-camera, desktop alerts, and sidebar state, with reset to defaults and no change to stored formats.
- **Fixes to shipped behaviour.** CSV neutralization catches dangerous prefixes after whitespace and quotes tabs; Markdown export neutralizes links, images, and raw HTML; BGM mode forwards its full payload again; attention and caption announcements collapse into one; date selection commits only after a successful read; popovers scope focus and Escape correctly.

**Bounded backend, continuous checks**
- **Git enrichment can no longer stall a poll.** Enrichment runs as a stale-while-revalidate worker with two concurrent jobs, a shedding queue, request coalescing, a command timeout, an output cap, and retry backoff. Cached state serves immediately and failures keep last-good data.
- **Cache-token accounting is shared.** One normalization path covers all seven providers while preserving each one's quirks, and `/api/perf` now reports process errors and Git-worker telemetry.
- **The pipeline is exercised, not assumed.** CI runs `validate:quick` on push and pull request, and an end-to-end replay drives real adapters through a real server and a raw WebSocket client, reconstructing JSON-Patch deltas and checking the full-snapshot floor.
- **Lifecycle records stop inventing history.** The Chronicle upgrade handles blocked connections with a visible degraded state, departures log as departures instead of false completions, departed agents stop accruing affinity, and the unattended digest reports only still-unresolved state.
- **A crash that only a browser could catch.** A missing bubble-height constant made the world renderer throw every frame and pause itself to a black canvas; the constant is restored and geometry tests now execute the draw path. The release closes with 345 passing checks, 0 frame failures, and 120 fps in both World and Dashboard.

---

## v0.33.3 — *The Returning Tide* · Aug 23, 2026

Commit fleets are visible in World mode again. The default WebGL renderer now carries Canvas-only harbor traffic onto the transparent world overlay instead of covering it with the opaque GPU scene.

**The fleet returns**
- **Unpushed commits are ships again.** Commit boats, packed fleets, repository flags, mooring marks, and harbor cargo labels render above the GPU-resident village while keeping their existing world positions and motion.
- **Push celebrations survive the compositor.** Harbor finale effects now use the same visible overlay whenever a GPU frame succeeds, so the journey from waiting commits to a shipped convoy remains complete.

**The renderer keeps its fast path**
- **Only the missing Canvas category is replayed.** Buildings, props, and agents stay on the GPU path; the overlay selectively draws harbor traffic without duplicating the rest of the village.
- **The fallback remains unchanged.** Canvas mode still uses its original depth-sorted pass, while focused tests cover selective GPU-overlay replay and the full 151-test quick validation remains green.

---

## v0.33.2 — *The Lettercarvers* · Aug 23, 2026

In-world text stays sharp on every display. The world canvas now picks its resolution from the physical pixel grid instead of a flat cap, so the browser can only ever scale the village by a whole number.

**Readable at any display scale**
- **The world renders at native device resolution.** The backing store was previously capped at CSS resolution, so on a Retina display every name plate, building plaque, and speech bubble was drawn at half resolution and stretched back up. Retina desktops now draw the village at full device resolution.
- **The canvas never lands between pixels again.** Large viewports used to fall to a fractional resolution and were then rescaled by a non-integer factor with nearest-neighbour filtering, which shredded the 1px strokes of the pixel fonts. Resolution is now always the device ratio divided by a whole number, so one canvas pixel covers an exact block of screen pixels; oversized viewports get chunkier, never smeared.
- **Browser zoom and mixed-DPI displays are handled.** Zoom tiers snap to whole backing pixels at fractional device ratios, and moving the window between a laptop panel and an external monitor now rebinds the canvas instead of leaving it scaled by the old ratio.

**Sharpness where it counts**
- **Annotations no longer thin out just because the display is sharp.** Agent render tiers and the fast sky, atmosphere, and prop paths measure the scene in layout pixels; a Retina canvas is no longer mistaken for a four-times-busier village.
- **Pixel budgets are spent deliberately.** One per-surface ceiling drives the whole ladder: laptop and 1440p-class viewports run native, 5K/6K viewports step down one whole rung, and the smooth sky caches stay at layout resolution because gradients gain nothing from four times the pixels.
- **Context loss no longer strands the water mask.** The PostFX mask is released with the other volatile surfaces and rebuilt on the next frame.

---

## v0.33.1 — *Quickened Glass* · Aug 21, 2026

World mode now reaches its fast steady state without trading away the Glasswrights renderer, while daylight lighting and animated water remain visually stable throughout GPU warm-up.

**A faster first watch**
- **GPU warm-up starts lean and restores the full scene quickly.** New contexts begin on the minimal effects rung, skip clear-weather work that cannot affect the frame, avoid unused daylight emission/bloom targets, and recover through the quality ladder once shader and texture uploads settle.
- **Local-light shading costs less after dusk.** The occlusion trace keeps its stepped pixel-shadow character with three samples instead of five, reducing the most expensive repeated texture work without flattening night lighting.

**Sunlight behaves like sunlight**
- **Point-light halos now answer to ambient darkness.** Broad daylight suppresses lighthouse, harbor, building, and lantern floodlight halos across direct GPU, flattened PostFX, and Canvas paths while authored glowing windows, runes, and fire pixels remain identifiable.

**One village, one composition path**
- **Adaptive recovery no longer flickers boats or water features.** Even at the lowest quality rung, the direct GPU scene remains resident while optional effects recover in place, so Canvas-only fauna and water layers cannot blink through between frames.
- **Release checks cover the regression.** Day/night browser captures, forced quality recovery, World/Dashboard switching, agent selection, 142 unit tests, sprite audits, and building/terrain validators all pass without console or frame errors.

---

## v0.33.0 — *The Glasswrights* · Aug 21, 2026

World mode becomes a semantic, GPU-resident pixel diorama: the village now knows which agents matter, which surfaces receive weather and light, and when visual detail should yield to operator clarity.

**A world with material memory**
- **WebGL2 now renders the village directly.** Terrain, landmarks, props, and animated agent frames stay in GPU-managed textures instead of uploading one flattened Canvas frame every render. The complete Canvas path remains available with `?renderer=canvas`, and `?postfx=0` still provides the allocation-free escape hatch.
- **Nine landmarks gained authored material contracts.** Stone, timber, metal, water, foliage, fabric, cobble, glass/runes, and fire respond differently to phase light, rain, fog, reflections, local occlusion, and quantized sun bands. Emissive windows, runes, forge fire, lanterns, and the lighthouse now bloom from named masks—and stay restrained in broad daylight.
- **Deterministic atlas tooling ships with the renderer.** A reviewed 18-asset, 209-frame pilot includes byte-stable albedo/material/emissive/occluder atlases, manifest validation, channel contact sheets, mask-fix tooling, and safe defaults for assets without companions.

**The crowd speaks more clearly**
- **One salience governor now owns the scene.** Needs-you, error, selection, recent events, working detail, and ambience share collision and occupancy budgets. Primary cues never disappear; routine particles, plaques, labels, and tool text quiet down before the village art does.
- **Names and thoughts have a stable grammar.** Agent identity stays below the feet, thoughts and current actions stay above the head, and both participate in one collision plane. GPU animation uses complete source silhouettes so movement no longer drops body or equipment pixels.
- **Claude and Codex share five readable action poses.** Read, work, think, talk, and celebrate add small modular pixel gestures without changing simulation cadence, and reduced motion keeps a complete static version of every cue.

**Triage before transcript**
- **Dashboard cards default to compact dossiers.** A cross-project queue orders Needs You, errors/rate limits, high burn, working sessions, and quiet agents; full tool/message history expands only for the selected card.
- **Inspection preserves orientation.** World selection saves the overview pose, composes against the detail panel, and restores the camera unless the operator moved it manually. A compact controls popover documents navigation and replay commands.

**Built to degrade cleanly**
- **Historical routes no longer web over the village.** Hour-long movement history stays recorded for diagnostics but is not painted across the overview; only a short, restrained recent route survives for the selected or action-needed agent.
- **Renderer budgets now name every owner.** Upload, shader, frame-gap, texture, attachment, buffer, Canvas, atlas, and trail diagnostics feed a hysteretic quality ladder. Context loss, Dashboard suspension, visibility changes, and resume release and rebuild resources without stale-context warnings.
- **Release evidence is reproducible.** Deterministic World scenarios, hardware metadata, overlay censuses, performance scripts, and 20 approved day/night visual baselines cover the new pipeline. The final suite passes 141 unit tests plus building, terrain, sprite, material-channel, and visual-diff gates.

---

## v0.32.0.1 · Aug 21, 2026 — Hotfix

GPU light glows no longer render as bright daylight discs (seen over the market stall and torches around Command), and the baked lantern posts got their night halos back.

- **The disc was a falloff bug, not a gating one.** The glow shader's hard 0.35-radius core drew a solid ball where the Canvas-2D pass draws a cached radial gradient (0.5 alpha core mixed toward white, 0.25 at a third of the radius, fading to the rim). The shader now reproduces that exact gradient, at the 2D pass's `0.14 × lightBoost²` strength envelope.
- **Day visibility preserved where the 2D path has it.** The ambient stamp pass is *not* night-gated in 2D — transient semantic lights (arrivals, rituals, relationship cues) and faint building glows keep their daylight presence instead of being suppressed wholesale.
- **Lantern posts glow at night again.** The baked lantern/brazier prop halos come from a separate, night-gated 2D pass (`_drawLanternGlows`) whose sources were never in the light feed — the GPU path had dropped them. They are now fed as flagged lights carrying the lantern night factor (`0.42 × nightFactor`, dusk-onward only).

---

## v0.32.0 — *Lanternfire* · Aug 21, 2026

World mode gains a hybrid GPU pipeline: the Canvas-2D village stays the source of truth while a new WebGL2 post-processing stage grades, glows, and blooms the finished frame — and steps aside automatically the moment it cannot earn its keep.

**The village learns to glow**
- **Night belongs to the lanterns.** Building windows, watchfires, braziers, the forge, and the lighthouse beacon now bloom into nearby roads and harbor water through a GPU bright-pass and Kawase blur, driven by the same light registry the 2D renderer already keeps.
- **The atmosphere grade moved to the GPU.** When the post stage is active it owns the day/night grade and edge vignette from the same atmosphere inputs; the classic 2D multiply grade remains byte-for-byte intact as the fallback path.
- **Water bends the light.** Harbor and shoreline tiles get flow-aware displacement and a faint reflection hint, masked by a quarter-resolution water mask that rebuilds only when the camera moves.
- **Weather, rays, and pulses.** Dawn/dusk god rays, forge heat haze, incident chromatic pulses, and a low-amplitude film grain round out the pass — every animated term honors the motion budget and freezes under reduced motion.

**Text never gets graded**
- **A third canvas carries the UI.** Labels, bubbles, primary marks, weather foreground, screen particles, cinematic letterbox, and the debug overlay now draw on a dedicated overlay canvas above the GL output, so post-processing can never distort a letter.

**It degrades before it drops frames**
- **A hysteretic effects ladder.** Sustained over-budget frames shed god rays and reflections first, then collapse to grade-plus-glows, then hand the whole frame back to Canvas-2D — the scene itself is never half-rated or half-resolved. Healthy frames probe back up slowly.
- **Stalls cannot hide.** The ladder watches instrumented upload/CPU/GPU timings *and* the raw gap between frames, so driver-side stalls that dodge the timers still trigger fallback.
- **Escape hatches.** `?postfx=0` skips the GPU path (and its allocations) entirely; Shift-D shows live post-FX level, timings, and texture bytes; WebGL2 absence or context loss falls back instantly with no visual regression from v0.31.

---

## v0.31.0.1 · Aug 20, 2026 — Hotfix

World mode now renders through an opaque canvas, sparing the desktop compositor per-frame alpha blending of the whole village layer.

- **The canvas declares itself opaque.** The sky pass already repaints the full viewport every frame, so the World canvas backing store is created with `alpha: false`; the browser compositor can skip blending the layer against the page. Measured on a busy 240 Hz desktop, worst-case frame pacing tightened from 21 ms to 16.8 ms with no visual change.

---

## v0.31.0 — *The Taskboard* · Aug 12, 2026

ClaudeVille now follows Oh My Pi orchestration as a first-class provider, keeping the parent session, nested agents, lineage, conversation, tool activity, and usage visible in the same village watch.

**The whole party stays in view**
- **OMP has a proper adapter.** ClaudeVille reads OMP's local session transcripts without modifying them and discovers both orchestration parents and nested agent runs.
- **Lineage survives the handoff.** Parent-child links, agent names, model identities, and underlying providers remain attached as nested work moves through the village.
- **Details carry the work.** Session detail views now include OMP messages, tool history, response usage, and token totals instead of reducing an orchestrated run to a single process row.

**A new house on the map**
- **The taskboard welcomes OMP.** Provider labels, badges, hues, arrival cues, agent prefixes, and home-building placement all recognize OMP sessions consistently.
- **The watch stays local and read-only.** OMP data comes from `~/.omp/agent/sessions/`; the server watches transcript changes and never writes to provider state.

**Pressure you can verify**
- **The release gate is green.** Dedicated OMP adapter coverage passes alongside the full 101-test dependency-free unit suite, syntax checks, live API detail checks, and a browser dashboard smoke test.

---

## v0.30.0 — *The Quartermaster* · Jul 28, 2026

ClaudeVille now keeps substantially more headroom during long watches. Session readers reuse bounded work, World releases its heavyweight resources while Dashboard is active, and the keep's controls communicate their state in one compact glance.

**The village carries less**
- **Dashboard truly puts World to sleep.** Switching modes releases the World canvas, decoded sprites, hit masks, outlines, composited agent sheets, and volatile caches, then restores them before animation resumes.
- **Trails remember the journey, not every footfall.** Paths now follow visible sprite movement, suppress stationary duplicates, compact older samples, and enforce bounded hydration and rendering.

**Session watching stays warm**
- **Provider readers reuse bounded work.** Claude transcript tails are projected once, while Gemini, Grok, Kimi, and OpenCode use capped caches and active-first or resumable discovery paths instead of repeatedly sweeping full histories.
- **Git stays quiet until something changes.** Ref-aware signatures, longer-lived caches, scoped invalidation, and coalesced watcher events make unchanged warm refreshes zero-command while retaining nested-ref detection.

**Long-running state has firm edges**
- **History cannot grow without limit.** Chronicle reads are paginated, agent signatures stay compact, biography and affinity memories are capped, and superseded WebSocket snapshots are released promptly.
- **Background work respects ownership.** Desktop notifications close cleanly, delayed modal reads cannot replace newer content, and hidden activity panels stop unnecessary timer work.

**Four controls, one glance**
- **Log → Alerts → Sound → Cinema.** The topbar's text controls are now a scroll, town bell, minstrel notes, and scrying eye. Inactive toggles recede into warm gray; active controls catch the keep's torchlight.

**Pressure you can verify**
- **Runtime health is measurable.** Diagnostics now report watcher, parsing, Git, trail, canvas, and asset pressure, backed by stricter watcher checks and warm-up-aware soak gates.
- **The regression floor is broader.** Oversized transcripts, deep provider indexes, nested Git refs, bounded trails, mode suspension, lifecycle ownership, and quota body limits all have focused coverage.

The release gate covers 100 dependency-free unit tests, 250 World–Dashboard transitions, bounded oversized-transcript and trail fixtures, zero-command unchanged Git refreshes, and a fresh-code 10-minute browser/30-minute server soak with no frame failures, no retained Dashboard World surfaces, browser heap inside its growth gate, and negative server-RSS slopes.

---

## v0.29.0.2 · Jul 27, 2026 — Hotfix

Agents now stay on the landmark bridge's center deck and complete crowded crossings without being redirected or pushed backward.

- **The crossing matches the art.** Only the authored center deck is walkable; decorative side spans, rails, lanterns, and water remain outside the traversal grid.
- **Completed agents keep their destination.** Ambient routes are no longer discarded and rebuilt every frame when a completed or idle status has no new destination.
- **Opposing traffic keeps moving.** Bridge lanes follow the crossing's authored direction, ignore non-walkable spans, and preserve forward progress while agents separate.

---

## v0.29.0.1 · Jul 27, 2026 — Hotfix

Agents now keep making forward progress through crowded roads and building approaches instead of turning back and forth around the same few pixels.

- **Crowd steering cannot undo a step.** Lane discipline and collision separation retain their useful sideways motion, but corrections that would push an agent farther from its current waypoint are constrained so slowed or congested villagers cannot be held in place indefinitely.
- **The failure stays fixed.** Focused regression coverage reproduces a slow walker facing a stronger reverse correction and proves it still reaches the waypoint.

---

## v0.29.0 — *The Wardens* · Jul 26, 2026

ClaudeVille now guards its private local data, keeps session history truthful across failures and reloads, and stays bounded through long-running work and heavy weather.

**The gate is local again**
- **Private data stays on the machine.** The server now binds explicitly to IPv4 loopback, rejects non-local hosts and cross-origin browser requests, and exposes WebSockets only on the validated same-origin `/ws` path. Malformed, unmasked, fragmented, or oversized frames are closed cleanly instead of being accepted by the hand-written protocol layer.

**The village does not rewrite its own history**
- **Transient failures no longer empty the town.** A failed provider poll is distinct from a successful empty result, so brief read or network failures preserve the current village. Agent details, usage panels, and Dashboard footers clear at identity boundaries instead of showing another agent's stale data.
- **Reloads are idempotent.** Biography pushes, meetings, messages, shared Git events, moods, Chronicle entries, and spend totals now retain compact bounded identities or watermarks. Reloading the same evidence cannot inflate milestones, relationships, streaks, or the day book, and shutdown waits for pending Chronicle and spend writes before closing storage.

**Every authored route leads somewhere**
- **World visits use real capacity.** All 83 base and overflow visit slots are unique, walkable, and reachable from the gate. Blocked targets can fall back only to an adjacent tile, so agents no longer report success while stopping several tiles away.

**Less repeated work**
- **Live transcripts stay warm.** Claude and Codex reuse parsed JSONL tails and parse safe appends incrementally. Claude's historical subagent scan now rechecks active children without restatting thousands of cold transcripts every broadcast, cutting measured warm collection from roughly 95–154 ms to 25–38 ms on the release workstation.
- **Rain keeps its character without taking the frame.** Rain, water, fog, puddle, and reflection work is bounded and profiled only when requested. Paired release runs kept heavy rain within 28.6% of clear weather at 25 agents and 21.4% at 50, with zero frame failures.

**Controls that work the way they look**
- **Keyboard and screen-reader paths are complete.** Sidebar agents, parent links, Dashboard selection, modal focus, and toast announcements now use native non-nested controls and explicit state. Gemini and appearance/team changes also resolve to the same avatar identity in World and Dashboard.

The release gate passed 73 dependency-free unit tests, a 250-switch browser lifecycle run, security and API probes, all sprite and World validators, a zero-vulnerability dependency audit, and a 60-second live soak with stable listener, watcher, canvas, cache, heap, and RSS bounds.

---

## v0.28.1 — *Chisel & Grain* · Jul 25, 2026

A pass over the places where the pixel village was quietly drawing itself in vectors — smooth curves, resampled lettering, and authored art that never reached the screen.

**The gate says its own name again**
- **CLAUDEVILLE is legible.** The town's name was baked into the gate sprite at a five-pixel cap height and then sheared onto the isometric axis along with the masonry, which reduced it to "ELAUDEVIL.E". Stone survives being resampled; letterforms do not. The band is now empty in the art and the name is drawn live into it, sheared to sit in the band while every glyph stem stays on a whole pixel column. Sharp at every zoom, day and night.

**Water is one body again**
- **The checkerboard is actually gone.** Depth shading covered only the lower half of each tile with a hard seam across the middle, which tiles into precisely the light/dark checkerboard the last overhaul removed from the depth *classification*. Shading now covers the whole tile and follows the shore distance already computed for each body of water, so lagoon, river and sea grade from rim to centre as coherent masses.

**Art that was already made now shows up**
- **Monuments are the sprites they were drawn as.** Every one of the village's monuments was rendering as stacked antialiased ellipses — smooth grey discs in a world of hard pixel steps — because the asset manager was never handed to the monument layer. The four authored cairn, stele, obelisk and founding-stone sprites now draw, and major monuments get their quiet mote trickle.

**The wall stops looking sketched**
- **Ivy and shrubs are pixels, not strokes.** The trailing ivy was a soft two-pixel polyline and the shrubs were ellipses; both read as marker scribbles against hard-edged planks. They are now stepped forms with a direction of light.
- **Torches burn in steps.** Flames were two sharp vector triangles; they now taper in stacked rows around a lit core.
- **The footing meets the ground.** Where the stone footing tumbles out it drew four flat grey squares outlined on all four sides, with no shading and no contact — UI boxes sitting on the sand. They now carry the same lit-edge and shadow treatment as the course above, with contact shadows and a slight stagger.

**One hand drawing the whole village**
- **Shared pixel primitives.** Flames were implemented four separate times — gate brazier, wall torch, command watchfire, watchtower beacon — each as filled triangles or quadratic curves that read as paper cutouts. They now share one stepped-row flame with a lit core, and the beacon brazier is a pixel bowl rather than an outlined vector ellipse.
- **Water tiles meet exactly.** The depth tint is rasterised with the exactly-tiling isometric scanline decomposition instead of a path fill, so translucent per-tile shading leaves neither a hairline between tiles nor a doubled dark lattice where they overlap.

**Ground that does not repeat**
- **Interior terrain varies.** The tileset holds one source cell per edge pattern, so every fully-interior tile drew the identical image and a field of dirt or grass read as a stamped repeat at tile frequency. Interior tiles now mirror horizontally on a per-tile hash — free variety, no new art, and the light direction is preserved.

**A coastline with courses**
- **The island edge is layered.** The sand lip and the cliff face below it were smooth vertical gradients, the one thing a pixel coastline cannot be. Both are now quantised into discrete courses, same silhouette and colours, in the same idiom as the rock above them.
- **The reef falls away.** Where a basin drops from shallow to deep the base art changes at a tile boundary, so the edge read as a hard staircase however smoothly the depth graded over it. Deep water bordering shallows now carries an inset darker rim, so the step reads as a shelf.

**Two artefacts, found by bisecting the render passes**
- **No more ruled lines across open water.** Long, perfectly straight pale streaks crossed the open sea. The shoreline foam mask counted neighbours *outside* the map as land, so every water tile along the edge of the tile array grew a coastline — foam drawn along a boundary that is an artefact of the array, not a feature of the world. Twenty-nine percent of all foam was spurious; the genuine coastlines keep theirs.
- **The sun stays in the sky.** The sun is drawn twice: once into the backdrop behind the world, and again in the canopy pass that deliberately composites over the village so aurora and shooting stars are not hidden behind it. That is right for the sun's glow and rays, which are additive and read as glare — and wrong for its body, which is opaque and was being stamped onto whatever lay beneath it, most obviously as a disc sitting on the ocean at close zoom. The canopy now carries only the glare; the backdrop still draws the full stepped disc, so the sun is crisp wherever sky is actually visible.

All of the added detail bakes once into the existing prop and terrain caches rather than running per frame; monuments got cheaper, not dearer, by moving from vector paths to sprite blits. Measured on the deterministic world benchmark: 48 FPS median at 10 agents and 40 at 25, at or above the v0.27 reference of 46 and 40, with zero frame failures.

---

## v0.28.0 — *Bell & Ledger* · Jul 25, 2026

The village can finally tell the difference between an agent that is thinking, one that is blocked on you, and one that has finished. It stops evicting the agents that need you, rings a bell you can hear from another window, keeps a day book of everything that happened, and tells you the truth about what you are spending.

**The town knows what your agents are actually doing**
- **Turn state read from the transcript.** Status came from a stopwatch on file modification time plus two hard-coded tool names, so "thinking", "blocked on you", and "finished" all looked the same after thirty seconds of quiet. ClaudeVille now reads the real signal: a closed turn means the next move is yours, and an unanswered tool call means a tool is pending.
- **Permission prompts are recognised.** A pending tool is judged blocked or merely slow from the session's permission mode, the tool's class, and how long it has been sitting — fifteen seconds for tools that are normally instant, four minutes for Bash and friends, immediately for a direct question. A long build is no longer mistaken for something that needs you.
- **Completed is a real status.** The soft-gold "completed" state has existed everywhere since v0.26 and nothing had ever produced it. Finished turns now light it up, in the world and on the dashboard.
- **Blocked agents say what they are blocked on.** "Waiting for approval — Bash" instead of a generic "Waiting for you", in both the dashboard card and the activity panel.

**Nobody vanishes while you are away**
- **Sessions that stop to ask stay in the village.** A session used to leave two minutes after its file went quiet — which is exactly when it finished a turn or stopped on a permission prompt. Those two states now stay resident for up to 45 minutes, capped, and are re-judged as their wait lengthens. Sessions that vanish mid-work still leave, as before.
- **Watching costs no more than it did.** Discovery, project tracking, and the file watchers all still run on the original two-minute window; only what reaches the browser holds residents.

**A bell you can hear from another window**
- **The tab tells you.** A count in the title and a marked favicon, so the village can reach you from a background tab on the other monitor.
- **A summons cue.** Needing a person finally has its own sound — a rising two-note call, distinct from the storm and distress cues, rate-limited like every other cue.
- **Alerts that lead somewhere.** The ATTN chip is now a button and `A` cycles waiting agents; both select and follow, so noticing and looking are one step. An optional ALERTS toggle adds desktop notifications, asked for by you and only fired while the tab is hidden.

**The Village Chronicle**
- **A day book you can read.** Arrivals and departures, waits and how long they lasted, finished turns, errors, rate limits, commits and pushes, all recorded to a readable ledger and timeline. Look away for forty minutes and the town can now tell you what you missed.
- **Told in the town's voice.** Commit subjects are dug out of the shell text agents actually ran and capped to one readable line; the two records git enrichment produces for a single commit collapse into one; repository watchers no longer "arrive"; and reloading the tab no longer re-announces the whole town. The recap opens from the LOG button in the topbar.

**Numbers that mean something**
- **Today, not lifetime.** The topbar's biggest number was the summed lifetime cost of whatever sessions were on screen; it lurched whenever one appeared or aged out. It is now the tokens observed today, banked from real growth and persisted across reloads.
- **Cache reads counted separately.** They are the same prompt re-read every turn and they dominated the total — the first cut of the burn rate read 486M tokens per hour. New tokens carry the headline; cache reads are priced into the day's accounting where they belong.
- **Quota headroom at a glance.** Two small gauges on the brand line show the 5-hour and 7-day windows and turn red near the ceiling. On a subscription that is the resource that actually runs out, so the dollar figure moved into the Chronicle and is labelled for what it is.
- **Alerts can no longer be crowded out.** When the topbar runs short of room the spend ledger yields first; the errored and attention badges always survive.

**Under the hood**
- **A test floor for the signal layer.** 44 `node:test` cases now cover turn-state derivation, pending-tool classification, status priority, residency, the day book, and the spend ledger — no dependency, no build step, wired into `npm run validate:quick`. They caught two real bugs while being written.

---

## v0.27.0 — *Fleetfoot Keep* · Jul 23, 2026

ClaudeVille now stays markedly smoother through crowded workdays and heavy rain without thinning the village, disabling weather, or lowering sprite quality. Repeated canvas work is reused where its pixels are identical, semantic crowd updates move off the per-frame path, and a deterministic benchmark makes World performance reproducible instead of anecdotal.

**Storms spend less paint**
- **Weather washes are reused.** The vertically varying overcast and fog grades render once into a one-pixel strip and stretch across the viewport, while live rain streaks, splashes, ripples, lightning, and moving fog keep their full animation.
- **Trails fit their actual footprint.** Persisted paths cache only the cropped area containing visible trail points instead of allocating a full transparent viewport canvas, with pixel-identical output.
- **Static atmosphere work stays static.** Immutable atmosphere asset descriptors and quieter frame bookkeeping remove repeated allocations without changing draw order or scene composition.

**Crowds share the work**
- **Equipment is rasterized once.** A bounded, scale-aware cache reuses pixel-identical Codex equipment layers across crowded scenes while arrival, archive, hand, and procedural weapon animation remains live.
- **One crowd snapshot serves the frame.** Building occupancy, visit allocation, relationship reconciliation, and team plaza preferences reuse shared agent state on their existing semantic cadence instead of rebuilding it for every landmark or frame.
- **Unchanged rosters stay quiet.** Identical two-second session snapshots refresh in-memory activity age without broadcasting full agent updates; minute-level age changes still reach the Dashboard and sidebar.

**Performance you can reproduce**
- **Deterministic World scenarios.** New 1, 10, 25, and 50-agent fixtures pin the camera, date, weather, render mode, and device scale for comparable clear and heavy-rain runs.
- **FPS and frame costs are recorded together.** The benchmark reports app FPS, raw animation-frame percentiles, slow frames, frame failures, host load, and optional update/render segment profiles while counterbalancing run order.
- **Stable-load release reference.** On the release workstation at 1600×1000 and DPR 1, median clear-weather FPS measured 60, 46, 40, and 33 for 1, 10, 25, and 50 working agents; heavy rain measured 29, 27, 24, and 22, with zero frame failures across all 24 runs.

---

## v0.26.2 · Jul 22, 2026 — Hotfix

ClaudeVille's pixel art now stays clean at every resting World zoom, including when the browser is displayed below 100%. Common 1080p layouts also render at native canvas resolution instead of passing through avoidable fractional resampling.

**Crisp at every resting zoom**
- **Display-pixel-aligned camera tiers.** World zoom levels adapt to sub-100% browser scaling so each authored sprite pixel occupies exactly one, two, or three physical pixels after the camera settles.
- **Every camera path agrees.** Wheel and keyboard zoom, agent follow, cinematic framing, resize recovery, auto-framing, and scripted capture poses all resolve through the same aligned zoom tiers.
- **Live browser scaling stays stable.** Changing browser zoom remaps current and in-flight camera poses without losing the chosen tier or leaving the World at a fractional resting scale.

**More native-resolution coverage**
- **1080p stays native.** The visible-canvas budget rises from 1.5 to 2 million pixels, covering common full-HD World layouts without downsampling.
- **Large canvases remain guarded.** Higher resolutions still scale progressively within the aggregate renderer budget, preserving the existing memory and frame-rate protections.

---

## v0.26.1 — *Firm Foundations* · Jul 18, 2026

ClaudeVille's landmarks now belong to the terrain beneath them. Every World building has an explicit grounding contract, so foundations, thresholds, shadows, and waterfront supports follow the site instead of reading as raised sprite slabs.

**Every building meets the ground**
- **Nine authored grounding profiles.** The Command Center, Portal, Archive, Task Board, Forge, Mine, Observatory, Watchtower, and Harbor now declare their terrain relationship, contact span, shadow shape, and entrance threshold explicitly.
- **Foundations belong to the world.** Terrain aprons and threshold paths are baked into the terrain cache, while the Archive's dais, Harbor quay, and Watchtower pilings keep their intentional elevation without making the whole sprite float.
- **Raised lawns and false platforms removed.** Structure masks and targeted site-color cutouts strip baked-in grass, stone, and dirt slabs from the affected sprites while preserving their pixel architecture.

**Contact that holds up in motion**
- **Structure-aware shadows.** Deterministic stepped contact shadows follow each building's actual footprint instead of using a generic resting ellipse.
- **Diagnostics for every landmark.** Shift+D grounding overlays expose profile mode, footprint, contact line, shadow polygon, threshold path, and validation state directly in the World view.
- **Full visual coverage.** Day and night baselines now center every building type, with manifest and world validators enforcing explicit dimensions, anchors, grounding modes, contact spans, and migration masks.

---

## v0.26.0 — *Painter's Guild* · Jul 17, 2026

The guild has repainted the whole town. The sea reads as one deep body of water instead of a checkerboard, the ground is hand-textured painterly turf and cobble, sky rewards burst over the village instead of hiding behind it, and every villager, building, card, and panel now speaks one color language. This is the largest visual overhaul since the founding — and it costs the town nothing: the desktop widgets were retired and every effect ships within the v0.25 performance budget.

**Water & ground, remade**
- **The checkerboard is gone.** Water depth is classified by distance-to-land, so lagoon, river, and sea read as coherent shallow-rim-to-deep-center masses with lerped tones, wet-sand shorelines, a one-mass sea gradient, and baked iso wavelets.
- **Painterly terrain suite.** All six Wang tilesets were rebaked as textured art: wildflower meadow, earthen paths, grey-blue cobbles, golden shore sand, teal shallows over sandy beds, cobalt deep water, flagstone plaza — generated through a new manifest-driven REST tileset pipeline.
- **The land coheres.** A low-frequency noise field turns per-tile confetti into authored masses; roads grow worn verges; a plank bridge now crosses the river mid-map; props cast contact shadows; building bases no longer seam against the terrain.

**Sky & light**
- **Rewards you can actually see.** Aurora, shooting stars, and sky-flares moved to the canopy pass over the village, with a warm whole-village pulse on a successful push; nights gain viewport-scaled stars and ambient meteors; the sun is a crisp stepped pixel disc; day length follows the season; fleet-driven storms take a subtle violet cast so the weather honestly says when the fleet is struggling.
- **Night keeps its promises.** Waiting beacons, selection rings, and incident pills are re-stamped after the atmosphere multiply, so the marks that must never be lost stay readable in the dark; ground fog drifts over the water at dawn.

**A crowd of individuals**
- **No more clone armies.** Per-sheet palette sources make per-agent variants and team sashes actually render, and every agent's animation phase is seeded from its id, so a crowd no longer breathes as one organism.
- **Legible at a glance.** Stronger selection rings, hover rings with name pills, contrast-fixed name tags, identical cluster bubbles that merge into one with a ×N chip, and provider-colored zoom-out impostors.

**One town, two windows**
- **One status language.** A single canonical status ramp feeds both canvas and DOM through a boot-time token bridge — guarded by a new smoke check so it can never drift again — and `completed` is finally a first-class, softly golden status everywhere. Rate-limited moves to steel blue, and provider hues no longer collide with status hues.
- **The dashboard earns its keep.** Attention-state header washes, collapsed empty tool history, FLIP-animated reorders, relative timestamps, a calmer chip row, district-tinted portraits, ambience that follows the world clock, and a warm hearth glow under the grid. Modal and toasts join the parchment-and-bronze fold with proper dialog semantics.
- **Landmarks with presence.** Chronicle monuments are real sprites (cairn, stele, obelisk, founding stones) with a quiet mote over major ones; occupied buildings grow lit windows, occupancy pennants, and a dais ring; the observatory opens its dome aperture at night; an empty village gets a slow dusk tour.

**Craft under the hood**
- **44+ PixelLab asset bakes.** Broken cube layers rebaked as isolated objects, placeholder props and vegetation replaced, effort rings made distinguishable, and a validator upgrade (dimension + cube-fill heuristics) that would have caught every shipped defect.
- **Budget respected.** Rain-veil and gradient-allocation hot paths removed; every new motion ships its reduced-motion static fallback; camera event cues honor reduced motion.
- **Sharp at your size.** Canvas backing snaps to pixel-uniform ratios only when nearly free — 1080p and up keep full sharpness instead of a 2× nearest upscale.

**Farewell, widgets.** The macOS menu-bar app and KDE Plasma widget are retired, along with their build scripts, routes, and checks — one surface, done well.

---

## v0.25.2 — *Town Crier* · Jul 17, 2026

Kimi villagers now speak plainly about the tools they wield, and the town's records of where Kimi Code sessions live are hardened against the current session-store layout.

**Clearer Kimi captions**
- **Questions are heard.** AskUserQuestion turns now surface the actual question in villager captions and the Activity Panel instead of a blank tool input.
- **More tools named outright.** Task, skill, and cron-style calls now show their identifiers (`task_id`, `skill`, `id`) in captions and tool history rather than falling silent.

**Hardened Kimi Code session mapping**
- **The right home address.** When the session index lacks an entry, project resolution now prefers `state.json`'s top-level `workDir` over the agent `homedir`, which on current Kimi Code builds points inside the session store rather than at the project.
- **Fixtures stand watch.** Adapter fixtures now pin the `workDir`-over-`homedir` precedence, question captions, and the new tool-input fields, so future Kimi Code format drift fails loudly instead of emptying the village.

---

## v0.25.1 — *Open Waters* · Jul 14, 2026

Pushed commit ships now complete their voyage cleanly, fading into open water instead of turning back toward the island after reaching the sea.

**Clean departures**
- **No return leg after open water.** Successful push routes now end at the established sea-lane endpoint, removing the randomized final leg that could point ships back across the island.
- **Fade on arrival.** Each ship's opacity and mist timing follow its actual departure duration, reaching zero as the ship arrives at open water rather than several seconds afterward.
- **Regression coverage.** The deterministic Harbor scenario now verifies both the final route endpoint and zero opacity on arrival.

---

## v0.25.0 — *Steady Hearth* · Jul 14, 2026

ClaudeVille can now stay open through long coding sessions without its history, watchers, canvases, or village state growing without bound. The town keeps its existing look, motion, density, and two-second freshness contract while doing substantially less repeated work.

**A lighter, steadier runtime**
- **Watch only what is alive.** Historical provider trees no longer expand into tens of thousands of kernel watches; bounded discovery, active-file watches, stat probes, reconciliation, and deterministic shutdown keep the live footprint near 60 watches on the same corpus that previously required 44,669.
- **Session history stays bounded.** Claude transcript aggregation is incremental, byte-budgeted, cancellable, and cooperative for large first scans; shared tails, usage history, Codex discovery, and provider indexes now retain compact bounded state.
- **Refresh the part that changed.** Provider and Git invalidation is scoped to the affected session or project, with separate caches and immediate recovery after transient Git failures instead of repeated global rescans.

**A village built for long visits**
- **World state has firm horizons.** Fade colors, paths, cooldowns, tool events, Harbor replay state, visit intents, biographies, affinities, nicknames, landmarks, and chronicle work now expire or evict without changing what is visible on screen.
- **Clean starts and clean exits.** App boot, teardown, sockets, polling, details requests, audio visibility, renderer failures, WebGL context loss, canvases, listeners, and IndexedDB-backed work now have explicit ownership and bounded recovery paths.
- **The same town, less frame work.** Invariant water descriptors, unchanged-state Harbor and visit reconciliation, targeted building masks/outlines, finite sprite variants, and Dashboard geometry reuse reduce CPU and retained pixels without lowering scene quality or animation cadence.

**Desktop companions and diagnostics**
- **Stable widgets.** The macOS widget reuses its WebViews and single-flights refreshes; KDE guards superseded XHR batches. Both bundles use the self-hosted Press Start 2P font and its license.
- **Release gates for the long run.** Bounded `/api/perf` diagnostics and focused watcher, transcript, cache, lifecycle, World, widget, and soak smokes make memory and stability regressions reproducible.

---

## v0.24.2.1 · Jul 13, 2026 — Hotfix

Codex villagers spawned from large forked histories now retain their exact GPT-5.6 identity instead of falling back to the generic Codex model.

- **Correct model identity.** Delayed `turn_context` metadata is recovered with a bounded backward scan, restoring Sol, Terra, and Luna labels, reasoning effort, pricing, colors, and character sprites.
- **Regression coverage.** Adapter fixtures now cover both directly recorded GPT-5.6 variants and child variants inferred when Codex persists the parent's model.

---

## v0.24.2 — *Lamplighter's Watch* · Jul 12, 2026

Night stays dark enough for stars, fireflies, and torchlight to matter, but the village no longer disappears into the grade. Moonlight now preserves more terrain detail, while the lanterns already placed around the village cast broader pools of warm light across roads, bridges, work yards, and quiet research paths.

**Brighter nights, warmer roads**
- **A clearer moonlight floor.** The night grade lifts shadow detail and eases the darkest vignette edges without flattening the cool sky, deep water, or strong building silhouettes.
- **Lanterns light their surroundings.** Existing lantern and brazier props now act as true ambient point lights, spreading warm ground illumination around the bridge, gate approach, workshop, mine road, and village paths.
- **Focused flames, restrained glow.** Compact flickering halos remain at each flame while the wider light pools stay soft, keeping agents, labels, and status effects at the top of the visual hierarchy.

---

## v0.24.1 — *Stoneward* · Jul 12, 2026

ClaudeVille's waterfront boundary has grown into a proper fortified entrance. The old flat palisade and loosely assembled gate are replaced by darker timberwork, continuous masonry, asset-backed watchtowers, and a civic arch that carries the village name as part of the structure.

**A gate worthy of the village**
- **Asset-backed gatehouse.** New hand-finished PixelLab sprites provide matching stone-and-timber watchtowers and a dedicated central arch, with `CLAUDEVILLE` baked into the masonry instead of painted as runtime canvas text.
- **One coherent structure.** The arch, animated door leaves, and tower jambs now layer in architectural order; the connector follows the world's isometric axis and remains aligned in both open and closed states.
- **Stronger doors and warmer arrival.** Braced timber leaves replace the flat slabs, while paired gate braziers provide balanced light without a hanging lantern obscuring the entrance.

**The fortified boundary**
- **Continuous stone footing.** The waterfront wall now sits on cool-grey mortared masonry that matches the gate towers and nearby village buildings.
- **Purposeful timberwork.** Dark walnut panels, cross braces, calmer stake spacing, stone buttresses, restrained slate caps, ivy, and torch details give the palisade depth without competing with the village interior.

**Every villager stays grounded**
- **Accessory cells are isolated.** Hats and equipment are clipped to their owning animation cell during composition, preventing tall accessories from leaking into adjacent frames and being mistaken for another frame's feet.
- **Provider-wide protection.** The grounding correction applies to every agent model and accessory combination, including the GPT-5.6 villagers that first exposed the levitation bug.

---

## v0.24.0 — *Bells & Birdsong* · Jul 12, 2026

The village finds its voice. The old sound toggle played a fixed synth drone that ignored everything on screen; it is replaced by a reactive soundscape that scores what the village is actually doing — and a proper tune. Still fully procedural Web Audio: no samples, no assets, no build step. Sound stays opt-in and off by default.

**A town band, like the old games**
- **A songbook, not a loop.** The music layer is a small generative composer: four authored tunes (two daytime folk songs, two night lullabies), each with A/B sections over real chord progressions, assembled into varying forms (A-A-B-A, A-B-A-A, ...) with a pickup bar and a ring-out outro. Repeated sections vary — the lead swaps timbre or adds a phrase-end flourish — and the next song is always a different tune.
- **Three console voices.** NES-style 25%/12.5% duty pulse leads and a flute tone (proper band-limited PeriodicWaves), plucked arpeggio/chord accompaniment, triangle bass in root–fifth motion — plus delayed-onset vibrato on held notes, downbeat accents, and humanized timing.
- **Arrangements follow the day.** Brisk and bright at noon, slower at dawn, warm and an octave lower at dusk, minor-pentatonic lullabies at night. When day turns to night mid-song, the tune finishes with its outro and the night songbook takes over. Storms push the music back and let the weather speak.
- **One tonal center.** Every pitched element — songs, bed swells, every bell cue — shares the same pentatonic tonal center per phase, so nothing ever clashes.

**The world you hear is the world you see**
- **Weather is audible.** Wind gusts with the storm intensity and hushes on calm days; rain patter and droplets track precipitation; thunder rolls just after each visible lightning strike. Winter snowfall stays hushed — wind carries the scene.
- **Time of day is audible.** A dawn chorus of birdsong, quieter daytime birds, and summer-night crickets (two of them, arguing in stereo) that go silent in winter.
- **The village is audible.** A faint work-hum of wood knocks and hammer taps scales with how many agents are working; an idle village rests near silence.

**Moments ring, but never spam**
- **Governed one-shot cues.** Arrivals and departures get two-note bells, distress a low muted toll, recovery a resolving pair, council gatherings a three-bell pattern, plus an hour bell (08:00–20:00) and a rare aurora shimmer.
- **A central cue governor** — per-kind cooldowns, 4-second global spacing, max 6 cues per minute — structurally prevents v0.12's wall-of-beeps from ever returning. Excess cues are dropped, never queued.

**BGM mode — continuous town music, like the handhelds**
- **A second sound system, switchable in the top bar.** The AMBIENT/BGM button (visible while sound is on) swaps the reactive soundscape for continuous town BGM in the classic handheld tradition: the music never stops. Choice persists across sessions.
- **Five original town themes** built from analysis of classic game BGM: *Willowbrook* (gentle home-village), *Cobblemarket* (warm market street over constant eighth-note arpeggios), *Millwheel* (brisk workday with soft hats), and after dark *Starfall* and *Moonwell* (slow music-box lullabies with pad chords and long echo).
- **Seamless loops, rotating playlist.** Pieces loop gap-free 2–3 times, take one short breath, and hand over to a different tune; time of day picks the playlist, and a day tune finishes its loop before the night music takes over. Event cues ring over the score like game jingles, ducking the music briefly.
- **Console voicing.** Pulse-wave lead (music-box bell at night), pulse arpeggio/counter voice, triangle bass, whisper-level noise percussion — the classic four-channel layout.

**Controls & plumbing**
- **Volume slider** next to the sound toggle, persisted across sessions.
- **Ambience continues in Dashboard mode** — the audio director computes its own local-clock atmosphere when the World renderer is stopped.
- New events: `atmosphere:updated` (renderer snapshot broadcast) and `weather:storm-flash` (per lightning strike). QA helpers: `__claudevilleAudio()` exposes per-layer levels, `setLayer`, `cue`, `setVolume`.

---

## v0.23.0 — *Tides & Torchlight* · Jul 12, 2026

A visual overhaul of the village: the harbor gets its beloved flock back, the water learns to move, the seasons touch the ground, hats finally sit on heads, and the night gets dark enough for lanterns to matter. Six exploration scouts surveyed the renderer; everything below is procedural canvas work — no new sprite assets.

**The harbor flock returns**
- **One ship per commit again.** Docked commits render as individual ships (up to 15 per repo, was: collapse into stack sprites at 5) — you can watch the fleet grow as an agent commits. Stack sprites remain only as overflow.
- **The whole flock sails on push.** Departing ships always render individually: a 12-commit push casts off as a 12-ship flotilla, with ±12% per-ship speed jitter, serpentine sway, and a beacon flare on the channel buoy at cast-off.
- **Flagship leader.** The lead ship keeps a commit-count class hull with the repo heraldry and a fleet-count `N⚓` banner; every other commit is a skiff.
- **Living hulls.** Ships bob and roll (phase-seeded per ship, so the flock never moves in lockstep), flags and pennants wave — streaming harder as ships pick up speed — and skiffs vary by hull mirror, gunwale stripe, and deck crates.

**Living water**
- **Rivers flow.** Downstream flow streaks derived from the river polylines' direction — rivers no longer read as static teal ribbons.
- **The sea rolls.** Swell crests travel across tiles along the wave direction instead of twinkling in place.
- **Sun and moon glitter.** A deterministic sparkle field on open water: warm at midday, pale blue under the moon.
- **Waterfalls churn.** Breathing spray mist, foam dabs, and staggered ripple rings at the plunge pool.
- **The horizon breathes.** Distant-sea swell lines bob and drift, with a glitter column under the sun/moon.

**Seasons & vegetation**
- **The ground knows the season.** Terrain rebakes per season: snow flecks in winter, wide warm leaf litter in autumn, blossom dabs in spring.
- **Leaves fall from trees.** Drift particles anchor to the world — leaves and petals spawn from actual tree canopies, butterflies from flower patches — instead of raining uniformly over open sea and rooftops.
- **Wind arrives in gusts.** Tree sway is modulated by a spatially-phased gust envelope, so wind travels across the forest in waves instead of a metronome.
- **Hidden details surfaced.** The terrain generator's stone and mushroom tiles (tagged but never drawn) now render: pebble clusters in open grass, glowing-cap mushrooms under the northern canopy.
- **Real insects.** Butterflies flap procedural wings; fireflies pulse with a soft halo.

**Hats that fit**
- **Per-cell head anchoring.** Accessories stamp at each sprite cell's measured head apex, tracking facing direction and walk bob — no more floating, sliding headgear (was: one fixed anchor for all 80 cells).
- **No more hat teleporting.** Tool-driven accessories switch only after 20s of dominance; effort crowns still apply instantly.
- **No more shrinking villagers.** Body draw-scale now measures accessory-free bounds, so a tall hat no longer squashes its wearer.
- **Grounded, harmonized headgear.** Contact shadow under the brim, palette-trim tint toward the wearer's colors, and a cropped darkened back view when facing away.

**Night, light & weather**
- **Real darkness.** The night/dusk grade composites with `multiply` instead of a milky translucent wash — deep contrasty nights, golden dawns.
- **Lanterns that glow.** Light stamps draw additively with a hot inner core, punching through the dark; the large-viewport fast path regains a capped glow pass (it previously dropped all lights exactly when zoomed in at night).
- **Torchlit decor.** Lantern and brazier props get warm flickering night glows; fireflies now only spawn at dusk/night, with extra spawn points by grass and water.
- **Weather with depth.** Rain falls in three parallax layers, splashes land on the ground instead of the sky, winter precipitation falls as snow, and a dozen hot stars twinkle live over the cached night sky.

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
