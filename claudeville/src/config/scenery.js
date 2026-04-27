// Authored scenery data for the ClaudeVille world.
// All tile coordinates are 0..MAP_SIZE-1 (40-tile grid).
// Polylines are arrays of [tileX, tileY] control points; rasterization is
// performed by SceneryEngine (Bresenham-thickened or quadratic-eased).

// Water polylines. `width` is the half-width in tiles around the centerline.
// `kind` controls visual depth: 'river' is shallow, 'moat' is deeper.
export const WATER_POLYLINES = [
    // Northwest jungle stream: breaks up the old conifer wall with bright
    // lagoon water and gives the upper-left forest a tropical focal point.
    {
        kind: 'river',
        width: 1.35,
        points: [[2, 7], [6, 8], [10, 8], [14, 9], [17, 10]],
    },
    // Forest spring: a bright tropical cascade feeding the northern lagoon.
    {
        kind: 'river',
        width: 1.05,
        points: [[18, 4], [18, 6], [17, 8], [17, 10]],
    },
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
        kind: 'river',
        centerX: 7.6,
        centerY: 8.3,
        radiusX: 5.1,
        radiusY: 3.4,
        edgeNoise: 0.22,
    },
    {
        kind: 'river',
        centerX: 12.4,
        centerY: 5.2,
        radiusX: 3.6,
        radiusY: 2.4,
        edgeNoise: 0.18,
    },
    {
        kind: 'river',
        centerX: 17.4,
        centerY: 10.5,
        radiusX: 4.8,
        radiusY: 3.2,
        edgeNoise: 0.18,
    },
    {
        kind: 'river',
        centerX: 24.8,
        centerY: 7.6,
        radiusX: 3.6,
        radiusY: 2.4,
        edgeNoise: 0.16,
    },
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

// The generated Harbor Master sprite now carries the quay, pier fingers, and
// visual dock surface. Keep authored dock tiles out of the bay so the runtime
// commit ships can gather around the sprite without a second grid of planks.
export const HARBOR_DOCK_TILES = [
    { tileX: 29, tileY: 19, orientation: 'EW', style: 'causeway' },
    { tileX: 30, tileY: 19, orientation: 'EW', style: 'causeway' },
    { tileX: 31, tileY: 19, orientation: 'EW', style: 'causeway' },
    { tileX: 31, tileY: 20, orientation: 'NS', style: 'causeway' },
];

// Large authored forest-floor masses. These sit under the sprite trees and
// make the north map read as one old fantasy woodland instead of isolated
// random props.
export const FOREST_FLOOR_REGIONS = [
    { name: 'northwest-elderwood', centerX: 7.5, centerY: 7.5, radiusX: 9.8, radiusY: 7.2, base: '#2d5a2b', accent: '#5c8b3f', strength: 0.90 },
    { name: 'northern-canopy', centerX: 17.5, centerY: 6.2, radiusX: 13.2, radiusY: 6.4, base: '#28562e', accent: '#659644', strength: 1.00 },
    { name: 'archive-greenwood', centerX: 27.8, centerY: 8.2, radiusX: 9.8, radiusY: 6.6, base: '#2e5835', accent: '#6c9648', strength: 0.80 },
    { name: 'observatory-grove', centerX: 10.5, centerY: 14.2, radiusX: 6.2, radiusY: 4.8, base: '#315f32', accent: '#729948', strength: 0.68 },
    { name: 'lighthouse-windbreak', centerX: 30.2, centerY: 10.8, radiusX: 5.8, radiusY: 6.2, base: '#315a36', accent: '#73924c', strength: 0.58 },
];

// Tree clusters: anchor tile + radius (tiles) + density (0..1).
// Density is multiplied against per-tile noise; trees only spawn on
// non-water, non-path, non-shore, non-building-footprint tiles.
// SceneryEngine MUST clamp iteration to [0, MAP_SIZE-1] — corner clusters
// (4,4) and (36,36) intentionally extend past map edges to thicken the
// fringe forest.
export const TREE_CLUSTERS = [
    // North crown: contiguous layered woodland with a few intentional glades.
    { centerX: 4, centerY: 5, radiusX: 8.4, radiusY: 6.2, density: 0.84, palmBias: 0.62 },
    { centerX: 14, centerY: 5, radiusX: 10.6, radiusY: 5.6, density: 0.80, palmBias: 0.54 },
    { centerX: 24, centerY: 5, radiusX: 8.8, radiusY: 5.4, density: 0.76, palmBias: 0.42 },
    { centerX: 28, centerY: 8, radiusX: 5.4, radiusY: 5.8, density: 0.58, palmBias: 0.42 },
    { centerX: 13, centerY: 12, radiusX: 6.8, radiusY: 4.6, density: 0.68, palmBias: 0.50 },
    { centerX: 22, centerY: 12, radiusX: 5.6, radiusY: 4.0, density: 0.56, palmBias: 0.54 },
    { centerX: 4, centerY: 35, radiusX: 7.6, radiusY: 5.6, density: 0.68, palmBias: 0.52 },
    { centerX: 35, centerY: 4, radiusX: 4.8, radiusY: 5.8, density: 0.52, palmBias: 0.44 },
    { centerX: 36, centerY: 36, radiusX: 7, radiusY: 5.8, density: 0.68, palmBias: 0.68 },
    // Abundant but path-safe woodland around the settlement.
    { centerX: 7, centerY: 31, radiusX: 6.8, radiusY: 4.6, density: 0.40, palmBias: 0.50 },
    { centerX: 17, centerY: 32, radiusX: 5.8, radiusY: 3.6, density: 0.35, palmBias: 0.42 },
    { centerX: 28, centerY: 32, radiusX: 6.2, radiusY: 3.8, density: 0.35, palmBias: 0.48 },
    { centerX: 33, centerY: 22, radiusX: 3.0, radiusY: 4.4, density: 0.30, palmBias: 0.58 },
    { centerX: 6, centerY: 20, radiusX: 4.8, radiusY: 4.8, density: 0.39, palmBias: 0.44 },
    { centerX: 18, centerY: 23, radiusX: 7.2, radiusY: 3.2, density: 0.28, palmBias: 0.61 },
    { centerX: 26, centerY: 23, radiusX: 5.6, radiusY: 3.6, density: 0.25, palmBias: 0.57 },
    { centerX: 35, centerY: 15, radiusX: 4.8, radiusY: 5.2, density: 0.34, palmBias: 0.61 },
];

export const TROPICAL_PALMS = [
    { tileX: 2.8, tileY: 8.6, scale: 1.34, seed: 0.62 },
    { tileX: 4.5, tileY: 4.8, scale: 1.26, seed: 0.23 },
    { tileX: 5.8, tileY: 11.8, scale: 1.30, seed: 0.77 },
    { tileX: 8.6, tileY: 5.7, scale: 1.38, seed: 0.36 },
    { tileX: 10.8, tileY: 10.6, scale: 1.24, seed: 0.92 },
    { tileX: 13.4, tileY: 3.8, scale: 1.32, seed: 0.51 },
    { tileX: 15.2, tileY: 8.9, scale: 1.20, seed: 0.69 },
    { tileX: 11.5, tileY: 22.3, scale: 1.22, seed: 0.18 },
    { tileX: 34.0, tileY: 14.8, scale: 1.18, seed: 0.44 },
    { tileX: 36.3, tileY: 17.8, scale: 1.14, seed: 0.66 },
    { tileX: 12.2, tileY: 30.1, scale: 1.20, seed: 0.78 },
    { tileX: 29.5, tileY: 31.0, scale: 1.18, seed: 0.58 },
    { tileX: 17.0, tileY: 10.0, scale: 1.28, seed: 0.14 },
    { tileX: 20.4, tileY: 11.7, scale: 1.22, seed: 0.88 },
    { tileX: 24.8, tileY: 9.6, scale: 1.18, seed: 0.48 },
];

export const TROPICAL_BROADLEAF_TREES = [
    { tileX: 3.8, tileY: 6.8, scale: 1.18, seed: 0.19 },
    { tileX: 6.4, tileY: 9.9, scale: 1.25, seed: 0.81 },
    { tileX: 9.4, tileY: 4.3, scale: 1.16, seed: 0.43 },
    { tileX: 12.1, tileY: 8.1, scale: 1.22, seed: 0.67 },
    { tileX: 16.0, tileY: 6.3, scale: 1.12, seed: 0.31 },
    { tileX: 18.6, tileY: 10.8, scale: 1.20, seed: 0.74 },
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
    { name: 'lighthouse-beacon-skybreak', centerX: 31.0, centerY: 12.6, radius: 3.8, strength: 0.24 },
    { name: 'north-bank-civic', centerX: 20, centerY: 22, radius: 6.4, strength: 0.23 },
    { name: 'observatory-terrace', centerX: 10, centerY: 19, radius: 4.8, strength: 0.20 },
    { name: 'archive-terrace', centerX: 28, centerY: 18, radius: 5.2, strength: 0.36 },
    { name: 'production-row', centerX: 22, centerY: 29.5, radius: 12.0, strength: 0.21 },
    { name: 'harbor-stage', centerX: 37, centerY: 20.5, radius: 7.5, strength: 0.28 },
    { name: 'portal-mine-bridge', centerX: 14, centerY: 24, radius: 3.5, strength: 0.24 },
    { name: 'command-task-bridge', centerX: 22, centerY: 24, radius: 3.6, strength: 0.25 },
    { name: 'harbor-mouth', centerX: 32, centerY: 21, radius: 4.0, strength: 0.24 },
];

export const TROPICAL_WATERFALLS = [
    { tileX: 9.0, tileY: 5.2, height: 40, width: 42, poolTileX: 7.6, poolTileY: 8.3, scale: 1.18, phase: 2.7 },
    { tileX: 18.0, tileY: 6.1, height: 46, width: 38, poolTileX: 17.4, poolTileY: 10.4, scale: 1.05, phase: 0.1 },
    { tileX: 24.6, tileY: 6.2, height: 30, width: 28, poolTileX: 24.8, poolTileY: 7.8, scale: 0.78, phase: 1.9 },
];

// Density thresholds for noise-driven flat features.
// `BUSH_DENSITY` and `GRASS_TUFT_DENSITY` are noise thresholds in [0, 1] —
// a tile becomes a bush/tuft when its noise value falls in the band.
// Tuned to roughly match the existing 'flowers'/'mushrooms' densities.
export const BUSH_DENSITY = { min: 0.05, max: 0.13 };
export const GRASS_TUFT_DENSITY = { min: 0.18, max: 0.30 };
