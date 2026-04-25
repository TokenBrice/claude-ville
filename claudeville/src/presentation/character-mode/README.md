# World Mode Renderer

World mode is the Canvas-2D isometric view that ClaudeVille shows by default. This directory owns the render loop, sprites, camera, particles, and minimap. It reads from the domain `World` and listens to the event bus; it never mutates domain state.

The directory is named `character-mode/` for historical reasons. In prose, the user-facing surface is "World mode" (paired with "Dashboard mode" under `../dashboard-mode/`).

## File ownership

| File | Responsibility |
| --- | --- |
| `IsometricRenderer.js` | Render loop (`requestAnimationFrame`), terrain/water/road generation, hit testing, click and hover handlers, event-bus subscriptions, minimap mount, selection plumbing. |
| `Camera.js` | Pan, zoom, `centerOnMap`, `followAgent` / `stopFollow`, `screenToWorld` / `worldToScreen` projections. |
| `AgentSprite.js` | Per-agent sprite state: tile position, smoothed motion, selection ring, chat animation toward a target sprite, hit testing in world coordinates. |
| `BuildingRenderer.js` | Building visuals, hover state, building-specific decoration and effects, `hitTest` in world coordinates. |
| `ParticleSystem.js` | Particle emitters and ambient effects. Honors `prefers-reduced-motion`. |
| `Minimap.js` | Minimap rendering and click-to-pan; mounted into the canvas's parent node. |

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
                 (no event emitted; deselection comes from the panel)

eventBus 'agent:selected' (also emitted from Sidebar / DashboardRenderer)
  → App.js _bindAgentFollow → renderer.selectAgentById(agent.id)
  → ActivityPanel.show(agent), starts 2s detail polling

ActivityPanel close button or eventBus 'agent:removed' for current agent
  → ActivityPanel.hide() → eventBus.emit('agent:deselected')
  → App.js → renderer.selectAgentById(null) → camera.stopFollow()
```

`onAgentSelect` is wired in `App.js:118-120`. The renderer keeps a single `selectedAgent` reference; clearing it deselects every sprite and stops camera follow.

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

`IsometricRenderer.show()` subscribes to three domain events (see `IsometricRenderer.js:354-361`) and stashes the unsubscribe functions in `_unsubscribers` for teardown:

| Event | Effect on the renderer |
| --- | --- |
| `agent:added` | `_addAgentSprite(agent)` creates an `AgentSprite` and inserts it into `agentSprites`. |
| `agent:removed` | Drops the entry from `agentSprites`. |
| `agent:updated` | Replaces `sprite.agent` so the sprite reads the latest status, tool, model. |

Selection events (`agent:selected`, `agent:deselected`) are bridged in `App.js:140-154`, not subscribed here directly. The renderer exposes `selectAgentById(id)` for that bridge to call.

`mode:changed` is not consumed by this directory. `ModeManager` toggles `#characterMode` and `#dashboardMode` via `display: none` (`ModeManager.js:19-29`); the renderer keeps running while hidden. Stop or pause logic should be added explicitly if frame cost becomes a concern.

## Adding a building

1. Add an entry to `BUILDING_DEFS` in `claudeville/src/config/buildings.js`. Copy a neighboring entry for the field shape:

   ```js
   { type: '<id>', x: <tileX>, y: <tileY>, width: <w>, height: <h>,
     label: '<UPPER CASE>', icon: '<glyph>', description: '<short>' }
   ```

   Tile coordinates must keep the footprint `(x..x+width-1, y..y+height-1)` within `0..MAP_SIZE-1` and not overlap an existing building or water.

2. If `BuildingRenderer.js` switches on `type` for visuals (icons, roof color, decoration), add a branch for the new `type`. Reuse an existing visual if the role matches.

3. (Optional) If the building needs hover/click behavior beyond the default tooltip, subscribe in `IsometricRenderer.js` near the existing `_onMouseMoveMain` / `_onClick` handlers, or extend `BuildingRenderer.hitTest`.

4. Reload the page. There is no build step — `App.js` adds buildings from `BUILDING_DEFS` on every boot (`App.js:46-49`).

## Frame and update notes

- The render loop is plain `requestAnimationFrame`; one update tick per frame, no fixed timestep.
- Water shimmer advances by `WATER_FRAME_STEP = 0.03` per frame and freezes to `STATIC_WATER_SHIMMER` when reduced motion is preferred.
- The terrain is precomputed into `terrainSeed` and a `terrainCache` canvas; only water/agents/effects redraw per frame. Adding terrain variation should extend the cache, not the per-frame path.
- Event-bus subscriptions (`agent:added`, `agent:updated`, `agent:removed`) are stored in `_unsubscribers` and torn down in `hide()`. New subscriptions in this directory should follow the same pattern to avoid leaks across mode toggles.
- `ParticleSystem.setMotionEnabled(false)` is set when `(prefers-reduced-motion: reduce)` matches; respect this when adding new effects.
