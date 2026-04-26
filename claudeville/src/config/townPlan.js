// Authored town structure for the isometric village.
// Building positions remain in buildings.js; this file owns the readable
// settlement shape: district masses and the roads that connect them.

export const TOWN_DISTRICTS = Object.freeze([
    { id: 'civic', label: 'City Center', center: [20, 20], radius: 7 },
    { id: 'knowledge', label: 'Upper Periphery', center: [12, 10], radius: 6 },
    { id: 'workshop', label: 'Forge Row', center: [30, 26], radius: 5 },
    { id: 'resource', label: 'Mine Yard', center: [7, 31], radius: 5 },
    { id: 'arcane', label: 'Portal Periphery', center: [10, 27], radius: 6 },
    { id: 'harbor', label: 'Harbor Quay', center: [36, 19], radius: 5 },
]);

export const TOWN_ROAD_ROUTES = Object.freeze([
    {
        id: 'city-center-spine',
        material: 'avenue',
        width: 2,
        points: [[17, 19], [20, 19], [23, 19], [25, 20], [25, 25]],
    },
    {
        id: 'city-center-south-bridge',
        material: 'avenue',
        width: 2,
        points: [[20, 19], [21, 21], [22, 21], [25, 22]],
    },
    {
        id: 'city-hall-bridge',
        material: 'avenue',
        width: 1,
        points: [[15, 19], [16, 22], [18, 23], [22, 24]],
    },
    {
        id: 'observatory-road',
        material: 'dirt',
        width: 1,
        points: [[17, 19], [15, 15], [13, 12], [11, 11]],
    },
    {
        id: 'harbor-quay',
        material: 'dock',
        width: 2,
        points: [[30, 18], [32, 19], [35, 19], [39, 19]],
    },
    {
        id: 'harbor-berths',
        material: 'dock',
        width: 1,
        points: [[37, 14], [37, 19], [39, 19], [39, 21]],
    },
    {
        id: 'portal-road',
        material: 'dirt',
        width: 1,
        points: [[16, 22], [13, 24], [10, 26]],
    },
    {
        id: 'mine-road',
        material: 'dirt',
        width: 1,
        points: [[10, 26], [9, 29], [7, 30]],
    },
    {
        id: 'forge-road',
        material: 'dirt',
        width: 1,
        points: [[25, 25], [29, 26], [31, 24]],
    },
]);
