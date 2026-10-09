import test from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, readFileSync } from 'node:fs';

import {
    COSMETIC_HEAD_ACCESSORIES,
    Compositor,
    HAIR_TUFT_ACCESSORIES,
    ROBE_HUE_LIMIT_DEG,
    ROBE_VALUE_RANGE,
    ROBE_VARIANT_COUNT,
    agentPaletteVariant,
    fillOverlayGaps,
    resolveHeadAccessory,
    robeHueTurn,
    robeVariant,
    shiftRobeColor,
} from '../../claudeville/src/presentation/character-mode/Compositor.js';

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
// Declared robe sources from the manifest, spanning the families: Codex
// near-neutral plate and navy, Claude violet, DeepSeek green, GLM vermilion.
const ROBE_SOURCES = ['#bdd2e3', '#2d2f41', '#222945', '#34184f', '#52337d', '#162620', '#b7362f', '#c0e9c3'].map(hexRgb);

function oklabHue([r8, g8, b8]) {
    const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const [r, g, b] = [lin(r8), lin(g8), lin(b8)];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    return (Math.atan2(bb, a) * 180) / Math.PI;
}

const hueDelta = (from, to) => ((to - from + 540) % 360) - 180;

test('the crowd variant is deterministic, 0..11, and keeps the historical 0..3 variant', () => {
    assert.equal(ROBE_VARIANT_COUNT, 12);
    const seen = new Set();
    for (let i = 0; i < 400; i++) {
        const id = `session-${i}`;
        const variant = agentPaletteVariant(id, 'gpt-5.6-luna', 'codex');
        assert.equal(agentPaletteVariant(id, 'gpt-5.6-luna', 'codex'), variant);
        assert.ok(Number.isInteger(variant) && variant >= 0 && variant < ROBE_VARIANT_COUNT);
        // The pre-W2.3 hash, so existing agents keep their value step and trim.
        const text = `${id}:gpt-5.6-luna:codex`;
        let hash = 0;
        for (let k = 0; k < text.length; k++) hash = (((hash << 5) - hash) + text.charCodeAt(k)) | 0;
        assert.equal(variant % 4, Math.abs(hash) % 4);
        seen.add(variant);
    }
    assert.equal(seen.size, ROBE_VARIANT_COUNT);
});

test('twelve distinct variants: value steps in the existing range, hue within the clamp', () => {
    const keys = new Set();
    for (let v = 0; v < ROBE_VARIANT_COUNT; v++) {
        const { value, hue } = robeVariant(v);
        assert.ok(value >= ROBE_VALUE_RANGE[0] && value <= ROBE_VALUE_RANGE[1], `value ${value}`);
        assert.ok(Math.abs(hue) <= ROBE_HUE_LIMIT_DEG, `hue ${hue}`);
        keys.add(`${value},${hue}`);
        for (const source of ROBE_SOURCES) {
            assert.ok(Math.abs(robeHueTurn(v, source)) <= ROBE_HUE_LIMIT_DEG);
        }
    }
    assert.equal(keys.size, ROBE_VARIANT_COUNT);
    assert.deepEqual(robeVariant(0), { value: 1, hue: 0 });
    assert.deepEqual(robeVariant(ROBE_VARIANT_COUNT + 3), robeVariant(3));
});

test('a shifted robe texel turns its hue by at most the clamp and never changes for variant 0', () => {
    for (const source of ROBE_SOURCES) {
        assert.deepEqual(shiftRobeColor(source, 0, source), source);
        for (let v = 0; v < ROBE_VARIANT_COUNT; v++) {
            if (robeVariant(v).value !== 1) continue;
            const out = shiftRobeColor(source, v, source);
            const turn = hueDelta(oklabHue(source), oklabHue(out));
            // One sRGB quantisation step of slack on dark, near-neutral texels.
            assert.ok(Math.abs(turn) <= ROBE_HUE_LIMIT_DEG + 1, `turn ${turn.toFixed(2)} for v${v}`);
            if (robeVariant(v).hue !== 0) assert.ok(Math.sign(turn) === Math.sign(robeVariant(v).hue));
        }
    }
});

test('palette swap recolours only declared robe texels, and the cache key collapses inert roles', () => {
    const robe = '#34184f';
    const skin = [214, 170, 140, 255];
    const data = new Uint8ClampedArray([...hexRgb(robe), 255, ...skin]);
    const ctx = { getImageData: () => ({ data }), putImageData() {} };
    const compositor = Object.create(Compositor.prototype);
    compositor.assets = {
        palettes: { claude: { trim: ['#d97757', '#e08a64', '#c86a4a'] } },
        getEntry: (id) => (id === 'agent.claude.sonnet'
            ? { paletteSource: { robe: [robe] } }
            : { paletteSource: {} }),
    };
    compositor._applyPaletteSwap(ctx, 2, 1, 'claude', 4, null, { robe: [robe] });
    assert.notDeepEqual([...data.subarray(0, 3)], hexRgb(robe));
    assert.deepEqual([...data.subarray(4, 8)], skin);

    const sonnetKeys = new Set();
    const bareKeys = new Set();
    for (let v = 0; v < ROBE_VARIANT_COUNT; v++) {
        sonnetKeys.add(compositor._resolvedVariantKey('claude', v, null, 'agent.claude.sonnet'));
        bareKeys.add(compositor._resolvedVariantKey('claude', v, null, 'agent.kimi.base'));
    }
    assert.equal(sonnetKeys.size, ROBE_VARIANT_COUNT);
    assert.equal(bareKeys.size, 1);
});

const AGENT_IDS = Array.from({ length: 300 }, (_, i) => `session-${i.toString(36)}-${(i * 7919) % 1000}`);

test('cosmetic hat selection is deterministic and spreads over the whole set', () => {
    const seen = new Set();
    for (const agentId of AGENT_IDS) {
        const hat = resolveHeadAccessory({ agentId });
        assert.equal(resolveHeadAccessory({ agentId }), hat, 'same id, same hat');
        assert.ok(COSMETIC_HEAD_ACCESSORIES.includes(hat), `${hat} is a cosmetic hat`);
        seen.add(hat);
    }
    assert.equal(seen.size, COSMETIC_HEAD_ACCESSORIES.length);
    // Hair tufts only ever land on a shaved (`headBare`) sheet.
    const bare = new Set(AGENT_IDS.map((agentId) => resolveHeadAccessory({ agentId, headBare: true })));
    for (const tuft of HAIR_TUFT_ACCESSORIES) assert.ok(bare.has(tuft), `${tuft} reachable on a bare head`);
    assert.equal(resolveHeadAccessory({ agentId: null }), null);
});

test('the effort crest always wins; headCovered sheets take no cosmetic hat', () => {
    for (const agentId of AGENT_IDS.slice(0, 40)) {
        assert.equal(resolveHeadAccessory({ agentId, effortAccessory: 'effortMax' }), 'effortMax');
        assert.equal(resolveHeadAccessory({ agentId, effortAccessory: 'effortUltra', headCovered: true }), 'effortUltra');
        assert.equal(resolveHeadAccessory({ agentId, headCovered: true }), null);
        // A sheet that refuses the crest falls back to the cosmetic hat.
        assert.equal(
            resolveHeadAccessory({ agentId, effortAccessory: 'effortXhigh', allowEffort: false }),
            resolveHeadAccessory({ agentId }),
        );
    }
});

test('every cosmetic overlay is registered with a PNG, and the manifest flags covered heads', () => {
    const manifestUrl = new URL('../../claudeville/assets/sprites/manifest.yaml', import.meta.url);
    const manifest = readFileSync(manifestUrl, 'utf8');
    for (const name of [...COSMETIC_HEAD_ACCESSORIES, ...HAIR_TUFT_ACCESSORIES]) {
        const id = `overlay.accessory.${name}`;
        assert.match(manifest, new RegExp(`- id: ${id.replace(/\./g, '\\.')}\\n`), `${id} in manifest`);
        assert.ok(existsSync(new URL(`../../claudeville/assets/sprites/overlays/${id}.png`, import.meta.url)), `${id}.png on disk`);
    }
    // Hatted sheets keep their authored headgear (Opus archmage hat, Luna helm).
    for (const id of ['agent.claude.opus', 'agent.claude.sonnet', 'agent.codex.gpt56luna', 'agent.codex.gpt56sol']) {
        const block = manifest.split(`  - id: ${id}\n`)[1]?.split('\n  - id: ')[0] || '';
        assert.match(block, /\n {4}headCovered: true\n/, `${id} is headCovered`);
    }
});

test('a hood back stamp closes its face opening with the cloth colour', () => {
    // One row: outline, cloth, hole, hole, cloth, outline.
    const outline = [20, 18, 16, 255];
    const cloth = [90, 110, 96, 255];
    const data = new Uint8ClampedArray([...outline, ...cloth, 0, 0, 0, 0, 0, 0, 0, 0, ...cloth, ...outline]);
    fillOverlayGaps(data, 6, 1);
    assert.deepEqual([...data.subarray(8, 12)], cloth);
    assert.deepEqual([...data.subarray(12, 16)], cloth);
    assert.deepEqual([...data.subarray(0, 4)], outline);
});
