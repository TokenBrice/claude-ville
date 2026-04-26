// Authored town structure for the isometric village.
// Building positions remain in buildings.js; this file owns the readable
// settlement shape: district masses and the roads that connect them.

export const TOWN_DISTRICTS = Object.freeze([
    { id: 'civic', label: 'City Center', center: [20, 22], radius: 6 },
    { id: 'knowledge', label: 'Scholars Ridge', center: [18, 18], radius: 10 },
    { id: 'workshop', label: 'Forge Row', center: [31, 29], radius: 5 },
    { id: 'resource', label: 'Mine Yard', center: [18, 33], radius: 4 },
    { id: 'arcane', label: 'Portal Periphery', center: [10, 31], radius: 5 },
    { id: 'harbor', label: 'Harbor Quay', center: [35, 17], radius: 9 },
]);

export const TOWN_ROAD_ROUTES = Object.freeze([
    {
        id: 'north-bank-promenade',
        material: 'avenue',
        width: 1,
        points: [[12, 21], [20, 22], [27, 20], [31, 16], [33, 13]],
    },
    {
        id: 'production-row',
        material: 'dirt',
        width: 1,
        points: [[12, 33], [18, 34], [26, 32], [30, 30]],
    },
    {
        id: 'portal-mine-bridge',
        material: 'avenue',
        width: 1,
        points: [[12, 21], [14, 25], [12, 28], [12, 33]],
    },
    {
        id: 'command-task-bridge',
        material: 'avenue',
        width: 1,
        points: [[21, 22], [22, 25], [26, 30], [26, 32]],
    },
    {
        id: 'archive-walk',
        material: 'avenue',
        width: 1,
        points: [[27, 20], [27, 19]],
    },
    {
        id: 'lighthouse-quay',
        material: 'dock',
        width: 1,
        points: [[33, 19], [33, 16], [33, 13]],
    },
    {
        id: 'harbor-berths',
        material: 'dock',
        width: 1,
        points: [[33, 21], [35, 22], [37, 21], [39, 21], [39, 18], [38, 17]],
    },
]);
