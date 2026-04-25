// Authored scenery data for the ClaudeVille world.
// All tile coordinates are 0..MAP_SIZE-1 (40-tile grid).
// Polylines are arrays of [tileX, tileY] control points; rasterization is
// performed by SceneryEngine (Bresenham-thickened or quadratic-eased).

// Water polylines. `width` is the half-width in tiles around the centerline.
// `kind` controls visual depth: 'river' is shallow, 'moat' is deeper.
export const WATER_POLYLINES = [
    // Preserved: northern curved stream (replaces inline pond+stream from
    // IsometricRenderer._generateWater).
    {
        kind: 'river',
        width: 1.4,
        points: [[2, 5], [8, 4], [14, 6], [20, 5], [22, 6]],
    },
    // Preserved: SW pond reframed as a wider river-end basin.
    {
        kind: 'river',
        width: 2.2,
        points: [[3, 33], [6, 32], [8, 33]],
    },
    // SW partial moat: short corner segment.
    {
        kind: 'moat',
        width: 1.6,
        points: [[1, 28], [1, 38], [10, 38]],
    },
    // NE partial moat: short corner segment.
    {
        kind: 'moat',
        width: 1.6,
        points: [[28, 1], [38, 1], [38, 11]],
    },
    // Diagonal river through the city, connecting the two moat ends.
    // Width tapers via per-segment control if needed; for v1 it's uniform.
    // Routed to avoid every building footprint per BUILDING_DEFS — in
    // particular it bends north of Code Forge (28..31, 15..17) and Sky
    // Watchtower (34..36, 10..14). DO NOT shorten back to (28,16) etc. —
    // that point is inside Code Forge and will silently corrupt water and
    // bridge generation.
    {
        kind: 'river',
        width: 1.3,
        points: [[10, 38], [16, 32], [22, 24], [26, 19], [30, 13], [34, 8], [38, 5]],
    },
];

// Bridge hints: explicit tile positions where a deck must exist.
// SceneryEngine will also auto-place bridges where the river polyline
// intersects pathTiles, but these guarantee the gameplay-critical crossings
// even if the river drifts during tuning. `orientation` is optional;
// when omitted the engine derives it from neighbor water tiles.
export const BRIDGE_HINTS = [
    { tileX: 5, tileY: 38, orientation: 'NS' },   // SW gate
    { tileX: 38, tileY: 5, orientation: 'EW' },   // NE gate
    { tileX: 16, tileY: 32 },                     // diagonal crossing #1
    { tileX: 22, tileY: 24 },                     // central crossing (S of Command Center)
    { tileX: 30, tileY: 13 },                     // crossing N of Code Forge
    { tileX: 34, tileY: 8 },                      // crossing N of Watchtower
];

// Tree clusters: anchor tile + radius (tiles) + density (0..1).
// Density is multiplied against per-tile noise; trees only spawn on
// non-water, non-path, non-shore, non-building-footprint tiles.
export const TREE_CLUSTERS = [
    { centerX: 4, centerY: 4, radius: 5, density: 0.55 },
    { centerX: 4, centerY: 35, radius: 4, density: 0.45 },
    { centerX: 35, centerY: 4, radius: 4, density: 0.5 },
    { centerX: 36, centerY: 36, radius: 5, density: 0.55 },
    // Inland thickets between buildings — sparser.
    { centerX: 12, centerY: 28, radius: 3, density: 0.32 },
    { centerX: 28, centerY: 32, radius: 3, density: 0.32 },
    { centerX: 14, centerY: 10, radius: 2.5, density: 0.28 },
];

// Static large boulders. Drawn Y-sorted (occlude behind agents).
export const BOULDERS = [
    { tileX: 7.4, tileY: 14.2, scale: 1.1, variant: 'a' },
    { tileX: 31.6, tileY: 28.8, scale: 0.95, variant: 'b' },
    { tileX: 18.2, tileY: 31.4, scale: 1.05, variant: 'a' },
    { tileX: 25.7, tileY: 12.3, scale: 0.9, variant: 'b' },
    { tileX: 11.5, tileY: 22.8, scale: 0.85, variant: 'a' },
    { tileX: 33.4, tileY: 21.5, scale: 1.0, variant: 'b' },
    { tileX: 9.1, tileY: 9.4, scale: 0.85, variant: 'a' },
    { tileX: 30.3, tileY: 36.2, scale: 1.0, variant: 'b' },
];

// Density thresholds for noise-driven flat features.
// `BUSH_DENSITY` and `GRASS_TUFT_DENSITY` are noise thresholds in [0, 1] —
// a tile becomes a bush/tuft when its noise value falls in the band.
// Tuned to roughly match the existing 'flowers'/'mushrooms' densities.
export const BUSH_DENSITY = { min: 0.05, max: 0.13 };
export const GRASS_TUFT_DENSITY = { min: 0.18, max: 0.34 };
