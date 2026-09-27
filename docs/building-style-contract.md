# ClaudeVille Building Style Contract

The visual and runtime contract for every World-mode building. Observatory is the style reference for the landmark family, Command Center is the hero and land-material reference, Harbor is the water-contact reference, and Portal/Lighthouse are named structural-platform exceptions. Use this when writing generation prompts, defining grounding metadata, and reviewing a regenerated sprite.

## Craft rules (every building)

- **Projection:** true 2:1 dimetric isometric (~26.57°, 2px run : 1px rise). No flat/near-front elevations.
- **Outline:** 1px **selective** outline in warm near-black (`#060402`–`#040404`). Not pure black, not colored. External silhouette + major internal plane breaks only. No anti-aliasing.
- **Shading:** painterly, 3–4 tone steps per material, crisp cel transitions on edges. **Minimum ~35% lightness contrast** dark→light per material (no washed-out pastels).
- **Lighting:** single warm key from **upper-left**; cool shadow toward lower-right; faint magical rim-glow on landmarks.
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
| `timber` | `#2A1C14` · `#45301F` · `#654629` · `#8A6337` | beams, planks, doors, hulls |
| `clothCrimson` | `#732A31` · `#A4463F` | banners and awnings; the only red on buildings |
| `clothOchre` | `#987638` · `#C9A04A` | awnings, pennant fringes, brass-toned cloth |
| `emissive` | `#FF9D4A` · `#FFCF7A` · `#FFE9B8` | reserved for authored lamp, fire, and window light |
| `grass`, `dirt`, `road`, `plaza` | see `artPalette.js` | terrain-owned; never baked into a land sprite |

Thematic palettes (Portal violet, Mine cyan ore, Harbor warm wood) are **allowed deviations** layered on the same craft rules — not separate art styles.

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
- After generation: place at `assets/sprites/buildings/<id>/base.png`; declare native dimensions and an explicit anchor; recalibrate `horizonY`, emitters, lights, overlays, windows, pennants, and ritual anchors; bump `style.assetVersion`.

## Reference order

Harbor (`water-pilings`) · Command (`terrain-apron`) · Portal (`intentional-dais`) · Lighthouse (`quay`). Archive, Task Board, Forge, and Mine were re-authored on the Observatory's grid and Command re-crowned as the hero in the 2026-09-25 Painted Isle landmark pass (manifest provenance items 4.2 and 4.5); preserve their recognizable silhouettes and authored material channels in future revisions.
