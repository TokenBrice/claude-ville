# ClaudeVille Building Style Contract

The visual and runtime contract for every World-mode building. Observatory is the style reference for the landmark family, Command Center is the hero and land-material reference, Harbor is the water-contact reference, and Portal/Lighthouse are named structural-platform exceptions. Use this when writing generation prompts, defining grounding metadata, and reviewing a regenerated sprite.

## Craft rules (every building)

- **Projection:** true 2:1 dimetric isometric (~26.57°, 2px run : 1px rise). No flat/near-front elevations.
- **Outline:** 1px **selective** outline in warm near-black (`#060402`–`#040404`). Not pure black, not colored. External silhouette + major internal plane breaks only. No anti-aliasing.
- **Shading:** stepped courses from the C1 ramps (`ART_RAMPS`, below): 3–4 tone steps per material with hard cel transitions, and an ordered (Bayer) dither where two courses meet. No smooth gradients, airbrush, blur or soft blending. **Minimum ~35% lightness contrast** dark→light per material (no washed-out pastels).
- **Lighting:** single warm key baked from the **upper-left**; cool shadow toward lower-right. No rim light, glow or bloom baked into the albedo: light that emits belongs to the emissive sidecar. Emissive-sidecar texels keep their own colour at every hour (1.3: the scene pass exempts them from the time grade, and the Canvas/hybrid paths draw an ungraded emitter cut, `EmitterCuts.drawCanvasEmitterCuts`). On an HDR screen under WebGPU they are the role-1 pixels that HDR highlights lift (10.2, `DisplayColor.js`); on a P3 screen their chroma is stretched ×1.22 (10.3). Both stay below the action-needed marks.
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
| `emissive` | `#FF9D4A` · `#FFCF7A` · `#FFE9B8` | reserved for authored lamp, fire, and window light; the 6.2 door-floor steps |
| `snow` | `#98A5B4` · `#B0BCC7` · `#C7D0D6` · `#D9DFE1` · `#E6E9E6` | 5.2 roof snow and silhouette caps (runtime only, never authored) |
| `grass`, `dirt`, `road`, `plaza` | see `artPalette.js` | terrain-owned; never baked into a land sprite |

Thematic palettes (Portal violet, Mine cyan ore, Harbor warm wood) are **allowed deviations** layered on the same craft rules — not separate art styles.

**Roof weather is runtime, not art.** Snow (5.2), the wet-slate course and eave drips (6.6) are derived at runtime from the landmark's 2.3 surface channel (`RoofWeather.js`): roof = occluder face class 3 where the albedo agrees it is slate, metal or the ink between them; trim (metal on a slate roof, any other colour on face 3), lit glass, fabric, rune glass and fire stay bare. Snow fills each slate course from its sky-facing lip (1, 2, 3 rows per quarter of cover; the whole roof at full cover with the joints still reading; the eave rows stay slate), plus 1–3-row caps on silhouette tops. The wet course is 1 art px on the roof's upper-left edges, one `wetSlate` stop per wetness quantum (`ROOF_WET_QUANTA` 4); drips fall from 3–4 eave points per landmark on a 12-step 90 ms cycle while it rains, hidden under reduced motion. Paint roofs as dry slate, keep banners, doors and pennants as fabric/timber parts or material, and keep gold trim gold. A landmark without a surface channel takes no roof weather.

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

## Sidecars

Every sidecar is a same-size companion of `base.png`, opted in on the manifest entry. [`material-channel-contract.md`](material-channel-contract.md) owns the byte layout.

| Sidecar | Manifest flag | Content | Buildings |
|---|---|---|---|
| `base.material.png` | `materialSidecar: true` | material class per texel | command, forge, mine, taskboard, archive, portal |
| `base.emissive.png` | `emissiveSidecar: true` | the only light the art emits: lit glass, fire, lanterns, crystals | all nine |
| `base.occluder.png` | `occluderSidecar: true` + `surfaceCode: true` | 2.3 surface channel: R = true height above ground (world px, clamped 255), G = occlusion strength, B = `face·64 + min(63, round(height/4))`, face 0 up/apron, 1 left wall, 2 right wall, 3 roof | all nine |
| `base.rooms.png` | `roomsSidecar: true` | 6.3 room index 1..N in R on each room's glass | all but portal (its vortex is no room: no `windowRects`) |

- `scripts/sprites/bake-surface-channel.mjs` writes the occluder sidecar from the footprint's visual base (the `BUILDING_DEFS` diamond through the sprite anchor) plus authored `SURFACE_SPECS` regions (first match wins) for decks, piers, stairs, daises and set-back masses. M5 approved hand authoring for the Harbor, Lighthouse, Observatory and Portal; Command, Archive and Forge also carry authored regions. `--check` verifies the on-disk bytes; rerun `npm run sprites:atlas-bake -- --atlas=world-pilot` after writing.
- `scripts/sprites/bake-room-masks.mjs` writes the room masks (`--check` verifies them). Glass is the emissive alpha after a 1-texel closing, split into 4-connected components. With `rooms.slots`, room k + 1 is the component under slot k; otherwise every component under a `windowRects` entry is a room, numbered by first reference. Fire, lantern-body, crystal and door-spill emission that no rect names stays 0.

## Windows (`windowRects`, `rooms.slots`, `glassRects`)

`BuildingVisualRegistry` rects name a landmark's glass on its emissive sidecar: `windowRects` the windows, `rooms.slots` the per-room panes (Command, Archive), and `glassRects` hall panes that belong to no room (Archive). On every rect, `at` is the **glass centre** in base-local texels, with `w`/`h` the pane size (at least 3; default 6 × 8). `windowRectBounds(rect)` is the single reader of that convention, used by `RoomGlass`, `bake-room-masks.mjs`, `scripts/sprites/atlas-bake.mjs`, the validator, and the flat warmth stamps that only a building without an emissive sidecar would still draw (none ships today). A building with a sidecar is lit by its art-shaped glass texels, never a rect. A `windowRects` or `rooms.slots` rect must cover at least **60%** (`WINDOW_SIDECAR_MIN_COVERAGE`) of its emissive sidecar's alpha. Coverage is measured against a 1-texel closed alpha mask, because glass sidecars are striped (lit every other column), so raw alpha under-scores. `npm run world:validate-buildings` enforces this and names a rect that only fits as a top-left corner. When the sidecar lights only a sliver of a pane, fit the rect to the lit texels or leave that pane without a rect; never stamp light the sidecar does not have.

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
    gate: work.mine    # BuildingPartGates: `work.<type>`, `door.<type>` or `room.<type>.<k>`; work/door are true while the building has >= 1 isWorkingVisitor (V8)
    restIsBase: true   # frame 0 is pixel-identical to the base art under it
    oneShot: false     # optional: play forward once when the gate opens, hold the last frame, play back when it closes (doors)
    loopFrom: 0        # optional: a loop skips frames below this (a lantern whose frame 0 is the unlit base)
```

- The strip PNG `buildings/<id>/<layer>.png` is exactly `frames × frameW` by `frameH`. `BuildingSprite.partDrawsFor` picks the frame once for both backends: the Canvas pass blits it, the GPU record carries channel strips cropped from the base's own sidecars (an added object or overlay takes its own `materialClass` and emits only what its `emissive` declares).
- Work-coupled parts loop only while their gate reads real work through `isWorkingVisitor`. Rest-seat, queue and inferred-leg visitors never animate a building. A `restIsBase` part at frame 0 draws nothing, so an empty building is its `base.png`.
- One looping part per building (the Task board's two eave lanterns are one part in two strips, each gated on its own room). A part changes ≥ 4–6 world px of value-contrasting pixels so it reads at z1, uses only the building's authored colours, and keeps its depth order in the split pass (each half draws the part's rows on its side of the horizon, like the base).
- Doors (6.2) are 3-frame `oneShot` strips gated `door.<type>`: closed (the base crop), ajar, open, one frame per 110 ms, onto a dark hall `#1a1310` over a stepped warm floor on the C1 `emissive` ramp (rim `#ff9d4a`, core `#ffcf7a`, one Bayer course); the floor texels emit on the GPU through the occupancy gate. Reduced motion shows the held frame with no steps.
- `restIsBase: true` promises that an idle building shows exactly `base.png`. The validator compares frame 0 with the base crop at `anchor` and rejects any strip whose width is not `frames × frameW`, whose `fps` falls outside 4–8, whose `staticFrame` is out of range, or whose `gate` is not `work.<type>` / `door.<type>` / `room.<type>.<k>`. `room.<type>.<k>` is open while a working visitor holds 6.3 room k (0-based, `base.rooms.png` R = k + 1): a part that is itself a room's glass (the Task board lanterns, `room.taskboard.0` west and `.1` east) burns for exactly the worker holding it, so N workers light min(N, rooms). A 6.7 `dressing: true` layer is a static strip: only its geometry is checked.
- Strips are hand-authored by `output/`-side scripts from the current `base.png` (frame 0 of a `restIsBase` strip is the live base crop); re-crop after any base edit under a part.

Shipped:

| Layer | Gate | Strip | Rate | Notes |
| --- | --- | --- | --- | --- |
| Command `gate` | `door.command` | 3 × 40 × 80 | 110 ms/frame | `oneShot`; the lifted 78 px leaf |
| Archive `door` | `door.archive` | 3 × 35 × 93 | 110 ms/frame | `oneShot` |
| Observatory `door` | `door.observatory` | 3 × 34 × 54 | 110 ms/frame | `oneShot` |
| Harbor `door` | `door.harbor` | 3 × 14 × 24 | 110 ms/frame | `oneShot`, the harbour-office door |
| Harbor `crane` | `work.harbor` | 6 × 28 × 70 | 4 fps | hoist 0/2/4/6/4/2 px |
| Mine `sheave` | `work.mine` | 4 × 22 × 32 | 6 fps | |
| Forge `bellows` | `work.forge` | 4 × 28 × 22 | 4 fps | an added object (`restIsBase: false`): frame 0 always draws |
| Task Board `lanternWest` / `lanternEast` | `room.taskboard.0` / `.1` | 4 × 20 × 30 | 6 fps, `loopFrom: 1` | frame 0 is the unlit base |

### Emitter cycles (V4, OE-1)

A layer with `cycle: { gate, … , hz }` is a mask, never art: alpha marks the emitter's authored texels. `EmitterCycle.bakeEmitterCycle` bakes one strip of phases from those texels, shared by Canvas, WebGL2 and WebGPU, in one of two modes; either way every output texel is an authored colour and a step is a hard index change. The rest frame is the art itself (nothing is drawn): gated off, banked or reduced motion.

- **`mode: tongues` (painted fires).** Use it for any fire whose tongues are painted as boundaries between colour courses (a bright bed, tongues of each course licking up into the next). The mask's columns fall into `lanePx`-wide lanes; each lane lifts its own authored texels 0‥3 texels up (climb 0 1 2 3, then 0 1 2, then a beat at rest), neighbouring lanes out of step, and when a lane drops back its last tip rises one texel more as a detached 2-texel wisp (at least 2 texels wide). The bottom `keepPx` texels of each column (the bed, a threshold edge) never move; texels whose own and source courses both lie below `fixedBelowRankFrac` (a dark crown) keep their colour. So every phase is the rest silhouettes shifted by at most four texels, and the fire reads as rising tongues. Always 8 phases. Mask only the flame body: fire-lit stone (a jamb reveal, rim highlights) is stone and must stay out, or the lift drags its brick courses.
- **`mode: wave` (default: glass, runes, lamps).** A stepped +1/0/−1/0 rank wave over the luma-sorted ramp in `bandPx` bands rises `riseStepPx` per phase (by row, or by the mask's red channel with `heightFromMask`); ranks below `fixedBelowRankFrac` never move. `frames: 8, bandPx: 4, riseStepPx: 2, fixedBelowRankFrac: 1/3`. Never use it on a painted fire: row bands cut across the tongue silhouettes and read as a blocky mosaic of luma bands, not flame (the Forge hearth and the Command braziers before `mode: tongues`).
- `gate`: `work.<type>` (runs only while the building has an `isWorkingVisitor` body) or `lamps` (a fixture that runs only while `lampsLitAt` says the village lamps are lit; never reads agent state, so by day it is the still art). `hz` stays in the V4 slow band (≤ 8).
- `art: <layer>` cycles a static overlay layer's pixels instead of `base.png` (the mask is that layer's size and anchor).
- `rampStops: K` bins a many-shaded emitter's colours into K luma courses, each shown by its most-used authored colour, so a lit or dimmed band moves one visible course (a band at 0 keeps the texel's own colour). Bin any wave ramp whose luma order interleaves rare off-hue shades (a generated flame's tan or brown edge pixels) between its main colours: an unbinned ±1 step lands whole courses on those shades and reads as a tan mosaic. `shearPx: 0` drops the per-column lean for a mask whose order is not vertical.
- The validator checks the gate, `hz`, `frames`, `mode`, that `art` names a static overlay, and that the mask is its art's size and covers authored texels.

Shipped:

| Layer | Art | Gate | Rate | Mode |
| --- | --- | --- | --- | --- |
| Forge `hearth` | base | `work.forge`, and only while the hearth glow is above the banked ember | 8 Hz | `tongues`, `lanePx: 3`, `keepPx: 3`; the mask is the flame body inside the arch (the lit jamb reveal is left out) |
| Command `braziers` | base | `lamps` | 6 Hz | `tongues`, `lanePx: 2`, `keepPx: 1` |
| Lighthouse `lens` | `beacon` | `lamps` (`fixture`) | 4 Hz | `wave`, `rampStops: 6`, R = rows above the bowl |
| Portal `runes` | base | `work.portal` | 6 Hz | `wave`, `rampStops: 6`, `shearPx: 0`, R = the eleven arch-ring glyphs from the left foot over the keystone to the right foot, then a two-arm spiral phase about the vortex heart, so the bands wind inward round it (never rows: a row-ordered vortex reads as scan lines); the vortex itself also glows every night through the `portalGlow` fixture overlay |

```yaml
  hearth:
    width: 256
    height: 232
    anchor: [128, 169]
    cycle: { gate: work.forge, mode: tongues, lanePx: 3, keepPx: 3, hz: 8 }
  lens:
    width: 18
    height: 25
    anchor: [145, 84]
    fixture: true
    cycle: { gate: lamps, art: beacon, frames: 8, bandPx: 4, riseStepPx: 2, fixedBelowRankFrac: 0.25, rampStops: 6, heightFromMask: true, hz: 4 }
  runes:
    width: 312
    height: 264
    anchor: [156, 202]
    cycle: { gate: work.portal, frames: 8, bandPx: 4, riseStepPx: 2, fixedBelowRankFrac: 0.3333, rampStops: 6, heightFromMask: true, shearPx: 0, hz: 6 }
```

## Rooms (per-room light)

Night window light counts workers; it is not a building-wide switch.

- **Room masks** come from the emissive sidecar: `base.rooms.png` (room index in R) segments `base.emissive.png` into connected glass components (see Sidecars). The validator checks that each room rect (`rooms.slots`, else `windowRects`) sits ≥ 60% on one mask room, that `rooms.slots[k]` is room k + 1, that indices run 1..N with every room named by a rect, and that every mask texel lies on the closed emissive glass.
- **Per-room gate:** `assignRoomSlots({ previous, workingIds, rooms })` gives each working visitor (V8 `isWorkingVisitor`) a stable room in every building. At night room *k* lights its own sidecar texels (art-shaped, not rects) only while it is occupied (`BuildingSprite.roomGate`). Unoccupied rooms stay dark. Waiting occupants are counted but never lit, and overflow is an exact count, never an invented window.
- **Unlit glass:** by day every pane is unlit slate glass (M15), and hall panes (glass in no room, e.g. the Archive's `glassRects`) stay unlit at every hour. `RoomGlass.js` switches a pane off with its own unlit albedo: the resident pass draws one glass-patch record right after the landmark, the Canvas emitter cut carves the same canvas, and the patch alpha is `1 − gate` in quarters (`ROOM_GLASS_STEPS` 4), never a smooth fade.
- Aperture lights (2.4) and water columns (2.9) read the same per-room gate, so a dark room lights nothing.

## Aperture lights (2.4)

`ApertureLights.js` cuts each landmark's `base.emissive.png` at load into emitter blobs (alpha > 0.1, 4-connected, area ≥ 10 px) tagged with their glass group from the room map. Every blob of room k is one `role: 'aperture'` light gated by `roomGate(type, k − 1)`; hall panes make no light; off-glass blobs (lanterns, braziers, openings, crystals) share the building's night-shift gate, and same-family blobs closer than 32 px merge into one. Intensity is `apertureIntensity(area, energy.core, gate)`, radius `apertureRadius(area)` capped at 106. A registry light point within 2 px of a room's glass stands in for that room; an off-glass blob within 30 px of any registry point is skipped. The authored sidecar is therefore the light map: paint emission only where light should come from, and a new window needs no registry light.

## Village wall, gatehouse and sea tower (one ashlar family)

- One material language for the curtain, the gatehouse and the sea tower: `ART_RAMPS.ashlar` (sampled from the Command and Archive masonry), the landmark ink `#050302` on the outer silhouette only, upper-left key: SW faces lit (blocks mostly stop 5, lit 6, dark 4, joints 3), SE faces a stop darker (2–3, joints 1), top planes 7–8, cast shadows two stops down with hard edges. Moss and ivy on `grass`/`foliage`, iron on `slate`, snow on `snow`.
- Geometry (`VillageWall.WALL_SPEC`, world px = texels, scale 1): plinth 0–10 (2 px proud, lit ledge), 6-px courses from h 10, string course 42–46 (2 px proud), walk and crenel sill at 50, merlons 11 ± 1 wide, 7 apart, 10 tall, 4 deep, a 3-px-taller crown over each pier; piers 14 wide, 6 proud, to 36 with a stepped cap; the west run starts at a 24-px corner turret. Towers match the 6-px course rhythm and meet the curtain at its sill.
- Rhythm, not metronome: piers 92–150 px apart, lanterns on one pier in two or three (never closer than 170 px), loops, scuppers and ivy placed by hash; merlon widths vary by a texel.
- Lanterns: one shared bracket lantern (`drawWallLantern`) on the wall piers and the gatehouse; glass unlit by day, lit (and a fixture light) only while the village's own lamplight is up; static, no flicker.

## Pennants and Chronicle dressing (6.5, 6.7)

- **Pennants** are never painted into a sprite. Every pennant and flag (the occupancy pennant, the Harbor mast pennants and the day-long release pennant, ship flags, dock mini-pennants, the Harbor bunting) is a blit of `sprites/overlays/pennant.strip.png` (`PixelPennant.js`: 4 frames of 24 × 16, five indexed tones rim/accent/shade/pole/finial, recoloured per accent), stepped at 4 fps from the C-W3 wind, mirrored downwind, on its rest frame 1 when calm (knot wind < 0.15) or under reduced motion. A building's occupancy pennant pole base is its registry `pennant: { at }` (Command, Task Board, Archive, Observatory, Portal, Lighthouse).
- **Dressing** is a static manifest strip layer with `dressing: true` (no `fps`, `gate` or `staticFrame`), one frame per earned tier from `MonumentRules.chronicleDressingFrame`; nothing earned draws nothing, and records past retention keep their tier. Shipped: Harbor `bunting` (one pennant per verified release, 1–5), Forge `billetRack` (verified feat/fix commits: ribbon, flagship, aurora), Archive `lectern` (verified Chronicle records: flagship, aurora). Dressing sits inside the footprint, casts no light and never moves.

## Size tiers (footprint-driven; all ≤400px → single-image generation)

Rule of thumb: **sprite width ≈ 1.2 × iso-diamond width** = `1.2 · (w+h) · 32` (TILE_WIDTH=64), height by archetype.

| Tier | Buildings | Native W × H (manifest) |
|---|---|---|
| Hero hall | command, archive, harbor, portal | 312–360 × 208–264 |
| Standard structure | forge, mine, taskboard | 256 × 232 |
| Tower (narrow, tall) | observatory, watchtower | 256 × 288, 288 × 384 |

## The village's stone family (gatehouse, sea tower, curtain)

The Village Gate's gatehouse (`prop.villageGate`, with its door strip `prop.villageGateDoors`) and the east wall's sea tower (`prop.villageWallSeaTower`) follow these craft rules as scenery: baked at scale 1 (never drawn scaled) by `scripts/sprites/bake-village-gate.mjs`, an orthographic ray cast of the solids in `VILLAGE_GATE_GEOMETRY` / `SEA_TOWER_GEOMETRY` (`townPlan.js`), on the curtain's own grammar (`VillageWall.js`): `ashlar` masonry (SW faces 5, the camera 4, SE faces 3, a drum's far edge 2; joints one or two stops down; half the block tops +1; tops, ledges and string-course lips 7–8; cast shadows two stops), 6-px courses from a 10-px plinth, `domeSlate` cones in 4-px courses, `trimGold` finials, `timber` doors, and the gate's name in Press Start 2P (the chrome's display face) at one texel per font px, each letter upright in its 8-px cell on a plaque that steps down the wall. The drums stand symmetric about the arch (within 0.08 tile), so the plaque and the arch sit centred, an equal margin either side, in the face the drums leave open: from where the face leaves the west drum to the east drum's silhouette. Their corbels stand 9 px clear of the merlon tops, so the parapet meets each drum below its machicolation. A crevice line marks a nearer mass over a farther one, and a joint line marks the west drum where the arch block runs flush into it. Glass is slate by day; the towers' lamp glass is an emissive sidecar lit with the village's lamps (a fixture, never a work light), and the occluder sidecar is the 2.3 surface channel, so lanterns land on the walls by face and height and the cones take no local light. The sea tower is drawn whole after the east run that ends inside its drum (never split for occlusion, at any zoom). Rerun the bake with `--check` after any change to the geometry or the ramps; it prints the manifest size, anchor and PropWinter roof polygons.

## Generation recipe

- Tool: REST `generate-image-v2` (Pro, with `building.observatory` as the style image) or MCP `create_map_object` (≤400px, transparent BG). Smoke-test the tool per building; `generate-image-v2` produced Command, Archive, Task Board, Forge, Mine, and Portal (2026-10-01, `building.command` as the style image); `create_map_object` produced Harbor, Observatory, and Watchtower. The manifest `tool` field names the surface, and the Pro re-authors carry a `provenance` block with endpoint, job, and style image.
- `create_map_object` params (not in the description): `view: low top-down`, `outline: selective outline`, `shading: detailed shading`, `detail: high detail`, transparent background.
- Description for `terrain-apron`: prepend the manifest `style.anchor`; add subject identity, palette cues, silhouette intent, "true wall/post/rock footings and attached steps only", and "transparent ground around the structure". Explicitly forbid ground tile, lawn, slab, plinth, retaining lip, complete perimeter, and baked shadow.
- Description for a structural exception: name the physical platform (`dais`, `quay`, `deck/pilings`), its support, and its terrain/water transition. Still forbid a larger generic ground tile.
- After generation: place at `assets/sprites/buildings/<id>/base.png`; declare native dimensions and an explicit anchor; recalibrate `horizonY`, emitters, lights, overlays, chimney `smokeTop`, window and room rects (glass centres on the new sidecar), pennants, and ritual anchors; re-bake the sidecars (`bake-surface-channel.mjs`, `bake-room-masks.mjs`) and re-crop every part strip; bump `style.assetVersion`; run `npm run world:validate-buildings`.

## Reference order

Harbor (`water-pilings`) · Command (`terrain-apron`) · Portal (`intentional-dais`) · Lighthouse (`quay`). Archive, Task Board, Forge, and Mine were re-authored on the Observatory's grid and Command re-crowned as the hero in the 2026-09-25 Painted Isle landmark pass (manifest provenance items 4.2 and 4.5); preserve their recognizable silhouettes and authored material channels in future revisions.
