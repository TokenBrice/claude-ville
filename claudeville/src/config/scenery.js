// Authored scenery data for the ClaudeVille world.
// All tile coordinates are 0..MAP_SIZE-1 (40-tile grid).
// Polylines are arrays of [tileX, tileY] control points; rasterization is
// performed by SceneryEngine (Bresenham-thickened or quadratic-eased).

// Water polylines. `width` is the half-width in tiles around the centerline.
// `kind` controls visual depth: 'river' is shallow, 'moat' is deeper.
export const WATER_POLYLINES = [
    // Top-right sea inlet: a broad deep-water body that reads as open water
    // feeding the harbor instead of a defensive moat around the map edge.
    {
        kind: 'moat',
        width: 5.8,
        points: [[24, 0], [30, 1], [36, 3], [39, 5]],
    },
    {
        kind: 'moat',
        width: 5.2,
        points: [[39, 4], [38, 9], [38, 14], [38, 20], [39, 24]],
    },
    {
        kind: 'moat',
        width: 3.2,
        points: [[32, 19], [35, 20], [39, 20]],
    },
    // Main river through the village. It enters from the lower-left edge,
    // cuts between the command plaza and workshop district, then empties into
    // the top-right sea. Control points are kept clear of building footprints
    // in BUILDING_DEFS, especially Command Center, Code Forge, Watchtower, and
    // Prompt Alchemy.
    {
        kind: 'river',
        width: 1.55,
        points: [[0, 29], [7, 28], [13, 27], [18, 24], [23, 22], [27, 20], [30, 18], [32, 19], [35, 20], [39, 20]],
    },
];

// Broad authored water masses. These supplement polylines for sea/bay shapes
// where a line stroke would look too rectangular.
export const WATER_BASINS = [
    {
        kind: 'moat',
        centerX: 44,
        centerY: 16,
        radiusX: 13,
        radiusY: 24,
        edgeNoise: 0.11,
    },
    {
        kind: 'moat',
        centerX: 38,
        centerY: 3.5,
        radiusX: 13.5,
        radiusY: 9.5,
        edgeNoise: 0.14,
    },
    {
        kind: 'moat',
        centerX: 37.4,
        centerY: 18.6,
        radiusX: 6.6,
        radiusY: 5.4,
        edgeNoise: 0.16,
    },
    {
        kind: 'moat',
        centerX: 39.2,
        centerY: 16.2,
        radiusX: 4.8,
        radiusY: 6.4,
        edgeNoise: 0.12,
    },
];

// Bridge hints: explicit tile positions where a deck must exist.
// SceneryEngine may auto-place extra crossings when no hints are present, but
// these three city bridges intentionally define the visible river crossings.
// `orientation` is optional; when omitted the engine derives it from neighbor
// water tiles.
export const BRIDGE_HINTS = [
    { tileX: 13, tileY: 27 }, // west village crossing near Token Mine
    { tileX: 20, tileY: 23 }, // central crossing below Command Center
    { tileX: 30, tileY: 18 }, // workshop crossing above Code Forge
];

// Harbor decks are water tiles with dock planks. They are intentionally
// separate from BRIDGE_HINTS so the city still has three river crossings.
export const HARBOR_DOCK_TILES = [
    // South quay/causeway: directly touches the lighthouse entrance while
    // staying just outside the watchtower footprint (34..36, 14..18).
    { tileX: 31, tileY: 19, orientation: 'EW' },
    { tileX: 32, tileY: 19, orientation: 'EW' },
    { tileX: 33, tileY: 19, orientation: 'EW' },
    { tileX: 34, tileY: 19, orientation: 'EW' },
    { tileX: 35, tileY: 19, orientation: 'EW' },
    { tileX: 36, tileY: 19, orientation: 'EW' },
    { tileX: 37, tileY: 19, orientation: 'EW' },
    { tileX: 38, tileY: 19, orientation: 'EW' },
    { tileX: 39, tileY: 19, orientation: 'EW' },

    // Two berth fingers run along the open-sea side of the lighthouse.
    { tileX: 37, tileY: 14, orientation: 'NS' },
    { tileX: 37, tileY: 15, orientation: 'NS' },
    { tileX: 37, tileY: 16, orientation: 'NS' },
    { tileX: 37, tileY: 17, orientation: 'NS' },
    { tileX: 37, tileY: 18, orientation: 'NS' },
    { tileX: 39, tileY: 15, orientation: 'NS' },
    { tileX: 39, tileY: 16, orientation: 'NS' },
    { tileX: 39, tileY: 17, orientation: 'NS' },
    { tileX: 39, tileY: 18, orientation: 'NS' },
    { tileX: 39, tileY: 20, orientation: 'NS' },
    { tileX: 39, tileY: 21, orientation: 'NS' },

    // Outer lower berth for boats entering from the river mouth.
    { tileX: 36, tileY: 21, orientation: 'EW' },
    { tileX: 37, tileY: 21, orientation: 'EW' },
    { tileX: 38, tileY: 21, orientation: 'EW' },
];

// Tree clusters: anchor tile + radius (tiles) + density (0..1).
// Density is multiplied against per-tile noise; trees only spawn on
// non-water, non-path, non-shore, non-building-footprint tiles.
// SceneryEngine MUST clamp iteration to [0, MAP_SIZE-1] — corner clusters
// (4,4) and (36,36) intentionally extend past map edges to thicken the
// fringe forest.
export const TREE_CLUSTERS = [
    { centerX: 3, centerY: 4, radiusX: 7.4, radiusY: 5.5, density: 0.70 },
    { centerX: 4, centerY: 35, radiusX: 7.2, radiusY: 5.2, density: 0.66 },
    { centerX: 35, centerY: 4, radiusX: 5.8, radiusY: 6.6, density: 0.64 },
    { centerX: 36, centerY: 36, radiusX: 7, radiusY: 5.8, density: 0.68 },
    // Abundant but path-safe woodland around the settlement.
    { centerX: 9, centerY: 30, radiusX: 6.4, radiusY: 4.2, density: 0.58 },
    { centerX: 17, centerY: 32, radiusX: 5.8, radiusY: 3.6, density: 0.52 },
    { centerX: 28, centerY: 32, radiusX: 6.2, radiusY: 3.8, density: 0.56 },
    { centerX: 33, centerY: 21, radiusX: 3.2, radiusY: 4.5, density: 0.42 },
    { centerX: 14, centerY: 9, radiusX: 5.4, radiusY: 3.8, density: 0.50 },
    { centerX: 26, centerY: 7, radiusX: 4.8, radiusY: 3.5, density: 0.44 },
    { centerX: 6, centerY: 19, radiusX: 3.2, radiusY: 4.1, density: 0.36 },
    { centerX: 23, centerY: 13, radiusX: 3.8, radiusY: 2.8, density: 0.32 },
];

// Static large boulders. Drawn Y-sorted (occlude behind agents).
export const BOULDERS = [
    { tileX: 7.4, tileY: 14.2, scale: 1.1, variant: 'a' },
    { tileX: 31.6, tileY: 28.8, scale: 0.95, variant: 'b' },
    { tileX: 18.2, tileY: 31.4, scale: 1.05, variant: 'a' },
    { tileX: 25.7, tileY: 12.3, scale: 0.9, variant: 'b' },
    { tileX: 11.5, tileY: 22.8, scale: 0.85, variant: 'a' },
    { tileX: 33.4, tileY: 21.5, scale: 1.0, variant: 'b' },
    { tileX: 9.1, tileY: 11.5, scale: 0.85, variant: 'a' },
    { tileX: 30.3, tileY: 36.2, scale: 1.0, variant: 'b' },
    { tileX: 4.8, tileY: 27.4, scale: 0.95, variant: 'a' },
    { tileX: 6.2, tileY: 30.6, scale: 1.1, variant: 'b' },
    { tileX: 15.4, tileY: 34.3, scale: 0.9, variant: 'a' },
    { tileX: 27.9, tileY: 33.6, scale: 1.05, variant: 'b' },
    { tileX: 32.8, tileY: 6.5, scale: 0.9, variant: 'a' },
];

// District biases make the authored map read in larger masses instead of
// uniformly sprinkling props. Radius is radial falloff in tiles; the engine
// clamps blocked/path/water/building tiles after applying these weights.
export const VEGETATION_DISTRICTS = [
    { name: 'north-sacred-grove', centerX: 12, centerY: 7, radius: 8.5, bushBoost: 0.03, grassBoost: 0.07, treeBoost: 0.08 },
    { name: 'west-archive-brake', centerX: 6, centerY: 22, radius: 7, bushBoost: 0.05, grassBoost: 0.03, treeBoost: 0.04 },
    { name: 'south-wildwood', centerX: 19, centerY: 34, radius: 13, bushBoost: 0.05, grassBoost: 0.06, treeBoost: 0.10 },
    { name: 'harbor-windbreak', centerX: 33, centerY: 21, radius: 5.5, bushBoost: 0.035, grassBoost: 0.02, treeBoost: 0.02 },
    { name: 'alchemy-heath', centerX: 25, centerY: 10, radius: 5, bushBoost: 0.04, grassBoost: 0.04, treeBoost: 0.02 },
];

// Shoreline accents are deterministic bands near water. They add readable
// riverbanks without turning the whole shore into dense trees.
export const SHORELINE_VEGETATION = {
    bushBoost: 0.04,
    grassBoost: 0.09,
    treeBoost: 0.015,
    maxWaterDistance: 1,
};

// Negative-space pockets keep key silhouettes and crossings readable after
// district density boosts. Strength is subtracted from generated scenery
// density with radial falloff.
export const SCENERY_CLEARINGS = [
    { name: 'command-plaza', centerX: 20.5, centerY: 20.5, radius: 6.5, strength: 0.18 },
    { name: 'harbor-stage', centerX: 36.5, centerY: 19.5, radius: 6.0, strength: 0.24 },
    { name: 'forge-yard', centerX: 30, centerY: 16.5, radius: 4.5, strength: 0.12 },
    { name: 'sanctuary-lawn', centerX: 10.5, centerY: 8.5, radius: 4.8, strength: 0.14 },
    { name: 'west-bridge', centerX: 13, centerY: 27, radius: 3.2, strength: 0.20 },
    { name: 'central-bridge', centerX: 20, centerY: 23, radius: 3.5, strength: 0.22 },
    { name: 'harbor-bridge', centerX: 30, centerY: 18, radius: 3.4, strength: 0.20 },
];

// Density thresholds for noise-driven flat features.
// `BUSH_DENSITY` and `GRASS_TUFT_DENSITY` are noise thresholds in [0, 1] —
// a tile becomes a bush/tuft when its noise value falls in the band.
// Tuned to roughly match the existing 'flowers'/'mushrooms' densities.
export const BUSH_DENSITY = { min: 0.05, max: 0.13 };
export const GRASS_TUFT_DENSITY = { min: 0.18, max: 0.30 };
