import test from 'node:test';
import assert from 'node:assert/strict';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { BUILDING_DEFS, VISIT_OVERFLOW_TILES } from '../../claudeville/src/config/buildings.js';
import { APPROACH_FILES, VILLAGE_GATE } from '../../claudeville/src/config/townPlan.js';
import { AMBIENT_SCENIC_POINTS } from '../../claudeville/src/config/scenery.js';
import { Building } from '../../claudeville/src/domain/entities/Building.js';
import { createE2PilotTerrain, createSurfaceRegistry, createVillageTerrain, projectSurface,
    spillContact, supportHeight, tileCoords, VILLAGE_SURFACES as village } from '../../claudeville/src/presentation/character-mode/SurfaceProjection.js';
import { buildingCenterToWorld, pickSurfaceAtWorld, tileToWorld, tileToWorldElevated, worldToTile } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { Pathfinder } from '../../claudeville/src/presentation/character-mode/Pathfinder.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';
import { solveOrcaVelocity } from '../../claudeville/src/presentation/character-mode/CrowdOrca.js';
import { bakeGround } from '../../claudeville/src/presentation/character-mode/GroundBake.js';
import { massingFacets } from '../../claudeville/src/presentation/character-mode/ShadeField.js';
import { buildGpuWorldRecords } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';
import { hullRecords } from '../../claudeville/src/presentation/character-mode/HarborHulls.js';
import { GpuWorldRendererWebGPU, planarMirrorFoot } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRendererWebGPU.js';
import { RIPPLE_GRID_WIDTH } from '../../claudeville/src/presentation/character-mode/gpu/wgpu/WaterRippleCompute.js';

const pilot = createSurfaceRegistry(createE2PilotTerrain());

test('plan coordinates stay exact and projected picks resolve the visible plane or front face', () => {
    assert.deepEqual(worldToTile(tileToWorld(5.125, 12.75)), { tileX: 5.125, tileY: 12.75 });
    function pick(registry, u, v, id, h) {
        const p = tileToWorldElevated(u, v, id, registry);
        assert.equal(p.y, tileToWorld(u, v).y - h);
        const hit = pickSurfaceAtWorld(p.x, p.y, registry);
        assert.deepEqual([hit.surfaceId, hit.u, hit.v, hit.h], [id, u, v, h]);
        return hit;
    }
    pick(pilot, 9, 10, 0, 0);
    pick(pilot, 10.25, 10, 3, 6);
    pick(pilot, 11, 10, 2, 8);
    pick(pilot, 9, 11, 2, 8);
    for (const [x, y, h, site] of [[15, 16, 8, 'commandKeepRise'], [10, 1, 8, 'windmillKnoll'],
        [28, 10, 8, 'lighthouseHeadland'], [6, 17, 16, 'archiveTerrace'], [0, 16, 24, 'westSeaCliffs']]) {
        assert.equal(supportHeight(x, y, village), h);
        const hit = pick(village, x, y, 2, h);
        assert.equal(hit.surface.route, site);
        assert.equal(hit.surface.walk, h !== 24);
    }
    const wall = projectSurface(1.5, 14, 12);
    const face = pickSurfaceAtWorld(wall.x, wall.y);
    assert.deepEqual([face.face, face.h, face.surface.route], ['se', 12, 'westSeaCliffs']);
    pick(village, 9, 17.75, 3, 14);
    pick(village, 29, 23, 1, -1);
    assert.equal(pickSurfaceAtWorld(-10000, 2), null);
});

test('only the declared stair ends admit climbs and the cliff never becomes a spawn or route', () => {
    const grid = new Uint8Array(1600);
    for (const { tile } of pilot.surfaces) grid[tile] = 1;
    const paths = new Pathfinder(grid, { surfaceRegistry: pilot });
    assert.ok(paths._lineWalkable(9, 10, 12, 10));
    assert.equal(paths.surfaceSegmentClear(9, 11, 10, 10), false);
    const blocked = new Uint8Array(1600).fill(1);
    const full = new Pathfinder(blocked, { surfaceRegistry: village });
    assert.equal(full.isWalkable(0, 14), false);
    assert.ok(!full.walkableTiles.some(t => t.tileX === 0 && t.tileY === 14));
    assert.equal(full._lineWalkable(15, 19, 15, 20), false);
    assert.ok(full._lineWalkable(20, 19, 18, 19));
    assert.ok(full._lineWalkable(9, 20, 9, 17));
    for (const link of village.links) {
        const a = tileCoords(link.from[0]), b = tileCoords(link.to[0]);
        assert.ok(full._lineWalkable(a.tx, a.ty, b.tx, b.ty));
        assert.ok(full._lineWalkable(b.tx, b.ty, a.tx, a.ty));
    }
    blocked[21 * 40 + 14] = 0;
    full.findPath({ tileX: 12, tileY: 20 }, { tileX: 15, tileY: 20 });
    assert.equal(full.isWalkable(14, 21), false);
});

test('the sculpted live walk grid reaches all nine entrances, visit, overflow, approach and scenic slots', () => {
    const renderer = Object.create(IsometricRenderer.prototype);
    const buildings = new Map(BUILDING_DEFS.map(d => [d.type, new Building(d)]));
    const tileNoise = renderer._tileNoise.bind(renderer);
    const scenery = new SceneryEngine({ world: { buildings }, tileNoise, smoothNoise: renderer._smoothNoise.bind(renderer),
        terrainSeed: Array.from({ length: 1600 }, (_, i) => tileNoise(i % 40, Math.floor(i / 40))) });
    scenery.generateBridges();
    const paths = new Pathfinder(scenery.getWalkabilityGrid().slice(), { surfaceRegistry: village });
    const gate = VILLAGE_GATE.inside;
    paths.keepReachableFrom(gate);
    const destinations = BUILDING_DEFS.flatMap(b => [b.entrance, ...b.visitTiles, ...(VISIT_OVERFLOW_TILES[b.type] || []),
        ...(APPROACH_FILES[b.type] || [])]);
    assert.equal(buildings.size, 9);
    for (const point of [...destinations, ...AMBIENT_SCENIC_POINTS]) {
        const tile = { tileX: Math.round(point.tileX), tileY: Math.round(point.tileY) };
        assert.ok(paths.isWalkable(tile.tileX, tile.tileY), JSON.stringify(tile));
        assert.deepEqual(paths.findPath(gate, tile, scenery.getBridgeTiles()).at(-1), { ...tile, surfaceId: village.resolveLegacySurface(tile.tileX, tile.tileY).surfaceId });
    }
});

test('ORCA isolates both directions at exactly 12 art pixels, including an Archive walker above a planted body', () => {
    const agent = { x: 0, y: 0, gaitSpeed: 40, supportH: 16 };
    const other = { x: 10, y: 0, planted: true };
    for (const [h, isolated] of [[4.01, false], [4, true], [0, true], [28, true]]) {
        const velocity = [0, 0];
        const count = solveOrcaVelocity(agent, 40, 0, [{ ...other, supportH: h }], null, velocity);
        assert.equal(count === 0, isolated);
        if (isolated) assert.deepEqual(velocity, [40, 0]);
    }
});

test('D5 validates the village definition before it is published', () => {
    for (const name of ['cottage', 'toolShed', 'decorativeManor']) {
        const def = createVillageTerrain();
        def.tiles[0].surfaces[0].landmark = name;
        assert.throws(() => createSurfaceRegistry(def), /D5/);
    }
});

test('both draw paths use four 64px spillway frames at 6 Hz, and missing images are harmless', () => {
    const source = { width: 256, height: 96 };
    const host = { surfaceRegistry: village, motionScale: 1, motionTimeMs: 0, assets: { get: () => null } };
    const props = IsometricRenderer.prototype._buildTerraceProps.call(host);
    assert.deepEqual(new Set(props.map(p => p.id)), new Set(['prop.lagoonSpillway',
        'prop.terraceCorner.outer', 'prop.terraceCorner.inner', 'prop.terraceStair.se', 'prop.terraceStair.nw', 'prop.terraceStair.ne']));
    const spill = props.find(p => p.id === 'prop.lagoonSpillway');
    assert.equal(spill.terraceFrame(), null);
    spill.draw({ drawImage: assert.fail });
    host.assets.get = () => source;
    const { u, v, lip, pool } = spillContact(village.spills[0], village);
    assert.deepEqual([spill.tileX, spill.tileY], [u, v]);
    assert.equal(pool.y - lip.y, 17);
    assert.equal(village.surfaces.filter(s => s.basin === village.getSurfaceByKey(village.spills[0].upper).basin).length, 4);
    for (const [ms, frame] of [[0, 0], [166, 0], [167, 1], [334, 2], [500, 3], [667, 0]]) {
        host.motionTimeMs = ms;
        const f = spill.terraceFrame();
        assert.equal(f.sx, frame * 64);
        assert.deepEqual([f.x + 32, f.y + 82], [pool.x, pool.y]);
        spill.drawCached({ drawImage: (...args) => assert.deepEqual(args, [source, f.sx, 0, 64, 96, f.x, f.y, 64, 96]) });
        const [record] = buildGpuWorldRecords({}, { drawables: [{ kind: 'prop', payload: { sprite: spill } }] });
        assert.equal(record.sx, f.sx);
        assert.equal(record.sourceWidth, 256);
        assert.equal(record.width, 64);
    }
    host.motionScale = 0; host.motionTimeMs = 500;
    assert.equal(spill.terraceFrame().sx, 0);
});

test('the frontier spillway feeds only its wet splash cell, bounded to the 30 Hz solver', () => {
    const { pool: splash } = spillContact(village.spills[0], village);
    const impulses = [];
    const pass = { queueImpulse: i => impulses.push(i), encode() {} };
    const boundary = new Uint8Array(4 * RIPPLE_GRID_WIDTH * 8);
    boundary[4 * (RIPPLE_GRID_WIDTH * 2 + 3)] = 255;
    const host = { _frontierPasses: new Map([['ripples', { pass }]]), _waterInputs: { boundaryUploaded: true, boundary,
        rippleOrigin: [splash.x - 3, splash.y - 2], rippleScale: 1, spillwaySplashes: [splash] } };
    const step = (reducedMotion = false) => GpuWorldRendererWebGPU.prototype._encodeRipples.call(host, {}, [], {}, { reducedMotion }, 1 / 60);
    step(); step(); step(); step(); step(true);
    assert.deepEqual(impulses.map(i => [i.kind, i.x, i.y]), [['spillway', 3, 2], ['spillway', 3, 2]]);
    boundary.fill(0);
    step(); step();
    assert.equal(impulses.length, 2);
});

test('lifted props, building geometry and agent records carry their support once', () => {
    const archive = BUILDING_DEFS.find(b => b.type === 'archive');
    const plan = buildingCenterToWorld(archive, null), foot = buildingCenterToWorld(archive);
    const h = plan.y - foot.y;
    assert.equal(h, 16);
    const assets = { get: () => ({ width: 32, height: 48 }), getAnchor: () => [16, 40] };
    const prop = { id: 'shrub', x: 0, y: 80, supportH: 8, _getCachedCanvas: () => ({ canvas: { width: 8, height: 8 }, x: 0, y: 72 }) };
    const actor = { x: 0, y: 96, _placeY: 80, _currentBridgeLift: () => h,
        _gpuFrameRecord: { id: 'actor', x: 0, y: 70, width: 8, height: 10 } };
    const records = buildGpuWorldRecords({ assets, surfaceRegistry: village }, { drawables: [
        { kind: 'building', entry: { id: 'building.archive' }, building: archive, wx: foot.x, wy: foot.y },
        { kind: 'agent', payload: actor }, { kind: 'prop', payload: { sprite: prop } }] });
    const building = records.find(r => r.id.startsWith('building.archive'));
    assert.equal(building.supportH, h);
    assert.equal(building.y, foot.y - 40);
    assert.equal(records.find(r => r.id === 'actor').supportH, h);
    assert.equal(records.find(r => r.id.startsWith('prop:shrub')).supportH, 8);
    const [facet] = massingFacets({ solids: [{ kind: 'box', at: [0, 0, 1, 1], top: 32 }] }, archive, plan, h);
    assert.equal(facet.base, 16); assert.equal(facet.top, 48);
});

test('Evensong changes only a present standing idle villager’s facing goal', () => {
    const archive = new Building(BUILDING_DEFS.find(d => d.type === 'archive'));
    const renderer = Object.create(IsometricRenderer.prototype);
    Object.assign(renderer, { world: { buildings: new Map([['archive', archive]]) }, motionScale: 0 });
    const poses = [{}, { moving: true }, { chatting: true }, { _seatedSeat: () => ({ id: 'bench' }) },
        { animState: 'strike' }, { isArrivalPending: () => true }, { departed: true }];
    const calls = [];
    const sprites = poses.map((pose, i) => ({ ...tileToWorld(24, 30), animState: 'idle',
        agent: { id: String(i), isDeparted: pose.departed }, _setFacingGoal: dir => calls.push([i, dir]), ...pose }));
    renderer._syncWave3LiveSystems([], sprites, 0);
    assert.deepEqual(calls, []);
    renderer._evensongActive = true;
    renderer._syncWave3LiveSystems([], sprites, 0);
    assert.deepEqual(calls, [[0, 4]]); // North toward the Archive bell.
});

test('ground bake retains opaque ashlar courses at the raised Archive front', t => {
    let pixels;
    globalThis.ImageData = class { constructor(w, h) { this.data = new Uint8ClampedArray(w * h * 4); } };
    globalThis.document = { createElement: () => ({ getContext: () => ({ putImageData: img => { pixels = img.data; } }) }) };
    t.after(() => { delete globalThis.document; delete globalThis.ImageData; });
    const r = { surfaceRegistry: village, _coastField: { key: '0:0:0:0:0:0', signedDistance: () => -9 },
        townSquareTiles: new Set(), world: { buildings: new Map() }, scenery: { getTreeProps: () => [] } };
    bakeGround(r);
    const stops = new Set();
    for (const [tx, ty, dx] of [[8, 18, -12], [9, 16, 12]]) {
        const center = tileToWorld(tx, ty);
        const edge = Math.ceil(center.y + 16 - Math.abs(dx + 0.5) / 2 - 0.5);
        for (let y = edge - 16; y < edge; y++) {
            const i = 4 * ((y + 16) * 2560 + center.x + dx + 1280);
            assert.equal(pixels[i + 3], 255);
            stops.add('#' + Buffer.from(pixels.subarray(i, i + 3)).toString('hex'));
        }
    }
    assert.deepEqual(stops, new Set([1, 2, 3, 4, 5, 6].map(i => ART_RAMPS.ashlar[i])));
});

test('paths and reverse sink fields preserve both surface endpoints of directed stairs', () => {
    const def = createE2PilotTerrain();
    def.links[0].bidirectional = def.links[1].bidirectional = false;
    const registry = createSurfaceRegistry(def);
    const grid = new Uint8Array(1600);
    for (const surface of registry.surfaces) grid[surface.tile] = 1;
    const paths = new Pathfinder(grid, { surfaceRegistry: registry });
    const low = { tileX: 9, tileY: 10, surfaceId: 0 };
    const ground = { tileX: 9, tileY: 11, surfaceId: 0 };
    const deck = { ...ground, surfaceId: 2 };
    const high = { tileX: 11, tileY: 10, surfaceId: 2 };
    assert.equal(paths.surfaceSegmentClear(9, 10, 9, 11, 0, 2), false);
    for (const goal of [ground, deck, high, low]) {
        paths.setSinkTiles(0, [goal]);
        for (const start of [ground, deck, high, low]) {
            const reachable = start.surfaceId === goal.surfaceId && start.tileX === goal.tileX
                || start !== deck && start !== high && goal !== deck;
            const route = paths.findPath(start, goal);
            assert.equal(route.length > 0, reachable, JSON.stringify([start, goal]));
            if (reachable) assert.deepEqual(route.at(-1), goal);
            const cost = paths.sinkCostAt(0, start.tileX, start.tileY, start.surfaceId);
            assert.equal(Number.isFinite(cost), reachable);
            if (start !== goal) assert.equal(paths.sampleFlowDirection(0, start.tileX, start.tileY, null, start.surfaceId) >= 0, reachable);
        }
    }
    paths.setSinkTiles(0, [high]);
    assert.ok(Math.abs(paths.sinkCostAt(0, 9, 10, 0) - 2 * Math.hypot(1, 4 / 32)) < 1e-5);
    assert.deepEqual(paths.findPath(low, { tileX: 9, tileY: 11 }).at(-1), ground);
});

test('mouse and touch respect an opaque wall and implicit water has no selectable ground', () => {
    const wall = projectSurface(1.5, 14, 12);
    const wet = projectSurface(22, 22, -1);
    const hit = pickSurfaceAtWorld(wet.x, wet.y, village, new Set(['22,22']));
    assert.deepEqual([hit.surfaceId, hit.h, hit.selectableId], [1, -1, null]);
    const body = { x: wall.x, y: wall.y + 1, agent: { id: 'behind' }, isArrivalPending: () => false };
    const host = Object.assign(Object.create(IsometricRenderer.prototype), {
        surfaceRegistry: village, agentSprites: new Map([['behind', body]]),
        camera: { zoom: 1, stopFollow() {}, followAgent: assert.fail }, _invalidateIdleFrame() {}, _closeFleetCard() {},
        _isGateTransit: () => false,
    });
    for (const touch of [false, true]) {
        body.hitTest = () => !touch;
        host._handleClick(wall.x, wall.y, touch);
        assert.equal(body.selected, false);
    }
});

test('static obstacles below a terrace affect only walkers on their elevation', () => {
    const walker = { x: 0, y: 0, gaitSpeed: 40, supportH: 16 };
    const obstacle = { x: 9, y: 0, radius: 8, supportH: 0 };
    const solve = () => solveOrcaVelocity(walker, 40, 0, [], [obstacle], [0, 0]);
    assert.equal(solve(), 0);
    obstacle.allTiers = true;
    assert.ok(solve() > 0);
    obstacle.allTiers = false;
    obstacle.supportH = 16;
    assert.ok(solve() > 0);
});

test('Frontier resolves a walker crossing the Archive face in either draw order and samples the real spillway',
    { skip: !process.env.CLAUDEVILLE_TEST_FRONTIER_GPU, timeout: 180000 }, async () => {
        const { launchBenchBrowser, openWorld, resolveServer } = await import('../smoke/support/world-bench.mjs');
        const server = await resolveServer();
        let browser;
        try {
            browser = await launchBenchBrowser();
            const { page, errors } = await openWorld(browser, { baseUrl: server.baseUrl, scenario: 'readme-showcase',
                width: 1440, height: 900, query: { renderer: 'webgpu', frontier: 1 } });
            await page.evaluate(() => window.__claudeVilleApp.renderer.gpuWorld.qualityLadder.setOverride(0));
            await page.waitForFunction(() => window.__claudeVilleApp.renderer.gpuWorld._waterInputs?.boundaryUploaded,
                null, { timeout: 60000 });
            const result = await page.evaluate(async () => {
                const { prepareGpuWorldWebGPU, createGpuWorldRendererWebGPU } = await import('/src/presentation/character-mode/gpu/GpuWorldRendererWebGPU.js');
                const { terrainPlaneTexture } = await import('/src/presentation/character-mode/gpu/GpuSceneBuilder.js');
                const { projectSurface, VILLAGE_SURFACES } = await import('/src/presentation/character-mode/SurfaceProjection.js');
                const { RIPPLE_GRID_WIDTH } = await import('/src/presentation/character-mode/gpu/wgpu/WaterRippleCompute.js');
                const water = window.__claudeVilleApp.renderer.gpuWorld._waterInputs;
                const [impact] = water.spillwaySplashes;
                const [ox, oy, width] = water.planarRect;
                const wet = water.mask[(impact.y - oy) * width + impact.x - ox];
                const rx = Math.floor((impact.x - water.rippleOrigin[0]) * water.rippleScale);
                const ry = Math.floor((impact.y - water.rippleOrigin[1]) * water.rippleScale);
                const boundary = water.boundary[4 * (ry * RIPPLE_GRID_WIDTH + rx)];
                const prepared = await prepareGpuWorldWebGPU();
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 8;
                const w = createGpuWorldRendererWebGPU({ ...prepared, canvas, frontierEnabled: true });
                try {
                    w.setFrontierConfig({ ripples: false, mirror: false, wind: false, shafts: false });
                    const probe = projectSurface(8, 18.5, 8);
                    const x = probe.x - 4, y = probe.y - 4;
                    const record = (id, color) => {
                        const source = new OffscreenCanvas(8, 8);
                        const c = source.getContext('2d');
                        c.fillStyle = color;
                        c.fillRect(0, 0, 8, 8);
                        return { id, textureKey: id, source, sourceWidth: 8, sourceHeight: 8, x, y, width: 8, height: 8,
                            footY: probe.y, depthSortY: probe.y, pageable: false };
                    };
                    const face = { ...record('terrain:static', '#0066ff'), terrainPlanes: terrainPlaneTexture(VILLAGE_SURFACES),
                        surfaceOffset: VILLAGE_SURFACES.heightRange };
                    const groundWalker = { ...record('walker', '#ff2200'), writesDepth: true, supportH: 0, sublayerRank: 7 };
                    const raisedWalker = { ...groundWalker, supportH: 16 };
                    const draw = (records, level = 0) => w.render({ records, camera: { x: -x, y: -y, zoom: 1 },
                        feed: { reducedMotion: true, timeMs: 0, atmosphere: { lunarTide: { level } } }, forceFreshOutput: true });
                    for (let i = 0; i < 300; i++) {
                        draw([face, raisedWalker]);
                        if (w.getDiagnostics().frontier.featureMask === 4) break;
                        await new Promise(resolve => setTimeout(resolve, 16));
                    }
                    if (w.getDiagnostics().frontier.featureMask !== 4) throw Error(JSON.stringify(w.getDiagnostics().frontier.passes.surfaceDepth));
                    const pixel = async records => {
                        draw(records);
                        return Array.from((await w.debugCaptureTargets()).scene.slice(144, 148));
                    };
                    const colors = [];
                    for (const walker of [groundWalker, raisedWalker]) {
                        colors.push(await pixel([face, walker]), await pixel([walker, face]));
                    }
                    const tides = [-2, 0, 2].map(level => {
                        draw([face], level);
                        return w._frameState.basinParams[0];
                    });
                    return { colors, tides, wet, boundary, face: await pixel([face]), walker: await pixel([raisedWalker]) };
                } finally { w.dispose(); }
            });
            assert.ok(result.wet && result.boundary, JSON.stringify(result));
            assert.deepEqual(result.tides, [-2, 0, 2]);
            assert.notDeepEqual(result.face, result.walker);
            assert.deepEqual(result.colors, [result.face, result.face, result.walker, result.walker]);
            assert.deepEqual(errors, []);
        } finally { await browser?.close(); await server.stop(); }
    });

test('the planar mirror meets the actual moored hull lip at low, mean and high tide', () => {
    const strip = { image: { width: 32, height: 24 }, frameWidth: 32, anchorX: 16, anchorY: 20 };
    for (const level of [-2, 0, 2]) {
        const [hull] = hullRecords({ id: 'moored', strip, x: 200, y: 830, frame: 0, tide: level, reflect: false });
        const lip = hull.y + hull.height - 1;
        const height = planarMirrorFoot(hull, level) - lip;
        assert.equal(lip, 830 - level);
        assert.equal(lip + 2 * (height - level), lip);
    }
});

test('Chronicle trail samples persist the selected floor on an overlapping tile', async () => {
    const agent = { id: 'walker', position: { tileX: 9, tileY: 11, surfaceId: 0 } };
    const sprite = { ...tileToWorld(9, 11), _surfaceIdAt: () => 2 };
    const writes = [];
    const host = Object.assign(Object.create(IsometricRenderer.prototype), {
        world: { agents: new Map([[agent.id, agent]]) }, agentSprites: new Map([[agent.id, sprite]]),
        chronicleStore: { bulkPut: async (name, batch) => writes.push(...batch) },
    });
    host._ensureTrailRenderer();
    host.trailRenderer._capturePositions([agent], 1000);
    await host.trailRenderer.flush();
    assert.deepEqual(writes.map(p => [p.tileX, p.tileY, p.surfaceId]), [[9, 11, 2]]);
});
