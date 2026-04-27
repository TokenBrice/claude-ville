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

export const TOWN_ROAD_ROUTES = Object.freeze([
    {
        id: 'north-bank-promenade',
        material: 'avenue',
        width: 1,
        points: [[7, 23], [16, 20], [23, 17], [28, 16], [29, 13]],
    },
    {
        id: 'production-row',
        material: 'dirt',
        width: 1,
        points: [[9, 33], [13, 34], [22, 33], [25, 29]],
    },
    {
        id: 'portal-mine-bridge',
        material: 'avenue',
        width: 1,
        points: [[7, 23], [10, 25], [9, 28], [9, 33]],
    },
    {
        id: 'command-task-bridge',
        material: 'avenue',
        width: 1,
        points: [[16, 20], [17, 25], [22, 31], [22, 33]],
    },
    {
        id: 'archive-walk',
        material: 'avenue',
        width: 1,
        points: [[23, 17], [23, 16]],
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
