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
update cadence as albedo, including padded equipped Codex frames; since B.2 it
rides the packed geometry map (below) instead of an occluder atlas.

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

The layout below has one owner, `gpu/GpuRecordLayout.js`, so every world
backend stages from the same bytes: `RECORD_LAYOUT` / `RECORD_OFFSETS` (field
byte offsets), `RECORD_HEAD_BYTES` 48, `RECORD_INSTANCE_BYTES` 68,
`recordHasDefaultTail`, `writeGpuRecordInstance(f32, u16, byteOffset, record,
tail)` and `stageGpuRecords(batches, staging, { fullTail })` (one growable
buffer from `createRecordStaging()`; sets each batch's `tail`, `cueRuns`,
`instanceOffset`, `count`; `fullTail` stages every record at 68 bytes for a
backend with base-instance draws). `assertRecordStride(stride)` checks the
field table tiles the record at module load and rejects any other stride: a
WebGPU storage struct must use scalar lanes (stride 68), never `vec4` lanes
(stride 80). The uint16 pairs are little-endian, so a reader of 32-bit lanes
takes each lane's low half first.

| Loc | Type | Fields | Bytes |
| --- | --- | --- | --- |
| 0 | `FLOAT x4` | rect `(x, y, w, h)`, world px (backing px, top-left origin, for a `screenSpace` record) | 0-15 |
| 1 | `FLOAT x4` | uv rect `(u0, v0, u1, v1)`; a paged record's rect addresses its slot in its page layer | 16-31 |
| 2 | `FLOAT x4` | `(alpha, material, elevation, emissive)` | 32-47 |
| 3 | `USHORT x4` | `(page layer, gate x 65535, ramp, flags)` | 48-55 |
| 4 | `USHORT x4` | `(depth key, footY, frontCornerX, frontCornerY)`; receiver coordinates are integer world px + 32768 | 56-63 |
| 5 | `USHORT x2`, `vertexAttribIPointer`, flat | `(ownerSlot, landmarkId)` | 64-67 |

Continuous values stay float32, so the instanced frame is hash-identical with the
six-vertex staging it replaced. A batch whose records all hold the default tail
(locs 3-5: page layer 0, gate 1, no ramp or flags, depth key 0, footY -1,
frontCorner `(0, -1)`, no identity) stages the 48-byte head only and reads the
tail as constant generic attributes: terrain, ground marks and every
ground-cue chord. A cue batch holding dot runs and a batch holding building or
tree ground casts stage the tail (their flags).

- **Flags** (`GPU_RECORD_FLAGS`, loc3.w): 1 `writesDepth`, 2 `reflect`
  (3.11), 4 `fatOptOut` (4.6), 8 `screenSpace` (Wave 10 S5: loc0 is in
  backing pixels and the vertex stage passes it straight through, skipping
  world→screen, so camera pan and zoom never move it; only the T1 mark
  records carry it — see below), 16 `surfaceCode` (2.3: occluder B is the
  surface code, R true height),
  32 `packedGeometry` (B.2), 64 `receiverAxis` (3.8: an upright prop turning
  round a vertical axis), 128 `cueRun` (B.3: a ground-cue dot run; loc1
  holds four packed 24-bit integer words, not UVs, and the batch draws
  `CUE_RUN_VERTICES` vertices per instance so the vertex stage rebuilds each
  dot's own rect and swatch uv, `GroundCueRecords.CUE_RUN_GLSL`), 256
  `groundCast` (2.9: a building or tree ground cast; over painted water,
  coast flag `water` and not `covered`, the scene fragment keeps
  `RakingLight.GROUND_CAST_WATER_SHARE` of it and breaks it by the water
  column's ripple rows), 512 `actionMark` (Wave 10 S5: a mark record's
  role 2 — a T1 mark or the C4 verified-success peak frame).
- **T1 mark records** (Wave 10 S5, WebGPU contract §7.4): `AttentionPlates
  .attentionMarkRecords(layout, { scale })` turns an attention layout's
  graphical pixels into prenormalized V9 records in the overlay's draw order —
  leaders, beacons, then per plate its rim, status cell, text cell and notch
  or edge arrow — at `scale` (the overlay's integer device scale) in backing
  pixels, all `screenSpace`. Fills sample one texel of a small ink atlas
  (`mark:inks`: plate outline, plate, the three status colours, the C4 peak
  cream); a beacon is two stamp records over the same origin, its silhouette
  in the outline ink and then only its colour pixels
  (`WorldLabelKit.outlinedMotifStamp` with a `transparent` outline), which
  together are exactly the stamp the overlay
  blits. `GpuWorldRenderer.render({ …, marks })` draws them after the
  composite, straight onto the presented frame (`MARK_FRAGMENT`: the texel,
  premultiplied, source-over), so no grade, fog, flash, bloom or particle
  touches them; `markRecords` / `markRoleRecords` report the frame's count.
  When every mark drew, the overlay prints only the ink
  (`drawAttentionPlates(ctx, layout, { inkOnly: true })` clears each graphic's
  footprint at the plates' slot, then draws the word, name and time), so the
  page is byte-identical to the overlay-only path. Canvas, a non-integer DPR
  or a GPU backing that is not the overlay's keep the overlay plates.
- **Roles** (Wave 10 plan items 10.2 / 10.3, M1): 0 none, 1 building/prop
  emitter, 2 action-needed mark (and the C4 verified-success cream peak
  frame). Roles exist only on an HDR or P3 screen; the SDR path never reads
  or writes one.
  - *Role 2* rides a mark record's flags (`actionMark`): only the
    status-colour pixels — the plate status cell, the notch's status rows and
    each beacon's colour stamp. The rim, text cell, leader, the beacon's
    outline stamp and the edge arrow are dark inks and role 0, so no gain
    ever lifts an ink. Role 2 never enters the scene MRT: the mark pass draws
    after the composite and its roles fragment (`markRolesFs`, WebGPU;
    `MARK_P3_FRAGMENT`, WebGL2 P3) applies the mark gain per record
    (`oetf(eotf(c) * markGain)` under HDR) and the P3 role chroma.
  - *The C4 verified-success peak frame* is role 2 for one art frame, the
    80 ms C4 peak phase (several display frames: 4–5 at 60 Hz, 9–10 at
    120 Hz; not one display frame) (10.2): the release crown's cream frame,
    its sloop's cream sail rim and, when the crown docks at the edge, the
    `RELEASE` plate's cream cell. On
    the resident path (an integer device scale, the overlay's backing size)
    `WorldFrameRenderer` arms the overlay (`EffectStamps.armPeakMarks`); the
    peak frame hands each whole-texel cream run to `peakMarkSink`, which
    clears it from the overlay and keeps its backing-px rect, and after the
    edge plates the rects become `mark:inks` peak-cream records
    (`AttentionPlates.inkMarkRecords`, `screenSpace | actionMark`) drawn in a
    late mark pass on the same presented frame (`drawLateMarks`, both
    backends), followed by the frame's T1 mark records again so the plates
    stay above the moment as the overlay stacks them. Overlay content drawn
    after the moment stays on top; what it drew before is cleared exactly
    where the cream covered it, so the SDR page is byte-identical to the
    overlay-only path. A transform off the whole-pixel grid, the Canvas
    renderer, follow frames, residues and every other moment's cream stay on
    the overlay; a late pass that draws fewer records than it was given
    repaints the cream on the overlay. `lateMarkRecords` /
    `lateMarkRoleRecords` report the frame's late pass.
  - *Role 1* rides the emission attachment's alpha. It is staged through the
    blend state, not the fragment: on an HDR/P3 screen the scene and particle
    pipelines take the role variants (`GpuWgpuPipelines.BLEND_NORMAL_ROLE` /
    `BLEND_ADD_ROLE`: colour exactly as Stage A, alpha `src.a × constant +
    dst.a × (1 − src.a)`, additive batches never change it) and the pass's
    blend constant is 1 for a batch with an authored emissive sidecar whose
    records carry no owner slot (a building or prop, never a character), 0
    otherwise, so a covering fragment writes its batch's role and the
    emission colour is untouched (bloom reads the same bytes). The emission
    target is `rgba16float` only while HDR presents (8-bit otherwise). The
    roles composite (`compositeRolesFs`) treats a pixel as role 1 when its
    emission alpha is ≥ 0.5 and its emission luma reaches the first course
    (0.10). WebGL2's P3 twin reads the same channel: on a P3 screen its
    scene pass writes the emission MRT every frame (bloom or not) and
    stages the role in attachment 1's alpha with `OES_draw_buffers_indexed`
    (`blendFuncSeparateiOES(1, ONE, ONE_MINUS_SRC_ALPHA, CONSTANT_ALPHA,
    ONE_MINUS_SRC_ALPHA)`, additive `ZERO, ONE` for alpha; `blendColor` alpha
    = the batch role); without the extension no WebGL2 pixel is role 1.
  - *Gains* (`DisplayColor.hdrGainTable`): emitter courses at emission luma
    0.10 / 0.30 / 0.55 gain 1 + (peak − 1) × 0.35 / 0.65 / 1.0 (peak 1.5
    subtle, 2.0 full) while the lamps are lit (`settling` lamp course);
    marks gain peak + `HDR_MARKS_ABOVE_EMITTER` (0.5): 2.0 subtle, 2.5 full.
    An emitter pixel's gain stops where its linear luminance (in the canvas's
    own primaries) would pass `emitterCap` — the NEEDS YOU hue
    (`HDR_CAP_MARK_HUE`, `#e8d44d`) at the mark gain less
    `HDR_EMITTER_CAP_MARGIN` (0.02): 1.276 subtle, 1.599 full, the frame
    uniform `hdrEmitterCap` — so no emitter outshines the primary action
    mark; the cap is at least SDR white, so the gain never falls below 1.
    It is a per-mode constant, whatever marks are on screen. The absolute
    ordering holds against the NEEDS YOU hue; darker marks (the error red,
    the limit violet) keep only the gain ordering, since outranking a white
    flame core in light would dim the core below its SDR value.
    Under HDR bloom is off, and every non-role pixel holds the 8-bit value
    the SDR canvas would store.
  - *P3*: every pixel becomes Display P3 numbers for the same colour; role
    pixels gain OKLab chroma ×1.22 at their own OKLab lightness and hue,
    bisected back inside the P3 gamut. The overlay's reserved-hue inks
    (`config/p3Variants.js`) are generated by the same mapping
    (`DisplayColor.p3RoleInk`), so a hue drawn as a GPU mark and as an
    overlay or Canvas ink lands on the same P3 colour (within 1 LSB).
- **Albedo page** (B.1b, `GpuAlbedoPage.js`, unit 14): one `TEXTURE_2D_ARRAY`
  of 1024² RGBA8 layers (at most 6; 3 at dense-100) holding the sources of
  sidecar-less records (`gpuRecordPageable`: no material, emissive or occluder
  source, no sidecar key, not screen-space nor `pageable: false` — the
  world-px field layers: ground haze, fog, `ground:semantics` — a whole-source rect of a source at
  most 1022 px a side): tree lean frames, tree and building ground casts, agent
  ground stamps (contact shadows, 2.8 point casts, rings), static prop caches,
  and the agent frame atlas while it has no channel atlas. loc3.x carries the
  record's layer (0 for every unpaged record; its only earlier reader, the
  screen occlusion pass, was deleted by 2.2) and its uv rect addresses its
  shelf-packed slot (2 px transparent gutter right and below). Paged records
  batch by page, so consecutive trees, casts, stamps, props and bodies share
  one draw; records with sidecars keep their own 2D textures and break on
  texture as before. Each slot uploads through a scratch 2D texture and a GPU
  copy (`copyTexSubImage3D`), so its texels equal the 2D path's byte for byte
  (a direct canvas `texSubImage3D` un-premultiplies differently). A frame whose
  sources do not fit repacks the page once (reallocated at the layer count its
  live set needs at ≤ 60 % fill, slots dropped, the frame batched again); a
  90-frame cooldown keeps an over-full page on the 2D path instead of
  thrashing. Every albedo read in `SCENE_FRAGMENT` goes through
  `albedoTexture(uv)`, `albedoTexel(ivec2)` and `albedoSize()`; a texel clamp
  is always the record rect (`v_uvClamp`), never the texture size.
- **Painter depth** (0.6): `depthKey = round((clamp(sortY) + 2048) x 8)`, i.e.
  sortY clamped to [-2048, 6143.875] at 1/8 world px, exactly the 65,536 steps of
  the `DEPTH_COMPONENT16` attachment (`gpuDepthKey`). Shaders write
  `depth = 1 - key / 65535`; key 0 is the cleared far plane. `writesDepth` is the
  writer's per-kind opt-in (buildings, props, bodies via
  `GpuSceneBuilder.stampPainterDepth`); soft alpha (< 1, e.g. departed bodies at
  0.58, archive fades) and additive blending never write; terrain, haze, ground
  and cue records never write. `writesDepth` joins the batch key.
- **Receiver fields** (V5, read by the 2.1 light loop): `footY` defaults to the
  painter sortY, `-1` = ground self (terrain, casts, marks, cues face up at
  their own point); props and bodies set their own ground line. Landmarks set
  `frontCornerX/Y` to their footprint's front corner: a pixel above the front
  edges is a wall facing its side's face (±0.7071, 0.7071), a pixel in front
  of them an apron lit as ground, unless flag 16 supplies the authored surface
  code. A body (`ownerSlot` > 0) keeps `frontCornerY -1` and carries its
  vertical axis in `frontCornerX` (the lamp-side fill wraps round it).
  `landmarkId` = `GPU_LANDMARK_IDS` (command 1 … portal 9, 0 = none, never
  reordered; 2.2's footprint G uses the same ids, and the march never blocks
  on the receiver's or the light's own landmark); `ownerSlot` 0 = none, else
  `LightSourceRegistry.ownerSlotFor(agentId)`, the integer an attention light
  compares (2.5).
- **Shader-derived**: `originFrac = fract(rect.xy)` for sprite records (0 for
  ground-self and screen-space records): pool courses quantize from the
  record's own texel grid, so a body on the backing-pixel grid lights in whole
  k x k blocks. The record-rect clamp keeps every sample inside the record's
  source rect, inset half a texel but never past its centre.
- Every writer supplies these defaults: `normalizeGpuRecord`
  (`assignGpuRecordV9Fields`) for ordinary records, and the literal pool in
  `GroundCueRecords` for `prenormalized` cues.

**Sampler table** (fixed per program, never reassigned; WebGL2 guarantees 16
fragment units). Scene program (`SCENE_SAMPLER_UNITS`):

| Unit | Field | Format | Reader |
| ---: | --- | --- | --- |
| 0 | albedo | RGBA8 | every unpaged record |
| 1 | material | RGBA8 | every record |
| 2 | free | | (2.2 deleted the screen occlusion target) |
| 3 | emissive | RGBA8 | every record |
| 4 | occluder companion | RGBA8 | every record |
| 5 | palette-ramp LUT | RGBA8 | 3.5 pilot |
| 6 | footprint height + landmark id | RG8 | 2.2 light loop: the footprint march (`FootprintField.js`, 704x384, 4 world px/texel) |
| 7 | water cycle offset | R8 | reserved: 3.1 (terrain/water only) |
| 8 | coast field | RG8 | reserved: 3.6 (terrain/water only) |
| 9 | light records | RGBA32F, 256 x 4 (`highp sampler2D`, `texelFetch`) | 2.4 light loop: admitted light i is column i; row 0 (foot x, foot y, ground radius, intensity) world px, row 1 (emitter height, face normal nx, ng, role code 0 point / 1 aperture / 2 fixture / 3 attention), row 2 (shader rgb, envelope share), row 3 (owner slot, landmark id, `LIGHT_RECORD_FLAGS` 1 wet reflection / 2 water column / 4 water only, column reach). 16 KiB baseline, uploaded only on change |
| 10 | light tile index | R16UI (`highp usampler2D`), tilesX*17 x tilesY | 2.4 clustered walk (`light-clusters` on): per 64x64 backing-px tile (tx, ty), texel (tx*17, ty) = count (<= 16), the next `count` texels the admitted light indices in admission order; a 1x1 zero texture when the flat walk runs. 57,596 B at 4880x1392 |
| 11 | puddle mask | R8 | reserved: 5.2 (ground only) |
| 12 | cloud-course noise tile | RGBA8 (linear) | 1.4 cloud courses + 1.6 aerial haze, per record; 3.4 sunlit course on in-map open water |
| 13 | C-W3 sea gust field | R8 (linear) | 3.4 cat's paws on in-map open water (the composite's own field, one upload per frame) |
| 14 | albedo page | RGBA8 `TEXTURE_2D_ARRAY` (`highp sampler2DArray`, also read by the vertex stage for the rect clamp) | B.1b: every paged record, layer at loc3.x |
| 15 | ground radiance | RGBA16F (filtered), 528 x 192: three 176 x 192 probe panels | 2.10 pilot (`GroundRadiance`, `radiance-bounce`, off by default; `gpuWorld.setRadianceOverride`): panel 0 fluence, 1 light arriving from the SW, 2 from the SE, one texel per 16 ground units (world x, world y x 2) over the footprint rect; rgb everything (bounce + ground-level openings), a the openings' fans alone (luma). Read at the receiver's foot, only where no direct course lands; the empty texture and `u_radianceGrid.w` 0 when off. 4,071,424 B with its scene, cascade and emitter targets, released whenever off |

Particle program (`PARTICLE_SAMPLER_UNITS`): 0 = event-shape motif mask (R8),
1 = cloud-course noise tile. Composite (`COMPOSITE_SAMPLER_UNITS`): 0 scene,
1 bloom, 2 cloud-course noise tile, 3 sea gust field (the open sea's clouds,
sunlit course and cat's paws on the world grid; the island's clouds and haze
are shaded per record). `uploadTypedTexture` restores the active unit's
binding, so an upload never blanks a sampler a caller already bound. `SCENE_FRAGMENT` stays one program:
the table fits one unit budget, and a terrain/water split would need a uniform
buffer to avoid uploading the grade twice per frame (the lights live in units
9/10 since 2.4); the terrain/water-only units are marked so a split stays
mechanical. Admission (`GpuWorldPolicy.binGpuLights`) bins every light's
conservative reach rect (`lightReachRect`) into the tiles before either walk,
so the clustered and the flat walk light the identical set of pixels.

**Typed uploads**: `GpuWorldRenderer.uploadTypedTexture(key, { width, height,
format, data, revision })` takes `r8`/`rg8` (`Uint8Array`), `r16ui`
(`Uint16Array`, read through `usampler2D`) and `rgba32f` (`Float32Array`) with
`UNPACK_ALIGNMENT 1`, nearest sampling and `texelFetch`; it re-uploads only on
a revision or size change (`texSubImage2D` when the size holds). The frame
fields' bytes and revisions (light records and tile index, sea gust, footprint,
puddle mask) come from `gpu/GpuFrameState.js` (below). Every cache
entry counts its real bytes (`width x height x bytesPerTexel`), so the 160 MiB
cached-source ceiling and Shift-D see an R8 field at a quarter of an RGBA
canvas. First consumer: the particle motif mask. The ceiling was 48 MiB until
B.2; every frame already samples 105-137 MB of sources (terrain bake 25 MB,
four world-pilot pages 64 MB, ground fields ~10.5 MB, agent atlases 6-30 MB),
so a 48 MiB cap was permanently exceeded and only evicted what the camera had
just left.

**Frame state** (`gpu/GpuFrameState.js`, pure: no GL, no DOM): every
per-frame value a world backend uploads is resolved there once from the feed,
the camera and the ladder level, and the WebGL2 renderer only uploads what it
returns. `resolveCamera(camera, scale, out)` → `{ xy, scale }` (backing px =
(world + xy) x scale, doubles); `resolveFatPixels(camera, override)`;
`resolveFrameGrade(feed)`; `resolveWeatherUniform(feed, level)` (`u_weather`
with the `weather-amplitude` shear); `resolveOccluderChannel(feed)`;
`resolveWaterFx(feed, camera, level, grade, moonFill, width, out)` →
`{ fx, glint, stops }`; `resolveAtmosphereCourses(level, camera, feed, grade,
out)` → `{ cloud, thresholds, haze, sunlit, courses, aerialHaze }`;
`resolveSeaWeather(level, camera, feed, { courses, width, height }, out)` →
`{ sunlit, gust }` (gust = `resolveSeaGustRect`'s R8 field `{ data, width,
height, rect, revision }` or null); `resolveLights(feed, camera, level, { width,
height, view, clusterOverride, state })` → the light records, `count`,
`tiles` (null unless clustered), `tilesX`/`tilesY`, `clusters`, `admission`
(`getDiagnostics().lightAdmission`), `wetReflectionCount`, `footprint`,
`marchSteps`, `localLightPhase` and the record/tile revisions;
`resolveBeam(feed, out)` → `{ active, ground, shape, courseEnds, courseShares
}`; `resolvePuddles(feed, out)` → `{ mask, rect, puddles, sky, ground }`;
`resolvePaletteLut(level, feed)` → the 11x3 ramp source or null. The `create*`
factories build the per-backend scratch the resolvers fill in place;
`scripts/tests/gpu-frame-state.test.mjs` pins each resolver to the values the
renderer computed inline before the extraction.

**Patch uploads** (record `textureUpdates`, `materialTextureUpdates`,
`emissiveTextureUpdates`): each entry `{ x, y, width, height, source }`
`texSubImage2D`s a source of exactly that size, or with `sx, sy` set, the
`width x height` rect at `(sx, sy)` of a larger source (`UNPACK_ROW_LENGTH` /
`SKIP_PIXELS` / `SKIP_ROWS`, reset after). Patches apply only when the
revision moved and the texture's source and size are unchanged; anything else
uploads whole. `ground:semantics` (B.2) redraws only the extent its previous
redraw painted (tracked per paint call on a bounds-recording context) while
the canvas size and camera transform hold, and uploads the union of the old
extent, the new one and any rect a skipped upload left behind.

**GPU-resident sources** (B.2): `{ width, height, gpuResident: true }` resolves
only to a live texture of the same key, revision and size
(`hasResidentTexture(key, revision)`), so a CPU canvas can be released after
its upload; the terrain bake uses it and re-bakes when the texture is gone.

**One occluder channel contract** (before 2.3 or B.2 lands):

- Occluder companion: R = height. On a record with flag 16 `surfaceCode`
  (2.3; `GpuSceneBuilder` sets it from the manifest entry's
  `surfaceCode: true`) R is the true height above the landmark's visual base
  line, `min(255, round(h))` world px, and the scene pass lifts fog off it
  over 128 world px (`min(1, R x 255 / 128)`); elsewhere R stays the authored
  fog elevation. G = occlusion strength, **B = surface
  code `face x 64 + min(63, round(heightAboveGround / 4))`** (face 0 up/apron,
  1 left wall, 2 right wall, 3 roof), A = presence. B is read only on records
  with flag 16 `surfaceCode`; everywhere else it must be 0 and is ignored.
- B.2's merged material + geometry packing lives in the **material** map, never
  the occluder companion, and is read only on records with flag 32
  `packedGeometry`: R material id (**255 = no material**, record default), G
  occluder height, B occlusion strength (**0 = no geometry**, record defaults;
  an authored strength of 0 packs as 1/255), A presence (255 wherever either
  channel is present). The shader reads it as `geometry = vec4(G, B, 0, 1)`
  only while the occluder channel's frame toggle is on (`u_packedGeometry`),
  exactly where the old occluder upload was skipped. A source that carries
  2.3 surface codes keeps the separate occluder companion, so the two B
  channels never collide.
- **Deviation from plan B.2 (world-pilot stays unpacked).** B.2 asked for the
  world-pilot channel atlases to be packed like the agent atlas. They are not:
  `world-pilot` holds all nine landmarks, whose occluder page carries 2.3
  surface codes in B (V9 reserves occluder B for 2.3's surface code), so it
  keeps four separate 2048² channel pages (albedo, material, emissive,
  occluder: 16 MB of GL texture each). Packing it would have saved one page
  (~16.8 MB) at the cost of the surface channel.
- B.2 memory rules (agents): `packGeometryPixels` (`GpuSceneBuilder.js`)
  packs one canvas per material + occluder sidecar pair
  (`AgentSprite` packed-geometry cache, 16 M px; a frame crop packs inline, a
  sheet-size pair inline at most once per 32 ms, else as a derived-art queue
  job); the agent atlas keeps two channel canvases (packed
  geometry, emissive) beside the albedo, and a body whose emissive companion
  is entirely transparent passes none (a zero emissive map shades exactly like
  none). Equipped Codex sheets re-lay the albedo only: the frame record's
  `channelRect` draws the unpadded sidecar cell at the pad offset of the padded
  slot, so no padded sidecar copies exist.
- B.2 release and backing rules (agents): an equipped albedo that only crowd
  (0.5x LOD) bodies sample is released once its LOD sheet is baked and no 1:1
  body has used it for 3 s; the cache entry keeps the LOD sheet. A 1:1 body
  that needs it again recomposes it (composition is deterministic, so the
  pixels are identical): at most one compose per animation frame, inline for
  a selected, hovered or action-needed body and otherwise from the derived-art
  queue, with the body on its LOD sheet until its turn, drawn at its own 1:1
  size (each LOD texel two world texels), so it never changes size. The composed and LOD
  sheets, the three agent atlases and the dashboard avatars are CPU-backed
  (`willReadFrequently`): their sources are CPU canvases, and a GPU-backed
  destination made Chrome keep a GPU copy of every whole source sheet it drew.
- Derived-art queue (`AssetManager.createDerivedArtQueue`): every idle tick
  runs its first live job; a tick forced by the idle timeout (`didTimeout`,
  `timeRemaining()` 0) runs exactly that one, a real idle period keeps going
  until the 2 ms slice or the deadline ends.

**WebGPU backend** (Wave 10, 10.1 Stage A, `?renderer=webgpu` opt-in;
`gpu/GpuWorldRendererWebGPU.js`, `gpu/wgpu/`, `gpu/wgsl/`). It consumes this
contract unchanged:

- Records: every batch stages the full 68-byte record
  (`stageGpuRecords(batches, staging, { fullTail: true })`) into one storage
  buffer read in the vertex stage as `array<RecordInstance>` of scalar lanes
  (`wgsl/common.js`, built from `RECORD_LAYOUT`: `loc0x..loc2w` f32, then
  `loc3xy`, `loc3zw`, `loc4xy`, `loc4zw`, `loc5xy` u32 with the first uint16 in
  the low half; `recordLoc0..5()` return what the GL attributes read). A batch
  draws its own slice with `firstInstance = instanceOffset / 68` (WebGPU's
  `instance_index` includes it), so the head-only default tail is a WebGL2
  detail. A compute probe on every new device reads the lanes back through the
  shader's own storage layout and calls `assertRecordStride` (68, never 80).
- Samplers become named bindings (no sampler arrays): group 0 per frame (frame
  uniforms, cloud tile, gust field, light records/tiles, footprint, cycle
  offset, coast field, puddle mask, palette LUT, radiance, particle motifs and
  their samplers), group 1 per batch (batch uniforms at a 256-byte dynamic
  offset, the record buffer, albedo 2D + albedo page array, material,
  emissive, occluder/packed-geometry sidecars, one nearest clamp sampler).
  Both albedo bindings always exist; the inactive one is a 1×1 stand-in, as
  the page's is on unit 14. Every `texture()` read is `textureSampleLevel(…,
  0.0)` with the same filter, every `texelFetch` a `textureLoad`, except the
  light records: the floats WebGL2 uploads as its 256×4 RGBA32F record
  texture sit verbatim in a read-only storage buffer (`lightData[row * 256 +
  i]`, rewritten when `recordsRevision` moves). The light walk reads them per
  light per pixel, and the buffer load costs measurably less than the texture
  fetch (Stage B gpu-burst); the tile index stays an R16UI texture (a buffer
  read measured slower there).
- Uploads: the same bytes as WebGL2. Typed fields (`uploadTypedTexture`: r8,
  rg8, r16ui, rgba32f, rgba8) go through `queue.writeTexture` from the same
  arrays (tight rows; only buffer copies need the 256-byte pitch). Canvas and
  image sources, their sub-rect patches and albedo-page slots go through
  `copyExternalImageToTexture` with `premultipliedAlpha: false, flipY: false`,
  measured byte-identical to `texImage2D` with `UNPACK_PREMULTIPLY_ALPHA_WEBGL
  false` at every alpha 0–255 (`output/waking-isle/WGPUCore/probe-bytes.html`),
  so no atlas byte changes for the port. The texture cache keeps each entry's
  source beside its GPU handle, so a device rebuild re-uploads from source; a
  B.2 GPU-resident stand-in reports `hasResidentTexture` false after a loss and
  its owner re-bakes, exactly as after a WebGL context loss.
- The shared numbers are generated, never copied: `GRADE_WGSL`
  (`wgsl/grade.js`) interpolates `GpuWorldPolicy.GRADE_CONSTANTS` through the
  same formatter as `GRADE_GLSL`, and every twin include interpolates the JS
  constants its GLSL twin does.

### Landmark surface channel (plan 2.3)

All nine landmarks ship a baked `base.occluder.png` and declare
`occluderSidecar: true` plus `surfaceCode: true` (the manifest flag that makes
`GpuSceneBuilder` set record flag 16). `node scripts/sprites/bake-surface-channel.mjs`
writes every texel from the albedo alpha and the landmark geometry, then
`npm run sprites:atlas-bake -- --atlas=world-pilot` copies the whole companion
pixel (B included) into the atlas occluder page; `--check` fails on a stale
sidecar, `--out=<dir>` writes previews.

- **R** = height above ground in world px (sprite px at scale 1), clamped 255.
  **G** = `alpha x occluder.strength`. **B** = `face x 64 + min(63, round(h / 4))`.
  **A** = albedo alpha. Decode: `face = B >> 6`, `h = (B & 63) x 4`.
- **Visual base**: each landmark's 2:1 front edges where its art meets the
  ground, in sprite px (`SURFACE_SPECS[type].base`; default the `BUILDING_DEFS`
  footprint projected through the anchor, which sits on the footprint
  centre). A wall texel's foot is the base edge under its column, so
  `h = footY(x) - y`; face 1 (SW-facing, on the left->bottom edge) left of
  the front corner, face 2 (SE-facing) right of it. Texels in front of the
  edge are apron (face 0, h 0).
- **Roofs** (face 3) are the landmark's slate colours (HSV hue 186-242,
  S >= 0.2); window glass lit in the emissive sidecar is never roof.
- **Authored regions** (polygons, first match wins) cover what the colour and
  base rules cannot see: stairs (face 0, height ramps), decks and piers (face
  0 at deck height, matched by plank colour with seams closed), set-back
  masses with their own front corner (towers, the Command drum and dome, the
  Forge chimney), and masses standing on a deck (`lift`). The Command dome's
  roof region matches only its slate and gold (`match`); the drum wall under
  the gold ring and the lantern's stone fall through to an `auto` region on
  the dome's corner and are walls (faces 1/2), as are three unlit slate-glass
  panes the emissive sidecar leaves dark. Per M5 the Harbor
  (water line; decks and piers at h 8, houses lifted 8), Lighthouse (stair,
  footing apron, bronze cap = roof), Observatory (door steps, dome shell and
  maroon eaves = roof) and Portal (stairs 0->23, dais flagstones at h 23, the
  arch and slabs lifted 23) are hand-authored.
- The 1-px outline and the deepest shadow texels (HSV value < 0.13) take the
  modal face and mean height of the non-ink texels in their 5x5 window, so an
  outline belongs to the surface it draws.
- The sprite audit (`npm run sprites:channels-validate`) fails a landmark
  without `occluderSidecar` + `surfaceCode`, and one whose occluder R or B is
  all zero.
- Face 3 has a second reader: roof weather (5.2 roofs, 6.6,
  `RoofWeather.js`). Snow, the wet-slate course and the eave drips lie only
  on face-3 texels whose albedo is roof material (slate, metal, or the ink
  between them — a mis-tagged wall stays bare), minus lit glass,
  fabric/rune/fire material and trim (metal on a slate roof, any other
  face-3 colour such as the Observatory's maroon cornice), and on silhouette
  caps; a landmark without the
  channel takes none. They draw as a patch record right after the landmark
  (after its glass patch, before its parts) that carries crops of the
  landmark's own material and occluder companions, so the patch shades as
  the slate under it (surface-coded, unlit by lamps). Re-baking the surface
  channel re-classes roof weather with it.

### Room masks (plan 6.3)

Buildings with an emissive sidecar and registry window or room rects ship
`base.rooms.png` beside `base.png` (manifest `roomsSidecar: true`; path via
`roomMaskPathForEntry`): R = room index 1..N on the room's glass, 0 = not a
room, G = B = 0, A = 255 on room texels. `node scripts/sprites/bake-room-masks.mjs`
(`--check` for staleness) closes the emissive alpha by one texel (the
validator's mullion bridge), splits it into 4-connected components and numbers
them by the registry under the glass-centre `windowRectBounds` convention:
`rooms.slots[k]` is room k + 1 where a building has room slots (Command,
Archive); otherwise every component under a `windowRects` entry is a room, in
first-reference order, and `ROOM_PANE_GROUPS` joins panes of one lamp split by
a post (the Task board lanterns). Emission that no rect names (fire mouths,
crystals, braziers, spare panes) is room 0 and stays on the building-level
gate. `npm run world:validate-buildings` checks every mask: each rect sits
>= 60 % on one room, room slots carry their own index, indices run 1..N with
every room named, and mask texels stay on the closed emissive glass.

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
    wait: { rows: [4, 6], hold: 6, directions: [se, e, w, sw] }
    strike: { rows: [7, 12], hold: 12, contactFrame: 3, directions: [se, e, w, sw], contact: { e: [58, 44] } }
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
- Plan 7.3 groups: `wait` (3 rows, the held action-needed pose), `strike`
  (Edit/Write/apply_patch, 6), `tinker` (Bash/tests, 6) and `gaze` (lookups:
  WebFetch/WebSearch, Grep/Glob, Read; 4); 7.1 adds `sit` with `seatLine`.
  They author the work facings only and say so in `directions` (short keys);
  `resolveActionFrame` returns null for any other facing, so a body whose
  strip is due turns to the nearest authored facing first
  (`AgentSprite._stripFacing`). `contactFrame` (group-relative) and `contact`
  (`{ <dir>: [x, y] }`, cell px, the contact frame's hand joint) are where the
  WorkDownbeat strikes. A work group animates only while RitualConductor has
  admitted a ritual of its tool class for that villager (`ritual.stripGroup`,
  `workStripGroup`: the tool class first, the building only for a tool with
  none), one cycle per gesture period with the contact frame on the beat; `wait`
  shows its held row. Every strip frame passes `scripts/sprites/feet-audit.mjs`
  (feet ±2 px of the V7 anchor, no new detached fragment, non-arm identity
  held, the wait hand ≥ 3 px above the head) before it ships.
- Pose strips (7.1/7.3): `scripts/sprites/generate-pose-strip.mjs` stages
  skeleton-v3 candidates (idle row-6 first frame, arm joints only, feet,
  hips, head and prop hand verbatim; `--clip` packs several groups into one
  ≤ 15-frame job), `feet-audit.mjs --strip=…` reviews them, and
  `scripts/sprites/assemble-action-strip.mjs` is the single writer of
  `actions.png` (shipped groups kept, staged groups added in the order read,
  wait, sit, strike, tinker, gaze) and prints the `actionStrip` record.
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
