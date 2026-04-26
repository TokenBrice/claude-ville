// Authored town structure for the isometric village.
// Building positions remain in buildings.js; this file owns the readable
// settlement shape: district masses and the roads that connect them.

export const TOWN_DISTRICTS = Object.freeze([
    { id: 'civic', label: 'City Center', center: [20, 23], radius: 7 },
    { id: 'knowledge', label: 'Scholars Ridge', center: [20, 17], radius: 7 },
    { id: 'workshop', label: 'Forge Row', center: [29, 28], radius: 5 },
    { id: 'resource', label: 'Mine Yard', center: [20, 28], radius: 4 },
    { id: 'arcane', label: 'Portal Periphery', center: [16, 26], radius: 4 },
    { id: 'harbor', label: 'Harbor Quay', center: [36, 20], radius: 7 },
]);

export const TOWN_ROAD_ROUTES = Object.freeze([
    {
        id: 'city-center-spine',
        material: 'avenue',
        width: 2,
        points: [[18, 22], [21, 22], [24, 22], [27, 21], [29, 20], [28, 27]],
    },
    {
        id: 'city-center-south-bridge',
        material: 'avenue',
        width: 2,
        points: [[21, 22], [22, 23], [23, 24], [25, 25]],
    },
    {
        id: 'west-civic-bridge',
        material: 'avenue',
        width: 1,
        points: [[16, 23], [17, 24], [19, 26], [22, 27]],
    },
    {
        id: 'archive-stair',
        material: 'avenue',
        width: 1,
        points: [[23, 22], [25, 20], [27, 20]],
    },
    {
        id: 'observatory-road',
        material: 'dirt',
        width: 1,
        points: [[18, 22], [17, 19], [17, 18]],
    },
    {
        id: 'harbor-quay',
        material: 'dock',
        width: 2,
        points: [[29, 20], [33, 20], [36, 19], [39, 19]],
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
        points: [[17, 24], [18, 26]],
    },
    {
        id: 'mine-road',
        material: 'dirt',
        width: 1,
        points: [[19, 26], [20, 26]],
    },
    {
        id: 'forge-road',
        material: 'dirt',
        width: 1,
        points: [[25, 27], [27, 27]],
    },
]);
