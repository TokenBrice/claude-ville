// Authored scenery data for the ClaudeVille world.
// All tile coordinates are 0..MAP_SIZE-1 (40-tile grid).
// Polylines are arrays of [tileX, tileY] control points; rasterization is
// performed by SceneryEngine (Bresenham-thickened or quadratic-eased).

// Water polylines. `width` is the half-width in tiles around the centerline.
// `kind` controls visual depth: 'river' is shallow, 'moat' is deeper.
export const WATER_POLYLINES = [
    // Top-right sea inlet: a broad deep-water body that reads as the river's
    // destination instead of a defensive moat around the map edge.
    {
        kind: 'moat',
        width: 4.5,
        points: [[24, 0], [30, 1], [36, 3], [39, 5]],
    },
    {
        kind: 'moat',
        width: 3.8,
        points: [[39, 4], [38, 9], [38, 14], [36, 18]],
    },
    {
        kind: 'moat',
        width: 2.6,
        points: [[36, 18], [39, 19]],
    },
    // Main river through the village. It enters from the lower-left edge,
    // cuts between the command plaza and workshop district, then empties into
    // the top-right sea. Control points are kept clear of building footprints
    // in BUILDING_DEFS, especially Command Center, Code Forge, Watchtower, and
    // Prompt Alchemy.
    {
        kind: 'river',
        width: 1.35,
        points: [[0, 29], [7, 28], [13, 27], [18, 24], [23, 22], [27, 20], [30, 18], [31, 14], [33, 9], [36, 6], [39, 5]],
    },
];

// Broad authored water masses. These supplement polylines for sea/bay shapes
// where a line stroke would look too rectangular.
export const WATER_BASINS = [
    {
        kind: 'moat',
        centerX: 43.5,
        centerY: 20,
        radiusX: 13.2,
        radiusY: 27,
        edgeNoise: 0.12,
    },
    {
        kind: 'moat',
        centerX: 37.5,
        centerY: 3,
        radiusX: 12,
        radiusY: 8,
        edgeNoise: 0.16,
    },
    {
        kind: 'moat',
        centerX: 35.5,
        centerY: 17.2,
        radiusX: 5.8,
        radiusY: 4.1,
        edgeNoise: 0.22,
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
    { tileX: 31, tileY: 18, orientation: 'EW' },
    { tileX: 32, tileY: 18, orientation: 'EW' },
    { tileX: 33, tileY: 18, orientation: 'EW' },
    { tileX: 34, tileY: 18, orientation: 'EW' },
    { tileX: 35, tileY: 18, orientation: 'EW' },
    { tileX: 36, tileY: 18, orientation: 'EW' },
    { tileX: 37, tileY: 18, orientation: 'EW' },
    { tileX: 38, tileY: 18, orientation: 'EW' },
    { tileX: 34, tileY: 16, orientation: 'NS' },
    { tileX: 35, tileY: 16, orientation: 'NS' },
    { tileX: 36, tileY: 16, orientation: 'NS' },
    { tileX: 34, tileY: 17, orientation: 'NS' },
    { tileX: 35, tileY: 17, orientation: 'NS' },
    { tileX: 36, tileY: 17, orientation: 'NS' },
    { tileX: 34, tileY: 19, orientation: 'NS' },
    { tileX: 35, tileY: 19, orientation: 'NS' },
    { tileX: 36, tileY: 19, orientation: 'NS' },
    { tileX: 34, tileY: 20, orientation: 'NS' },
    { tileX: 35, tileY: 20, orientation: 'NS' },
    { tileX: 36, tileY: 20, orientation: 'NS' },
];

// Tree clusters: anchor tile + radius (tiles) + density (0..1).
// Density is multiplied against per-tile noise; trees only spawn on
// non-water, non-path, non-shore, non-building-footprint tiles.
// SceneryEngine MUST clamp iteration to [0, MAP_SIZE-1] — corner clusters
// (4,4) and (36,36) intentionally extend past map edges to thicken the
// fringe forest.
export const TREE_CLUSTERS = [
    { centerX: 4, centerY: 4, radius: 5.5, density: 0.62 },
    { centerX: 4, centerY: 35, radius: 5, density: 0.58 },
    { centerX: 35, centerY: 4, radius: 5, density: 0.62 },
    { centerX: 36, centerY: 36, radius: 5.5, density: 0.6 },
    // Abundant but path-safe woodland around the settlement.
    { centerX: 10, centerY: 30, radius: 4, density: 0.48 },
    { centerX: 18, centerY: 31, radius: 3.5, density: 0.42 },
    { centerX: 28, centerY: 31, radius: 4, density: 0.46 },
    { centerX: 33, centerY: 20, radius: 3.2, density: 0.38 },
    { centerX: 14, centerY: 9, radius: 3.5, density: 0.4 },
    { centerX: 27, centerY: 7, radius: 3.2, density: 0.36 },
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
];

// Density thresholds for noise-driven flat features.
// `BUSH_DENSITY` and `GRASS_TUFT_DENSITY` are noise thresholds in [0, 1] —
// a tile becomes a bush/tuft when its noise value falls in the band.
// Tuned to roughly match the existing 'flowers'/'mushrooms' densities.
export const BUSH_DENSITY = { min: 0.05, max: 0.16 };
export const GRASS_TUFT_DENSITY = { min: 0.18, max: 0.39 };
