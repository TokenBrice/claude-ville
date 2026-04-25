# Pixel-Art Visual Upgrade — Design Spec

**Date:** 2026-04-25
**Status:** Approved through brainstorming, ready for implementation planning
**Style anchor:** *epic high-fantasy pixel art, dramatic lighting, painterly palette, crisp pixel edges, no anti-aliasing, top-down 3/4 isometric where iso, heroic silhouettes, faint magical glow on landmarks*

## 1. Goal

Replace ClaudeVille's vector Canvas2D rendering with a sprite-based pixel-art renderer. Asset library generated through the [pixellab MCP](https://github.com/pixellab-code/pixellab-mcp) server. Rolled out as a single big-bang feature branch.

## 2. Non-goals

- No change to the data model (`World`, `Agent`, providers, adapters, REST/WS APIs).
- No new gameplay or UX behaviors. Selection, follow camera, particles, activity panel, dashboard mode all preserved.
- No new framework, no bundler, no build step. Vanilla ES modules + zero-dep server unchanged.
- No internationalization scope (English-only, per project policy).
- No widget changes.

## 3. Locked design decisions

| Axis | Decision | Why |
|---|---|---|
| Scope | Full pixel-art renderer (chars + buildings + props + terrain + scenery) | Coherent end state; no half-vector/half-pixel mixing |
| Projection | Hybrid — iso world (TILE 64×32 unchanged) + 8-direction front-facing characters | Keeps village identity; matches pixellab `rotate` strengths |
| Density | Standard tier — 64×32 iso tiles, 8-dir chars, walk + idle, palette swap + 1 accessory per agent | Sweet spot of asset count vs visual richness |
| Pipeline | Pixellab MCP + YAML asset manifest as single source of truth | Reproducible from versioned prompts; me as in-loop executor |
| Rollout | Big-bang single feature branch, single PR | Cleanest end state; user prefers no transitional half-states |
| Hero treatment | 4 hero buildings (Command Center, Watchtower/Lighthouse, Observatory, Portal Gate) get composed quadrants + animated overlays + occlusion split | Maximal execution quality on landmarks |
| Roof fade | Dropped (replaced by X-ray silhouette of agents passing behind buildings) | Saves 11 PNGs and a state machine; X-ray is the standard iso-game pattern |

## 4. Repo layout

```
claudeville/
  assets/
    sprites/
      manifest.yaml                        # source of truth
      palettes.yaml                        # provider palette swaps
      characters/
        agent.claude.base/
          walk-{dir}-{frame}.png           # dir = s|se|e|ne|n|nw|w|sw, frame = 0..3
          idle-{dir}-{frame}.png           # frame = 0..1
        agent.codex.base/
        agent.gemini.base/
      overlays/
        accessory.{name}-{dir}.png         # 6 accessories × 8 dirs
        status.{name}.png                  # selected ring, chat, working, idle
      buildings/
        building.{type}/
          base-{quadrant}.png              # quadrant ∈ tl|tr|bl|br for hero (composed); single for standard
          beacon.png, banner.png, ...      # named animated overlays
      props/
        prop.{name}/
          base.png
          frame-{n}.png                    # if animated
      vegetation/
        veg.{species}.{variant}.png
      terrain/
        terrain.{class-pair}/              # one folder per Wang tileset
          variant-{0..15}.png              # 16 Wang adjacency variants
      atmosphere/
        deep-sea.png                       # seamless background
        light.{name}.png                   # additive light reflections
        aurora.png                         # optional polish
  src/
    presentation/
      character-mode/
        SpriteRenderer.js                  # NEW — image blits, integer snap, smoothing off
        AssetManager.js                    # NEW — manifest loader, PNG cache, alphaMask cache
        SpriteSheet.js                     # NEW — frame strip / quadrant compositor
        BuildingSprite.js                  # NEW — replaces BuildingRenderer drawing
        TerrainTileset.js                  # NEW — Wang lookup + tileset blit
        Compositor.js                      # NEW — palette swap + accessory overlay
        AgentSprite.js                     # SHRUNK — state + dir/frame, no drawing
        IsometricRenderer.js               # SHRUNK — orchestration only, no shape drawing
        SceneryEngine.js                   # SHRUNK — generation + walkability only
        BuildingRenderer.js                # DELETED
scripts/
  sprites/
    generate.md                            # human-readable instructions for the generation session
    manifest-validator.mjs                 # node script: every id resolved, every PNG used
```

## 5. Asset manifest schema

```yaml
style:
  anchor: "epic high-fantasy pixel art, dramatic lighting, painterly palette,
           crisp pixel edges, no anti-aliasing, heroic silhouettes,
           faint magical glow on landmarks"

characters:
  - id: agent.claude.base
    tool: create_character        # MCP tool
    prompt: "epic high-fantasy mage scholar, warm amber robes with gold trim,
             glowing rune sigil on chest, hooded silhouette, front 3/4 view"
    n_directions: 8
    size: 64
    animations: [walk, idle]
    palette_layer: claude
    anchor: [32, 56]              # sprite-local pixel anchor (bottom-center of feet)
  # ... codex, gemini

palettes:                          # palette swap source/target colors
  claude:
    robe: ['#8f4f21', '#a85f24', '#7b3f1c']
    pants: ['#3b2418', '#4b2c1a', '#33231a']
    trim: ['#f2d36b', '#e9b85f', '#ffd98a']
  # ... codex, gemini

accessories:                       # 6 overlays, 8-dir each
  - id: overlay.accessory.mageHood
    tool: isometric_tile
    prompt: "wizard hood, drapes over shoulders, transparent background"
    size: 32
    n_directions: 8
    anchor: [16, 12]              # head-pixel offset on base sprite
  # ... scholarCap, goggles, toolBand, starCrown, oracleVeil

statusOverlays:
  - id: overlay.status.selected
    tool: isometric_tile
    prompt: "magical selection ring, glowing runes, faint pulse"
    size: 64
    animation: pulse              # 3-frame
  # ... chat, working, idle

buildings:
  - id: building.watchtower       # Harbor Lighthouse
    composeGrid: [3, 2]           # 3 cols × 2 rows of 128px cells → 384×256 final bitmap
    splitForOcclusion: true
    horizonY: 160                 # back/front split row in sprite-local px (composed coords)
    layers:
      base:
        tool: isometric_tile
        prompt: "epic harbor lighthouse, weathered grey stone tower,
                 crimson conical roof, brass lantern dome, dragon banner,
                 isometric, dramatic"
        size: 128                  # generates 6 cells stitched at load
      beacon:
        tool: isometric_tile
        prompt: "bright golden lantern dome glow, transparent background, isometric"
        size: 64
        anchor: [144, 38]
        animation: pulse           # 3-frame
    emitters:
      torch: [144, 28]              # particle hook, sprite-local px → world coords
  # ... command (4 watchfires + dragon-banner sway), forge (forge-mouth + smoke),
  #     observatory (astrolabe rotation + star sparkle); 7 standard buildings
  #     with single base layer

props:
  - id: prop.harbor.boat
    tool: isometric_tile
    prompt: "epic fishing boat, weathered hull, raised lantern, sailcloth furled,
             isometric"
    size: 64
    anchor: [32, 32]
  # ... lantern, signpost, runestone, well, marketStall, scrollCrates,
  #     oreCart, flowerCart, noticePillar, harborPier, harborCrates, harborCrane

vegetation:
  - id: veg.tree.oak.large
    tool: isometric_tile
    prompt: "ancient oak tree, dense canopy, twisted roots, isometric"
    size: 64
    anchor: [32, 80]
  # ... oak.small, pine.large, pine.small, willow.large, willow.small,
  #     boulder.mossy.large/small, boulder.granite.large/small,
  #     bush.a/b/c, grassTuft.a/b, reed.a/b

terrain:
  - id: terrain.grass-dirt
    tool: tileset                  # Wang 4-bit
    lower: "ancient forest grass with wildflowers and moss"
    upper: "rich loam dirt path"
    size: 32                       # per-cell base; rendered at 64×32 iso
  # ... grass-cobble, grass-shore, shore-shallow, shallow-deep, cobble-square

atmosphere:
  - id: atmosphere.deep-sea
    tool: tileset
    lower: "abyssal sea, dark currents, painterly"
    upper: "abyssal sea, dark currents, painterly"   # seamless self-tile
    size: 64
  - id: atmosphere.light.lighthouse-beam
    tool: isometric_tile
    prompt: "warm golden light reflection on water, soft, transparent background"
    size: 64
  # ... fire-glow, lantern-glow, aurora (optional)

bridges:
  - id: bridge.ew
    tool: isometric_tile
    prompt: "weathered wooden bridge, plank deck, rope rails, east-west, isometric"
    size: 64
  - id: bridge.ns
    tool: isometric_tile
    prompt: "weathered wooden bridge, plank deck, rope rails, north-south, isometric"
    size: 64
  - id: dock.ew                     # similar but barnacle-weathered planks
  - id: dock.ns
```

**Naming convention:** `<class>.<subject>[.<variant>]`. PNG filenames mirror manifest ids.

**Validation:** `scripts/sprites/manifest-validator.mjs` — every id used in code must exist in the manifest; every PNG on disk must correspond to a manifest id.

## 6. Renderer specifics

### 6.1 Smoothing & HiDPI
At canvas init and after every `setTransform`:
```js
ctx.imageSmoothingEnabled = false;
ctx.mozImageSmoothingEnabled = false;
ctx.webkitImageSmoothingEnabled = false;
```
Backing buffer scale = `Math.floor(devicePixelRatio)` (integer only — never 1.25). Fractional DPR clamped down to 1, 2, or 3.

### 6.2 Integer snap
Camera translate snapped: `ctx.translate(Math.round(-cam.x), Math.round(-cam.y))`.
Sprite blit destination snapped: `ctx.drawImage(img, sx, sy, sw, sh, Math.round(dx), Math.round(dy), sw, sh)`.
Destination size always equals source size — no fractional scaling, ever.

### 6.3 Iso projection (unchanged)
`screenX = (tileX - tileY) * 32; screenY = (tileX + tileY) * 16`.
Sprite anchored at bottom-center of footprint via `anchor: [cx, cy]` from manifest.

### 6.4 Depth sort
Same algorithm as today: drawables sorted by `screenY + footprintBottom`. Hero buildings with `splitForOcclusion: true` register two drawables — back-half (sort by tile center Y) and front-half (sort by tile bottom-edge Y). Agents between sort correctly.

### 6.5 Hit testing
Per-pixel: `alphaMask[(my - dy) * w + (mx - dx)] > 0`. Mask baked as `Uint8Array` per sprite at load time. Eliminates "click between buildings selects wrong target" bug.

### 6.6 X-ray silhouette (replaces roof fade)
When agent's footprint Y < building front-half Y, render a 30%-opacity tinted silhouette of the agent on top of the building's front half (one alpha-mask blit, no extra texture).

### 6.7 Selection & hover halos
Generated at runtime by edge detection on cached alpha mask:
- Hover: 1px gold outline behind sprite
- Selection: pulsing rune ring under sprite feet (1 PNG, shared)

No extra PNG per entity for halos.

### 6.8 Animation
Per `AgentSprite`: `(direction: 0..7, frame: int, animState: 'idle' | 'walk')`. Frame ticks at 8fps walk / 2fps idle. `direction` derived from velocity:
```js
const angle = Math.atan2(vy, vx);
const dir = Math.round(((angle + Math.PI) / (Math.PI / 4)) + 4) % 8;
```
Old `facingLeft` boolean removed.

## 7. Particle system integration

`ParticleSystem` API unchanged. Existing particle types (torch, smoke, sparkle, mining) preserved.

Emitter points move from hand-tuned offsets in `BuildingRenderer._spawnThemeParticles` (deleted) to manifest-declared `emitters: { name: [x, y] }` per building. `BuildingSprite.getEmitterPoint(name)` returns world coords; `IsometricRenderer.update()` calls `ParticleSystem.spawn` using these.

Per-building emitter map (full enumeration):

| Building | Emitters |
|---|---|
| Command Center | watchfire×4 (torch), banner×2 (sparkle) |
| Forge | smokestack (smoke), forge-mouth (mining), anvil (sparkle) |
| Mine | shaft-mouth (sparkle), cart (mining) |
| Lighthouse | lantern-cage (torch — beacon pulse via overlay) |
| Observatory | dome-top (sparkle) |
| Portal Gate | portal-arch (sparkle) |
| Alchemy | cauldron (sparkle) |
| Chat Hall | chimney (sparkle) |

## 8. Asset budget

| Bucket | PNGs |
|---|---|
| Characters (3 base × walk + idle × 8-dir) | 13 |
| Accessories + status overlays | 10 |
| Hero buildings (4 × 4 quadrants + animated overlay) | ~20 |
| Standard buildings (7 × 1) | 7 |
| Props | ~22 |
| Vegetation | 17 |
| Terrain Wang tilesets (6 × 16 variants) | ~96 |
| Bridges + docks | 4 |
| Atmosphere (deep-sea + 4 light reflections + aurora) | ~6 |
| **Total** | **~195 PNGs** |

**Generation calls** (a single `tileset` call produces 16 Wang variants; `create_character` with `n_directions: 8 + animations` produces a full sheet in one call; quadrant-composed buildings need one call per cell):

| Bucket | Calls |
|---|---|
| Characters (3 base × 1 call each, sheet output) | 3 |
| Accessories (6 × 1 call each, 8-dir output) | 6 |
| Status overlays | 4 |
| Hero buildings (4 × (3×2 grid + 1 animated overlay)) | 28 |
| Standard buildings | 7 |
| Props | ~13 |
| Vegetation | ~17 |
| Terrain Wang tilesets | 6 |
| Bridges + docks | 4 |
| Atmosphere | ~6 |
| **Total** | **~94 MCP calls** |

## 9. Generation workflow

1. User adds `pixellab` MCP server to Claude Code config with their API token.
2. User starts a Claude Code session: "regenerate sprites from manifest".
3. I read `assets/sprites/manifest.yaml`, iterate entries.
4. For each entry:
   - Concatenate `style.anchor` with entry-specific prompt.
   - Call appropriate MCP tool (`create_character`, `isometric_tile`, `tileset`, `animate_character`).
   - Save returned image bytes to PNG path matching manifest id.
   - For composed buildings (`composeAs: "5x4"`): emit 4 separate calls (one per quadrant), AssetManager stitches at boot.
5. Run `scripts/sprites/manifest-validator.mjs` to verify all referenced ids resolved.
6. Commit `assets/sprites/**/*.png`.

**Re-generation:** edit manifest entry → ask me to regenerate just that id → I make a single MCP call → commit single PNG.

## 10. Validation strategy

### 10.1 Static
- `scripts/sprites/manifest-validator.mjs` — bidirectional id ↔ PNG check.
- `node --check` on every modified .js file (existing AGENTS.md pattern).

### 10.2 Runtime smoke
- `npm run dev`, open http://localhost:4000.
- Asset load time < 2s on first paint.
- World mode renders without missing-asset placeholders.
- Switch to dashboard mode + back — no leaked listeners or canvas state corruption.
- Select agent → activity panel opens; deselect → closes (existing event-bus contract preserved).
- Resize window → canvas fills `.content`, no fractional scaling, no smoothing artifacts.

### 10.3 Visual regression
- Take screenshots at 5 known camera positions (overview, command-center, harbor, mine, forest fringe) via playwright MCP.
- Commit baseline screenshots in first commit; diff thereafter.

### 10.4 Performance
- Frame time ≤ 16ms with 20 active agents at default zoom (today's typical load).
- AssetManager memory: bitmap totals ≤ 30 MB (PNG decoded into memory).

## 11. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Pixellab API output doesn't match "epic and fantastic" anchor consistently | High | Iterate prompts in manifest; commit reference screenshot per entry; reject + regenerate when off-style |
| Hero buildings at composed 256×~280 px feel too small or too large vs current vector | Medium | Tune `BUILDING_DEFS` footprints in same PR; visual smoke before merge |
| Wang tileset edges don't blend cleanly between adjacent classes | Medium | Generate transition tilesets for the 6 declared pairs; if seams visible, add 2 more transition tilesets |
| 8-direction character generation produces directional inconsistency (different style per dir) | Medium | Use `create_character` with `n_directions: 8` (single call → consistent set), not 8 separate calls |
| Per-pixel hit test cost on every mouse-move | Low | Cache hit-tested entity per frame; only re-test on movement > 1px |
| MCP API key cost runs higher than expected for 25 calls | Low | User confirms cost ceiling before generation begins |
| Big-bang branch rots vs main | Medium | Keep PR window short (target ≤ 2 weeks); rebase weekly |

## 12. What gets deleted

Estimated ~5,000 LOC retired:
- `BuildingRenderer.js` (~3,270 lines, entire file)
- `AgentSprite.js` drawing methods (~600 lines of `_drawProvider*`, `_drawAccessory*`, `_drawEyes*`, etc — keep state, movement, chat logic)
- `IsometricRenderer.js` shape-drawing methods (~700 lines): `_drawHarborPier`, `_drawHarborBoat`, `_drawHarborCrane`, `_drawHarborCrates`, `_drawTerrainFeature`, `_drawBush`, `_drawGrassTuft`, `_drawReed`, `_drawAncientRuin`, `_drawCommandCenterDecoration`, terrain rect-fills
- `SceneryEngine.js` water-surface vector code (~150 lines) — water rendering moves to `TerrainTileset`; walkability + generation logic stays

`scenery.js` and `buildings.js` data files are untouched — layout positions stay; only the rendering layer changes.

## 13. Acceptance criteria

- World mode renders fully via sprites; no `ctx.fillRect`/`beginPath`/etc. in any drawing-related path.
- All 11 buildings, all props, all vegetation, all terrain classes display correct pixel-art assets.
- Agents move in 8 directions with walk/idle animations.
- Provider palette + per-agent accessory variation preserved.
- Particle effects fire from manifest-declared emitter points.
- Selection halo + X-ray occlusion work for all hero buildings.
- Validation strategy (§10) passes end-to-end.
- ~5,000 LOC of vector drawing code removed.
- Single PR merges to main with no transitional flag-gated state.
