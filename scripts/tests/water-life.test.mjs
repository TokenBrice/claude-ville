import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AMBIENT_EVENT_KINDS,
    AMBIENT_TIERS,
    buildAmbientSchedule,
    createAmbientScheduler,
} from '../../claudeville/src/presentation/character-mode/AmbientEvents.js';
import { OCEAN_HORIZON_WORLD_Y, distantShowerFront, squallApproach } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import {
    FAR_SEA_STATIONS,
    HORIZON_BAND_ROWS,
    HORIZON_LIFE_KINDS,
    drawHorizonLife,
    horizonLifeStamps,
} from '../../claudeville/src/presentation/character-mode/HorizonLife.js';
import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import {
    WildlifeRenderer,
    dabbleAt,
    duckAshoreShare,
    duckPoint,
    fishSchoolPoint,
    heronPose,
    heronRelocation,
} from '../../claudeville/src/presentation/character-mode/WildlifeRenderer.js';
import { createAtmosphereSnapshot } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';
import { CALM_WATER_FAUNA, HERON_SHALLOWS, MARINE_FISH_SCHOOLS, SHORE_FAUNA } from '../../claudeville/src/config/scenery.js';

const FAIR = Object.freeze({ type: 'clear', nextType: 'clear', cloudCover: 0.1, transitionProgress: 0.4, precipitation: 0 });
const FRONT = Object.freeze({ type: 'partly-cloudy', nextType: 'overcast', cloudCover: 0.5, transitionProgress: 0.3, precipitation: 0 });
const DAY = Object.freeze({ weather: FAIR, phase: 'day', season: 'summer', motionScale: 1, level: 0, calm: false });
const NEW_KINDS = ['heron-relocation', 'far-gull-wisp', 'distant-shower', 'whale-spout', 'dolphin-pod'];

function daySweep(scheduler, date, ctx) {
    const schedule = buildAmbientSchedule(date);
    const seen = [];
    for (let t = schedule.dayStartMs; t < schedule.dayEndMs; t += 10000) {
        const r = scheduler.at(t, ctx);
        for (const tier of AMBIENT_TIERS) if (r[tier]) seen.push(`${tier}:${r[tier].kind}:${r[tier].startMs}`);
    }
    return seen;
}

test('the new kinds are live, scheduled deterministically and only when their gates allow', () => {
    const ids = AMBIENT_EVENT_KINDS.filter(kind => kind.live).map(kind => kind.id);
    for (const id of NEW_KINDS) assert.ok(ids.includes(id), id);
    const date = new Date(2026, 6, 14);
    const fair = daySweep(createAmbientScheduler(), date, DAY);
    assert.deepEqual(fair, daySweep(createAmbientScheduler(), date, DAY), 'same date, same events');
    const kindsSeen = new Set(fair.map(entry => entry.split(':')[1]));
    for (const id of ['far-gull-wisp', 'heron-relocation']) assert.ok(kindsSeen.has(id), `fair day runs ${id}`);
    assert.ok(!kindsSeen.has('distant-shower'), 'no shower without a front');

    const front = new Set(daySweep(createAmbientScheduler(), date, { ...DAY, weather: FRONT }).map(entry => entry.split(':')[1]));
    assert.ok(front.has('distant-shower'), 'a front brings the distant shower');
    assert.ok(!front.has('whale-spout') && !front.has('dolphin-pod'), 'whales and dolphins keep to calm seas');

    const scheduler = createAmbientScheduler();
    const start = new Date(2026, 6, 14, 9).getTime();
    for (let t = start; t < start + 6 * 3600000; t += 10000) {
        const night = scheduler.at(t, { ...DAY, phase: 'night' });
        for (const tier of AMBIENT_TIERS) {
            assert.ok(!['far-gull-wisp', 'whale-spout', 'dolphin-pod', 'heron-relocation'].includes(night[tier]?.kind));
        }
        const reduced = scheduler.at(t, { ...DAY, motionScale: 0 });
        for (const tier of AMBIENT_TIERS) assert.equal(reduced[tier], null);
        const storm = scheduler.at(t, { ...DAY, weather: { ...FAIR, type: 'storm', cloudCover: 0.95 } });
        assert.equal(storm.frequent, null);
        assert.notEqual(storm.occasional?.kind, 'heron-relocation');
    }
});

test('a whale is offered at most twice a day and rare slots stay within 3/day', () => {
    for (let day = 0; day < 120; day++) {
        const schedule = buildAmbientSchedule(new Date(2026, 0, 1 + day));
        assert.ok(schedule.rare.length <= 3);
        const whales = schedule.rare.filter(slot => slot.order.some(kind => kind.id === 'whale-spout')).length;
        const pods = schedule.rare.filter(slot => slot.order.some(kind => kind.id === 'dolphin-pod')).length;
        assert.ok(whales <= 2 && pods <= 2, `day ${day}: ${whales} whales, ${pods} pods`);
    }
});

test('the distant shower window contains the squall window and adds approaching overcast', () => {
    let squall = 0;
    let shower = 0;
    // The squall's own window (a rain or storm knot ahead) is wholly inside
    // the shower's; an overcast knot ahead qualifies the shower alone.
    for (const [type, nextType, rate] of [['partly-cloudy', 'rain', 0.3], ['clear', 'storm', 0.1], ['overcast', 'rain', 0.05], ['clear', 'overcast', 0], ['partly-cloudy', 'overcast', 0]]) {
        for (let p = 0; p < 1; p += 0.002) {
            const weather = { type, nextType, transitionProgress: p, precipitation: rate * p };
            if (squallApproach(weather)) {
                squall++;
                assert.ok(distantShowerFront(weather), `${type}→${nextType} at ${p}`);
            }
            if (distantShowerFront(weather)) shower++;
        }
    }
    assert.ok(squall > 0 && shower >= 3 * squall, `${shower} vs ${squall}`);
    assert.ok(distantShowerFront({ type: 'clear', nextType: 'overcast', transitionProgress: 0.7 }));
    assert.ok(!distantShowerFront({ type: 'rain', nextType: 'storm', transitionProgress: 0.1, precipitation: 0.5 }));
    assert.ok(!distantShowerFront({ type: 'overcast', nextType: 'overcast', transitionProgress: 0.5 }));
    assert.ok(!distantShowerFront({ type: 'fog', nextType: 'rain', transitionProgress: 0.1, precipitation: 0.01 }));
});

// The live island: the renderer's own terrain noise, so every station is
// checked against the water the village actually draws.
const noise = Object.create(IsometricRenderer.prototype);
const terrainSeed = [];
for (let y = 0; y < MAP_SIZE; y++) for (let x = 0; x < MAP_SIZE; x++) terrainSeed.push(noise._tileNoise(x, y));
const scenery = new SceneryEngine({
    world: null,
    terrainSeed,
    tileNoise: (x, y) => noise._tileNoise(x, y),
    smoothNoise: (x, y, scale) => noise._smoothNoise(x, y, scale),
});
scenery.generateBridges();
const water = scenery.getWaterTiles();
const deep = scenery.getDeepWaterTiles();
const lagoon = scenery.getLagoonWaterTiles();
const shore = scenery.getShoreTiles();
const bridges = scenery.getBridgeTiles();
const keyOf = point => `${Math.floor(point.tileX)},${Math.floor(point.tileY)}`;
const isWater = key => water.has(key) && !bridges.has(key);

test('every duck step is on open water or its own bank', () => {
    const point = { tileX: 0, tileY: 0 };
    CALM_WATER_FAUNA.forEach((duck, index) => {
        const bankKey = keyOf(duck.bank);
        assert.ok(shore.has(bankKey) && !water.has(bankKey), `duck ${index} bank ${bankKey} is a shore tile`);
        const [bx, by] = bankKey.split(',').map(Number);
        assert.ok([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => isWater(`${bx + dx},${by + dy}`)), `duck ${index} bank touches water`);
        for (let lap = 0; lap < 1; lap += 0.01) {
            const motionMs = lap * duck.lapS * 1000;
            for (let cover = 0; cover <= 1.0001; cover += 0.1) {
                const key = keyOf(duckPoint(duck, index, { motionMs, cover }, point));
                assert.ok(isWater(key), `duck ${index} lap ${lap.toFixed(2)} cover ${cover.toFixed(1)} on ${key}`);
            }
            for (let ashore = 0; ashore <= 1.0001; ashore += 0.025) {
                const key = keyOf(duckPoint(duck, index, { motionMs, ashore }, point));
                assert.ok(isWater(key) || key === bankKey, `duck ${index} ashore ${ashore.toFixed(3)} on ${key}`);
            }
        }
        assert.equal(keyOf(duckPoint(duck, index, { ashore: 1 }, point)), bankKey);
    });
    let beats = 0;
    for (let t = 0; t < 24 * 3600000; t += 100) {
        const dabble = dabbleAt(t);
        if (!dabble) continue;
        beats++;
        assert.ok(dabble.dip.every(dip => dip >= 0 && dip <= 2));
    }
    assert.ok(beats > 0, 'ducks dabble now and then');
});

// A WildlifeRenderer over the live water, recording what each duck draws:
// 'swim' (the whole frame), 'bank' (reflection cropped) or 'sleep' (head
// tucked onto the back), at its world point.
function duckPoses(renderer, atmosphere, frameNow) {
    renderer.host._lastAtmosphere = atmosphere;
    renderer._sceneFrameNow = frameNow;
    const poses = [];
    const ctx = {
        globalAlpha: 1,
        fillStyle: '',
        save() {},
        restore() {},
        fillRect() {},
        drawImage(img, sx, sy, sw, sh, dx, dy) {
            if (img.id !== 'prop.duck') return;
            if (sx === 10) poses.at(-1).pose = 'sleep';
            else poses.push({ pose: sy > 0 ? 'body' : 'bank', x: dx + 16, y: dy + 24 - sy });
        },
    };
    renderer.host.sprites.drawSprite = (_ctx, id, x, y) => {
        if (id === 'prop.duck') poses.push({ pose: 'swim', x, y });
    };
    renderer.drawWaterfowl(ctx);
    return poses;
}

test('pinned dusk and night hours bring every duck to its bank and to sleep', () => {
    const art = { 'prop.duck': { id: 'prop.duck', width: 32, height: 32 }, 'prop.heron': { id: 'prop.heron', width: 32, height: 48 } };
    const renderer = new WildlifeRenderer({
        sprites: { drawSprite() {} },
        assets: { get: id => art[id], getAnchor: id => (id === 'prop.duck' ? [16, 24] : [16, 42]) },
        _getVisibleTileBounds: () => ({ startX: 0, startY: 0, endX: MAP_SIZE, endY: MAP_SIZE }),
        waterTiles: water,
        deepWaterTiles: deep,
        shoreTiles: shore,
        bridgeTiles: bridges,
        motionScale: 1,
        motionTimeMs: 4321000,
        waterFrame: 0,
        ambientEvents: null,
    });
    // QA's path: a noon frame, then the hour pinned forward 16 ms later.
    const at = hour => createAtmosphereSnapshot({ now: new Date(2026, 9, 9, 12, 0), hourOverride: hour, weatherOverride: 'clear', timelineMode: 'fixed' });
    const bankOf = duck => ({ x: (duck.bank.tileX - duck.bank.tileY) * 32, y: (duck.bank.tileX + duck.bank.tileY) * 16 });
    const noon = duckPoses(renderer, at(12), 1000);
    assert.equal(noon.length, CALM_WATER_FAUNA.length);
    assert.ok(noon.every(duck => duck.pose === 'swim'), 'ducks paddle at noon');
    for (const [hour, pose] of [[19.9, 'bank'], [23.5, 'sleep'], [2, 'sleep']]) {
        const atmosphere = at(hour);
        assert.equal(duckAshoreShare(atmosphere.phase, atmosphere.phaseProgress), 1, `ashore at ${hour}`);
        const drawn = duckPoses(renderer, atmosphere, hour === 19.9 ? 1016 : 1032);
        assert.equal(drawn.length, CALM_WATER_FAUNA.length, `every duck drawn at ${hour}`);
        drawn.forEach((duck, index) => {
            const bank = bankOf(CALM_WATER_FAUNA[index]);
            assert.equal(duck.pose, pose, `duck ${index} at ${hour}`);
            // Whole-texel placement, the sleeping body settled one texel.
            assert.ok(Math.abs(duck.x - bank.x) <= 1 && Math.abs(duck.y - bank.y) <= 2, `duck ${index} on its bank at ${hour}`);
        });
    }
    // Reduced motion snaps to the same end state.
    renderer.host.motionScale = 0;
    assert.ok(duckPoses(renderer, at(23.5), 1048).every(duck => duck.pose === 'sleep'));
    renderer.host.motionScale = 1;
    // Dawn takes them back out; the share is the clock's, not the frame's.
    assert.equal(duckAshoreShare('day', 0.5), 0);
    assert.equal(duckAshoreShare('dusk', 0.1), 0);
    assert.ok(duckAshoreShare('dusk', 0.5) > 0 && duckAshoreShare('dusk', 0.5) < 1);
    assert.equal(duckAshoreShare('dawn', 0.9), 0);
    assert.ok(duckPoses(renderer, at(10), 1064).every(duck => duck.pose === 'swim'));
});

test('every fish step stays in its body of water', () => {
    const point = { tileX: 0, tileY: 0 };
    MARINE_FISH_SCHOOLS.forEach((fish, index) => {
        assert.ok(fish.path?.length >= 2, `school ${index} has a path`);
        for (let t = 0; t < fish.driftS * 2000; t += 250) {
            const key = keyOf(fishSchoolPoint(fish, t, point));
            assert.ok(isWater(key) && (!deep.has(key) || lagoon.has(key)), `school ${index} at ${t} ms on ${key}`);
        }
    });
});

test('herons stand only on the five shallows and hop between them', () => {
    assert.equal(HERON_SHALLOWS.length, 5);
    for (const shallow of HERON_SHALLOWS) {
        const key = keyOf(shallow);
        assert.ok(!bridges.has(key) && ((water.has(key) && !deep.has(key)) || shore.has(key)), `shallow ${key}`);
    }
    const homes = SHORE_FAUNA.map(heron => heron.shallow);
    const pose = {};
    for (let i = 0; i < 200; i++) {
        const event = { kind: 'heron-relocation', tier: 'occasional', startMs: 1000000, endMs: 1000000 + 24000 + (i % 17) * 1000, seed: i / 200 };
        const plan = heronRelocation(event);
        assert.ok(!homes.includes(plan.to) && homes.includes(plan.from));
        const span = event.endMs - event.startMs;
        let stabMs = 0;
        let beats = 0;
        let lastFrame = -1;
        for (let t = -500; t <= span + 500; t += 20) {
            heronPose(plan.heron, event, event.startMs + t, pose);
            if (pose.flying) {
                assert.ok(pose.altitude > 0 && pose.frame >= 0 && pose.frame <= 2);
                if (pose.frame === 0 && lastFrame !== 0) beats++;
                lastFrame = pose.frame;
                continue;
            }
            lastFrame = -1;
            const key = keyOf(pose);
            assert.ok(HERON_SHALLOWS.some(shallow => keyOf(shallow) === key), `standing on ${key}`);
            if (pose.stab >= 0) stabMs += 20;
        }
        assert.ok(beats <= 4, 'two wingbeats a hop');
        const from = HERON_SHALLOWS[plan.from];
        const to = HERON_SHALLOWS[plan.to];
        assert.ok(Math.hypot(to.tileX - from.tileX, to.tileY - from.tileY) <= 5, `hop ${plan.from}→${plan.to} is short`);
        assert.ok(stabMs <= 400, `stab ${stabMs} ms`);
        heronPose(plan.heron, event, event.startMs + span / 2, pose);
        assert.equal(keyOf(pose), keyOf(HERON_SHALLOWS[plan.to]));
        heronPose(plan.heron, event, event.endMs, pose);
        assert.equal(keyOf(pose), keyOf(HERON_SHALLOWS[plan.from]));
    }
    heronPose(0, { kind: 'gull-fishing-run', startMs: 0, endMs: 1e9, seed: 0.5 }, 5000, pose);
    assert.equal(pose.flying, false);
});

// World px → tile coords (Projection's inverse: 64 × 32 tiles).
const worldTile = (x, y) => ({ tileX: (y / 16 + x / 32) / 2, tileY: (y / 16 - x / 32) / 2 });
// Tiles a point lies outside the map's north-east (tileY < 0) or
// south-east (tileX > MAP_SIZE - 1) shore; every ship lane, anchorage and
// the release slip lie inside the map.
const tilesOffEastShore = (x, y) => {
    const t = worldTile(x, y);
    return Math.max(-t.tileY, t.tileX - (MAP_SIZE - 1));
};
const FAR_SEA_KINDS = ['whale-spout', 'dolphin-pod', 'far-gull-wisp'];

test('far-sea life surfaces in the open sea east of the island, the shower in the horizon band, never a vessel', () => {
    const top = OCEAN_HORIZON_WORLD_Y + 1;
    const bottom = OCEAN_HORIZON_WORLD_Y + HORIZON_BAND_ROWS;
    for (const station of FAR_SEA_STATIONS) {
        assert.ok(station.tileY <= -4 || station.tileX >= MAP_SIZE + 4, `station ${station.tileX},${station.tileY} is off the east shores`);
    }
    const out = [];
    for (const kind of HORIZON_LIFE_KINDS) {
        let drawn = 0;
        for (let i = 0; i < 40; i++) {
            // Forced events may run longer than the scheduled range.
            const event = { kind, startMs: 0, endMs: 60000 + i * 2997, seed: i / 40 };
            for (let t = 0; t < event.endMs; t += 50) {
                horizonLifeStamps(event, t, { windX: i % 2 ? -0.5 : 0.5 }, out);
                drawn += out.length;
                for (const s of out) {
                    assert.ok(Number.isInteger(s.x) && Number.isInteger(s.y) && Number.isInteger(s.w) && Number.isInteger(s.h));
                    assert.ok(['back', 'mid', 'light', 'crest'].includes(s.tone));
                    if (FAR_SEA_KINDS.includes(kind)) {
                        // Clear of the map (and its sea lanes) by three tiles,
                        // within the whole-island frame's east sea (x 450..1250).
                        for (const [x, y] of [[s.x, s.y], [s.x + s.w, s.y], [s.x, s.y + s.h], [s.x + s.w, s.y + s.h]]) {
                            assert.ok(tilesOffEastShore(x, y) >= 3, `${kind} stamp at ${x},${y} is near the island`);
                            assert.ok(x >= 450 && x <= 1250, `${kind} stamp x ${x} outside the east sea`);
                        }
                        assert.equal(s.alpha, 1, 'opaque');
                    } else {
                        assert.ok(s.y >= top && s.y + s.h <= bottom, `${kind} stamp rows ${s.y}..${s.y + s.h}`);
                    }
                }
            }
            horizonLifeStamps(event, event.endMs, {}, out);
            assert.equal(out.length, 0, 'nothing after the event');
        }
        assert.ok(drawn > 0, `${kind} draws`);
    }
    for (const kind of ['gull-fishing-run', 'lone-cloud', 'heron-relocation', 'tall-ship', 'horizon-sail']) {
        assert.equal(horizonLifeStamps({ kind, startMs: 0, endMs: 60000, seed: 0.3 }, 1000, {}, out).length, 0, kind);
    }

    // The draw clips only the shower, to the band; the whale fills the far sea.
    const calls = [];
    let clipped = 0;
    const ctx = {
        save() {}, restore() { clipped = Math.max(0, clipped - 1); }, beginPath() {}, clip() { clipped++; },
        rect(x, y, w, h) { calls.push(['clip', y, h]); },
        fillRect(x, y, w, h) { calls.push(['fill', y, h, x, clipped]); },
        set fillStyle(v) {}, set globalAlpha(v) {},
    };
    const renderer = {
        motionScale: 1,
        overlayCtx: null,
        _lastAtmosphere: { effectiveDate: new Date(9200), weather: FAIR },
        ambientEvents: { frequent: { kind: 'distant-shower', startMs: 0, endMs: 120000, seed: 0.4 }, rare: { kind: 'whale-spout', startMs: 0, endMs: 60000, seed: 0.2 } },
    };
    drawHorizonLife(ctx, renderer);
    const fills = calls.filter(call => call[0] === 'fill');
    const banded = fills.filter(call => call[4] > 0);
    const far = fills.filter(call => call[4] === 0);
    assert.ok(banded.length > 0 && far.length > 0, 'both the shower and the whale draw');
    assert.deepEqual(calls.find(call => call[0] === 'clip'), ['clip', top, bottom - top]);
    for (const [, y, h] of banded) assert.ok(y >= top && y + h <= bottom);
    for (const [, y, , x] of far) assert.ok(tilesOffEastShore(x, y) >= 3);
    calls.length = 0;
    drawHorizonLife(ctx, { ...renderer, motionScale: 0 });
    assert.equal(calls.length, 0, 'reduced motion draws nothing');
});
