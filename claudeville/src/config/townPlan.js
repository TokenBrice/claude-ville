// Authored town structure for the isometric village.
// Building positions remain in buildings.js; this file owns the readable
// settlement shape: district masses and the roads that connect them.

export const VILLAGE_GATE = Object.freeze({
    id: 'prop.villageGate',
    tileX: 19.0,
    tileY: 39.1,
    widthTiles: 9.0,
    outside: { tileX: 18.4, tileY: 39.25 },
    inside: { tileX: 20.5, tileY: 37.85 },
});

export const VILLAGE_GATE_BOUNDS = Object.freeze({
    left: -236,
    right: 236,
    top: -180,
    bottom: 96,
});

// Center of Portal Gate footprint (origin 2,29 size 4x4). Subagents spawn here
// so dispatch reads as "child stepped through the portal" rather than the
// generic Village Gate arrival used by top-level sessions.
export const PORTAL_SPAWN_TILE = Object.freeze({ tileX: 4, tileY: 32 });

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
// greens, the Harbor pier kerb, and stone (a step against Command's wings, the
// fountain's rim) that is drawn only under a sitter. Seats on building visit
// points (Command wings, the pier) never count as visitors (V8). None sits on
// the Command approach (7.2) or behind a wall the camera cannot see past.
export const REST_SEATS = Object.freeze([
    { id: 'command-east-step-n', tileX: 18, tileY: 18, facing: 'south-east', occluder: 'step' },
    { id: 'command-east-step-s', tileX: 18, tileY: 19, facing: 'south-east', occluder: 'step' },
    { id: 'command-west-step', tileX: 12, tileY: 19, facing: 'south-west', occluder: 'step' },
    { id: 'taskboard-green', tileX: 24, tileY: 28, facing: 'south-west', occluder: 'bench' },
    { id: 'fountain-rim', tileX: 14, tileY: 21, facing: 'south-west', occluder: 'well' },
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
// between slots). The 13th petitioner onward stands on the plaza west of the
// fountain (`overflow`). No slot stands on a fixture's footprint
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
