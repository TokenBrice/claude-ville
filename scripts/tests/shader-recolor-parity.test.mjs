import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { collectSpriteEntries, loadSpriteManifest, pathForEntry, actionStripPathsForEntry, spritesRoot } from '../sprites/manifest-utils.mjs';
import { Compositor, bakeSpriteOutline, downsampleMajorityWithChannels, LOD_OUTLINE_ALPHA } from '../../claudeville/src/presentation/character-mode/Compositor.js';
import { AgentPaletteLutTable, CANVAS_CELL_CACHE, agentLayerRecords, canvasPoseCell, modelLayerSheet, finishAgentLayerFrame,
    clearLayerCaches, outlineHat, paletteIdentity, recolorCellBytes } from '../../claudeville/src/presentation/character-mode/AgentLayerRecords.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { GPU_RECORD_FLAGS, normalizeGpuRecord } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { packGeometryPixels } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';
import { stageGpuRecords, createRecordStaging } from '../../claudeville/src/presentation/character-mode/gpu/GpuRecordLayout.js';

const roster = collectSpriteEntries(loadSpriteManifest()).filter(e => e.id.startsWith('agent.') && e.materialSidecar);
const read = path => PNG.sync.read(readFileSync(join(spritesRoot, path)));
const trims = ['#e85d75', '#48b89f', '#d9a441', null];
const manifest = JSON.parse(readFileSync(join(spritesRoot, 'characters/roster-palettes.json')));

test('every sheet and strip texel matches the legacy palette swap for all variants and trims', t => {
    assert.equal(roster.length, 40);
    let pixels = 0, images = 0, overlap = 0;
    const lut = new AgentPaletteLutTable();
    const legacy = Object.create(Compositor.prototype);
    legacy.assets = {};
    for (const entry of roster) {
        const paths = [pathForEntry(entry), actionStripPathsForEntry(entry)[0]];
        // Both transforms are pointwise. Compare every distinct (RGBA, code)
        // input from both images; repeated occurrences have identical outputs.
        const unique = new Set();
        for (const path of paths) {
            const { data } = read(path);
            const material = read(path.replace(/\.png$/, '.material.png')).data;
            assert.equal(data.length, material.length);
            const packed = packGeometryPixels(material, null, data.length/4, true);
            const rgba = new Uint32Array(data.buffer, data.byteOffset, data.length/4);
            for (let i = 0; i < rgba.length; i++) unique.add(rgba[i]*64 + (packed[4*i+2] >> 1));
            pixels += rgba.length;
            images++;
        }
        const albedo = new Uint8ClampedArray(unique.size * 4);
        const inputs = new Uint32Array(albedo.buffer);
        const packed = new Uint8Array(albedo.length);
        let i = 0;
        for (const key of unique) {
            inputs[i] = Math.floor(key/64);
            packed[4*i+2] = (key%64) << 1;
            i++;
        }
        const model = manifest.models[entry.id];
        assert.ok(model.robeColors.length <= 31);
        overlap += model.robeColors.filter(tuple => tuple[4] >= 0).length;
        for (let variant = 0; variant < 12; variant++) for (const trim of trims) {
            lut.used.clear();
            const identity = paletteIdentity(entry.id, variant, trim);
            const row = lut.rowFor(identity);
            const actual = albedo.slice(), expected = albedo.slice();
            legacy._applyPaletteSwap({ getImageData: () => ({ data: expected }), putImageData() {} },
                inputs.length, 1, '', variant, trim, entry.paletteSource);
            recolorCellBytes(actual, packed, lut.data.subarray(row*256, (row+1)*256), false);
            assert.deepEqual(actual, expected, [entry.id, variant, trim].join('|'));
        }
    }
    assert.equal(images, 80);
    assert.ok(overlap > 0);
    const fire = read('luts/light-ramp.command.png').data;
    for (let y = 0; y < 3; y++) assert.deepEqual([...lut.data.subarray(y*256, y*256+44)], [...fire.subarray(y*44, (y+1)*44)]);
    assert.equal(lut.data.byteLength, 65536);
    t.diagnostic(`${images} images, ${pixels} pixels, ${overlap} overlapping robe/trim color, max byte difference 0`);
});

test('the top/side rim stays off the hat contact edge and its two shadow rows bypass bakedRim', () => {
    const w = 13, h = 9, data = new Uint8ClampedArray(w*h*4);
    for (let y = 2; y <= 4; y++) for (let x = 2; x <= 10; x++) data.set([180,110,60,255], (y*w+x)*4);
    outlineHat(data,w,h);
    const rgba = (x,y) => [...data.subarray((y*w+x)*4,(y*w+x)*4+4)];
    for (let x = 2; x <= 10; x++) assert.deepEqual(rgba(x,1), [28,20,16,128]);
    for (let y = 2; y <= 4; y++) assert.deepEqual(rgba(1,y), [28,20,16,128]);
    for (let y = 5; y <= 6; y++) for (let x = 3; x <= 9; x++) assert.deepEqual(rgba(x,y), [0,0,0,56]);
    for (let x = 0; x < w; x++) for (let y = 5; y < h; y++) assert.notEqual(rgba(x,y)[3], 128);
    for (let value = 0; value < 256; value++) assert.ok(Math.abs(Math.round(value*0.78)-Math.round(value*(1-56/255))) <= 1);
    const names = ['seatBack', 'weaponBack', 'body', 'frost', 'snow', 'hat', 'weaponFront', 'seatFront'];
    const records = agentLayerRecords(Object.fromEntries(names.toReversed().map(name => [name, { name }])));
    assert.deepEqual(records.map(record => record.name), names);
    assert.deepEqual(records.map(record => record.layer), [0, 1, 2, 3, 3, 4, 5, 6]);
});

test('every LOD vote copies both channels from one original texel and outline writes leave its index zero', () => {
    for (const entry of roster) {
        const path = pathForEntry(entry);
        const {data, width:w, height:h} = read(path);
        const material = read(path.replace(/\.png$/,'.material.png')).data;
        const packed = packGeometryPixels(material, material, w*h, true);
        const out = new Uint8ClampedArray(w*h), geo = new Uint8ClampedArray(w*h);
        downsampleMajorityWithChannels(data,w,out,w/2,h/2,92,packed,geo);
        bakeSpriteOutline({ getImageData: () => ({data:out}), putImageData() {} }, w/2,h/2,46,LOD_OUTLINE_ALPHA);
        const rgba = new Uint32Array(out.buffer), codes = new Uint32Array(geo.buffer);
        const src = new Uint32Array(data.buffer,data.byteOffset,w*h), input = new Uint32Array(packed.buffer);
        for (let i = 0; i < rgba.length; i++) {
            if (out[4*i+3] !== 255) { if (codes[i]) assert.fail('orphan LOD material or rim'); continue; }
            const base = Math.floor(i/(w/2))*2*w + (i%(w/2))*2;
            let matched = false;
            for (const j of [base,base+1,base+w,base+w+1]) {
                if ((src[j]&0xffffff) === (rgba[i]&0xffffff) && data[4*j+3]>=160 && input[j]===codes[i]) matched = true;
            }
            if (!matched) assert.fail(entry.id + ' split LOD vote at '+i);
        }
    }
});

test('hard cache ceilings hold across five hot frames at 100 agents', t => {
    clearLayerCaches();
    const prev = globalThis.document, prevImageData = globalThis.ImageData;
    t.after(() => { globalThis.document = prev; globalThis.ImageData = prevImageData; clearLayerCaches(); });
    globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
    function canvas() {
        const result = { width: 0, height: 0 };
        const blank = (w,h) => new ImageData(new Uint8ClampedArray(w*h*4),w,h);
        const ctx = { canvas: result, drawImage() {}, save() {}, restore() {}, translate() {}, clearRect() {},
            getImageData: (_x,_y,w,h) => blank(w,h), putImageData(image) { result.pixels = image.data; },
            createImageData: blank,
        };
        result.getContext = () => ctx;
        return result;
    }
    globalThis.document = { createElement: canvas };
    const sources = new Map(roster.map(({id}) => [id,{width:736,height:920}]));
    const assets = { get: id => sources.get(id) };
    const agents = Array.from({length:100}, (_, i) => paletteIdentity(roster[i%40].id, i%12, trims[i%3]));
    const cell = { sx: 0, sy: 0, sw: 92, sh: 92 };
    const sample = identity => canvasPoseCell(assets, identity, assets.get(identity.model), cell);
    for (let row = 0; row < 7; row++) {
        cell.sy = row*92;
        for (const identity of agents) sample(identity);
    }
    const model = identity => modelLayerSheet(assets, identity.model, null, null, null, packGeometryPixels, cell);
    for (const identity of agents) model(identity);
    const times = [];
    for (let frame = 0; frame < 5; frame++) {
        finishAgentLayerFrame();
        const start = performance.now();
        for (const identity of agents) { sample(identity); model(identity); }
        times.push(performance.now()-start);
        const stats = AgentSprite.sharedCacheStats();
        assert.ok(stats.canvasCells <= 512 && stats.canvasCellBytes <= 16.5*1024*1024);
        assert.ok(stats.modelBaseBytes <= 72*1024*1024);
        assert.equal(stats.gpuEquippedMaxComposeMs,0);
    }
    const stats = AgentSprite.sharedCacheStats();
    assert.ok(CANVAS_CELL_CACHE.entries.size >= 500 && stats.modelBaseBytes > 50*1024*1024);
    assert.ok(Math.max(...times)<16);
    t.diagnostic(`100 warm agents, max ${Math.max(...times).toFixed(3)} ms; ${stats.canvasCells} cells, ${stats.canvasCellBytes} bytes; model cache ${stats.modelBaseBytes} bytes`);
});

test('the 72-byte scalar record preserves all eight extended flags and both adjacent metadata values', () => {
    const names = ['recolorIndex','faceKeyed','goldenRim','reliefMaterial','surfacePage','mirrorSource','shaftReceiver','surfaceRelative'];
    const properties = Object.fromEntries(names.map((name,i) => {
        assert.equal(GPU_RECORD_FLAGS[name], 2**(14+i)); return [name,true];
    }));
    assert.equal(normalizeGpuRecord({ flags: 0x3fc000 }).flags, 0x3fc000);
    const previous = normalizeGpuRecord({ ...properties, variant: 7, recolorRow: 99 });
    normalizeGpuRecord({}, 0, previous);
    assert.deepEqual([previous.flags, previous.meta, previous.recolorRow], [0, 0, 0]);
    const records = [normalizeGpuRecord({...properties,variant:11,recolorRow:255}), normalizeGpuRecord({alpenglowRow:102})];
    const stage = createRecordStaging();
    assert.equal(stageGpuRecords([{records}],stage,{fullTail:true}),144);
    const u = stage.u16;
    assert.equal(u[26],255);
    assert.equal(u[27] | (u[34]<<16),0x3fc000);
    assert.equal(u[35],11);
    assert.equal(u[36+34],0);
    assert.equal(u[36+35],102);
    // Keep every admitted row stable while a frame has 253 distinct identities.
    const lut = new AgentPaletteLutTable();
    const identity = paletteIdentity(roster[0].id,0,null);
    for (let i=0;i<252;i++) assert.equal(lut.rowFor({...identity,key:String(i)}),i+4);
    assert.equal(lut.rowFor({...identity,key:'overflow'}),0);
    lut.used.clear();
    assert.equal(lut.rowFor({...identity,key:'next'}),4);
});
