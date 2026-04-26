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
        width: 6.1,
        points: [[23, 0], [29, 1], [35, 3], [39, 6]],
    },
    {
        kind: 'moat',
        width: 6.3,
        points: [[39, 3], [36, 9], [35, 15], [35, 22], [37, 29], [39, 34]],
    },
    {
        kind: 'moat',
        width: 4.4,
        points: [[29, 20], [33, 20], [37, 21], [39, 22]],
    },
    // Main river through City Center. It separates the north civic landmarks
    // from the task-board/forge side, then drains into the harbor sea.
    {
        kind: 'river',
        width: 1.18,
        points: [[5, 23], [10, 23], [15, 24], [19, 24], [23, 23], [28, 22], [33, 21], [39, 20]],
    },
];

// Broad authored water masses. These supplement polylines for sea/bay shapes
// where a line stroke would look too rectangular.
export const WATER_BASINS = [
    {
        kind: 'moat',
        centerX: 43,
        centerY: 19,
        radiusX: 13.6,
        radiusY: 25,
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
        centerX: 36.5,
        centerY: 21.4,
        radiusX: 8.2,
        radiusY: 7.8,
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
// these authored hints intentionally define the visible river crossings.
// `orientation` is optional; when omitted the engine derives it from neighbor
// water tiles.
export const BRIDGE_HINTS = [
    { tileX: 11, tileY: 23, orientation: 'NS' }, // west river crossing toward Portal and Token Mine
    { tileX: 17, tileY: 24, orientation: 'NS' }, // civic bridge into the southern plaza
    { tileX: 20, tileY: 22, orientation: 'NS' }, // command-center front crossing
    { tileX: 22, tileY: 23, orientation: 'NS' }, // Command/Archive bridge into Task Board
];

// Harbor decks are water tiles with dock planks. They are intentionally
// separate from BRIDGE_HINTS so river crossings and harbor decking stay distinct.
export const HARBOR_DOCK_TILES = [
    // South quay/causeway: directly touches the lighthouse entrance while
    // staying just outside the watchtower footprint (34..36, 14..18).
    { tileX: 30, tileY: 19, orientation: 'EW' },
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
    { tileX: 39, tileY: 22, orientation: 'NS' },

    // Harbor mouth decking: explicit docks avoid the bridge-span slab that
    // would otherwise cover the bay.
    { tileX: 29, tileY: 20, orientation: 'EW' },
    { tileX: 30, tileY: 20, orientation: 'EW' },
    { tileX: 31, tileY: 20, orientation: 'EW' },
    { tileX: 32, tileY: 20, orientation: 'EW' },
    { tileX: 33, tileY: 20, orientation: 'EW' },
    { tileX: 34, tileY: 20, orientation: 'EW' },
    { tileX: 35, tileY: 20, orientation: 'EW' },

    // Outer lower berth for boats entering from the river mouth.
    { tileX: 36, tileY: 21, orientation: 'EW' },
    { tileX: 37, tileY: 21, orientation: 'EW' },
    { tileX: 38, tileY: 21, orientation: 'EW' },
    { tileX: 36, tileY: 22, orientation: 'EW' },
    { tileX: 37, tileY: 22, orientation: 'EW' },
    { tileX: 38, tileY: 22, orientation: 'EW' },
    { tileX: 39, tileY: 22, orientation: 'EW' },
];

// Tree clusters: anchor tile + radius (tiles) + density (0..1).
// Density is multiplied against per-tile noise; trees only spawn on
// non-water, non-path, non-shore, non-building-footprint tiles.
// SceneryEngine MUST clamp iteration to [0, MAP_SIZE-1] — corner clusters
// (4,4) and (36,36) intentionally extend past map edges to thicken the
// fringe forest.
export const TREE_CLUSTERS = [
    { centerX: 3, centerY: 4, radiusX: 7.8, radiusY: 5.8, density: 0.72 },
    { centerX: 4, centerY: 35, radiusX: 7.6, radiusY: 5.6, density: 0.68 },
    { centerX: 35, centerY: 4, radiusX: 5.8, radiusY: 6.6, density: 0.64 },
    { centerX: 36, centerY: 36, radiusX: 7, radiusY: 5.8, density: 0.68 },
    // Abundant but path-safe woodland around the settlement.
    { centerX: 7, centerY: 31, radiusX: 6.8, radiusY: 4.6, density: 0.60 },
    { centerX: 17, centerY: 32, radiusX: 5.8, radiusY: 3.6, density: 0.52 },
    { centerX: 28, centerY: 32, radiusX: 6.2, radiusY: 3.8, density: 0.52 },
    { centerX: 33, centerY: 21, radiusX: 3.2, radiusY: 4.5, density: 0.42 },
    { centerX: 13, centerY: 9, radiusX: 5.8, radiusY: 4.0, density: 0.52 },
    { centerX: 26, centerY: 7, radiusX: 4.8, radiusY: 3.5, density: 0.44 },
    { centerX: 6, centerY: 19, radiusX: 4.8, radiusY: 4.8, density: 0.52 },
    { centerX: 18, centerY: 9, radiusX: 4.2, radiusY: 2.9, density: 0.32 },
];

// Static large boulders. Drawn Y-sorted (occlude behind agents).
export const BOULDERS = [
    { tileX: 7.4, tileY: 14.2, scale: 1.1, variant: 'a' },
    { tileX: 31.6, tileY: 28.8, scale: 0.95, variant: 'b' },
    { tileX: 18.2, tileY: 31.4, scale: 1.05, variant: 'a' },
    { tileX: 20.4, tileY: 11.6, scale: 0.9, variant: 'b' },
    { tileX: 12.4, tileY: 24.2, scale: 0.85, variant: 'a' },
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
    { name: 'north-grove', centerX: 14, centerY: 14, radius: 6.8, bushBoost: 0.025, grassBoost: 0.06, treeBoost: 0.05 },
    { name: 'west-wilderness-frame', centerX: 7, centerY: 22, radius: 7.0, bushBoost: 0.04, grassBoost: 0.045, treeBoost: 0.07 },
    { name: 'portal-grove', centerX: 15.5, centerY: 26.5, radius: 4.5, bushBoost: 0.035, grassBoost: 0.025, treeBoost: 0.02 },
    { name: 'south-wildwood', centerX: 19, centerY: 35, radius: 12, bushBoost: 0.04, grassBoost: 0.05, treeBoost: 0.08 },
    { name: 'harbor-windbreak', centerX: 33, centerY: 22, radius: 5.2, bushBoost: 0.028, grassBoost: 0.018, treeBoost: 0.012 },
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
    { name: 'city-center', centerX: 20, centerY: 23.5, radius: 7.0, strength: 0.20 },
    { name: 'harbor-stage', centerX: 36.5, centerY: 21, radius: 7.4, strength: 0.27 },
    { name: 'forge-yard', centerX: 29, centerY: 27.5, radius: 4.5, strength: 0.12 },
    { name: 'portal-yard', centerX: 15.5, centerY: 27, radius: 4.0, strength: 0.16 },
    { name: 'mine-yard', centerX: 20, centerY: 28, radius: 3.8, strength: 0.14 },
    { name: 'civic-bridge', centerX: 17, centerY: 24, radius: 3.5, strength: 0.22 },
    { name: 'command-bridge', centerX: 22, centerY: 23, radius: 3.5, strength: 0.22 },
    { name: 'harbor-bridge', centerX: 31, centerY: 21, radius: 3.4, strength: 0.20 },
];

// Density thresholds for noise-driven flat features.
// `BUSH_DENSITY` and `GRASS_TUFT_DENSITY` are noise thresholds in [0, 1] —
// a tile becomes a bush/tuft when its noise value falls in the band.
// Tuned to roughly match the existing 'flowers'/'mushrooms' densities.
export const BUSH_DENSITY = { min: 0.05, max: 0.13 };
export const GRASS_TUFT_DENSITY = { min: 0.18, max: 0.30 };
