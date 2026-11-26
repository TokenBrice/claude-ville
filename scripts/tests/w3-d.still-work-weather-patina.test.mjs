import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import weather from '../../claudeville/services/villageWeather.js';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { REST_SEATS } from '../../claudeville/src/config/townPlan.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { Building } from '../../claudeville/src/domain/entities/Building.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { MarkGovernor, MarkTier, admitRoutineStatusArc, stillWorkState, formatComposingSliver } from '../../claudeville/src/presentation/character-mode/MarkGovernor.js';
import { routineStatusGate, resolveGroundMarks } from '../../claudeville/src/presentation/character-mode/AgentGroundMarks.js';
import { stillWorkRoutine, squallShelter } from '../../claudeville/src/presentation/character-mode/CrowdRoutine.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { TrailRenderer } from '../../claudeville/src/presentation/character-mode/TrailRenderer.js';
import { drawBenchPatina, tavernTableArt, TAVERN_TABLE } from '../../claudeville/src/presentation/character-mode/RestSeats.js';
import { AgentBiographyService, patinaFor } from '../../claudeville/src/application/AgentBiographyService.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

const NOW = Date.now();
const worker = { id: 'scribe', status: 'working', lastActivityAt: NOW - 130_000 };
const fixture = JSON.parse(readFileSync(new URL('./fixtures/open-meteo-london.json', import.meta.url))).hourly;

test('dense-100: twelve still workers draw their arcs in one region, leaving the full regular quota', t => {
    const image = (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
    t.after(() => { delete globalThis.document; });
    globalThis.document = { createElement: () => ({ getContext: () => ({
        createImageData: image, getImageData: (x, y, w, h) => image(w, h), putImageData() {},
    }) }) };
    const governor = new MarkGovernor();
    const expected = new MarkGovernor();
    for (const pressureLevel of [0, 1, 2, 3, 4]) {
        for (const motionScale of [0, 1]) {
            for (const g of [governor, expected]) g.beginFrame({ regionSize: 200, pressureLevel, motionScale });
            for (let i = 0; i < 12; i++) {
                const agent = i % 2 ? worker : { ...worker, pendingTool: 'Bash', pendingSince: NOW - 60_000 };
                const gate = routineStatusGate(governor, agent, 4 * i, 50, NOW);
                assert.deepEqual(gate, { draw: true, alpha: 0.78, unconditional: true });
                const marks = resolveGroundMarks({ x: i * 4, y: 50, status: agent.status, contentWidth: 28,
                    routineStatus: gate.draw, routineAlpha: gate.alpha, owner: { agent } });
                assert.match(marks.find(m => m.kind === 'working').stamp.__cvGroundKey, /\|199$/);
            }
            assert.equal(governor._regions.size, 0);
            for (let i = 0; i < 88; i++) {
                assert.deepEqual(admitRoutineStatusArc(governor, 'working', 0, 50, null),
                    expected.admit(MarkTier.WORKING, 0, 50));
            }
        }
    }
});

test('only observed silence and long shell waits qualify, and turn-sand starts at exactly two minutes', () => {
    for (const [elapsedMs, label] of [[119_999, null], [120_000, 'composing 2m0s'], [130_000, 'composing 2m10s']]) {
        const state = stillWorkState({ ...worker, plan: ['write'], lastActivityAt: NOW - elapsedMs }, NOW);
        assert.deepEqual(state, { kind: 'composing', elapsedMs, hasPlan: true, showTurnSand: label !== null });
        assert.equal(formatComposingSliver(elapsedMs), label);
    }
    for (const field of ['lastToolAt', 'statusChangedAt', 'lastSessionActivity']) {
        assert.equal(stillWorkState({ status: 'working', lastActivityAt: NaN, [field]: NOW - 30_000 }, NOW).kind, 'composing');
    }
    for (const pendingTool of ['Bash', 'shell', 'exec', 'run_command']) {
        const agent = { ...worker, pendingTool, pendingSince: NOW - 60_000 };
        assert.equal(stillWorkState(agent, NOW - 1), null);
        assert.deepEqual(stillWorkState(agent, NOW), { kind: 'watching', elapsedMs: 60_000 });
    }
    for (const agent of [{ status: 'working' }, { ...worker, lastToolAt: NOW - 29_999 },
        { ...worker, pendingTool: 'Read', pendingSince: NOW - 90_000 }, { ...worker, pendingTool: 'Bash' },
        { ...worker, isDeparted: true }, { ...worker, status: 'idle' }]) {
        assert.equal(stillWorkState(agent, NOW), null);
    }
});

test('pacing and sitting keep the id in the arrived working set and the same lit room', t => {
    const building = new Building(BUILDING_DEFS.find(b => b.type === 'archive'));
    const agent = { ...worker, lastActivityAt: NOW, targetBuildingType: building.type };
    const station = building.visitTiles[0];
    const world = new World();
    world.agents.set(agent.id, agent);
    const renderer = new BuildingSprite();
    t.after(() => renderer.dispose());
    renderer.buildings = [building];
    renderer.roomGlass.roomCount = () => 10; // The Archive's ten panes in the authored mask.
    const sprite = { agent };
    renderer.agentSprites = [sprite];
    let firstRoom;
    const tiles = new Set();
    for (const elapsed of [30_000, 38_000, 46_000, 119_999, 120_000]) {
        const routine = stillWorkRoutine(agent, NOW + elapsed, building, { station });
        assert.equal(routine.stillWorkPose, elapsed >= 120_000 ? 'sit-work' : 'pace-work');
        assert.deepEqual(routine.facingPoint, station.facingPoint);
        assert.ok(building.visitTiles.includes(routine.target));
        assert.ok(!REST_SEATS.some(s => s.tileX === routine.target.tileX && s.tileY === routine.target.tileY));
        assert.equal(routine.visitRole, 'work');
        tiles.add(routine.target);
        Object.assign(sprite, routine, tileToWorld(routine.target));
        renderer._updateVisitorCounts();
        assert.ok(renderer._workingIdsByType.get('archive').has(agent.id));
        const room = renderer._roomSlotsByType.get('archive').assignment.get(agent.id);
        assert.notEqual(room, undefined);
        firstRoom ??= room;
        assert.equal(room, firstRoom);
        assert.equal(world.getStats().working, 1);
        assert.equal(world.getStats().idle, 0);
    }
    assert.equal(tiles.size, 2);
    assert.deepEqual(stillWorkRoutine({ ...agent, pendingTool: 'Edit' }, NOW + 130_000, building,
        { station, previousPose: 'sit-work' }), { stillWorkPose: null, gait: 'run', visitRole: 'work' });
    assert.equal(stillWorkRoutine(agent, NOW + 38_000, building, { station, reducedMotion: true }).target, station);
    assert.equal(stillWorkRoutine(agent, NOW + 38_000, { ...building, type: 'tavern' }), null);
});

test('squalls recall idle sitters and strollers to nearby cover while workers and petitioners hold', () => {
    for (const [building, tileX, tileY] of [['gate', 19, 38], ['tavern', 23, 19], ['archive', 9, 16]]) {
        const position = { tileX, tileY };
        for (const visitRole of ['stroll', 'rest']) {
            const idle = { status: 'idle', visitRole, position };
            assert.equal(squallShelter(idle, { type: 'rain', intensity: 0.719 }), null);
            for (const weather of [{ type: 'storm' }, { type: 'rain', intensity: 0.72 }]) {
                const move = squallShelter(idle, weather);
                assert.equal(move.building, building);
                assert.equal(move.gait, 'run');
                assert.ok(!REST_SEATS.some(s => s.tileX === move.target.tileX && s.tileY === move.target.tileY));
                for (const status of ['working', 'waiting', 'waiting_on_user', 'errored']) {
                    assert.equal(squallShelter({ ...idle, status }, weather), null);
                }
            }
        }
    }
});

test('optional temperatures reject malformed entries independently of all seven required series', () => {
    const valid = fixture.time.map((_, i) => [-90, null, 0, 60][i % 4]);
    assert.deepEqual(weather.readHourly({ ...fixture, temperature_2m: valid }), { ...fixture, temperature_2m: valid });
    for (const bad of [undefined, [1], '0', ...[NaN, '1', Infinity, -90.01, 60.01].map(x => valid.with(0, x))]) {
        assert.deepEqual(weather.readHourly({ ...fixture, temperature_2m: bad }), { ...fixture, temperature_2m: null });
    }
    assert.equal(weather.readHourly({ ...fixture, snowfall: [], temperature_2m: valid }), null);
});

test('breath uses 0°C entry and 1°C exit, then frost or night snow for unknown forecasts', () => {
    assert.equal(weather.FREEZING_C, 0);
    assert.equal(weather.FREEZING_EXIT_C, 1);
    for (const [temperatureC, wasFreezing, expected] of [[0, false, true], [0.1, false, false],
        [0.99, true, true], [1, true, false]]) {
        assert.equal(weather.isFreezingBreathTemp({ temperatureC, wasFreezing }), expected);
    }
    for (const fallback of [{ temperatureC: null }, { temperatureC: 12, stale: true }, { temperatureC: -2, modelledSky: true }]) {
        assert.equal(weather.isFreezingBreathTemp({ ...fallback, frostQuarters: 1 }), true);
        assert.equal(weather.isFreezingBreathTemp({ ...fallback, snowBucket: 1, isNightOrDawn: true }), true);
        assert.equal(weather.isFreezingBreathTemp({ ...fallback, snowBucket: 1, wasFreezing: true }), false);
    }
});

function paintedPixels() {
    const fills = [];
    return { fills, globalAlpha: 1, save() {}, restore() {}, fillRect(x, y, w, h) {
        fills.push({ x, y, w, h, alpha: this.globalAlpha, color: this.fillStyle });
    } };
}

test('real steps leave bounded pairs that restore from trail history and fade with ground conditions', async t => {
    const rows = new Map();
    const store = {
        bulkPut: (_, batch) => structuredClone(batch).forEach(row => rows.set(row.id, row)),
        queryRange: () => structuredClone([...rows.values()].sort((a, b) => b.ts - a.ts)),
    };
    const agent = { id: 'walker' };
    const sprite = { ...tileToWorld(10, 10), moving: true, _stepLength: 2 };
    const sprites = new Map([[agent.id, sprite]]);
    const origin = new TrailRenderer({ store, sprites, surfaceAt: () => 'sand' });
    t.after(() => origin.dispose());
    const snow = { snowBucket: 1, surfaceWetness: 0.35 };
    const wet = { snowBucket: 0, surfaceWetness: 0.35 };
    origin.capture([agent], NOW, wet);
    for (const [i, conditions] of [[1, { snowBucket: 0, surfaceWetness: 0.34 }], [2, snow]]) {
        Object.assign(sprite, tileToWorld(10 + i, 10));
        origin.capture([agent], NOW + i * 1000, conditions);
    }
    sprite.moving = false;
    Object.assign(sprite, tileToWorld(15, 10));
    origin.capture([agent], NOW + 3000, snow);
    await origin.flush();
    assert.deepEqual([...rows.values()].map(s => s.footprint), ['sand', undefined, 'snow', undefined]);
    const restored = new TrailRenderer({ store, sprites, motionScale: 0 });
    t.after(() => restored.dispose());
    await restored.hydrate(NOW + 3000);
    restored.capture([], NOW + 3000, null); // Startup can precede the first sky snapshot.
    restored.capture([], NOW + 3000, snow);
    const draw = (renderer, now) => {
        const ctx = paintedPixels();
        renderer.draw(ctx, {}, {}, now);
        return ctx.fills;
    };
    const prints = draw(restored, NOW + 3000);
    assert.deepEqual(prints.map(f => f.color), [ART_RAMPS.dirt[0], ART_RAMPS.dirt[0], ART_RAMPS.slate[1], ART_RAMPS.slate[1]]);
    assert.equal(prints[2].x, Math.round(tileToWorld(12, 10).x) - 1);
    assert.ok(prints.every(f => f.w === 1 && f.h === 2 && f.alpha > 0 && f.alpha < 0.5));
    restored.capture([], NOW + 4000, { snowBucket: 0, surfaceWetness: 0.1 });
    const faded = draw(restored, NOW + 4000);
    assert.equal(faded.length, 2);
    assert.ok(faded[0].alpha < prints[0].alpha);
    restored.capture([], NOW + 5000, { snowBucket: 0, surfaceWetness: 0 });
    assert.deepEqual(draw(restored, NOW + 5000), []);
    await restored.flush();
    assert.ok([...rows.values()].every(row => !row.footprint), 'melted and dried tracks stay erased on reload');
    for (let i = 0; i < 605; i++) {
        sprite.moving = true;
        Object.assign(sprite, tileToWorld(10 + i % 5, 10));
        origin.capture([agent], NOW + (5 + i) * 1000, snow);
    }
    assert.equal(draw(origin, NOW + 610_000).length, 1200);
});

test('saturated shore takes prints without rain, swash removes them, and reduced motion adds none', async t => {
    const agent = { id: 'shore-walker' };
    const sprite = { ...tileToWorld(10, 10), moving: true, _stepLength: 1 };
    let material = 'wet-shore';
    const renderer = new TrailRenderer({ sprites: new Map([[agent.id, sprite]]), surfaceAt: () => material });
    t.after(() => renderer.dispose());
    const dryWeather = { snowBucket: 0, surfaceWetness: 0 };
    renderer.capture([agent], NOW, dryWeather);
    const paint = () => {
        const ctx = paintedPixels();
        renderer.draw(ctx, {}, {}, NOW + 3000);
        return ctx.fills;
    };
    assert.equal(paint().length, 2);
    renderer.setMotionScale(0);
    Object.assign(sprite, tileToWorld(11, 10));
    renderer.capture([agent], NOW + 1000, dryWeather);
    assert.equal(paint().length, 2);
    material = 'shallow';
    renderer.capture([], NOW + 2000, dryWeather);
    assert.deepEqual(paint(), []);
    material = 'wet-shore';
    renderer.capture([], NOW + 3000, dryWeather);
    assert.deepEqual(paint(), []);
});

test('patina exposes exactly the four approved traces at their inclusive thresholds', () => {
    for (const [count, stitches] of [[0, 0], [1, 1], [9, 1], [10, 2], [49, 2], [50, 3], [99, 3], [100, 4], [200, 4]]) {
        assert.equal(patinaFor({ errorsRecovered: count }).mendedStitches, stitches);
    }
    for (const count of [24, 25]) assert.equal(patinaFor({ commitsPushed: count }).saltCuff, count >= 25);
    const seat = REST_SEATS.find(s => s.occluder === 'tavern');
    const other = REST_SEATS.at(-1);
    for (const sits of [9, 10, 49, 50]) {
        const record = { extensions: { seats: { [other.id]: 1, [seat.id]: sits }, seatRepoColors: { [seat.id]: 5 } } };
        const patina = patinaFor(record, [{ identityKey: 'friend', tier: 'allies' }, { identityKey: 'new', tier: 'acquaintances' }]);
        assert.deepEqual(Object.keys(patina).sort(), ['allyNodEligible', 'mendedStitches', 'saltCuff', 'theirBench']);
        assert.equal(patina.allyNodEligible('friend'), true);
        assert.equal(patina.allyNodEligible('new'), false);
        assert.equal(patina.allyNodEligible('unknown'), false);
        assert.deepEqual(patina.theirBench, { seatId: seat.id, sits, hollow: sits >= 10, rune: sits >= 50, repoColorIndex: 5 });
        const ctx = paintedPixels();
        drawBenchPatina(ctx, 0, 0, other, patina.theirBench);
        assert.equal(ctx.fills.length, 0);
        drawBenchPatina(ctx, 0, 0, seat, patina.theirBench);
        assert.equal(ctx.fills.length, sits < 10 ? 0 : sits < 50 ? 1 : 4);
        const art = tavernTableArt(seat.facing);
        for (const f of ctx.fills) {
            assert.ok(Object.values(ART_RAMPS).flat().includes(f.color));
            for (let x = f.x; x < f.x + f.w; x++) for (let y = f.y; y < f.y + f.h; y++) {
                const pixel = 4 * ((TAVERN_TABLE.anchor[1] + y) * TAVERN_TABLE.width + TAVERN_TABLE.anchor[0] + x) + 3;
                assert.equal(art.back[pixel], 255);
                assert.equal(art.front[pixel], 0);
            }
        }
    }
});

test('biographies persist one sit per arrival, including a return to the same bench', async () => {
    const agent = { id: 'smith', agentName: 'Smith', provider: 'codex' };
    const seat = REST_SEATS.at(-1);
    const records = new Map();
    const service = new AgentBiographyService({ store: {
        getFounding: async () => ({ identityKey: 'founder' }),
        getBiography: key => records.get(key),
        putBiographies: rows => rows.forEach(row => records.set(row.identityKey, structuredClone(row))),
    } }).start();
    eventBus.emit('agent:added', agent);
    for (const id of [seat.id, seat.id, null, seat.id]) service.observeRestSeat(agent, id, 3);
    await service.stop();
    assert.equal(patinaFor(records.get(service.identityKeyFor(agent))).theirBench.sits, 2);
});
