# Village Gate Redesign — Design Spec

**Date:** 2026-04-29
**Status:** Design (pre-implementation)
**Brainstormed in session:** opus-doormaster
**Mockups archived in:** `.superpowers/brainstorm/688513-1777413951/content/`

## Summary

The village gate at the south edge of ClaudeVille reads as poor next to the rest of the village: slabby crosshatch tower fronts, a flat plank arch beam with a stuck-on lantern, a rope cap that doesn't match the surrounding pixel-art language, and a disconnected cobblestone "threshold patch" sitting in front of the arch with no road connecting to it. We rebuild the gate as a **stone-on-wood hybrid gatehouse** that integrates with the existing wooden palisade walls and the rest of the village's wood + teal palette, plus add a long avenue connecting the civic plaza to the gate so the threshold has a real road through it.

This is a procedural Canvas 2D rewrite — no new sprite assets.

## Goals

1. Replace the slab-tower / plank-beam / floating-patch gate with a hybrid gatehouse that reads as part of ClaudeVille (same wood + teal palette, same architectural language).
2. Make the threshold disappear as a "patch" — the cobble road simply passes through.
3. Land a long N-S avenue connecting the civic plaza to the gate so the gate is the terminus of a real road.
4. Bind doors to the existing agent gate-transit infrastructure that already routes spawning agents from outside the gate to inside.
5. Treat the wall-to-gate transition with a stone footing fade so the wood palisade doesn't dead-end into stone abruptly.

## Non-goals

- No new PNG sprites, no manifest changes, no `style.assetVersion` bump.
- No restyle of any other building or wall segment.
- No new event types on the bus; reuse `agent:added` (already wired) and the existing `gateTransits` Map.
- No animation/tweening; door state is binary.
- No atmosphere/weather code changes.
- No widget changes.

## Architecture

The gate is procedurally rendered in `claudeville/src/presentation/character-mode/IsometricRenderer.js` via four methods:
- `_drawVillageGatehouse(ctx, originX, originY)` — orchestrator.
- `_drawVillageGateThreshold(ctx, leftBase, rightBase)` — ground patch.
- `_drawVillageGateTower(ctx, x, y, side)` — single tower (called twice).
- `_drawVillageGateArch(ctx, leftBase, rightBase)` — beam + lantern.

Walls use `_drawVillageWallSegment(ctx, originX, originY, start, end, phase)`. Each wall route in `townPlan.js → VILLAGE_WALL_ROUTES` becomes one or more `StaticPropSprite` instances that route to this method.

The agent spawn-from-gate flow already exists:
- `_addAgentSprite(agent)` is called on `agent:added`.
- It calls `_beginAgentGateArrival(agent, sprite)` which places the sprite at `VILLAGE_GATE.outside` (tileX 18.4, tileY 39.25) and walks it to `VILLAGE_GATE.inside` (tileX 20.5, tileY 37.85).
- A `gateTransits` Map tracks the transit (`{ type: 'arrival' | 'departure' }`).
- `_beginAgentGateDeparture(agent)` does the symmetric thing on remove.

This means **we do not write spawn-from-gate logic**. We hook the door state into the already-tracked transits.

### Files touched

**`claudeville/src/presentation/character-mode/IsometricRenderer.js`**

- Add `VILLAGE_STONE_PALETTE` constant beside the existing `VILLAGE_WOOD_PALETTE`.
- Rewrite `_drawVillageGateTower` to draw stone foundation (lower ~60%), wood-frame upper (~40%), and the village's teal pitched roof. Keep the same `(x, y, side)` signature.
- Rewrite `_drawVillageGateArch` to draw a carved timber lintel, iron straps, corbel brackets, plaque ("CLAUDEVILLE"), and a hanging iron lantern. Replace the rope-strapped beam style.
- Rewrite `_drawVillageGateThreshold` to defer to the road tile renderer — i.e. delete the floating cobble-on-grass patch and the underside-shadow ellipse. The threshold is painted by the road via the new `gate-avenue` route.
- Add `_drawVillageGateWallFooting(ctx, originX, originY, start, end)` invoked as an overlay AFTER `_drawVillageWallSegment` for segments adjacent to the gate, OR detect proximity inside `_drawVillageWallSegment` itself (gate.tileX within ~1.5 tiles of either segment endpoint) and paint the footing on that endpoint. Implementer's choice.
- Add door-state rendering inside `_drawVillageGatehouse` (or its arch helper). Render either the closed double-door sprite or the open (jamb-tucked) sprite based on a single boolean.
- Add door-state computation: each frame, `doorsOpen = (this.gateTransits.size > 0) || this._hasAgentNearGate()`. Add a `_doorsOpenUntilFrame` (or wall-clock time) grace counter that holds the boolean true for ~1.5 s after both predicates go false.
- Register the gate apex lantern with `LightSourceRegistry` once at construction, matching the existing village lantern emitter shape, so the gate contributes warm light at dusk/night.

**`claudeville/src/config/townPlan.js`**

- Append a new entry to `TOWN_ROAD_ROUTES`:
  ```js
  {
    id: 'gate-avenue',
    material: 'avenue',
    width: 1,
    points: [[18, 27], [18, 32], [19, 36], [19, 39]],
  }
  ```
  Branches off the existing `central-river-bridge` spine where it turns east at (18, 27), runs ~12 tiles south through open ground (passing west of Task Board at (21, 31)), and arrives at the gate threshold (19, 39).
- Optionally adjust `VILLAGE_GATE.inside.tileX` from `20.5` to `19.0` so post-spawn agents land on the new gate-avenue. **Decision:** leave at `20.5` if pathfinding routes them along the avenue cleanly; otherwise update.
- Verify `VILLAGE_GATE_BOUNDS` still covers the new tower geometry (taller; includes teal roof). Update bounds if the new geometry overruns.

### What stays the same

- Every other building and its renderer.
- All wall segments outside ~1.5 tiles of the gate.
- All sprite PNGs and the manifest.
- All atmosphere/weather code.
- The event bus, the dashboard mode, the server, the adapters, the widget.
- `_beginAgentGateArrival` and `_beginAgentGateDeparture` (already exist; we only read from `gateTransits`).
- The existing `VILLAGE_WOOD_PALETTE`.

## Visual specs

### Towers (each ~64 world units wide)

- **Stone foundation, lower ~60%:** mossy quarried stone, 4-5 visible courses, mortar lines, mottled tone (light + mid blocks per course), narrow archer slit centered on the front, moss tuft at the base. Outline `#1b1009`, same as existing walls.
- **Wood-frame upper, ~40%:** vertical-plank infill matching the wall plank rule, one narrow window slit, horizontal floor band where stone meets wood (a structural transition, not a paint line).
- **Roof:** teal pitched roof matching every other ClaudeVille building, with the existing tealLight ridge highlight. Eaves overhang the wood frame; small shadow underneath.
- **Tower foot shadow:** a single ellipse integrated with the threshold, replacing today's two awkward separate quadrilaterals.

### Arch / lintel

- Carved timber lintel spanning between the towers' upper portions, with two iron straps and corbel brackets at each end where it meets the towers.
- A wooden plaque mounted on the lintel reading **CLAUDEVILLE** in a serif face. Spec width must accommodate at least 12 letters at the chosen font size.
- Replaces today's rope-wrapped plank beam.

### Lantern

- Square iron-bound lantern hung on a chain from the lintel apex.
- Warm glow ellipse below it that responds to atmosphere phase (brighter at night) — matches the lighting behavior of other village lanterns.
- Registered with `LightSourceRegistry` at construction so the gate contributes ambient warm light at dusk/night.

### Doors

- Iron-bound double doors, dark wood with two iron bands and ring-pull handles.
- **Two states only:** closed (both leaves shut, default) | open (both leaves tucked flat against the inner jambs; warm interior glow spills onto the road; visible interior road tile in the frame).
- Single boolean `doorsOpen`; no tweening, no rotation, no animation. The toggle is instantaneous each frame.
- **Trigger:** `doorsOpen = (gateTransits.size > 0) || _hasAgentNearGate()`. The `_hasAgentNearGate()` predicate returns true if any agent sprite occupies a tile in the box (tileX 17-21, tileY 38-39.5).
- **Grace timer:** hold `doorsOpen = true` for an additional 1.5 s after both predicates go false. Avoids visible flicker while an agent traverses the gate, and across the gap between back-to-back transits.
- **Reduced motion:** non-issue; no animation to skip.

### Threshold

- Today's `_drawVillageGateThreshold` drawing is removed. The threshold is painted by the road tile renderer via the new `gate-avenue` route, which arrives at tile (19, 39) and naturally renders cobble underneath the arch using the same `TerrainTileset` / road code that paints all other roads.
- The previous floating "underside shadow" ellipse and the disconnected cobble-on-grass quadrilateral are dropped.

### Wall stone footing

- An overlay drawn at the gate-adjacent end of each wall segment's bottom edge.
- ~16-20 px tall stone strip across the closest tile (full footing), then 3-5 dithered stone cubes of decreasing size across the next half-tile back into pure wood palisade.
- The plank face, pointed stakes, and rope ties above the footing are unchanged.
- The footing's vertical extent must stay below the existing wall watchpost base height so the watchpost cadence (~every 72 world units) is never visually overlapped.

## Configuration changes

```js
// claudeville/src/config/townPlan.js — appended to TOWN_ROAD_ROUTES
{
  id: 'gate-avenue',
  material: 'avenue',
  width: 1,
  points: [[18, 27], [18, 32], [19, 36], [19, 39]],
}
```

```js
// claudeville/src/presentation/character-mode/IsometricRenderer.js
// New constant placed beside VILLAGE_WOOD_PALETTE
const VILLAGE_STONE_PALETTE = Object.freeze({
    light: '#cfc6b3',
    mid: '#bdb6a8',
    shadow: '#a59e8d',
    mortar: '#5b574e',
    moss: '#4f7b3d',
});
```

## Validation

Per `claudeville/CLAUDE.md`:

- `node --check claudeville/src/presentation/character-mode/IsometricRenderer.js`
- `node --check claudeville/src/config/townPlan.js`
- `npm run dev`; navigate to `http://localhost:4000/`.
- Pan to the gate (south edge of map). Confirm:
  - Towers show stone foundation + wood-frame upper + teal pitched roof.
  - Arched opening with carved timber lintel + plaque ("CLAUDEVILLE") + hanging lantern.
  - No floating cobble patch in front of the gate; cobble road threads from inside the village down through the gate.
  - Doors render closed by default. Spawning a fresh agent (e.g. starting a new Claude Code session) opens the doors and the agent walks inward through the opening; doors close ~1.5 s after the agent leaves the gate proximity area.
  - Wall on either side has a stone-footing fade that meets the gate towers cleanly.
- Pan along the south wall and confirm the watchpost cadence is unbroken; the footing terminates before the next watchpost.
- Switch to night phase; confirm the gate lantern contributes warm light to the surroundings via `LightSourceRegistry`.
- `npm run sprites:validate` — should pass unchanged (no PNG/manifest changes).
- (Optional) `npm run sprites:capture-fresh` then `npm run sprites:visual-diff` to capture a new gate baseline if that workflow is in use for this branch.

No widget validation is required.

## Risks and edge cases

- **Pathfinder + new road.** The pathfinder runs over a walkability map. Adding `gate-avenue` should auto-update walkability via the existing road-routing pipeline, but verify that an agent pathing from `VILLAGE_GATE.inside` (tileX 20.5, tileY 37.85) finds and uses the avenue rather than cutting across grass. Mitigation: walk-test by spawning an agent and observing the path. If the agent strays off the avenue, tighten `VILLAGE_GATE.inside.tileX` from `20.5` to `19.0` in the same change.
- **Watchpost cadence.** The wall draws watchposts at ~72 world-unit intervals. The new stone footing must terminate or stay shorter (in vertical extent) than the watchpost base, otherwise the footing visually clashes with the post. Test by laying out the gate and observing the two adjacent watchposts.
- **Lantern emitter shape.** Existing village lantern emitters in `LightSourceRegistry` follow a specific registration shape (position, intensity, falloff). Match that shape exactly. Position the gate apex roughly at `tileToWorld(19, 39.1)` minus the lintel height; pre-compute and register once at gate construction time, not per-frame.
- **Atmosphere / sun direction.** Stone has a different albedo than wood; verify dawn / dusk / night look acceptable. The mottled stone (light + mid + shadow blocks per course) should still read clearly under existing sky tinting.
- **Door grace timer.** If multiple agents pass through in quick succession, the doors must stay open across the whole burst, not flicker. The `gateTransits.size > 0` predicate plus the 1.5 s grace timer handle this; verify with rapid spawns (start 3 sessions in quick succession).
- **Departure transits.** `_beginAgentGateDeparture` already routes leaving agents through the gate. The doors should also open during departure — the `gateTransits.size > 0` check covers both `arrival` and `departure`, so this is automatic. Confirm visually.
- **`VILLAGE_GATE_BOUNDS`.** The gate's drawing bounds in `townPlan.js` (`VILLAGE_GATE_BOUNDS`) are wired into occlusion-split logic. The new tower geometry is taller (includes teal roof above the existing top). Verify bounds still cover the new geometry; update if needed, otherwise the gate can be culled at the canvas edge or its split behave wrongly.
- **Pixel-art consistency.** All new shapes must use `shape-rendering: crispEdges`-equivalent integer coordinates (round before drawing) and the existing outline color `#1b1009` to match the rest of the village's pixel-art look.

## Open implementation questions

- **`VILLAGE_GATE.inside.tileX` adjustment.** Today's value (20.5) is 1.5 tiles east of the gate center (19.0). The new gate-avenue runs at tileX 18-19. If post-spawn pathfinding routes agents along the avenue cleanly, leave it; otherwise tighten to 19.0 in the same change. Decide during implementation by walk-testing.
- **Footing as overlay vs flag.** Either (a) pass a "footing distance" flag through `_drawVillageWallSegment`, or (b) add a separate `_drawVillageGateWallFooting` overlay drawn after the wall by the gate orchestrator. Either is acceptable; pick whichever keeps coupling cleaner during the rewrite.
