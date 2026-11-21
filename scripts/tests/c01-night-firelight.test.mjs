import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import {
    GRADE_AMBIENT_FLOOR,
    applyGradeToRgb,
    evaluateGrade,
} from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { BuildingPartGates, parsePartGate } from '../../claudeville/src/presentation/character-mode/BuildingPartGates.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { getBuildingRestEmber } from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
import { RAMP_LANDMARKS } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';
import { GRADE_GLSL, lightLaysColumn } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { GRADE_WGSL } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/grade.js';
import { normalizeLightSource } from '../../claudeville/src/presentation/character-mode/LightSourceRegistry.js';
import { loadSpriteManifest } from '../sprites/manifest-utils.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLEAR = { type: 'clear', intensity: 0.18, cloudCover: 0.08 };
const STORM = { type: 'storm', intensity: 0.9, cloudCover: 0.97 };
const rgb01 = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

test('C-01 grade: velvet moonlit night hits lighter target while preserving +0.08 moon-phase step and strict diurnal arc', () => {
    // Operator decision #4: keep +0.08 full-moon exposure step unchanged.
    const newMoon = evaluateGrade({ minuteOfDay: 22 * 60, weather: CLEAR, moonFill: 0 });
    const fullMoon = evaluateGrade({ minuteOfDay: 22 * 60, weather: CLEAR, moonFill: 1 });
    assert.ok(Math.abs((fullMoon.exposure - newMoon.exposure) - 0.08) < 1e-6,
        `full-moon exposure step ${(fullMoon.exposure - newMoon.exposure).toFixed(4)} === 0.08`);

    // Operator decision #1: lighter night target (clear-2300 road[2] / grass[2] well below old ~94 washed-out grey,
    // without crushing dark grass or storm-0200).
    const noon = evaluateGrade({ minuteOfDay: 12.5 * 60, weather: CLEAR, moonFill: 0 });
    const dusk = evaluateGrade({ minuteOfDay: 18 * 60, weather: CLEAR, moonFill: 0 });
    const blue = evaluateGrade({ minuteOfDay: 19.75 * 60, weather: CLEAR, moonFill: 0.35 });
    const nightOct24 = evaluateGrade({ minuteOfDay: 23 * 60, weather: CLEAR, moonFill: 0.831 });
    const deepNight = evaluateGrade({ minuteOfDay: 2 * 60, weather: CLEAR, moonFill: 0.831 });
    const storm0200 = evaluateGrade({ minuteOfDay: 2 * 60, weather: STORM, moonFill: 0 });

    const yOf = (hex, g) => luma(applyGradeToRgb(rgb01(hex), g)) * 255;
    const roadNoon = yOf(ART_RAMPS.road[2], noon);
    const roadDusk = yOf(ART_RAMPS.road[2], dusk);
    const roadBlue = yOf(ART_RAMPS.road[2], blue);
    const roadNight = yOf(ART_RAMPS.road[2], nightOct24);
    const roadDeep = yOf(ART_RAMPS.road[2], deepNight);
    const roadStorm = yOf(ART_RAMPS.road[2], storm0200);
    assert.ok(roadNoon > roadDusk && roadDusk > roadBlue && roadBlue > roadNight && roadNight > roadDeep && roadDeep > roadStorm,
        `strict diurnal arc: ${[roadNoon, roadDusk, roadBlue, roadNight, roadDeep, roadStorm].map(v => v.toFixed(1)).join(' > ')}`);
    assert.ok(roadNight >= 78 && roadNight <= 88,
        `Oct-24 23:00 road[2] luma ${roadNight.toFixed(1)} in [78, 88] (calibrated for ~70 island mean, down from 94.4)`);
    assert.ok(fullMoon.exposure < 0.82, `full-moon night exposure ${fullMoon.exposure.toFixed(3)} < 0.82`);
    assert.ok(GRADE_AMBIENT_FLOOR <= 0.53 && GRADE_AMBIENT_FLOOR >= 0.48,
        `GRADE_AMBIENT_FLOOR ${GRADE_AMBIENT_FLOOR} in [0.48, 0.53]`);
    assert.ok(yOf(ART_RAMPS.grass[0], storm0200) >= 34,
        `storm-0200 dark grass luma ${yOf(ART_RAMPS.grass[0], storm0200).toFixed(1)} >= 34`);
});

test('C-01 Pharos gate: watchtower beacon declares gate: lamps and stays off at noon, on at night', () => {
    assert.deepEqual(parsePartGate('lamps'), { kind: 'lamps' });
    const gates = new BuildingPartGates();
    gates.update({ lampsLit: false });
    assert.equal(gates.isOpen('lamps'), false, 'BuildingPartGates.isOpen("lamps") is false when lamps are off');
    gates.update({ lampsLit: true });
    assert.equal(gates.isOpen('lamps'), true, 'BuildingPartGates.isOpen("lamps") is true when lamps burn');
    const manifest = loadSpriteManifest();
    const watchtower = manifest.buildings.find((b) => b.id === 'building.watchtower');
    assert.equal(watchtower?.layers?.beacon?.gate, 'lamps', 'watchtower beacon layer declares gate: lamps');

    const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
        assets: {
            getAnchor: () => [164, 344],
            get: (id) => (id === 'building.watchtower.beacon' ? { width: 20, height: 25 } : null),
            assetVersion: 'test',
        },
        motionScale: 1,
        atmosphereState: { clock: { minuteOfDay: 12 * 60 } },
    });
    const entry = {
        id: 'building.watchtower',
        layers: { beacon: { width: 20, height: 25, anchor: [164, 109], fixture: true, gate: 'lamps' } },
    };
    assert.equal(renderer.partDrawsFor(entry, { type: 'watchtower' }, 0, 0).length, 0, 'beacon is hidden at noon');
    renderer.atmosphereState = { clock: { minuteOfDay: 22.5 * 60 } };
    const nightDraws = renderer.partDrawsFor(entry, { type: 'watchtower' }, 0, 0);
    assert.equal(nightDraws.length, 1, 'beacon draws at night');
    assert.equal(nightDraws[0].name, 'beacon');
});

test('C-01 Tavern: arrived standing patrons light Tavern and tally on plaque; en-route walkers do neither; VQ-8 banked ember emits at night only', () => {
    assert.deepEqual(getBuildingRestEmber('tavern'), { colors: ['#d67634', '#803e22'], strength: 0.4 });
    const tavern = { id: 'b-tavern', type: 'tavern', width: 4, height: 4, position: { tileX: 20, tileY: 20 }, containsPoint: () => false };
    const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
        buildings: [tavern],
        agentSprites: [],
        _visitorCountByType: new Map(),
        _visitorStatusByType: new Map(),
        _visitorRepoByType: new Map(),
        _workingVisitorIdsByType: new Map(),
        _patronIdsByType: new Map(),
        _roomSlotsByType: new Map([['tavern', { assignment: new Map(), capacity: 4 }]]),
        plaquePatrons: new Map(),
        _spriteTilePosition: () => ({ tileX: 0, tileY: 0 }),
        _updateRoomSlots() {
            const ids = this._patronIdsByType.get('tavern') || new Set();
            const map = this._roomSlotsByType.get('tavern').assignment;
            map.clear();
            let slot = 0;
            for (const id of ids) map.set(id, slot++);
        },
    });
    const enRoute = { agent: { id: 'w1', status: 'idle' }, visitRole: 'rest', _restBuilding: 'tavern', moving: true, _holdsRestPlace: () => false, _seatedSeat: () => null };
    const stander = { agent: { id: 's1', status: 'idle' }, visitRole: 'rest', _restBuilding: 'tavern', moving: false, _holdsRestPlace: () => true, _seatedSeat: () => null };

    renderer.agentSprites = [enRoute];
    renderer._updateVisitorCounts();
    renderer._plaqueCountsByType();
    assert.equal(renderer._patronIdsByType.get('tavern')?.size ?? 0, 0, 'en-route walker is not an arrived patron');
    assert.equal(renderer.plaquePatrons.get('tavern') ?? null, null, 'en-route walker does not increment Tavern plaque');

    renderer.agentSprites = [enRoute, stander];
    renderer._updateVisitorCounts();
    renderer._plaqueCountsByType();
    assert.equal(renderer._patronIdsByType.get('tavern')?.size, 1, 'arrived standing patron lights Tavern');
    assert.equal(renderer.plaquePatrons.get('tavern')?.count, 1, 'arrived standing patron tallies on Tavern plaque');
});

test('C-01 shaders, Archive & cut leftovers: villager-only inkKeep in stepPool, Archive off RAMP_LANDMARKS with lifted stained glass, zero portal waterColumn leftovers', () => {
    // stepPool takes 9th inkGuard argument so ground/wall pools never lose lift (REVIEW.md:40)
    assert.match(GRADE_GLSL, /vec3 stepPool\([^)]*float land,\s*float inkGuard\)/, 'GLSL stepPool takes inkGuard');
    assert.match(GRADE_WGSL, /fn stepPool\([^)]*land: f32,\s*inkGuard: f32\)/, 'WGSL stepPool takes inkGuard');
    assert.ok(GRADE_GLSL.includes('mix(1.0, smoothstep(0.05, 0.14, albedoLuma), inkGuard)'), 'GLSL inkKeep gated by inkGuard');
    assert.ok(GRADE_WGSL.includes('mix(1.0, smoothstep(0.05, 0.14, albedoLuma), inkGuard)'), 'WGSL inkKeep gated by inkGuard');

    // Archive stays off RAMP_LANDMARKS (REVIEW.md:42) while its stained-glass emissive sidecar is lifted (maxA > 150)
    assert.equal(RAMP_LANDMARKS.has('archive'), false, 'Archive stays off RAMP_LANDMARKS');
    const archiveEmissive = PNG.sync.read(readFileSync(join(REPO_ROOT, 'claudeville/assets/sprites/buildings/building.archive/base.emissive.png')));
    let maxA = 0;
    for (let i = 3; i < archiveEmissive.data.length; i += 4) if (archiveEmissive.data[i] > maxA) maxA = archiveEmissive.data[i];
    assert.ok(maxA >= 160 && maxA <= 190, `Archive stained-glass emissive max alpha ${maxA} in [160, 190] (was 110)`);

    // Zero portal waterColumn leftovers (REVIEW.md:43)
    const normalized = normalizeLightSource({ id: 'p', x: 0, y: 0, waterColumn: true, role: 'point' });
    assert.equal(normalized.waterColumn, undefined, 'LightSourceRegistry has no waterColumn leftover');
    assert.equal(lightLaysColumn({ id: 'p', role: 0, waterColumn: true }), false, 'lightLaysColumn ignores cut waterColumn flag');
    assert.equal(BuildingSprite.prototype.waterColumnSources, undefined, 'BuildingSprite has no waterColumnSources leftover');
});
