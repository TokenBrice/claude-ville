// Authored town structure for the isometric village.
// Building positions remain in buildings.js; this file owns the readable
// settlement shape: district masses and the roads that connect them.

export const TOWN_DISTRICTS = Object.freeze([
    { id: 'civic', label: 'City Center', center: [20, 22], radius: 6 },
    { id: 'knowledge', label: 'Scholars Ridge', center: [18, 18], radius: 10 },
    { id: 'workshop', label: 'Forge Row', center: [31, 29], radius: 5 },
    { id: 'resource', label: 'Mine Yard', center: [18, 29], radius: 4 },
    { id: 'arcane', label: 'Portal Periphery', center: [10, 28], radius: 5 },
    { id: 'harbor', label: 'Harbor Quay', center: [37, 20], radius: 7 },
]);

export const TOWN_ROAD_ROUTES = Object.freeze([
    {
        id: 'north-bank-promenade',
        material: 'avenue',
        width: 1,
        points: [[12, 21], [20, 22], [28, 18], [33, 19], [38, 19]],
    },
    {
        id: 'production-row',
        material: 'dirt',
        width: 1,
        points: [[12, 30], [18, 30], [26, 30], [30, 30]],
    },
    {
        id: 'portal-mine-bridge',
        material: 'avenue',
        width: 1,
        points: [[12, 21], [14, 25], [12, 28], [12, 30]],
    },
    {
        id: 'command-task-bridge',
        material: 'avenue',
        width: 1,
        points: [[21, 22], [22, 25], [26, 28], [26, 30]],
    },
    {
        id: 'archive-walk',
        material: 'avenue',
        width: 1,
        points: [[28, 18], [28, 17]],
    },
    {
        id: 'lighthouse-quay',
        material: 'dock',
        width: 1,
        points: [[33, 19], [36, 19], [38, 19]],
    },
    {
        id: 'harbor-berths',
        material: 'dock',
        width: 1,
        points: [[35, 21], [37, 22], [39, 21], [39, 18], [38, 17]],
    },
]);
