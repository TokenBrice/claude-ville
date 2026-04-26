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
        width: 2.6,
        points: [[31, 22], [34, 22], [37, 22], [39, 23]],
    },
    // Main moat through City Center. It separates the north civic landmarks
    // from the production row, then drains into the harbor sea.
    {
        kind: 'moat',
        width: 2.15,
        points: [[0, 25], [9, 25], [14, 25], [22, 25], [30, 24], [35, 23], [39, 22]],
    },
];

// Broad authored water masses. These supplement polylines for sea/bay shapes
// where a line stroke would look too rectangular.
export const WATER_BASINS = [
    {
        kind: 'moat',
        centerX: 0.8,
        centerY: 25,
        radiusX: 4.2,
        radiusY: 3.3,
        edgeNoise: 0.06,
    },
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
        centerX: 37.3,
        centerY: 21.7,
        radiusX: 6.8,
        radiusY: 7.4,
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
    { tileX: 14, tileY: 25, orientation: 'NS' }, // Portal/Mine bridge across the production river
    { tileX: 22, tileY: 25, orientation: 'NS' }, // Command/Tasks bridge into the production row
];

// Harbor decks are water tiles with dock planks. They are intentionally
// separate from BRIDGE_HINTS so river crossings and harbor decking stay distinct.
export const HARBOR_DOCK_TILES = [
    // Harbor causeway: a narrow bridge from the archive bank to the harbor
    // docks, separate from the wider south river crossings.
    { tileX: 29, tileY: 19, orientation: 'EW' },
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

    // North beacon approach plus two berth fingers on the open-sea side.
    { tileX: 34, tileY: 17, orientation: 'NS' },
    { tileX: 35, tileY: 15, orientation: 'NS' },
    { tileX: 35, tileY: 16, orientation: 'NS' },
    { tileX: 36, tileY: 14, orientation: 'EW' },
    { tileX: 36, tileY: 15, orientation: 'EW' },
    { tileX: 37, tileY: 14, orientation: 'NS' },
    { tileX: 37, tileY: 15, orientation: 'NS' },
    { tileX: 37, tileY: 16, orientation: 'NS' },
    { tileX: 37, tileY: 17, orientation: 'NS' },
    { tileX: 37, tileY: 18, orientation: 'NS' },
    { tileX: 38, tileY: 17, orientation: 'EW' },
    { tileX: 39, tileY: 15, orientation: 'NS' },
    { tileX: 39, tileY: 16, orientation: 'NS' },
    { tileX: 39, tileY: 17, orientation: 'NS' },
    { tileX: 39, tileY: 18, orientation: 'NS' },
    { tileX: 38, tileY: 20, orientation: 'EW' },
    { tileX: 39, tileY: 20, orientation: 'NS' },
    { tileX: 39, tileY: 21, orientation: 'NS' },
    { tileX: 39, tileY: 22, orientation: 'NS' },

    // Harbor mouth decking: explicit docks avoid the bridge-span slab that
    // would otherwise cover the bay.
    { tileX: 32, tileY: 20, orientation: 'EW' },
    { tileX: 33, tileY: 20, orientation: 'EW' },
    { tileX: 34, tileY: 20, orientation: 'EW' },
    { tileX: 35, tileY: 20, orientation: 'EW' },
    { tileX: 32, tileY: 21, orientation: 'EW' },
    { tileX: 33, tileY: 21, orientation: 'EW' },
    { tileX: 34, tileY: 21, orientation: 'EW' },
    { tileX: 35, tileY: 21, orientation: 'EW' },

    // Outer lower berth for boats entering from the river mouth.
    { tileX: 36, tileY: 21, orientation: 'EW' },
    { tileX: 37, tileY: 21, orientation: 'EW' },
    { tileX: 38, tileY: 21, orientation: 'EW' },
    { tileX: 36, tileY: 22, orientation: 'EW' },
    { tileX: 37, tileY: 22, orientation: 'EW' },
    { tileX: 38, tileY: 22, orientation: 'EW' },
    { tileX: 39, tileY: 22, orientation: 'EW' },
];

// Large authored forest-floor masses. These sit under the sprite trees and
// make the north map read as one old fantasy woodland instead of isolated
// random props.
export const FOREST_FLOOR_REGIONS = [
    { name: 'northwest-elderwood', centerX: 7.5, centerY: 7.5, radiusX: 9.8, radiusY: 7.2, base: '#21492a', accent: '#386b33', strength: 0.90 },
    { name: 'northern-canopy', centerX: 17.5, centerY: 6.2, radiusX: 13.2, radiusY: 6.4, base: '#1d4329', accent: '#315f31', strength: 1.00 },
    { name: 'archive-greenwood', centerX: 27.8, centerY: 8.2, radiusX: 9.8, radiusY: 6.6, base: '#203f2c', accent: '#3f6b38', strength: 0.80 },
    { name: 'observatory-grove', centerX: 10.5, centerY: 14.2, radiusX: 6.2, radiusY: 4.8, base: '#24482c', accent: '#426d35', strength: 0.68 },
    { name: 'lighthouse-windbreak', centerX: 33.2, centerY: 10.8, radiusX: 5.8, radiusY: 6.2, base: '#1f4430', accent: '#3e6a3c', strength: 0.58 },
];

// Tree clusters: anchor tile + radius (tiles) + density (0..1).
// Density is multiplied against per-tile noise; trees only spawn on
// non-water, non-path, non-shore, non-building-footprint tiles.
// SceneryEngine MUST clamp iteration to [0, MAP_SIZE-1] — corner clusters
// (4,4) and (36,36) intentionally extend past map edges to thicken the
// fringe forest.
export const TREE_CLUSTERS = [
    // North crown: contiguous layered woodland with a few intentional glades.
    { centerX: 4, centerY: 5, radiusX: 8.4, radiusY: 6.2, density: 0.84 },
    { centerX: 14, centerY: 5, radiusX: 10.6, radiusY: 5.6, density: 0.80 },
    { centerX: 24, centerY: 5, radiusX: 8.8, radiusY: 5.4, density: 0.76 },
    { centerX: 31, centerY: 8, radiusX: 5.4, radiusY: 5.8, density: 0.58 },
    { centerX: 13, centerY: 12, radiusX: 6.8, radiusY: 4.6, density: 0.68 },
    { centerX: 22, centerY: 12, radiusX: 5.6, radiusY: 4.0, density: 0.56 },
    { centerX: 4, centerY: 35, radiusX: 7.6, radiusY: 5.6, density: 0.68 },
    { centerX: 35, centerY: 4, radiusX: 4.8, radiusY: 5.8, density: 0.52 },
    { centerX: 36, centerY: 36, radiusX: 7, radiusY: 5.8, density: 0.68 },
    // Abundant but path-safe woodland around the settlement.
    { centerX: 7, centerY: 31, radiusX: 6.8, radiusY: 4.6, density: 0.60 },
    { centerX: 17, centerY: 32, radiusX: 5.8, radiusY: 3.6, density: 0.52 },
    { centerX: 28, centerY: 32, radiusX: 6.2, radiusY: 3.8, density: 0.52 },
    { centerX: 33, centerY: 22, radiusX: 3.0, radiusY: 4.4, density: 0.30 },
    { centerX: 6, centerY: 20, radiusX: 4.8, radiusY: 4.8, density: 0.50 },
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
    { name: 'northern-elderwood', centerX: 17, centerY: 8, radius: 15.0, bushBoost: 0.044, grassBoost: 0.060, treeBoost: 0.120 },
    { name: 'scholars-ridge', centerX: 17, centerY: 18, radius: 10.0, bushBoost: 0.022, grassBoost: 0.048, treeBoost: 0.040 },
    { name: 'west-river-frame', centerX: 7, centerY: 22, radius: 7.0, bushBoost: 0.04, grassBoost: 0.045, treeBoost: 0.065 },
    { name: 'portal-grove', centerX: 10.5, centerY: 28.5, radius: 5.0, bushBoost: 0.032, grassBoost: 0.023, treeBoost: 0.018 },
    { name: 'south-wildwood', centerX: 22, centerY: 35, radius: 12, bushBoost: 0.04, grassBoost: 0.05, treeBoost: 0.08 },
    { name: 'harbor-windbreak', centerX: 35, centerY: 22, radius: 5.2, bushBoost: 0.020, grassBoost: 0.014, treeBoost: 0.008 },
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
    { name: 'elderwood-glade', centerX: 16.8, centerY: 10.5, radius: 3.6, strength: 0.18 },
    { name: 'archive-skybreak', centerX: 28.4, centerY: 14.0, radius: 5.8, strength: 0.95 },
    { name: 'observatory-approach', centerX: 11.2, centerY: 16.8, radius: 3.9, strength: 0.24 },
    { name: 'command-skyline', centerX: 20.4, centerY: 16.0, radius: 4.4, strength: 0.22 },
    { name: 'lighthouse-beacon-skybreak', centerX: 34.0, centerY: 12.6, radius: 3.8, strength: 0.24 },
    { name: 'north-bank-civic', centerX: 20, centerY: 22, radius: 6.4, strength: 0.23 },
    { name: 'observatory-terrace', centerX: 10, centerY: 19, radius: 4.8, strength: 0.20 },
    { name: 'archive-terrace', centerX: 28, centerY: 18, radius: 5.2, strength: 0.36 },
    { name: 'production-row', centerX: 22, centerY: 29.5, radius: 12.0, strength: 0.21 },
    { name: 'harbor-stage', centerX: 37, centerY: 20.5, radius: 7.5, strength: 0.28 },
    { name: 'portal-mine-bridge', centerX: 14, centerY: 24, radius: 3.5, strength: 0.24 },
    { name: 'command-task-bridge', centerX: 22, centerY: 24, radius: 3.6, strength: 0.25 },
    { name: 'harbor-mouth', centerX: 32, centerY: 21, radius: 4.0, strength: 0.24 },
];

// Density thresholds for noise-driven flat features.
// `BUSH_DENSITY` and `GRASS_TUFT_DENSITY` are noise thresholds in [0, 1] —
// a tile becomes a bush/tuft when its noise value falls in the band.
// Tuned to roughly match the existing 'flowers'/'mushrooms' densities.
export const BUSH_DENSITY = { min: 0.05, max: 0.13 };
export const GRASS_TUFT_DENSITY = { min: 0.18, max: 0.30 };
