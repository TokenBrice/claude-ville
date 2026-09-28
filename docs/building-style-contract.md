# ClaudeVille Building Style Contract

The visual and runtime contract for every World-mode building. Observatory is the style reference for the landmark family, Command Center is the hero and land-material reference, Harbor is the water-contact reference, and Portal/Lighthouse are named structural-platform exceptions. Use this when writing generation prompts, defining grounding metadata, and reviewing a regenerated sprite.

## Craft rules (every building)

- **Projection:** true 2:1 dimetric isometric (~26.57°, 2px run : 1px rise). No flat/near-front elevations.
- **Outline:** 1px **selective** outline in warm near-black (`#060402`–`#040404`). Not pure black, not colored. External silhouette + major internal plane breaks only. No anti-aliasing.
- **Shading:** stepped courses from the C1 ramps (`ART_RAMPS`, below): 3–4 tone steps per material with hard cel transitions, and an ordered (Bayer) dither where two courses meet. No smooth gradients, airbrush, blur or soft blending. **Minimum ~35% lightness contrast** dark→light per material (no washed-out pastels).
- **Lighting:** single warm key baked from the **upper-left**; cool shadow toward lower-right. No rim light, glow or bloom baked into the albedo: light that emits belongs to the emissive sidecar.
- **Doors:** a door leaf is at least **1.2× the median 1:1 body height** (Command's leaf ≥ 78 px), so a villager reads as going in, not squeezing past.
- **Glass:** `base.png` paints window glass **unlit** (slate glass on the stone/slate ramps, with the frame and a cool sky glint at most). Painted amber glass makes an empty building look occupied at noon. Window light comes only from the emissive sidecar (`base.emissive.png`), gated at night by real work (see Rooms).
- **Roof signature:** slate-blue tiled roof is the family motif. No terracotta-red, no sky-blue cartoon roofs.
- **Grounding (required):** land sprites contain structure, attached stairs, and true footings only. The ground bake (`claudeville/src/presentation/character-mode/GroundBake.js`, cached in the static terrain layer) owns grass, dirt, district yards and their kerbs, contact darkening, and the worn threshold from each door along its frontage spur. A land sprite must not contain a complete ground tile, raised slab, plinth, retaining lip, closed dark perimeter, baked cast shadow, or generic square diamond.
- **Exceptions:** `intentional-dais`, `quay`, and `water-pilings` may remain structural parts of the sprite. They must have visible support, stairs/thresholds where applicable, and a localized terrain or water contact rather than a second generic platform.
- **Contact shadow:** structure-aware and tight to walls, posts, rock mass, towers, or pilings. Never size a shadow from the whole sprite canvas or flat apron.

## Palette ramps (`ART_RAMPS` in `claudeville/src/config/artPalette.js`)

The master palette is code-owned; authoring, the ground bake, and `npm run art:analyze` read it. The building-facing ramps:

| Ramp | Stops (dark → light) | Use |
|---|---|---|
| `stone` | `#25262D` · `#373944` · `#4D4F5A` · `#686A72` · `#8C8B8A` | masonry and props |
| `slate` | `#1E2433` · `#2C3650` · `#3E4D6C` · `#5A6C8C` | all roofs |
| `wetSlate` | `#5A6C8C` · `#6B7EA0` · `#7D91B0` · `#8FA3C0` | 6.6 wet course on the roof's upper-left edges, one stop per wetness quantum; eave drips (runtime only, never authored) |
| `timber` | `#2A1C14` · `#45301F` · `#654629` · `#8A6337` | beams, planks, doors, hulls |
| `clothCrimson` | `#732A31` · `#A4463F` | banners and awnings; the only red on buildings |
| `clothOchre` | `#987638` · `#C9A04A` | awnings, pennant fringes, brass-toned cloth |
| `emissive` | `#FF9D4A` · `#FFCF7A` · `#FFE9B8` | reserved for authored lamp, fire, and window light |
| `grass`, `dirt`, `road`, `plaza` | see `artPalette.js` | terrain-owned; never baked into a land sprite |

Thematic palettes (Portal violet, Mine cyan ore, Harbor warm wood) are **allowed deviations** layered on the same craft rules — not separate art styles.

**Roof weather is runtime, not art.** Snow (5.2), the wet-slate course and eave drips (6.6) are derived at runtime from the landmark's 2.3 surface channel (`RoofWeather.js`): paint roofs as dry slate on face class 3, keep banners, doors and pennants as fabric/timber parts or material, and keep gold trim gold. A new landmark needs its surface channel before its roof can take weather.

## Grounding profiles

Every type has one profile in `claudeville/src/config/buildingGrounding.js`, linked through `BuildingVisualRegistry`:

```js
grounding: {
    mode: 'terrain-apron' | 'intentional-dais' | 'quay' | 'water-pilings',
    material: 'civic-cobble' | 'knowledge-terrace' | 'workshop-yard' | 'mine-yard' | 'arcane-court' | 'harbor-quay' | 'tidal-water',
    edgeTreatment: 'broken' | 'retained' | 'water-contact',
    shadow: 'structure-contact' | 'tower-cast' | 'none',
}
```

The logical footprint always comes from `BUILDING_DEFS`. Do not duplicate it in the manifest. Every manifest building entry must declare native `width`, `height`, and `anchor`; split sprites also declare `horizonY`. A `structureMask` is reserved as a migration tool for preserving legacy upper pixels while removing an old baked site slab at load time. The nine current landmark sprites are native structure-only art and do not use one.

## Windows (`windowRects`)

`BuildingVisualRegistry` `windowRects` are the dusk warmth stamps, and `rooms.slots` are the per-room panes. On every rect, `at` is the **glass centre** in base-local texels, with `w`/`h` the pane size. `windowRectBounds(rect)` is the single reader of that convention, used by the runtime stamps, the room panes, the Command aggregate row, `scripts/sprites/atlas-bake.mjs` and the validator. A rect must cover at least **60%** of its emissive sidecar's alpha. Coverage is measured against a 1-texel closed alpha mask, because glass sidecars are striped (lit every other column), so raw alpha under-scores. `npm run world:validate-buildings` enforces this and names a rect that only fits as a top-left corner. When the sidecar lights only a sliver of a pane, fit the rect to the lit texels or leave that pane without a rect; never stamp light the sidecar does not have.

## Parts (frame-strip layers)

Every drawn manifest layer goes through `BuildingSprite.partDrawsFor`, one descriptor list for both backends: the Canvas pass blits it and the GPU emits one small record per descriptor right after the building's record (same painter depth, same split half). A plain layer with art and an `anchor` is a static overlay, bottom-centre anchored in base-local px, with no alpha pulse (V4):

```yaml
layers:
  beacon:              # the Pharos lamp, seated in the lantern glass
    width: 18
    height: 25
    anchor: [145, 84]  # base-local bottom-centre
    fixture: true      # GPU: emits through no occupancy gate (a real fixture, M22)
    materialClass: fire
    emissive: { strength: 1, sources: [{ geometry: authored-albedo, strength: 1 }] }   # GPU emissive strip = its own albedo
```

Moving building parts (a Mine sheave, a Harbor crane, Forge bellows, a lantern flame, door strips) are manifest `layers:` entries authored as one horizontal strip:

```yaml
layers:
  sheave:
    anchor: [x, y]     # base-local bottom-centre of one frame
    frames: 4
    frameW: 24
    frameH: 20
    fps: 6             # 4–8, stepped on the shared motion clock; never smooth
    staticFrame: 0     # drawn when the gate is false or motion is reduced
    gate: work.mine    # BuildingPartGates: `work.<type>` or `door.<type>`, true while the building has >= 1 isWorkingVisitor (V8)
    restIsBase: true   # frame 0 is pixel-identical to the base art under it
    oneShot: false     # optional: play forward once when the gate opens, hold the last frame, play back when it closes (doors)
    loopFrom: 0        # optional: a loop skips frames below this (a lantern whose frame 0 is the unlit base)
```

- The strip PNG `buildings/<id>/<layer>.png` is exactly `frames × frameW` by `frameH`. `BuildingSprite.partDrawsFor` picks the frame once for both backends: the Canvas pass blits it, the GPU record carries channel strips cropped from the base's own sidecars (an added object or overlay takes its own `materialClass` and emits only what its `emissive` declares).
- Work-coupled parts loop only while their gate reads real work through `isWorkingVisitor`. Rest-seat, queue and inferred-leg visitors never animate a building. A `restIsBase` part at frame 0 draws nothing, so an empty building is its `base.png`.
- One looping part per building (the Task board's two eave lanterns are one part in two strips, each gated on its own room). A part changes ≥ 4–6 world px of value-contrasting pixels so it reads at z1, uses only the building's authored colours, and keeps its depth order in the split pass (each half draws the part's rows on its side of the horizon, like the base).
- Doors (6.2) are 3-frame `oneShot` strips gated `door.<type>`: closed (the base crop), ajar, open, one frame per 110 ms, onto a dark hall `#1a1310` over a stepped warm floor on the C1 `emissive` ramp (rim `#ff9d4a`, core `#ffcf7a`, one Bayer course); the floor texels emit on the GPU through the occupancy gate. Reduced motion shows the held frame with no steps.
- `restIsBase: true` promises that an idle building shows exactly `base.png`. The validator compares frame 0 with the base crop at `anchor` and rejects any strip whose width is not `frames × frameW`, whose `fps` falls outside 4–8, whose `staticFrame` is out of range, or whose `gate` is not `work.<type>` / `door.<type>` / `room.<type>.<k>`. `room.<type>.<k>` is open while a working visitor holds 6.3 room k (0-based, `base.rooms.png` R = k + 1): a part that is itself a room's glass (the Task board lanterns, `room.taskboard.0` west and `.1` east) burns for exactly the worker holding it, so N workers light min(N, rooms). A 6.7 `dressing: true` layer is a static strip: only its geometry is checked.
- Strips are hand-authored by `output/`-side scripts from the current `base.png` (frame 0 is always the live base crop); re-crop after any base edit under a part.

### Emitter cycles (V4, OE-1)

A layer with `cycle: { gate, frames: 8, bandPx: 4, riseStepPx: 2, fixedBelowRankFrac: 1/3, hz }` is a mask, never art: alpha marks the emitter's authored texels. `EmitterCycle.bakeEmitterCycle` sorts those texels' own colours by luma into a ramp and bakes `frames` phases in which a stepped +1/0/−1/0 rank wave in `bandPx` bands rises `riseStepPx` per phase up the flame (by row, or by the mask's red channel with `heightFromMask`); ranks below `fixedBelowRankFrac` (dark embers) never move, so every output texel is an authored colour. The rest frame is the art itself (nothing is drawn): gated off, banked or reduced motion.

- `gate`: `work.<type>` (runs only while the building has an `isWorkingVisitor` body) or `lamps` (a fixture that runs only while `lampsLitAt` says the village lamps are lit; never reads agent state, so by day it is the still art). `hz` stays in the V4 slow band (≤ 8).
- `art: <layer>` cycles a static overlay layer's pixels instead of `base.png` (the mask is that layer's size and anchor).
- `rampStops: K` bins a many-shaded emitter's colours into K luma courses, each shown by its most-used authored colour, so a lit or dimmed band moves one visible course (a band at 0 keeps the texel's own colour). `shearPx: 0` drops the per-column lean for a mask whose order is not vertical.
- The validator checks the gate, `hz`, `frames`, that `art` names a static overlay, and that the mask is its art's size and covers authored texels.

Shipped:

| Layer | Art | Gate | Rate | Mask order |
| --- | --- | --- | --- | --- |
| Forge `hearth` | base | `work.forge`, and only while the hearth glow is above the banked ember | 8 Hz | rows up the fire |
| Command `braziers` | base | `lamps` | 6 Hz | rows up both flames |
| Lighthouse `lens` | `beacon` | `lamps` (`fixture`) | 4 Hz, `rampStops: 6` | R = rows above the bowl |
| Portal `runes` | base | `work.portal` | 6 Hz, `rampStops: 6`, `shearPx: 0` | R = around the rune ring from the front, then up the vortex (the ring's white eye and dark outlines excluded) |

```yaml
  lens:
    width: 18
    height: 25
    anchor: [145, 84]
    fixture: true
    cycle: { gate: lamps, art: beacon, frames: 8, bandPx: 4, riseStepPx: 2, fixedBelowRankFrac: 0.25, rampStops: 6, heightFromMask: true, hz: 4 }
  runes:
    width: 312
    height: 208
    anchor: [156, 182]
    cycle: { gate: work.portal, frames: 8, bandPx: 4, riseStepPx: 2, fixedBelowRankFrac: 0.3333, rampStops: 6, heightFromMask: true, shearPx: 0, hz: 6 }
```

## Rooms (per-room light)

Night window light counts workers; it is not a building-wide switch.

- **Room masks** come from the emissive sidecar: `base.rooms.png` (room index in R) segments `base.emissive.png` into connected glass components. Every `rooms.slots` rect lies on its room's glass and is validated against the sidecar like a window rect.
- **Per-room gate:** `assignRoomSlots({ previous, workingIds, rooms })` gives each working visitor (V8 `isWorkingVisitor`) a stable room. At night room *k* lights its own sidecar texels (art-shaped, not rects) only while it is occupied. Unoccupied rooms stay dark. Waiting occupants are counted but never lit, and overflow is an exact count, never an invented window.
- Aperture lights and water reflection columns read the same per-room gate, so a dark room lights nothing.

## Size tiers (footprint-driven; all ≤400px → single-image generation)

Rule of thumb: **sprite width ≈ 1.2 × iso-diamond width** = `1.2 · (w+h) · 32` (TILE_WIDTH=64), height by archetype.

| Tier | Buildings | Native W × H (manifest) |
|---|---|---|
| Hero hall | command, archive, harbor, portal | 312–360 × 208–240 |
| Standard structure | forge, mine, taskboard | 256 × 232 |
| Tower (narrow, tall) | observatory, watchtower | 256 × 288, 288 × 384 |

## Generation recipe

- Tool: REST `generate-image-v2` (Pro, with `building.observatory` as the style image) or MCP `create_map_object` (≤400px, transparent BG). Smoke-test the tool per building; `generate-image-v2` produced Command, Archive, Task Board, Forge, and Mine; `create_map_object` produced Harbor, Observatory, Watchtower, and Portal. The manifest `tool` field names the surface, and the Pro re-authors carry a `provenance` block with endpoint, job, and style image.
- `create_map_object` params (not in the description): `view: low top-down`, `outline: selective outline`, `shading: detailed shading`, `detail: high detail`, transparent background.
- Description for `terrain-apron`: prepend the manifest `style.anchor`; add subject identity, palette cues, silhouette intent, "true wall/post/rock footings and attached steps only", and "transparent ground around the structure". Explicitly forbid ground tile, lawn, slab, plinth, retaining lip, complete perimeter, and baked shadow.
- Description for a structural exception: name the physical platform (`dais`, `quay`, `deck/pilings`), its support, and its terrain/water transition. Still forbid a larger generic ground tile.
- After generation: place at `assets/sprites/buildings/<id>/base.png`; declare native dimensions and an explicit anchor; recalibrate `horizonY`, emitters, lights, overlays, window and room rects (glass centres on the new sidecar), pennants, and ritual anchors; bump `style.assetVersion`; run `npm run world:validate-buildings`.

## Reference order

Harbor (`water-pilings`) · Command (`terrain-apron`) · Portal (`intentional-dais`) · Lighthouse (`quay`). Archive, Task Board, Forge, and Mine were re-authored on the Observatory's grid and Command re-crowned as the hero in the 2026-09-25 Painted Isle landmark pass (manifest provenance items 4.2 and 4.5); preserve their recognizable silhouettes and authored material channels in future revisions.
