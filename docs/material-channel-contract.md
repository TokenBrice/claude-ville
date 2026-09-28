# Semantic Drawable, Material, and Atlas Contract

This contract feeds the GPU-resident WebGL2 World renderer, which is the default;
`?renderer=canvas` selects the Canvas-2D fallback.
Albedo PNGs remain authoritative. Material data, sidecars, atlases, and GPU
records are optional and use deterministic defaults.

## Runtime Invariants

- Canvas mode loads and draws the original albedo paths exactly as before.
- `AssetManager` only loads atlases and companion channels after an explicit
  `loadMaterialAssets()` call or `new AssetManager(path, { materialAssets: true })`.
- A missing optional sidecar or atlas never loads the checker placeholder.
- Albedo and every channel use nearest sampling. One authored albedo pixel stays
  one sampled renderer pixel at integer zoom tiers.
- Labels, bubbles, primary marks, and debug UI remain outside material grading.
- Material response is palette-stepped, not smooth PBR shading.

## Semantic Drawable Record

`DrawablePass.createDepthDrawable()` preserves the legacy `draw()` method and
adds the following fields:

```js
{
  kind,
  sortY,
  sortBand,
  stableKey,
  salience,       // primary | recent | working | ambient
  materialId,
  materialClass,
  elevation,
  emissive,
  occluder,
  atlasFrame,
  drawFallback(ctx, zoom, context),
  buildGpuRecord(context),
}
```

`draw` remains an alias of `drawFallback`; existing Canvas call sites do not
change. `buildGpuRecordsFromDrawables()` walks the already-sorted stream and
adds `drawOrder` without reordering painter semantics. Future batching may only
combine consecutive compatible records.

`summarizeDrawableLayers()` exposes counts by material plus GPU-ready,
emissive, and occluder counts for Shift-D integration. `AssetManager` exposes a
more detailed `materialDebugSnapshot()`; neither seam draws UI by itself.

## Material Vocabulary

Stable material classes, in numeric encoding order, are:

| Index | Class | Intended response |
| ---: | --- | --- |
| 0 | `unlit` | Safe default; albedo only |
| 1 | `stone` | Restrained key light, modest wetness |
| 2 | `timber` | Warm, low reflection |
| 3 | `metal` | Strong stepped key response |
| 4 | `foliage` | Wet receiving surface, low reflection |
| 5 | `fabric` | Soft response |
| 6 | `earth` | Matte, darkens when wet |
| 7 | `cobble` | Wet receiving surface |
| 8 | `water` | Reflection-eligible, non-occluding |
| 9 | `glass-rune` | Reflective and optionally emissive |
| 10 | `fire` | Semantic emission, no key-light response |

Append new classes; never reorder these indices. The authored key convention is
warm light from screen upper-left. The direct GPU renderer currently reaches two restrained material-wide response bands, `0.86 / 1.00`; it does not infer roof or wall normals.

## Manifest Fields

All fields are optional for ordinary assets:

```yaml
materialClass: stone
atlasFrame: { atlas: world-pilot, key: building.command }
elevation: { base: 0, top: 240, unit: sprite-px }
emissive:
  strength: 1
  sources:
    - { id: emissive.command.windows, kind: windows, geometry: registry.windowRects, strength: 0.72 }
    - { id: emissive.command.braziers, kind: fire, geometry: emitters.torch, strength: 1 }
occluder: { mode: alpha-silhouette, strength: 1, horizonY: 112 }

# Only add these after the companion PNG exists and was reviewed:
materialSidecar: true
emissiveSidecar: true
occluderSidecar: true
```

Every emissive source needs a stable semantic `id`. `BuildingVisualRegistry`
owns landmark geometry such as windows and effect anchors; light placement
remains under `LightSourceRegistry`/building light records.

### Companion Paths

`true` derives a companion path beside albedo:

| Albedo | Channel | Derived path |
| --- | --- | --- |
| `buildings/building.command/base.png` | emissive | `base.emissive.png` |
| `characters/agent.claude.opus/sheet.png` | material | `sheet.material.png` |
| `terrain/terrain.shore-shallow/sheet.png` | occluder | `sheet.occluder.png` |

A string value is an explicit path. Absent/false means “use generated defaults,”
not “load a missing file.” Sidecars must exactly match albedo dimensions and may
not extend alpha beyond albedo.

## Channel Encoding

The committed pilot atlas has identical rectangles and padding in every channel:

- `albedo`: original RGBA pixels.
- `material`: R = stable material-class index; G/B reserved; A = albedo alpha.
- `emissive`: authored RGB with A as contribution; transparent black by default.
- `occluder`: R = authored height (zero in the flat default), G = occlusion
  strength, B = surface code (V9, below), A = albedo alpha. `mode: none` is
  transparent.

The direct GPU renderer samples the occluder companion separately from the raw
material map. Material alpha also marks presence: opaque class zero is authored unlit, not the provider fallback. Nonzero occluder companion alpha explicitly marks authored geometry:
R (including zero) overrides default elevation; G overrides default occlusion
strength. Uncovered pixels use record defaults. Default strength is per vertex,
never a batch-wide height floor. Agent geometry follows the same atlas slots and
update cadence as albedo, including padded equipped Codex frames.

Generated emissive defaults come only from named semantic sources and existing
window/light anchors. The tooling does not infer emission from luminance.

Every building except the Portal now ships an authored `base.emissive.png`
(Command, Observatory, Archive, Forge, Mine, Task board, Harbor, and the
Lighthouse `building.watchtower`); lit panes live only in the sidecar and the
albedo keeps dark glass, so a building is never lit by day or by an empty
night. Prefer an authored sidecar: `scripts/sprites/atlas-bake.mjs` reads a
`registry.windowRects` entry's `at` as the rectangle's top-left corner, while
`BuildingSprite` and the window tests treat it as the centre, so generated
window emission lands off the panes for any building without a sidecar.

Each frame has a two-pixel extruded gutter to prevent atlas bleeding. Runtime
sampling is still nearest; gutters protect edge texels when future passes sample
near frame boundaries.

## V9 GPU Record Layout, Samplers, Typed Uploads and Channels

The resident renderer draws **one instance per record**
(`drawArraysInstanced(TRIANGLE_STRIP, 0, 4, n)`, every attribute at divisor 1,
the strip corner from `gl_VertexID`). WebGL2 has no base instance, so each batch
re-points its attributes at its own byte range (`_pointRecordInstances`).

| Loc | Type | Fields | Bytes |
| --- | --- | --- | --- |
| 0 | `FLOAT x4` | rect `(x, y, w, h)`, world px | 0-15 |
| 1 | `FLOAT x4` | uv rect `(u0, v0, u1, v1)` | 16-31 |
| 2 | `FLOAT x4` | `(alpha, material, elevation, emissive)` | 32-47 |
| 3 | `USHORT x4` | `(occluder x 65535, gate x 65535, ramp, flags)` | 48-55 |
| 4 | `USHORT x4` | `(depth key, footY, frontCornerX, frontCornerY)`; receiver coordinates are integer world px + 32768 | 56-63 |
| 5 | `USHORT x2`, `vertexAttribIPointer`, flat | `(ownerSlot, landmarkId)` | 64-67 |

Continuous values stay float32, so the instanced frame is hash-identical with the
six-vertex staging it replaced. A batch whose records all hold the default tail
(locs 3-5: no occluder, gate 1, no ramp or flags, depth key 0, footY -1,
frontCorner `(0, -1)`, no identity) stages the 48-byte head only and reads the
tail as constant generic attributes: terrain, ground casts and marks, and every
ground-cue chord. The occlusion pass draws the same ranges and culls
non-occluders in its vertex stage (no second staging).

- **Flags** (`GPU_RECORD_FLAGS`, loc3.w): 1 `writesDepth`, 2 `reflect`
  (3.11), 4 `fatOptOut` (4.6), 8 `screenSpace` (haze, `ground:semantics`),
  16 `surfaceCode` (reserved for 2.3), 32 `packedGeometry` (reserved for B.2).
- **Painter depth** (0.6): `depthKey = round((clamp(sortY) + 2048) x 8)`, i.e.
  sortY clamped to [-2048, 6143.875] at 1/8 world px, exactly the 65,536 steps of
  the `DEPTH_COMPONENT16` attachment (`gpuDepthKey`). Shaders write
  `depth = 1 - key / 65535`; key 0 is the cleared far plane. `writesDepth` is the
  writer's per-kind opt-in (buildings, props, bodies via
  `GpuSceneBuilder.stampPainterDepth`); soft alpha (< 1, e.g. departed bodies at
  0.58, archive fades) and additive blending never write; terrain, haze, ground
  and cue records never write. `writesDepth` joins the batch key.
- **Receiver fields** (V5): `footY` defaults to the painter sortY, `-1` = ground
  self; `frontCornerY -1` = no landmark corner (2.1 fills landmarks);
  `landmarkId` = `GPU_LANDMARK_IDS` (command 1 … portal 9, 0 = none, never
  reordered; 2.2's footprint G uses the same ids); `ownerSlot` 0 = none (2.5
  assigns agents).
- **Shader-derived**: `originFrac = fract(rect.xy)` for sprite records (0 for
  ground-self and screen-space records): pool courses quantize from the
  record's own texel grid, so a body on the backing-pixel grid lights in whole
  k x k blocks. The record-rect clamp keeps every sample inside the record's
  source rect, inset half a texel but never past its centre.
- Every writer supplies these defaults: `normalizeGpuRecord`
  (`assignGpuRecordV9Fields`) for ordinary records, and the literal pool in
  `GroundCueRecords` for `prenormalized` cues.

**Sampler table** (fixed per program, never reassigned; WebGL2 guarantees 16
fragment units). Scene and occlusion programs (`SCENE_SAMPLER_UNITS`):

| Unit | Field | Format | Reader |
| ---: | --- | --- | --- |
| 0 | albedo | RGBA8 | every record |
| 1 | material | RGBA8 | every record |
| 2 | occlusion target | RGBA8 | light loop (2.2 deletes it and frees the unit) |
| 3 | emissive | RGBA8 | every record |
| 4 | occluder companion | RGBA8 | every record |
| 5 | palette-ramp LUT | RGBA8 | 3.5 pilot |
| 6 | footprint height + landmark id | RG8 | reserved: 2.2 |
| 7 | water cycle offset | R8 | reserved: 3.1 (terrain/water only) |
| 8 | coast field | RG8 | reserved: 3.6 (terrain/water only) |
| 9 | light records | RGBA32F | reserved: 2.4 |
| 10 | light tile index | R16UI (`usampler2D`) | reserved: 2.4 |
| 11 | puddle mask | R8 | reserved: 5.2 (ground only) |
| 12 | cloud-course noise tile | RGBA8 (linear) | 1.4 cloud courses + 1.6 aerial haze, per record |
| 13-15 | free | | |

Particle program (`PARTICLE_SAMPLER_UNITS`): 0 = event-shape motif mask (R8),
1 = cloud-course noise tile. Composite: 0 scene, 1 bloom (clouds and haze are
shaded per record, never on the world grid in the composite). `SCENE_FRAGMENT` stays one program:
the table fits one unit budget, and a terrain/water split would need a uniform
buffer to avoid uploading the grade and 32 lights twice per frame; the
terrain/water-only units are marked so a split stays mechanical.

**Typed uploads**: `GpuWorldRenderer.uploadTypedTexture(key, { width, height,
format, data, revision })` takes `r8`/`rg8` (`Uint8Array`), `r16ui`
(`Uint16Array`, read through `usampler2D`) and `rgba32f` (`Float32Array`) with
`UNPACK_ALIGNMENT 1`, nearest sampling and `texelFetch`; it re-uploads only on
a revision or size change (`texSubImage2D` when the size holds). Every cache
entry counts its real bytes (`width x height x bytesPerTexel`), so the 48 MiB
cached-source ceiling and Shift-D see an R8 field at a quarter of an RGBA
canvas. First consumer: the particle motif mask.

**One occluder channel contract** (before 2.3 or B.2 lands):

- Occluder companion: R = height (today the authored elevation that drives fog
  and the occlusion trace; 2.3 makes it true height above ground / 255 and
  retunes the fog in the same change), G = occlusion strength, **B = surface
  code `face x 64 + min(63, round(heightAboveGround / 4))`** (face 0 up/apron,
  1 left wall, 2 right wall, 3 roof), A = presence. B is read only on records
  with flag 16 `surfaceCode`; everywhere else it must be 0 and is ignored.
- B.2's merged material + geometry packing (R material id, G height, B
  strength, A presence) lives in the **material** map, never the occluder
  companion, and is read only on records with flag 32 `packedGeometry`. A source
  that carries 2.3 surface codes keeps the separate occluder companion, so the
  two B channels never collide.

## Grade, Light Pools, and Emission

The direct GPU renderer applies the time-of-day and weather grade (contract C2
of the aesthetic plan, `GradeEvaluator.evaluateGrade`, shader `GRADE_GLSL`) to
each albedo fragment in the scene pass, before the light loop. Local lights then
multiply the graded albedo in three stepped courses (rim, mid, core on each
light's own falloff; warm lights take the reserved emissive ramp), and authored
emission is added after both. Emissive pixels and lit pools are therefore exempt
from the night desaturation without a separate lit mask, and `fire` pixels keep
their authored colour at every hour. The Canvas fallback reproduces the same
order with composite fills (`CanvasGrade.js`). Emission sidecars are gated at
runtime by `NightOccupancyGate`, so a lit window means real work inside.

The offline analyzer (`npm run art:analyze`) treats pixels lit in an
`.emissive.png` sidecar, and `fire`/unlit/light layers, as allowed Tier-A
brightness; any other Tier-A pixel is reported as palette misuse.

## Frame Contracts

- Characters retain 8 directions (`s,se,e,ne,n,nw,w,sw`) and 10 rows: six
  `walk` frames followed by four `idle` frames. Atlas keys are
  `<id>/<animation>/<direction>/<frame>`.
- Terrain retains the 4x4 Wang layout. Keys are `<id>/wang/<mask>`.
- Building overlay layers use `<building-id>.<layer-name>`.
- Single sprites keep their stable manifest ID as the frame key.
- Metadata preserves source path/dimensions/hash, anchor, structure mask,
  material class, semantic tags, and deterministic pack order. It contains no
  timestamp, so unchanged inputs produce byte-stable JSON and PNGs.

## Action Strips (contract C2)

A character entry may declare one optional *action strip*: a separate PNG of
8 direction columns × N rows of the **same engine cell as the base sheet**
(92 px, same anchor and feet), holding authored poses the base sheet has no rows
for. The base sheet is never widened and never repurposed.

```yaml
actionStrip:
  path: characters/agent.claude.sonnet/actions.png   # sprites-root relative
  cell: 92
  groups:                                            # named, never identified by frame count
    read: { rows: [0, 3], hold: 3 }                  # hold = most legible static row
    wait: { rows: [4, 4], hold: 4 }                  # single held row
  grip: { hand: both, sheathe: true }                # right | left | both
  provenance: { characterId: <pixellab id>, animationGroupId: <id>, generationSize: 144 }
```

- Row ranges are inclusive, may not overlap, and must fall inside the PNG's real
  row count; `hold` must be a row of its own group. `provenance.generationSize`
  is the source rig's export canvas (16–256 px), which is what v3 animation is
  billed and assembled at — not the character entry's `generationSize` request.
- `SpriteSheet.resolveActionFrame(sheetMeta, group, direction, frame)` returns
  `{sx, sy, sw, sh}` or **null**; `frame` is group-relative and wraps, or the
  literal `'hold'`. `AssetManager.getActionStrip(id)` returns
  `{ image, meta, path, channels, generation }` or **null**. Null on either seam means the
  caller keeps its existing procedural overlay, so a strip-less character renders
  byte-identically.
- Strips load lazily per demanded character through the existing character-demand
  path, after the base sheet is already drawable, and are priced in
  `cacheStats()` (`actionStrips`, `actionStripPixels`) like every other decoded
  image. A malformed or mis-sized strip is recorded as an optional load miss and
  left unloaded.
- Companion channels are optional and follow the ordinary sidecar rules against
  the *strip* path (`actions.material.png` …), driven by the character entry's
  existing `materialSidecar`/`emissiveSidecar`/`occluderSidecar` declarations.
  `node scripts/sprites/author-roster-channels.mjs` authors sheet and strip
  companions from the same reviewed colour classification; a companion whose
  dimensions disagree with the strip is refused.
- Production: `node scripts/sprites/generate-action-strip.mjs --ids=<id> --plan`
  quotes the live balance and per-direction generations; without `--plan` it
  requests one named v3 group at a time (Tier 1 allows 8 concurrent background
  jobs, and one 8-direction group fills them), assembles the strip, and records
  the manifest `actionStrip` block.

## Pilot

`world-pilot` covers 18 reviewed IDs: all nine landmarks; lantern, rune brazier,
and three light overlays; shallow/deep water transitions; one Claude class; and
one Codex class. Building overlay layers are included with their parent. No
individual sidecar PNG is required for the pilot.

## Tooling

```bash
# Review deterministic layout; writes nothing.
npm run sprites:atlas-plan -- --atlas=world-pilot

# Rebuild committed atlas channels and metadata from existing source PNGs.
npm run sprites:atlas-bake -- --atlas=world-pilot

# Validate schema, dimensions, anchors, hashes, alpha bounds, frame tags,
# matching rectangles, nearest gutters, and orphan/missing channels.
npm run sprites:channels-validate
npm run sprites:validate

# Produce output-only channel review sheets.
npm run sprites:channels-contact-sheet -- --atlas=world-pilot
```

Broad atlas membership is opt-in through the reviewed `atlases[].ids` list in
`manifest.yaml`. `atlas-bake` deliberately rejects an ad-hoc `--ids` override.

For a precise manual correction, paint explicit pixels or rectangles rather
than auto-thresholding luminance:

```bash
npm run sprites:sidecar-mask-fix -- \
  --id=building.command \
  --channel=emissive \
  --paint=rect:80:127:7:10:#ffd98aff \
  --dry-run
```

Remove `--dry-run` only after reviewing the target and then add the matching
`<channel>Sidecar: true` manifest opt-in. Re-bake, validate, and inspect the
channel contact sheet before committing a sidecar.
