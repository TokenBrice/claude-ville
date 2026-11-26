import { BUILDING_GROUNDING_PROFILES } from '../../config/buildingGrounding.js';
import { normalizeApertureLayers } from './BuildingApertureModel.js';
import {
    ARCHIVE_CUTAWAY_PROFILE,
    COMMAND_CUTAWAY_PROFILE,
    CUTAWAY_LAYERS_4,
    HARBOR_CUTAWAY_PROFILE,
} from './BuildingCutaways.js';
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
    tavern: landmarkMaterial('tavern', 'stone', 288, 248, [
        emissiveSource('emissive.tavern.windows', 'windows', 'windowRects', 0.62),
    ]),
    portal: landmarkMaterial('portal', 'stone', 264, 150, [
        emissiveSource('emissive.portal.vortex', 'rune', 'layers.portalGlow', 1),
        emissiveSource('emissive.portal.runes', 'rune', 'layers.runes', 0.8),
    ]),
    watchtower: landmarkMaterial('watchtower', 'stone', 384, 300, [
        emissiveSource('emissive.watchtower.windows', 'windows', 'windowRects', 0.68),
        emissiveSource('emissive.watchtower.beacon', 'fire', 'effectAnchors.lanternFire', 1),
    ]),
    harbor: landmarkMaterial('harbor', 'stone', 284, 200, [
        emissiveSource('emissive.harbor.windows', 'windows', 'windowRects', 0.66),
        emissiveSource('emissive.harbor.lantern', 'lantern', 'lightSource', 0.82),
        emissiveSource('emissive.harbor.tideClock', 'lantern', 'emitters.signal', 0.72),
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
        // W5-B (Spec 01 §1, D6) — base.surface.png: the WebGPU `surface-v1`
        // height + oct64 normal page (bake-depth-channels.mjs); the Command
        // dome is one of the per-pixel depth pilots. `surfaceAoPairs`: an
        // exposed texel is never more occluded than its crevice
        // (world:validate-buildings).
        surfaceSidecar: true,
        surfaceAoPairs: [
            { open: [160, 60], crevice: [122, 205] },
            { open: [300, 150], crevice: [122, 205] },
        ],
        // Spec 04 §2.3 — the sign anchor (sprite-local): the left jamb of the hall door, the arm reaching over the leaf under the gilt crest. The
        // compact chit column and the Carved Motif bracket hang here;
        // `signBoxFor` is the 12 × 14 box world:validate-buildings checks.
        sign: { at: [121, 122] },
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
        // W5.3 — the attention banner (manifest layers banner / bannerError /
        // bannerLimit, status gates): `at` is the cloth's top-centre under
        // the rod on the flag tower's front face, `drops` the cloth rows per
        // wait-age tier (frames 1–4; bake-banner-stones.mjs BANNER_DROPS).
        // The walnut count board hangs `boardGap` px under the cloth's tip.
        attentionBanner: { at: [89, 70], drops: [25, 45, 65, 85], boardGap: 2 },
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
        // the layers were authored inside (rising to the right at the art's
        // own ~2:1 wall slope): it spans the wing's plain right-facing wall
        // between the corner pillar and the right pilaster, from the cornice
        // down through the upper plinth (the floor slab is the sawn sill), so
        // the room is a full storey rather than a slot. `occupant.h` is the
        // presented body height in sprite pixels — two thirds of the room's
        // height, so an occupant reads as a person standing in a room at 2x.
        // The exterior silhouette, footprint, door anchor, hit target and
        // pathfinding are untouched.
        // W5-B (Spec 04 §5.1, D6) — the Miniature War Table cutaway. Four
        // layers: `roof` is base.png's own wing wall crop over the cut
        // (bake-cutaway-command.mjs), lifted on a 4 × 4 Bayer order in four
        // 150 ms steps (instant under reduced motion); `aperture` the hall's
        // back wall and floor, `interior` the 26 × 10 oak war table body and
        // the two desks that occlude their occupants' legs, `foreground` the
        // sawn sill and jambs. Slots are `{ id, bay, at, pose, facing }`,
        // front to back; `floor` is the back-wall base line every slot stands
        // below (world:validate-buildings). The legend is the one-line sill
        // bar (R12): `3 WORKING · 1 WAITING · +2` at `legend.at`.
        aperture: {
            minZoom: COMMAND_CUTAWAY_PROFILE.minZoom,
            layers: [...CUTAWAY_LAYERS_4],
            cutaway: 'command',
            cut: { ...COMMAND_CUTAWAY_PROFILE.cut },
            legend: { ...COMMAND_CUTAWAY_PROFILE.legend, at: [...COMMAND_CUTAWAY_PROFILE.legend.at] },
            sillBar: true,
            occupant: { ...COMMAND_CUTAWAY_PROFILE.occupant },
            floor: { at: [228, 199], slope: -0.52 },
            warTable: COMMAND_CUTAWAY_PROFILE.table,
            slots: COMMAND_CUTAWAY_PROFILE.slots.map(cutawaySlot),
        },
        // 4.2 — the hall's work rooms: one authored window per room, lit for
        // one real working occupant each. B3-01 — every painted pane is a
        // room, front and large first (`assignRoomSlots` fills in order): the
        // three dome-drum panes, the east wing's three, the hall pane by the
        // right tower, the left tower's two, the right turret and the small
        // keep pane between the banners. Distinct from `windowRects` and from
        // the gate braziers. The wing panes sit inside the 4.1 cut: while the
        // aperture is open they stay dark (`BuildingSprite.roomGate`), so an
        // open aperture never argues with a lit window about the same room.
        rooms: {
            countAt: [186, 236],
            slots: [
                { at: [143, 104], w: 5, h: 9 },
                { at: [175, 110], w: 6, h: 10 },
                { at: [207, 104], w: 3, h: 9 },
                { at: [247, 186], w: 4, h: 8 },
                { at: [272, 173.5], w: 4, h: 7 },
                { at: [296, 160], w: 4, h: 8 },
                { at: [236.5, 122], w: 3, h: 10 },
                { at: [72.5, 121], w: 3, h: 6 },
                { at: [73, 102], w: 3, h: 6 },
                { at: [265, 100.5], w: 3, h: 7 },
                { at: [215, 133], w: 3, h: 5 },
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
        // Spec 04 §2.3 — the sign anchor (sprite-local): the right post under its pennant, clear of the east lantern and the code-drawn slate. The
        // compact chit column and the Carved Motif bracket hang here;
        // `signBoxFor` is the 12 × 14 box world:validate-buildings checks.
        sign: { at: [180, 136] },
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
        // W5-B (Spec 01 §1, D6) — base.surface.png, the Forge's per-pixel
        // depth pilot (bake-depth-channels.mjs over the arcade's authored
        // occluder): the centre pier's face and the S corner's wall stay more
        // exposed than the bay's floor behind the arches.
        surfaceSidecar: true,
        surfaceAoPairs: [
            { open: [64, 150], crevice: [70, 190] },
            { open: [110, 170], crevice: [80, 196] },
        ],
        // W5 Fix-B (D6, Fable P0-5) — the open-front Forge: a two-arch smithy
        // arcade (bake-forge-openfront.mjs). Its one profile is OpenFront's
        // `forge` (FORGE_OPEN_FRONT_PROFILE, measured on the art); this record
        // only names it. BuildingSprite emits its arch split drawables; the
        // Tavern's are TavernArcade's.
        openFront: Object.freeze({ profile: 'forge', drawables: 'BuildingSprite' }),
        // Spec 04 §2.3 — the sign anchor (sprite-local): the half-timbered gable wall over the smithy arcade. The
        // compact chit column and the Carved Motif bracket hang here;
        // `signBoxFor` is the 12 × 14 box world:validate-buildings checks.
        sign: { at: [73, 107] },
        beaconBase: 1,
        // 4.5 — the two warm windows over the tool rack. B3-04 (2026-10-24):
        // each leaded window of the re-authored art has an upper and a lower
        // pane split by a 3-texel transom, so it is two rects that light as
        // one room (`ROOM_PANE_GROUPS.forge` in bake-room-masks.mjs).
        // BL-3 — pane centres on the sidecar glass (they were top-left corners).
        windowRects: [
            { at: [144.5, 168], w: 5, h: 8 },
            { at: [144.5, 179], w: 5, h: 8 },
            { at: [159.5, 160.5], w: 5, h: 9 },
            { at: [159.5, 172], w: 5, h: 8 },
        ],
        // SW gable apex timber ridge, clear of the east chimney plume.
        pennant: { at: [74, 56] },
        // 4.6 — the hearth fire is painted into base.png, so rest needs an
        // authored mask: `banked.png` restates the arcade hearth's firebox as
        // stepped charcoal over one ember course, and its warm spill on the
        // floor and wall as unlit stone. A part (`partDrawsFor`) only while
        // the hearth is banked (`BuildingSprite._restMaskShowing`).
        // VQ-8 — the ember floor: the course's own authored texels (bright
        // `#d67634`, dim `#803e22`, the Tavern's pair) emit at `strength`
        // while the village lamps burn, static, so a banked hearth reads
        // banked, not cold.
        rest: { layer: 'banked', ember: { colors: ['#d67634', '#803e22'], strength: 0.4 } },
        // 4.4 — the workload bench. `billets` are the three stepped bars on the
        // anvil plinth (one per observed count tier), `shelf` is the result
        // rack under the front windows where a finished command's stamped tile
        // lands, and `countAt` carries the exact edit-call count on
        // inspection. The chimney anchor is the one the smoke column uses.
        workload: {
            billets: { at: [114, 214], step: [10, -4], w: 8, h: 4 },
            chimney: { at: [184, 19] },
            countAt: [150, 222],
            shelf: { at: [136, 184], step: 11, w: 9, h: 8, max: 4 },
        },
        // 4.5 / B3-04 — art-coupled points of the forge. W5 Fix-B — `hearth`
        // is the arcade's recessed firebox on the bay's inner wall, `spill`
        // the right arch's threshold its light falls through; the chimney
        // crown (smoke source; `smokeTop` is where a column leaves the cap)
        // and the anvil on its stone block in the yard.
        effectAnchors: {
            hearth: [75, 142],
            spill: [79, 196],
            chimney: [184, 19],
            smokeTop: [184, 15],
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
        // Spec 04 §2.3 — the sign anchor (sprite-local): the timber lintel over the tunnel mouth, above the lantern-lit opening. The
        // compact chit column and the Carved Motif bracket hang here;
        // `signBoxFor` is the 12 × 14 box world:validate-buildings checks.
        sign: { at: [76, 116] },
        beaconBase: 0.78,
        // 4.5 — the re-authored tunnel on the SW face: three columns of the
        // dark timber-framed opening, measured on base.png.
        windowColor: '#ffb84d',
        windowRects: [
            { at: [67, 164], w: 6, h: 30 },
            { at: [76, 162], w: 7, h: 34 },
            { at: [84, 160], w: 5, h: 24 },
        ],
        // Top of the wooden headframe's west post above the sheave wheel.
        pennant: { at: [75, 19] },
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
        // ritual cart rolls out along it), and `railsBaked` retires the drawn
        // rails.
        effectAnchors: {
            mouth: [76, 186],
            railFrom: [77, 194],
            railTo: [47, 209],
            railsBaked: true,
        },
        // 4.3 — the assay bench: two shallow trays and the coin-stamp rack,
        // standing on the open yard below the rubble foot, east of the
        // cottage that sits in front of the track.
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
        // Spec 04 §2.3 — the sign anchor (sprite-local): the SE gable stone over the lancet portal's arch. The
        // compact chit column and the Carved Motif bracket hang here;
        // `signBoxFor` is the 12 × 14 box world:validate-buildings checks.
        sign: { at: [242, 97] },
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
        pennant: { at: [68, 14] },
        // 4.2 — reading rooms. B3-01 — every painted lancet is a room: the
        // five tall ground lancets first (the second and fourth bays keep
        // rooms 1 and 2), then the five clerestory lancets above the same
        // bays. An eleventh working occupant is a count, never an invented
        // window.
        rooms: {
            countAt: [140, 216],
            slots: [
                { at: [115.5, 160.5], w: 5, h: 25 },
                { at: [159.5, 183], w: 5, h: 28 },
                { at: [137.5, 172], w: 5, h: 26 },
                { at: [95, 152], w: 5, h: 30 },
                { at: [181.5, 195], w: 5, h: 26 },
                { at: [123.5, 104.5], w: 4, h: 18 },
                { at: [170, 129], w: 5, h: 19 },
                { at: [147.5, 117], w: 4, h: 19 },
                { at: [98.5, 92.5], w: 5, h: 17 },
                { at: [192.5, 141], w: 6, h: 19 },
            ],
        },
        // W5-B (Spec 04 §5.2, D6) — the lifted-roof cutaway over the long
        // lancet wall (slope +0.5): five Repo Directory Bays, one per ground
        // lancet, a lectern 12 texels toward the viewer from each, the
        // Compaction Shelf beside bay 1 and the Loom of Days wall space
        // (BuildingCutaways ARCHIVE_CUTAWAY_PROFILE). All ten room panes lie
        // inside the cut and stay dark while it is open. Bay names are text:
        // sill bar (opened by The Glass) only, never a postcard.
        aperture: {
            minZoom: ARCHIVE_CUTAWAY_PROFILE.minZoom,
            layers: [...CUTAWAY_LAYERS_4],
            cutaway: 'archive',
            cut: { ...ARCHIVE_CUTAWAY_PROFILE.cut },
            legend: { ...ARCHIVE_CUTAWAY_PROFILE.legend, at: [...ARCHIVE_CUTAWAY_PROFILE.legend.at] },
            sillBar: true,
            occupant: { ...ARCHIVE_CUTAWAY_PROFILE.occupant },
            floor: { at: [88, 132], slope: 0.5 },
            slots: ARCHIVE_CUTAWAY_PROFILE.bays.map((bay) => cutawaySlot({
                id: `bay-${bay.index}`,
                bay: bay.index,
                at: bay.at,
                pose: 'read',
                facing: 'north-east',
            })),
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
    tavern: {
        material: BUILDING_MATERIAL_REGISTRY.tavern,
        grounding: BUILDING_GROUNDING_PROFILES.tavern,
        labelAccent: '#e8b86a',
        emblem: 'tankard',
        districtTint: 'rgba(232, 184, 106, 0.2)',
        pulseBand: { color: '#e8b86a', alpha: 0.26 },
        reducedMotionFallback: { pulse: 0.56, alpha: 0.86 },
        occupancyThresholds: { occupiedMax: 0.5, busyMax: 0.86 },
        labelPriority: 'landmark',
        // W5-B (D6) — the Tavern is already open: `OpenFront.js`'s `tavern`
        // profile, whose arch split drawables TavernArcade emits.
        openFront: Object.freeze({ profile: 'tavern', drawables: 'TavernArcade' }),
        // Spec 04 §2.3 — the sign anchor (sprite-local): the open front's main beam over the centre arch. The
        // compact chit column and the Carved Motif bracket hang here;
        // `signBoxFor` is the 12 × 14 box world:validate-buildings checks.
        sign: { at: [99, 178] },
        beaconBase: 0.7,
        // Glass centres of the five windows on base.png: the dormer, the
        // east gable's upper pair and the curtained ground-floor pair. Each is
        // a room lit by the Tavern's patrons; the open bar's lanterns and
        // hearth glow on the building's patron gate.
        windowRects: [
            { at: [127, 89], w: 10, h: 12 },
            { at: [221, 157], w: 11, h: 15 },
            { at: [251, 143], w: 11, h: 12 },
            { at: [218, 214], w: 4, h: 13 },
            { at: [248, 201], w: 3, h: 8 },
        ],
        // NW gable ridge peak, clear of the SE chimney plume.
        pennant: { at: [103, 12] },
        // The chimney mouth: the hearth smokes while the Tavern has patrons.
        effectAnchors: {
            smokeTop: [217, 36],
        },
        // B3-03' — the hearth fire and its floor spill are painted into
        // base.png, so an empty Tavern (no patron, no worker) lays the
        // authored `banked.png` mask over exactly those pixels: charcoal over
        // one ember course. A part only while banked, like the Forge's.
        rest: { layer: 'banked', ember: { colors: ['#d67634', '#803e22'], strength: 0.4 } },
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
        // Spec 04 §2.3 — the sign anchor (sprite-local): the gilt keystone over the vortex arch, above the rune voussoirs. The
        // compact chit column and the Carved Motif bracket hang here;
        // `signBoxFor` is the 12 × 14 box world:validate-buildings checks.
        sign: { at: [157, 40] },
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
        // MB-4 (D4) — the Portal slumbers until someone travels: the vortex
        // is painted into base.png, so an empty Portal lays the authored
        // `slumber.png` (two courses down the vortex's own violet ramp, chroma
        // held) over exactly those texels, and the `portalGlow` fixture it
        // `covers` stands down. It wakes on `work.portal` only (web tools).
        // The ember floor: the slumbering eye's two courses glow low while
        // the lamps burn, as the banked Forge's do.
        rest: { layer: 'slumber', covers: ['portalGlow'], ember: { colors: ['#b775f6', '#9a58e6'], strength: 0.4 } },
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
        // Spec 04 §2.3 — the sign anchor (sprite-local): the keeper's cottage gable over its door (the tower's own entrance tile lies outside the sprite). The
        // compact chit column and the Carved Motif bracket hang here;
        // `signBoxFor` is the 12 × 14 box world:validate-buildings checks.
        sign: { at: [95, 284] },
        beaconBase: 1,
        // Glass centres of the two arched shaft windows (SW and SE faces)
        // and the keeper's cottage window, measured on the emissive sidecar.
        windowRects: [
            { at: [146.5, 158], w: 3, h: 12 },
            { at: [183.5, 204.5], w: 3, h: 11 },
            { at: [137, 308.5], w: 6, h: 13 },
        ],
        pennant: { at: [192, 112] },
        effectAnchors: {
            // Fire exhaust leaves the cone's crown, not its occupancy rooms.
            smokeTop: [164, 50],
            // Keeper's cottage stone chimney: smokes while someone watches/works
            // at the Lighthouse (daytime occupied cue, separate from crown).
            cottageSmokeTop: [108, 237],
            lanternFire: {
                flame: [164, 97],
                light: [164, 97],
                particle: [164, 97],
                // Tower foot under the lantern; anchors the water reflection
                // column (the lantern lights no ground, apron or masonry).
                foot: [166, 324],
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
        // Spec 04 §2.3 — the sign anchor (sprite-local): the timber wall over the counting-house door, left of the lit bay. The
        // compact chit column and the Carved Motif bracket hang here;
        // `signBoxFor` is the 12 × 14 box world:validate-buildings checks.
        sign: { at: [137, 122] },
        beaconBase: 0.9,
        // 5.A — pane centres on the re-authored house, each fitted to its
        // pane's lit texels: the counting-house bay first (room 1), then the
        // upper band under its slate hood, the turret-side window and the
        // dormer. The tide-clock dial and the quay lantern glow in the sidecar
        // but are no room; nor is the one-texel slit beside the door.
        windowRects: [
            { at: [162, 135], w: 4, h: 12 },
            { at: [154.5, 136.5], w: 3, h: 11 },
            { at: [151.5, 104], w: 5, h: 14 },
            { at: [144, 108.5], w: 4, h: 11 },
            { at: [159, 101.5], w: 4, h: 11 },
            { at: [184.5, 88.5], w: 5, h: 9 },
            { at: [94.5, 74.5], w: 5, h: 11 },
            { at: [84, 69.5], w: 4, h: 9 },
        ],
        // Clock turret spire above the counting house (kept near the top-centre
        // of the 384x284 footprint, clear of the outer-pier signal mast; if the
        // Harbor sprite is rebuilt on the same footprint, recalibrate to the new
        // roofline/turret apex).
        pennant: { at: [176, 8] },
        // W5-B (Spec 04 §5.3, D6) — the Chart Loft: the lifted slate hood
        // over the upper storey (rooms at [151.5,104], [144,108.5],
        // [159,101.5]). W5 Fix-B (Fable P1-1/P1-2) — the cut is a sheared
        // parallelogram on the oriel's own wall slope (-0.5) holding the whole
        // hood. Two slots for agents whose current tool classifies to the
        // Harbor, a signal rack of pending-commit lanterns wholly inside the
        // cut, and no text (no legend: the buoys keep the repo names).
        aperture: {
            minZoom: HARBOR_CUTAWAY_PROFILE.minZoom,
            layers: [...CUTAWAY_LAYERS_4],
            cutaway: 'harbor',
            cut: { ...HARBOR_CUTAWAY_PROFILE.cut },
            occupant: { ...HARBOR_CUTAWAY_PROFILE.occupant },
            floor: { at: [...HARBOR_CUTAWAY_PROFILE.floor.at], slope: HARBOR_CUTAWAY_PROFILE.floor.slope },
            signalRack: HARBOR_CUTAWAY_PROFILE.signalRack,
            slots: HARBOR_CUTAWAY_PROFILE.slots.map(cutawaySlot),
        },
        // 6.4 — the stone chimney behind the gable: where its column leaves
        // the cap (ChimneySmoke; smoke only with a working visitor).
        effectAnchors: {
            smokeTop: [[140, 14]],
        },
    },
});

const WATCHTOWER_LANTERN_FIRE = BUILDING_VISUAL_REGISTRY.watchtower.effectAnchors.lanternFire;

export const BUILDING_EMITTER_FALLBACKS = {
    forge: [
        { type: 'forgeEmber', at: [73, 152], chance: 0.16, count: 1 },
        { type: 'forgeSpark', at: [104, 196], chance: 0.22, count: 2 },
    ],
    mine: [
        { type: 'mineDust', at: [76, 186], chance: 0.045, count: 1 },
        { type: 'mining', at: [70, 194], chance: 0.032, count: 1 },
    ],
    portal: [
        { type: 'portalRune', at: [156, 128], chance: 0.12, count: 1 },
        { type: 'sparkle', at: [92, 158], chance: 0.06, count: 1 },
    ],
    watchtower: [
        { type: 'forgeEmber', at: WATCHTOWER_LANTERN_FIRE.particle, stepMs: 1120, count: 1 },
    ],
    harbor: [
        { type: 'sparkle', at: [192, 45], chance: 0.014, count: 1 },
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
    forge: { at: [73, 190], color: '#ff8a33', radius: 80, overlay: 'atmosphere.light.fire-glow', fire: true },
    mine: { at: [76, 186], color: '#ffb84d', radius: 80, overlay: 'atmosphere.light.lantern-glow' },
    taskboard: { at: [124, 108], color: '#8bd7ff', radius: 42, overlay: 'atmosphere.light.lantern-glow' },
    archive: { at: [245, 178], color: '#ffcf7a', radius: 96, overlay: 'atmosphere.light.lantern-glow' },
    harbor: { at: [18, 150], color: '#ffd37a', radius: 58, overlay: 'atmosphere.light.lantern-glow' },
};

export const LIGHT_SOURCE_REGISTRY = {
    watchtower: [
        {
            kind: 'point',
            role: 'fixture',
            at: WATCHTOWER_LANTERN_FIRE.light,
            foot: WATCHTOWER_LANTERN_FIRE.foot,
            color: '#f0a850',
            fire: true,
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
// braziers); glazed flameless lanterns stay steady.
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
// W5-B (D6) — a 3-layer aperture (`aperture, interior, foreground`) or a
// 4-layer lifted-roof cutaway (`roof` first). Only Command, Archive and
// Harbor carry one (R9): the Tavern and the Forge are open fronts, the Mine
// and the Task board get nothing.
export function getBuildingApertureProfile(type) {
    const aperture = getBuildingVisual(type)?.aperture;
    if (!aperture?.cut || !Array.isArray(aperture.slots) || !aperture.slots.length) return null;
    if (!normalizeApertureLayers(aperture.layers)) return null;
    return aperture;
}

// W5-B — the back-wall base line of a cutaway, `y(x) = at[1] + slope * (x -
// at[0])` in sprite-local texels: a slot stands below it, on the floor.
export function apertureFloorY(aperture, x) {
    const floor = aperture?.floor;
    if (!Array.isArray(floor?.at)) return null;
    return floor.at[1] + (Number(floor.slope) || 0) * (x - floor.at[0]);
}

// W5-B (D6) — the open-front record (`{ profile, drawables, ... }`) or null.
export function getBuildingOpenFront(type) {
    const openFront = getBuildingVisual(type)?.openFront;
    return openFront?.profile ? openFront : null;
}

// W5-B — whether base.surface.png (`surface-v1`) ships beside base.png.
export function hasBuildingSurfaceSidecar(type) {
    return getBuildingVisual(type)?.surfaceSidecar === true;
}

// W5-B — authored AO-monotonic `{ open, crevice }` texel pairs of a surface page.
export function getBuildingSurfaceAoPairs(type) {
    const pairs = getBuildingVisual(type)?.surfaceAoPairs;
    return Array.isArray(pairs) ? pairs : [];
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

// MB-4 — the static overlay layers a rest mask stands in for (the Portal's
// `portalGlow`): they draw only while the building is awake.
export function getBuildingRestCovers(type) {
    const covers = getBuildingVisual(type)?.rest?.covers;
    return Array.isArray(covers) ? covers : [];
}

// VQ-8 — the rest mask's ember floor `{ colors, strength }`, or null: which
// of the mask's own authored colours emit, and how strongly (the emissive
// contribution, as an `authored-albedo` layer's strength).
export function getBuildingRestEmber(type) {
    const ember = getBuildingVisual(type)?.rest?.ember;
    return Array.isArray(ember?.colors) && ember.colors.length && ember.strength > 0 ? ember : null;
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

// Spec 04 §2.3 — the sign anchor: one authored sprite-local point per
// landmark on its own wall, over the door, where the Carved Motif bracket is
// bolted and the compact chit column stands. Null when a type has none.
export function getBuildingSignAnchor(type) {
    const at = getBuildingVisual(type)?.sign?.at;
    return Array.isArray(at) && at.length === 2 && at.every(Number.isFinite) ? at : null;
}

// The one footprint both the renderer (BuildingPlaques) and
// `npm run world:validate-buildings` read: a 12 × 14 texel box hung from
// `sign.at`, columns x - 6 .. x + 5 and rows y .. y + 13 — the bracket arm,
// its rings and the 10 × 10 framed board with its ink rim. The validator
// requires it >= 60 % on the building's own opaque texels, on no emissive
// texel and outside every aperture cut.
export const SIGN_BOX = Object.freeze({ dx: -6, dy: 0, w: 12, h: 14 });

export function signBoxFor(at) {
    return { left: at[0] + SIGN_BOX.dx, top: at[1] + SIGN_BOX.dy, w: SIGN_BOX.w, h: SIGN_BOX.h };
}

// W5.3 — optional attention banner geometry; only Command carries one.
export function getBuildingAttentionBanner(type) {
    const banner = getBuildingVisual(type)?.attentionBanner;
    return Array.isArray(banner?.at) && Array.isArray(banner?.drops) && banner.drops.length ? banner : null;
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

function cutawaySlot(slot) {
    return {
        id: slot.id,
        bay: slot.bay,
        at: [slot.at[0], slot.at[1]],
        pose: slot.pose,
        facing: slot.facing,
    };
}

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
