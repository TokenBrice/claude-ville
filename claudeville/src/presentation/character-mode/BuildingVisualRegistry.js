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
    portal: landmarkMaterial('portal', 'stone', 264, 150, [
        emissiveSource('emissive.portal.vortex', 'rune', 'layers.portalGlow', 1),
        emissiveSource('emissive.portal.runes', 'rune', 'layers.runes', 0.8),
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
        // 6.2 — sprite-local lit-window spots. BL-3 — `at` is the glass
        // centre on every rect in this registry (`windowRectBounds`), and
        // each rect sits >= 60 % on its emissive sidecar's glass
        // (`npm run world:validate-buildings`).
        // 4.2 — measured on the re-authored keep: the three dome-drum panes,
        // the lower left-tower pane and the hall pane beside the right tower.
        // The east wing's panes are left out: they sit inside the 4.1 cut.
        windowRects: [
            { at: [143, 103], w: 5, h: 12 },
            { at: [175, 110], w: 6, h: 11 },
            { at: [207, 103], w: 3, h: 11 },
            { at: [72.5, 121], w: 3, h: 6 },
            { at: [236.5, 122], w: 3, h: 10 },
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
        // BL-3 — one rect per lantern pane: the dark centre post is not glass.
        windowRects: [
            { at: [43, 56], w: 4, h: 12 },
            { at: [50, 56], w: 4, h: 12 },
            { at: [200, 126], w: 4, h: 12 },
            { at: [207.5, 126], w: 4, h: 12 },
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
        // BL-3 — pane centres on the sidecar glass (they were top-left corners).
        windowRects: [
            { at: [144, 169.5], w: 6, h: 19 },
            { at: [158, 163.5], w: 6, h: 19 },
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
        // portal, so the rose window and its rect are gone.) BL-3 — lancet
        // glass centres; these were top-left corners, so every stamp and room
        // pane lit the wall below-right of its window.
        windowRects: [
            { at: [95, 152], w: 5, h: 30 },
            { at: [115.5, 160.5], w: 5, h: 25 },
            { at: [137.5, 172], w: 5, h: 26 },
            { at: [159.5, 183], w: 5, h: 28 },
            { at: [181.5, 195], w: 5, h: 26 },
        ],
        // 6.3 / M15 — the clerestory lancets: authored glass that belongs to
        // no room, so it is unlit slate glass at every hour (RoomGlass reads
        // `glassRects`); only a room a worker holds glows.
        glassRects: [
            { at: [98, 92], w: 7, h: 19 },
            { at: [123.5, 104.5], w: 4, h: 18 },
            { at: [147.5, 117], w: 4, h: 19 },
            { at: [170, 129], w: 5, h: 19 },
            { at: [192.5, 141], w: 6, h: 19 },
        ],
        pennant: { at: [68, 14] },
        // 4.2 — two reading rooms (the second and fourth lancet bays). A third
        // working occupant is a count, never an invented third window.
        rooms: {
            countAt: [140, 216],
            slots: [
                { at: [115.5, 160.5], w: 5, h: 25 },
                { at: [159.5, 183], w: 5, h: 28 },
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
        labelAccent: '#8bd7ff',
        emblem: 'rune',
        districtTint: 'rgba(139, 215, 255, 0.2)',
        pulseBand: { color: '#8feaff', alpha: 0.3 },
        reducedMotionFallback: { pulse: 0.58, alpha: 0.9 },
        occupancyThresholds: { occupiedMax: 0.5, busyMax: 0.86 },
        labelPriority: 'landmark',
        beaconBase: 0.92,
        // The vortex is no window and no room: its glass is the emissive
        // sidecar plus the `portalGlow` fixture overlay, so the Portal carries
        // no `windowRects`. The vortex's violet pools on the flagstones in
        // front of it while the Portal works (kept apart from the mine's amber).
        doorSpill: {
            at: [149, 183],
            color: '#9b7cff',
            maxAlpha: 0.2,
            steps: [
                { offset: [-8, 0], w: 16, h: 1 },
                { offset: [-12, 1], w: 24, h: 2 },
                { offset: [-16, 3], w: 32, h: 1 },
            ],
        },
        // The right tower's gilt finial.
        pennant: { at: [222, 62] },
        // 2026-10-01 re-author: `gate` is the vortex threshold on the dais
        // floor (the ritual rings, plaque and summon curve's origin),
        // `vortex` the vortex's heart (the status rings and the ritual light).
        effectAnchors: {
            gate: [150, 186],
            vortex: [156, 128],
        },
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
        // The emissive sidecar lights the same glass plus the SE-face window;
        // the second, fourth and fifth rects are narrowed to its lit slit.
        windowRects: [
            { at: [131, 122], w: 6, h: 15 },
            { at: [130.5, 148], w: 3, h: 16 },
            { at: [129, 179], w: 4, h: 17 },
            { at: [126.5, 218], w: 3, h: 16 },
            { at: [118.5, 258], w: 3, h: 16 },
        ],
        pennant: { at: [166, 80] },
        effectAnchors: {
            lanternFire: {
                flame: [144, 68],
                light: [144, 68],
                particle: [144, 68],
                // 2.7 (V5) — the tower base under the lantern: the foot the
                // beam fans leave from (the lamp itself lights no ground).
                foot: [145, 316],
            },
            // 2.7 — pivot, length and far width of the Lighthouse beam fans
            // (ground px) the resident shaders sweep from the lantern: long
            // enough to read at z1 on a 5120 frame, and a fan (about 11
            // degrees each side), never a parallel strip.
            searchlight: {
                pivot: [144, 68],
                length: 520,
                width: 200,
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
        // Pane centres, sized to the sidecar's lit texels on each pane. The
        // sidecar lights only a one-texel sliver of the panes at ~[122, 129]
        // and ~[167, 148], so they carry no rect.
        windowRects: [
            { at: [155.5, 70.5], w: 3, h: 3 },
            { at: [181.5, 79.5], w: 3, h: 5 },
            { at: [196, 88], w: 6, h: 6 },
            { at: [221.5, 90.5], w: 3, h: 3 },
            { at: [102.5, 111], w: 3, h: 8 },
            { at: [178.5, 107], w: 3, h: 4 },
            { at: [231.5, 111], w: 3, h: 4 },
            { at: [179.5, 135.5], w: 3, h: 5 },
            { at: [183.5, 155.5], w: 3, h: 5 },
            { at: [190.5, 158], w: 3, h: 4 },
        ],
        // 6.4 — the two grey stacks behind the office roof: where each column
        // leaves its cap (ChimneySmoke; smoke only with a working visitor).
        effectAnchors: {
            smokeTop: [[129, 26], [139, 30]],
        },
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
        { type: 'portalRune', at: [156, 128], chance: 0.05, count: 1 },
        { type: 'sparkle', at: [92, 158], chance: 0.025, count: 1 },
    ],
    watchtower: [
        { type: 'beaconMote', at: WATCHTOWER_LANTERN_FIRE.particle, chance: 0.038, count: 1 },
    ],
    harbor: [
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
    forge: { at: [80, 186], color: '#ff8a33', radius: 80, overlay: 'atmosphere.light.fire-glow', fire: true },
    mine: { at: [76, 186], color: '#ffb84d', radius: 80, overlay: 'atmosphere.light.lantern-glow' },
    taskboard: { at: [124, 108], color: '#8bd7ff', radius: 42, overlay: 'atmosphere.light.lantern-glow' },
    archive: { at: [245, 178], color: '#ffcf7a', radius: 96, overlay: 'atmosphere.light.lantern-glow' },
    harbor: { at: [181, 156], color: '#ffd37a', radius: 58, overlay: 'atmosphere.light.lantern-glow' },
};

export const LIGHT_SOURCE_REGISTRY = {
    watchtower: [
        {
            kind: 'point',
            role: 'fixture',
            at: WATCHTOWER_LANTERN_FIRE.light,
            foot: WATCHTOWER_LANTERN_FIRE.foot,
            color: '#ffb347',
            // 2.7 — a 2.5D ground radius from the tower base: the gallery
            // masonry near the lantern is lit and the base takes one course.
            radius: 200,
            overlay: 'atmosphere.light.fire-glow',
        },
    ],
};

// 2.6 — `fire: true` marks flame sources that breathe in stepped quanta. A
// `torch` emitter is fire only where its building's manifest declares an
// emissive `kind: fire` source on that emitter geometry (the Command gate
// braziers); glazed lanterns and flameless harbour/Lighthouse torches stay
// steady.
export const EMITTER_LIGHTS = {
    torch: { color: '#ffbc62', radius: 42, overlay: 'atmosphere.light.fire-glow' },
    signal: { color: '#ffd37a', radius: 48, overlay: 'atmosphere.light.lantern-glow' },
    forgeEmber: { color: '#ff8a33', radius: 42, overlay: 'atmosphere.light.fire-glow', fire: true },
    forgeSpark: { color: '#ff9f3f', radius: 34, overlay: 'atmosphere.light.fire-glow', fire: true },
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

// BL-3 — `at` on every window rect and room pane is the glass centre, in
// base-local texels. Every reader (the warmth stamps, the room panes, the
// Command aggregate row, the atlas bake and the building validator) takes a
// rect's texel bounds from here, so the convention lives in one place. Pass
// a mapped centre (`cx`, `cy`) to get bounds in that space instead.
export function windowRectBounds(rect, cx = rect.at[0], cy = rect.at[1]) {
    const w = Math.max(3, Math.round(rect.w || 6));
    const h = Math.max(3, Math.round(rect.h || 8));
    return { left: Math.round(cx - w / 2), top: Math.round(cy - h / 2), w, h };
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
