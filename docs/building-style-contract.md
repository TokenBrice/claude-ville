# ClaudeVille Building Style Contract

The single visual standard for every World-mode building sprite. Derived from the gold-standard trio (Command Center, Grand Lore Archive, Observatory) and the manifest `style.anchor`. Use this when writing generation prompts and when judging a regenerated sprite. Companion to the upgrade plan: [`agents/plans/claudeville-building-harmonization-upgrade-plan.md`](../agents/plans/claudeville-building-harmonization-upgrade-plan.md).

## Craft rules (every building)

- **Projection:** true 2:1 dimetric isometric (~26.57°, 2px run : 1px rise). No flat/near-front elevations.
- **Outline:** 1px **selective** outline in warm near-black (`#060402`–`#040404`). Not pure black, not colored. External silhouette + major internal plane breaks only. No anti-aliasing.
- **Shading:** painterly, 3–4 tone steps per material, crisp cel transitions on edges. **Minimum ~35% lightness contrast** dark→light per material (no washed-out pastels).
- **Lighting:** single warm key from **upper-left**; cool shadow toward lower-right; faint magical rim-glow on landmarks.
- **Roof signature:** slate-blue tiled roof is the family motif. No terracotta-red, no sky-blue cartoon roofs.
- **Grounding (required):** every building sits on a baked **2:1 isometric diamond base** — nothing floats. Land → grass + cobble apron; arcane → dark stone floor; harbor → timber deck + water pilings. Diamond width ≈ building width + ~16px margin.

## Palette ramps (sampled from gold trio + Portal/Mine)

| Ramp | Stops (dark → light) | Use |
|---|---|---|
| Cool grey stone | `#4C3A4C` · `#5C5A70` · `#837F86` · `#A9A6AC` | default walls |
| Slate-blue roof | `#215B7F` · `#3782B5` · `#3A86BA` | all roofs |
| Crimson banner | `#782331` · `#96201A` · `#A32B21` | banners / cloth |
| Gold trim | `#BA9668` · `#D79613` · `#E0A311` · `#EFC819` | trim / metal |
| Warm torch glow | `#D79613` · `#F89206` · `#FDE2AD` | fire / window light |
| Arcane violet | `#8149B2` · `#B241F0` · `#E39AFC` | Portal / arcane only |
| Cyan ore glow | `#1E6F86` · `#45DCA8` · `#C8FFF0` | Mine ore only |
| Grass base | `#355408` · `#456F03` · `#567A16` | land diamond |
| Cobble base | `#99776A` · `#A1795E` · `#E0A665` | path / apron |

Thematic palettes (Portal violet, Mine cyan ore, Harbor warm wood) are **allowed deviations** layered on the same craft rules — not separate art styles.

## Size tiers (footprint-driven; all ≤400px → single-image generation)

Rule of thumb: **sprite width ≈ 1.2 × iso-diamond width** = `1.2 · (w+h) · 32` (TILE_WIDTH=64), height by archetype.

| Tier | Buildings | Target W × H |
|---|---|---|
| Hero hall | command, archive, harbor, observatory, portal | ~310–346 × ~210–230 |
| Standard structure (4×3) | forge, mine, taskboard | ~256–268 × ~220–240 |
| Tower (narrow, tall) | watchtower | ~280 × ~370 |

## Generation recipe

- Tool: REST `create-image-pixflux` or MCP `create_map_object` (≤400px, transparent BG). Smoke-test the tool per building; prefer whichever yields true iso + painterly (pixflux produced Archive/Harbor).
- Params (not in the description): `view: low top-down`, `outline: selective outline`, `shading: detailed shading`, `detail: high detail`, transparent background.
- Description: prepend the manifest `style.anchor`; then subject identity + the palette color cues above + "standing on a square isometric [grass-and-cobblestone | dark stone] base tile" + silhouette intent. Keep negatives short and concrete.
- After generation: place at `assets/sprites/buildings/<id>/base.png`; recalibrate `horizonY`, emitters, lightSource, and `BuildingVisualRegistry` coords (see plan §6.3); bump `style.assetVersion`.

## Reference order (best → worst, regen priority is the reverse)

Command (canon) · Portal (arcane canon) · Archive · Observatory · Harbor (warm variant) · Mine · Watchtower · Forge · Task Board.
