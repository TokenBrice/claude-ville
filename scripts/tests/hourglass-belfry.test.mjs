import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

import {
    IsleLandmarks,
    QUOTA_PILLAR_ID,
    QUOTA_PILLAR_STATES,
    QUOTA_PILLAR_STREAM_PHASES,
    QUOTA_PILLAR_STRIP_FRAME,
    QUOTA_PILLAR_STRIP_ID,
    QUOTA_PILLAR_STRIP_ORIGIN,
    QUOTA_TERRACE_APRON_ID,
    quotaPillarStateCell,
    quotaPillarStreamCell,
} from '../../claudeville/src/presentation/character-mode/IsleLandmarks.js';
import {
    QUOTA_PILLAR_DRAIN_MS,
    QUOTA_PILLAR_LEVELS,
    QUOTA_TERRACE_PROVIDERS,
    quotaPillarStripCellCount,
} from '../../claudeville/src/presentation/character-mode/QuotaTerrace.js';
import { DISTRICT_PROPS, QUOTA_TERRACE_SLOTS } from '../../claudeville/src/config/scenery.js';

const usage = (claude, codex, glm = null, antigravity = null) => ({
    quota: claude === null ? { fiveHour: null, sevenDay: null } : { fiveHour: 0.1, sevenDay: claude },
    codex: codex === 'limit' ? { usedPercent: 100, limitReached: true } : codex === null ? null : { usedPercent: codex, limitReached: false },
    glm: glm === 'limit' ? { weekly: { usedPercent: 100 } } : glm === null ? null : { weekly: { usedPercent: glm } },
    antigravity: antigravity === 'limit'
        ? { geminiWeekly: { usedPercent: 100 } }
        : antigravity === null ? null : { geminiWeekly: { usedPercent: antigravity } },
});

function world({ motionScale = 1 } = {}) {
    const stripCells = quotaPillarStripCellCount();
    const host = {
        motionScale,
        motionTimeMs: 0,
        idleInvalidations: 0,
        _invalidateIdleFrame() { this.idleInvalidations++; },
        sprites: { drawSprite() {} },
        assets: {
            getDims: (id) => (id === QUOTA_PILLAR_ID ? { w: 32, h: 68 } : { w: 128, h: 208 }),
            getAnchor: (id) => (id === QUOTA_PILLAR_ID ? [16, 60] : [64, 168]),
            get: (id) => (id === QUOTA_PILLAR_ID
                ? { width: 32, height: 68 }
                : id === QUOTA_PILLAR_STRIP_ID ? { width: stripCells * 16, height: 48 } : null),
        },
    };
    const landmarks = new IsleLandmarks(host);
    const sprites = landmarks.buildSprites();
    const pillars = Object.fromEntries(QUOTA_TERRACE_PROVIDERS.map((p) => [p, landmarks.getQuotaPillar(p)]));
    const keys = () => QUOTA_TERRACE_PROVIDERS.map((p) => pillars[p].pillarKey());
    return { host, landmarks, sprites, pillars, keys };
}

test('Runic Tide-Terrace stands on the NW headland clear of the north farm plank bridge and Archive', () => {
    const landmarks = DISTRICT_PROPS.filter((prop) => prop.landmark);
    assert.equal(landmarks.filter((p) => p.id === 'prop.windmill').length, 1);
    const pillarProps = landmarks.filter((p) => p.id === QUOTA_PILLAR_ID);
    assert.deepEqual(pillarProps.map((p) => p.provider), [...QUOTA_TERRACE_PROVIDERS]);
    const apron = DISTRICT_PROPS.find((p) => p.id === QUOTA_TERRACE_APRON_ID);
    assert.ok(apron, 'terrace apron registered in DISTRICT_PROPS');
    assert.equal(apron.layer, 'cache');
    assert.equal(apron.walkBlock, false);

    for (const prop of pillarProps) {
        assert.equal(prop.layer, 'sorted');
        assert.equal(prop.walkBlock, true);
        assert.ok(prop.tileX <= 2.0, `${prop.provider} pillar stands well west of north farm bridge (x=3)`);
        assert.ok(prop.tileY >= 9.0 && prop.tileY <= 11.0, `${prop.provider} pillar stands on NW headland north of Archive`);
    }
    // The farm (with the laundry line) remains intact on the north shore.
    const farm = DISTRICT_PROPS.filter((prop) => prop.district === 'farm');
    assert.ok(farm.some((prop) => prop.id === 'prop.laundryLine'));
    for (const prop of farm) assert.ok(prop.tileY < 5, `${prop.id} @ ${prop.tileX},${prop.tileY} stands on the north shore`);
});

test('each pillar shows its provider: weekly courses left, shroud when unknown, lavender seal at LIMIT', () => {
    const { landmarks, keys } = world();
    assert.deepEqual(keys(), ['unknown', 'unknown', 'unknown', 'unknown'], 'no usage yet: all shrouded');
    landmarks.setUsage(usage(0.27, 16, 12, 26));
    assert.deepEqual(keys(), ['l4', 'l5', 'l5', 'l4']);
    landmarks.setUsage(usage(null, 'limit', 'limit', null));
    assert.deepEqual(keys(), ['unknown', 'limit', 'limit', 'unknown']);
});

test('a weekly reset refills only that provider pillar: C4 cream peak, then one course per 150 ms', () => {
    const { host, landmarks, keys } = world();
    landmarks.setUsage(usage(0.9, 30, 50, 70));
    assert.deepEqual(keys(), ['l1', 'l4', 'l3', 'l2']);
    host.motionTimeMs = 10_000;
    landmarks.setUsage(usage(0.05, 30, 50, 70));
    const seen = [];
    for (const t of [0, 149, 150, 300, 450, 600, 5_000]) {
        host.motionTimeMs = 10_000 + t;
        seen.push(keys()[0]);
    }
    assert.deepEqual(seen, ['peak', 'peak', 'l2', 'l3', 'l4', 'l5', 'l5']);
    assert.deepEqual(keys().slice(1), ['l4', 'l3', 'l2'], 'other pillars hold still');
});

test('a falling reading, first arrival, or reduced motion swaps at once', () => {
    const { host, landmarks, keys } = world();
    landmarks.setUsage(usage(0.1, 10, 10, 10));
    assert.deepEqual(keys(), ['l5', 'l5', 'l5', 'l5'], 'unknown -> reading: instant');
    landmarks.setUsage(usage(0.7, 70, 70, 70));
    assert.deepEqual(keys(), ['l2', 'l2', 'l2', 'l2'], 'spending never plays reset animation');

    const still = world({ motionScale: 0 });
    still.landmarks.setUsage(usage(0.9, 'limit', 90, 90));
    still.landmarks.setUsage(usage(0.1, 5, 5, 5));
    assert.deepEqual(still.keys(), ['l5', 'l5', 'l5', 'l5']);

    landmarks.setUsage(usage(0.1, 70, 70, 70));
    host.motionScale = 0;
    assert.equal(keys()[0], 'l5', 'reduced motion mid-refill completes at once');
});

test('a changed reading invalidates a still world; a same-level repeat does not', () => {
    const { host, landmarks } = world();
    landmarks.setUsage(usage(0.27, 16, 12, 26));
    assert.equal(host.idleInvalidations, 1);
    landmarks.setUsage(usage(0.28, 17, 13, 27));
    assert.equal(host.idleInvalidations, 1, 'same course levels');
    landmarks.setUsage(usage(0.5, 17, 13, 27));
    assert.equal(host.idleInvalidations, 2);
});

test('each pillar paints its own strip cell at QUOTA_PILLAR_STRIP_ORIGIN', () => {
    const { pillars, landmarks } = world();
    landmarks.setUsage(usage(0.27, 'limit', 12, 26));
    const [fw, fh] = QUOTA_PILLAR_STRIP_FRAME;
    const [ox, oy] = QUOTA_PILLAR_STRIP_ORIGIN;
    for (const [provider, expectedState] of [['claude', 'l4'], ['codex', 'limit'], ['glm', 'l5'], ['antigravity', 'l4']]) {
        const sprite = pillars[provider];
        sprite._getCachedCanvas();
        const draws = [];
        sprite._paint({ drawImage: (...args) => draws.push(args) }, 1000, 500);
        assert.equal(draws.length, 1);
        assert.deepEqual(
            draws[0].slice(1, 9),
            [quotaPillarStateCell(provider, expectedState) * fw, 0, fw, fh, 1000 - 16 + ox, 500 - 60 + oy, fw, fh],
            `${provider} paints ${expectedState}`,
        );
    }
});

test('per-pillar hit testing identifies each spaced pillar and returns its 2-line tooltip', () => {
    const { pillars, landmarks } = world();
    landmarks.setUsage(usage(0.38, 44, 12, 26));
    for (const provider of QUOTA_TERRACE_PROVIDERS) {
        const sprite = pillars[provider];
        const bounds = landmarks.quotaPillarWorldBounds(sprite);
        assert.equal(landmarks.hitTestQuotaPillar(bounds.left + 16, bounds.top + 32), sprite, `hits ${provider}`);
        const lines = landmarks.quotaPillarTooltip(sprite, Date.now()).split('\n');
        assert.equal(lines.length, 2, `${provider} hover has strictly 2 lines`);
    }
    const farMiss = landmarks.hitTestQuotaPillar(-9999, -9999);
    assert.equal(farMiss, null);
});

// MB-7 (relaxed 2026-11-23) — Windmill sails unaffected by terrace replacement.
test('the windmill sails turn steadily in a breeze (2–4 fps) and speed up to 8 fps in a gust', () => {
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
    assert.ok(gaps.length > 8, `breeze + gusts turn the sails (${gaps.length} steps)`);
    assert.ok(gaps.every((gap) => gap >= 125), 'never faster than 8 fps');
    assert.ok(gaps.includes(125), 'a held gust turns them at exactly 8 fps');
    assert.ok(gaps.includes(300), 'a steady breeze turns them at ~3.3 fps (2–4 fps)');

    host._lastAtmosphere = { weather: { type: 'clear', windX: 0.35, seed: 7 } };
    let breezeSteps = 0;
    let prev = mill.sailFrame();
    for (let t = 120_000; t <= 123_000; t += 25) {
        host.motionTimeMs = t;
        const next = mill.sailFrame();
        if (next !== prev) {
            breezeSteps++;
            prev = next;
        }
    }
    assert.ok(breezeSteps >= 6 && breezeSteps <= 15, `steady clear breeze steps at 2–4 fps (${breezeSteps} steps in 3 s)`);
    frame = prev;

    host._lastAtmosphere = { weather: { windX: 0.05 } };
    for (let t = 123_000; t <= 133_000; t += 25) {
        host.motionTimeMs = t;
        assert.equal(mill.sailFrame(), frame, 'calm air holds the frame they stopped on');
    }
    host.motionScale = 0;
    assert.equal(mill.sailFrame(), 0, 'reduced motion holds frame 0');
});

// MB-5 — active spend runs a 2 fps 3-phase trickle for 10 min, never under reduced motion.
test('a spending provider runs its pillar trickle at 2 fps for ten minutes, never under reduced motion', () => {
    const { host, landmarks, pillars } = world();
    const t0 = Date.now() - 400_000;
    landmarks.setUsage(usage(0.27, 16, 12, 26), t0);
    assert.equal(pillars.claude.streamPhase(t0), null, 'first reading is no spend');
    landmarks.setUsage(usage(0.31, 16, 12, 26), t0 + 300_000);
    const now = t0 + 300_000;
    const phases = [];
    for (let t = 0; t < 3000; t += 250) {
        host.motionTimeMs = t;
        phases.push(pillars.claude.streamPhase(now));
    }
    assert.deepEqual(phases, [0, 0, 1, 1, 2, 2, 0, 0, 1, 1, 2, 2]);
    assert.equal(pillars.codex.streamPhase(now), null, 'other providers hold still');
    assert.equal(pillars.claude.streamPhase(now + QUOTA_PILLAR_DRAIN_MS), null, 'ten minutes after the rise');

    pillars.claude._getCachedCanvas();
    const draws = [];
    pillars.claude._paint({ drawImage: (...args) => draws.push(args) }, 1000, 500);
    const [fw] = QUOTA_PILLAR_STRIP_FRAME;
    assert.equal(draws[0][1], quotaPillarStreamCell('claude', 4, pillars.claude.streamPhase()) * fw);

    host.motionScale = 0;
    assert.equal(pillars.claude.streamPhase(now), null, 'reduced motion keeps static cell');
    host.motionScale = 1;
    landmarks.setUsage(usage(0.31, 'limit', 12, 26), now + 1000);
    landmarks.setUsage(usage(0.31, 'limit', 12, 26), now + 2000);
    assert.equal(pillars.codex.streamPhase(now + 2000), null, 'spent/limit pillar has no trickle');
});

test('the baked prop.quotaPillarStrip holds every state and 3-phase spend trickle for all 4 providers', () => {
    const strip = PNG.sync.read(readFileSync(new URL(`../../claudeville/assets/sprites/props/${QUOTA_PILLAR_STRIP_ID}.png`, import.meta.url)));
    const [fw, fh] = QUOTA_PILLAR_STRIP_FRAME;
    const cells = quotaPillarStripCellCount(QUOTA_TERRACE_PROVIDERS);
    assert.equal(cells, 4 * (QUOTA_PILLAR_STATES.length + QUOTA_PILLAR_LEVELS * QUOTA_PILLAR_STREAM_PHASES));
    assert.deepEqual([strip.width, strip.height], [fw * cells, fh]);
    const texels = (cell) => {
        const out = [];
        for (let y = 0; y < fh; y++) {
            for (let x = 0; x < fw; x++) {
                const i = (y * strip.width + cell * fw + x) * 4;
                out.push(strip.data[i], strip.data[i + 1], strip.data[i + 2], strip.data[i + 3]);
            }
        }
        return out;
    };
    const opaque = (cell) => texels(cell).filter((v, i) => i % 4 === 3 && v > 0).length;
    for (let cell = 0; cell < cells; cell++) assert.ok(opaque(cell) > 250, `cell ${cell} is painted`);
    for (const provider of QUOTA_TERRACE_PROVIDERS) {
        for (let level = 1; level <= QUOTA_PILLAR_LEVELS; level++) {
            const still = texels(quotaPillarStateCell(provider, `l${level}`));
            for (let phase = 0; phase < QUOTA_PILLAR_STREAM_PHASES; phase++) {
                const run = texels(quotaPillarStreamCell(provider, level, phase));
                let differ = 0;
                for (let i = 0; i < run.length; i += 4) {
                    if (run[i] !== still[i] || run[i + 1] !== still[i + 1] || run[i + 2] !== still[i + 2]) differ++;
                }
                assert.ok(differ >= 2 && differ <= 24, `${provider} l${level} phase ${phase}: subtle interior trickle (${differ} texels)`);
            }
        }
    }
    assert.equal(QUOTA_TERRACE_SLOTS.length, QUOTA_TERRACE_PROVIDERS.length);
});
