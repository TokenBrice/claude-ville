export const BUILDING_GROUNDING_MODES = Object.freeze([
    'terrain-apron',
    'intentional-dais',
    'quay',
    'water-pilings',
]);

export const BUILDING_GROUNDING_MATERIALS = Object.freeze([
    'civic-cobble',
    'knowledge-terrace',
    'workshop-yard',
    'mine-yard',
    'arcane-court',
    'harbor-quay',
    'tidal-water',
]);

export const BUILDING_GROUNDING_EDGE_TREATMENTS = Object.freeze([
    'broken',
    'retained',
    'water-contact',
]);

export const BUILDING_GROUNDING_SHADOWS = Object.freeze([
    'structure-contact',
    'tower-cast',
    'none',
]);

// E1 (W1.2) — bake-owned landmark footings. A profile's optional `footing`
// is painted by the ground bake (GroundBake `drawFootings`) as a vertical
// face directly under the sprite's front edges, never above them: so it is
// always in front of the building and never on a walkable tile behind it,
// and it is at most FOOTING_MAX_ROWS rows tall (no free-standing posts or
// rails: those would mis-sort with walkers).
//   kind     'dais' (coursed ashlar platform), 'terrace' (a low riser with
//            relief balustrade) or 'rock' (a cliff-strata headland plinth).
//   edges    which front-edge points it runs along, in order: 'left' →
//            'bottom' is the SW face (it takes the key), 'bottom' → 'right'
//            the SE face (shade). Dais and terrace read the `plinth` points
//            (or GroundBake's painted-plinth fallback); rock reads the drawn
//            base corners of the footprint.
//   ramp     the shared ramp its rows index (`ashlar`; rock: `cliff`, with
//            `tideline` for the wet foot).
//   rows     top → bottom: `sw` / `se` ramp stops, `joint` (a vertical joint
//            every that many px, one stop darker, the texel right of it one
//            lighter on the SW face), `relief` (every that many px one stop
//            darker: a balustrade carved in the riser).
//   stair    a centred flight cut into the dais at the projection of tile
//            `at` onto the SW face: `steps` treads (`tread` stop) each over a
//            riser row (`riser` stop), `width + grow · i` px wide.
//   aoShiftRows  the contact AO's plinth front edges move down this many
//            rows, so the ground's contact shadow starts at the footing's foot.
//   rock: `maxRun` (rows from the base edge to the waterline that still
//            take a headland), `spread` (px past the corners), `tide` (wet
//            foot rows), `fracture` (px per fracture cell on the SW / SE face).
export const FOOTING_MAX_ROWS = 10;
export const BUILDING_FOOTING_KINDS = Object.freeze(['dais', 'terrace', 'rock']);

const ASHLAR_DAIS_ROWS = Object.freeze([
    Object.freeze({ role: 'coping', sw: 7, se: 6 }),
    Object.freeze({ role: 'course', sw: 5, se: 3, joint: 13 }),
    Object.freeze({ role: 'course', sw: 5, se: 3, joint: 13 }),
    Object.freeze({ role: 'course', sw: 5, se: 3, joint: 13 }),
    Object.freeze({ role: 'bed', sw: 2, se: 2 }),
    Object.freeze({ role: 'course', sw: 4, se: 2, joint: 17 }),
    Object.freeze({ role: 'course', sw: 4, se: 2, joint: 17 }),
]);

const ASHLAR_TERRACE_ROWS = Object.freeze([
    Object.freeze({ role: 'coping', sw: 8, se: 7 }),
    Object.freeze({ role: 'balustrade', sw: 5, se: 4, relief: 3 }),
    Object.freeze({ role: 'course', sw: 5, se: 4 }),
    Object.freeze({ role: 'foot', sw: 3, se: 2 }),
]);

// The headland's strata, top → bottom (cliff ramp stops); the last `tide`
// rows of every column are the wet tideline foot instead.
const CLIFF_HEADLAND_ROWS = Object.freeze([
    Object.freeze({ role: 'highlight', sw: 5, se: 4 }),
    Object.freeze({ role: 'upper', sw: 3, se: 2 }),
    Object.freeze({ role: 'lit', sw: 4, se: 3 }),
    Object.freeze({ role: 'joint', sw: 1, se: 0 }),
    Object.freeze({ role: 'bed', sw: 2, se: 1 }),
    Object.freeze({ role: 'lowLit', sw: 3, se: 2 }),
    Object.freeze({ role: 'lower', sw: 2, se: 1 }),
]);

// World-pixel contact geometry is measured at zoom 1. Foundations are baked
// into the static terrain cache; shadow/contact shapes are the only per-frame
// physical grounding marks. Optional, read by GroundBake's contact AO:
// `plinth` (EN-3) is the artist's visual base, the left, bottom (front
// corner) and right points of the 2:1 front edges where the art meets the
// ground, in sprite px of base.png (the same anchors
// scripts/sprites/bake-surface-channel.mjs bakes the surface channel on); the
// contact AO's front edges run along them (Command, Tavern, Forge; the
// others keep the logical footprint). `shelter` (EY-3, default 1) is the
// share of the snow and rain the eaves keep off, low for an open frame.
export const BUILDING_GROUNDING_PROFILES = Object.freeze({
    command: Object.freeze({
        mode: 'terrain-apron',
        material: 'civic-cobble',
        edgeTreatment: 'broken',
        shadow: 'structure-contact',
        foundation: Object.freeze({ enabled: false, owner: 'sprite-reference', opacity: 0 }),
        contact: Object.freeze({ offsetX: 0, offsetY: -9, width: 190, depth: 34, opacity: 0.78 }),
        // EN-3 — the painted plinth's front edges (sprite px of base.png).
        plinth: Object.freeze({ left: Object.freeze([58, 171]), bottom: Object.freeze([213, 238]), right: Object.freeze([343, 174]) }),
        // E1 — a 7-row two-course ashlar dais with a 5-step stair at the gate.
        footing: Object.freeze({
            kind: 'dais',
            edges: Object.freeze(['left', 'bottom', 'right']),
            ramp: 'ashlar',
            rows: ASHLAR_DAIS_ROWS,
            stair: Object.freeze({ at: Object.freeze([15.5, 18.0]), width: 30, steps: 5, grow: 2, tread: 8, riser: 5 }),
            aoShiftRows: 7,
        }),
    }),
    taskboard: Object.freeze({
        mode: 'terrain-apron',
        material: 'civic-cobble',
        edgeTreatment: 'broken',
        shadow: 'structure-contact',
        foundation: Object.freeze({ enabled: true, owner: 'terrain-cache', opacity: 0.54, density: 0.44, thresholdReach: 0.58 }),
        contact: Object.freeze({ offsetX: 0, offsetY: -4, width: 148, depth: 20, opacity: 0.62 }),
        // EY-3 — an open frame under a narrow roof: its contact AO keeps this
        // share of the snow off the ground (omitted = 1, a solid building).
        shelter: 0.15,
    }),
    forge: Object.freeze({
        mode: 'terrain-apron',
        material: 'workshop-yard',
        edgeTreatment: 'broken',
        shadow: 'structure-contact',
        foundation: Object.freeze({ enabled: true, owner: 'terrain-cache', opacity: 0.5, density: 0.5, thresholdReach: 0.56 }),
        contact: Object.freeze({ offsetX: -8, offsetY: -7, width: 152, depth: 32, opacity: 0.76 }),
        // EN-3 — the painted plinth's front edges (sprite px of base.png).
        plinth: Object.freeze({ left: Object.freeze([24, 166]), bottom: Object.freeze([137, 222]), right: Object.freeze([224, 183]) }),
    }),
    mine: Object.freeze({
        mode: 'terrain-apron',
        material: 'mine-yard',
        edgeTreatment: 'broken',
        shadow: 'structure-contact',
        foundation: Object.freeze({ enabled: true, owner: 'terrain-cache', opacity: 0.56, density: 0.58, thresholdReach: 0.68 }),
        contact: Object.freeze({ offsetX: -8, offsetY: -5, width: 172, depth: 38, opacity: 0.82 }),
    }),
    archive: Object.freeze({
        mode: 'terrain-apron',
        material: 'knowledge-terrace',
        edgeTreatment: 'broken',
        shadow: 'structure-contact',
        foundation: Object.freeze({ enabled: true, owner: 'terrain-cache', opacity: 0.52, density: 0.52, thresholdReach: 0.66 }),
        contact: Object.freeze({ offsetX: 0, offsetY: -7, width: 218, depth: 38, opacity: 0.8 }),
        // E1 — a 4-row terrace riser along the SW face (toward the river
        // basin), its balustrade carved in relief only.
        footing: Object.freeze({
            kind: 'terrace',
            edges: Object.freeze(['left', 'bottom']),
            ramp: 'ashlar',
            rows: ASHLAR_TERRACE_ROWS,
            stair: null,
            aoShiftRows: 4,
        }),
    }),
    tavern: Object.freeze({
        mode: 'terrain-apron',
        material: 'knowledge-terrace',
        edgeTreatment: 'broken',
        shadow: 'tower-cast',
        foundation: Object.freeze({ enabled: true, owner: 'terrain-cache', opacity: 0.48, density: 0.48, thresholdReach: 0.62 }),
        contact: Object.freeze({ offsetX: -8, offsetY: -7, width: 108, depth: 28, opacity: 0.76, castLength: 52 }),
        // EN-3 — the painted plinth's front edges (sprite px of base.png).
        plinth: Object.freeze({ left: Object.freeze([30, 218]), bottom: Object.freeze([158, 282]), right: Object.freeze([286, 218]) }),
    }),
    portal: Object.freeze({
        mode: 'intentional-dais',
        material: 'arcane-court',
        edgeTreatment: 'retained',
        shadow: 'structure-contact',
        foundation: Object.freeze({ enabled: true, owner: 'terrain-cache', opacity: 0.3, density: 0.3, thresholdReach: 0.42 }),
        contact: Object.freeze({ offsetX: 0, offsetY: -2, width: 150, depth: 32, opacity: 0.72 }),
    }),
    watchtower: Object.freeze({
        mode: 'quay',
        material: 'harbor-quay',
        edgeTreatment: 'water-contact',
        shadow: 'tower-cast',
        foundation: Object.freeze({ enabled: false, owner: 'structural-sprite', opacity: 0 }),
        contact: Object.freeze({ offsetX: 0, offsetY: -4, width: 74, depth: 20, opacity: 0.76, castLength: 86 }),
        // E1 — a cliff-strata headland under the tower's front edges where
        // the shore runs down to the water: the beach there becomes rock.
        footing: Object.freeze({
            kind: 'rock',
            edges: Object.freeze(['left', 'bottom', 'right']),
            ramp: 'cliff',
            rows: CLIFF_HEADLAND_ROWS,
            stair: null,
            aoShiftRows: 0,
            maxRun: 64,
            spread: 8,
            tide: 3,
            fracture: Object.freeze([13, 8]),
        }),
    }),
    // 5.A — the coursed stone quay meets the island shore at its west face;
    // the piers stand on pilings in the basin. The quay's water contact is in
    // the art, so the bake adds no foundation and no contact shadow.
    harbor: Object.freeze({
        mode: 'quay',
        material: 'harbor-quay',
        edgeTreatment: 'water-contact',
        shadow: 'none',
        foundation: Object.freeze({ enabled: false, owner: 'structural-sprite', opacity: 0 }),
        contact: Object.freeze({ offsetX: 0, offsetY: 0, width: 0, depth: 0, opacity: 0 }),
    }),
});

// The tallest column a footing paints (rows): its row table, its stair (a
// tread and a riser row per step) or, for a rock headland, the cap. (A
// const, like every export here: scripts/world/config-loader.mjs reads
// this file as plain `export const` declarations.)
export const footingHeight = (footing) => {
    if (!footing) return 0;
    if (footing.kind === 'rock') return FOOTING_MAX_ROWS;
    return Math.max(footing.rows.length, footing.stair ? footing.stair.steps * 2 : 0);
};
