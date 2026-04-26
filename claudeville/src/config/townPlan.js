// Authored town structure for the isometric village.
// Building positions remain in buildings.js; this file owns the readable
// settlement shape: district masses and the roads that connect them.

export const TOWN_DISTRICTS = Object.freeze([
    { id: 'civic', label: 'City Center', center: [21, 20], radius: 7 },
    { id: 'knowledge', label: 'Scholars Ridge', center: [21, 13], radius: 7 },
    { id: 'workshop', label: 'Forge Row', center: [29, 25], radius: 5 },
    { id: 'resource', label: 'Mine Yard', center: [20, 25], radius: 4 },
    { id: 'arcane', label: 'Portal Periphery', center: [16, 23], radius: 4 },
    { id: 'harbor', label: 'Harbor Quay', center: [36, 20], radius: 6 },
]);

export const TOWN_ROAD_ROUTES = Object.freeze([
    {
        id: 'city-center-spine',
        material: 'avenue',
        width: 2,
        points: [[18, 19], [21, 19], [24, 19], [27, 18], [29, 17], [28, 24]],
    },
    {
        id: 'city-center-south-bridge',
        material: 'avenue',
        width: 2,
        points: [[21, 19], [22, 20], [23, 21], [25, 22]],
    },
    {
        id: 'west-civic-bridge',
        material: 'avenue',
        width: 1,
        points: [[16, 20], [17, 21], [19, 23], [22, 24]],
    },
    {
        id: 'archive-stair',
        material: 'avenue',
        width: 1,
        points: [[23, 19], [25, 17], [27, 17]],
    },
    {
        id: 'observatory-road',
        material: 'dirt',
        width: 1,
        points: [[18, 19], [17, 16], [17, 15]],
    },
    {
        id: 'harbor-quay',
        material: 'dock',
        width: 2,
        points: [[30, 19], [33, 19], [36, 19], [39, 19]],
    },
    {
        id: 'harbor-berths',
        material: 'dock',
        width: 1,
        points: [[37, 14], [37, 19], [39, 19], [39, 22]],
    },
    {
        id: 'portal-road',
        material: 'dirt',
        width: 1,
        points: [[17, 21], [18, 23]],
    },
    {
        id: 'mine-road',
        material: 'dirt',
        width: 1,
        points: [[19, 23], [20, 23]],
    },
    {
        id: 'forge-road',
        material: 'dirt',
        width: 1,
        points: [[25, 24], [27, 24]],
    },
]);
