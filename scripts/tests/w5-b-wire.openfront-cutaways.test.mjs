// Wave 5-B wiring (D6, Spec 04 §5.1–5.3, Spec 03 §1.2 5.1–5.4, X-13): the
// 12 lifted-roof cutaway layers, the open-front Forge arcade, the surface-v1
// pages, and their runtime wiring in the registry, the aperture model,
// BuildingSprite and world:validate-buildings. W5 Fix-B adds the council's
// fixes: the arcade bake and its one profile, the sheared Harbor loft, the
// Archive's Loom/shelf, the peel replay, the resolved Glass target, the
// night grade, reader spill and per-repo lanterns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PNG } from 'pngjs';

import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { Building } from '../../claudeville/src/domain/entities/Building.js';
import {
    APERTURE_GLASS_DWELL_MS,
    APERTURE_LAYERS_3,
    APERTURE_LAYERS_4,
    APERTURE_MIN_ZOOM,
    apertureCutContains,
    normalizeApertureLayers,
    resolveApertureTrigger,
} from '../../claudeville/src/presentation/character-mode/BuildingApertureModel.js';
import {
    ARCHIVE_CUTAWAY_PROFILE,
    COMMAND_CUTAWAY_PROFILE,
    CutawayPeelController,
    HARBOR_CUTAWAY_PROFILE,
    warTableTexelToSprite,
} from '../../claudeville/src/presentation/character-mode/BuildingCutaways.js';
import { BuildingSprite, gradedPainterContext, resolveOpenFrontProfile } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import {
    apertureFloorY,
    BUILDING_VISUAL_REGISTRY,
    getBuildingApertureProfile,
    getBuildingOpenFront,
    getBuildingSurfaceAoPairs,
    hasBuildingSurfaceSidecar,
    isBuildingApertureLayer,
} from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
import { appendDepthSortedDrawables } from '../../claudeville/src/presentation/character-mode/DrawablePass.js';
import { FORGE_ARCH_ROWS, FORGE_OPEN_FRONT_PROFILE, OPEN_FRONT_PROFILES, parseArchRows } from '../../claudeville/src/presentation/character-mode/OpenFront.js';
import { repoProfile } from '../../claudeville/src/presentation/shared/RepoColor.js';
import { withPostcardFrame } from '../../claudeville/src/presentation/character-mode/Postcard.js';
import { buildingCenterToWorld, tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { bakeArchiveCutaway } from '../sprites/bake-cutaway-archive.mjs';
import { bakeCommandCutaway, cutawayMask, readPng } from '../sprites/bake-cutaway-command.mjs';
import { bakeHarborCutaway } from '../sprites/bake-cutaway-harbor.mjs';
import {
    FORGE_ARCADE,
    LINTEL_TOP,
    SMITH_HEIGHT_PX,
    bakeForgeOpenFront,
    readForgeFiles,
    verifyForgeBake,
} from '../sprites/bake-forge-openfront.mjs';
import {
    CUTAWAY_BUILDINGS,
    cutawayReport,
    livingPainterReport,
    openFrontReport,
    OPEN_FRONT_BUILDINGS,
    surfaceSidecarReport,
    validateCutaways,
} from '../world/validate-buildings.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPRITES = path.join(ROOT, 'claudeville/assets/sprites/buildings');
const LAYERS = ['roof', 'aperture', 'interior', 'foreground'];

function spritePng(type, name) {
    return readPng(path.join(SPRITES, `building.${type}`, name));
}

function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function recCtx() {
    const fills = [];
    const draws = [];
    const texts = [];
    return {
        fills,
        draws,
        texts,
        globalAlpha: 1,
        fillStyle: '',
        font: '',
        imageSmoothingEnabled: true,
        save() {},
        restore() {},
        translate() {},
        scale() {},
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
        setTransform() {},
        measureText: (text) => ({ width: String(text).length * 7 }),
        fillRect(x, y, w, h) { fills.push({ x, y, w, h, fill: this.fillStyle }); },
        drawImage(...args) { draws.push(args); },
        fillText(text, x, y) { texts.push({ text, x, y }); },
        strokeText(text, x, y) { texts.push({ text, x, y, stroke: true }); },
    };
}

function mockAssets({ missing = new Set() } = {}) {
    const dims = {
        'building.command': { w: 360, h: 240 },
        'building.archive': { w: 336, h: 240 },
        'building.harbor': { w: 384, h: 284 },
        'building.forge': { w: 256, h: 232 },
    };
    const anchors = {
        'building.command': [199, 164],
        'building.archive': [167, 182],
        'building.harbor': [131, 154],
        'building.forge': [128, 169],
    };
    return {
        get: (id) => (missing.has(id) ? null : { width: 1, height: 1, id }),
        getEntry: (id) => (dims[id] ? { id, layers: {}, materialClass: 'stone' } : null),
        getDims: (id) => dims[id] || null,
        getAnchor: (id) => anchors[id.split('.').slice(0, 2).join('.')] || [0, 0],
        getMask: () => null,
        getCompanion: () => null,
    };
}

function rendererWith(fields = {}) {
    const drawn = [];
    return Object.assign(Object.create(BuildingSprite.prototype), {
        assets: mockAssets(),
        sprites: { drawSprite: (ctx, id) => { drawn.push(id); return { dx: 0, dy: 0 }; } },
        drawn,
        agentSprites: [],
        buildings: [],
        _zoom: 2,
        _restZoom: 2,
        _selectedBuildingType: null,
        _deskAssignments: new Map(),
        _roomSlotsByType: new Map(),
        _apertureModel: null,
        _apertureProfile: null,
        _apertureSessions: [],
        _glassCutawayTarget: null,
        _cutawayPeel: new CutawayPeelController(),
        _cutawayPeelSnap: null,
        _cutawayPeelSerial: null,
        _cutawayRoofCache: new Map(),
        _cutawayLiving: null,
        _harborPendingRepos: [],
        _compactionRecords: [],
        _openFrontSprites: new Map(),
        _openFrontActive: new Set(),
        _partPassSerial: 1,
        motionScale: 1,
        ...fields,
    });
}

function agentSprite(id, { building = null, status = 'working', parentSessionId = null, x = 0, y = 0, extra = {} } = {}) {
    return {
        x,
        y,
        _foldBuildingType: building,
        agent: { id, name: id, status, parentSessionId, targetBuildingType: building, isDeparted: false, ...extra },
    };
}

// ─── 1. Registry, D6 scope and the aperture model ────────────────────────────

test('D6 scope: Command, Archive and Harbor carry 4-layer lifted-roof cutaways; Tavern and Forge are open fronts; Mine and Task board get nothing', () => {
    assert.deepEqual([...CUTAWAY_BUILDINGS], ['command', 'archive', 'harbor']);
    assert.deepEqual([...OPEN_FRONT_BUILDINGS], ['tavern', 'forge']);
    for (const [type, visual] of Object.entries(BUILDING_VISUAL_REGISTRY)) {
        const profile = getBuildingApertureProfile(type);
        if (CUTAWAY_BUILDINGS.includes(type)) {
            assert.ok(profile, `${type} opens`);
            assert.deepEqual(profile.layers, LAYERS, `${type} is a 4-layer cutaway`);
            assert.equal(profile.minZoom, APERTURE_MIN_ZOOM);
            for (const name of LAYERS) assert.equal(isBuildingApertureLayer(type, name), true, `${type}.${name} skips the generic layer pass`);
        } else {
            assert.equal(profile, null, `${type} has no cutaway`);
        }
        if (visual.openFront) assert.ok(OPEN_FRONT_BUILDINGS.includes(type));
    }
    assert.equal(getBuildingOpenFront('tavern').drawables, 'TavernArcade');
    assert.equal(getBuildingOpenFront('forge').drawables, 'BuildingSprite');
    assert.equal(getBuildingOpenFront('mine'), null);
    assert.equal(getBuildingOpenFront('taskboard'), null);
    assert.equal(hasBuildingSurfaceSidecar('forge'), true);
    assert.equal(hasBuildingSurfaceSidecar('command'), true);
    assert.equal(hasBuildingSurfaceSidecar('archive'), false);

    // Registry data is the BuildingCutaways profile data.
    const command = getBuildingApertureProfile('command');
    assert.deepEqual(command.cut, COMMAND_CUTAWAY_PROFILE.cut);
    assert.deepEqual(command.slots.map((slot) => [slot.id, slot.pose, slot.at]), [
        ['front-desk', 'tinker', [246, 202]],
        ['war-table', 'think', [270, 190]],
        ['rear-desk', 'gaze', [294, 177]],
    ]);
    assert.equal(command.warTable, COMMAND_CUTAWAY_PROFILE.table);
    assert.equal(command.sillBar, true);
    assert.deepEqual(getBuildingApertureProfile('archive').slots.map((slot) => slot.at), ARCHIVE_CUTAWAY_PROFILE.bays.map((bay) => bay.at));
    assert.deepEqual(getBuildingApertureProfile('harbor').slots.map((slot) => slot.id), HARBOR_CUTAWAY_PROFILE.slots.map((slot) => slot.id));
    assert.equal(getBuildingApertureProfile('harbor').legend, undefined, 'the Chart Loft adds no text');
});

test('aperture model: 3 or 4 layers, selection at z >= 2 or a 300 ms Glass dwell — never hover-peep, never zoom-auto', () => {
    assert.equal(APERTURE_MIN_ZOOM, 2);
    assert.equal(APERTURE_GLASS_DWELL_MS, 300);
    assert.deepEqual(normalizeApertureLayers(APERTURE_LAYERS_3), {
        layers: APERTURE_LAYERS_3, roof: null, aperture: 'aperture', interior: 'interior', foreground: 'foreground', hasRoof: false,
    });
    assert.equal(normalizeApertureLayers(APERTURE_LAYERS_4).roof, 'roof');
    assert.equal(normalizeApertureLayers(['a', 'b']), null);
    assert.equal(normalizeApertureLayers(['roof', 'a', 'b', 'c', 'd']), null);
    assert.equal(normalizeApertureLayers(['a', 'a', 'b']), null);

    // The shipped 3-layer stack still opens.
    const shipped = { ...BUILDING_VISUAL_REGISTRY.command.aperture, layers: [...APERTURE_LAYERS_3] };
    assert.ok(normalizeApertureLayers(shipped.layers));

    const base = { buildingType: 'archive', minZoom: 2 };
    assert.equal(resolveApertureTrigger({ ...base, selectedType: 'archive', zoom: 2 }), 'selection');
    assert.equal(resolveApertureTrigger({ ...base, selectedType: 'archive', zoom: 1.5 }), null, 'no selection below inspection zoom');
    assert.equal(resolveApertureTrigger({ ...base, zoom: 3 }), null, 'zoom alone never opens');
    assert.equal(resolveApertureTrigger({ ...base, glassType: 'archive', glassDwellMs: 299, zoom: 2 }), null, 'no hover-peep');
    assert.equal(resolveApertureTrigger({ ...base, glassType: 'archive', glassDwellMs: 300, zoom: 2 }), 'glass');
    assert.equal(resolveApertureTrigger({ ...base, glassType: 'archive', glassDwellMs: 900, zoom: 1.5 }), null);
    assert.equal(resolveApertureTrigger({ ...base, selectedType: 'archive', glassType: 'archive', glassDwellMs: 900, zoom: 2 }), 'selection');
});

// ─── 2. The 12 cutaway layers and the bakers ─────────────────────────────────

test('bakers are deterministic: in-memory bakes match the on-disk 12 layers byte-for-byte and pass every invariant', () => {
    for (const [type, bake, size] of [
        ['command', bakeCommandCutaway, [360, 240]],
        ['archive', bakeArchiveCutaway, [336, 240]],
        ['harbor', bakeHarborCutaway, [384, 284]],
    ]) {
        const result = bake();
        assert.deepEqual(result.errors, [], `${type} bake invariants`);
        assert.deepEqual(Object.keys(result.layers), LAYERS);
        const base = spritePng(type, 'base.png');
        for (const name of LAYERS) {
            const disk = spritePng(type, `${name}.png`);
            assert.deepEqual([disk.width, disk.height], size, `${type}/${name}.png size`);
            assert.ok(bytesEqual(disk.data, result.layers[name].data), `${type}/${name}.png matches the deterministic bake`);
        }
        // The roof is base.png's own crop over the cut: a closed cutaway is the shipped exterior.
        const mask = cutawayMask(getBuildingApertureProfile(type).cut, base);
        const roof = spritePng(type, 'roof.png');
        let covered = 0;
        for (let i = 0; i < mask.length; i++) {
            for (let c = 0; c < 4; c++) assert.equal(roof.data[i * 4 + c], mask[i] ? base.data[i * 4 + c] : 0);
            covered += mask[i];
        }
        assert.ok(covered > 500, `${type} cut covers the wall`);
    }
    // The CLIs agree (`--check` exits 0).
    for (const script of ['bake-cutaway-command.mjs', 'bake-cutaway-archive.mjs', 'bake-cutaway-harbor.mjs', 'bake-forge-openfront.mjs']) {
        const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/sprites', script), '--check'], {
            encoding: 'utf8',
            env: { ...process.env, NODE_NO_WARNINGS: '1' },
        });
        assert.match(out, /OK/, script);
    }
});

test('every cutaway slot lies inside its cut, below its floor line, on an opaque aperture floor texel (world:validate-buildings)', () => {
    for (const type of CUTAWAY_BUILDINGS) {
        const aperture = getBuildingApertureProfile(type);
        const report = cutawayReport(type, aperture);
        assert.deepEqual(report.errors, [], `${type} cutaway report`);
        assert.equal(report.layers, 4);
        const floor = spritePng(type, 'aperture.png');
        for (const slot of aperture.slots) {
            assert.equal(apertureCutContains(aperture.cut, slot.at[0], slot.at[1]), true, `${type} ${slot.id}`);
            assert.ok(slot.at[1] > apertureFloorY(aperture, slot.at[0]), `${type} ${slot.id} on the floor`);
            assert.equal(floor.data[(Math.floor(slot.at[1]) * floor.width + Math.floor(slot.at[0])) * 4 + 3], 255);
        }
    }
    // Lecterns sit at their bays, 12 texels toward the viewer from each lancet.
    for (const bay of ARCHIVE_CUTAWAY_PROFILE.bays) assert.equal(bay.at[1] - bay.lancetAt[1], 12);
    // The 26 x 10 war table at [270, 184] stands on Command's floor.
    const command = getBuildingApertureProfile('command');
    for (const [tx, ty] of [[0, 0], [25, 0], [0, 9], [25, 9]]) {
        const corner = warTableTexelToSprite(tx, ty);
        assert.ok(apertureCutContains(command.cut, corner.x, corner.y));
        assert.ok(corner.y > apertureFloorY(command, corner.x));
    }

    // Corruption is caught: a slot pushed outside the cut, a roof texel that
    // no longer matches base.png, a texel painted outside the cut, an aperture
    // on a building D6 keeps closed.
    const archive = getBuildingApertureProfile('archive');
    const moved = { ...archive, slots: [{ id: 'stray', at: [60, 150] }] };
    assert.ok(cutawayReport('archive', moved).errors.some((error) => /outside the cut/.test(error)));
    const tampered = (name) => {
        const png = spritePng('harbor', name);
        if (name === 'roof.png') png.data[(100 * png.width + 150) * 4] ^= 1;
        if (name === 'interior.png') png.data.set([1, 2, 3, 255], (10 * png.width + 10) * 4);
        return png;
    };
    const errors = cutawayReport('harbor', getBuildingApertureProfile('harbor'), tampered).errors;
    assert.ok(errors.some((error) => /roof\.png differs/.test(error)));
    assert.ok(errors.some((error) => /interior\.png paints 1 texel\(s\) outside the cut/.test(error)));
    const reported = [];
    validateCutaways({ error: (where, message) => reported.push(`${where}: ${message}`), warn() {} }, {
        ...BUILDING_VISUAL_REGISTRY,
        mine: { ...BUILDING_VISUAL_REGISTRY.mine, aperture: BUILDING_VISUAL_REGISTRY.command.aperture },
    });
    assert.ok(reported.some((line) => /registry\.mine\.aperture: D6/.test(line)));

    // W5 Fix-B (Fable P1-2) — every living-painter texel lies inside its cut,
    // and a painter that overhangs the cut is caught.
    for (const type of CUTAWAY_BUILDINGS) {
        const living = livingPainterReport(type, getBuildingApertureProfile(type));
        assert.deepEqual(living.errors, [], `${type} living painters inside the cut`);
        assert.ok(living.rects > 10);
    }
    const narrow = { ...getBuildingApertureProfile('harbor'), cut: { ...HARBOR_CUTAWAY_PROFILE.cut, x1: 150 } };
    assert.ok(livingPainterReport('harbor', narrow).errors.some((error) => /outside the cut/.test(error)));
});

// ─── 3. Forge open front + surface-v1 pages ─────────────────────────────────

test('the Forge open front is a two-arch arcade: the bake reproduces every file, and OpenFront holds its one profile', () => {
    const current = readForgeFiles();
    const bake = bakeForgeOpenFront(current);
    assert.deepEqual(verifyForgeBake(bake, { original: current.base }), []);
    for (const [key, raster] of Object.entries(bake.files)) {
        assert.ok(bytesEqual(current[key].data, raster.data), `building.forge ${key} matches the deterministic bake`);
    }
    // One authoritative profile: OpenFront's, named (never overridden) by the registry.
    assert.equal(OPEN_FRONT_PROFILES.forge, FORGE_OPEN_FRONT_PROFILE);
    assert.equal(FORGE_OPEN_FRONT_PROFILE.frontArchRows, bake.calibration.rows.join(''), 'OpenFront block is current');
    assert.equal(FORGE_ARCH_ROWS, FORGE_OPEN_FRONT_PROFILE.frontArchRows);
    assert.deepEqual(Object.keys(getBuildingOpenFront('forge')).sort(), ['drawables', 'profile']);
    assert.equal(resolveOpenFrontProfile(getBuildingOpenFront('forge')), FORGE_OPEN_FRONT_PROFILE);
    assert.equal(resolveOpenFrontProfile(getBuildingOpenFront('tavern')), OPEN_FRONT_PROFILES.tavern);
    assert.deepEqual(FORGE_OPEN_FRONT_PROFILE.anchor, [128, 169]);
    assert.deepEqual(FORGE_OPEN_FRONT_PROFILE.nativeSize, { width: 256, height: 232 });
    assert.deepEqual(FORGE_OPEN_FRONT_PROFILE.bays.map((bay) => bay.id), ['forge-hearth', 'forge-anvil']);

    const width = 256;
    const front = new Uint8Array(width * 232);
    for (const [y, x, length] of parseArchRows(FORGE_OPEN_FRONT_PROFILE.frontArchRows, width, 232)) {
        for (let i = x; i < x + length; i++) front[y * width + i] = 1;
    }
    // Fire, rest mask and bellows stay on the interior: the arch never covers them.
    const hearth = spritePng('forge', 'hearth.png');
    const banked = spritePng('forge', 'banked.png');
    for (let i = 0; i < front.length; i++) {
        if (hearth.data[i * 4 + 3] > 0) assert.equal(front[i], 0, 'no fire texel is front arch');
        if (banked.data[i * 4 + 3] > 0) assert.equal(front[i], 0, 'no rest texel is front arch');
    }
    // The centre pier and the lintel are front arch; both arch interiors are not.
    assert.equal(front[150 * width + 64], 1);
    assert.equal(front[120 * width + 80], 1);
    assert.equal(front[150 * width + 48], 0);
    assert.equal(front[150 * width + 80], 0);

    // Each bay: a buildings.js work slot on the open floor, inside an arch,
    // its smith's crown clear of the lintel.
    const forgeDef = BUILDING_DEFS.find((def) => def.type === 'forge');
    const forge = new Building(forgeDef);
    for (const bay of FORGE_OPEN_FRONT_PROFILE.bays) {
        const slot = forgeDef.visitTiles.find((tile) => tile.tileX === bay.tile.tileX && tile.tileY === bay.tile.tileY);
        assert.equal(slot?.role, 'work', `${bay.id} is a work slot`);
        assert.equal(forge.isOpenFloor(bay.tile.tileX, bay.tile.tileY), true, `${bay.id} is open floor`);
        assert.equal(forge.blocksWalkTile(bay.tile.tileX, bay.tile.tileY), false, `${bay.id} is walkable`);
        assert.ok(FORGE_ARCADE.openings.some((opening) => bay.at[0] >= opening.x0 && bay.at[0] <= opening.x1), `${bay.id} inside an arch`);
        assert.ok(bay.at[1] - SMITH_HEIGHT_PX >= LINTEL_TOP[bay.at[0]], `${bay.id} crown clears the lintel`);
        assert.equal(front[bay.at[1] * width + bay.at[0]], 0, `${bay.id} feet off the front arch`);
    }
    // The trough's corner and the yard anvil keep row 29 closed either side.
    assert.equal(forge.blocksWalkTile(26, 29), true);
    assert.equal(forge.blocksWalkTile(29, 29), true);

    assert.deepEqual(openFrontReport('forge', getBuildingOpenFront('forge'), undefined, BUILDING_DEFS).errors, []);
    assert.equal(openFrontReport('tavern', getBuildingOpenFront('tavern')), null, "the Tavern's drawables are TavernArcade's");
    const onPier = { ...forgeDef, visitTiles: forgeDef.visitTiles.filter((tile) => tile.tileY !== 29), openFloor: [] };
    const broken = openFrontReport('forge', getBuildingOpenFront('forge'), undefined, [onPier]).errors;
    assert.ok(broken.some((error) => /not a work visit tile/.test(error)));
    assert.ok(broken.some((error) => /not on the building's openFloor/.test(error)));
});

test('surface-v1 pages: H16 = 0 outside alpha, B <= 63, valid bit, AO monotonic pairs (Forge and Command)', () => {
    for (const type of ['forge', 'command']) {
        const report = surfaceSidecarReport(type, BUILDING_VISUAL_REGISTRY[type]);
        assert.deepEqual(report.errors, [], `${type} surface page`);
        assert.ok(report.stats.opaquePixels > 30000);
        assert.ok(getBuildingSurfaceAoPairs(type).length >= 2);
        const surface = spritePng(type, 'base.surface.png');
        for (let i = 0; i < surface.data.length; i += 4) assert.ok(surface.data[i + 2] <= 63);
    }
    assert.equal(surfaceSidecarReport('archive', BUILDING_VISUAL_REGISTRY.archive), null, 'absent and undeclared: nothing to check');
    const corrupt = (name) => {
        const png = spritePng('forge', name);
        if (name === 'base.surface.png') png.data[0] = 7; // H16 on a transparent corner texel
        return png;
    };
    assert.ok(surfaceSidecarReport('forge', BUILDING_VISUAL_REGISTRY.forge, corrupt).errors.length > 0);
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/sprites/bake-depth-channels.mjs'), '--check', '--id=building.command'], { encoding: 'utf8' });
    assert.match(out, /OK building\.command: matches on-disk base\.surface\.png/);
});

// ─── 4. BuildingSprite runtime wiring ────────────────────────────────────────

test('BuildingSprite: selection at rest zoom 2 opens a cutaway, a Glass dwell opens one after 300 ms, selection always wins', (t) => {
    let now = 10_000;
    t.mock.method(Date, 'now', () => now);
    const r = rendererWith({ _selectedBuildingType: 'archive' });
    r._updateInspection();
    assert.equal(r.getApertureModel().buildingType, 'archive');
    assert.equal(r.getApertureModel().trigger, 'selection');

    r._restZoom = 1.5;
    r._zoom = 2;
    r._updateInspection();
    assert.equal(r.getApertureModel(), null, 'the rest tier decides, not the instantaneous zoom (R1)');
    r._restZoom = 2;

    // A cutaway whose authored aperture layer has not loaded never opens.
    r.assets = mockAssets({ missing: new Set(['building.archive.aperture']) });
    r._updateInspection();
    assert.equal(r.getApertureModel(), null);
    r.assets = mockAssets();

    // Glass: no hover-peep; 300 ms dwell; reset when the lens moves.
    r._selectedBuildingType = null;
    r.setGlassCutawayTarget('harbor', now);
    r._updateInspection();
    assert.equal(r.getApertureModel(), null);
    now += 299;
    r._updateInspection();
    assert.equal(r.getApertureModel(), null);
    now += 1;
    r._updateInspection();
    assert.equal(r.getApertureModel().buildingType, 'harbor');
    assert.equal(r.getApertureModel().source, 'glass');
    r.setGlassCutawayTarget('harbor', now + 5000);
    r._updateInspection();
    assert.equal(r.getApertureModel().buildingType, 'harbor', 'the same target keeps its dwell');
    r.setGlassCutawayTarget('mine', now);
    now += 1000;
    r._updateInspection();
    assert.equal(r.getApertureModel(), null, 'the Mine never opens');
    r.setGlassCutawayTarget('harbor', now);
    r._selectedBuildingType = 'command';
    now += 400;
    r._updateInspection();
    assert.equal(r.getApertureModel().buildingType, 'command', 'a selection-opened cutaway takes priority');
    r._selectedBuildingType = 'forge';
    r._updateInspection();
    assert.equal(r.getApertureModel().buildingType, 'harbor', 'a selection without a cutaway leaves the lens free');
    r.setGlassCutawayTarget(null);
    r._updateInspection();
    assert.equal(r.getApertureModel(), null);

    // W5 Fix-B (Opus P1-1) — a resolved target from IsometricRenderer
    // (InspectionGlass already ran its dwell and exit) opens and closes at
    // once, with no second 300 ms timer.
    r._selectedBuildingType = null;
    r.setGlassCutawayTarget('archive', { resolved: true });
    r._updateInspection();
    assert.equal(r.getApertureModel()?.buildingType, 'archive', 'opens on the same frame');
    assert.equal(r.getApertureModel().trigger, 'glass');
    assert.equal(r.getApertureModel().source, 'glass');
    r.setGlassCutawayTarget(null, { resolved: true });
    r._updateInspection();
    assert.equal(r.getApertureModel(), null, 'closes on the same frame');
    // A resolved lens still needs inspection zoom.
    r._restZoom = 1;
    r.setGlassCutawayTarget('archive', { resolved: true });
    r._updateInspection();
    assert.equal(r.getApertureModel(), null);
    r._restZoom = 2;
    // The numeric second argument keeps its standalone dwell.
    r.setGlassCutawayTarget('harbor', now);
    r._updateInspection();
    assert.equal(r.getApertureModel(), null, 'a raw lens target dwells first');
});

test('BuildingSprite: the roof lifts on a 4-step 150 ms Bayer peel, once per frame, and swaps at once under reduced motion', (t) => {
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    const r = rendererWith({ _selectedBuildingType: 'command' });
    r._updateInspection();
    const steps = [];
    for (const [time, serial] of [[0, 1], [149, 2], [150, 3], [300, 4], [450, 5], [600, 6], [900, 7]]) {
        now = time;
        r._partPassSerial = serial;
        steps.push(r._cutawayPeelSnapshot().step);
    }
    assert.deepEqual(steps, [0, 0, 1, 2, 3, 4, 4]);
    // Memoized within a frame: a second read in the same serial does not advance.
    now = 5000;
    assert.equal(r._cutawayPeelSnapshot().step, 4);

    const reduced = rendererWith({ _selectedBuildingType: 'harbor', motionScale: 0 });
    reduced._updateInspection();
    now = 0;
    reduced._partPassSerial = 1;
    const snap = reduced._cutawayPeelSnapshot();
    assert.equal(snap.step, 4);
    assert.equal(snap.fullyOpen, true);

    // W5 Fix-B (Fable P1-4) — closing resets the peel: reselecting replays
    // the whole 0 -> 1 -> 2 -> 3 -> 4 lift instead of reopening fully peeled.
    r._selectedBuildingType = null;
    r._updateInspection();
    assert.equal(r._cutawayPeelSnap, null);
    r._selectedBuildingType = 'command';
    r._updateInspection();
    const replay = [];
    for (const [time, serial] of [[10_000, 20], [10_150, 21], [10_300, 22], [10_450, 23], [10_600, 24]]) {
        now = time;
        r._partPassSerial = serial;
        replay.push(r._cutawayPeelSnapshot().step);
    }
    assert.deepEqual(replay, [0, 1, 2, 3, 4], 'the reopened roof peels again');
    // Switching to another cutaway building also starts from a whole roof.
    r._selectedBuildingType = 'archive';
    r._updateInspection();
    now = 20_000;
    r._partPassSerial = 30;
    assert.equal(r._cutawayPeelSnapshot().step, 0);

    // The roof layer draws whole at step 0, a masked step 1..3, nothing at 4.
    const drawn = [];
    const roofRenderer = rendererWith({ sprites: { drawSprite: (ctx, id) => drawn.push(id) } });
    roofRenderer._cutawayRoofStep = (id, step) => ({ canvas: { id, step }, x: 228, y: 136 });
    const ctx = recCtx();
    const entry = { id: 'building.command' };
    roofRenderer._drawCutawayRoof(ctx, entry, 'roof', 0, 0, { step: 0 });
    roofRenderer._drawCutawayRoof(ctx, entry, 'roof', 0, 0, { step: 2 });
    roofRenderer._drawCutawayRoof(ctx, entry, 'roof', 0, 0, { step: 4 });
    assert.deepEqual(drawn, ['building.command.roof']);
    assert.equal(ctx.draws.length, 1);
    assert.deepEqual(ctx.draws[0][0], { id: 'building.command.roof', step: 2 });
});

test('BuildingSprite: Command draws aperture -> occupants -> interior -> war table -> foreground -> roof, one sill bar line, zero text on a postcard', (t) => {
    t.mock.method(Date, 'now', () => 0);
    const lead = agentSprite('lead', { building: 'command' });
    const children = [
        agentSprite('scout', { building: 'forge', parentSessionId: 'lead' }),
        agentSprite('scribe', { building: 'archive', parentSessionId: 'lead', status: 'error' }),
    ];
    const r = rendererWith({ _selectedBuildingType: 'command', agentSprites: [lead, ...children] });
    r._updateInspection();
    const open = r._openApertureFor({ type: 'command' });
    assert.ok(open);
    const ctx = recCtx();
    r._drawInspectionAperture(ctx, { type: 'command' }, { id: 'building.command' }, 199, 164, open);
    assert.deepEqual(r.drawn, [
        'building.command.aperture',
        'building.command.interior',
        'building.command.foreground',
        'building.command.roof', // step 0: the whole roof, peeling from the next frame
    ]);
    // The live war table: 2 pawns (an errored child lies prone, 5 x 3).
    const living = r._cutawayLivingState('command', open.model, open.profile);
    assert.equal(living.warTable.pawns.length, 2);
    assert.deepEqual(living.warTable.pawns.map((pawn) => [pawn.agentId, pawn.width, pawn.height]).sort(), [['scout', 3, 5], ['scribe', 5, 3]]);
    // The sill bar is one line through the postcard-locked legend site. W5
    // Fix-B — it counts the presented lead and its mustered crew by status:
    // the lead and the scout work, the errored scribe neither works nor waits.
    assert.deepEqual(ctx.texts.map((entry) => entry.text), ['2 WORKING · 0 WAITING']);

    const postcard = recCtx();
    withPostcardFrame(() => r._drawInspectionAperture(postcard, { type: 'command' }, { id: 'building.command' }, 199, 164, open));
    assert.equal(postcard.texts.length, 0, 'no text on a postcard frame');

    // W5 Fix-B — council-fleet: the lead polls its crew from the plaza, so no
    // session is presented at Command, yet the hall musters the plaque's
    // squad: its crew stands on the table and the sill counts real workers.
    const council = agentSprite('council', { building: null });
    const crew = ['forge', 'archive', 'harbor', 'mine'].map((building, i) => agentSprite(`crew-${i}`, {
        building, parentSessionId: 'council', status: i === 3 ? 'idle' : 'working',
    }));
    const hall = rendererWith({ _selectedBuildingType: 'command', agentSprites: [council, ...crew] });
    hall._updateInspection();
    const hallOpen = hall._openApertureFor({ type: 'command' });
    assert.equal(hallOpen.model.slots.length, 0, 'nobody presented at Command');
    const muster = hall._cutawayLivingState('command', hallOpen.model, hallOpen.profile).warTable;
    assert.equal(muster.ownerLeadId, 'council');
    assert.equal(muster.pawns.length, 4);
    assert.equal(muster.sillBar, '4 WORKING · 0 WAITING', 'the lead and its three working crew');
});

test('BuildingSprite: Archive readers stand at their bays, the shelf counts today\'s compactions; Harbor seats Harbor tools and adds no text', (t) => {
    const midday = new Date(2026, 10, 26, 12, 0, 0).getTime();
    t.mock.method(Date, 'now', () => midday);
    const reader = agentSprite('reader', {
        building: 'archive',
        extra: { repoRoot: '/r', workingSet: [{ path: 'docs/a.md', at: 1 }], compactions: [{ at: midday - 1000 }] },
    });
    const r = rendererWith({ _selectedBuildingType: 'archive', agentSprites: [reader] });
    r._observeCompaction({ kind: 'compacted', ts: midday - 5000, compactionKey: 'other:1', agentId: 'other' });
    r._observeCompaction({ kind: 'compacted', ts: midday - 5000, compactionKey: 'other:1', agentId: 'other' });
    r._observeCompaction({ kind: 'arrived', ts: midday });
    assert.equal(r._compactionRecords.length, 1, 'COMPACTED records only, deduplicated');
    r._updateInspection();
    const open = r._openApertureFor({ type: 'archive' });
    const living = r._cutawayLivingState('archive', open.model, open.profile);
    assert.equal(living.archive.compactionShelf.spines.length, 2);
    const placements = r._cutawayPlacements('archive', open.model, open.profile, living);
    const bay = living.archive.readers[0].bayIndex;
    assert.deepEqual(placements.map((p) => p.at), [ARCHIVE_CUTAWAY_PROFILE.bays[bay].at]);
    assert.equal(placements[0].height, 24);
    const ctx = recCtx();
    r._drawInspectionAperture(ctx, { type: 'archive' }, { id: 'building.archive' }, 167, 182, open);
    assert.deepEqual(ctx.texts.map((entry) => entry.text), ['1 WORKING · 0 WAITING']);
    // Wave 6's Loom of Days panel hangs on the rear wall frame when supplied.
    const panel = { width: 96, height: 72 };
    r.setArchiveLoomPanel(panel);
    r._cutawayLiving = null;
    const woven = r._cutawayLivingState('archive', open.model, open.profile);
    assert.equal(woven.archive.loomWall.panel, panel);
    const loomCtx = recCtx();
    r._drawInspectionAperture(loomCtx, { type: 'archive' }, { id: 'building.archive' }, 167, 182, open);
    assert.ok(loomCtx.draws.some((args) => args[0] === panel), 'the panel is drawn onto the rear wall');
    r.setArchiveLoomPanel(null);
    r._cutawayLiving = null;
    const bareCtx = recCtx();
    r._drawInspectionAperture(bareCtx, { type: 'archive' }, { id: 'building.archive' }, 167, 182, open);
    assert.equal(bareCtx.draws.length, 0, 'no Loom board until Wave 6 hands over a panel');
    // Opened by The Glass, the sill carries the bay names (never on a postcard).
    open.model.source = 'glass';
    const glassCtx = recCtx();
    r._drawApertureLegend(glassCtx, (x, y) => ({ x, y }), { type: 'archive' }, open.model, open.profile, living);
    assert.match(glassCtx.texts[0].text, /docs · .*everything else/);

    // Harbor: only a visitor whose current tool classifies to the Harbor takes a slot.
    const pusher = agentSprite('pusher', { building: 'harbor', extra: { currentTool: 'Bash', currentToolInput: { command: 'git push origin main' } } });
    const idler = agentSprite('idler', { building: 'harbor' });
    const harbor = rendererWith({
        _selectedBuildingType: 'harbor',
        agentSprites: [pusher, idler],
        _harborPendingRepos: [{ repo: 'a', pendingCommits: 2 }],
    });
    harbor._updateInspection();
    const harborOpen = harbor._openApertureFor({ type: 'harbor' });
    const harborLiving = harbor._cutawayLivingState('harbor', harborOpen.model, harborOpen.profile);
    assert.equal(harborLiving.harbor.signalRack.lanterns.length, 1);
    const seats = harbor._cutawayPlacements('harbor', harborOpen.model, harborOpen.profile, harborLiving);
    assert.deepEqual(seats.map((seat) => seat.slot.agentId), harborLiving.harbor.slots.filter((slot) => slot.agentId).map((slot) => slot.agentId));
    for (const seat of seats) {
        const cut = harborOpen.profile.cut;
        const top = cut.top + cut.slope * (seat.at[0] - cut.x0);
        assert.ok(seat.at[1] - seat.height >= top + 2, 'a loft body never rises out of its sheared cut');
        // On the plank floor, clear of the chart table's top.
        assert.ok(seat.at[1] > apertureFloorY(harborOpen.profile, seat.at[0]));
        const table = HARBOR_CUTAWAY_PROFILE.chartTable;
        assert.ok(Math.abs(seat.at[0] - table.at[0]) > table.width / 2, 'never stands on the chart table');
    }
    const harborCtx = recCtx();
    harbor._drawInspectionAperture(harborCtx, { type: 'harbor' }, { id: 'building.harbor' }, 131, 154, harborOpen);
    assert.equal(harborCtx.texts.length, 0, 'the Chart Loft adds no text');

    // W5 Fix-B (Fable P1-7) — branch-lane rows fold into one lantern per
    // repository, in that repository's pennant accent.
    const lanes = rendererWith({
        _selectedBuildingType: 'harbor',
        agentSprites: [pusher],
        _harborPendingRepos: [
            { project: '/work/alpha', branch: 'main', pendingCommits: 2 },
            { project: '/work/alpha', branch: 'feature/x', pendingCommits: 3 },
            { project: '/work/beta', branch: 'main', pendingCommits: 1 },
        ],
    });
    lanes._updateInspection();
    const lanesOpen = lanes._openApertureFor({ type: 'harbor' });
    const lanterns = lanes._cutawayLivingState('harbor', lanesOpen.model, lanesOpen.profile).harbor.signalRack.lanterns;
    assert.equal(lanterns.length, 2, 'one lantern per repository');
    const alpha = lanterns.find((lantern) => lantern.repo === '/work/alpha');
    assert.equal(alpha.pendingCommits, 5);
    assert.equal(alpha.color, repoProfile('/work/alpha').accent);

    // W5 Fix-B (Fable P1-6) — readers whose newest paths share a bay spill to
    // the next free bay: every presented reader is shown, up to five.
    const crowd = ['a', 'b', 'c'].map((id) => agentSprite(`reader-${id}`, {
        building: 'archive',
        extra: { repoRoot: '/r', workingSet: [{ path: 'docs/same.md', at: 1 }] },
    }));
    const archive = rendererWith({ _selectedBuildingType: 'archive', agentSprites: crowd });
    archive._updateInspection();
    const archiveOpen = archive._openApertureFor({ type: 'archive' });
    const crowdLiving = archive._cutawayLivingState('archive', archiveOpen.model, archiveOpen.profile);
    const crowdSeats = archive._cutawayPlacements('archive', archiveOpen.model, archiveOpen.profile, crowdLiving);
    assert.equal(crowdSeats.length, 3, 'no reader dropped');
    assert.equal(new Set(crowdSeats.map((seat) => seat.at.join(','))).size, 3, 'each at its own bay');
});

test('BuildingSprite: on the ungraded overlay the cutaway takes the night grade; the occupant fallback is opaque', (t) => {
    t.mock.method(Date, 'now', () => 0);
    const night = {
        exposure: 0.45, saturation: 0.7, gain: [0.6, 0.65, 0.9], lift: [0, 0, 0.02], gamma: [1, 1, 1],
        shadowTint: [0.1, 0.12, 0.2], highlightTint: [1, 1, 1], purkinje: [0, 0, 0], night: 1,
    };
    const fills = [];
    const facade = gradedPainterContext({ fillRect: () => {}, set fillStyle(v) { fills.push(v); }, get fillStyle() { return fills.at(-1); } }, night);
    facade.fillStyle = '#c8743a';
    assert.notEqual(fills[0], '#c8743a', 'a painter fill is graded');
    assert.equal(gradedPainterContext(recCtx(), null).fillRect !== undefined, true);

    const lead = agentSprite('lead', { building: 'command' });
    const r = rendererWith({ _selectedBuildingType: 'command', agentSprites: [lead], atmosphereState: { lightGrade: night } });
    r._updateInspection();
    const open = r._openApertureFor({ type: 'command' });
    const graded = [];
    r._gradedCutawayImage = (key, image, grade) => {
        graded.push(key);
        assert.equal(grade, night);
        return { graded: key };
    };
    r._ungradedOverlay = true;
    const ctx = recCtx();
    r._drawInspectionAperture(ctx, { type: 'command' }, { id: 'building.command' }, 199, 164, open);
    r._ungradedOverlay = false;
    assert.deepEqual(graded, ['building.command.aperture', 'building.command.interior', 'building.command.foreground', 'building.command.roof']);
    assert.ok(ctx.fills.every((fill) => fill.fill !== '#654629'), 'the war table oak is graded, not noon timber');

    // No resident sheet: an opaque ART_RAMPS figure, never a translucent wash.
    const fallback = recCtx();
    r._drawApertureOccupant(fallback, { x: 10, y: 40 }, { agentId: 'ghost' }, 20);
    assert.ok(fallback.fills.length >= 2);
    for (const fill of fallback.fills) assert.match(fill.fill, /^#[0-9a-f]{6}$/i, 'opaque hex fill');
});

test('BuildingSprite: Forge arch split drawables exist only while a smith stands in the bay, and sandwich them on Canvas and GPU paths', () => {
    const forgeDef = BUILDING_DEFS.find((def) => def.type === 'forge');
    const forge = new Building(forgeDef);
    const r = rendererWith({ buildings: [forge] });
    const center = buildingCenterToWorld(forge);

    // Empty bay: the shipped drawable list, no arch slices.
    r._updateOpenFrontOccupancy();
    assert.equal(r._openFrontActive.size, 0);
    const empty = r.enumerateDrawables();
    assert.ok(empty.length > 4);
    assert.equal(empty.filter((d) => d.kind === 'prop-column').length, 0);

    // A smith at the hearth bay (its work tile on the open floor).
    const bay = FORGE_OPEN_FRONT_PROFILE.bays[0];
    const bayWorld = { x: bay.at[0] - 128 + center.x, y: bay.at[1] - 169 + center.y };
    assert.deepEqual(bayWorld, tileToWorld(bay.tile.tileX, bay.tile.tileY), 'the bay is its tile');
    const smith = agentSprite('smith', { building: 'forge', x: bayWorld.x, y: bayWorld.y });
    r.agentSprites = [smith];
    r._updateOpenFrontOccupancy();
    assert.equal(r._openFrontActive.size, 1);
    assert.equal(r._openFrontActive.has('forge'), true);
    const drawables = r.enumerateDrawables();
    assert.notEqual(drawables, empty, 'the cache was rebuilt');
    const arch = drawables.filter((d) => d.kind === 'prop-column');
    assert.ok(arch.length > 4);
    for (const d of arch) {
        assert.equal(d.openFront, 'forge');
        assert.equal(d.part, 'column');
        assert.equal(d.building, undefined, 'no building/entry: occluder, emitter and hit consumers pass it by');
        assert.equal(typeof d.sprite.columnSourceSpan, 'function', 'GpuSceneBuilder.recordForProp contract');
        // W5 Fix-B — the surface-v1 binding GpuSceneBuilder reads.
        assert.equal(d.buildingType, 'forge');
        assert.equal(d.buildingId, 'building.forge');
        assert.deepEqual(d.surfaceCrop, { sx: d.column.sx, sy: 0, sw: d.column.sw, sh: 232 });
        assert.ok(d.column.sw > 0 && d.column.sx >= 0 && d.column.sx + d.column.sw <= 256);
    }
    // The crops tile the arch's span exactly once.
    const spans = arch.map((d) => [d.column.sx, d.column.sx + d.column.sw]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) assert.equal(spans[i][0], spans[i - 1][1]);
    // Sandwich: the Forge's own columns < smith < the arch column over the smith.
    const relX = bayWorld.x - arch[0].sprite.x;
    const archColumn = arch.find((d) => relX >= d.column.left && relX < d.column.right);
    assert.ok(archColumn.sortY > bayWorld.y, 'the arch lintel and piers draw over the smith');
    const own = drawables.filter((d) => d.kind === 'building-column' && d.building === forge
        && bayWorld.x >= d.column.worldLeft && bayWorld.x < d.column.worldRight);
    assert.ok(own.length === 1 && own[0].sortY < bayWorld.y, 'the smith draws over the hearth and rear interior');
    // A yard visitor right in front of the arcade (28, 30) stands in front of it.
    const yard = tileToWorld(28, 30);
    const yardColumn = arch.find((d) => yard.x - d.sprite.x >= d.column.left && yard.x - d.sprite.x < d.column.right);
    assert.ok(yardColumn.sortY < yard.y);

    // Canvas: drawDrawable draws the slice; hitTest and the GPU overlay pass skip it.
    const parts = [];
    const slice = { ...arch[0], sprite: { drawPart: (...args) => parts.push(args) } };
    r.drawDrawable(recCtx(), slice);
    assert.equal(parts.length, 1);
    assert.equal(parts[0][1], 'column');
    r._drawFunctionalOverlay = () => {};
    r._drawOccupancyPennant = () => {};
    r._drawAttentionBannerBoard = () => {};
    r._drawCarvedMotif = () => {};
    assert.doesNotThrow(() => r.drawGpuFunctionalOverlays(recCtx()));
    r.sprites.hitTest = () => false;
    assert.doesNotThrow(() => r.hitTest(bayWorld.x, bayWorld.y));

    // The depth pass takes the slice as a `prop-column` payload, like TavernArcade's.
    const target = [];
    appendDepthSortedDrawables(target, { buildingDrawables: drawables });
    const pooled = target.filter((d) => d.kind === 'prop-column');
    assert.equal(pooled.length, arch.length);
    assert.ok(pooled.every((d) => d.payload.sprite && d.payload.part === 'column' && d.payload.column));

    // The smith leaves: the shipped list returns.
    r.agentSprites = [];
    r._updateOpenFrontOccupancy();
    assert.equal(r.enumerateDrawables().filter((d) => d.kind === 'prop-column').length, 0);
});

test('postcard safety: BuildingSprite has no new text site, and the sill bar reuses _drawApertureLegend', () => {
    const source = readFileSync(path.join(ROOT, 'claudeville/src/presentation/character-mode/BuildingSprite.js'), 'utf8');
    const lines = source.split('\n');
    const owners = new Set();
    lines.forEach((line, index) => {
        if (!/\.(fillText|strokeText)\(/.test(line)) return;
        for (let i = index; i >= 0; i--) {
            const match = /^    (?:static )?(?:async )?([_a-zA-Z]\w*)\s*\([^;]*\)\s*\{\s*$/.exec(lines[i]) || /^(?:export )?function (\w+)/.exec(lines[i]);
            if (match && !['if', 'for', 'while', 'switch', 'catch'].includes(match[1])) {
                owners.add(match[1]);
                break;
            }
        }
    });
    for (const owner of ['_drawInspectionAperture', '_cutawayLivingState', '_drawCutawayRoof', '_cutawayPlacements', '_appendOpenFrontDrawables']) {
        assert.equal(owners.has(owner), false, `${owner} paints no text`);
    }
    assert.equal(owners.has('_drawApertureLegend'), true);
    const cutaways = readFileSync(path.join(ROOT, 'claudeville/src/presentation/character-mode/BuildingCutaways.js'), 'utf8');
    assert.doesNotMatch(cutaways, /\.(fillText|strokeText)\(/);
});

test('manifest patch: the integrator snippet lists every new layer and sidecar (when present)', () => {
    const patchPath = path.join(ROOT, 'agents/visual-ultimate/evidence/w5/w5-b.manifest-patch.yaml');
    let text = null;
    try {
        text = readFileSync(patchPath, 'utf8');
    } catch {
        // The patch is gitignored agent scratch; absent in CI checkouts.
    }
    if (text === null) return;
    for (const type of CUTAWAY_BUILDINGS) {
        for (const name of LAYERS) assert.match(text, new RegExp(`building\\.${type}[\\s\\S]*?${name}:`), `${type}.${name}`);
    }
    assert.match(text, /surfaceSidecar: true/);
    assert.match(text, /undersideSidecar: true/);
    // Sanity: the PNGs it names are on disk at their manifest-implied paths.
    for (const type of CUTAWAY_BUILDINGS) {
        for (const name of LAYERS) assert.ok(PNG.sync.read(readFileSync(path.join(SPRITES, `building.${type}`, `${name}.png`))).width > 0);
    }
});
