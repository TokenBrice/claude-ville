# ClaudeVille Sprite Asset Runbook

This runbook covers the current manifest-first sprite workflow for ClaudeVille. It replaces older fixed asset-count plans: always trust `claudeville/assets/sprites/manifest.yaml` over hardcoded IDs in old notes.

For tool selection, parameter enums, animation templates, async lifecycle, and pitfalls, see [`docs/pixellab-reference.md`](../../docs/pixellab-reference.md).

## Sources Of Truth

| File | Purpose |
| --- | --- |
| `claudeville/assets/sprites/manifest.yaml` | Canonical sprite IDs, prompts, tool names, sizes, anchors, building overlay layers, provenance, style anchor, asset version, and palette block. |
| `claudeville/assets/sprites/palettes.yaml` | Standalone palette mirror for tooling. Keep it in sync with the `palettes` block in `manifest.yaml`. |
| `claudeville/src/presentation/character-mode/AssetManager.js` | Runtime path mapping, manifest flattening, building layer loading, cache busting, and placeholder fallback. |
| `claudeville/src/presentation/character-mode/SpriteSheet.js` | Character sheet layout contract. Current sheets are 8 columns by 10 rows of 92px cells. |
| `scripts/sprites/manifest-validator.mjs` | Manifest-to-PNG validation and character-sheet motion checks. |
| `docs/material-channel-contract.md` | Semantic drawable fields, material classes, sidecar paths, atlas metadata, and channel encodings. |
| `scripts/sprites/atlas-{plan,bake}.mjs` | Deterministic reviewed-ID atlas planning and committed channel bake. |
| `scripts/sprites/channel-{validate,contact-sheet}.mjs` | Sidecar/atlas validation and output-only channel review sheets. |

## Setup

Runtime does not need npm packages, but the sprite tools do:

```bash
npm install
```

PixelLab generation requires the MCP server and an API token:

```bash
claude mcp add --transport http pixellab https://api.pixellab.ai/mcp \
  --header "Authorization: Bearer YOUR_API_TOKEN"
claude mcp list
```

Expected: `pixellab` is connected. Codex mounts the same server from the project-scoped `.codex/config.toml`, reading the token from `PIXELLAB_TOKEN`. The REST scripts read `.dev.vars` instead (see below).

## Path Contract

Every generated PNG must land at the path implied by its manifest ID:

| ID prefix | Expected path |
| --- | --- |
| `agent.*` | `claudeville/assets/sprites/characters/<id>/sheet.png` |
| `equipment.*` | `claudeville/assets/sprites/equipment/<id>.png` |
| `overlay.*` | `claudeville/assets/sprites/overlays/<id>.png` |
| `building.*` | `claudeville/assets/sprites/buildings/<id>/base.png`, plus layer files (`<name>.png`) when `layers` are set |
| `prop.*` | `claudeville/assets/sprites/props/<id>.png` |
| `veg.*` | `claudeville/assets/sprites/vegetation/<id>.png` |
| `terrain.*` | `claudeville/assets/sprites/terrain/<id>/sheet.png` |
| `bridge.*`, `dock.*` | `claudeville/assets/sprites/bridges/<id>.png` |
| `atmosphere.*` | `claudeville/assets/sprites/atmosphere/<id>.png` |

If the runtime cannot load an image, `AssetManager` falls back to `assets/sprites/_placeholder/checker-64.png`. Checkerboard output in the browser usually means a manifest/path/PNG problem.

## Procedural Grok fallback

The shipped Grok sheets are PixelLab bakes (manifest `tool: create_character`). When PixelLab is unavailable, an offline procedural baker remains:

```bash
npm run sprites:generate-grok
# or: node scripts/sprites/generate-grok-procedural.mjs --id=agent.grok.base --preview
```

It overwrites the `agent.grok.base` and `agent.grok.composer` sheets (8×10 × 92px; `--id=` limits it to one) and `--preview` also writes `output/grok-procedural-preview-<variant>.png`. Use it only as a stand-in; review the diff before committing over the PixelLab sheets.

## Generation Rules

1. Read the current `style.anchor` from `manifest.yaml`.
2. For entries with `prompt`, prepend the anchor to that prompt.
3. For tileset entries with `lower` and `upper`, prepend the anchor to both descriptions and pass them as the lower/upper tileset inputs.
4. Use the entry's `tool`, `size` or `width`/`height`, `n_directions`, `animations`, `layers`, and `anchor` fields. Buildings are single-image (`create_map_object`/`create-image-pixflux`); `create_map_object` downloads are flattened on grey, so run `node scripts/sprites/key-out-bg.mjs <base.png>` after saving. Manifest `tool` names are short repo labels; map them to the actual PixelLab surface before calling tools (`create_character`, `isometric_tile`, `create_topdown_tileset`, `create_map_object`, or REST `create-image-pixflux` for large hero assets). Character generation uses `generationSize` and optional `generationMode`; character `size: 92` remains the engine cell.
5. Save output to the path contract above.
6. Bump `style.assetVersion` only when PNGs on disk actually change; manifest-only edits (prompts, comments, anchors) must not bump it.
7. If editing palette keys or colors, keep `manifest.yaml` and `palettes.yaml` synchronized.

Use `curl --fail` when downloading direct Pixellab URLs. Pixellab may return non-PNG JSON while a job is still pending; `--fail` prevents accidentally saving that response as an image.

Use `npm run sprites:plan -- --ids=<manifest-id>` for a manifest-backed dry run before generating. The plan prints the selected IDs, expected output paths, tool names, dimensions, and style-anchored prompts without calling external services.

`scripts/sprites/generate-pixellab-revamp.mjs` is a legacy REST helper with a static asset inventory. It now fails unless run with an explicit, reviewed `--ids` list.

## Add One Character

This is the canonical character procedure. PixelLab parameter definitions and lifecycle details live in [`docs/pixellab-reference.md`](../../docs/pixellab-reference.md).

1. Add the `agent.*` entry to `manifest.yaml` before generating. Include the subject-only `prompt`, `tool: create_character`, `n_directions: 8`, engine `size: 92`, integer `generationSize` from 32 through 128, optional `generationMode`, animations, palette, anchor, and reviewed material metadata. Use `generationSize: 92 # generation size unverified — inherited default` only when generation history is unknown.
2. Preview the manifest-backed request: `node scripts/sprites/plan.mjs --ids=<sprite-id> --group read --frames 4`. Confirm its anchored prompt, generation size/mode, 92px engine cell, expected 736x920 sheet, output path, direction jobs and live `/v2/balance` before **any** bake. Inherited sizes yield provisional costs, not verified production quotes.
3. Call `mcp__pixellab__create_character` with `description` (`style.anchor` plus the entry prompt), `name`, `size` (equal to `generationSize`; the former `image_size` object is rejected since 2026-09), `n_directions=8`, `view="low top-down"`, `outline="single color black outline"`, `shading="basic shading"`, `detail="medium detail"`, and `mode` from `generationMode` (default `standard`). The MCP tool takes no `seed`. Pro mode ignores the outline/shading/detail hints. Save the returned `character_id`.
4. Call `mcp__pixellab__animate_character` twice with that `character_id`, `mode="template"`, all eight `directions`, and `template_animation_id="walking-6-frames"` then `template_animation_id="breathing-idle"`.
5. Call `mcp__pixellab__get_character` with `character_id` every 60 seconds (or block on `mcp__pixellab__wait_for_jobs` between checks) until both animations report 100%. Download the completed ZIP URL to `output/character-mcp-cache/<sprite-id>.zip` with `curl --fail`.
6. Assemble the runtime sheet with explicit animation IDs, never frame-count inference: `node scripts/sprites/generate-character-mcp.mjs --id=<sprite-id> --zip=<path> --character-id=<id> --walk=<animation-id> --breathingIdle=<animation-id>`. To replace only a named base-sheet group, use `--group=breathingIdle --animation-group-id=<id>` instead of the two group flags. Assembly requires eight directions, centres each frame in the 92px cell (cropping padded exports), and writes the 736x920 sheet plus ledger metadata only after all frames assemble. Supply `--generation-size=<verified-size>` when the entry has an inherited default.
7. Confirm the artifact: `file claudeville/assets/sprites/characters/<sprite-id>/sheet.png`. The result must be a 736x920 PNG.
8. Select or add `palette_layer`. Change both palette mirrors only for a shared palette change. Add reviewed material/emissive/occluder metadata and a `PROFILES` entry in `author-roster-channels.mjs` whenever required by sidecar declarations; never infer emission from brightness. Then run `node scripts/sprites/author-roster-channels.mjs`.
9. Run `npm run sprites:audit-refresh`. This must cover ID, manifest/PNG/palette, roster-profile, and channel validation before the character is accepted.
10. Create and inspect character evidence with `node scripts/sprites/contact-sheet.mjs --groups=characters`; also review every direction and representative walk/idle frames in World mode. The building-only visual-diff suite does not display characters.
11. Bump `style.assetVersion` only after PNG bytes change, then rerun `NODE_NO_WARNINGS=1 node scripts/sprites/manifest-validator.mjs`. Do not bump it for manifest-only metadata or comment changes.

Every character may declare `animationGroups: { walk: { rows: [0, 5] }, breathingIdle: { rows: [6, 9] } }`; ranges are inclusive and cannot overlap. Optional `provenance: { characterId, animationGroupId, generationSize, generationMode }` stores only known source facts; unknown IDs stay absent. `animationGroupId` identifies the most recently assembled named group (full two-group assembly omits this singular field). The separate optional `actionStrip` contract keeps its own `path`, `cell`, named `groups` with `rows`/`hold`, `grip`, and `provenance`; do not widen or repurpose the base sheet for new actions.

For a reviewed direction repair, add `--directions=north,north-east,north-west` to a named-group assembly. Other columns and groups remain untouched. If v3 exported an extra leading reference frame, explicitly pass `--skip-reference`; frame counts are still validated after that selection. When the repair's verified PNG canvas differs from the original rig metadata, pass `--source-size=<actual-size>`; this controls centering/cropping, not generation size. The ledger records `repairedDirections`, `skippedReference`, and `animationSourceSize` for this partial assembly. Keep the original and repair group IDs in the execution record so the mixed-source sheet can be reproduced.

The planner quotes v3 animation generations as `ceil(width * height * frames / 65536)` per direction using the source generation size, and template animation as one generation per direction when a matching template exists. These animation costs are separate from the character rig's `generationMode`. It parses `.dev.vars` with the shared token loader (`PIXELLAB_API_TOKEN`, or `PIXELLAB_AUTHORIZATION`, quoted or bare, with an optional `Bearer ` prefix); never source that file or print credentials. Tier 1 / 2,000 generations was verified on 2026-09-05 with 1,403 remaining and a September 9 reset; only the live balance authorizes a new batch.

## Add An Action Strip

An action strip is the optional second PNG beside a character sheet
(`characters/<id>/actions.png`, 8 direction columns × N rows of the 92px engine
cell; the shipped `read`-only strips are 4 rows, 736×368) that carries authored poses the base sheet has no rows for. The full field
contract is in [`docs/material-channel-contract.md`](../../docs/material-channel-contract.md)
§Action Strips (contract C2).

1. Record the source rig once: `provenance: { characterId: <uuid> }` on the
   character entry. Every shipped sheet's rig was recovered by comparing each
   server rotation against the shipped south idle cells; the four previously
   recorded IDs agreed with that comparison.
2. Quote before spending: `node scripts/sprites/generate-action-strip.mjs --ids=<id> --plan`
   prints the live `/v2/balance`, the rig's export canvas, and
   `ceil(canvas² × frames / 65536) × 8` generations per named group. The canvas
   is the rig's real export size (76–144px across this roster), not the entry's
   `generationSize`; several rigs therefore cost 2 generations per direction.
3. Generate and assemble: the same command without `--plan`. Groups are
   requested one at a time because Tier 1 allows **8 concurrent background jobs**
   and one 8-direction group fills them; a concurrency `429` is retried, not
   failed. Frames cache under `output/action-strip-cache/`, so `--assemble-only`
   re-assembles and re-reviews without spending anything.
   Frame caches include the source animation URL's path identity, so a new rig
   or repaired direction cannot reuse an older pose's cached pixels.
4. Review every direction at 1×/2×/3×: `--contact-sheet=/tmp/strip-{id}.png`.
   Regenerate one group with `--groups=<name> --force` when hands, hats, or
   props clip the cell, optionally narrowed with
   `--directions=north,west` to only the failing columns; leave a character
   strip-less rather than shipping a bad pose — the fallback is
   byte-identical. The v3 `wait` rows piloted on 2026-09-06 were rejected
   twice (the rigs re-drew the held staff or spear into a hand); plan 7.3's
   pose strips below replaced that route.
5. Author strip companions with `node scripts/sprites/author-roster-channels.mjs`
   (it covers sheet and strip from one profile) when the entry declares
   sidecars, then `npm run sprites:audit-refresh`.
6. Bump `style.assetVersion` once after the strip PNGs land.

### Pose strips: work, wait and sit (plan 7.3 / 7.1)

The `wait`, `strike`, `tinker`, `gaze` and `sit` groups are skeleton-v3 pose
strips on the work facings E/W/SE/SW, generated from the base sheet itself so
the feet stay on the V7 anchor:

1. `node scripts/sprites/generate-pose-strip.mjs --id=<id> --groups=strike,tinker,wait --clip --plan`
   quotes the job (a 15-frame clip bills 4 generations per direction, a
   3-frame `wait` alone 2). The first frame is the idle row-6 cell, only arm
   joints move (head, shoulders, hips, knees and ankles are copied), the
   profile's baked prop hand (`PROPS`) is frozen and the gesture is
   empty-handed. Keep object nouns out of `action` labels: the model draws
   them into every frame.
   Queued skeleton jobs save a `.job.json.pending` receipt before waiting
   (up to 60 minutes). After an interruption, rerun the same command to
   resume the paid job rather than queue it again; successful jobs replace
   the receipt with the completed cache.
2. `node scripts/sprites/feet-audit.mjs --id=<id> --strip=<stage png> --groups=<name:a-b,…> --contact-sheet=<png>`:
   feet within ±2 px, no new detached fragment ≥ 3 px, the non-arm identity
   diff under its cap (it reads the stage json's keypoints), and the `wait`
   hand ≥ 3 px above the head. Ship only groups whose four facings pass.
   A profile whose idle carries a detached prop (gpt54's floating wrench)
   fails identity when the model drops or moves it: re-cut the cached jobs at
   no cost with `--assemble-only --freeze-detached` (every non-body island is
   cleared and the idle cell's detached props are pasted back pixel-exact).
3. `node scripts/sprites/assemble-action-strip.mjs --id=<id> --stage=<stage png>[,<stage png>] [--groups=wait,strike]`
   rebuilds `actions.png` (the single writer; 7.1 sit stages are picked up
   from `output/waking-isle/Villagers/sit/`) and prints the `actionStrip`
   record (one group and one provenance key per line) to paste into
   `manifest.yaml`; then run step 5 above and `feet-audit.mjs --id=<id>` on
   the shipped strip.

The Phase C roster ships `wait`, `strike` and `tinker` on all 26 profiles,
plus `gaze` on the two pilots and eight most-seen profiles. The assembled
strips preserve 20 existing `read` groups and include 24 approved `sit`
groups. A work body and its downbeat share the cell-selection timestamp:
do not resample the wall clock in the overlay, or a cycle-boundary contact
flash can land on the previous wind-up frame.

The 7.1 rest seat uses the `sit-front` group on SE/SW only (settle + two held
samples, 2 generations per facing): `seatFrontSkeleton` drops hips, head and
shoulders onto the seat, turns the knees toward the camera with joint `depth`,
rests the free hands on the knees and keeps the prop hand still; detached idle
props (sparkles, a floating wrench) are frozen pixel-exact and every other
detached island is cleared. `--seat-front='{…}'` tunes a body family (slim
light-armour bodies need `hipDrop 1.15, kneeOut 0.45, kneeDown 0.6,
handAlong 0.9, kneeDepth 110, handDepth 60`), `--freeze=<facing>@x0,y0,x1,y1`
pins a planted prop (Sonnet's staff). Keep "bench" out of the prompt (the
model paints one). A reviewed candidate is staged as
`output/waking-isle/Villagers/sit/<id>.sit.png` (8 × 2 cells: settle, held)
plus `<id>.sit.json` (`groups.sit.hold`, per-facing `seatLine`, provenance),
judged over a bench front covering everything below `seatLine`, and audited
with `feet-audit.mjs --groups=sit:0-1 --reference=group --directions=se,sw`.

### Run gait strips (plan 7.5, deferred; recipe in OF-020)

No profile ships a `run` group yet: the 2026-09-29 pilot was deferred to
after the October 9 PixelLab reset ([OF-020](../../agents/plans/open-followups.md)).
The tooling is ready:

1. `node scripts/sprites/generate-pose-strip.mjs --id=<id> --groups=run-skel
   --directions=south,south-east,east,north-east,north,north-west,west,south-west
   --agent=<name> --item=7.5 --plan` quotes the `running-6-frames` template
   posed by `skeleton-v3` mode (≈ 3 generations per facing measured, 2–4
   documented). `--groups=run` is the plain `template` mode (1 per facing);
   the pilot rejected it for robed and caped profiles (props popping in,
   robes redrawn as trousers, capes coming and going). Both groups share the
   rig's `running-6-frames` animation type, so each facing's record is pinned
   by the animation group id in the stage json; a skeleton job can outlast
   `waitForCharacterAnimation`'s 6-minute stall guard, so rerun with
   `--assemble-only` once the record lands instead of requesting again.
2. Staging seats the cycle (`seatGait`): each facing drops by one amount so
   its most grounded frame stands on the base sheet's V7 foot line, then a
   flight frame floats at most `--gait-lift` px (default 2).
3. `feet-audit.mjs --id=<id> --strip=<stage png> --groups=run:0-5` audits
   `run` in gait mode: the planted-feet match does not apply to a cycle
   that lifts its feet, so per frame `dy` is the foot line against the
   anchor and `dx` the body's sideways hop (idle head band against the
   cycle median), both ±2 px; fragments as usual; `flicker` fails a frame
   whose colour histogram differs from the rest of its cycle by more than
   `--flicker-max` (default max(0.3, 1.5 × the profile's own worst walk
   frame)). Judge the contact sheet at z2 as well: cloth smear and a staff
   popping in pass the numbers.
4. `assemble-action-strip.mjs --stage=<stage png> --groups=run` appends the
   rows after `gaze` (a `run-skel` stage ships as group `run`) and records
   `provenance.templateStrips` (the animation mode and the animation group id
   per facing). The runtime has no `run` consumer yet: land the wiring in
   OF-020 with the first shipped strips.

## Manifest-Driven Bulk Bake + Contact Sheets

`scripts/sprites/bake-manifest.mjs` is the supported bulk-rebake path: it reads prompt, dimensions, and output path straight from `manifest.yaml` (`style.anchor` + entry prompt), calls REST pixflux, keys out the edge background, and writes the manifest-implied PNG. Building overlay layers are addressed as `--ids=building.<id>.<layerName>`. Raw API responses cache under `output/pixellab-cache/bake/`; `--force` ignores the cache, `--dry-run` prints the plan. Characters and terrain tilesets are out of scope (different generation surfaces).

After a batch, produce review evidence without opening individual files:

```bash
node scripts/sprites/bake-manifest.mjs --ids=prop.well,prop.runestone
node scripts/sprites/contact-sheet.mjs --groups=props   # or all families
```

Contact sheets land in `output/sprite-contact-sheets/<family>.png` (pngjs montage, manifest order, dark checkerboard so alpha reads). `scripts/sprites/pixellab-rest.mjs` holds the shared REST/key-out helpers for new bake scripts; `scripts/sprites/rehue-flowercart.mjs` is a single-purpose hue-mask re-hue used for plan 6.5.

## Material Sidecars And Deterministic Atlases

Material metadata is optional and must not change Canvas rendering. Read
[`docs/material-channel-contract.md`](../../docs/material-channel-contract.md)
before authoring a companion channel.

The committed `world-pilot` atlas uses a reviewed manifest ID list. It includes
all nine landmarks, representative light/water assets, and one Claude/Codex
class. Character sheets retain their 8-direction × 10-row frame tags; terrain
retains all 16 Wang masks. Building overlay layers follow their parent.

```bash
# Deterministic dry-run; no files written.
npm run sprites:atlas-plan -- --atlas=world-pilot

# Bake albedo + default/authored material, emissive, and occluder channels.
npm run sprites:atlas-bake -- --atlas=world-pilot

# Schema, source hash, dimensions, alpha bounds, matching rectangles, frame
# tags, nearest sampling, padding extrusion, and orphan checks.
npm run sprites:channels-validate
npm run sprites:validate

# Output-only visual evidence, one montage per channel.
npm run sprites:channels-contact-sheet -- --atlas=world-pilot
```

`atlas-bake` rejects an ad-hoc `--ids` override. Change `atlases[].ids` in the
manifest so broad membership is explicit and reviewable. Unchanged source PNGs
produce byte-stable channel PNGs and metadata; metadata contains no timestamp.

Absent individual sidecars use generated safe defaults and do not load a
checkerboard. To create a reviewed correction, paint exact rectangles/points:

```bash
npm run sprites:sidecar-mask-fix -- \
  --id=building.command \
  --channel=emissive \
  --paint=rect:80:127:7:10:#ffd98aff \
  --dry-run
```

Remove `--dry-run` only after checking the coordinates, add the matching
`materialSidecar`, `emissiveSidecar`, or `occluderSidecar` manifest opt-in, then
rebake and review the channel contact sheet. Do not use automatic luminance
thresholding as a substitute for authored emission.


## Smoke Before Bulk Work

Before broad regeneration, prove the pipeline with one low-risk asset:

1. Pick one manifest entry, usually a prop/status overlay with high visibility.
2. Call the Pixellab tool for only that entry.
3. Save the PNG to the manifest-implied path.
4. Verify with `file <path>` and `npm run sprites:validate`.
5. Review in the browser if the asset is visible in World mode.

For direct JSON-RPC smoke tests, the known-good sequence is:

```text
initialize -> tools/list -> tools/call(create_isometric_tile) -> poll get_isometric_tile -> curl --fail download
```

## Prioritizing Regeneration

Do not regenerate by manifest order. Rank candidates by runtime impact:

1. Missing PNGs for currently referenced manifest IDs.
2. Globally visible UI/status assets such as `overlay.status.selected`.
3. Size or shape mismatches against `manifest.yaml` and `SpriteSheet.js`.
4. Hero buildings and high-traffic props.
5. Decorative vegetation/atmosphere.

Do not treat `736x920` character sheets as suspicious by default. That is the expected size for 8 directions × 10 animation rows × 92px cells.

## Validation

Run after sprite changes:

```bash
npm run sprites:validate
```

The validator checks expected paths, orphan PNGs, duplicate PNGs, palette mirror parity, character-sheet shape/motion, equipment PNG dimensions, and atmosphere PNG dimensions. It also prints non-fatal warnings for: PNG dimensions that disagree with the manifest `size`/`width`/`height` declaration, a corner-alpha/fill-ratio "is it a cube?" heuristic on isolated-object sprites (would have caught the four shipped block-cube layers), and manifest ids with no code reference (dead inventory). It does not prove that an asset is artistically correct; inspect important regenerated assets in the browser or via `scripts/sprites/contact-sheet.mjs`.

For visual regression checks:

```bash
npm run dev
npm run sprites:capture-baseline   # once, when accepting a new local baseline
npm run sprites:capture-fresh
npm run sprites:visual-diff
```

`sprites:capture-baseline` and `sprites:capture-fresh` write to `scripts/sprites/baselines/`; `sprites:visual-diff` compares `<pose>.png` against `<pose>-fresh.png` in that directory. If the baseline directory or individual baseline images are missing, visual diff fails unless you pass `--allow-missing-baselines` directly to `scripts/sprites/visual-diff.mjs`.

If dependencies are unavailable and installing them is out of scope, use fallback validation:

```bash
file claudeville/assets/sprites/path/to/touched.png
```

Then inspect `manifest.yaml`, `AssetManager._pathFor()`, and browser output for checkerboard placeholders.

## Commit Hygiene

For broad sprite work, commit in small batches by category or runtime impact. Do not mix generated PNGs with renderer code unless both are required for the same visible behavior.
