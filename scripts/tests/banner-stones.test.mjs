import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { BuildingPartGates, attentionBannerState, parsePartGate } from '../../claudeville/src/presentation/character-mode/BuildingPartGates.js';
import { getBuildingAttentionBanner } from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
import { REPO_STONE_SPRITES, repoStoneSpriteFor } from '../../claudeville/src/application/MonumentRules.js';
import { RepoStones, repoStoneLayout, repoStoneLore } from '../../claudeville/src/presentation/character-mode/RepoStones.js';
import { REPO_STONE_ANCHORS } from '../../claudeville/src/config/townPlan.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { ChronicleMonuments } from '../../claudeville/src/presentation/character-mode/ChronicleMonuments.js';
import { appendDepthSortedDrawables } from '../../claudeville/src/presentation/character-mode/DrawablePass.js';
import { buildGpuWorldRecords } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';
import { materialClassId } from '../../claudeville/src/presentation/character-mode/MaterialRegistry.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { evaluateGrade } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { canvasFrameGradeRgb, statusClothPreimage } from '../../claudeville/src/presentation/character-mode/CanvasGrade.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const waiting = (minutes) => ({ status: AgentStatus.WAITING_ON_USER, awaitingSince: NOW - minutes * MIN });
const BANNER_LAYERS = {
    banner: { frames: 5, staticFrame: 0, gate: 'status.needsYou', restIsBase: true },
    bannerError: { frames: 5, staticFrame: 0, gate: 'status.errors', restIsBase: true },
    bannerLimit: { frames: 5, staticFrame: 0, gate: 'status.quota', restIsBase: true },
};
const framesFor = (gates) => Object.fromEntries(Object.entries(BANNER_LAYERS)
    .map(([name, layer]) => [name, gates.frameFor('command', name, layer)]));

test('status gates parse only actionable buckets', () => {
    assert.deepEqual(parsePartGate('status.needsYou'), { kind: 'status', bucket: 'needsYou' });
    assert.deepEqual(parsePartGate('status.quota'), { kind: 'status', bucket: 'quota' });
    assert.equal(parsePartGate('status.idle'), null);
    assert.equal(parsePartGate('status.'), null);
});

test('no actionable agent hangs no banner', () => {
    assert.equal(attentionBannerState([], NOW), null);
    assert.equal(attentionBannerState([{ status: AgentStatus.WORKING }], NOW), null);
    const gates = new BuildingPartGates();
    gates.update({ attention: null });
    assert.deepEqual(framesFor(gates), { banner: 0, bannerError: 0, bannerLimit: 0 });
});

test('drop length steps by the oldest actionable wait (<1 / >=1 / >=5 / >=15 min)', () => {
    const cases = [[0.5, 0], [1, 1], [4.9, 1], [5, 2], [14.9, 2], [15, 3], [90, 3]];
    for (const [minutes, tier] of cases) {
        const state = attentionBannerState([waiting(0.1), waiting(minutes)], NOW);
        assert.equal(state.tier, tier, `${minutes} min`);
        assert.equal(state.count, 2);
        const gates = new BuildingPartGates();
        gates.update({ attention: state, motion: false });
        assert.equal(framesFor(gates).banner, 1 + tier, `${minutes} min frame`);
    }
});

test('an undated wait never lengthens the banner', () => {
    const state = attentionBannerState([{ status: AgentStatus.WAITING_ON_USER }], NOW);
    assert.deepEqual(state, { bucket: 'needsYou', tier: 0, count: 1 });
});

test('only the lead bucket hangs (needs-you > error > limit), keyed on the oldest wait of any bucket', () => {
    const limitOld = { status: AgentStatus.RATE_LIMITED, lastSessionActivity: NOW - 20 * MIN };
    const errored = { status: AgentStatus.ERRORED, lastSessionActivity: NOW - 2 * MIN };
    let state = attentionBannerState([limitOld, errored, waiting(0.2)], NOW);
    assert.deepEqual(state, { bucket: 'needsYou', tier: 3, count: 3 });
    const gates = new BuildingPartGates();
    gates.update({ attention: state });
    assert.deepEqual(framesFor(gates), { banner: 4, bannerError: 0, bannerLimit: 0 });
    state = attentionBannerState([limitOld, errored], NOW);
    gates.update({ attention: state });
    assert.deepEqual(framesFor(gates), { banner: 0, bannerError: 4, bannerLimit: 0 });
    state = attentionBannerState([limitOld], NOW);
    gates.update({ attention: state });
    assert.deepEqual(framesFor(gates), { banner: 0, bannerError: 0, bannerLimit: 4 });
});

test('status parts are static: the motion clock never moves the frame', () => {
    const gates = new BuildingPartGates();
    const state = attentionBannerState([waiting(6)], NOW);
    const seen = new Set();
    for (const timeMs of [0, 140, 999, 5000]) {
        gates.update({ attention: state, timeMs, motion: true });
        seen.add(gates.frameFor('command', 'banner', BANNER_LAYERS.banner));
    }
    assert.deepEqual([...seen], [3]);
});

test('manifest banner layers match the registry drops and status gates', () => {
    const manifest = readFileSync(new URL('../../claudeville/assets/sprites/manifest.yaml', import.meta.url), 'utf8');
    for (const [name, layer] of Object.entries(BANNER_LAYERS)) {
        const block = manifest.split(`\n      ${name}:\n`)[1]?.split(/\n      \w+:\n/)[0] || '';
        assert.match(block, new RegExp(`gate: ${layer.gate.replace('.', '\\.')}`), name);
        assert.match(block, /frames: 5/, name);
        assert.match(block, /restIsBase: true/, name);
    }
    const banner = getBuildingAttentionBanner('command');
    assert.deepEqual(banner.drops, [25, 45, 65, 85]);
    assert.equal(getBuildingAttentionBanner('forge'), null);
});

test('stone tiers follow the 1 / 10 / 100 / 1000 lifetime commit tiers', () => {
    assert.equal(repoStoneSpriteFor(0), null);
    assert.equal(repoStoneSpriteFor(1), REPO_STONE_SPRITES.maiden);
    assert.equal(repoStoneSpriteFor(9), 'prop.repoStone.cairn');
    assert.equal(repoStoneSpriteFor(10), 'prop.repoStone.stone');
    assert.equal(repoStoneSpriteFor(99), 'prop.repoStone.stone');
    assert.equal(repoStoneSpriteFor(100), 'prop.repoStone.pillar');
    assert.equal(repoStoneSpriteFor(999), 'prop.repoStone.pillar');
    assert.equal(repoStoneSpriteFor(1000), 'prop.repoStone.obelisk');
    assert.equal(repoStoneSpriteFor(250_000), 'prop.repoStone.obelisk');
});

test('one stone per anchored repo with commits, on its slot anchor', () => {
    const anchorages = new Map([['/r/a', 2], ['/r/b', 0], ['/r/none', 3], ['/r/far', 42]]);
    const counts = new Map([['/r/a', 140], ['/r/b', 1], ['/r/far', 5]]);
    const stones = repoStoneLayout(anchorages, counts);
    assert.deepEqual(stones.map(s => [s.project, s.slot, s.spriteId]), [
        ['/r/b', 0, 'prop.repoStone.cairn'],
        ['/r/a', 2, 'prop.repoStone.pillar'],
    ]);
    const anchor = REPO_STONE_ANCHORS.find(a => a.slot === 2);
    assert.deepEqual([stones[1].tileX, stones[1].tileY], [anchor.tileX, anchor.tileY]);
});

test('every Harbor slot has exactly one distinct quay stone anchor', () => {
    const slots = REPO_STONE_ANCHORS.map(a => a.slot).sort((a, b) => a - b);
    assert.deepEqual(slots, [...Array(10).keys()]);
    const tiles = new Set(REPO_STONE_ANCHORS.map(a => `${a.tileX},${a.tileY}`));
    assert.equal(tiles.size, REPO_STONE_ANCHORS.length);
    for (const a of REPO_STONE_ANCHORS) assert.ok(Number.isInteger(a.tileX) && Number.isInteger(a.tileY));
});

test('RepoStones reads lifetime counts for the harbor anchorages', async () => {
    const stones = new RepoStones();
    const harbor = { state: { repoAnchorages: new Map([['/r/a', 1], ['/r/b', 4]]) } };
    const store = { getLifetimeCommitCount: async (project) => (project === '/r/a' ? 1200 : 0) };
    await stones.refresh(harbor, store, NOW);
    assert.equal(stones.stones.length, 1);
    assert.equal(stones.stones[0].spriteId, 'prop.repoStone.obelisk');
    const [drawable] = stones.drawables();
    assert.equal(drawable.payload.kind, 'repo-stone');
    assert.ok(Number.isFinite(drawable.sortY));
});

// A canvas whose 2D context accepts every call (Node has no canvas).
function fakeDocument() {
    const made = [];
    const gradient = { addColorStop() {} };
    const ctx = new Proxy({}, { get: (target, key) => (key in target ? target[key] : () => gradient) });
    return {
        made,
        document: {
            createElement() {
                const canvas = { width: 0, height: 0, getContext: () => ctx };
                made.push(canvas);
                return canvas;
            },
        },
    };
}

test('Chronicle stones reach the resident GPU world as records over their baked faces', () => {
    const fake = fakeDocument();
    const previous = globalThis.document;
    globalThis.document = fake.document;
    try {
        const assets = {
            has: () => false,
            get: (id) => (id.startsWith('prop.repoStone.') ? { width: 28, height: 44 } : null),
            getAnchor: () => [14, 42],
        };
        const monuments = new ChronicleMonuments({ eventTarget: { on: () => () => {}, emit() {} }, assets });
        const quay = REPO_STONE_ANCHORS.find(a => a.slot === 2);
        const quayWorld = tileToWorld(quay.tileX, quay.tileY);
        monuments.repoStones.stones = [{
            project: '/r/a', slot: 2, spriteId: 'prop.repoStone.pillar', tileX: quay.tileX, tileY: quay.tileY,
            worldX: quayWorld.x, worldY: quayWorld.y, accent: '#e0584f',
        }];
        const renderer = { camera: { zoom: 1 } };
        const frame = () => {
            const target = [];
            appendDepthSortedDrawables(target, { chronicleMonumentDrawables: monuments.enumerateDrawables(NOW) });
            const records = buildGpuWorldRecords(renderer, { drawables: target })
                .filter(record => String(record.id).startsWith('chronicle:'));
            return { target, records: new Map(records.map(record => [record.id, record])) };
        };

        const first = frame();
        assert.deepEqual([...first.records.keys()].sort(), ['chronicle:repo:2']);
        const stone = materialClassId('stone');
        for (const record of first.records.values()) {
            assert.ok(fake.made.includes(record.source), `${record.id} draws its baked canvas`);
            assert.equal(record.material, stone);
            assert.ok(record.width > 0 && record.height > 0);
            const drawable = first.target.find(entry => entry.payload.buildGpuRecord && record.id.endsWith(
                entry.payload.payload.kind === 'repo-stone' ? `repo:${entry.payload.payload.slot}` : entry.payload.payload.id));
            assert.equal(record.depthSortY, drawable.sortY, `${record.id} sorts at its drawable`);
        }
        const repo = first.records.get('chronicle:repo:2');
        assert.equal(repo.x, Math.round(quayWorld.x - (14 + 4)));
        assert.equal(repo.y, Math.round(quayWorld.y - 42));
        assert.equal(repo.footY, Math.round(quayWorld.y));
        assert.equal(repo.writesDepth, true);
        for (const record of first.records.values()) assert.equal(record.emissiveSource, null);

        // Static faces: a second frame bakes nothing and reuses every record.
        const baked = fake.made.length;
        const second = frame();
        assert.equal(fake.made.length, baked);
        for (const [id, record] of second.records) assert.equal(record, first.records.get(id));
    } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    }
});

// D5 — the stones remember: hover lore from the lifetime count.
test('a repo stone tells its repo, tier, lifetime commits and next threshold on hover', async () => {
    assert.equal(repoStoneLore({ project: '/work/pharosville', count: 214 }), 'pharosville · pillar · 214 commits · next at 1000');
    assert.equal(repoStoneLore({ project: '/work/a', count: 1 }), 'a · cairn · 1 commit · next at 10');
    assert.equal(repoStoneLore({ project: '/work/a', count: 1000 }), 'a · obelisk · 1000 commits');
    assert.equal(repoStoneLore({ project: '/work/a', count: 0 }), '');

    const stones = new RepoStones();
    const harbor = { state: { repoAnchorages: new Map([['/r/a', 1]]) } };
    await stones.refresh(harbor, { getLifetimeCommitCount: async () => 37 }, NOW);
    const [stone] = stones.stones;
    assert.equal(stone.count, 37);
    stones.image = () => ({ canvas: { width: 20, height: 30 }, ax: 10, ay: 28 });
    assert.equal(stones.hitTest(stone.worldX, stone.worldY - 5), stone);
    assert.equal(stones.hitTest(stone.worldX + 40, stone.worldY), null);
    assert.equal(stones.tooltipFor(stone), 'a · stone · 37 commits · next at 100');
});

test('G7-1: the attention banner keeps its status hue through the night grade', () => {
    const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
    const sat = c => (Math.max(...c) - Math.min(...c)) / Math.max(...c);
    const luma = c => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
    // HSV hue in degrees.
    const hue = ([r, g, b]) => {
        const hi = Math.max(r, g, b);
        const d = hi - Math.min(r, g, b);
        const h = hi === r ? ((g - b) / d + 6) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4;
        return h * 60;
    };
    const night = evaluateGrade({ minuteOfDay: 23 * 60, moonFill: 0.8, weather: { type: 'clear', cloudCover: 0.08 } });
    const noon = evaluateGrade({ minuteOfDay: 12 * 60 + 30 });
    for (const postFx of [true, false]) {
        const frame = rgb => canvasFrameGradeRgb(rgb, night, { postFx });
        for (const status of ['#e8d44d', '#e06c5b', '#f06ae0']) {
            const authored = hex(status);
            const plain = frame(authored);
            const held = frame(statusClothPreimage(authored, night, { postFx }));
            const label = `${status} ${postFx ? 'resident' : 'canvas'}`;
            // Its authored colour back, or much more of it than the plain
            // night grade leaves it...
            const enough = Math.min(sat(authored) - 0.03, sat(plain) + 0.08);
            assert.ok(sat(held) >= Math.max(enough, 0.45), `${label}: sat ${sat(plain).toFixed(2)} -> ${sat(held).toFixed(2)}`);
            // ...on its own hue, not the Purkinje shift (the yellow went sage)...
            const drift = Math.abs(((hue(held) - hue(authored) + 540) % 360) - 180);
            assert.ok(drift < 15, `${label}: hue drift ${drift.toFixed(1)}`);
            // ...and never brighter than the night makes it: cloth, not light.
            assert.ok(luma(held) <= luma(plain) + 0.01, `${label}: luma ${luma(plain).toFixed(3)} -> ${luma(held).toFixed(3)}`);
        }
    }
    // By day the cloth is its authored strip.
    assert.deepEqual(statusClothPreimage(hex('#e8d44d'), noon, { postFx: true }), hex('#e8d44d'));
});
