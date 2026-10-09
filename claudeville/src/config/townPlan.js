// Authored town structure for the isometric village.
// Building positions remain in buildings.js; this file owns the readable
// settlement shape: district masses and the roads that connect them.

export const VILLAGE_GATE = Object.freeze({
    id: 'prop.villageGate',
    tileX: 19.0,
    tileY: 39.1,
    widthTiles: 9.0,
    // In the arch's mouth (half-width 0.72): with the renderer's ±0.3 jitter
    // an arriving or departing body never stands in the jambs.
    outside: { tileX: 19.05, tileY: 39.3 },
    // Where bodies already in the village appear at load (±0.32 / ±0.22
    // jitter, then spread): far enough in that the spread never backs a
    // body into the east gate tower's drum.
    inside: { tileX: 20.4, tileY: 37.4 },
});

// True when a foot at (tileX, tileY) lies within `reach` tiles of the
// village's stone: a wall run's line (the curtain, 0.1875 tile either side),
// the gatehouse's span between the runs, a gate tower's drum, or the sea
// tower's drum on the east run's end (where IsometricRenderer places it on
// this map: SEA_TOWER_GEOMETRY.endInset tiles back from the run's end). The
// arch passage is open. SceneryEngine closes the walk nodes it returns true
// for; VisitTileAllocator.standsOnFixture keeps every standing place off it.
// Steering asks it per walker per frame, so the stone's segments and the sea
// tower's centre are laid out once (`villageMasonryShape`).
export function inVillageMasonry(tileX, tileY, reach = 0.3) {
    const G = VILLAGE_GATE_GEOMETRY;
    const X = tileX - VILLAGE_GATE.tileX;
    const Y = tileY - VILLAGE_GATE.tileY;
    if (Math.abs(X) < G.archHalfWidth && Math.abs(Y) <= G.blockHalfDepth + reach) return false;
    for (const cx of G.towerX) if (Math.hypot(X - cx, Y) < G.towerR + reach) return true;
    const { segments, seaX, seaY } = villageMasonryShape();
    if (Math.hypot(tileX - seaX, tileY - seaY) < SEA_TOWER_GEOMETRY.towerR + reach) return true;
    for (let i = 0; i < segments.length; i += 4) {
        const ax = segments[i];
        const ay = segments[i + 1];
        const dx = segments[i + 2] - ax;
        const dy = segments[i + 3] - ay;
        const t = Math.max(0, Math.min(1, ((tileX - ax) * dx + (tileY - ay) * dy) / Math.max(1e-6, dx * dx + dy * dy)));
        if (Math.hypot(tileX - (ax + t * dx), tileY - (ay + t * dy)) < reach) return true;
    }
    return false;
}

let villageMasonry = null;
function villageMasonryShape() {
    if (villageMasonry) return villageMasonry;
    const half = VILLAGE_GATE.widthTiles / 2;
    const segments = [VILLAGE_GATE.tileX - half, VILLAGE_GATE.tileY, VILLAGE_GATE.tileX + half, VILLAGE_GATE.tileY];
    let seaX = NaN;
    let seaY = NaN;
    for (const { id, points } of VILLAGE_WALL_ROUTES) {
        for (let i = 1; i < points.length; i++) segments.push(points[i - 1].tileX, points[i - 1].tileY, points[i].tileX, points[i].tileY);
        if (id !== 'east') continue;
        const [a, b] = points.slice(-2);
        const len = Math.max(1e-6, Math.hypot(b.tileX - a.tileX, b.tileY - a.tileY));
        const k = SEA_TOWER_GEOMETRY.endInset / len;
        seaX = b.tileX - (b.tileX - a.tileX) * k;
        seaY = b.tileY - (b.tileY - a.tileY) * k;
    }
    villageMasonry = { segments: Float64Array.from(segments), seaX, seaY };
    return villageMasonry;
}

export const VILLAGE_GATE_BOUNDS = Object.freeze({
    left: -236,
    right: 236,
    top: -236,
    bottom: 96,
});

// The gatehouse as authored (scripts/sprites/bake-village-gate.mjs bakes
// prop.villageGate from it; the renderer hangs the doors, lanterns and wall
// stubs on the same numbers). Tiles along +tileX from VILLAGE_GATE (X) and
// +tileY off the wall line (Y); heights in world px. The arch and the sign sit
// on X = 0, on the block's face a quarter tile in front of the wall line
// (screen x 32 (X - Y) = -8). At the sign's height that face shows from where
// it leaves the west drum (screen x 32 (west + 0.295)) to the east drum's
// silhouette (32 (east - 0.849)), so towers at -2.33 and 2.41 (symmetric
// within 0.08 tile) leave the sign and the arch an equal margin either side.
// The corbels stand 9 px above the merlon tops: the parapet meets each drum
// below its machicolation.
export const VILLAGE_GATE_GEOMETRY = Object.freeze({
    towerX: Object.freeze([-2.33, 2.41]),
    towerR: 0.6,
    blockHalfDepth: 0.25,
    plinthTop: 10,
    plinthOut: 0.05,
    archHalfWidth: 0.72,
    archSpring: 20,
    archRise: 1.25,
    voussoirDepth: 8,
    voussoirs: 13,
    portcullisBottom: 47,
    stringZ: Object.freeze([75, 79]),
    stringOut: 0.04,
    blockTop: 81,
    merlon: Object.freeze({ width: 11, gap: 7, depth: 3, height: 10 }),
    railHeight: 4,
    corbelZ: Object.freeze([100, 106]),
    corbels: 16,
    ringOut: 0.08,
    ringTop: 114,
    eaveOut: 0.16,
    roofApex: 178,
    // Angles round each tower (radians, atan2(tileY, tileX); pi/4 faces the
    // camera, 3pi/4 the lit west). `lit` glass is the guard room's lamp; the
    // slit stands under it, clear of the arch block, which hides the west
    // drum below 0.43.
    towerWindows: Object.freeze([
        Object.freeze({ angle: 1.25, z0: 62, z1: 76, width: 6, pointed: true, lit: true }),
        Object.freeze({ angle: 1.0, z0: 28, z1: 38, width: 3, pointed: false, lit: false }),
    ]),
    sign: Object.freeze({ text: 'CLAUDEVILLE', z0: 59, z1: 74, textTop: 4, field: '#5b132a', fieldShadow: '#3f1c1a' }),
    // Door leaves hang a little behind the wall line.
    doorY: -0.06,
    // Wall lanterns flank the arch on the block's face.
    lanternX: Object.freeze([-1.28, 1.28]),
    lanternZ: 36,
});

// The sea tower at the east wall's coastal end (prop.villageWallSeaTower,
// baked by the same script): a round lookout on its rock, a crenellated
// gallery and a glazed lamp room under a slate cone.
export const SEA_TOWER_GEOMETRY = Object.freeze({
    towerR: 0.6,
    // Tiles back from the east run's end where the renderer stands it on this
    // map (IsometricRenderer._villageWallSeaTowerTile: every nearer candidate
    // is water).
    endInset: 1.45,
    plinthTop: 12,
    plinthOut: 0.06,
    corbelZ: Object.freeze([98, 104]),
    corbels: 16,
    ringOut: 0.09,
    galleryFloor: 108,
    merlons: 12,
    merlonShare: 0.55,
    merlonHeight: 7,
    lampR: 0.44,
    eaveZ: 136,
    eaveOut: 0.16,
    roofApex: 190,
    windows: Object.freeze([
        Object.freeze({ angle: 1.1, z0: 34, z1: 46, width: 3, pointed: false, lit: false }),
        Object.freeze({ angle: 0.35, z0: 70, z1: 82, width: 3, pointed: false, lit: false }),
    ]),
    // The lamp room's three lancets on the camera's half of the drum.
    lampWindows: Object.freeze([
        Object.freeze({ angle: -0.2, z0: 116, z1: 131, width: 6, pointed: true, lit: true }),
        Object.freeze({ angle: 0.8, z0: 116, z1: 131, width: 7, pointed: true, lit: true }),
        Object.freeze({ angle: 1.8, z0: 116, z1: 131, width: 6, pointed: true, lit: true }),
    ]),
    // Half-sunk boulders round the foot (tiles, px; centres at the waterline).
    rocks: Object.freeze([
        Object.freeze({ x: 0.52, y: 0.5, z: 0, rx: 0.4, ry: 0.34, rz: 13 }),
        Object.freeze({ x: -0.34, y: 0.66, z: 0, rx: 0.34, ry: 0.28, rz: 10 }),
        Object.freeze({ x: 0.74, y: -0.22, z: 0, rx: 0.32, ry: 0.38, rz: 11 }),
        Object.freeze({ x: 0.16, y: 0.8, z: 0, rx: 0.24, ry: 0.2, rz: 7 }),
        Object.freeze({ x: 0.92, y: 0.3, z: 0, rx: 0.2, ry: 0.18, rz: 6 }),
    ]),
});

// The first walkable tile at the foot of the Portal Gate's stairs, centred
// under the vortex (footprint origin 2,29 size 4x4; the stairs run down its SW
// face to the walk-excluded row y 33). Subagents appear here, so dispatch
// reads as "child stepped out of the portal and down its steps" rather than
// the generic Village Gate arrival used by top-level sessions. A body cannot
// stand at the dais's height, and on the dais floor its feet would sit on the
// building's front sort line (footprint centre + 16 px), so the spawn jitter
// would hide it behind the dais and arch; a tile inside the footprint or on
// row 33 is also snapped to the nearest walkable tile by the first walk leg.
// Here (centre + 64 px) it always draws in front of the stairs.
export const PORTAL_SPAWN_TILE = Object.freeze({ tileX: 5, tileY: 34 });

export const VILLAGE_WALL_ROUTES = Object.freeze([
    {
        id: 'west',
        points: [
            { tileX: 0.0, tileY: 39.1 },
            { tileX: 14.5, tileY: 39.1 },
        ],
    },
    {
        id: 'east',
        points: [
            { tileX: 23.5, tileY: 39.1 },
            { tileX: 35.8, tileY: 39.1 },
        ],
    },
]);

// `width` is in tiles (1 or 2). The three arms that leave the Command plaza
// are 2-wide so the civic core reads as a hub with radiating avenues; the
// rest of the network stays single-file.
export const TOWN_ROAD_ROUTES = Object.freeze([
    {
        id: 'north-bank-promenade',
        material: 'avenue',
        width: 1,
        points: [[7, 23], [10, 20]],
    },
    {
        id: 'civic-west-arm',
        material: 'avenue',
        width: 2,
        points: [[10, 20], [14, 21]],
    },
    {
        id: 'civic-east-arm',
        material: 'avenue',
        width: 2,
        points: [[16, 20], [23, 18]],
    },
    {
        id: 'observatory-promenade',
        material: 'avenue',
        width: 1,
        points: [[23, 18], [28, 16], [29, 13]],
    },
    {
        id: 'production-row',
        material: 'dirt',
        width: 1,
        points: [[6, 34], [13, 34], [18, 38], [22, 37], [28, 37], [28, 31], [25, 29]],
    },
    {
        id: 'west-production-road',
        material: 'avenue',
        width: 1,
        points: [[6, 34], [14, 31], [18, 27]],
    },
    {
        id: 'civic-south-arm',
        material: 'avenue',
        width: 2,
        points: [[16, 20], [18, 21]],
    },
    {
        id: 'central-river-bridge',
        material: 'avenue',
        width: 1,
        points: [[18, 21], [18, 26], [22, 31], [22, 37]],
    },
    {
        id: 'archive-walk',
        material: 'avenue',
        width: 1,
        points: [[7, 23], [8, 20], [8, 17]],
    },
    {
        id: 'clock-walk',
        material: 'avenue',
        width: 1,
        points: [[23, 18], [23, 16]],
    },
    {
        id: 'lighthouse-quay',
        material: 'dock',
        width: 1,
        points: [[29, 19], [29, 16], [29, 13]],
    },
    {
        id: 'harbor-berths',
        material: 'dock',
        width: 1,
        points: [[30, 20], [32, 21], [35, 22], [38, 22], [40, 20], [39, 18]],
    },
    {
        id: 'gate-avenue',
        material: 'avenue',
        width: 1,
        points: [[18, 26], [18, 32], [19, 36], [19, 39]],
    },
]);

// District identity through yard materials (plan item 4.7). Each building's
// frontage apron — the ring side its entrance faces plus nearby visit tiles —
// is laid in its district's material by the ground bake (GroundBake.js), not
// tinted by an alpha wash. `surface` picks the ground ramp and texture,
// `edge` the low baked edging where the yard meets grass, and `paved` whether
// footfall/lane material reads it as stone (avenue) or earth (dirt).
//   flag    dressed flagstone (plaza ramp, one step darker than Command's)
//   gravel  crushed stone (road ramp, fine texture)
//   cinder  packed dark earth with slag flecks (dirt ramp, low)
//   earth   trodden yard earth (dirt ramp)
export const YARD_MATERIALS = Object.freeze({
    archive: Object.freeze({ surface: 'flag', edge: 'kerb', paved: true }),
    observatory: Object.freeze({ surface: 'flag', edge: 'kerb', paved: true }),
    portal: Object.freeze({ surface: 'flag', edge: 'kerb', paved: true }),
    forge: Object.freeze({ surface: 'cinder', edge: 'wattle', paved: false }),
    mine: Object.freeze({ surface: 'gravel', edge: null, paved: false }),
    taskboard: Object.freeze({ surface: 'earth', edge: 'wattle', paved: false }),
    watchtower: Object.freeze({ surface: 'gravel', edge: null, paved: false }),
    harbor: Object.freeze({ surface: 'gravel', edge: null, paved: false }),
});

// Plan 7.1 — rest seats. Idle villagers reserve the free seat nearest on foot
// (VisitTileAllocator) and hold a seated pose there; working bodies never sit.
// `facing` is the sitter's front three-quarter facing (the sit strips are
// authored for south-east and south-west only). `occluder` names the front
// slice drawn over the sitter's legs (RestSeats.js): a timber bench on the
// greens, the Harbor pier kerb, and stone (a step against Command's wings)
// that is drawn only under a sitter. Seats on building visit points (Command
// wings, the pier) never count as visitors (V8). None sits on the Command
// approach (7.2) or behind a wall the camera cannot see past.
export const REST_SEATS = Object.freeze([
    { id: 'command-east-step-n', tileX: 18, tileY: 18, facing: 'south-east', occluder: 'step' },
    { id: 'command-east-step-s', tileX: 18, tileY: 19, facing: 'south-east', occluder: 'step' },
    { id: 'command-west-step', tileX: 12, tileY: 19, facing: 'south-west', occluder: 'step' },
    { id: 'taskboard-green', tileX: 24, tileY: 28, facing: 'south-west', occluder: 'bench' },
    { id: 'harbor-pier', tileX: 26, tileY: 21, facing: 'south-west', occluder: 'pier' },
    { id: 'archive-green-e', tileX: 10, tileY: 13, facing: 'south-east', occluder: 'bench' },
    { id: 'archive-green-w', tileX: 12, tileY: 13, facing: 'south-west', occluder: 'bench' },
    { id: 'archive-bank-e', tileX: 4, tileY: 20, facing: 'south-east', occluder: 'bench' },
    { id: 'archive-bank-w', tileX: 6, tileY: 21, facing: 'south-west', occluder: 'bench' },
    { id: 'observatory-green-w', tileX: 24, tileY: 20, facing: 'south-west', occluder: 'bench' },
    { id: 'observatory-green-e', tileX: 26, tileY: 19, facing: 'south-east', occluder: 'bench' },
    { id: 'south-lawn-w', tileX: 6, tileY: 28, facing: 'south-east', occluder: 'bench' },
    { id: 'south-lawn-mid', tileX: 7, tileY: 30, facing: 'south-west', occluder: 'bench' },
    { id: 'south-lawn-e', tileX: 15, tileY: 28, facing: 'south-east', occluder: 'bench' },
    { id: 'forge-shore', tileX: 30, tileY: 30, facing: 'south-east', occluder: 'bench' },
    { id: 'gate-green-w', tileX: 16, tileY: 32, facing: 'south-east', occluder: 'bench' },
    { id: 'gate-green-e', tileX: 21, tileY: 34, facing: 'south-west', occluder: 'bench' },
]);

// Plan 7.2 — the petitioners' queue. Waiting-on-user agents stand in
// `slots` by SignalLedger wait rank (slot 0, nearest Command's door, holds the
// longest wait); ranks change only when the waiting set changes. The line
// leaves the foot of Command's steps, crosses the bridge landing, runs down
// the bridge deck and folds at its foot, between the watch lantern, the
// notice pillar, the avenue stall and the Task Board roof (32-36 world px
// between slots). The 13th petitioner onward stands on the civic west arm
// beyond the market stall (`overflow`). No slot stands on a fixture's footprint
// (VisitTileAllocator `standsOnFixture`) or behind a roof. `door` is the point
// the head of the line faces; each later slot faces the slot ahead of it.
export const COMMAND_QUEUE = Object.freeze({
    door: Object.freeze({ tileX: 14.5, tileY: 19.5 }),
    slots: Object.freeze([
        { tileX: 15, tileY: 21 },
        { tileX: 16, tileY: 22 },
        { tileX: 17, tileY: 22 },
        { tileX: 18, tileY: 22 },
        { tileX: 18, tileY: 23 },
        { tileX: 18, tileY: 24 },
        { tileX: 18, tileY: 25 },
        { tileX: 18, tileY: 26 },
        { tileX: 18, tileY: 27 },
        { tileX: 19, tileY: 28 },
        { tileX: 18, tileY: 28 },
        { tileX: 18, tileY: 29 },
    ].map(Object.freeze)),
    overflow: Object.freeze([
        { tileX: 11, tileY: 22 },
        { tileX: 10, tileY: 22 },
        { tileX: 9, tileY: 21 },
        { tileX: 10, tileY: 20 },
        { tileX: 9, tileY: 22 },
        { tileX: 8, tileY: 21 },
        { tileX: 10, tileY: 19 },
        { tileX: 8, tileY: 22 },
    ].map(Object.freeze)),
});

// W7.7 — repo standing stones: one land tile per Harbor Home-Waters
// anchorage (HarborTraffic COAST_ANCHORAGE_SLOTS, same index order), the
// nearest shore tile behind that slot's buoy and pennant, so a repo's stone
// stands on the island its fleet anchors off. Lagoon slots 0–1 take the
// lagoon's south bank and the spit; the east-coast slots take the Pharos
// shore and the southern strand (the two northern sea slots have no nearer
// land than the strand north of the Pharos). Stones are drawn props only:
// never a walk exclusion, never a fixture, never a visit tile.
export const REPO_STONE_ANCHORS = Object.freeze([
    { slot: 0, tileX: 7, tileY: 12 },   // Commit Lagoon West → lagoon south bank
    { slot: 1, tileX: 14, tileY: 7 },   // Commit Lagoon Spring → the spit
    { slot: 2, tileX: 28, tileY: 13 },  // Pharos Reach → Pharos shore
    { slot: 3, tileX: 30, tileY: 30 },  // Southern Strand
    { slot: 4, tileX: 26, tileY: 10 },  // North Shoal → strand north of the Pharos
    { slot: 5, tileX: 30, tileY: 31 },  // Reed Point
    { slot: 6, tileX: 24, tileY: 10 },  // Far North Sea → strand north of the Pharos
    { slot: 7, tileX: 31, tileY: 34 },  // Wall Tower Bank
    { slot: 8, tileX: 28, tileY: 14 },  // Pharos Bank
    { slot: 9, tileX: 30, tileY: 29 },  // Strand Shallows
].map(Object.freeze));

// W4.2 — door discipline. A landmark at capacity lines its next working
// visitors up on its approach file, in order of arrival (VisitTileAllocator
// `_lineSlot`): place 0 is the head and faces the building's entrance, each
// later place faces the place ahead, and a body steps up a place when one
// frees. Past the file a body takes the building's ranked outer ring
// (`VISIT_OVERFLOW_TILES`, buildings.js). Every step runs along a tile axis
// (36 world px) or across the screen at one depth (64 px), never toward the
// camera, so a line trails away from the camera-near side and its heads keep
// open sky for their thoughts. No place stands on a fixture, a road, a
// footprint, a walk exclusion or another standing place, except that a file
// may take over its own building's queue or scenic slot (the Harbor quay),
// which the allocator then leaves to the line. Command's petitioners keep
// their own queue (`COMMAND_QUEUE`); this file is for Command's visitors.
const approachFile = (...points) => Object.freeze(points.map(([tileX, tileY]) => Object.freeze({ tileX, tileY })));
export const APPROACH_FILES = Object.freeze({
    // Along the Archive's front steps, west from its south-east corner.
    archive: approachFile([7, 19], [6, 19], [5, 19], [4, 19]),
    // Up the lane between Command's east wing and the Observatory terrace.
    command: approachFile([20, 18], [19, 18], [19, 17], [19, 16]),
    // Up the Forge's cinder yard, parallel to its west wall.
    forge: approachFile([23, 30], [23, 29], [23, 28], [23, 27]),
    // West along the Task Board's front, then up beside the gate avenue.
    taskboard: approachFile([21, 36], [20, 36], [20, 35], [20, 34], [20, 33]),
    // West from the Mine's mouth along its yard, beside the production row.
    mine: approachFile([10, 35], [9, 35], [8, 35], [7, 35]),
    // Up the Portal's east flank, then across its lawn.
    portal: approachFile([7, 33], [7, 32], [7, 31], [8, 30], [9, 29]),
    // Up the lawn east of the Observatory's door, turning short of the tower.
    observatory: approachFile([26, 16], [26, 15], [26, 14], [25, 14]),
    // North-west from the Lighthouse, between the tower and the dome.
    watchtower: approachFile([26, 12], [25, 12], [24, 12], [24, 11]),
    // Up the Harbor's quay front, along its west wall.
    harbor: approachFile([27, 19], [27, 18], [27, 17], [27, 16]),
});
