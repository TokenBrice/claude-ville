import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

import {
    BELFRY_GLASS_FRAME,
    BELFRY_GLASS_ORIGINS,
    BELFRY_GLASS_STATES,
    BELFRY_STREAM_PHASES,
    IsleLandmarks,
    belfryStreamCell,
} from '../../claudeville/src/presentation/character-mode/IsleLandmarks.js';
import { BELFRY_DRAIN_MS, BELFRY_LEVELS } from '../../claudeville/src/presentation/character-mode/BelfryQuota.js';
import { DISTRICT_PROPS } from '../../claudeville/src/config/scenery.js';

const BELFRY = 'prop.hourglassBelfry';
const GLASS = 'prop.hourglassBelfryGlass';
const usage = (claude, codex) => ({
    quota: claude === null ? { fiveHour: null, sevenDay: null } : { fiveHour: claude, sevenDay: 0 },
    codex: codex === 'limit' ? { usedPercent: 100, limitReached: true } : { usedPercent: codex, limitReached: false },
});

function world({ motionScale = 1 } = {}) {
    const host = {
        motionScale,
        motionTimeMs: 0,
        idleInvalidations: 0,
        _invalidateIdleFrame() { this.idleInvalidations++; },
        sprites: { drawSprite() {} },
        assets: {
            getDims: () => ({ w: 128, h: 208 }),
            getAnchor: (id) => (id === BELFRY ? [64, 177] : [64, 168]),
            get: (id) => (id === BELFRY ? { width: 128, height: 208 } : id === GLASS ? { width: 360, height: 38 } : null),
        },
    };
    const landmarks = new IsleLandmarks(host);
    const sprites = landmarks.buildSprites();
    const belfry = sprites.find((sprite) => sprite.id === BELFRY);
    const keys = () => [belfry.glassKey('claude'), belfry.glassKey('codex')];
    return { host, landmarks, belfry, keys };
}

test('the belfry stands where the ruined tower stood, one landmark for one', () => {
    const landmarks = DISTRICT_PROPS.filter((prop) => prop.landmark).map((prop) => prop.id);
    assert.deepEqual(landmarks, ['prop.windmill', 'prop.waysideChapel', BELFRY]);
    const belfry = DISTRICT_PROPS.find((prop) => prop.id === BELFRY);
    assert.deepEqual([belfry.tileX, belfry.tileY, belfry.walkBlock, belfry.layer], [4.5, 3.6, true, 'sorted']);
});

test('each glass shows its account: sand left, a shroud with no reading, a cord at the Codex limit', () => {
    const { landmarks, keys } = world();
    assert.deepEqual(keys(), ['unknown', 'unknown'], 'no usage yet: both shrouded');
    landmarks.setUsage(usage(0.27, 16));
    assert.deepEqual(keys(), ['l4', 'l5']);
    landmarks.setUsage(usage(null, 'limit'));
    assert.deepEqual(keys(), ['unknown', 'limit']);
});

test('a window reset refills its glass once: the cream frame, then a level a step', () => {
    const { host, landmarks, keys } = world();
    landmarks.setUsage(usage(0.9, 30));
    assert.deepEqual(keys(), ['l1', 'l4']);
    host.motionTimeMs = 10_000;
    landmarks.setUsage(usage(0.05, 30));
    const seen = [];
    for (const t of [0, 149, 150, 300, 450, 600, 5_000]) {
        host.motionTimeMs = 10_000 + t;
        seen.push(keys()[0]);
    }
    assert.deepEqual(seen, ['peak', 'peak', 'l2', 'l3', 'l4', 'l5', 'l5']);
    assert.equal(keys()[1], 'l4', 'the other glass holds still');
});

test('a reading that falls, or first arrives, swaps at once; so does any change under reduced motion', () => {
    const { host, landmarks, keys } = world();
    landmarks.setUsage(usage(0.1, 10));
    assert.deepEqual(keys(), ['l5', 'l5'], 'unknown to a reading: no moment');
    landmarks.setUsage(usage(0.7, 70));
    assert.deepEqual(keys(), ['l2', 'l2'], 'spending never plays a moment');

    const still = world({ motionScale: 0 });
    still.landmarks.setUsage(usage(0.9, 'limit'));
    still.landmarks.setUsage(usage(0.1, 5));
    assert.deepEqual(still.keys(), ['l5', 'l5']);

    landmarks.setUsage(usage(0.1, 70));
    host.motionScale = 0;
    assert.equal(keys()[0], 'l5', 'reduced motion mid-moment ends it');
});

test('a changed reading asks a still world for a paint; a repeat does not', () => {
    const { host, landmarks } = world();
    landmarks.setUsage(usage(0.27, 16));
    assert.equal(host.idleInvalidations, 1);
    landmarks.setUsage(usage(0.28, 17));
    assert.equal(host.idleInvalidations, 1, 'same sand levels');
    landmarks.setUsage(usage(0.5, 17));
    assert.equal(host.idleInvalidations, 2);
});

test('each glass paints its own cell of the strip at its origin', () => {
    const { belfry, landmarks } = world();
    landmarks.setUsage(usage(0.27, 'limit'));
    belfry._getCachedCanvas();
    const draws = [];
    belfry._paint({ drawImage: (...args) => draws.push(args) }, 1000, 500);
    const [fw, fh] = BELFRY_GLASS_FRAME;
    const states = BELFRY_GLASS_STATES.length;
    assert.deepEqual(draws.map((args) => args.slice(1, 9)), [
        [BELFRY_GLASS_STATES.indexOf('l4') * fw, 0, fw, fh, 1000 - 64 + BELFRY_GLASS_ORIGINS.claude[0], 500 - 177 + BELFRY_GLASS_ORIGINS.claude[1], fw, fh],
        [(states + BELFRY_GLASS_STATES.indexOf('limit')) * fw, 0, fw, fh, 1000 - 64 + BELFRY_GLASS_ORIGINS.codex[0], 500 - 177 + BELFRY_GLASS_ORIGINS.codex[1], fw, fh],
    ]);
});

test('hovering the belfry reads out both accounts', () => {
    const { belfry, landmarks } = world();
    landmarks.setUsage(usage(0.27, 16));
    const left = Math.round(belfry.x) - 64;
    const top = Math.round(belfry.y) - 177;
    assert.equal(landmarks.hitTestBelfry(left + 64, top + 100), belfry);
    assert.equal(landmarks.hitTestBelfry(left - 1, top + 100), null);
    assert.equal(landmarks.hitTestBelfry(left + 64, top + 208), null);
    const tip = landmarks.belfryTooltip(Date.now()).split('\n');
    assert.deepEqual(tip.map((line) => line.split(':')[0]), ['Hourglass Belfry · sand left = quota left', 'Claude', 'Codex']);
});

// MB-7 — 8 frames of 11.25° on 125 ms steps: one turn per 4 s, as the old
// 4 frames of 22.5° on 250 ms, and still only while a gust crosses the mill.
test('the windmill sails turn one 11.25° frame per 125 ms, only in a gust (MB-7)', () => {
    const strip = PNG.sync.read(readFileSync(new URL('../../claudeville/assets/sprites/props/prop.windmillSails.png', import.meta.url)));
    assert.deepEqual([strip.width, strip.height], [8 * 112, 112]);
    const { host, landmarks } = world();
    const mill = landmarks.buildSprites().find((sprite) => sprite.id === 'prop.windmill');
    host._lastAtmosphere = { weather: { windX: 0.9, seed: 7 } };
    let frame = mill.sailFrame();
    let steppedAt = -Infinity;
    const gaps = [];
    for (let t = 0; t <= 120_000; t += 25) {
        host.motionTimeMs = t;
        const next = mill.sailFrame();
        if (next === frame) continue;
        assert.equal(next, (frame + 1) % 8, `one frame at a time (${t} ms)`);
        gaps.push(t - steppedAt);
        frame = next;
        steppedAt = t;
    }
    assert.ok(gaps.length > 8, `a gust turns the sails (${gaps.length} steps)`);
    assert.ok(gaps.every((gap) => gap >= 125), 'never faster than 8 fps');
    assert.ok(gaps.includes(125), 'a held gust turns them at exactly 8 fps');

    host._lastAtmosphere = { weather: { windX: 0.05 } };
    for (let t = 120_000; t <= 130_000; t += 25) {
        host.motionTimeMs = t;
        assert.equal(mill.sailFrame(), frame, 'calm air holds the frame they stopped on');
    }
    host.motionScale = 0;
    assert.equal(mill.sailFrame(), 0, 'reduced motion holds frame 0');
});

// MB-5 — while an account spends its glass's stream runs (3 phases at
// 2 fps); a still reading, a reset, the shroud, the cord or reduced motion
// keep today's static cell.
test('a spending account runs its glass\'s stream at 2 fps for ten minutes, never under reduced motion', () => {
    const { host, landmarks, belfry } = world();
    const t0 = Date.now() - 400_000; // the cache reads the wall clock
    landmarks.setUsage(usage(0.27, 16), t0);
    assert.equal(belfry.streamPhase('claude', t0), null, 'a first reading is no spend');
    landmarks.setUsage(usage(0.31, 16), t0 + 300_000);
    const now = t0 + 300_000;
    const phases = [];
    for (let t = 0; t < 3000; t += 250) {
        host.motionTimeMs = t;
        phases.push(belfry.streamPhase('claude', now));
    }
    assert.deepEqual(phases, [0, 0, 1, 1, 2, 2, 0, 0, 1, 1, 2, 2]);
    assert.equal(belfry.streamPhase('codex', now), null, 'the other account holds still');
    assert.equal(belfry.streamPhase('claude', now + BELFRY_DRAIN_MS), null, 'ten minutes after the rise');

    belfry._getCachedCanvas();
    const draws = [];
    belfry._paint({ drawImage: (...args) => draws.push(args) }, 1000, 500);
    const [fw] = BELFRY_GLASS_FRAME;
    assert.equal(draws[0][1], belfryStreamCell('claude', 4, belfry.streamPhase('claude')) * fw, 'the stream cell of its level');
    assert.equal(draws[1][1], (BELFRY_GLASS_STATES.length + BELFRY_GLASS_STATES.indexOf('l5')) * fw);

    host.motionScale = 0;
    assert.equal(belfry.streamPhase('claude', now), null, 'reduced motion keeps the static stream');
    host.motionScale = 1;
    landmarks.setUsage(usage(0.31, 'limit'), now + 1000);
    landmarks.setUsage(usage(0.31, 'limit'), now + 2000);
    assert.equal(belfry.streamPhase('codex', now + 2000), null, 'the spent glass has no stream');
});

test('the baked strip holds every state of both glasses, then their running streams', () => {
    const strip = PNG.sync.read(readFileSync(new URL(`../../claudeville/assets/sprites/props/${GLASS}.png`, import.meta.url)));
    const [fw, fh] = BELFRY_GLASS_FRAME;
    const cells = 2 * (BELFRY_GLASS_STATES.length + BELFRY_LEVELS * BELFRY_STREAM_PHASES);
    assert.deepEqual([strip.width, strip.height], [fw * cells, fh]);
    const texels = (cell) => {
        const out = [];
        for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) out.push(...strip.data.subarray((y * strip.width + cell * fw + x) * 4, (y * strip.width + cell * fw + x) * 4 + 4));
        return out;
    };
    const opaque = (cell) => texels(cell).filter((_, i) => i % 4 === 3 && _ > 0).length;
    for (let cell = 0; cell < cells; cell++) assert.ok(opaque(cell) > 200, `cell ${cell} is painted`);
    for (const [g, account] of ['claude', 'codex'].entries()) {
        for (let level = 1; level <= BELFRY_LEVELS; level++) {
            const still = texels(g * BELFRY_GLASS_STATES.length + BELFRY_GLASS_STATES.indexOf(`l${level}`));
            for (let phase = 0; phase < BELFRY_STREAM_PHASES; phase++) {
                const run = texels(belfryStreamCell(account, level, phase));
                let differ = 0;
                for (let i = 0; i < run.length; i += 4) if (run[i] !== still[i] || run[i + 1] !== still[i + 1] || run[i + 2] !== still[i + 2]) differ++;
                assert.ok(differ >= 1 && differ <= 8, `${account} l${level} phase ${phase}: only stream texels change (${differ})`);
            }
        }
    }
});
