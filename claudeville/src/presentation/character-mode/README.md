# World Mode Renderer

World mode is the Canvas-2D isometric view that ClaudeVille shows by default. This directory owns the render loop, sprites, camera, particles, and minimap. It reads from the domain `World` and listens to the event bus; it never mutates domain state.

The directory is named `character-mode/` for historical reasons. In prose, the user-facing surface is "World mode" (paired with "Dashboard mode" under `../dashboard-mode/`).

## File ownership

| File | Responsibility |
| --- | --- |
| `IsometricRenderer.js` | Render loop (`requestAnimationFrame`), terrain/water/road generation, hit testing, click and hover handlers, event-bus subscriptions, minimap mount, selection plumbing. |
| `Camera.js` | Pan, zoom, `centerOnMap`, `followAgent` / `stopFollow`, `screenToWorld` / `worldToScreen` projections. |
| `CanvasBudget.js` | Effective DPR selection and backing-store guardrails for large desktop canvases. |
| `AgentSprite.js` | Per-agent sprite state: tile position, smoothed motion, selection ring, chat animation toward a target sprite, hit testing in world coordinates. |
| `AgentBehaviorState.js` | Per-agent behavior and destination state used by movement/visit systems. |
| `VisitIntentManager.js`, `VisitTileAllocator.js` | Building capacity, visit reservations, and destination assignment. |
| `BuildingSprite.js` | Current building visuals, sprite blits, hover state, building-specific decoration/effects, occlusion split for hero buildings, and `hitTest` in world coordinates. |
| `AssetManager.js` | Loads `manifest.yaml` and `palettes.yaml`, maps manifest IDs to PNG paths, cache-busts with `style.assetVersion`, and supplies placeholder/checker fallbacks. |
| `SpriteRenderer.js` | Single entry point for PNG sprite blits; keeps pixel-art draws snapped and smoothing disabled. |
| `SpriteSheet.js` | Character sheet frame lookup and 8-direction velocity mapping. Character sheets are 8 columns × 10 rows of 92px cells. |
| `Compositor.js` | Palette-swap and accessory overlay composition. |
| `TerrainTileset.js` | Wang-tile neighbor masks and isometric tile transforms. |
| `SceneryEngine.js` | Water, shore, bridges, vegetation, boulders, and walkability data. |
| `Pathfinder.js` | Grid pathfinding over the walkability map. |
| `AtmosphereState.js`, `SkyRenderer.js`, `WeatherRenderer.js` | Time/weather snapshots, sky rendering, and foreground weather effects. |
| `LightSourceRegistry.js` | Shared light-source records consumed by world grading and effects. |
| `HarborTraffic.js` | Harbor/ship motion and git-event-aware harbor activity. |
| `LandmarkActivity.js` | Harbor/landmark event extraction and activity state updates tied to git-event streams. |
| `AgentEventStream.js` | Shared observer that derives tool, subagent, team, and chat semantic events from `agent:*` updates. |
| `RelationshipState.js` | Debounced relationship snapshot for parent/child, team, arrival/departure, and chat-pair consumers. |
| `ArrivalDeparture.js`, `TrailRenderer.js` | Relationship arrival/departure cues and movement trails. |
| `Chronicler.js`, `ChronicleEvents.js`, `ChronicleMonuments.js` | Chronicle event capture and monument rendering. |
| `CouncilRing.js` | Team/council ring visuals around related agents. |
| `PulsePolicy.js` | Shared pulse-priority parser and defaults. |
| `DebugOverlay.js` | Shift-D debug overlay for renderer diagnostics. |
| `RitualConductor.js` | Capped, reduced-motion-aware scheduler for future tool ritual visuals. |
| `ParticleSystem.js` | Particle emitters and ambient effects. Honors `prefers-reduced-motion`. |
| `Minimap.js` | Minimap rendering and click-to-pan; mounted into the canvas's parent node. |

## Data sources and draw order

World mode is driven by four source layers:

- Domain state from `World` (`agents` and `buildings`).
- Static config from `src/config/constants.js`, `buildings.js`, `townPlan.js`, `scenery.js`, and `theme.js`.
- Sprite metadata from `claudeville/assets/sprites/manifest.yaml` and `palettes.yaml`.
- Runtime provider state already normalized into `Agent` objects, including `gitEvents` for harbor activity.

The render loop keeps the scene readable by drawing in broad layers:

1. Background washes, water, terrain cache, roads, shore, bridges, and flat features.
2. Static props and scenery sorted by world Y where they can overlap agents.
3. Building bases and occlusion-aware hero building pieces.
4. Agents, selection/status overlays, chat motion, and current-tool effects.
5. Building labels/bubbles, particles, atmospheric overlays, and the minimap.

When adding a visual feature, place it in the lowest layer that still communicates the state. Avoid adding per-frame work when it can be cached into terrain or static scenery.

## Selection lifecycle

```
canvas click (IsometricRenderer._onClick)
  → camera.screenToWorld(x, y)
  → IsometricRenderer._handleClick(worldX, worldY)
      hit-test agentSprites
      ├── hit  → sprite.selected = true
      │         camera.followAgent(sprite)
      │         onAgentSelect(agent) → App.js emits 'agent:selected'
      │
      └── miss → camera.stopFollow()
                 onAgentSelect(null)
                 App.js does not emit 'agent:deselected' for this path,
                 so the ActivityPanel stays open until its close button
                 or the selected agent is removed.

eventBus 'agent:selected' (also emitted from Sidebar / DashboardRenderer)
  → App.js _bindAgentFollow → renderer.selectAgentById(agent.id)
  → ActivityPanel.show(agent), starts 2s detail polling

ActivityPanel close button or eventBus 'agent:removed' for current agent
  → ActivityPanel.hide() → eventBus.emit('agent:deselected')
  → App.js → renderer.selectAgentById(null) → camera.stopFollow()
```

`onAgentSelect` is wired in `App.js` after the renderer is created. The renderer keeps a single `selectedAgent` reference; clearing it deselects every sprite and stops camera follow.

## Map constants

From `src/config/constants.js`:

| Constant | Value | Used by |
| --- | --- | --- |
| `TILE_WIDTH` | `64` | iso projection in `Camera.js`, every tile draw. |
| `TILE_HEIGHT` | `32` | iso projection (half of width — standard 2:1 iso). |
| `MAP_SIZE` | `40` | square tile grid; terrain seed is `MAP_SIZE * MAP_SIZE`. |
| `AGENT_SPEED` | `0.06` | sprite tile-per-frame interpolation. |

The grid is `40 × 40` tiles. World-space origin is `(0, 0)` at the top corner of the diamond; tile `(x, y)` projects to screen `((x − y) · 32, (x + y) · 16)` before camera offset and zoom.

## Event-bus integration

`IsometricRenderer.show()` subscribes to domain events and stashes the unsubscribe functions in `_unsubscribers` for teardown:

| Event | Effect on the renderer |
| --- | --- |
| `agent:added` | `_addAgentSprite(agent)` creates an `AgentSprite` and inserts it into `agentSprites`. |
| `agent:removed` | Drops the entry from `agentSprites`. |
| `agent:updated` | Replaces `sprite.agent` so the sprite reads the latest status, tool, model. |

Selection events (`agent:selected`, `agent:deselected`) are bridged in `App.js`, not subscribed here directly. The renderer exposes `selectAgentById(id)` for that bridge to call.

`mode:changed` is consumed by `IsometricRenderer` to call `setWorldModeActive(mode !== 'dashboard')`. When Dashboard mode is active, the World render loop stops and volatile renderer caches are released; when World mode becomes active again, dirty sprite state is reconciled and the loop restarts. Browser visibility and canvas context loss/restoration also pause, resume, and rebuild canvas-owned caches.

## Adding a building

1. Add an entry to `BUILDING_DEFS` in `claudeville/src/config/buildings.js`. Copy a neighboring entry for the field shape:

   ```js
   { type: '<id>', x: <tileX>, y: <tileY>, width: <w>, height: <h>,
     label: '<UPPER CASE>', icon: '<glyph>', description: '<short>' }
   ```

   Tile coordinates must keep the footprint `(x..x+width-1, y..y+height-1)` within `0..MAP_SIZE-1` and not overlap an existing building or water.

2. If `BuildingSprite.js` switches on `type` for visuals, label treatment, decoration, emitters, or building-specific overlays, add a branch for the new `type`. Reuse an existing visual if the role matches.

3. (Optional) If the building needs hover/click behavior beyond the default tooltip, subscribe in `IsometricRenderer.js` near the existing `_onMouseMoveMain` / `_onClick` handlers, or extend `BuildingSprite.hitTest`.

4. Reload the page. There is no build step — `App.js` adds buildings from `BUILDING_DEFS` on every boot (`App.js:46-49`).

## Frame and update notes

- The render loop is plain `requestAnimationFrame`; one update tick per frame, no fixed timestep.
- Water shimmer advances by `WATER_FRAME_STEP = 0.03` per frame and freezes to `STATIC_WATER_SHIMMER` when reduced motion is preferred.
- The terrain is precomputed into `terrainSeed` and a `terrainCache` canvas; only water/agents/effects redraw per frame. Adding terrain variation should extend the cache, not the per-frame path.
- Event-bus subscriptions (`agent:added`, `agent:updated`, `agent:removed`) are stored in `_unsubscribers` and torn down in `hide()`. New subscriptions in this directory should follow the same pattern to avoid leaks across mode toggles.
- `ParticleSystem.setMotionEnabled(false)` is set when `(prefers-reduced-motion: reduce)` matches; respect this when adding new effects.
- New motion-bearing features must follow [`../../../../docs/motion-budget.md`](../../../../docs/motion-budget.md): check `motionScale` before allocating animation resources, declare a pulse band, and ship a static reduced-motion fallback.
