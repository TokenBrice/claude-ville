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
        region: 'lagoon',
        surface: 'current',
        weatherProfile: 'lagoon',
        width: 1.35,
        points: [[2, 7], [6, 8], [10, 8], [14, 9], [17, 10]],
    },
    // Forest spring: a bright tropical cascade feeding the northern lagoon.
    {
        kind: 'river',
        region: 'lagoon',
        surface: 'current',
        weatherProfile: 'lagoon',
        width: 1.05,
        points: [[18, 4], [18, 6], [17, 8], [17, 10]],
    },
    // Top-right sea inlet: a broad deep-water body that reads as open water
    // feeding the harbor instead of a defensive moat around the map edge.
    {
        kind: 'sea',
        region: 'sea',
        surface: 'surf',
        weatherProfile: 'openSea',
        width: 6.1,
        points: [[23, 0], [29, 1], [35, 3], [39, 6]],
    },
    {
        kind: 'sea',
        region: 'sea',
        surface: 'surf',
        weatherProfile: 'openSea',
        width: 6.3,
        points: [[39, 3], [36, 9], [35, 15], [35, 22], [37, 29], [39, 34]],
    },
    {
        kind: 'harbor',
        region: 'harbor',
        surface: 'harbor',
        weatherProfile: 'harbor',
        width: 2.6,
        points: [[31, 22], [34, 22], [37, 22], [39, 23]],
    },
    // Main river through City Center. The local narrows shortens the
    // footbridge span before the river drains into the harbor sea.
    {
        kind: 'river',
        region: 'river',
        surface: 'current',
        weatherProfile: 'river',
        width: 2.15,
        points: [[0, 25], [9, 25], [13, 25]],
    },
    {
        kind: 'river',
        region: 'river',
        surface: 'current',
        weatherProfile: 'river',
        width: 1.4,
        points: [[13, 25], [15, 24.5], [21, 24.5], [23, 25]],
    },
    {
        kind: 'river',
        region: 'river',
        surface: 'current',
        weatherProfile: 'river',
        width: 2.15,
        points: [[23, 25], [30, 24], [35, 23], [39, 22]],
    },
];

// Broad authored water masses. These supplement polylines for sea/bay shapes
// where a line stroke would look too rectangular.
export const WATER_BASINS = [
    {
        kind: 'river',
        region: 'lagoon',
        surface: 'current',
        weatherProfile: 'lagoon',
        centerX: 7.6,
        centerY: 8.3,
        radiusX: 5.1,
        radiusY: 3.4,
        edgeNoise: 0.22,
    },
    {
        kind: 'river',
        region: 'lagoon',
        surface: 'current',
        weatherProfile: 'lagoon',
        centerX: 12.4,
        centerY: 5.2,
        radiusX: 3.6,
        radiusY: 2.4,
        edgeNoise: 0.18,
    },
    {
        kind: 'river',
        region: 'lagoon',
        surface: 'current',
        weatherProfile: 'lagoon',
        centerX: 17.4,
        centerY: 10.5,
        radiusX: 4.8,
        radiusY: 3.2,
        edgeNoise: 0.18,
    },
    {
        kind: 'river',
        region: 'lagoon',
        surface: 'current',
        weatherProfile: 'lagoon',
        centerX: 24.8,
        centerY: 7.6,
        radiusX: 3.6,
        radiusY: 2.4,
        edgeNoise: 0.16,
    },
    {
        kind: 'river',
        region: 'river',
        surface: 'current',
        weatherProfile: 'river',
        centerX: 0.8,
        centerY: 25,
        radiusX: 4.2,
        radiusY: 3.3,
        edgeNoise: 0.06,
    },
    {
        kind: 'sea',
        region: 'sea',
        surface: 'surf',
        weatherProfile: 'openSea',
        centerX: 43,
        centerY: 19,
        radiusX: 13.6,
        radiusY: 25,
        edgeNoise: 0.11,
    },
    {
        kind: 'sea',
        region: 'sea',
        surface: 'surf',
        weatherProfile: 'openSea',
        centerX: 38,
        centerY: 3.5,
        radiusX: 13.5,
        radiusY: 9.5,
        edgeNoise: 0.14,
    },
    {
        kind: 'harbor',
        region: 'harbor',
        surface: 'harbor',
        weatherProfile: 'harbor',
        centerX: 37.3,
        centerY: 21.7,
        radiusX: 6.8,
        radiusY: 7.4,
        edgeNoise: 0.16,
    },
    {
        kind: 'harbor',
        region: 'harbor',
        surface: 'harbor',
        weatherProfile: 'harbor',
        centerX: 39.2,
        centerY: 16.2,
        radiusX: 4.8,
        radiusY: 6.4,
        edgeNoise: 0.12,
    },
    {
        kind: 'river',
        region: 'lagoon',
        surface: 'current',
        weatherProfile: 'lagoon',
        centerX: 17,
        centerY: 22,
        radiusX: 1.2,
        radiusY: 1.2,
        edgeNoise: 0.14,
    },
];

// Bridge hints: explicit tile positions where a deck must exist.
// SceneryEngine may auto-place extra crossings when no hints are present, but
// these authored hints intentionally define the visible river crossings.
// `orientation` is optional; when omitted the engine derives it from neighbor
// water tiles.
export const BRIDGE_HINTS = [
    // The deck is 3 tiles wide (17..19) x 3 long (23..25); only the center
    // column is walkable. deckRise is the visual arch height in px used for
    // the agent lift. nearRail is the span-space band (px) containing the
    // sprite's camera-near handrail used for occlusion.
    {
        id: 'central-river-bridge',
        tileX: 18,
        tileY: 24,
        orientation: 'NS',
        style: 'civic',
        widthRadius: 1,
        walkableRadius: 0,
        deckRise: 10,
        nearRail: { inner: 30, outer: 76, top: 44, bottom: 10 },
    },
];

// Plank crossings: single-file walkable spans drawn per-tile from the
// bridge.ew/ns plank assets (kind 'plank' — no landmark span treatment).
// The west crossing meets the north-bank-promenade's river anchor (7, 23) so
// the archive/promenade side links to the portal-grove and mine approach
// without walking to the central landmark bridge. Walkability only ever
// *adds* connectivity here, so routing risk is limited to new scenery.
export const PLANK_BRIDGES = [
    {
        id: 'west-river-plank',
        tileX: 7,
        tileY: 25,
        orientation: 'NS',
    },
    {
        id: 'command-pond-plank',
        tileX: 17,
        tileY: 22,
        orientation: 'EW',
    },
];

// Small authored Harbor Master causeway. This is intentionally separate from
// the two landmark river bridges so agents can reach the harbor without
// creating extra town-wide crossings.
export const HARBOR_DOCK_TILES = [
    { tileX: 28, tileY: 19, orientation: 'EW', style: 'causeway' },
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
    { name: 'clock-greenwood', centerX: 27.8, centerY: 8.2, radiusX: 9.8, radiusY: 6.6, base: '#2e5835', accent: '#6c9648', strength: 0.80 },
    { name: 'archive-grove', centerX: 8.2, centerY: 14.8, radiusX: 6.2, radiusY: 4.8, base: '#315f32', accent: '#729948', strength: 0.68 },
    { name: 'lighthouse-windbreak', centerX: 30.2, centerY: 10.8, radiusX: 5.8, radiusY: 6.2, base: '#315a36', accent: '#73924c', strength: 0.58 },
    { name: 'central-isle', centerX: 17, centerY: 22, radiusX: 7, radiusY: 6, base: '#2c5a32', accent: '#54753f', strength: 0.55 },
    // The south wildwood's tall stand between the Portal and Mine yards and
    // the sea wall (stops short of both yards and the gate avenue).
    { name: 'south-wildwood', centerX: 7, centerY: 38.6, radiusX: 9, radiusY: 3.2, base: '#2d5a2b', accent: '#5c8b3f', strength: 0.85 },
];

// Tree clusters: procedural woodland regions around the settlement. Each
// region seeds clumps rather than single trees (SceneryEngine.generateTrees):
// `density` (0..1) is the chance a candidate tile becomes a clump centre,
// `clump` is the [min, max] tree count per clump (at least 3 must stand or the
// clump is dropped), `spacing` the minimum tiles between clump centres, and
// `species` the dominant-species weights. Willow is never listed: any tree
// within one tile of fresh water may turn willow, and a willow never stands
// away from water. Poplar is never listed either: it has only a tall sheet,
// so it grows only in TREE_AVENUES rows, where the tall-tree rules are
// checked. SceneryEngine clamps iteration to [0, MAP_SIZE-1], so
// regions may overhang the map edge.
//
// Species by region (W8.3d, AD-P8): birch on the north ridge and the west
// cliff (pale trunks, straw-gold in autumn), maple in the inhabited belt and
// the south woods (scarlet in autumn), so the October woods turn in three
// hue families instead of one russet mass.
//
// `tall` (plan 5.5) is the share of the region's large trees that grow into
// the tall woodland sheets (oak/pine/willow/birch/maple `.tall`, 1.4–2.2× a villager), so
// the outer woods read as forest while the 51-px trees keep the district
// scale. A tree only grows tall where TALL_TREE_RULES allow it. `stand`
// (species in planting order) makes the region a tall stand instead: every
// tree it grew and every clear point inside its ellipse grows tall where the
// rules allow, broad crowns first (SceneryEngine `_growTallStand`), for belts
// too narrow for clumps to land on the few clear sites.
export const TREE_CLUSTERS = [
    // North-west elderwood above the lagoon: the densest mass on the island.
    { name: 'elderwood', centerX: 8, centerY: 2.2, radiusX: 10.5, radiusY: 4.4, density: 0.9, clump: [5, 7], spacing: 2.9, species: { oak: 0.3, birch: 0.35, pine: 0.35 }, tall: 0.75 },
    { name: 'west-cliff', centerX: 1.2, centerY: 9, radiusX: 2.4, radiusY: 4.2, density: 0.7, clump: [3, 5], spacing: 2.6, species: { pine: 0.5, birch: 0.3, oak: 0.2 }, tall: 0.5 },
    // South wildwood along the island's lower rim, clear of the gate avenue:
    // a belt between the Portal and Mine yards and the sea wall, grown as a
    // tall stand so it reads as forest, not a hedge.
    { name: 'south-wildwood', centerX: 9.5, centerY: 38, radiusX: 11, radiusY: 3.4, density: 0.8, clump: [4, 7], spacing: 2.9, species: { oak: 0.4, maple: 0.25, pine: 0.35 }, stand: ['oak', 'maple', 'pine'] },
    { name: 'south-rim', centerX: 27, centerY: 38.4, radiusX: 4.6, radiusY: 1.8, density: 0.55, clump: [3, 5], spacing: 3.0, species: { oak: 0.35, maple: 0.25, pine: 0.4 }, tall: 0.45 },
    // Sea-facing pine windbreak on the south-east coast.
    { name: 'coast-windbreak', centerX: 32, centerY: 35, radiusX: 3.4, radiusY: 4.8, density: 0.6, clump: [3, 6], spacing: 2.8, species: { pine: 0.75, oak: 0.25 }, tall: 0.45 },
];

// Where a woodland tree may grow tall (plan 5.5): never within `pathClearance`
// tiles of a path, lane, yard or bridge tile; never within `districtClearance`
// tiles of a landmark's scenery zone (51-px trees keep the district scale);
// two tall oaks at least `spacing` tiles apart (narrower crowns closer, in
// proportion to their width); and never where its crown would hide a
// villager: a body (`villager` = [width, height] world px above the feet)
// standing on any walkable tile behind the trunk may have at most
// `hiddenShare` of its box inside the crown box (FoliageRenderer
// `TREE_SPRITES[…].crown`).
export const TALL_TREE_RULES = Object.freeze({
    pathClearance: 1.5,
    districtClearance: 2.5,
    spacing: 1.3,
    villager: Object.freeze([20, 56]),
    hiddenShare: 0.25,
});

// Authored clumps that compose the settlement: they frame districts and water
// edges and leave the ground around every landmark open. `trees` is the clump
// size (3–7); `species` the dominant species (willow only stands within one
// tile of water; elsewhere it falls back to oak); `mix` optional secondary
// weights.
export const TREE_CLUMPS = [
    // Lagoon islet: waterside willows.
    { tileX: 15.5, tileY: 5.6, trees: 4, species: 'willow' },
    // West terrace between the lagoon and the Archive (clear of the Archive's
    // sightline): the ridge's birches running down toward the scholars.
    { tileX: 2.6, tileY: 11.4, trees: 5, species: 'birch', mix: { birch: 0.4, oak: 0.35, pine: 0.25 } },
    { tileX: 10.8, tileY: 12.2, trees: 3, species: 'maple', mix: { oak: 1 } },
    // River frame: willows on the Archive bank and the east river isle.
    { tileX: 3.2, tileY: 21.5, trees: 4, species: 'willow', mix: { oak: 1 } },
    { tileX: 22.6, tileY: 22.0, trees: 3, species: 'willow' },
    // South meadow copse between the river and the Mine, and the maple clump
    // that frames the gate avenue's approach to the Forge (the inhabited
    // belt's scarlet in October).
    { tileX: 9.2, tileY: 27.8, trees: 4, species: 'maple', mix: { oak: 1 } },
    { tileX: 22.6, tileY: 28.3, trees: 3, species: 'maple' },
    // Pines screening the Task board's sea side.
    { tileX: 30.4, tileY: 31.6, trees: 4, species: 'pine', mix: { oak: 1 } },
];

// W8.3d (AD-P8) — avenue rows: Lombardy poplars, the island's one vertical
// rhythm, in a file beside a walk. `points` are authored trunk tiles on the
// walk's far verge (screen-up of the walk, so the walk is always drawn in
// front of the crowns); SceneryEngine `_plantTreeAvenues` keeps a point only
// where a new tree may grow and the tall-tree body test passes (no crown
// hides a villager on any walk tile), with the row's own `verge` (tiles from
// a walk tile) in place of the woodland path clearance. One canopy `variant`
// per row so the file turns as one (0 gold, 2 a stop lighter in autumn).
// The civic core's walks and yards leave no verge whose crown column is clear
// (a poplar hides any walk tile up its screen column), so both rows stand on
// the river banks where the two approaches cross the water.
export const TREE_AVENUES = [
    // The Archive walk's foot: a file along the north bank, west of the
    // scholars' crossing.
    { name: 'archive-walk', species: 'poplar', variant: 0, verge: 0.3, points: [[4.45, 22.45], [5.5, 22.45], [6.55, 22.4]] },
    // The Command approach from the gate: a file on the south bank behind the
    // walk's bend to the bridge, one screen row of columns over the river.
    { name: 'command-approach', species: 'poplar', variant: 2, verge: 0.3, points: [[17.6, 27.4], [16.7, 28.0], [15.95, 28.7]] },
];

// The world ash (user item 5): one colossal evergreen (FoliageRenderer
// `ash.world`, 240×271 px) planted on the northern lagoon islet between the
// Observatory and the Lighthouse. `tileX`/`tileY` is the sheet's anchor, its
// front root tip; the trunk meets the ground about 30 px up the sheet.
// `islet` is the islet's land, an authored oval in world px (centre, radii,
// `edgeNoise` the share its radius wanders round the rim) sized so every root
// stands on sand or grass with a sand rim past the outermost tips.
// `inWorldTreeIslet` is the one test: SceneryEngine takes the tiles whose
// centre it covers back from the lagoon and sea basins (and blocks them for
// walking and generated scenery), and CoastBake seeds its sub-tile coast
// field from the oval itself, so the shore, sand ring and foam follow a
// rounded, gently irregular rim like every basin coast, never whole tiles.
// SceneryEngine adds the tree after the generated trees, outside every clump
// and woodland rule.
export const WORLD_TREE = Object.freeze({
    tileX: 21.16,
    tileY: 7.69,
    islet: Object.freeze({ centerX: 428, centerY: 431, radiusX: 105, radiusY: 63, edgeNoise: 0.05 }),
});

// True when world point (x, y) lies on the world ash's islet: inside its oval,
// whose radius wanders by `edgeNoise` on a smooth five-lobed angular wave.
export const inWorldTreeIslet = (x, y) => {
    const { centerX, centerY, radiusX, radiusY, edgeNoise } = WORLD_TREE.islet;
    const dx = (x - centerX) / radiusX;
    const dy = (y - centerY) / radiusY;
    const angle = Math.atan2(dy, dx);
    const wave = 0.6 * Math.sin(angle * 3 + 0.9) + 0.4 * Math.sin(angle * 5 + 2.3);
    return Math.hypot(dx, dy) <= 1 + edgeNoise * wave;
};

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
    { tileX: 29.2, tileY: 33.6, scale: 1.05, variant: 'b' },
    { tileX: 32.8, tileY: 6.5, scale: 0.9, variant: 'a' },
    { tileX: 22.0, tileY: 14.0, scale: 1.05, variant: 'b' },
    { tileX: 23.2, tileY: 13.2, scale: 0.95, variant: 'b' },
    { tileX: 14.6, tileY: 22.4, scale: 0.9, variant: 'b' },
    { tileX: 21.5, tileY: 26.4, scale: 0.85, variant: 'b' },
];

// District biases make the authored map read in larger masses instead of
// uniformly sprinkling props. Radius is radial falloff in tiles; the engine
// clamps blocked/path/water/building tiles after applying these weights.
export const VEGETATION_DISTRICTS = [
    { name: 'northern-elderwood', centerX: 17, centerY: 8, radius: 15.0, bushBoost: 0.044, grassBoost: 0.060, treeBoost: 0.120, flowerBoost: 0.050 },
    { name: 'scholars-ridge', centerX: 17, centerY: 18, radius: 10.0, bushBoost: 0.022, grassBoost: 0.048, treeBoost: 0.040, flowerBoost: 0.110 },
    { name: 'west-river-frame', centerX: 7, centerY: 22, radius: 7.0, bushBoost: 0.04, grassBoost: 0.045, treeBoost: 0.065, flowerBoost: 0.085 },
    { name: 'portal-grove', centerX: 7.5, centerY: 28.5, radius: 5.0, bushBoost: 0.032, grassBoost: 0.023, treeBoost: 0.018, flowerBoost: 0.045 },
    { name: 'south-wildwood', centerX: 22, centerY: 35, radius: 12, bushBoost: 0.04, grassBoost: 0.05, treeBoost: 0.08, flowerBoost: 0.080 },
    { name: 'harbor-windbreak', centerX: 35, centerY: 22, radius: 5.2, bushBoost: 0.020, grassBoost: 0.014, treeBoost: 0.008, flowerBoost: 0.040 },
    // Keep the inhabited belt quiet so agents, paths and thresholds remain legible.
    { name: 'civic-meadow', centerX: 17, centerY: 22, radius: 9.0, bushBoost: -0.035, grassBoost: -0.035, treeBoost: 0.0, flowerBoost: -0.025 },
];

// Shoreline accents are deterministic bands near water. They add readable
// riverbanks without turning the whole shore into dense trees.
export const SHORELINE_VEGETATION = {
    bushBoost: 0.04,
    grassBoost: 0.09,
    treeBoost: 0.015,
    flowerBoost: 0.060,
    maxWaterDistance: 1,
};

// Negative-space pockets keep key silhouettes and crossings readable after
// district density boosts. Strength is subtracted from generated scenery
// density with radial falloff.
export const SCENERY_CLEARINGS = [
    { name: 'elderwood-glade', centerX: 16.8, centerY: 10.5, radius: 3.6, strength: 0.18 },
    { name: 'clock-skybreak', centerX: 27.2, centerY: 14.0, radius: 5.8, strength: 0.95 },
    { name: 'archive-approach', centerX: 9.0, centerY: 17.0, radius: 4.2, strength: 0.36 },
    { name: 'command-skyline', centerX: 20.4, centerY: 16.0, radius: 2.8, strength: 0.15 },
    { name: 'lighthouse-beacon-skybreak', centerX: 31.0, centerY: 12.6, radius: 3.8, strength: 0.24 },
    { name: 'archive-terrace', centerX: 8, centerY: 19, radius: 4.8, strength: 0.26 },
    { name: 'clock-terrace', centerX: 27, centerY: 18, radius: 5.2, strength: 0.32 },
    { name: 'production-row', centerX: 22, centerY: 29.5, radius: 12.0, strength: 0.21 },
    { name: 'harbor-stage', centerX: 37, centerY: 20.5, radius: 7.5, strength: 0.28 },
    { name: 'central-river-bridge', centerX: 18, centerY: 23, radius: 5.4, strength: 0.30 },
    { name: 'harbor-mouth', centerX: 32, centerY: 21, radius: 4.0, strength: 0.24 },
    { name: 'isle-promenade-bend', centerX: 14, centerY: 21, radius: 1.6, strength: 0.5 },
    { name: 'isle-bridge-bend', centerX: 19.5, centerY: 22.0, radius: 1.6, strength: 0.5 },
];

export const ANCIENT_RUINS = [
    { tileX: 37, tileY: 3, scale: 1.05 },
    { tileX: 2, tileY: 16, scale: 0.82 },
    { tileX: 36, tileY: 34, scale: 0.95 },
];

export const DISTRICT_PROPS = [
    { tileX: 11.9, tileY: 21.0, id: 'prop.runeBrazier', layer: 'cache', district: 'command' },
    { tileX: 2.2, tileY: 14.4, id: 'veg.root.arch', layer: 'sorted', district: 'elderwood' },
    { tileX: 6.2, tileY: 26.5, id: 'veg.standingStone.mossy', layer: 'cache', district: 'elderwood' },
    { tileX: 6.9, tileY: 27.3, id: 'prop.lakeShrine', layer: 'cache', district: 'elderwood' },
    { tileX: 32.3, tileY: 19.6, id: 'prop.netRack', layer: 'cache', district: 'harbor' },
    { tileX: 33.2, tileY: 22.2, id: 'prop.harborBeaconBuoy', layer: 'cache', district: 'harbor' },
    { tileX: 37.1, tileY: 22.0, id: 'prop.harborBeaconBuoy', layer: 'cache', district: 'harbor' },
    { tileX: 6.0, tileY: 8.0, id: 'prop.netRack', layer: 'cache', district: 'lagoon' },
    { tileX: 14.0, tileY: 5.5, id: 'prop.harborBeaconBuoy', layer: 'cache', district: 'lagoon' },
    { tileX: 20.0, tileY: 11.0, id: 'prop.harborBeaconBuoy', layer: 'cache', district: 'lagoon' },
    // Lagoon lilypad drifts: tight 2-3 pad clusters on calm interior water
    // instead of isolated singles.
    { tileX: 13.4, tileY: 7.6, id: 'veg.lilypad', layer: 'cache', district: 'lagoon' },
    { tileX: 12.6, tileY: 8.2, id: 'veg.lilypad', layer: 'cache', district: 'lagoon' },
    { tileX: 13.2, tileY: 8.7, id: 'veg.lilypad', layer: 'cache', district: 'lagoon' },
    { tileX: 15.2, tileY: 8.4, id: 'veg.lilypad', layer: 'cache', district: 'lagoon' },
    { tileX: 14.0, tileY: 9.2, id: 'veg.lilypad', layer: 'cache', district: 'lagoon' },
    { tileX: 15.6, tileY: 9.3, id: 'veg.lilypad', layer: 'cache', district: 'lagoon' },
    // Lily pair on the east lagoon basin.
    { tileX: 24.2, tileY: 7.4, id: 'veg.lilypad', layer: 'cache', district: 'lagoon' },
    { tileX: 25.0, tileY: 7.9, id: 'veg.lilypad', layer: 'cache', district: 'lagoon' },
    // Mangrove roots: west shore shallow water.
    { tileX: 6.6, tileY: 7.8, id: 'prop.mangroveRoot.twisted', layer: 'sorted', district: 'lagoon' },
    { tileX: 7.4, tileY: 9.6, id: 'prop.mangroveRoot.twisted', layer: 'sorted', district: 'lagoon' },
    { tileX: 6.2, tileY: 8.8, id: 'prop.mangroveRoot.arch', layer: 'sorted', district: 'lagoon' },
    // Driftwood logs: west shore shallows.
    { tileX: 7.2, tileY: 10.4, id: 'prop.driftwood.log', layer: 'cache', district: 'lagoon' },
    { tileX: 8.6, tileY: 9.4, id: 'prop.driftwood.log', layer: 'cache', district: 'lagoon' },
    // Central island lily pool composition. The pond's open water (coast
    // field) spans tileX ~15.9-17.1 north of the command-pond plank row, so
    // pads and the buoy keep to tileX 16.1-17.0, tileY <= 21.05: in the
    // water, never over the plaza, the planks or the bridge landing. Roots,
    // the standing stone and the driftwood ring the dry west and south banks,
    // clear of the avenue and bridge. The plaza in front of Command carries no
    // fixture: it is where the briefing, the queue and the overflow crowd.
    { tileX: 15.3, tileY: 22.5, id: 'veg.standingStone.mossy', layer: 'sorted', district: 'civic' },
    { tileX: 16.15, tileY: 20.95, id: 'veg.lilypad', layer: 'cache', district: 'civic' },
    { tileX: 16.6, tileY: 20.8, id: 'veg.lilypad', layer: 'cache', district: 'civic' },
    { tileX: 16.55, tileY: 21.05, id: 'veg.lilypad', layer: 'cache', district: 'civic' },
    { tileX: 17.0, tileY: 21.0, id: 'prop.harborBeaconBuoy', layer: 'cache', district: 'civic' },
    { tileX: 15.2, tileY: 22.1, id: 'prop.mangroveRoot.twisted', layer: 'sorted', district: 'civic' },
    { tileX: 14.6, tileY: 22.8, id: 'prop.mangroveRoot.arch', layer: 'sorted', district: 'civic' },
    { tileX: 20.4, tileY: 22.7, id: 'prop.mangroveRoot.twisted', layer: 'sorted', district: 'civic' },
    { tileX: 15.8, tileY: 22.8, id: 'prop.driftwood.log', layer: 'cache', district: 'civic' },
    { tileX: 20.6, tileY: 22.2, id: 'prop.signpost', layer: 'sorted', district: 'civic' },
    // Footbridge abutments. The north-west corner stands in the lily pond, so
    // only the dry south-east corner carries a lantern post; the sprite's own
    // post lanterns light the other three.
    { tileX: 19.4, tileY: 26.6, id: 'prop.bridgeLanternPost', layer: 'sorted', district: 'civic' },
    { tileX: 16.4, tileY: 26.9, id: 'veg.standingStone.mossy', layer: 'sorted', district: 'civic' },
    { tileX: 19.6, tileY: 22.3, id: 'veg.boulder.mossy.small', layer: 'sorted', district: 'civic' },
    { tileX: 16.3, tileY: 22.6, id: 'veg.flower.a', layer: 'cache', district: 'civic' },
    { tileX: 19.8, tileY: 22.5, id: 'veg.flower.b', layer: 'cache', district: 'civic' },
    { tileX: 16.4, tileY: 26.6, id: 'veg.flower.c', layer: 'cache', district: 'civic' },
    { tileX: 19.7, tileY: 26.7, id: 'veg.flowerBed', layer: 'cache', district: 'civic' },
    { tileX: 19.7, tileY: 26.1, id: 'prop.bridgeBannerRune', layer: 'sorted', district: 'civic' },
    // Workshop district: Forge → Task Board handoff yard (brazier, bed, hedge
    // and the handoff crates at the scenic point below).
    { tileX: 26.2, tileY: 31.5, id: 'prop.runeBrazier', layer: 'cache', district: 'workshop' },
    // Living Isle W8.3a (AD-P5): working yards. Each prop stands on one
    // whole tile so `walkBlock` closes exactly its own lattice node, never a
    // lane, visit slot, seat or queue place; listed back to front per yard
    // because the cache bake draws in list order. No hull anywhere (git
    // channel). The door queues (townPlan APPROACH_FILES, the outer rings)
    // claim the ground between the Observatory and the harbour office, so
    // the harbour quay spreads to its shores: a fishing nook on the lagoon
    // shore north of the Observatory (fish rack and drying crab pots), an
    // anchor beached on the lawn below the Pharos, the salt store against
    // the harbour office's west wall by its door, the bollard pair where
    // the causeway meets land.
    { tileX: 21, tileY: 12, id: 'prop.fishRack', layer: 'cache', district: 'harbor', walkBlock: true },
    { tileX: 22, tileY: 12, id: 'prop.crabPots', layer: 'cache', district: 'harbor', walkBlock: true },
    { tileX: 26, tileY: 10, id: 'prop.anchorChain', layer: 'cache', district: 'harbor', walkBlock: true },
    { tileX: 29, tileY: 19, id: 'prop.saltCrates', layer: 'cache', district: 'harbor', walkBlock: true },
    { tileX: 29, tileY: 20, id: 'prop.bollardPair', layer: 'cache', district: 'harbor', walkBlock: true },
    // Forge smithy yard: the roofed log store on the shore behind the
    // hearth, the bellows bench on the shore past the hearth's east corner
    // (the door file and its ring hold the yard west of the door), barrels
    // at the Forge → Task Board handoff.
    { tileX: 25, tileY: 26, id: 'prop.firewoodStack', layer: 'cache', district: 'workshop', walkBlock: true },
    { tileX: 31, tileY: 32, id: 'prop.bellowsBench', layer: 'cache', district: 'workshop', walkBlock: true },
    { tileX: 27, tileY: 33, id: 'prop.barrelStack', layer: 'cache', district: 'workshop', walkBlock: true },
    // Token Mine: a tool corner west of the rock (roofed tool rack and
    // grindstone), beside the Portal's door file; ore sacks, the parked
    // barrow and the spoil heap at the rock's north-east foot by the mine
    // road. The rock hides anything closer to its west face.
    { tileX: 8, tileY: 31, id: 'prop.toolRack', layer: 'cache', district: 'resource', walkBlock: true },
    { tileX: 8, tileY: 32, id: 'prop.grindstone', layer: 'cache', district: 'resource', walkBlock: true },
    { tileX: 15, tileY: 29, id: 'prop.oreSacks', layer: 'cache', district: 'resource', walkBlock: true },
    { tileX: 16, tileY: 29, id: 'prop.wheelbarrow', layer: 'cache', district: 'resource', walkBlock: true },
    { tileX: 16, tileY: 30, id: 'prop.slagHeap', layer: 'cache', district: 'resource', walkBlock: true },
    // South-bank green between the Token Mine's rock and the central bridge:
    // the village well on the river bank, the flower cart parked at its side
    // and the south-lawn bench beyond. No lane, visit slot or queue place
    // reaches the green (the lanes pass the bridge foot and the mine road), and
    // `walkBlock` takes the lattice nodes round each foot out of the walk grid
    // (SceneryEngine), so no body stands on or crosses the baked sprites.
    { tileX: 12.5, tileY: 27.5, id: 'prop.well', layer: 'cache', district: 'civic', walkBlock: true },
    { tileX: 13.7, tileY: 28.5, id: 'prop.flowerCart', layer: 'cache', district: 'civic', walkBlock: true },
    // Archive west lawn: the rune fountain between its two braziers, a
    // reading-garden shrine on the open grass between the Archive's bell
    // tower and the shore. No lane, path, visit slot, queue place, seat or
    // loiter point reaches the lawn (the archive walk and the bank benches
    // stop at x >= 4), and `walkBlock` keeps every body off the baked group.
    { tileX: 1.15, tileY: 19.0, id: 'prop.runeFountain', layer: 'cache', district: 'knowledge', walkBlock: true },
    { tileX: 1.9, tileY: 18.25, id: 'prop.runeBrazier', layer: 'cache', district: 'knowledge', walkBlock: true },
    { tileX: 0.4, tileY: 19.75, id: 'prop.runeBrazier', layer: 'cache', district: 'knowledge', walkBlock: true },
    // Gate-avenue spine between river bridge and village gate.
    { tileX: 17.5, tileY: 30.0, id: `prop.${marketStallType(17.5, 30.0)}`, layer: 'sorted', district: 'gate' },
    { tileX: 20.0, tileY: 27.5, id: 'prop.noticePillar', layer: 'sorted', district: 'gate' },
    // Mine ↔ Portal corridor along west-production-road: one lit waymark.
    { tileX: 10.0, tileY: 32.0, id: 'prop.lantern', layer: 'sorted', district: 'arcane' },
    // W8.4b (AW-P15) — the north road: a parked handcart of firewood on the
    // watchtower green's verge beside the dirt road up to the lighthouse.
    // Cache-baked: every verge tile of the observatory promenade lies in the
    // Observatory or Watchtower tall-scenery zone (padded footprint or
    // sightline), so a `sorted` cart there was culled and never drew. The
    // whole-tile row keeps its walkBlock to two lattice nodes, neither a path
    // nor an approach-file place. Static everyday dressing, never an actor.
    { tileX: 27.5, tileY: 12.0, id: 'prop.handcart', layer: 'cache', district: 'knowledge', walkBlock: true },
    // Birdsong & Bloom (v0.16): cultivated garden plants in the lived-in
    // districts. layer 'sorted' so any that land on a footprint/path/sightline
    // are auto-culled by _buildDistrictPropSprites rather than drawn wrongly.
    { tileX: 17.0, tileY: 28.8, id: 'veg.flowerBed', layer: 'sorted', district: 'gate' },
    { tileX: 20.6, tileY: 28.2, id: 'veg.planter', layer: 'sorted', district: 'gate' },
    { tileX: 18.8, tileY: 33.2, id: 'veg.hedge', layer: 'sorted', district: 'gate' },
    { tileX: 8.4, tileY: 23.6, id: 'veg.flowerBed', layer: 'sorted', district: 'civic' },
    { tileX: 7.2, tileY: 21.4, id: 'veg.planter', layer: 'sorted', district: 'civic' },
    { tileX: 19.4, tileY: 19.8, id: 'veg.planter', layer: 'sorted', district: 'civic' },
    { tileX: 26.4, tileY: 31.2, id: 'veg.flowerBed', layer: 'sorted', district: 'workshop' },
    { tileX: 28.8, tileY: 30.2, id: 'veg.hedge', layer: 'sorted', district: 'workshop' },
    // Living Isle W8.5b (AD-P10): four non-semantic landmarks, no occupancy,
    // label or gate; `landmark` props are built by IsleLandmarks.js (the
    // windmill's sails step on wind gusts, the chapel lantern on the lamps
    // clock), sorted with the trees, and `walkBlock` keeps every body off
    // them. Each stands on open grass no lane, visit slot, queue, seat,
    // scenic point or building sightline zone reaches: the windmill on the
    // north shore's open crest, the watermill on the river's north bank east
    // of the central bridge (its wheel rim dipping over the river's edge), the chapel
    // on the Archive's north lawn (west of the farm pocket), the ruined
    // tower at the north wood's edge on the lake's north-west beach. The
    // headland between the Observatory and the Lighthouse stays bare: it is
    // both buildings' tall-scenery sightline zone.
    { tileX: 9.6, tileY: 0.9, id: 'prop.windmill', layer: 'sorted', district: 'north', walkBlock: true, landmark: true },
    { tileX: 22.9, tileY: 22.2, id: 'prop.watermill', layer: 'sorted', district: 'civic', walkBlock: true, landmark: true },
    { tileX: 1.6, tileY: 9.0, id: 'prop.waysideChapel', layer: 'sorted', district: 'knowledge', walkBlock: true, landmark: true },
    { tileX: 4.5, tileY: 3.6, id: 'prop.ruinedTower', layer: 'sorted', district: 'north', walkBlock: true, landmark: true },
    // Living Isle W8.3c (AD-P5 group D): civic/garden and wetland/forest
    // dressing, all baked into the terrain (`cache`). Garden furniture stands
    // on lawns no lane, visit slot, queue place or scenic point reaches;
    // standing places keep off it through VisitTileAllocator FIXTURE_PARTS,
    // and `walkBlock` takes the solid pieces out of the walk grid. The
    // Archive's south-west lawn takes a two-clump hedgerow on the lake shore,
    // clear of its door file, the west lawn a rose arbor with a cold torch
    // post beside the fountain (the tower hides its east side), its lake lawn
    // a laundry line between the reeds; the Observatory's north lawn a
    // waymark cairn; the well green a trough.
    { tileX: 0.9, tileY: 16.9, id: 'prop.trellisArch', layer: 'cache', district: 'knowledge', walkBlock: true },
    { tileX: 0.3, tileY: 17.5, id: 'prop.torchSconce', layer: 'cache', district: 'knowledge', walkBlock: true },
    { tileX: 0.4, tileY: 21.0, id: 'veg.hedgerow', layer: 'cache', district: 'knowledge' },
    { tileX: 1.5, tileY: 21.0, id: 'veg.hedgerow', layer: 'cache', district: 'knowledge' },
    { tileX: 6.85, tileY: 12.0, id: 'prop.laundryLine', layer: 'cache', district: 'knowledge', walkBlock: true },
    { tileX: 23, tileY: 12, id: 'prop.cairn', layer: 'cache', district: 'knowledge', walkBlock: true },
    { tileX: 11.3, tileY: 27.8, id: 'prop.wellTrough', layer: 'cache', district: 'civic', walkBlock: true },
    // Reeds and cattails on dry bank tiles of the lagoon's south shore and
    // the west river's south bank: never on water, a heron shallow or a duck
    // bank (CALM_WATER_FAUNA, HERON_SHALLOWS), never at a bridge foot.
    { tileX: 5.4, tileY: 11.5, id: 'veg.reedClump', layer: 'cache', district: 'lagoon' },
    { tileX: 9.2, tileY: 11.4, id: 'veg.cattailClump', layer: 'cache', district: 'lagoon' },
    { tileX: 12.3, tileY: 12.6, id: 'veg.reedClump', layer: 'cache', district: 'lagoon' },
    { tileX: 15.6, tileY: 13.6, id: 'veg.cattailClump', layer: 'cache', district: 'lagoon' },
    { tileX: 4.3, tileY: 27.3, id: 'veg.reedClump', layer: 'cache', district: 'civic' },
    { tileX: 3.4, tileY: 27.6, id: 'veg.cattailClump', layer: 'cache', district: 'civic' },
    { tileX: 14.5, tileY: 27.1, id: 'veg.cattailClump', layer: 'cache', district: 'civic' },
    // Fern and bramble where the woods meet the lagoon's west and north
    // shores (the world ash's islet and crown cover its north-east bank).
    { tileX: 0.5, tileY: 5.8, id: 'veg.fernCluster', layer: 'cache', district: 'elderwood' },
    { tileX: 1.4, tileY: 11.6, id: 'veg.bramblePatch', layer: 'cache', district: 'elderwood' },
    { tileX: 7.5, tileY: 4.4, id: 'veg.fernCluster', layer: 'cache', district: 'elderwood' },
    { tileX: 1.3, tileY: 3.4, id: 'veg.bramblePatch', layer: 'cache', district: 'elderwood' },
    // W8.3b (AD-P5) — the gate avenue market: the bread stall on the
    // avenue's west verge below the existing stall, between the gate-green
    // bench and the gatehouse (the east verge sits under the Task Board's
    // sprite, the verge at the gate under its tower). Clear of the Task
    // Board's approach file, the queue, the rest seats and the calendar
    // anchors. Cache-baked like the south-bank well (`sorted` props on the
    // avenue strip are culled by the landmark sightline rule); `walkBlock`
    // keeps every body off the baked feet.
    { tileX: 17.3, tileY: 32.9, id: 'prop.marketStall.bread', layer: 'cache', district: 'gate', walkBlock: true },
    // The W8.3b milestone stands on the avenue's west verge between the two
    // stalls: a whole tile the sightline rule leaves open, so it sorts like
    // the avenue stall, and its fixture box clears the Task Board's approach
    // file. (The fish and cloth stalls and the notice board were withdrawn:
    // every visible verge left is a queue-overflow or visit place, a path
    // node, or ground under the Mine, Task Board or gatehouse sprites.)
    { tileX: 17.85, tileY: 31.65, id: 'prop.milestone', layer: 'sorted', district: 'gate' },
    // W8.3b (AD-P5) — the farm pocket on the lagoon lawn between the Archive
    // gable and the seat park, around the laundry line and the repo stone:
    // dovecote, scarecrow and two crop beds fenced on their back (bank and
    // gable) edges, skeps against the Archive wall, and a small paddock east
    // of the line (gate, back rail along the bank, trough) with the hay cart
    // at its foot. Fences only run along back edges, so anything inside draws
    // in front of them. Cache-baked in back-to-front order (tileX + tileY):
    // the bake draws them in list order.
    { tileX: 4.0, tileY: 11.6, id: 'prop.farm.dovecote', layer: 'cache', district: 'farm', walkBlock: true },
    { tileX: 5.0, tileY: 11.95, id: 'prop.fence.nwSe', layer: 'cache', district: 'farm', walkBlock: true },
    { tileX: 4.6, tileY: 12.4, id: 'prop.farm.scarecrow', layer: 'cache', district: 'farm', walkBlock: true },
    { tileX: 4.1, tileY: 13.1, id: 'prop.fence.neSw', layer: 'cache', district: 'farm', walkBlock: true },
    { tileX: 5.4, tileY: 12.7, id: 'prop.farm.cropRows.long', layer: 'cache', district: 'farm', walkBlock: true },
    { tileX: 4.7, tileY: 13.7, id: 'prop.farm.beehives', layer: 'cache', district: 'farm', walkBlock: true },
    { tileX: 6.5, tileY: 13.4, id: 'prop.farm.cropRows.short', layer: 'cache', district: 'farm', walkBlock: true },
    { tileX: 6.9, tileY: 14.1, id: 'prop.farm.hayWagon', layer: 'cache', district: 'farm', walkBlock: true },
    { tileX: 7.9, tileY: 13.6, id: 'prop.fence.gate', layer: 'cache', district: 'farm', walkBlock: true },
    { tileX: 8.8, tileY: 12.85, id: 'prop.fence.nwSe', layer: 'cache', district: 'farm', walkBlock: true },
    { tileX: 8.9, tileY: 13.6, id: 'prop.farm.trough', layer: 'cache', district: 'farm', walkBlock: true },
];

// Living Isle W2.2: three awning colourways of one stall (manifest
// prop.marketStall, .ochre, .canvas), picked per placement by a fixed hash
// of its tile so a stall keeps its colours across reloads.
function marketStallType(tileX, tileY) {
    const ways = ['marketStall', 'marketStall.ochre', 'marketStall.canvas'];
    const h = (Math.imul(Math.round(tileX * 10), 73856093) ^ Math.imul(Math.round(tileY * 10), 19349663)) >>> 0;
    return ways[h % ways.length];
}

// Props group by purpose (plan item 4.1): a work yard reads as cart + lantern,
// never as lone steles on open dirt. Upright stones and crates are rationed
// island-wide — two runestones (portal ruins, observatory skywatch), one gate
// notice pillar, three crates (harbor ledger, archive alcove, forge handoff).
export const AMBIENT_GROUND_PROPS = [
    // Forge and mine work yards: ore carts with their lanterns.
    { tileX: 24.4, tileY: 29.7, type: 'oreCart' },
    { tileX: 25.4, tileY: 29.6, type: 'lantern' },
    { tileX: 13.3, tileY: 34.7, type: 'oreCart' },
    { tileX: 12.5, tileY: 35.4, type: 'lantern' },

    // Civic core: utility props around the square, not scattered through the
    // woods. The Command gate steps own the front of the plaza (row 20); the
    // village well stands on the south-bank green (DISTRICT_PROPS).
    { tileX: 12.1, tileY: 20.0, type: marketStallType(12.1, 20.0) },
    { tileX: 17.8, tileY: 19.4, type: 'signpost' },

    // Research edges: a reading lamp beside the Archive alcove's scroll
    // crates, a skywatch lamp beside the Observatory's runestone.
    { tileX: 11.2, tileY: 17.3, type: 'lantern' },
    { tileX: 24.5, tileY: 18.9, type: 'lantern' },
];

export const AMBIENT_SCENIC_POINTS = Object.freeze([
    { id: 'bridge-west', tileX: 17, tileY: 26, district: 'civic', reason: 'bridge-pause', tags: ['bridge'] },
    { id: 'bridge-east', tileX: 19, tileY: 22, district: 'civic', reason: 'bridge-pause', tags: ['bridge'] },
    { id: 'harbor-rail', tileX: 31, tileY: 23, district: 'harbor', reason: 'harbor-watch', tags: ['water'] },
    { id: 'harbor-ledger', tileX: 33, tileY: 24, district: 'harbor', reason: 'dock-ledger', tags: ['harbor'] },
    { id: 'portal-ruins', tileX: 4, tileY: 36, district: 'arcane', reason: 'portal-observe', tags: ['portal'] },
    { id: 'mine-cart', tileX: 15, tileY: 37, district: 'resource', reason: 'cart-path', tags: ['mine'] },
    { id: 'forest-edge', tileX: 25, tileY: 11, district: 'knowledge', reason: 'forest-edge', tags: ['quiet'] },
    { id: 'archive-alcove', tileX: 10, tileY: 18, district: 'knowledge', reason: 'reading-alcove', tags: ['archive'] },
    { id: 'observatory-view', tileX: 25, tileY: 19, district: 'knowledge', reason: 'skywatch', tags: ['observatory'] },
    { id: 'lighthouse-shore', tileX: 30, tileY: 15, district: 'harbor', reason: 'shore-watch', tags: ['watchtower'] },
    { id: 'plaza-corner', tileX: 20, tileY: 22, district: 'civic', reason: 'plaza-pause', tags: ['command'] },
    { id: 'forge-handoff', tileX: 27, tileY: 31, district: 'workshop', reason: 'handoff-path', tags: ['forge', 'taskboard'] },
]);

// #41 — Scenic-point storytelling props. Authored detail baked at the
// AMBIENT_SCENIC_POINTS so each loiter spot reads as an inhabited place: a
// coiled net at the harbor rail, scroll-bundles in the reading alcove, a mossy
// resting stone at the forest edge. All `layer: 'cache'` so they fold into the
// terrain bake with zero per-frame cost. `scenicPoint` links each prop to its
// point id; `tileX/tileY` are offset slightly off the loiter tile so the
// standing villager and the prop compose rather than overlap. Existing,
// manifest-validated sprite ids only — no new PNGs, so no assetVersion bump.
export const SCENIC_POINT_PROPS = [
    { scenicPoint: 'bridge-west', tileX: 16.5, tileY: 26.4, id: 'prop.lantern', layer: 'cache' },
    { scenicPoint: 'bridge-east', tileX: 19.6, tileY: 21.6, id: 'prop.lantern', layer: 'cache' },
    // The harbor-rail and harbor-ledger loiter tiles sit in open water; their
    // props stand on the quay where the causeway meets land, never afloat.
    { scenicPoint: 'harbor-rail', tileX: 28.0, tileY: 20.8, id: 'prop.netRack', layer: 'cache' },
    { scenicPoint: 'harbor-ledger', tileX: 26.6, tileY: 20.6, id: 'prop.scrollCrates', layer: 'cache' },
    { scenicPoint: 'portal-ruins', tileX: 4.5, tileY: 35.5, id: 'prop.runestone', layer: 'cache' },
    { scenicPoint: 'mine-cart', tileX: 15.4, tileY: 36.5, id: 'prop.oreCart', layer: 'cache' },
    { scenicPoint: 'forest-edge', tileX: 25.5, tileY: 11.4, id: 'veg.standingStone.mossy', layer: 'cache' },
    { scenicPoint: 'archive-alcove', tileX: 10.4, tileY: 17.6, id: 'prop.scrollCrates', layer: 'cache' },
    { scenicPoint: 'observatory-view', tileX: 25.4, tileY: 18.5, id: 'prop.runestone', layer: 'cache' },
    { scenicPoint: 'lighthouse-shore', tileX: 29.6, tileY: 15.4, id: 'prop.driftwood.log', layer: 'cache' },
    // W8.2b: the 49 px handcart sits 0.1 tile up-east so its fixture box
    // (half 24) clears the plaza-corner viewing place at 20,22.
    { scenicPoint: 'plaza-corner', tileX: 20.7, tileY: 21.3, id: 'prop.flowerCart', layer: 'cache' },
    { scenicPoint: 'forge-handoff', tileX: 27.4, tileY: 32.4, id: 'prop.scrollCrates', layer: 'cache' },
];

// W8.5a (AD-P2) — the offshore backdrop: static sea scenery past the map
// diamond, in the whole-island frame's right third. Purely visual: no
// consumer outside OffshoreScenery.js, so never walkable, never coast-seeded,
// outside `_fullIslandWorldBox` and the camera content frame. Listed in
// explicit painter order, back to front (ascending world y); the water pass
// draws them over the sea and under every island drawable. Every placement is
// outside the map (ship lanes, anchorages and the release slip all lie
// inside it) and at least three tiles from each HorizonLife
// FAR_SEA_STATIONS station. No hull, sail or boat: the reef wreck is a
// broken bow on rocks (user-approved).
// World x 1000..1430 keeps every piece inside the user's whole-island frame
// (zoom 1, its right edge near world x 1470): the two far-shore strips and
// the hamlet islet along the top right (the far sea), the three stacks just
// past the east vertex on the Lighthouse's sight-line, the reef wreck off
// the Harbor's outer fairway and the beacon rock to the south-east.
export const OFFSHORE_SCENERY = Object.freeze([
    Object.freeze({ id: 'prop.farShore.b', tileX: 18, tileY: -13.5 }),
    Object.freeze({ id: 'prop.farShore.a', tileX: 23.75, tileY: -17.75 }),
    Object.freeze({ id: 'prop.farHamlet', tileX: 25.25, tileY: -13.5 }),
    Object.freeze({ id: 'prop.seaStack.a', tileX: 38.5, tileY: -3.5 }),
    Object.freeze({ id: 'prop.seaStack.c', tileX: 41.25, tileY: -3.25 }),
    Object.freeze({ id: 'prop.seaStack.b', tileX: 41.25, tileY: 0.5 }),
    Object.freeze({ id: 'prop.reefWreck', tileX: 47.5, tileY: 7 }),
    Object.freeze({ id: 'prop.beaconRock', tileX: 54.75, tileY: 15.5 }),
]);

export const GULL_FLIGHT_FRAMES = [
    'prop.gullFlight.up',
    'prop.gullFlight.level',
    'prop.gullFlight.down',
    'prop.gullFlight.level',
];
export const GULL_BANK_FRAME = 'prop.gullFlight.bank';
export const GULL_ROUTE_SPEED_SCALE = 0.52;
export const GULL_LIGHTHOUSE_HOTSPOT = { tileX: 31.4, tileY: 12.2 };
// Watchtower gull orbit: single-bird 30s loop pegged just north of the
// Pharos Lighthouse lantern (watchtower footprint sits at tile (27,8) sized
// 3x5), with the orbit centre on the sea side so the bird reads as guarding
// the beacon. Buoys flank the beacon on adjacent open-water tiles.
export const WATCHTOWER_GULL_ORBIT = Object.freeze({
    centerTileX: 28,
    centerTileY: 12,
    radiusTileX: 2.2,
    radiusTileY: 1.6,
    periodMs: 30000,
    altitudePx: 38,
});
export const WATCHTOWER_BEACON_BUOY_TILES = Object.freeze([
    { tileX: 29, tileY: 9 },
    { tileX: 30, tileY: 11 },
]);
export const GULL_OFFMAP_GATEWAYS = [
    { tileX: -4.8, tileY: 24.8 },
    { tileX: 7.2, tileY: -4.6 },
    { tileX: 22.8, tileY: -5.2 },
    { tileX: 43.8, tileY: 4.8 },
    { tileX: 45.2, tileY: 17.6 },
    { tileX: 43.6, tileY: 34.4 },
    { tileX: 28.2, tileY: 44.6 },
    { tileX: 3.8, tileY: 43.8 },
];
export const GULL_STAGING_WAYPOINTS = [
    { tileX: 10.8, tileY: 7.8 },
    { tileX: 19.8, tileY: 9.8 },
    { tileX: 27.4, tileY: 8.2 },
    { tileX: 36.0, tileY: 10.4 },
    { tileX: 35.8, tileY: 23.8 },
    { tileX: 23.4, tileY: 24.8 },
    { tileX: 9.8, tileY: 24.8 },
    { tileX: 34.0, tileY: 29.4 },
    { tileX: 7.4, tileY: 8.6 },
    { tileX: 14.0, tileY: 9.6 },
];
export const OPEN_SEA_FLOCK_FORMATION = [
    { side: 0.00, trail: 0.00 },
    { side: -0.42, trail: 0.36 },
    { side: 0.42, trail: 0.36 },
    { side: -0.82, trail: 0.78 },
    { side: 0.82, trail: 0.78 },
    { side: -1.18, trail: 1.22 },
    { side: 1.18, trail: 1.22 },
    { side: -0.30, trail: 1.58 },
    { side: 0.30, trail: 1.58 },
    { side: 0.00, trail: 1.92 },
];
export const OPEN_SEA_FLOCK_ROUTES = [
    {
        size: 8,
        altitude: 38,
        phase: 0.02,
        speed: 0.032,
        wingRate: 3.6,
        route: [
            { tileX: 37.2, tileY: 5.4 },
            { tileX: 33.2, tileY: 2.8 },
            { tileX: 28.7, tileY: 4.8 },
            { tileX: 31.8, tileY: 8.8 },
            { tileX: 37.6, tileY: 9.4 },
        ],
    },
    {
        size: 9,
        altitude: 31,
        phase: 0.24,
        speed: 0.026,
        wingRate: 3.1,
        route: [
            { tileX: 38.4, tileY: 6.2 },
            { tileX: 35.6, tileY: 12.6 },
            { tileX: 37.6, tileY: 17.4 },
            { tileX: 35.2, tileY: 24.8 },
            { tileX: 37.5, tileY: 31.4 },
            { tileX: 39.1, tileY: 20.8 },
        ],
    },
    {
        size: 7,
        altitude: 27,
        phase: 0.47,
        speed: 0.038,
        wingRate: 4.0,
        route: [
            { tileX: 31.6, tileY: 24.7 },
            { tileX: 35.6, tileY: 25.6 },
            { tileX: 38.2, tileY: 28.6 },
            { tileX: 36.0, tileY: 32.6 },
            { tileX: 33.0, tileY: 27.4 },
        ],
    },
    {
        size: 8,
        altitude: 24,
        phase: 0.69,
        speed: 0.021,
        wingRate: 2.9,
        route: [
            { tileX: 2.4, tileY: 25.0 },
            { tileX: 9.0, tileY: 24.8 },
            { tileX: 17.2, tileY: 25.2 },
            { tileX: 25.8, tileY: 24.4 },
            { tileX: 32.8, tileY: 24.4 },
            { tileX: 37.8, tileY: 25.8 },
        ],
    },
    {
        size: 6,
        altitude: 34,
        phase: 0.86,
        speed: 0.024,
        wingRate: 3.4,
        route: [
            { tileX: 7.6, tileY: 8.4 },
            { tileX: 12.3, tileY: 5.4 },
            { tileX: 17.4, tileY: 9.8 },
            { tileX: 24.8, tileY: 7.5 },
            { tileX: 31.0, tileY: 5.0 },
            { tileX: 36.8, tileY: 8.2 },
        ],
    },
    {
        size: 5,
        altitude: 22,
        phase: 0.13,
        speed: 0.024,
        wingRate: 3.4,
        route: [
            { tileX: 6.4, tileY: 9.6 },
            { tileX: 11.2, tileY: 7.2 },
            { tileX: 16.4, tileY: 9.0 },
            { tileX: 13.0, tileY: 11.4 },
            { tileX: 8.0, tileY: 11.2 },
        ],
    },
];

// W6.5 (AW-P4) — each school drifts along its short `path` (tile points, a
// ping-pong over `driftS` seconds of the motion clock) inside one body of
// water, every point on a lagoon or shallow water tile that is not bridge
// deck (WildlifeRenderer draws a school on nothing else), and scatters for
// ~3 s when a gull's fishing dive or a git ship's wake crosses it.
export const MARINE_FISH_SCHOOLS = [
    { tileX: 29.5, tileY: 15.5, id: 'prop.fishSchoolTeal', radius: 0.12, phase: 0.1, driftS: 150,
        path: [{ tileX: 29.5, tileY: 12.2 }, { tileX: 29.6, tileY: 15.5 }, { tileX: 29.4, tileY: 17.8 }] },
    { tileX: 24.5, tileY: 26.5, id: 'prop.fishSchoolTeal', radius: 0.12, phase: 2.1, driftS: 130,
        path: [{ tileX: 21.5, tileY: 26.4 }, { tileX: 24.5, tileY: 26.5 }, { tileX: 27.3, tileY: 26.4 }] },
    { tileX: 18.2, tileY: 10.4, id: 'prop.fishSchoolTeal', radius: 0.12, phase: 3.6, driftS: 110,
        path: [{ tileX: 16.6, tileY: 10.5 }, { tileX: 18.4, tileY: 10.4 }, { tileX: 19.8, tileY: 11.3 }] },
    { tileX: 8.5, tileY: 6.4, id: 'prop.fishSchoolTeal', radius: 0.12, phase: 5.2, driftS: 140,
        path: [{ tileX: 5.5, tileY: 6.6 }, { tileX: 8.5, tileY: 6.4 }, { tileX: 11.0, tileY: 7.0 }] },
    { tileX: 17.0, tileY: 21.5, id: 'prop.fishSchoolKoi', radius: 0.08, phase: 1.4, driftS: 70,
        path: [{ tileX: 16.25, tileY: 21.5 }, { tileX: 17.7, tileY: 21.55 }] },
];

// Birdsong & Bloom (v0.16): land + water fauna.
// Songbirds flit on small looping flight paths between the trees of the
// inhabited belt. `points` are tile waypoints; the loop closes automatically.
export const LAND_BIRD_ROUTES = [
    { speed: 0.020, altitude: 28, phase: 0.00, wingRate: 6, points: [
        { tileX: 14, tileY: 19 }, { tileX: 17, tileY: 17.5 }, { tileX: 19.5, tileY: 19.5 }, { tileX: 16, tileY: 22 } ] },
    { speed: 0.016, altitude: 24, phase: 0.40, wingRate: 5, points: [
        { tileX: 8, tileY: 20 }, { tileX: 10.5, tileY: 22 }, { tileX: 7, tileY: 24 }, { tileX: 5.5, tileY: 21 } ] },
    { speed: 0.023, altitude: 30, phase: 0.72, wingRate: 7, points: [
        { tileX: 25, tileY: 30 }, { tileX: 28.5, tileY: 28.5 }, { tileX: 27, tileY: 32 }, { tileX: 24, tileY: 31 } ] },
];

// Ducks drifting on calm lagoon water (west of the command footbridge, the
// central lily basin, the NW lagoon). Every home is a water tile that is not
// bridge deck (WildlifeRenderer draws a duck on nothing else).
// W6.5 (AW-P4): by day each paddles its `paddle` loop (tile points, one lap
// per `lapS` seconds of the motion clock; the loop is star-shaped about the
// home so every chord to it stays on water); at dusk it swims home and on
// to its `bank` (a shore tile beside its own water) and sleeps there through
// the night, back out at dawn.
export const CALM_WATER_FAUNA = [
    { tileX: 14.3, tileY: 23.55, id: 'prop.duck', radius: 0.16, phase: 0.3, lapS: 240,
        paddle: [{ tileX: 11.2, tileY: 23.5 }, { tileX: 15.3, tileY: 23.4 }, { tileX: 15.5, tileY: 24.5 }, { tileX: 11.4, tileY: 24.6 }],
        bank: { tileX: 13.5, tileY: 22.6 } },
    { tileX: 17.6, tileY: 21.6, id: 'prop.duck', radius: 0.14, phase: 2.1, lapS: 150,
        paddle: [{ tileX: 16.3, tileY: 21.3 }, { tileX: 17.7, tileY: 21.3 }, { tileX: 17.7, tileY: 21.8 }, { tileX: 16.3, tileY: 21.8 }],
        bank: { tileX: 17.4, tileY: 20.6 } },
    { tileX: 13.2, tileY: 8.2, id: 'prop.duck', radius: 0.18, phase: 4.0, lapS: 260,
        paddle: [{ tileX: 11.6, tileY: 8.3 }, { tileX: 13.5, tileY: 7.6 }, { tileX: 14.8, tileY: 8.6 }, { tileX: 13.4, tileY: 9.5 }, { tileX: 11.6, tileY: 9.4 }],
        bank: { tileX: 14.5, tileY: 7.4 } },
    { tileX: 14.8, tileY: 9.0, id: 'prop.duck', radius: 0.13, phase: 1.2, lapS: 220,
        paddle: [{ tileX: 14.3, tileY: 9.4 }, { tileX: 16.6, tileY: 9.3 }, { tileX: 17.6, tileY: 10.5 }, { tileX: 15.2, tileY: 10.6 }],
        bank: { tileX: 13.4, tileY: 12.4 } },
];

// W6.5 (AW-P4) — the herons' five shallows: a shore tile beside the NW
// lagoon or a lagoon tile that is shallow, never deep or bridge deck. Each
// heron stands on its `shallow`; an occasional `heron-relocation` event
// flies one to a free shallow and back.
export const HERON_SHALLOWS = [
    { tileX: 11.4, tileY: 10.6 },
    { tileX: 4.6, tileY: 10.4 },
    { tileX: 7.5, tileY: 11.5 },
    { tileX: 14.6, tileY: 12.5 },
    { tileX: 17.5, tileY: 13.4 },
];

// Herons wading at the shoreline (mostly still, gentle bob).
export const SHORE_FAUNA = [
    { tileX: 11.4, tileY: 10.6, id: 'prop.heron', shallow: 0 },
    { tileX: 4.6, tileY: 10.4, id: 'prop.heron', shallow: 1 },
];

// W8.4a (AD-P11) — land fauna, drawn by WildlifeRenderer's livestock region
// (no walk blocks, no fixtures). Each actor holds still at one point for a
// seeded `holdS` span, then walks to the next at `speed` tiles/s (a sheep
// moves about a tile a minute), on its loop forever. Every point is open
// ground clear of visit/queue tiles, rest seats and scenic points: the
// paddock between the Archive and Command (OpusDressMarketFarm's fences,
// trough and crops kept clear) — the cow at the trough's front east of the
// gate, the sheep in front of the gate leaf and the goat at the hay cart,
// none over a gate post, a rail or the Command roofline below — the
// hens in front of it, the dog at the Forge's front and the cat on the
// Archive plaza. `face` is the facing held at a point when it differs from
// the arriving walk. Listed in draw priority: the zoom cap keeps the first
// N (livestockBudget).
export const LIVESTOCK_ROUTES = [
    { id: 'cow', sprite: 'prop.fauna.cow', speed: 0.16, holdS: [34, 70], phase: 0.12, kind: 'grazer',
        points: [{ tileX: 9.5, tileY: 13.75, face: 'west' }, { tileX: 9.55, tileY: 13.95, face: 'south' }] },
    { id: 'sheep', sprite: 'prop.fauna.sheep', speed: 0.18, holdS: [26, 58], phase: 0.57, kind: 'grazer',
        points: [{ tileX: 8.72, tileY: 14.41, face: 'east' }, { tileX: 8.75, tileY: 14.63, face: 'south' }] },
    { id: 'goat', sprite: 'prop.fauna.goat', speed: 0.22, holdS: [20, 44], phase: 0.31, kind: 'grazer',
        points: [{ tileX: 7.69, tileY: 14.56, face: 'west' }, { tileX: 7.72, tileY: 14.78, face: 'south' }] },
    { id: 'dog', sprite: 'prop.fauna.dog', speed: 0.55, holdS: [24, 60], phase: 0.44, kind: 'roamer', night: 'away', wet: 'away',
        points: [{ tileX: 26.4, tileY: 29.45, face: 'south' }, { tileX: 29.3, tileY: 29.45, face: 'west' }] },
    { id: 'cat', sprite: 'prop.fauna.cat', speed: 0.4, holdS: [40, 90], phase: 0.73, kind: 'roamer', night: 'roam', wet: 'away',
        points: [{ tileX: 6.7, tileY: 20.5, face: 'south' }, { tileX: 8.8, tileY: 20.6, face: 'south' }] },
    { id: 'hen-b', sprite: 'prop.fauna.chicken', speed: 0.3, holdS: [10, 24], phase: 0.66, kind: 'hen', night: 'away', wet: 'away',
        points: [{ tileX: 10.45, tileY: 14.45 }, { tileX: 10.1, tileY: 14.3 }, { tileX: 10.6, tileY: 14.95 }] },
];

// W8.4a (AW-P15) — the `deer-at-dawn` ambient event (AmbientEvents,
// occasional tier, dawn only): a stag steps out of the treeline at `from`,
// walks to `graze`, grazes there and walks back, fading in and out over
// the first and last steps of the treeline so it never pops.
export const DEER_DAWN_ROUTE = Object.freeze({
    sprite: 'prop.fauna.deer',
    from: Object.freeze({ tileX: 9.4, tileY: 2.5 }),
    graze: Object.freeze({ tileX: 11.2, tileY: 2.85 }),
});

// Density thresholds for noise-driven flat features.
// `BUSH_DENSITY` and `GRASS_TUFT_DENSITY` are noise thresholds in [0, 1] —
// a tile becomes a bush/tuft when its noise value falls in the band.
// Tuned to roughly match the existing 'flowers'/'mushrooms' densities.
export const BUSH_DENSITY = { min: 0.05, max: 0.13 };
export const GRASS_TUFT_DENSITY = { min: 0.18, max: 0.30 };
// Flower-clump scatter. Sparse base everywhere (a light meadow dusting), much
// denser where VEGETATION_DISTRICTS set a `flowerBoost`. Flowers are flat and
// never block building sightlines, so they fill the lived-in zone safely.
export const FLOWER_DENSITY = { min: 0.02, max: 0.075 };
