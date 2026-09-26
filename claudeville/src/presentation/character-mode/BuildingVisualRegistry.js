import { BUILDING_GROUNDING_PROFILES } from '../../config/buildingGrounding.js';
import { normalizeMaterialMetadata } from './MaterialRegistry.js';

export const DEFAULT_BUILDING_OCCUPANCY_THRESHOLDS = Object.freeze({
    idleMax: 0,
    occupiedMax: 0.49,
    busyMax: 0.84,
});

// Pilot material profiles seed the authored semantic contract from existing
// window/light/effect anchors. Geometry stays in this registry; light records
// stay authoritative in LightSourceRegistry/BuildingSprite.
export const BUILDING_MATERIAL_REGISTRY = Object.freeze({
    command: landmarkMaterial('command', 'stone', 240, 112, [
        emissiveSource('emissive.command.windows', 'windows', 'windowRects', 0.72),
        emissiveSource('emissive.command.braziers', 'fire', 'emitters.torch', 1),
    ]),
    taskboard: landmarkMaterial('taskboard', 'timber', 232, 162, [
        emissiveSource('emissive.taskboard.lanterns', 'lantern', 'windowRects', 0.76),
    ]),
    forge: landmarkMaterial('forge', 'stone', 232, null, [
        emissiveSource('emissive.forge.furnace', 'fire', 'windowRects', 1),
    ]),
    mine: landmarkMaterial('mine', 'stone', 232, null, [
        emissiveSource('emissive.mine.cave', 'fire', 'windowRects', 0.82),
        emissiveSource('emissive.mine.crystals', 'rune', 'emitters.sparkle', 0.62),
    ]),
    archive: landmarkMaterial('archive', 'stone', 240, 130, [
        emissiveSource('emissive.archive.windows', 'windows', 'windowRects', 0.68),
        emissiveSource('emissive.archive.door-spill', 'lantern', 'lightSource', 0.74),
    ]),
    observatory: landmarkMaterial('observatory', 'stone', 288, 235, [
        emissiveSource('emissive.observatory.windows', 'windows', 'windowRects', 0.62),
        emissiveSource('emissive.observatory.dome', 'rune', 'effectAnchors.domeAperture', 0.78),
    ]),
    portal: landmarkMaterial('portal', 'glass-rune', 208, 130, [
        emissiveSource('emissive.portal.aperture', 'rune', 'windowRects', 0.78),
        emissiveSource('emissive.portal.vortex', 'rune', 'layers.portalGlow', 1),
    ]),
    watchtower: landmarkMaterial('watchtower', 'stone', 384, 300, [
        emissiveSource('emissive.watchtower.windows', 'windows', 'windowRects', 0.68),
        emissiveSource('emissive.watchtower.beacon', 'fire', 'effectAnchors.lanternFire', 1),
    ]),
    harbor: landmarkMaterial('harbor', 'timber', 232, 164, [
        emissiveSource('emissive.harbor.windows', 'windows', 'windowRects', 0.66),
        emissiveSource('emissive.harbor.lantern', 'lantern', 'lightSource', 0.82),
    ]),
});

export const BUILDING_VISUAL_REGISTRY = Object.freeze({
    command: {
        material: BUILDING_MATERIAL_REGISTRY.command,
        grounding: BUILDING_GROUNDING_PROFILES.command,
        labelAccent: '#f6c85f',
        emblem: 'crown',
        districtTint: 'rgba(246, 200, 95, 0.24)',
        pulseBand: { color: '#f6c85f', alpha: 0.28 },
        reducedMotionFallback: { pulse: 0.58, alpha: 0.9 },
        occupancyThresholds: { occupiedMax: 0.45, busyMax: 0.8 },
        labelPriority: 'landmark',
        beaconBase: 0.85,
        // 6.2 — sprite-local lit-window spots (`at` is the pane centre).
        // 4.2 — measured on the re-authored keep: the three dome-drum panes,
        // the lower left-tower pane and the hall pane beside the right tower.
        // The east wing's panes are left out: they sit inside the 4.1 cut.
        windowRects: [
            { at: [143, 103], w: 5, h: 12 },
            { at: [175, 110], w: 6, h: 11 },
            { at: [207, 103], w: 3, h: 11 },
            { at: [72, 120], w: 3, h: 6 },
            { at: [236, 121], w: 4, h: 10 },
        ],
        // #53 — sprite-local pole base for the occupancy pennant (right turret).
        pennant: { at: [254, 60] },
        // 4.2 — drawing anchors on the re-authored keep: `keep` is the dome
        // crown under the finial (activity rings, carrier-bird source),
        // `standard` the finial tip the ritual standard rises from, `hall`
        // the gate threshold (the hall-activity glow lands as a pool at the
        // foot of the steps, below the occlusion horizon, not on the door).
        effectAnchors: {
            keep: [174, 24],
            standard: [174, 4],
            hall: [122, 210],
        },
        // 4.1 — the inspection aperture. The authored sectional view swaps the
        // east wing's front wall for a cut room on explicit selection at
        // resting zoom >= `minZoom`. `cut` is the sprite-local parallelogram
        // the three layers were authored inside (rising to the right at the
        // art's own ~2:1 wall slope): it spans the wing's plain right-facing
        // wall between the corner pillar and the right pilaster, from the
        // cornice down through the upper plinth (the floor slab is the sawn
        // sill), so the room is a full storey rather than a slot. `slots` are
        // the bottom-centre anchors of the authored desks, front to back, and
        // `occupant.h` is the presented body height in sprite pixels — two
        // thirds of the room's height, so an occupant reads as a person
        // standing in a room at 2x. The exterior silhouette, footprint, door
        // anchor, hit target and pathfinding are untouched.
        aperture: {
            minZoom: 2,
            layers: ['aperture', 'interior', 'foreground'],
            cut: { x0: 228, x1: 312, top: 181, bottom: 219, slope: -0.52 },
            // The open aperture's legend: the working/waiting count and one
            // row per presented session, on the apron under the cut. Sized in
            // sprite pixels so it scales with the building, never with the
            // viewport.
            legend: { at: [228, 222], w: 84, rowH: 8 },
            occupant: { h: 24 },
            slots: [
                { at: [246, 202] },
                { at: [270, 190] },
                { at: [294, 177] },
            ],
        },
        // 4.2 — the hall's work rooms: one authored window per room, lit for
        // one real working occupant each — the three dome-drum panes. Distinct
        // from `windowRects` (the dusk warmth stamps) and from the gate
        // braziers, and deliberately outside the 4.1 cut so an open aperture
        // never argues with a lit window about the same room.
        rooms: {
            countAt: [186, 236],
            slots: [
                { at: [143, 104], w: 5, h: 9 },
                { at: [175, 110], w: 6, h: 10 },
                { at: [207, 104], w: 3, h: 9 },
            ],
        },
    },
    taskboard: {
        material: BUILDING_MATERIAL_REGISTRY.taskboard,
        grounding: BUILDING_GROUNDING_PROFILES.taskboard,
        labelAccent: '#8bd7ff',
        emblem: 'scroll',
        districtTint: 'rgba(139, 215, 255, 0.2)',
        pulseBand: { color: '#8bd7ff', alpha: 0.24 },
        reducedMotionFallback: { pulse: 0.52, alpha: 0.86 },
        occupancyThresholds: { occupiedMax: 0.5, busyMax: 0.84 },
        labelPriority: 'landmark',
        beaconBase: 0.8,
        // 6.2 — the two eave lanterns, not mid-wall blobs. 4.5 — glass
        // measured on the re-authored board (NW and SE ends of the roof beam).
        windowRects: [
            { at: [46, 55], w: 6, h: 10, shape: 'ellipse' },
            { at: [203, 125], w: 6, h: 10, shape: 'ellipse' },
        ],
        // On the roof ridge, above the middle of the slate.
        pennant: { at: [124, 33] },
        // 4.7 — plan tabs hang off the slate's left frame edge (x82 on the
        // 2:1 art, from just under the slate's top-left corner): one
        // project-coloured tab per concurrent plan owner, right edge flush to
        // the slate, stacked downward, with the exact `+N plans` beneath.
        // Screen-fixed type; hit targets, not decoration.
        planTabs: {
            at: [82, 62],
            gap: 2,
            max: 3,
        },
    },
    forge: {
        material: BUILDING_MATERIAL_REGISTRY.forge,
        grounding: BUILDING_GROUNDING_PROFILES.forge,
        labelAccent: '#f08a4b',
        emblem: 'hammer',
        districtTint: 'rgba(240, 138, 75, 0.24)',
        pulseBand: { color: '#ff9f3f', alpha: 0.3 },
        reducedMotionFallback: { pulse: 0.6, alpha: 0.88 },
        occupancyThresholds: { occupiedMax: 0.5, busyMax: 0.84 },
        labelPriority: 'landmark',
        beaconBase: 1,
        // 4.5 — the two warm panes over the tool rack (re-authored base.png).
        windowRects: [
            { at: [140, 157], w: 8, h: 21 },
            { at: [153, 152], w: 8, h: 21 },
        ],
        // 4.6 — the hearth fire is painted into base.png, so rest needs an
        // authored mask: `banked.png` restates exactly those pixels as stepped
        // charcoal over one ember course. Drawn by the building renderer on
        // canonical READY_EMPTY only, never by the generic layer pass.
        rest: { layer: 'banked' },
        // 4.4 — the workload bench. `billets` are the three stepped bars on the
        // anvil plinth (one per observed count tier), `shelf` is the result
        // rack under the front windows where a finished command's stamped tile
        // lands, and `countAt` carries the exact edit-call count on
        // inspection. The chimney anchor is the one the smoke column uses.
        workload: {
            billets: { at: [114, 214], step: [10, -4], w: 8, h: 4 },
            chimney: { at: [183, 8] },
            countAt: [150, 222],
            shelf: { at: [136, 184], step: 11, w: 9, h: 8, max: 4 },
        },
        // 4.5 — art-coupled points of the re-authored forge: the furnace arch
        // on the SW gable, the molten spill in front of it, the chimney crown
        // (smoke source; `smokeTop` is where a column leaves the cap) and the
        // anvil stump in the yard.
        effectAnchors: {
            hearth: [80, 160],
            spill: [80, 190],
            chimney: [183, 8],
            smokeTop: [183, 4],
            anvil: [104, 200],
        },
    },
    mine: {
        material: BUILDING_MATERIAL_REGISTRY.mine,
        grounding: BUILDING_GROUNDING_PROFILES.mine,
        nativeSize: { w: 256, h: 232 },
        labelAccent: '#ffab47',
        emblem: 'pick',
        districtTint: 'rgba(255, 171, 71, 0.22)',
        pulseBand: { color: '#ffab47', alpha: 0.26 },
        reducedMotionFallback: { pulse: 0.54, alpha: 0.86 },
        occupancyThresholds: { occupiedMax: 0.55, busyMax: 0.9 },
        labelPriority: 'landmark',
        beaconBase: 0.78,
        // 4.5 — the re-authored tunnel on the SW face: three columns of the
        // dark timber-framed opening, measured on base.png.
        windowColor: '#ffb84d',
        windowRects: [
            { at: [67, 164], w: 6, h: 30 },
            { at: [76, 162], w: 7, h: 34 },
            { at: [84, 160], w: 5, h: 24 },
        ],
        // Lantern light pooling on the plank threshold and running out along
        // the track toward the lower-left.
        doorSpill: {
            at: [74, 197],
            color: '#ffb84d',
            maxAlpha: 0.22,
            steps: [
                { offset: [-7, 0], w: 14, h: 1 },
                { offset: [-12, 1], w: 18, h: 2 },
                { offset: [-18, 3], w: 22, h: 1 },
            ],
        },
        // 4.5 — art-coupled points of the re-authored mine: `mouth` is the
        // plank floor just inside the tunnel, `railFrom`→`railTo` is the baked
        // track's centre line from the threshold out to its last sleeper (the
        // ritual cart rolls out along it), `railsBaked` retires the drawn
        // rails, and `reserve` is where the quota stockpile sits on the
        // rubble with its gauge below.
        effectAnchors: {
            mouth: [76, 186],
            railFrom: [77, 194],
            railTo: [47, 209],
            railsBaked: true,
            reserve: [176, 190],
        },
        // 4.3 — the assay bench: two shallow trays and the coin-stamp rack,
        // standing on the open yard below the rubble foot, east of the
        // cottage that sits in front of the track, clear of the reserve gauge.
        assay: {
            trays: [
                { at: [104, 236], w: 26, h: 10, kind: 'input' },
                { at: [134, 244], w: 26, h: 10, kind: 'cacheRead' },
            ],
            rack: { at: [166, 250], w: 30, h: 12 },
            countAt: [150, 267],
            costAt: [150, 276],
        },
    },
    archive: {
        material: BUILDING_MATERIAL_REGISTRY.archive,
        grounding: BUILDING_GROUNDING_PROFILES.archive,
        labelAccent: '#b3d68c',
        emblem: 'book',
        districtTint: 'rgba(179, 214, 140, 0.22)',
        pulseBand: { color: '#b3d68c', alpha: 0.24 },
        reducedMotionFallback: { pulse: 0.5, alpha: 0.84 },
        occupancyThresholds: { occupiedMax: 0.5, busyMax: 0.82 },
        labelPriority: 'landmark',
        beaconBase: 0.82,
        // 4.5 — the re-authored hall's five ground-floor lancets (the reading
        // rooms), glass bounds measured on base.png. The clerestory row is
        // emissive art only. (QAWorld F10: the SE gable is now one tall lancet
        // portal, so the rose window and its rect are gone.)
        windowRects: [
            { at: [90, 137], w: 8, h: 30 },
            { at: [113, 148], w: 5, h: 25 },
            { at: [135, 159], w: 5, h: 26 },
            { at: [157, 169], w: 5, h: 28 },
            { at: [179, 182], w: 5, h: 26 },
        ],
        pennant: { at: [68, 14] },
        // 4.2 — two reading rooms (the second and fourth lancet bays). A third
        // working occupant is a count, never an invented third window.
        rooms: {
            countAt: [140, 216],
            slots: [
                { at: [113, 148], w: 5, h: 25 },
                { at: [157, 169], w: 5, h: 28 },
            ],
        },
        // QAWorld F10 — the SE portal was re-authored (inpaint) into a lancet
        // whose oak leaf runs ~y 120–203 (≈83 px, ≥ 1.2× the 1:1 body), so the
        // points move with it: the leaf centre and the foot of its steps. The
        // lanterns are authored art plus emissive sidecar; the old decorative
        // aura, crest, window and lamp anchors are retired (no readers).
        effectAnchors: {
            doorway: [242, 162],
            step: [247, 219],
        },
    },
    observatory: {
        material: BUILDING_MATERIAL_REGISTRY.observatory,
        grounding: BUILDING_GROUNDING_PROFILES.observatory,
        labelAccent: '#bda7ff',
        emblem: 'star',
        districtTint: 'rgba(189, 167, 255, 0.22)',
        pulseBand: { color: '#bda7ff', alpha: 0.26 },
        reducedMotionFallback: { pulse: 0.56, alpha: 0.86 },
        occupancyThresholds: { occupiedMax: 0.5, busyMax: 0.86 },
        labelPriority: 'landmark',
        beaconBase: 0.7,
        // 4.6 — centres of the three glazed windows, measured on base.png
        // (the old rects were top-left corners): tower lancet, gable window,
        // porch window.
        windowRects: [
            { at: [80, 206], w: 12, h: 40 },
            { at: [167, 175], w: 10, h: 28 },
            { at: [121, 222], w: 8, h: 22 },
        ],
        pennant: { at: [108, 20] },
        effectAnchors: {
            clockFace: {
                compositeRef: { w: 256, h: 288 },
                center: [80, 155],
                radius: 13,
                sourceSize: 40,
                sourceCenter: 20,
                sourceRadius: 18,
                hourHandLength: 10,
                minuteHandLength: 15,
            },
            // #52 — the round dome aperture nearest the telescope opens at
            // night and bursts when a web ritual completes.
            domeAperture: {
                slit: [149, 107],
                star: [149, 101],
                glintArc: { center: [149, 104], radius: 12, from: -2.4, to: -0.7 },
            },
        },
    },
    portal: {
        material: BUILDING_MATERIAL_REGISTRY.portal,
        grounding: BUILDING_GROUNDING_PROFILES.portal,
        nativeSize: { w: 312, h: 208 },
        labelAccent: '#8bd7ff',
        emblem: 'rune',
        districtTint: 'rgba(139, 215, 255, 0.2)',
        pulseBand: { color: '#8feaff', alpha: 0.3 },
        reducedMotionFallback: { pulse: 0.58, alpha: 0.9 },
        occupancyThresholds: { occupiedMax: 0.5, busyMax: 0.86 },
        labelPriority: 'landmark',
        beaconBase: 0.92,
        // Violet rune aperture; kept separate from the mine's amber fire.
        windowColor: '#b38cff',
        windowRects: [
            { at: [134, 91], w: 5, h: 28 },
            { at: [144, 84], w: 8, h: 32, shape: 'ellipse' },
            { at: [154, 91], w: 5, h: 28 },
        ],
        doorSpill: {
            at: [144, 128],
            color: '#9b7cff',
            maxAlpha: 0.2,
            steps: [
                { offset: [-8, 0], w: 16, h: 1 },
                { offset: [-12, 1], w: 24, h: 2 },
                { offset: [-16, 3], w: 32, h: 1 },
            ],
        },
        pennant: { at: [170, 30] },
    },
    watchtower: {
        material: BUILDING_MATERIAL_REGISTRY.watchtower,
        grounding: BUILDING_GROUNDING_PROFILES.watchtower,
        labelAccent: '#ffe59a',
        emblem: 'flame',
        districtTint: 'rgba(255, 229, 154, 0.24)',
        pulseBand: { color: '#ffe59a', alpha: 0.28 },
        reducedMotionFallback: { pulse: 0.62, alpha: 0.92 },
        occupancyThresholds: { occupiedMax: 0.5, busyMax: 0.9 },
        labelPriority: 'landmark',
        beaconBase: 1,
        // Centres of the five arched windows up the lit (SW) face of the
        // shaft, measured on base.png glass (the old rects sat on blank wall).
        // The emissive sidecar lights the same glass plus the SE-face window.
        windowRects: [
            { at: [131, 122], w: 6, h: 15 },
            { at: [129, 148], w: 6, h: 15 },
            { at: [129, 179], w: 4, h: 17 },
            { at: [125, 218], w: 6, h: 15 },
            { at: [118, 258], w: 5, h: 14 },
        ],
        pennant: { at: [166, 80] },
        effectAnchors: {
            lanternFire: {
                flame: [144, 68],
                light: [144, 68],
                particle: [144, 68],
            },
            // #17 — pivot for the rotating distress searchlight beam. Anchored at
            // the lantern fire so the wedge appears to sweep out from the flame.
            searchlight: {
                pivot: [144, 68],
                length: 320,
                width: 58,
            },
        },
    },
    harbor: {
        material: BUILDING_MATERIAL_REGISTRY.harbor,
        grounding: BUILDING_GROUNDING_PROFILES.harbor,
        labelAccent: '#ffd37a',
        emblem: 'anchor',
        districtTint: 'rgba(255, 211, 122, 0.22)',
        pulseBand: { color: '#ffd37a', alpha: 0.24 },
        reducedMotionFallback: { pulse: 0.54, alpha: 0.86 },
        occupancyThresholds: { occupiedMax: 0.5, busyMax: 0.84 },
        labelPriority: 'landmark',
        beaconBase: 0.9,
        windowRects: [
            { at: [155, 70], w: 4, h: 8 },
            { at: [181, 80], w: 4, h: 8 },
            { at: [195, 89], w: 8, h: 7 },
            { at: [222, 90], w: 4, h: 7 },
            { at: [102, 110], w: 4, h: 9 },
            { at: [179, 107], w: 4, h: 7 },
            { at: [232, 110], w: 4, h: 8 },
            { at: [122, 129], w: 4, h: 8 },
            { at: [180, 136], w: 4, h: 8 },
            { at: [167, 148], w: 4, h: 8 },
            { at: [183, 155], w: 4, h: 8 },
            { at: [190, 158], w: 4, h: 7 },
        ],
    },
});

const WATCHTOWER_LANTERN_FIRE = BUILDING_VISUAL_REGISTRY.watchtower.effectAnchors.lanternFire;

export const BUILDING_EMITTER_FALLBACKS = {
    forge: [
        { type: 'forgeEmber', at: [80, 150], chance: 0.06, count: 1 },
        { type: 'forgeSpark', at: [104, 196], chance: 0.032, count: 1 },
    ],
    mine: [
        { type: 'mineDust', at: [76, 186], chance: 0.035, count: 1 },
        { type: 'mining', at: [70, 194], chance: 0.026, count: 1 },
    ],
    portal: [
        { type: 'portalRune', at: [144, 60], chance: 0.05, count: 1 },
        { type: 'sparkle', at: [122, 80], chance: 0.025, count: 1 },
    ],
    watchtower: [
        { type: 'beaconMote', at: WATCHTOWER_LANTERN_FIRE.particle, chance: 0.038, count: 1 },
    ],
    harbor: [
        { type: 'smoke', at: [127, 29], chance: 0.026, count: 1 },
        { type: 'sparkle', at: [249, 88], chance: 0.014, count: 1 },
    ],
    taskboard: [
        { type: 'questPing', at: [124, 100], chance: 0.024, count: 1 },
    ],
    archive: [
        { type: 'archiveMote', at: [241, 118], chance: 0.034, count: 1 },
        { type: 'archiveMote', at: [245, 170], chance: 0.018, count: 1 },
        { type: 'archiveMote', at: [170, 130], chance: 0.018, count: 1 },
    ],
};

export const BUILDING_LIGHT_FALLBACKS = {
    forge: { at: [80, 165], color: '#ff8a33', radius: 80, overlay: 'atmosphere.light.fire-glow' },
    mine: { at: [76, 186], color: '#ffb84d', radius: 80, overlay: 'atmosphere.light.lantern-glow' },
    taskboard: { at: [124, 108], color: '#8bd7ff', radius: 42, overlay: 'atmosphere.light.lantern-glow' },
    archive: { at: [245, 178], color: '#ffcf7a', radius: 96, overlay: 'atmosphere.light.lantern-glow' },
    harbor: { at: [181, 156], color: '#ffd37a', radius: 58, overlay: 'atmosphere.light.lantern-glow' },
};

export const LIGHT_SOURCE_REGISTRY = {
    watchtower: [
        {
            kind: 'point',
            at: WATCHTOWER_LANTERN_FIRE.light,
            color: '#ffb347',
            radius: 108,
            overlay: 'atmosphere.light.fire-glow',
        },
    ],
};

export const EMITTER_LIGHTS = {
    torch: { color: '#ffbc62', radius: 42, overlay: 'atmosphere.light.fire-glow' },
    signal: { color: '#ffd37a', radius: 48, overlay: 'atmosphere.light.lantern-glow' },
    forgeEmber: { color: '#ff8a33', radius: 42, overlay: 'atmosphere.light.fire-glow' },
    forgeSpark: { color: '#ff9f3f', radius: 34, overlay: 'atmosphere.light.fire-glow' },
};

export function getBuildingVisual(type) {
    return BUILDING_VISUAL_REGISTRY[type] || null;
}

export function getBuildingMaterial(type) {
    return getBuildingVisual(type)?.material || null;
}

export function getBuildingLabelAccent(type, fallback = '#d6a951') {
    return getBuildingVisual(type)?.labelAccent || fallback;
}

export function getBuildingLabelEmblem(type, fallback = 'mark') {
    return getBuildingVisual(type)?.emblem || fallback;
}

export function getBuildingLabelPriority(type, fallback = 'normal') {
    return getBuildingVisual(type)?.labelPriority || fallback;
}

export function getBuildingEffectAnchor(type, key, fallback = null) {
    return getBuildingVisual(type)?.effectAnchors?.[key] || fallback;
}

// 6.2 — optional per-building lit-window spots (sprite-local px). Buildings
// without an entry keep the legacy radial warmth blobs.
export function getBuildingWindowRects(type) {
    const rects = getBuildingVisual(type)?.windowRects;
    return Array.isArray(rects) && rects.length ? rects : null;
}

export function getBuildingWindowColor(type, fallback = null) {
    return getBuildingVisual(type)?.windowColor || fallback;
}

export function getBuildingDoorSpill(type) {
    const spill = getBuildingVisual(type)?.doorSpill;
    return Array.isArray(spill?.at) && Array.isArray(spill?.steps) && spill.steps.length ? spill : null;
}

// A static, phase-free lighting descriptor for the reaction pass. The spill
// is an occupancy signal, so an empty building has no doorstep sheen.
export function getBuildingDoorSpillDescriptor(type, {
    occupancy = 0,
    beaconIntensity = 0,
    weatherWetness = 0,
    atmosphereWarmth = 1,
} = {}) {
    const spill = getBuildingDoorSpill(type);
    if (!spill) return null;
    const occupancyScale = Math.max(0, Math.min(1, Number(occupancy) || 0));
    const beaconScale = Math.max(0, Math.min(1, Number(beaconIntensity) || 0));
    const wetnessScale = Math.max(0, Math.min(1, Number(weatherWetness) || 0));
    const warmthScale = Math.max(0, Math.min(1, Number(atmosphereWarmth) || 0));
    const maxAlpha = Number.isFinite(spill.maxAlpha) ? spill.maxAlpha : 0.2;
    const alpha = Math.min(maxAlpha, occupancyScale * warmthScale * maxAlpha * (
        0.48 + beaconScale * 0.36 + wetnessScale * 0.16
    ));
    return {
        at: spill.at,
        steps: spill.steps,
        color: spill.color || getBuildingWindowColor(type, '#ffcd70'),
        alpha,
        staticAlpha: true,
    };
}

// 4.1 — optional authored inspection aperture. A building without a profile
// never opens; the caller keeps the exterior exactly as it ships.
export function getBuildingApertureProfile(type) {
    const aperture = getBuildingVisual(type)?.aperture;
    if (!aperture?.cut || !Array.isArray(aperture.slots) || !aperture.slots.length) return null;
    if (!Array.isArray(aperture.layers) || aperture.layers.length !== 3) return null;
    return aperture;
}

// 4.1 — the layer names the aperture owns, so the generic manifest-layer pass
// can skip them: they are drawn only during explicit inspection, in the
// authored order, by the building renderer.
export function isBuildingApertureLayer(type, layerName) {
    const visual = getBuildingVisual(type);
    if (visual?.rest?.layer && visual.rest.layer === layerName) return true;
    const aperture = visual?.aperture;
    return Array.isArray(aperture?.layers) && aperture.layers.includes(layerName);
}

// 4.6 — optional authored rest mask (`banked.png`). Absent = the building has
// no baked work light to restate and keeps its shipped idle treatment.
export function getBuildingRestLayer(type) {
    const layer = getBuildingVisual(type)?.rest?.layer;
    return typeof layer === 'string' && layer ? layer : null;
}

// 4.2 — optional authored work rooms (sprite-local windows). Buildings without
// a profile keep the shipped aggregate night gate.
export function getBuildingRoomProfile(type) {
    const rooms = getBuildingVisual(type)?.rooms;
    if (!Array.isArray(rooms?.slots) || !rooms.slots.length) return null;
    return rooms;
}

// 4.3 — optional authored assay bench (sprite-local trays + coin rack). Only
// the Mine carries one; absent = the building shows no assay instrument.
export function getBuildingAssayProfile(type) {
    const assay = getBuildingVisual(type)?.assay;
    if (!Array.isArray(assay?.trays) || !assay.trays.length) return null;
    return assay;
}

// 4.4 — optional authored workload bench (billets, chimney, result shelf).
export function getBuildingWorkloadProfile(type) {
    const workload = getBuildingVisual(type)?.workload;
    return workload?.billets?.at ? workload : null;
}

// 4.7 — optional authored plan-tab strip on the slate frame.
export function getBuildingPlanTabProfile(type) {
    const tabs = getBuildingVisual(type)?.planTabs;
    return Array.isArray(tabs?.at) ? tabs : null;
}

// #53 — optional occupancy-pennant anchor (sprite-local pole base). Only hero
// buildings carry one; absent = no pennant.
export function getBuildingPennantAnchor(type) {
    const pennant = getBuildingVisual(type)?.pennant;
    return Array.isArray(pennant?.at) ? pennant : null;
}

// Per-building responsiveness to the global beacon intensity (0..1). Strong
// emitters (forge/watchtower) react fully; quieter buildings hold back so the
// village dims/brightens in unison without flattening to one brightness.
export function getBuildingBeaconBase(type, fallback = 0.85) {
    const value = getBuildingVisual(type)?.beaconBase;
    return Number.isFinite(value) ? value : fallback;
}

export function getBuildingOccupancyState(type, { count = 0, capacity = 0, alert = false } = {}) {
    if (alert) return 'alert';
    const numericCount = Math.max(0, Number(count) || 0);
    const numericCapacity = Math.max(0, Number(capacity) || 0);
    if (numericCount <= 0 || numericCapacity <= 0) return numericCount > 0 ? 'occupied' : 'idle';
    const ratio = numericCount / numericCapacity;
    const thresholds = {
        ...DEFAULT_BUILDING_OCCUPANCY_THRESHOLDS,
        ...(getBuildingVisual(type)?.occupancyThresholds || {}),
    };
    if (ratio <= thresholds.idleMax) return 'idle';
    if (ratio <= thresholds.occupiedMax) return 'occupied';
    if (ratio <= thresholds.busyMax) return 'busy';
    return 'full';
}

export {
    MIDNIGHT_OIL_FALL_MS,
    MIDNIGHT_OIL_RISE_MS,
    lightsBuildingWindows,
    nightWindowGate,
} from './NightOccupancyGate.js';

function landmarkMaterial(type, materialClass, top, horizonY, sources) {
    return Object.freeze(normalizeMaterialMetadata({
        materialId: `building.${type}`,
        materialClass,
        elevation: { base: 0, top, unit: 'sprite-px' },
        emissive: { strength: sources.length ? 1 : 0, sources },
        occluder: {
            mode: 'alpha-silhouette',
            strength: 1,
            ...(Number.isFinite(horizonY) ? { horizonY } : {}),
        },
    }));
}

function emissiveSource(id, kind, geometry, strength) {
    return Object.freeze({ id, kind, geometry, strength });
}
