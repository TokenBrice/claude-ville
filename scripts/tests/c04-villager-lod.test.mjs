import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import * as CompositorModule from '../../claudeville/src/presentation/character-mode/Compositor.js';
import * as FirelightModule from '../../claudeville/src/presentation/character-mode/gpu/Firelight.js';
import { contactShadowStamp } from '../../claudeville/src/presentation/character-mode/AgentGroundMarks.js';
import { effectBudgetMode } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { collectSpriteEntries, loadSpriteManifest, spritesRoot } from '../sprites/manifest-utils.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHAR_DIR = join(REPO_ROOT, 'claudeville', 'assets', 'sprites', 'characters');

function makeMockCanvas(width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    const ctx = {
        imageSmoothingEnabled: true,
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        getImageData: (x, y, w, h) => {
            const out = new Uint8ClampedArray(w * h * 4);
            for (let row = 0; row < h; row++) {
                const srcOff = ((y + row) * width + x) * 4;
                out.set(data.subarray(srcOff, srcOff + w * 4), row * w * 4);
            }
            return { width: w, height: h, data: out };
        },
        putImageData: (img, x, y) => {
            for (let row = 0; row < img.height; row++) {
                const srcOff = row * img.width * 4;
                const dstOff = ((y + row) * width + x) * 4;
                data.set(img.data.subarray(srcOff, srcOff + img.width * 4), dstOff);
            }
        },
        drawImage() {},
    };
    return { width, height, data, getContext: () => ctx };
}

function luma(r, g, b) {
    return r * 0.299 + g * 0.587 + b * 0.114;
}

test('C-04: downsampleMajority keeps interior robe colours and attached crown tips on real character sheets', () => {
    const { downsampleMajority } = CompositorModule;
    assert.equal(typeof downsampleMajority, 'function', 'downsampleMajority is exported');
    assert.equal(CompositorModule.liftDarkGarmentSheet, undefined, 'liftDarkGarmentSheet is dropped per review');

    // Synthetic edge tie: 1 dark ink pixel + 1 interior colour pixel -> interior wins, never ink crust.
    const synthSrc = new Uint8ClampedArray(4 * 4 * 4);
    const setPx = (buf, w, x, y, rgba) => {
        const o = (y * w + x) * 4;
        buf[o] = rgba[0]; buf[o + 1] = rgba[1]; buf[o + 2] = rgba[2]; buf[o + 3] = rgba[3];
    };
    setPx(synthSrc, 4, 0, 0, [6, 4, 2, 255]);       // dark ink outline
    setPx(synthSrc, 4, 1, 0, [110, 140, 180, 255]); // interior steel robe
    // Isolated bright 1px speck in bottom-right 2x2 block (no opaque 8-neighbour) -> dropped.
    setPx(synthSrc, 4, 3, 3, [240, 210, 90, 255]);
    const synthDst = new Uint8ClampedArray(2 * 2 * 4);
    downsampleMajority(synthSrc, 4, synthDst, 2, 2, 4);
    assert.deepEqual([...synthDst.subarray(0, 4)], [110, 140, 180, 255], 'interior robe beats dark outline ink');
    assert.equal(synthDst[(1 * 2 + 1) * 4 + 3], 0, 'detached 1px bright air mote still drops');

    // Real sheets: dark-robed DeepSeek bodies keep interior robe tones (no near-black collapse)
    // and Sol.b retains attached golden sunburst crown pixels.
    for (const id of ['agent.deepseek.reasoner', 'agent.deepseek.pro']) {
        const png = PNG.sync.read(readFileSync(join(CHAR_DIR, id, 'sheet.png')));
        const w = png.width >> 1;
        const h = png.height >> 1;
        const dst = new Uint8ClampedArray(w * h * 4);
        downsampleMajority(png.data, png.width, dst, w, h, 92);
        let solid = 0;
        let darkInk = 0;
        for (let i = 0; i < dst.length; i += 4) {
            if (dst[i + 3] < 160) continue;
            solid++;
            if (luma(dst[i], dst[i + 1], dst[i + 2]) < 26) darkInk++;
        }
        const darkShare = darkInk / Math.max(1, solid);
        assert.ok(darkShare < 0.35, `${id} 0.5x LOD dark-ink share ${(darkShare * 100).toFixed(1)}% < 35% (was 59-76%)`);
    }

    // Sol.b sunburst crown: verify attached bright gold edge pixels survive (not sheared off).
    const sol = PNG.sync.read(readFileSync(join(CHAR_DIR, 'agent.codex.gpt56sol.b', 'sheet.png')));
    const sw = sol.width >> 1;
    const sh = sol.height >> 1;
    const solDst = new Uint8ClampedArray(sw * sh * 4);
    downsampleMajority(sol.data, sol.width, solDst, sw, sh, 92);
    let goldCrownPx = 0;
    for (let cellY = 0; cellY < 10; cellY++) {
        for (let cellX = 0; cellX < 8; cellX++) {
            for (let ly = 4; ly < 16; ly++) {
                for (let lx = 12; lx < 34; lx++) {
                    const o = ((cellY * 46 + ly) * sw + (cellX * 46 + lx)) * 4;
                    if (solDst[o + 3] >= 160 && solDst[o] > 180 && solDst[o + 1] > 130 && solDst[o + 2] < 110) {
                        goldCrownPx++;
                    }
                }
            }
        }
    }
    assert.ok(goldCrownPx >= 260, `Sol.b 0.5x golden crown pixels ${goldCrownPx} >= 260`);
});

test('C-04: LOD_OUTLINE_ALPHA sits cleanly inside the shader bakedRim (0.4, 0.6) window with >= 10 LSB margin', () => {
    const { LOD_OUTLINE_ALPHA, bakeSpriteOutline } = CompositorModule;
    assert.ok(Number.isInteger(LOD_OUTLINE_ALPHA), 'LOD_OUTLINE_ALPHA is an exported integer');
    // Shader bakedRim checks albedo.a > 0.4 (102/255) && albedo.a < 0.6 (153/255).
    assert.ok(LOD_OUTLINE_ALPHA >= 112 && LOD_OUTLINE_ALPHA <= 128,
        `LOD_OUTLINE_ALPHA=${LOD_OUTLINE_ALPHA} (${(LOD_OUTLINE_ALPHA / 255).toFixed(3)}) sits cleanly inside (0.4, 0.6)`);

    const canvas = makeMockCanvas(8, 8);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(8, 8);
    const center = (4 * 8 + 4) * 4;
    img.data.set([120, 140, 160, 255], center);
    ctx.putImageData(img, 0, 0);
    bakeSpriteOutline(ctx, 8, 8, 8, LOD_OUTLINE_ALPHA);
    const leftRim = (4 * 8 + 3) * 4;
    assert.equal(canvas.data[leftRim + 3], LOD_OUTLINE_ALPHA, 'bakeSpriteOutline applies custom LOD_OUTLINE_ALPHA');
});

test('C-04: AgentGroundMarks contact shadow core alpha strengthens boot grounding to 148 while outer stays 66', () => {
    const prevDocument = globalThis.document;
    globalThis.document = { createElement: () => makeMockCanvas(1, 1) };
    // Resize mock canvas on width/height assignment
    globalThis.document = {
        createElement: () => {
            let backing = makeMockCanvas(1, 1);
            return {
                get width() { return backing.width; },
                set width(w) { backing = makeMockCanvas(w, backing.height); },
                get height() { return backing.height; },
                set height(h) { backing = makeMockCanvas(backing.width, h); },
                get data() { return backing.data; },
                getContext: () => backing.getContext('2d'),
            };
        },
    };
    try {
        const stamp = contactShadowStamp(24, { key: 'none', steps: 0, dx: 0, dy: 0 });
        assert.ok(stamp, 'contactShadowStamp returns a canvas');
        const alphas = new Set();
        for (let i = 3; i < stamp.data.length; i += 4) {
            if (stamp.data[i] > 0) alphas.add(stamp.data[i]);
        }
        assert.ok(alphas.has(148), `shadow core alpha includes 148 (got ${[...alphas].join(', ')})`);
        assert.ok(alphas.has(66), `shadow outer alpha keeps 66 (got ${[...alphas].join(', ')})`);
    } finally {
        globalThis.document = prevDocument;
    }
});

test('C-04: all 39 roster characters declare M/E/O sidecars, Opus emissive stays untouched, and gpt6astra.b trim avoids face skin', () => {
    const manifest = loadSpriteManifest();
    const chars = collectSpriteEntries(manifest).filter((e) => e.id?.startsWith('agent.'));
    assert.equal(chars.length, 39, '39 roster characters');
    for (const entry of chars) {
        assert.equal(entry.materialSidecar, true, `${entry.id} declares materialSidecar: true`);
        assert.equal(entry.emissiveSidecar, true, `${entry.id} declares emissiveSidecar: true`);
        assert.equal(entry.occluderSidecar, true, `${entry.id} declares occluderSidecar: true`);
    }
    for (const id of ['agent.claude.opus', 'agent.claude.opus.b', 'agent.codex.gpt56sol.b', 'agent.codex.gpt56luna.b']) {
        for (const stem of ['sheet', 'actions']) {
            for (const ch of ['material', 'emissive', 'occluder']) {
                const p = join(spritesRoot, 'characters', id, `${stem}.${ch}.png`);
                assert.ok(existsSync(p), `sidecar exists: ${id}/${stem}.${ch}.png`);
            }
        }
    }

    // Opus crystal emissive stays untouched per REVIEW.md:97
    const opus = chars.find((e) => e.id === 'agent.claude.opus');
    assert.equal(opus.emissive?.strength, 0.45, 'Opus emissive.strength remains 0.45');
    assert.equal(opus.emissive?.sources?.[0]?.geometry, 'sidecar-required', 'Opus emissive geometry remains sidecar-required');

    // gpt6astra.b paletteSource avoids open-visor face skin and matches violet cape + cool steel trim
    const astraB = chars.find((e) => e.id === 'agent.codex.gpt6astra.b');
    const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const listOf = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(hexRgb);
    const trimSources = listOf(astraB.paletteSource?.trim);
    const robeSources = listOf(astraB.paletteSource?.robe);
    assert.ok(trimSources.length > 0 && robeSources.length > 0, 'gpt6astra.b declares robe and trim');
    const png = PNG.sync.read(readFileSync(join(CHAR_DIR, 'agent.codex.gpt6astra.b', 'sheet.png')));
    const near = (r, g, b, src) => src.some(([sr, sg, sb]) => Math.abs(r - sr) <= 12 && Math.abs(g - sg) <= 12 && Math.abs(b - sb) <= 12);
    // Warm skin pixels in idle-S face box around portraitFace {x: 44, y: 30}
    let faceTrimHits = 0;
    for (let y = 6 * 92 + 22; y < 6 * 92 + 38; y++) {
        for (let x = 36; x < 52; x++) {
            const o = (y * png.width + x) * 4;
            if (png.data[o + 3] < 200) continue;
            const [r, g, b] = [png.data[o], png.data[o + 1], png.data[o + 2]];
            if (r > g + 18 && g > b + 12 && near(r, g, b, trimSources)) faceTrimHits++;
        }
    }
    assert.equal(faceTrimHits, 0, 'gpt6astra.b trim never collides with open-visor face skin');

    // Cut scope invariants: carried-lanterns stays 12/6/0, no moonRim helper in Firelight.js
    assert.deepEqual([0, 1, 2].map((lvl) => effectBudgetMode('carried-lanterns', lvl)), [12, 6, 0]);
    assert.equal(FirelightModule.computeMoonRimStrength, undefined, 'moonRim cut per review');
});
