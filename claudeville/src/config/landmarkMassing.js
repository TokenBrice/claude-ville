// SD-1 (the Sundial) — landmark massing.
//
// The few solids that stand for each landmark wherever something has to know
// its shape from above: today the shade field (character-mode/ShadeField.js),
// which sweeps them along the sun to lay building-shaped shadows on the
// ground. They are fitted to the landmark's `base.png` with
// `node scripts/sprites/massing.mjs` (`--preview <dir>` draws them over the
// sprite, `--check` fails a fitted landmark whose solids leave its
// silhouette), and that check runs in the unit suite.
//
// Units. Plan coordinates are tiles from the landmark's BUILDING_DEFS
// footprint origin (0, 0 is its back corner, `width`, `height` its front
// corner; +x runs down-right on screen, +y down-left). Heights are world px
// above the ground (= sprite px at scale 1). Every solid stands on the ground
// and is convex:
//
//   box       { at: [x0, y0, x1, y1], top }
//   gable     { at, eave, ridge, axis }            ridge along tile `axis` ('x' | 'y')
//   hip       { at, eave, ridge, axis, inset? }    a gable drawn in at both ends
//   pyramid   { at, eave, apex }
//   cylinder  { centre: [x, y], radius, top }
//   cone      { centre, radius, eave, apex }
//   dome      { centre, radius, eave, apex }
//
// A roof solid (gable, hip, pyramid, cone, dome) reaches down to the ground
// like the rest: it is the column under its roof, so it needs no wall box
// beneath it. `name` labels a solid in the preview. `base` (world px) on any
// solid lifts its underside off the ground: a board on posts, whose shadow
// then lies beyond the posts' line with the light passing under it.
//
// `fitted: true` promises the validator passes (an entry may loosen one of
// its limits with `limits: { cover: 0.85 }` and a comment naming what its
// solids leave out on purpose). A landmark that is not fitted yet keeps a
// coarse mass (a plain shadow at its foot) or no mass at all where a box
// would throw a plainly wrong shadow (an arch, a rock, a board on posts);
// either way it still stands on its structure-contact stamp.

export const LANDMARK_MASSING = Object.freeze({
    command: Object.freeze({
        fitted: true,
        solids: Object.freeze([
            { kind: 'box', name: 'keep', at: [1.58, 1.73, 3.8, 4], top: 87 },
            { kind: 'dome', name: 'dome', centre: [2.79, 3.05], radius: 1.105, eave: 116, apex: 159 },
            { kind: 'cone', name: 'lantern', centre: [2.79, 3.05], radius: 0.2, eave: 165, apex: 185 },
            { kind: 'pyramid', name: 'spire', at: [0.27, 3.49, 0.89, 4.11], eave: 104, apex: 135 },
            { kind: 'box', name: 'west range', at: [0.89, 2.2, 1.58, 4], top: 73 },
            { kind: 'cylinder', name: 'round tower', centre: [3.67, 1.48], radius: 0.475, top: 113 },
            { kind: 'hip', name: 'east wing', at: [3.875, 0.47, 5, 3.9], eave: 58, ridge: 72, axis: 'y', inset: 0.37 },
            { kind: 'box', name: 'steps', at: [2.05, 4, 3.2, 4.8], top: 6 },
        ]),
    }),
    tavern: Object.freeze({
        fitted: true,
        solids: Object.freeze([
            { kind: 'gable', name: 'house', at: [-0.66, -0.3, 3.9, 2.54], eave: 97, ridge: 155, axis: 'x' },
            { kind: 'box', name: 'chimney', at: [2.34, 0.5, 2.74, 0.9], top: 167 },
            { kind: 'box', name: 'veranda', at: [-0.2, 2.54, 3.95, 3.92], top: 63 },
        ]),
    }),
    // The church: nave, aisle, the tower under its spire, the porch steps.
    archive: Object.freeze({
        fitted: true,
        solids: Object.freeze([
            { kind: 'gable', name: 'nave', at: [0.363, 0.2, 5.038, 2.345], eave: 73, ridge: 135, axis: 'x' },
            // The lean-to aisle: a gable whose ridge hides inside the nave.
            { kind: 'gable', name: 'aisle', at: [0.95, 1.5, 4.55, 2.725], eave: 50, ridge: 75, axis: 'x' },
            { kind: 'pyramid', name: 'tower', at: [0.28, 2.475, 1, 3.233], eave: 125, apex: 171 },
            { kind: 'box', name: 'steps', at: [4.8, 0.65, 5.113, 1.875], top: 8 },
        ]),
    }),
    forge: Object.freeze({
        fitted: true,
        solids: Object.freeze([
            { kind: 'gable', name: 'house', at: [0.08, 0.065, 3.705, 3.153], eave: 54.5, ridge: 133.5, axis: 'y' },
            { kind: 'box', name: 'chimney', at: [3.113, 0.805, 3.875, 1.81], top: 167.5 },
            { kind: 'box', name: 'trough', at: [0.84, 3.13, 1.34, 3.91], top: 18 },
            { kind: 'box', name: 'anvil', at: [2.85, 3.2, 3.44, 3.81], top: 24 },
        ]),
    }),
    // The Lighthouse: the tower on its plinth, the lantern under its cap, the
    // keeper's cottage.
    watchtower: Object.freeze({
        fitted: true,
        solids: Object.freeze([
            { kind: 'cylinder', name: 'plinth', centre: [1.36, 1.75], radius: 0.94, top: 18 },
            // The shaft stands as wide as the gallery it carries.
            { kind: 'cylinder', name: 'shaft and gallery', centre: [1.39, 1.78], radius: 0.84, top: 202 },
            { kind: 'cone', name: 'lantern', centre: [1.39, 1.78], radius: 0.53, eave: 230, apex: 264 },
            { kind: 'gable', name: 'cottage', at: [0.592, 2.2, 1.956, 3.787], eave: 43, ridge: 74, axis: 'y' },
            { kind: 'box', name: 'chimney', at: [0.723, 2.778, 0.95, 3.05], top: 76 },
            { kind: 'box', name: 'steps', at: [1.14, 3.78, 1.575, 4.165], top: 12 },
        ]),
    }),
    // The board and its roof cap as one thin slab between the posts. A
    // grounded solid cannot leave the 40-odd px gap under the board open, so
    // its shadow starts at the posts' line and the gap counts as overhang and
    // base error; the lanterns are left out.
    taskboard: Object.freeze({
        fitted: true,
        // The lanterns and banners hang off the posts, and the posts' feet
        // taper to a point where a box stands square.
        limits: { cover: 0.9, baseP75: 9 },
        solids: Object.freeze([
            // The board hangs between its posts: the light passes under it.
            { kind: 'gable', name: 'board', at: [-0.35, 0.9, 3.55, 1.55], eave: 152.5, ridge: 162.5, axis: 'x', base: 50 },
            // The posts' flared feet stand a little proud of the board's line.
            { kind: 'box', name: 'west post', at: [-0.2, 1, 0.25, 1.7], top: 60 },
            { kind: 'box', name: 'east post', at: [3, 0.585, 3.455, 1.385], top: 60 },
        ]),
    }),
    // The rock outcrop as a cone and two domes. The headframe timbers (up to
    // 60 px above the rock) and the crystals are left out, so the skyline
    // limits are loosened; outside the headframe's columns it holds 4.8 / 11.
    mine: Object.freeze({
        fitted: true,
        limits: { skylineMean: 10, skylineP90: 30 },
        solids: Object.freeze([
            { kind: 'cone', name: 'crag', centre: [1.823, 0.84], radius: 1.525, eave: 106, apex: 185.25 },
            { kind: 'dome', name: 'west shoulder', centre: [0.852, 1.568], radius: 1.25, eave: 0, apex: 126.75 },
            { kind: 'dome', name: 'east flank', centre: [2.233, 0.095], radius: 0.975, eave: 0, apex: 116.5 },
        ]),
    }),
    // The dais, its steps, the two spired pylons and the arch's jambs. The arch
    // ring and the vortex are left open on purpose (a slab would throw a wall's
    // shadow), so cover and skyline are loosened; outside the arch's columns
    // the skyline holds 2.8 / 4.
    portal: Object.freeze({
        fitted: true,
        limits: { cover: 0.8, skylineMean: 29, skylineP90: 92 },
        solids: Object.freeze([
            { kind: 'box', name: 'dais', at: [-0.125, 0.263, 4.087, 3.625], top: 23 },
            { kind: 'box', name: 'steps', at: [1.537, 3.4, 2.825, 4.05], top: 16 },
            { kind: 'pyramid', name: 'west pylon', at: [-0.1, 1.78, 0.32, 2.2], eave: 115, apex: 166.5 },
            { kind: 'pyramid', name: 'east pylon', at: [3.57, 1.54, 3.99, 1.96], eave: 119.5, apex: 166.5 },
            { kind: 'box', name: 'west jamb', at: [0.32, 1.8, 0.8, 2.2], top: 120.5 },
            { kind: 'box', name: 'east jamb', at: [3.1, 1.55, 3.57, 1.95], top: 130.5 },
        ]),
    }),
    // Rebuilt Tavern-scale Harbor Master house, clock turret, stone chimney,
    // limestone quay and three timber piers. The thin 2-px static dock rope
    // strung 60 px above the north pier between its two bunting masts (plus
    // the crane jib and lantern post) is left out on purpose so it never casts
    // a solid wall shadow; outside the rope's columns skyline holds 3.3 / 7.
    harbor: Object.freeze({
        fitted: true,
        limits: { skylineMean: 16, skylineP90: 55 },
        solids: Object.freeze([
            { kind: 'gable', name: 'house', at: [0.76, 0.74, 2.981, 3.55], eave: 129.975, ridge: 141, axis: 'y' },
            { kind: 'pyramid', name: 'clock turret', at: [2.3, -0.26, 2.822, 0.7], eave: 118.525, apex: 153.5 },
            { kind: 'box', name: 'chimney', at: [1.467, 0.635, 1.583, 0.75], top: 133.5 },
            // The quay deck and the three pier decks: low aprons (posts, crane,
            // lantern, masts and dock rope are skipped).
            { kind: 'box', name: 'quay', at: [0.778, -0.38, 2.93, 4.4], top: 16 },
            { kind: 'box', name: 'north pier', at: [2.8, -1.075, 6.757, -0.52], top: 12 },
            { kind: 'box', name: 'middle pier', at: [2.9, 1.188, 6.675, 1.783], top: 12 },
            { kind: 'box', name: 'south pier', at: [2.875, 3.463, 6.26, 4.04], top: 12 },
        ]),
    }),
});

// Standing props with a mass of their own, by sprite id: the same solids, in
// tiles from the prop's foot (its sprite anchor: 0, 0) and world px of
// height. A prop listed here casts from these instead of from its own
// silhouette (the windmill's cached image carries its turning sails) and is
// checked by the same validator (`--ids=prop.windmill`).
export const PROP_MASSING = Object.freeze({
    // The tower tapers: stacked drums, the widest lowest, under its cap.
    'prop.windmill': Object.freeze({
        fitted: true,
        solids: Object.freeze([
            { kind: 'cylinder', name: 'foot', centre: [-0.09, -0.09], radius: 0.74, top: 14 },
            { kind: 'cylinder', name: 'drum 2', centre: [-0.09, -0.09], radius: 0.7, top: 34 },
            { kind: 'cylinder', name: 'drum 3', centre: [-0.09, -0.09], radius: 0.66, top: 54 },
            { kind: 'cylinder', name: 'drum 4', centre: [-0.09, -0.09], radius: 0.62, top: 74 },
            { kind: 'cylinder', name: 'drum 5', centre: [-0.09, -0.09], radius: 0.59, top: 98 },
            { kind: 'cylinder', name: 'eave', centre: [-0.09, -0.09], radius: 0.674, top: 101 },
            { kind: 'cone', name: 'cap', centre: [-0.09, -0.09], radius: 0.52, eave: 101, apex: 152 },
        ]),
    }),
});
