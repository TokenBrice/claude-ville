// Authored town structure for the isometric village.
// Building positions remain in buildings.js; this file owns the readable
// settlement shape: district masses and the roads that connect them.

export const TOWN_DISTRICTS = Object.freeze([
    { id: 'civic', label: 'Civic Plaza', center: [20, 21], radius: 6 },
    { id: 'knowledge', label: 'Scholars Quarter', center: [10, 15], radius: 6 },
    { id: 'workshop', label: 'Forge Row', center: [29, 21], radius: 5 },
    { id: 'resource', label: 'Mine Yard', center: [9, 28], radius: 5 },
    { id: 'arcane', label: 'Rune Gate', center: [28, 29], radius: 6 },
    { id: 'harbor', label: 'Harbor Quay', center: [34, 18], radius: 5 },
    { id: 'quiet', label: 'Sanctuary Grove', center: [9, 8], radius: 5 },
]);

export const TOWN_ROAD_ROUTES = Object.freeze([
    {
        id: 'civic-spine',
        material: 'avenue',
        width: 2,
        points: [[20, 22], [20, 21], [23, 21], [23, 19]],
    },
    {
        id: 'civic-ring-west',
        material: 'avenue',
        width: 2,
        points: [[20, 23], [18, 23], [13, 23], [10, 21]],
    },
    {
        id: 'scholar-road',
        material: 'dirt',
        width: 1,
        points: [[10, 21], [10, 17], [12, 15], [14, 15]],
    },
    {
        id: 'sanctuary-path',
        material: 'dirt',
        width: 1,
        points: [[14, 15], [11, 14], [10, 11], [10, 9]],
    },
    {
        id: 'workshop-causeway',
        material: 'avenue',
        width: 2,
        points: [[22, 22], [26, 22], [29, 23], [30, 23]],
    },
    {
        id: 'harbor-quay',
        material: 'dock',
        width: 2,
        points: [[30, 18], [33, 19], [34, 19], [36, 19]],
    },
    {
        id: 'mine-road',
        material: 'dirt',
        width: 1,
        points: [[17, 23], [15, 25], [12, 30], [10, 30]],
    },
    {
        id: 'arcane-road',
        material: 'dirt',
        width: 1,
        points: [[22, 26], [24, 28], [26, 29], [27, 31], [29, 31]],
    },
]);
