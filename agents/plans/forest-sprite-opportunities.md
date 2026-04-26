# Forest Sprite Opportunities

## Audit Snapshot

- Current vegetation manifest coverage is complete: `npm run sprites:validate` reports `expected: 105  missing: 0  orphan PNGs: 0  invalid character sheets: 0`.
- Current vegetation PNG dimensions match their manifest sizes: large tree/boulder assets are `64x64`, small trees/bushes/tufts/reeds are `32x32`.
- The high-impact visual issue is qualitative: several tree sprites include visible isometric ground blocks or read as simple icon shapes, while the new northern canopy pass uses procedural canvas trees instead of manifest-backed sprites.
- `AssetManager._pathFor()` maps every `veg.*` ID to `claudeville/assets/sprites/vegetation/<id>.png`, so new forest sprite IDs can be added to `manifest.yaml` without new path rules. They still require renderer/scenery code to be referenced.

## Ranked Opportunities

### 1. Add Manifest-Backed Elder Canopy Trees

Impact: very high.
Risk: medium, because this needs a renderer follow-up to replace or supplement the current procedural northern-canopy draw path.

Recommended new manifest entries:

```yaml
  - id: veg.canopy.pine.elder
    tool: isometric_tile
    prompt: "towering elder pine forest canopy tree, layered dark evergreen branches, narrow heroic silhouette, mossy trunk visible at base, transparent background, no ground tile, no square base, isometric"
    size: 96
    anchor: [48, 88]

  - id: veg.canopy.oak.elder
    tool: isometric_tile
    prompt: "ancient elder oak forest canopy tree, broad irregular crown, twisted mossy trunk, small root flare, deep green leaves with golden highlights, transparent background, no ground tile, no square base, isometric"
    size: 96
    anchor: [48, 88]
```

Path implications:

- `claudeville/assets/sprites/vegetation/veg.canopy.pine.elder.png`
- `claudeville/assets/sprites/vegetation/veg.canopy.oak.elder.png`

Why this ranks first:

- The top/north forest is now the first visual read from the screenshot context.
- Sprites would give the dense canopy the same pixel-art contract as the rest of the world instead of relying on custom canvas silhouettes.
- Two IDs are enough for immediate variation because `SceneryEngine` already marks northern trees with `variant` and `seed`.

Execution note:

- Keep generation sequential. Generate one canopy sprite, save it, confirm dimensions with `file`, then generate the second.
- A later renderer owner can map `t.canopy && variant === 1` to `veg.canopy.pine.elder` and the oak fallback to `veg.canopy.oak.elder`.

### 2. Regenerate Existing Large Tree Sprites With Transparent Backgrounds

Impact: high.
Risk: low to medium. No renderer code is required if IDs and paths are preserved, but increasing size changes draw footprint.

Recommended manifest replacement entries:

```yaml
  - id: veg.tree.oak.large
    tool: isometric_tile
    prompt: "large ancient oak tree prop, wide asymmetrical leafy canopy, twisted mossy trunk, exposed roots, transparent background, no ground tile, no square base, no platform, isometric"
    size: 96
    anchor: [48, 88]

  - id: veg.tree.pine.large
    tool: isometric_tile
    prompt: "large tall pine tree prop, stacked conifer boughs, dark evergreen needles, slim trunk, transparent background, no ground tile, no square base, no platform, isometric"
    size: 96
    anchor: [48, 88]

  - id: veg.tree.willow.large
    tool: isometric_tile
    prompt: "large weeping willow tree prop near water, drooping curtain branches, readable trunk opening, transparent background, no ground tile, no square base, no platform, isometric"
    size: 96
    anchor: [48, 88]
```

Path implications:

- Existing paths stay the same:
  - `claudeville/assets/sprites/vegetation/veg.tree.oak.large.png`
  - `claudeville/assets/sprites/vegetation/veg.tree.pine.large.png`
  - `claudeville/assets/sprites/vegetation/veg.tree.willow.large.png`
- Because `size` would change from `64` to `96`, generated PNGs should be `96x96`.
- Bump `style.assetVersion` after replacing PNGs.

Why this ranks second:

- It improves all non-canopy tree clusters immediately.
- It removes visible base tiles that fight the authored forest-floor regions.
- It stays within the existing ID contract.

### 3. Regenerate Existing Small Tree Sprites As Saplings

Impact: medium.
Risk: low. Preserves renderer references and visual footprint.

Recommended manifest replacement entries:

```yaml
  - id: veg.tree.oak.small
    tool: isometric_tile
    prompt: "young oak sapling prop, compact leafy crown, tiny mossy trunk, transparent background, no ground tile, no square base, isometric"
    size: 48
    anchor: [24, 44]

  - id: veg.tree.pine.small
    tool: isometric_tile
    prompt: "small pine sapling prop, clean conical evergreen silhouette, tiny trunk, transparent background, no ground tile, no square base, isometric"
    size: 48
    anchor: [24, 44]

  - id: veg.tree.willow.small
    tool: isometric_tile
    prompt: "young willow sapling prop, slender trunk and drooping leafy strands, transparent background, no ground tile, no square base, isometric"
    size: 48
    anchor: [24, 44]
```

Path implications:

- Existing paths stay the same:
  - `claudeville/assets/sprites/vegetation/veg.tree.oak.small.png`
  - `claudeville/assets/sprites/vegetation/veg.tree.pine.small.png`
  - `claudeville/assets/sprites/vegetation/veg.tree.willow.small.png`
- Because `size` would change from `32` to `48`, generated PNGs should be `48x48`.
- Bump `style.assetVersion` after replacing PNGs.

### 4. Regenerate Bushes As Forest Understory

Impact: medium.
Risk: low. This is the safest no-code improvement because bush IDs are already placed by `generateFlatVegetation()`.

Recommended manifest replacement entries:

```yaml
  - id: veg.bush.a
    tool: isometric_tile
    prompt: "dense forest underbrush shrub, layered dark green leaves, a few berries, transparent background, no ground tile, isometric"
    size: 32
    anchor: [16, 20]

  - id: veg.bush.b
    tool: isometric_tile
    prompt: "wild briar underbrush, thorny crossing branches, tiny red flowers, transparent background, no ground tile, isometric"
    size: 32
    anchor: [16, 20]

  - id: veg.bush.c
    tool: isometric_tile
    prompt: "fern and white-blossom forest shrub cluster, irregular natural silhouette, transparent background, no ground tile, isometric"
    size: 32
    anchor: [16, 20]
```

Path implications:

- Existing paths stay the same:
  - `claudeville/assets/sprites/vegetation/veg.bush.a.png`
  - `claudeville/assets/sprites/vegetation/veg.bush.b.png`
  - `claudeville/assets/sprites/vegetation/veg.bush.c.png`

Why this ranks fourth:

- The current bush sprites are valid but mostly flat oval blobs.
- Better understory will help forest density without increasing occlusion risk.

### 5. Add Forest Accent Ground Props

Impact: medium to low.
Risk: medium, because new IDs need placement code before they render.

Recommended new manifest entries:

```yaml
  - id: veg.forest.stump.mossy
    tool: isometric_tile
    prompt: "moss-covered cut tree stump, small mushrooms at base, transparent background, no ground tile, isometric"
    size: 32
    anchor: [16, 24]

  - id: veg.forest.fern.cluster
    tool: isometric_tile
    prompt: "cluster of forest ferns, layered fronds, deep green with pale highlights, transparent background, no ground tile, isometric"
    size: 32
    anchor: [16, 18]

  - id: veg.forest.mushroom.ring
    tool: isometric_tile
    prompt: "tiny fairy-ring mushrooms, cream caps, subtle magical blue specks, transparent background, no ground tile, isometric"
    size: 32
    anchor: [16, 16]
```

Path implications:

- `claudeville/assets/sprites/vegetation/veg.forest.stump.mossy.png`
- `claudeville/assets/sprites/vegetation/veg.forest.fern.cluster.png`
- `claudeville/assets/sprites/vegetation/veg.forest.mushroom.ring.png`

Execution note:

- Do this after the canopy/tree replacements. These are polish props and require a later scenery placement owner.

## Generation And Validation Commands

Use the repo runbook in `scripts/sprites/generate.md`. For each generated PNG:

```bash
file claudeville/assets/sprites/vegetation/<id>.png
npm run sprites:validate
```

After a sprite batch:

```bash
npm run dev
npm run sprites:capture-fresh
npm run sprites:visual-diff
```

For browser verification of the forest specifically:

```bash
npm exec -- playwright screenshot http://localhost:4000 /tmp/claudeville-forest-sprite-check.png
```

If changing existing PNGs, also update `style.assetVersion` in `claudeville/assets/sprites/manifest.yaml`. Palette files do not need changes for the prompts above.
