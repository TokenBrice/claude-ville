# Claude Ville Visual Refresh and Enhancement Plan

Max old-school RPG look and feel, optimized for parallel execution with subagents.

## Purpose

ClaudeVille's world mode should read like a small, playable fantasy RPG village that explains active AI coding sessions at a glance. This refresh focuses on sprite quality, visual grammar, and renderer-safe asset generation without introducing a build step or framework.

The core goal is not "more decoration." The goal is a stronger data-to-place metaphor:

- agents read as distinct RPG party members;
- buildings read as semantic landmarks before labels are needed;
- terrain reads as one cohesive game board;
- props and harbor activity make the world feel inhabited;
- status and light overlays support attention without becoming clutter.

## Execution Model

Use a light-to-full swarm depending on whether the slice is read-only, asset-generation only, or renderer-changing.

- **Orchestrator**: owns sequencing, conflict checks, final integration, validation, and commits if requested.
- **Asset Contract Lead**: verifies manifest IDs, runtime paths, dimensions, anchors, and renderer usage.
- **Prompt Lead**: owns prompt wording, negative constraints, and reject criteria.
- **Generation Workers**: regenerate disjoint asset groups only.
- **Visual QA Agents**: inspect contact sheets and browser screenshots.
- **Renderer Reviewer**: confirms whether each asset is visible today or code-first.

Actual writes should use non-overlapping ownership. The orchestrator should re-run `git status --short` before assignment, before integration, and before final handoff.

## Shared Checkout Safety Gate

This plan assumes the checkout may already contain unrelated local changes. At the start of each execution slice, record the full `git status --short`.

Known unrelated dirty paths must remain untouched unless a later task explicitly takes ownership of them. For asset-only phases, do not edit:

- `claudeville/src/config/buildings.js`
- `claudeville/src/config/scenery.js`
- `claudeville/src/config/townPlan.js`
- `claudeville/src/presentation/character-mode/Camera.js`
- `claudeville/src/presentation/character-mode/HarborTraffic.js`
- `claudeville/src/presentation/character-mode/IsometricRenderer.js`

Before integrating a worker result, compare the current status and owned-path checksums against the assignment baseline. If any owned path changed outside the assigned worker, stop and ask for direction.

Keep no more than five subagents active at once. Only one write-enabled worker may own a given asset group at a time.

## Dependency Graph

Parallelizable immediately:

- Phase 0 contract audit.
- Prompt prep for Phases 1 through 7.
- Current PNG inventory and contact-sheet creation.
- Renderer visibility classification.

Sequential gates:

1. Phase 0 must finish before asset writes.
2. One low-risk overlay asset should prove the PixelLab path before broad generation.
3. Each batch must pass dimension and transparency checks before browser smoke.
4. Terrain and character work should each start with one benchmark before full-batch generation.
5. Code-first assets should not be regenerated until renderer wiring is approved.
6. Prompt prep before Phase 0 is draft-only. Final prompts must be frozen after Phase 0 confirms tool names, sizes, anchors, paths, and visibility.

## Global Art Contract

Use the existing manifest style anchor as the shared prefix:

```text
epic high-fantasy pixel art, dramatic lighting, painterly palette, crisp pixel edges, no anti-aliasing, heroic silhouettes, faint magical glow on landmarks
```

When using the manifest anchor, interpret `painterly palette` as color richness only. Do not allow soft brush texture, anti-aliased edges, smeared gradients, or high-resolution illustration detail. The final sprite must read as crisp pixel art.

For transparent overlays, props, vegetation, docks, boats, and non-terrain objects, append this negative constraint:

```text
transparent background only, isolated sprite, no ground tile, no square base, no platform, no grass patch, no dirt patch, no cobblestone patch, no drop shadow baked into the image, empty transparent corners
```

Old-school RPG style constraints:

- Use limited SNES/GBA-style palettes.
- Favor strong silhouettes over tiny detail.
- Keep pixel edges crisp.
- Do not rely on labels for core identity.
- Do not bake base plates into props unless the renderer expects terrain.
- Make species, provider, and landmark differences visible by shape first, color second.

### Art Bible Gate

Before any generation worker writes PNGs, the Prompt Lead and Visual QA Agent must approve a one-page art bible:

- camera/read: isometric old-school RPG village, readable first at zoom 1;
- outline rule: strong 1-2 px dark contour for characters, landmarks, props, and vegetation;
- palette rule: moss greens, warm parchment/amber, weathered stone, deep harbor blues, provider accents only where semantically useful;
- material rule: stone, wood, cloth, parchment, lantern fire, brass, water, moss;
- detail rule: large silhouette first, interior detail second, tiny decoration last;
- rejection rule: reject painterly blur, photoreal lighting, smooth gradients, generic neon fantasy glow, base tiles on transparent sprites, and any asset whose identity only reads in isolation.

## Phase 0: Baseline and Contract Audit

### Goal

Create the execution map before any asset writes.

### Subagents

- **Contract Agent**
  - Read-only paths:
    - `claudeville/assets/sprites/manifest.yaml`
    - `claudeville/src/presentation/character-mode/AssetManager.js`
    - `claudeville/src/presentation/character-mode/SpriteSheet.js`
    - `claudeville/src/presentation/character-mode/TerrainTileset.js`
    - `claudeville/src/presentation/character-mode/AgentSprite.js`
    - `claudeville/src/presentation/character-mode/IsometricRenderer.js`
    - `claudeville/src/presentation/character-mode/HarborTraffic.js`
  - Output:
    - manifest-to-render-use table;
    - dimension and anchor contracts;
    - visible-now versus code-first classification.

- **Inventory Agent**
  - Read-only paths:
    - `claudeville/assets/sprites/**/*.png`
    - `claudeville/assets/sprites/manifest.yaml`
  - Output:
    - current dimensions;
    - manifest size mismatches;
    - missing or orphan assets;
    - contact sheets by category.

- **Renderer Visibility Agent**
  - Read-only paths:
    - `claudeville/src/presentation/character-mode/*.js`
  - Output:
    - which assets are drawn today;
    - which assets require code wiring first;
    - assets that should be deferred.

### Acceptance Criteria

- Every target asset is labeled as `visible now`, `code-first`, or `defer`.
- Every writable path has one owner before generation begins.
- Contract constraints are known for dimensions, anchors, transparency, and runtime scaling.

### Validation

```bash
git status --short
find claudeville/assets/sprites -type f -name '*.png' -print0 | xargs -0 file
```

Use `identify` instead of `file` when ImageMagick is available.

## Phase 1: Low-Risk Visible Overlay Fixes

### Goal

Prove the generation pipeline and immediately fix visible overlay problems.

### Targets

- `claudeville/assets/sprites/overlays/overlay.status.selected.png`
- `claudeville/assets/sprites/atmosphere/atmosphere.light.fire-glow.png`
- `claudeville/assets/sprites/atmosphere/atmosphere.light.lantern-glow.png`
- `claudeville/assets/sprites/atmosphere/atmosphere.light.lighthouse-beam.png`

### Parallelization

- Prompt Lead prepares all four prompts.
- One Generation Worker owns these four PNG writes.
- Visual QA Agent verifies transparency and contact sheet.
- Renderer Reviewer confirms these are visible today and require no code changes.

### Prompt Directions

`overlay.status.selected`, `64x64`:

```text
magical selection ring at character feet, flat elliptical golden rune circle, hollow transparent center, thin bright pixel outline, subtle amber pulse marks, SNES-era fantasy RPG target marker, transparent background only, no object in center, no ground tile, no square base, no platform, empty transparent corners
```

The ring should occupy roughly x `8..56` and y `20..42`. The renderer draws this directly under the agent, so the manifest anchor is not used.

`atmosphere.light.fire-glow`, `64x64`:

```text
orange amber firelight reflection mask, soft elliptical light pool with pixel-dithered edges, warm flicker caustics, additive overlay for ground and water, transparent background only, no flame, no brazier, no lantern, no stone base, no ground tile, empty transparent corners
```

`atmosphere.light.lantern-glow`, `64x64`:

```text
small warm lantern light pool, soft amber oval halo, subtle pixel dither falloff, additive overlay for stone paths and building walls, transparent background only, no lantern object, no post, no cobblestone base, no ground tile, empty transparent corners
```

`atmosphere.light.lighthouse-beam`, `64x64`:

```text
wide golden lighthouse shimmer on harbor water, horizontal broken caustic streaks, soft pixel-dithered reflection, old-school RPG night harbor glow, transparent background only, no lighthouse, no flame, no beam cone, no square base, empty transparent corners
```

### Acceptance Criteria

- All outputs are `64x64`.
- Corners are transparent.
- There is no base tile, platform, flame object, brazier, or lamp geometry.
- Selected agents read clearly in World mode.
- Building lights read as light or water reflection, not misplaced props.

## Phase 2: Landmark Benchmark

### Goal

Improve the weakest major building first and use it as a landmark-quality benchmark.

### Primary Target

- `claudeville/assets/sprites/buildings/building.taskboard/base.png`

### Optional Follow-Up

- `claudeville/assets/sprites/buildings/building.archive/base.png`, only if screenshot review confirms low identity.

### Parallelization

- Art Direction Agent refines the landmark silhouette.
- Generation Worker owns only `building.taskboard/base.png`.
- Visual QA Agent compares against current buildings in a contact sheet.
- Browser QA checks recognizability at zoom levels 1, 2, and 3.

### Prompt Direction

```text
epic fantasy guild task board hall, open-sided quest pavilion, oversized parchment notice boards facing front, colored wax seals, dangling scrolls, carved stone pillars, warm blue-gold lantern glow, small guild pennant, readable quest-board silhouette, isometric old-school RPG landmark, transparent background, no square base, no grass tile, no dirt platform
```

### Contract Notes

- Manifest source size is `64`.
- Runtime normalizes to `displaySize: 112`.
- No explicit anchor means `AssetManager` uses bottom-center and 7/8 height.

### Acceptance Criteria

- Reads as a task board or quest hall before the label.
- Important board shape is front/center, not hidden by roof detail.
- No square base tile.
- Runtime footprint remains compatible with the existing building layout.

## Phase 3: Terrain Foundation

### Goal

Replace blob-like generated sheets with cohesive old-school RPG ground.

### Targets

- `claudeville/assets/sprites/terrain/terrain.grass-dirt/sheet.png`
- `claudeville/assets/sprites/terrain/terrain.grass-cobble/sheet.png`
- `claudeville/assets/sprites/terrain/terrain.grass-shore/sheet.png`
- `claudeville/assets/sprites/terrain/terrain.shore-shallow/sheet.png`
- `claudeville/assets/sprites/terrain/terrain.shallow-deep/sheet.png`
- `claudeville/assets/sprites/terrain/terrain.cobble-square/sheet.png`

### Parallelization

- Prompt Lead prepares shared Wang tileset rules.
- Generation Worker A owns land and civic terrain:
  - `terrain.grass-dirt`
  - `terrain.grass-cobble`
  - `terrain.cobble-square`
- Generation Worker B owns shore and water terrain:
  - `terrain.grass-shore`
  - `terrain.shore-shallow`
  - `terrain.shallow-deep`
- Terrain QA Agent validates sheets and edge behavior.
- Browser QA checks roads, shore, and water in World mode.

### Shared Negative Constraint

```text
seamless Wang 4-bit tileset, 16 adjacency variants, no single island composition, no large central blob, no border frame, no object props, no buildings, no text
```

### Prompt Directions

`terrain.grass-dirt`:

```text
lower: ancient mossy forest grass, muted green, tiny wildflowers, SNES fantasy RPG ground texture, seamless
upper: rich loam dirt footpath, worn cart ruts, scattered pebbles, warm brown, seamless
```

`terrain.grass-cobble`:

```text
lower: ancient mossy forest grass, muted green, tiny wildflowers, seamless
upper: weathered medieval cobblestone road, uneven grey stones, moss in cracks, subtle carved guild marks, seamless
```

`terrain.grass-shore`:

```text
lower: ancient mossy grass near coast, damp dark edges, tiny reeds, seamless
upper: sandy harbor shore, pebbles, broken white sea foam, wet edge shimmer, seamless
```

`terrain.shore-shallow`:

```text
lower: pale limestone harbor shore, wet sand, pebbles, broken foam, seamless
upper: clear turquoise shallow harbor water, visible sandy bed, small pixel wavelets, seamless
```

`terrain.shallow-deep`:

```text
lower: clear turquoise shallow harbor water, sunlit ripples, small foam flecks, seamless
upper: deep cobalt open sea water, darker currents, subtle wave crests, old-school RPG water texture, seamless
```

`terrain.cobble-square`:

```text
lower: weathered medieval cobblestone road, moss in cracks, uneven stones, seamless
upper: polished town square flagstone, worn smooth, slightly lighter center stones, subtle heroic fantasy plaza texture, seamless
```

### Contract Notes

- Each tileset output must be `128x128`.
- Runtime expects 16 Wang variants, arranged as a `4x4` sheet of `32px` source tiles.
- Terrain changes affect the full viewport, so review as one coherent map pass.

### Acceptance Criteria

- No tile sheet looks like one large island or blob.
- Roads and shorelines blend across repeated tiles.
- Water reads darker and richer without overpowering agents or buildings.
- No baked props, buildings, text, or frames.
- Each terrain sheet passes a 3x3 repeat check. No seam should reveal the tile boundary, and no variant should look like a standalone island when repeated.

## Phase 4: Character Identity Pass

### Goal

Make agents read as distinct RPG party members at medium zoom.

### Benchmark First

Choose one:

- `claudeville/assets/sprites/characters/agent.claude.opus/sheet.png`
- `claudeville/assets/sprites/characters/agent.codex.gpt55/sheet.png`

### Full Targets

- `agent.claude.opus`
- `agent.claude.sonnet`
- `agent.claude.base`
- `agent.codex.gpt55`
- `agent.codex.gpt54`
- `agent.codex.gpt53spark`
- `agent.codex.base`
- `agent.gemini.base`

### Parallelization

After one benchmark passes:

- Claude Worker owns `agent.claude.*`.
- Codex Worker owns `agent.codex.*`.
- Gemini Worker owns `agent.gemini.base`.
- Character QA Agent extracts representative frames and checks all sheets.

### Prompt Directions

`agent.claude.opus`:

```text
epic high-fantasy Claude Opus archmage scholar, large readable head and hands, ivory amber robe mass, broad gold rune mantle, high collar silhouette, glowing tome held forward, short staff, wise calm posture, strong 16-bit RPG party-character silhouette, 8-direction pixel art, transparent background
```

`agent.claude.sonnet`:

```text
epic high-fantasy Claude Sonnet scribe mage, warm amber cloak, silver quill wand, open spellbook, narrow scholar hood, nimble readable silhouette, parchment satchel, bright gold trim, old-school RPG party-character style, 8-direction pixel art, transparent background
```

`agent.codex.gpt55`:

```text
epic high-fantasy Codex GPT-5.5 master artificer, teal engineer coat, brass arcane lens, luminous chest core, tool belt, gear pauldron, sturdy heroic silhouette, readable from zoomed-out isometric view, 8-direction pixel art, transparent background
```

`agent.codex.gpt54`:

```text
epic high-fantasy Codex GPT-5.4 senior engineer, deep blue teal coat, brass goggles, rolled blueprint scroll, compact mechanical backpack, gold circuit trim, strong readable RPG silhouette, 8-direction pixel art, transparent background
```

`agent.codex.gpt53spark`:

```text
epic high-fantasy Codex GPT-5.3 Spark scout artificer, fast runner silhouette, yellow cyan lightning sash, short teal coat, small arcane tool kit, energetic pose, readable old-school RPG sprite, 8-direction pixel art, transparent background
```

`agent.gemini.base`:

```text
epic celestial oracle, deep violet vestments, constellation veil, star crown silhouette, pale blue starlight trim, calm floating mystic posture, readable old-school RPG party-character silhouette, 8-direction pixel art, transparent background
```

### Contract Notes

- Output must be `736x920`.
- Layout is 8 direction columns by 10 animation rows.
- Cell size is `92px`.
- Preserve anchor `[46,80]`.
- Walk rows and breathing-idle rows must be populated.

### Acceptance Criteria

- Provider and model identity are readable by silhouette.
- The differences are not dependent on tiny accessories.
- Feet remain near y `80`.
- No frames are cropped.
- Character sheets still animate cleanly in World mode.
- The character remains recognizable in a `46x46` crop so identity survives zoomed-out rendering.

## Phase 5: High-Frequency Props

### Goal

Fix high-use small props, especially manifest `size: 32` assets currently stored as larger files and downscaled at runtime.

### Targets

Primary:

- `claudeville/assets/sprites/props/prop.runestone.png`
- `claudeville/assets/sprites/props/prop.scrollCrates.png`
- `claudeville/assets/sprites/props/prop.oreCart.png`
- `claudeville/assets/sprites/props/prop.well.png`
- `claudeville/assets/sprites/props/prop.noticePillar.png`
- `claudeville/assets/sprites/props/prop.harborCrates.png`

Optional style consistency:

- `claudeville/assets/sprites/props/prop.lantern.png`
- `claudeville/assets/sprites/props/prop.signpost.png`

### Parallelization

- Worker A owns civic and research props:
  - `prop.runestone`
  - `prop.noticePillar`
  - `prop.signpost`
- Worker B owns mine and forge props:
  - `prop.oreCart`
  - `prop.lantern`
- Worker C owns storage and harbor props:
  - `prop.scrollCrates`
  - `prop.harborCrates`
  - `prop.well`
- Prop QA Agent checks native-size readability.

### Shared Prompt Suffix

```text
single readable object, native 32x32 pixel sprite, transparent background, no ground tile, no platform, no square base, no tiny unreadable details
```

### Prompt Directions

`prop.runestone`:

```text
ancient rune monolith, chunky vertical silhouette, one bright cyan rune, moss chips, isometric, single readable object, native 32x32 pixel sprite, transparent background, no ground tile
```

`prop.scrollCrates`:

```text
two stacked wooden crates with oversized scroll tubes, red wax seals, rope bands, isometric, native 32x32 pixel sprite, transparent background, no ground tile
```

`prop.oreCart`:

```text
tiny mine cart on short rail segment, glowing amber ore mound, dark iron wheels, strong side silhouette, isometric, native 32x32 pixel sprite, transparent background, no ground tile
```

`prop.well`:

```text
round stone village well, simple roof beam, visible bucket, ivy accent, chunky readable silhouette, isometric, native 32x32 pixel sprite, transparent background, no ground tile
```

`prop.noticePillar`:

```text
narrow carved stone notice pillar, oversized parchment strips, tiny iron crown top, vertical silhouette, isometric, native 32x32 pixel sprite, transparent background, no ground tile
```

`prop.harborCrates`:

```text
compact harbor cargo stack, rope net, one blue guild stencil, strong crate block silhouette, isometric, native 32x32 pixel sprite, transparent background, no dock tile
```

### Acceptance Criteria

- Manifest `size: 32` assets are true `32x32`, unless explicitly promoted in the manifest.
- Each prop reads by silhouette at zoom 1.
- Transparent background.
- No square base tile.

## Phase 6: Harbor Narrative Upgrade

### Goal

Make commit and push activity feel like RPG world motion rather than dashboard decoration.

### Targets

Primary:

- `claudeville/assets/sprites/props/prop.harborBoat.png`
- `claudeville/assets/sprites/props/prop.harborCrane.png`
- `claudeville/assets/sprites/bridges/dock.ew.png`
- `claudeville/assets/sprites/bridges/dock.ns.png`

Optional:

- `claudeville/assets/sprites/bridges/bridge.ew.png`
- `claudeville/assets/sprites/bridges/bridge.ns.png`
- `claudeville/assets/sprites/props/prop.harborPier.png`

### Parallelization

- Harbor Prompt Agent prepares a cohesive harbor style.
- Boat Worker owns `prop.harborBoat`.
- Dock/Bridge Worker owns `dock.*` and `bridge.*`.
- Crane Worker owns `prop.harborCrane`.
- Harbor QA Agent checks motion readability and transparent surroundings.

### Prompt Directions

`prop.harborBoat`, `64x64`, anchor `[32,32]`:

```text
fantasy commit cargo sailboat marker, dark wooden hull, bright white triangular sail with gold branch sigil, glowing sealed cargo crate, tiny lantern at stern, readable old-school RPG harbor sprite, isometric, transparent background, no water tile, no dock tile, no square base
```

`prop.harborCrane`, `64x64`, anchor `[32,56]`:

```text
medieval harbor loading crane, timber A-frame, chunky pulley wheel, hanging iron hook, coiled rope, weathered planks detail, strong vertical silhouette, isometric old-school RPG sprite, transparent background, no dock tile, no square base
```

`dock.ew`:

```text
east-west harbor dock plank strip, barnacle-weathered boards, rope coil, iron cleats at both ends, edge-aligned isometric RPG dock segment, transparent background, no water tile, no sand tile, no square base
```

`dock.ns`:

```text
north-south harbor dock plank strip, barnacle-weathered boards, rope coil, iron cleats at both ends, edge-aligned isometric RPG dock segment, transparent background, no water tile, no sand tile, no square base
```

### Acceptance Criteria

- Boat reads as a commit cargo vessel.
- Docks are plank-only transparent overlays.
- Crane has a strong vertical silhouette.
- No asset brings its own water, sand, or square tile.
- Commit/push motion still reads while the boat is moving, not only in static contact sheets.

## Phase 7: Vegetation and Fillers

### Goal

Add world texture after core readability is proven.

### Targets

- `veg.tree.oak.small`
- `veg.tree.pine.small`
- `veg.tree.willow.small`
- `veg.bush.a`
- `veg.bush.b`
- `veg.bush.c`
- `veg.grassTuft.a`
- `veg.grassTuft.b`
- `veg.reed.a`
- `veg.reed.b`
- small boulder variants

Large tree and boulder variants may be refreshed later if they clash with the new style.

### Parallelization

- Tree Worker owns tree variants.
- Bush/Tuft Worker owns bushes and grass.
- Reed/Boulder Worker owns reeds and boulders.
- Vegetation QA Agent validates variety and no square turf bases.

### Prompt Strategy

```text
native 32x32 for small vegetation, native 64x64 for large trees and boulders, transparent background, no ground tile, exaggerated old-school RPG silhouette, one readable species cue, limited interior noise
```

Specific directions:

- Oak: round chunky canopy, short twisted trunk.
- Pine: compact triangular layered silhouette.
- Willow: drooping leaf strands, waterline mood.
- Bush A: round berry bush.
- Bush B: thorn briar.
- Bush C: flowering hedge.
- Reeds: sparse, vertical, water-edge cue.
- Grass tufts: very sparse, not full grass patches.

### Acceptance Criteria

- Small fillers are native `32x32`.
- Species differ by silhouette, not only color.
- No square turf bases.
- Repetition adds texture without cluttering the map.

## Deferred Code-First Track

Do not spend asset-generation budget here until renderer changes are approved:

- `overlay.accessory.*`
- `overlay.status.chat`
- `overlay.status.working`
- `overlay.status.idle`
- `atmosphere.deep-sea`
- `prop.flowerCart`, unless placement is confirmed or added.

Possible future workers:

- **Renderer Activation Agent**: wire accessories/status overlays into `AgentSprite` only if they add information not already carried by labels, rings, and ribbons.
- **Placement Agent**: decide whether unused or low-use props should appear in authored scenery.

## Failure Handling

Generate into a temporary review location first whenever possible. Do not replace the checked-in PNG until the output passes:

- correct path contract;
- correct dimensions;
- valid PNG/RGBA output;
- transparent-corner check when required;
- category-specific acceptance criteria.

If a generated asset fails validation, keep the existing checked-in asset, record the rejected prompt/output reason, and retry only within the same owned path. Do not broaden scope to renderer code or manifest changes unless the orchestrator opens a new assignment.

Use `curl --fail` for downloads. If a downloaded file is JSON, HTML, empty, or not reported as PNG by `file`, reject it immediately and do not overwrite the existing asset.

## Manifest Cache-Busting Ownership

When any PNG batch is accepted, the orchestrator owns the single manifest edit to bump `style.assetVersion` in `claudeville/assets/sprites/manifest.yaml`.

Generation workers must not edit `manifest.yaml` unless their assignment explicitly includes that path. Palette edits are out of scope for this plan unless separately approved; if palettes change, `claudeville/assets/sprites/palettes.yaml` must be kept in sync.

## Validation Gates

### Per Asset

```bash
file <asset-path>
```

or:

```bash
identify <asset-path>
```

For transparent assets, inspect corners and reject any baked ground tile.

### Per Batch

```bash
npm run sprites:validate
```

If local dependencies are missing and installing is out of scope, fall back to manifest/path inspection plus `file` or `identify`.

### Style Consistency Gate

For every batch, Visual QA must compare changed sprites against:

- one character sheet;
- one hero building;
- one standard building;
- one terrain sheet;
- one prop or vegetation contact sheet.

Reject the batch if contrast, outline weight, saturation, perspective, or scale makes the new assets feel like they came from a different game.

Visual QA has stop-the-line authority: a technically valid sprite may still be rejected if it weakens the RPG world identity.

### Runtime Smoke

```bash
npm run dev
```

Then inspect:

- `http://localhost:4000`
- World mode at zoom 1, 2, and 3.
- Dashboard mode for avatar regressions.
- Agent select and deselect behavior.
- Taskboard landmark area.
- Building light overlays.
- Terrain seams along roads, shore, and water.
- Harbor traffic if git-event sessions are available.

### Final Gate

- `git status --short`
- changed asset list
- contact sheets before and after
- browser screenshots
- no checkerboard placeholders
- no unrelated files staged or modified by the plan execution
- if PNGs changed, `style.assetVersion` is bumped in `claudeville/assets/sprites/manifest.yaml`
- if palette definitions changed, `claudeville/assets/sprites/palettes.yaml` is synchronized with the manifest palette block
- before/after screenshots show an obvious first-glance improvement in the affected area, not only contract correctness

## Assignment Packet Requirements

Every subagent assignment must include:

- cwd: `/home/ahirice/Documents/git/claude-ville`
- current HEAD
- current `git status --short`
- owned paths, or `none` for read-only review
- read-only paths
- owned-path baseline:
  - for read-only tasks: `none`
  - for write tasks: current `file` or `identify` output plus a pre-write copy or checksum for each owned PNG
- direct edits allowed: `yes` or `no`
- non-goals:
  - do not edit unrelated config/rendering files
  - do not stage
  - do not commit
  - do not call PixelLab unless the assignment explicitly says so
- validation required
- stop conditions
- return format

Workers may only write the exact owned paths listed in their packet. Prompt, QA, reviewer, and inventory agents are notes-only unless explicitly promoted by the orchestrator.

### Example Phase 1 Write Packet

```text
Goal: Regenerate transparent selected-agent and light-overlay assets.
Scope:
  cwd: /home/ahirice/Documents/git/claude-ville
  owned paths:
    - claudeville/assets/sprites/overlays/overlay.status.selected.png
    - claudeville/assets/sprites/atmosphere/atmosphere.light.fire-glow.png
    - claudeville/assets/sprites/atmosphere/atmosphere.light.lantern-glow.png
    - claudeville/assets/sprites/atmosphere/atmosphere.light.lighthouse-beam.png
  read-only paths:
    - claudeville/assets/sprites/manifest.yaml
    - claudeville/src/presentation/character-mode/AgentSprite.js
    - claudeville/src/presentation/character-mode/BuildingSprite.js
    - claudeville/src/presentation/character-mode/IsometricRenderer.js
  current HEAD: <sha>
  current git status summary: <paste git status --short>
  owned-path baseline: <file/identify output plus checksum for each owned PNG>
Direct edits allowed: yes, only for owned PNG paths after temporary-output validation.
Non-goals: do not edit renderer/config files, manifest, palettes, docs, or unrelated assets.
Validation required: file/identify, transparent-corner check, contact sheet, World-mode selected-agent and light-overlay smoke.
Stop conditions: stop if PixelLab returns non-PNG output, if generated output includes a base tile/object body, or if an owned path changes outside this worker.
Return format: files touched, prompts used, validation evidence, rejected attempts, residual risks.
```

### Example Phase 3 Write Packet

```text
Goal: Regenerate land/civic terrain sheets as seamless old-school RPG Wang tilesets.
Scope:
  cwd: /home/ahirice/Documents/git/claude-ville
  owned paths:
    - claudeville/assets/sprites/terrain/terrain.grass-dirt/sheet.png
    - claudeville/assets/sprites/terrain/terrain.grass-cobble/sheet.png
    - claudeville/assets/sprites/terrain/terrain.cobble-square/sheet.png
  read-only paths:
    - claudeville/assets/sprites/manifest.yaml
    - claudeville/src/presentation/character-mode/TerrainTileset.js
  current HEAD: <sha>
  current git status summary: <paste git status --short>
  owned-path baseline: <file/identify output plus checksum for each owned PNG>
Direct edits allowed: yes, only for owned PNG paths after temporary-output validation.
Non-goals: do not edit shore/water terrain, renderer code, manifest, palettes, docs, or unrelated assets.
Validation required: file/identify, 128x128 check, 3x3 repeat check, contact sheet, World-mode road/civic terrain smoke.
Stop conditions: stop if generated sheets show island/blob composition, visible seams, baked props/text, or if an owned path changes outside this worker.
Return format: files touched, prompts used, repeat-check evidence, browser-smoke notes, rejected attempts, residual risks.
```

## Recommended Parallel Execution Order

1. Run Phase 0 with three read-only agents.
2. In parallel, have Prompt Lead prepare prompts for all phases.
3. Generate Phase 1 overlays as the pipeline proof.
4. Generate Phase 2 `building.taskboard` and one Phase 4 character benchmark in parallel.
5. If benchmarks pass, split Phase 3 terrain and the rest of Phase 4 characters across workers.
6. Run Phase 5 props, Phase 6 harbor assets, and Phase 7 vegetation in parallel after the core style is proven.
7. Run one final browser QA and renderer-contract review.

This maximizes concurrency while keeping renderer contracts, visual consistency, and shared-checkout safety under control.
