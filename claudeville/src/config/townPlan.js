// Authored town structure for the isometric village.
// Building positions remain in buildings.js; this file owns the readable
// settlement shape: district masses and the roads that connect them.

export const TOWN_DISTRICTS = Object.freeze([
    { id: 'civic', label: 'City Center', center: [16, 22], radius: 6 },
    { id: 'knowledge', label: 'Scholars Ridge', center: [14, 16], radius: 10 },
    { id: 'workshop', label: 'Forge Row', center: [26, 28], radius: 5 },
    { id: 'resource', label: 'Mine Yard', center: [13, 33], radius: 4 },
    { id: 'arcane', label: 'Portal Periphery', center: [7, 31], radius: 5 },
    { id: 'harbor', label: 'Harbor Quay', center: [34, 17], radius: 9 },
]);

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
    splitY: -42,
});

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

export const TOWN_ROAD_ROUTES = Object.freeze([
    {
        id: 'north-bank-promenade',
        material: 'avenue',
        width: 1,
        points: [[7, 23], [10, 20], [16, 20], [23, 18], [28, 16], [29, 13]],
    },
    {
        id: 'production-row',
        material: 'dirt',
        width: 1,
        points: [[9, 33], [13, 34], [18, 38], [24, 37], [25, 29]],
    },
    {
        id: 'west-production-road',
        material: 'avenue',
        width: 1,
        points: [[9, 33], [14, 31], [18, 27]],
    },
    {
        id: 'central-river-bridge',
        material: 'avenue',
        width: 1,
        points: [[16, 20], [18, 22], [18, 25], [18, 27], [24, 31], [24, 37]],
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
        points: [[32, 21], [34, 22], [36, 21], [38, 21], [38, 18], [37, 17]],
    },
]);
