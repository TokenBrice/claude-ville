# Task Board — Hero Upgrade Design

**Date:** 2026-04-27  
**Status:** Approved

## Summary

Upgrade the Task Board from a flat single-tile standard building to a full hero building: the **Arcane Rune Chronicle Court**. Twin crenellated stone watchtowers flank a massive central inscribed tablet. Horizontal amber rune-inscription lines glow across the carved stone face. A burnished gold arcane seal crowns the board. An animated `runeGlow` overlay pulses the inscriptions to life. Warm amber torch sconces burn at each tower base.

This gives the Task Board landmark presence comparable to the Command Center and Observatory while giving it a distinct identity (amber arcane stone) separate from the Portal Gate (violet) and Observatory (cold blue).

## Visual Design

**Structure:** Two ancient crenellated stone watchtowers flanking a central rune chronicle tablet. Stone plinth base runs the full width.

**Colors:** Dark weathered stone for the towers and plinth. The board face is carved stone with horizontal amber/gold glowing rune lines. Burnished gold arcane seal at the top center. Twin amber torch sconces at each tower base.

**Animation layer:** `runeGlow` — a pulsing warm amber arcane energy overlay anchored to the board face center, giving the impression that the inscriptions are alive and updating.

**Light emission:** Warm amber (`#ffb347`), radius 80px, using `atmosphere.light.fire-glow` overlay — matches the forge and harbor in warmth, distinct from the Observatory's cold blue.

## Manifest Changes

Replace the current single-tile `building.taskboard` entry in `claudeville/assets/sprites/manifest.yaml`:

```yaml
# ── HERO: Task Board (Arcane Rune Chronicle Court) ──
- id: building.taskboard
  composeGrid: [3, 2]
  splitForOcclusion: true
  horizonY: 130
  layers:
    base:
      tool: isometric_tile
      prompt: "epic arcane rune chronicle court, twin ancient crenellated stone watchtowers with amber torch sconces flanking a massive central inscribed tablet, rune-carved stone face with horizontal amber glowing inscription lines, burnished gold arcane seal at top center, stone plinth base with guild relief, warm golden firelight, heroic isometric RPG landmark"
      size: 64
      displaySize: 104
    runeGlow:
      tool: isometric_tile
      prompt: "pulsing warm amber rune glow radiating from carved stone tablet surface, horizontal glowing inscription lines, burnished gold arcane energy, transparent background, isometric"
      size: 64
      anchor: [156, 80]
      animation: pulse
  emitters:
    torch:  [52, 148]
    torch2: [260, 148]
    sparkle:  [156, 74]
    sparkle2: [156, 30]
  lightSource: [156, 80]
  lightColor: '#ffb347'
  lightRadius: 80
  lightOverlay: 'atmosphere.light.fire-glow'
```

**Remove** the old single-tile entry:
```yaml
# OLD — delete this
- id: building.taskboard
  tool: isometric_tile
  prompt: "epic task board hall, open-sided pavilion with carved stone pillars, scrolls and parchment notices pinned to boards, guild pennant flying, isometric"
  size: 64
  displaySize: 112
```

## Code Changes

### `claudeville/src/config/buildings.js`

Change `visualTier` for the taskboard entry:

```js
// before
visualTier: 'major',

// after
visualTier: 'hero',
```

Optionally increase the world footprint from `width: 4, height: 3` to `width: 5, height: 4` — defer until the generated sprite is visible and the fit can be judged in-world.

## Sprite Generation

**Tool:** PixelLab MCP (`mcp__pixellab__create_isometric_tile`)  
**Calls:** 7 total — 6 base grid cells (indices `[0,0]` through `[2,1]`) + 1 `runeGlow` overlay  
**Output paths** (per `AssetManager._pathFor`):

| File | Description |
|---|---|
| `buildings/building.taskboard/base-0-0.png` | Grid cell col 0 row 0 |
| `buildings/building.taskboard/base-0-1.png` | Grid cell col 0 row 1 |
| `buildings/building.taskboard/base-1-0.png` | Grid cell col 1 row 0 |
| `buildings/building.taskboard/base-1-1.png` | Grid cell col 1 row 1 |
| `buildings/building.taskboard/base-2-0.png` | Grid cell col 2 row 0 |
| `buildings/building.taskboard/base-2-1.png` | Grid cell col 2 row 1 |
| `buildings/building.taskboard/runeGlow.png` | Animated overlay |

**Remove** the old `buildings/building.taskboard/base.png`.

## Validation

1. `node --check claudeville/server.js` — syntax clean
2. `npm run sprites:validate` — all manifest entries resolve, no orphan PNGs
3. Visit `http://localhost:4000`, World mode — Task Board renders at hero scale with amber glow
4. Confirm `runeGlow` overlay pulses (particle system / animation tick)
5. Confirm light glow visible on nearby terrain tiles at night
6. Select an agent near the Task Board — activity panel opens correctly

## Constraints

- No frontend framework or build step changes.
- Do not alter other building definitions or sprite paths.
- `AGENTS.md` and `CLAUDE.md` parity check not needed (no doc changes).
- `assetVersion` in `manifest.yaml` must be bumped after new PNGs land on disk.
