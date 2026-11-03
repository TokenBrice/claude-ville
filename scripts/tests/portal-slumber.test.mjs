import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

import { BuildingPartGates } from '../../claudeville/src/presentation/character-mode/BuildingPartGates.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import {
    getBuildingRestCovers,
    getBuildingRestEmber,
    getBuildingRestLayer,
} from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
import { loadSpriteManifest } from '../sprites/manifest-utils.mjs';

// MB-4 (D4) — the Portal slumbers until someone travels: an empty Portal
// lays `slumber.png` over its painted vortex, `portalGlow` stands down, and
// the slumbering eye keeps a low ember at night. It wakes on `work.portal`.

const ENTRY = loadSpriteManifest().buildings.find((entry) => entry.id === 'building.portal');
const png = (name) => PNG.sync.read(readFileSync(new URL(`../../claudeville/assets/sprites/buildings/building.portal/${name}.png`, import.meta.url)));
const portal = { type: 'portal' };

function renderer({ working = [], hour = 12 } = {}) {
    const partGates = new BuildingPartGates();
    partGates.update({ workingIdsByType: new Map([['portal', new Set(working)]]) });
    const images = { 'building.portal.slumber': { width: 312, height: 264 }, 'building.portal.portalGlow': { width: 56, height: 121 } };
    return Object.assign(Object.create(BuildingSprite.prototype), {
        partGates,
        atmosphereState: { clock: { minuteOfDay: hour * 60 } },
        assets: { getAnchor: () => [156, 202], get: (id) => images[id] || null, assetVersion: 'test' },
        _litGateByType: new Map(),
    });
}

test('the registry rests the Portal on its slumber mask, covering the vortex fixture, with a low ember', () => {
    assert.equal(getBuildingRestLayer('portal'), 'slumber');
    assert.deepEqual(getBuildingRestCovers('portal'), ['portalGlow']);
    const ember = getBuildingRestEmber('portal');
    assert.ok(ember.strength > 0 && ember.strength <= 0.5, 'a low floor, never the working vortex');
    assert.deepEqual(getBuildingRestCovers('forge'), [], 'the hearths cover no overlay');
    const layer = ENTRY.layers.slumber;
    assert.deepEqual([layer.width, layer.height, ...layer.anchor], [ENTRY.width, ENTRY.height, ...ENTRY.anchor], 'at the base\'s size and origin');
});

test('an empty Portal slumbers and emits nothing; a working visitor wakes it (work.portal only)', () => {
    const empty = renderer();
    assert.equal(empty._restMaskShowing(portal), true);
    assert.equal(empty._emissiveGateFor(portal), 0, 'no vortex, rune or brazier light while it sleeps');
    const awake = renderer({ working: ['web-1'] });
    assert.equal(awake._restMaskShowing(portal), false);
    assert.equal(awake._emissiveGateFor(portal), 1);
});

test('asleep, the slumber part replaces portalGlow and carries its ember gate; awake, the vortex fixture is back', () => {
    const at = (options) => renderer(options).partDrawsFor(ENTRY, portal, 1000, 2000).map((draw) => draw.name);
    assert.deepEqual(at({ hour: 12 }), ['slumber']);
    assert.deepEqual(at({ hour: 12, working: ['web-1'] }), ['portalGlow']);

    const [night] = renderer({ hour: 22 }).partDrawsFor(ENTRY, portal, 1000, 2000);
    assert.equal(night.name, 'slumber');
    assert.deepEqual([night.x, night.y], [1000 - 156, 2000 - 202], 'at the base origin');
    assert.equal(night.emissiveGate, 1, 'the ember glows while the lamps burn');
    assert.equal(night.fixture, false);
    assert.equal(renderer({ hour: 12 }).partDrawsFor(ENTRY, portal, 0, 0)[0].emissiveGate, 0, 'dark by day');
});

test('the slumber mask is the vortex two courses down its own violet ramp, chroma held', () => {
    const base = png('base');
    const glow = png('portalGlow');
    const mask = png('slumber');
    assert.deepEqual([mask.width, mask.height], [base.width, base.height]);
    const layer = ENTRY.layers.portalGlow;
    const left = Math.round(layer.anchor[0] - glow.width / 2);
    const top = Math.round(layer.anchor[1] - glow.height);
    const key = (data, i) => (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    const vortex = new Set();
    for (let y = 0; y < glow.height; y++) {
        for (let x = 0; x < glow.width; x++) if (glow.data[(y * glow.width + x) * 4 + 3]) vortex.add((top + y) * base.width + left + x);
    }
    const luma = (k) => 0.2126 * (k >> 16) + 0.7152 * ((k >> 8) & 255) + 0.0722 * (k & 255);
    const ramp = [...new Set([...vortex].map((p) => key(base.data, p * 4)))].sort((a, b) => luma(a) - luma(b) || a - b);
    assert.ok(ramp.length >= 5, `the vortex ramp (${ramp.length} colours)`);
    const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const oklab = (k) => {
        const [r, g, b] = [lin(k >> 16), lin((k >> 8) & 255), lin(k & 255)];
        const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
        const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
        const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
        const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
        const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
        return { L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, C: Math.hypot(a, bb) };
    };
    const sums = { L0: 0, L1: 0, C0: 0, C1: 0 };
    for (let p = 0; p < base.width * base.height; p++) {
        const opaque = mask.data[p * 4 + 3] > 0;
        assert.equal(opaque, vortex.has(p), `texel ${p % base.width},${Math.floor(p / base.width)}: the mask covers exactly the vortex`);
        if (!opaque) continue;
        const from = key(base.data, p * 4);
        const to = key(mask.data, p * 4);
        assert.equal(to, ramp[Math.max(0, ramp.indexOf(from) - 2)], 'two courses down its own ramp');
        const [a, b] = [oklab(from), oklab(to)];
        sums.L0 += a.L; sums.L1 += b.L; sums.C0 += a.C; sums.C1 += b.C;
    }
    assert.ok(sums.L1 / vortex.size < sums.L0 / vortex.size - 0.1, 'deeper');
    assert.ok(Math.abs(sums.C1 - sums.C0) / sums.C0 < 0.1, 'chroma held within 10 %');
    const ember = new Set(getBuildingRestEmber('portal').colors.map((hex) => parseInt(hex.slice(1), 16)));
    let glowing = 0;
    for (const p of vortex) if (ember.has(key(mask.data, p * 4))) glowing++;
    assert.ok(glowing > 0 && glowing < vortex.size / 2, `the ember is the slumbering eye (${glowing} texels)`);
});
