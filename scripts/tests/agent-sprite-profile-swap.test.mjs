import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { Compositor } from '../../claudeville/src/presentation/character-mode/Compositor.js';
import { SpriteSheet } from '../../claudeville/src/presentation/character-mode/SpriteSheet.js';
import { getModelVisualIdentity } from '../../claudeville/src/presentation/shared/ModelVisualIdentity.js';
import { AssetManager } from '../../claudeville/src/presentation/character-mode/AssetManager.js';

// CPU raster stand-in: copies real source texels for alpha/geometry scans and
// rejects the browser's invalid-source case. Decorative painting is irrelevant.
function canvas(width = 0, height = 0) {
    const result = { width, height, pixels: null, sample: null };
    const ctx = {
        canvas: result, globalAlpha: 1,
        drawImage(source, ...args) {
            assert.ok(source?.width > 0 && source?.height > 0, 'drawImage needs a live source');
            const [sx, sy, sw, sh, dx, dy, dw, dh] = args.length === 8
                ? args : [0, 0, source.width, source.height, args[0] || 0, args[1] || 0, source.width, source.height];
            result.sample = (x, y) => {
                if (x < dx || y < dy || x >= dx + dw || y >= dy + dh) return [0, 0, 0, 0];
                const px = sx + Math.floor((x - dx) * sw / dw);
                const py = sy + Math.floor((y - dy) * sh / dh);
                if (source.pixels) return source.pixels.subarray((py * source.width + px) * 4, (py * source.width + px) * 4 + 4);
                return source.sample?.(px, py) || [0, 0, 0, 0];
            };
            result.pixels = null;
        },
        getImageData(x, y, w, h) {
            const data = new Uint8ClampedArray(w * h * 4);
            for (let iy = 0; iy < h; iy++) for (let ix = 0; ix < w; ix++) {
                const px = x + ix, py = y + iy;
                const pixel = result.pixels
                    ? result.pixels.subarray((py * result.width + px) * 4, (py * result.width + px) * 4 + 4)
                    : result.sample?.(px, py) || [0, 0, 0, 0];
                data.set(pixel, (iy * w + ix) * 4);
            }
            return { data, width: w, height: h };
        },
        putImageData(image) { result.pixels = image.data.slice(); result.sample = null; },
        measureText(text) { return { width: String(text).length * 6 }; },
        save() {}, restore() {}, fillRect() {}, clearRect() {}, translate() {}, scale() {},
        beginPath() {}, rect() {}, clip() {}, fillText() {}, strokeRect() {},
    };
    result.getContext = () => ctx;
    return result;
}

function installRaster(t) {
    const previousDocument = globalThis.document;
    const previousImageData = globalThis.ImageData;
    globalThis.document = { createElement: () => canvas() };
    globalThis.ImageData = class {
        constructor(data, width, height) { Object.assign(this, { data, width, height }); }
    };
    t.after(() => { globalThis.document = previousDocument; globalThis.ImageData = previousImageData; });
}

function bodySource({ minX, minY, maxX, maxY }) {
    const source = canvas(736, 920);
    source.sample = (x, y) => {
        x %= 92; y %= 92;
        return x >= minX && x <= maxX && y >= minY && y <= maxY
            ? [80, 100, 120, 255] : [0, 0, 0, 0];
    };
    return source;
}

function sprite(compositor, id = 'profile-swap') {
    const agent = { id, name: 'Swap', status: 'idle', provider: 'claude', model: 'claude-sonnet-4-6', position: { tileX: 10, tileY: 10 } };
    const result = new AgentSprite(agent, { compositor });
    result.gpuWorldEnabled = true;
    result.motionScale = 0;
    return result;
}

test('a delayed profile sheet preserves body and label geometry until the ready generation commits', t => {
    installRaster(t);
    const oldBounds = { minX: 22, minY: 10, maxX: 65, maxY: 80 };
    const newBounds = { minX: 16, minY: 5, maxX: 73, maxY: 85 };
    const oldSource = bodySource(oldBounds), nextSource = bodySource(newBounds);
    const oldId = getModelVisualIdentity('claude-sonnet-4-6', undefined, 'claude').spriteId;
    const sheets = new Map([[oldId, oldSource]]);
    const s = sprite({ spriteFor: id => sheets.get(id) || null });
    t.after(() => s.releaseRenderResources());
    const ctx = canvas(100, 100).getContext('2d');
    s.draw(ctx);
    const oldSheet = s.spriteSheet, oldKey = s._spriteProfileKey;
    const oldBox = { ...s._bodyBox }, oldLabelTop = s.identityLabelTopPx();
    assert.deepEqual(s._getCellContentBounds(oldSheet.cell('idle', s.direction, 0)), oldBounds);
    s.agent.model = 'claude-opus-4-6';
    for (let frame = 0; frame < 4; frame++) {
        s.draw(ctx);
        assert.equal(s.spriteCanvas, oldSource);
        assert.equal(s.spriteSheet, oldSheet);
        assert.equal(s._spriteProfileKey, oldKey);
        assert.deepEqual(s._bodyBox, oldBox);
        assert.equal(s._stableContentWidth(), 44);
        assert.equal(s.identityLabelTopPx(), oldLabelTop);
        assert.equal(s._gpuFrameRecord.source, oldSource);
        assert.equal(s._gpuFrameRecord.textureKey, `agent-sheet:${oldKey}`);
    }
    const nextId = getModelVisualIdentity(s.agent.model, undefined, 'claude').spriteId;
    sheets.set(nextId, nextSource);
    s.draw(ctx);
    assert.equal(s.spriteCanvas, nextSource);
    assert.equal(s.spriteSheet.image, nextSource);
    assert.notEqual(s._spriteProfileKey, oldKey);
    assert.deepEqual(s._getCellContentBounds(s.spriteSheet.cell('idle', s.direction, 0)), newBounds);
    assert.equal(s._stableContentWidth(), 58);
    assert.deepEqual(s._stableFootAnchor(s.direction), { cx2: 89, maxY: 85 });
    assert.notDeepEqual(s._bodyBox, oldBox);
    assert.equal(s._gpuFrameRecord.source, nextSource);
});

test('a first pending sheet retains default body/identity geometry and retries once ready', t => {
    installRaster(t);
    let ready = null;
    const s = sprite({ spriteFor: () => ready }, 'first-pending');
    t.after(() => s.releaseRenderResources());
    const before = s.identityLabelTopPx();
    const width = s._stableContentWidth();
    const ctx = canvas(100, 100).getContext('2d');
    s.draw(ctx);
    assert.equal(s.spriteCanvas, null);
    assert.equal(s.spriteSheet, null);
    assert.equal(s._stableContentWidth(), width);
    assert.equal(s.identityLabelTopPx(), before);
    ready = bodySource({ minX: 20, minY: 8, maxX: 60, maxY: 82 });
    s.draw(ctx);
    assert.equal(s.spriteCanvas, ready);
    assert.equal(s._stableContentWidth(), 41);
});

test('bounds and facing anchors share immutable sheet metadata without sharing placement', t => {
    installRaster(t);
    const bounds = { minX: 19, minY: 7, maxX: 69, maxY: 84 };
    const source = bodySource(bounds);
    const a = sprite(null, 'bounds-a'), b = sprite(null, 'bounds-b');
    for (const s of [a, b]) { s.spriteCanvas = source; s.spriteSheet = new SpriteSheet(source); }
    t.after(() => { a.releaseRenderResources(); b.releaseRenderResources(); });
    for (let direction = 0; direction < 8; direction++) {
        const cell = a.spriteSheet.cell('idle', direction, 0);
        assert.deepEqual(a._getCellContentBounds(cell), bounds);
        assert.equal(a._getCellContentBounds(cell), b._getCellContentBounds(cell));
        assert.deepEqual(a._stableFootAnchor(direction), { cx2: 88, maxY: 84 });
        assert.equal(a._stableFootAnchor(direction), b._stableFootAnchor(direction));
    }
    a._setBodyBox(10, 20, -15, -60, 36, 25);
    b._setBodyBox(30, 40, 12, -20, 63, 45);
    assert.notDeepEqual(a._bodyBox, b._bodyBox);
    a.releaseRenderResources();
    assert.deepEqual(b._getCellContentBounds(b.spriteSheet.cell('idle', 0, 0)), bounds);
});

test('packed geometry reuses sidecar sources across frame keys and replaces regenerated sources', t => {
    installRaster(t);
    AgentSprite.releaseSharedCaches();
    t.after(() => AgentSprite.releaseSharedCaches());
    const material = canvas(2, 1), occluder = canvas(2, 1);
    material.pixels = new Uint8ClampedArray([3, 0, 0, 255, 7, 0, 0, 0]);
    occluder.pixels = new Uint8ClampedArray([40, 90, 0, 255, 80, 0, 0, 255]);
    const assets = new AssetManager({ materialAssets: true });
    assets.assetVersion = 'one';
    t.after(() => assets.dispose());
    const id = 'agent.claude.opus';
    assets.companions.get('material').set(id, material);
    assets.companions.get('occluder').set(id, occluder);
    const host = { assets };
    const pack = (m, o) => AgentSprite.prototype._packedGeometrySource.call(host, m, o);
    const mOnly = pack(material, null), both = pack(material, occluder), oOnly = pack(null, occluder);
    assert.deepEqual([...mOnly.pixels], [3, 0, 0, 255, 0, 0, 0, 0]);
    assert.deepEqual([...both.pixels], [3, 40, 90, 255, 255, 80, 1, 255]);
    assert.deepEqual([...oOnly.pixels], [255, 40, 90, 255, 255, 80, 1, 255]);
    for (let frame = 0; frame < 8; frame++) {
        const resolved = assets.resolveMaterialChannels(id, `walk/s/${frame}`);
        assert.equal(pack(resolved.material, resolved.occluder), both);
        assert.equal(pack(material, null), mOnly);
        assert.equal(pack(material, occluder), both);
        assert.equal(pack(null, occluder), oOnly);
    }
    assert.equal(pack(null, null), null);
    assets.assetVersion = 'two';
    assert.equal(pack(material, occluder), both);
    const regeneratedMaterial = canvas(2, 1), regeneratedOccluder = canvas(2, 1);
    regeneratedMaterial.pixels = material.pixels.slice();
    regeneratedOccluder.pixels = occluder.pixels.slice();
    assert.notEqual(pack(regeneratedMaterial, occluder), both);
    assert.notEqual(pack(material, regeneratedOccluder), both);
    const regenerated = pack(regeneratedMaterial, regeneratedOccluder);
    assert.notEqual(regenerated, both);
    assert.deepEqual(regenerated.pixels, both.pixels);
    assert.equal(pack(regeneratedMaterial, regeneratedOccluder), regenerated);
});

test('new compositor registration reuses live composed pixels but not changed source generations', t => {
    installRaster(t);
    const base = canvas(8, 10);
    base.sample = () => [100, 100, 100, 255];
    let current = base;
    const assets = {
        assetVersion: 'one', palettes: { claude: { trim: ['#808080'] } },
        get: () => current, getDims: () => ({ w: 8, h: 10 }),
        getEntry: () => ({ paletteSource: { robe: '#646464' } }),
    };
    const a = new Compositor(assets), first = a.spriteFor('agent.claude.base', 'claude', 1, null);
    const b = new Compositor(assets), reused = b.spriteFor('agent.claude.base', 'claude', 1, null);
    assert.equal(reused, first);
    assert.deepEqual([...reused.pixels.subarray(0, 4)], [110, 110, 110, 255]);
    a.dispose();
    assert.deepEqual([...b.spriteFor('agent.claude.base', 'claude', 1, null).pixels.subarray(0, 4)], [110, 110, 110, 255]);
    current = canvas(8, 10); current.sample = () => [50, 50, 50, 255];
    const c = new Compositor(assets), replaced = c.spriteFor('agent.claude.base', 'claude', 1, null);
    assert.notEqual(replaced, first);
    assert.deepEqual([...replaced.pixels.subarray(0, 4)], [50, 50, 50, 255]);
    t.after(() => { a.dispose(); b.dispose(); c.dispose(); });
});
