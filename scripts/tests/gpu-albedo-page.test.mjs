import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStableGpuBatches,
  gpuRecordPageable,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import {
  ALBEDO_PAGE_GUTTER,
  GpuAlbedoPage,
  ShelfPacker,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuAlbedoPage.js';

// EN-3 — a recording GL stand-in: `flushUploads` only needs the constants it
// reads back and the calls it makes; sources can be any width/height object.
function fakeGl() {
  const calls = [];
  const rec = (fn) => (...args) => {
    calls.push({ fn, args });
    return null;
  };
  let created = 0;
  const gl = {
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    TEXTURE_2D_ARRAY: 0x8c1a,
    READ_FRAMEBUFFER: 0x8ca8,
    READ_FRAMEBUFFER_BINDING: 0x8caa,
    COLOR_ATTACHMENT0: 0x8ce0,
    RGBA: 0x1908,
    RGBA8: 0x8058,
    UNSIGNED_BYTE: 0x1401,
    NEAREST: 0x2600,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    CLAMP_TO_EDGE: 0x812f,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    UNPACK_ROW_LENGTH: 0x0cf2,
    UNPACK_SKIP_PIXELS: 0x0cf4,
    UNPACK_SKIP_ROWS: 0x0cf3,
    getParameter: rec('getParameter'),
    createTexture: () => ({ id: ++created }),
    createFramebuffer: () => ({}),
    activeTexture: rec('activeTexture'),
    bindTexture: rec('bindTexture'),
    texParameteri: rec('texParameteri'),
    pixelStorei: rec('pixelStorei'),
    texImage2D: rec('texImage2D'),
    texSubImage2D: rec('texSubImage2D'),
    texImage3D: rec('texImage3D'),
    copyTexSubImage3D: rec('copyTexSubImage3D'),
    bindFramebuffer: rec('bindFramebuffer'),
    framebufferTexture2D: rec('framebufferTexture2D'),
    deleteTexture: rec('deleteTexture'),
  };
  return { gl, calls };
}

const sheet = (width, height) => ({ width, height });

function sheetRecord(textureKey, source, textureRevision, textureUpdates = null) {
  return {
    textureKey,
    source,
    sourceWidth: source.width,
    sourceHeight: source.height,
    textureRevision,
    textureUpdates,
  };
}

// The first place() overflows an absent page; the repack allocates it and the
// caller batches the frame again.
function allocatePage(gl) {
  const page = new GpuAlbedoPage(gl, 14);
  page.beginFrame(0);
  assert.equal(page.place(sheetRecord('seed', sheet(8, 8), 1)), null);
  assert.equal(page.repackIfOverflowed(), true);
  return page;
}

test('a continuous revision with sub-rect updates patches only the changed texels', () => {
  const { gl, calls } = fakeGl();
  const page = allocatePage(gl);
  const source = sheet(64, 32);
  const first = sheetRecord('agent-sheet:P', source, 1);
  assert.ok(page.place(first));
  let bytes = page.flushUploads();
  // First fill: the whole slot, through the DOM-source texImage2D.
  const whole = calls.filter((call) => call.fn === 'texImage2D' && call.args.length === 6);
  assert.equal(whole.length, 1);
  assert.equal(whole[0].args[5], source);
  assert.equal(bytes, 64 * 32 * 4);
  assert.equal(page.uploads, 1);

  calls.length = 0;
  page.beginFrame(1);
  const patch = { x: 4, y: 2, sx: 4, sy: 2, width: 8, height: 4, source };
  assert.ok(page.place(sheetRecord('agent-sheet:P', source, 2, [patch])));
  bytes = page.flushUploads();
  // The update path is chosen: a scratch sized to the patch, one sub-image
  // upload from the sheet, and a copy of the patch rect alone.
  const scratch = calls.filter(
    (call) => call.fn === 'texImage2D' && call.args.length === 9 && call.args[3] === 8 && call.args[4] === 4,
  );
  assert.equal(scratch.length, 1);
  const subImage = calls.find((call) => call.fn === 'texSubImage2D');
  assert.equal(subImage.args[8], source);
  assert.ok(calls.some((call) => call.fn === 'pixelStorei' && call.args[0] === gl.UNPACK_ROW_LENGTH && call.args[1] === 64));
  const copy = calls.find((call) => call.fn === 'copyTexSubImage3D');
  assert.deepEqual(
    [copy.args[2], copy.args[3], copy.args[7], copy.args[8]],
    [first.pageX + 4, first.pageY + 2, 8, 4],
  );
  assert.equal(bytes, 8 * 4 * 4);
  assert.equal(page.uploads, 2);
});

test('whole-slot uploads remain wherever no sub-rect knowledge exists', () => {
  const { gl, calls } = fakeGl();
  const page = allocatePage(gl);
  page.beginFrame(0);
  const source = sheet(64, 32);
  assert.ok(page.place(sheetRecord('agent-sheet:a', source, 1)));
  page.flushUploads();

  const assertWholeUpload = (lastSource) => {
    assert.equal(calls.some((call) => call.fn === 'texSubImage2D'), false);
    const whole = calls.filter((call) => call.fn === 'texImage2D' && call.args.length === 6);
    assert.equal(whole.length, 1);
    assert.equal(whole[0].args[5], lastSource);
  };

  // A re-baked sheet (a new source object) under the same key: whole, even if
  // a patch list rode along, because the page never held this canvas.
  calls.length = 0;
  page.beginFrame(1);
  const rebaked = sheet(64, 32);
  assert.ok(page.place(sheetRecord('agent-sheet:a', rebaked, 2, [
    { x: 0, y: 0, sx: 0, sy: 0, width: 8, height: 8, source: rebaked },
  ])));
  page.flushUploads();
  assertWholeUpload(rebaked);

  // A source back after a frame on its 2D texture (non-continuous): whole.
  calls.length = 0;
  page.beginFrame(3);
  assert.ok(page.place(sheetRecord('agent-sheet:a', rebaked, 3, [
    { x: 0, y: 0, sx: 0, sy: 0, width: 4, height: 4, source: rebaked },
  ])));
  page.flushUploads();
  assertWholeUpload(rebaked);
});

// B.1b — a pager that places every pageable record on one page.
function pagerFor(page) {
  return (record) => {
    if (!gpuRecordPageable(record, 1022)) return null;
    record.pageLayer = 0;
    record.pageX = 0;
    record.pageY = 0;
    return page;
  };
}

test('paged records batch across textures; sidecars, blend and depth still break', () => {
  const page = { key: 'albedo-page' };
  const tree = { width: 40, height: 60 };
  const cast = { width: 30, height: 12 };
  const landmark = { width: 200, height: 200 };
  const material = { width: 200, height: 200 };
  const records = [
    { source: cast, textureKey: 'tree-ground-cast:a', x: 0, y: 0 },
    { source: tree, textureKey: 'tree:oak|0|summer|0', x: 0, y: 0 },
    { source: tree, textureKey: 'tree:pine|0|summer|1', x: 50, y: 0 },
    { source: landmark, textureKey: 'building.forge', sidecarKey: 'building.forge:material', materialSource: material, x: 0, y: 0 },
    { source: tree, textureKey: 'tree:oak|0|summer|0', x: 90, y: 0 },
    { source: cast, textureKey: 'tree-ground-cast:b', x: 0, y: 0, blend: 'add' },
    { source: tree, textureKey: 'tree:oak|0|summer|0', x: 0, y: 0, depthSortY: 10, writesDepth: true },
  ];
  const batches = buildStableGpuBatches(records, [], [], pagerFor(page));
  assert.deepEqual(batches.map((batch) => batch.records.length), [3, 1, 1, 1, 1]);
  assert.deepEqual(batches.map((batch) => batch.page === page), [true, false, true, true, true]);
  assert.equal(batches[1].textureKey, 'building.forge');
  assert.equal(batches[1].records[0].pageLayer, -1);
});

test('only whole, sidecar-less, world-space sources that fit a layer are pageable', () => {
  const source = { width: 64, height: 32 };
  const base = { source, sourceWidth: 64, sourceHeight: 32, sx: 0, sy: 0, sw: 64, sh: 32, flags: 0, sidecarKey: '' };
  assert.equal(gpuRecordPageable(base, 1022), true);
  assert.equal(gpuRecordPageable({ ...base, sx: 16, sw: 32 }, 1022), true);
  assert.equal(gpuRecordPageable({ ...base, emissiveSource: {} }, 1022), false);
  assert.equal(gpuRecordPageable({ ...base, sidecarKey: 'x:channels' }, 1022), false);
  assert.equal(gpuRecordPageable({ ...base, flags: 8 }, 1022), false);
  assert.equal(gpuRecordPageable({ ...base, sw: 80 }, 1022), false);
  assert.equal(gpuRecordPageable({ ...base, source: { width: 2048, height: 32 }, sourceWidth: 2048 }, 1022), false);
  assert.equal(gpuRecordPageable({ ...base, source: { width: 64, height: 32, gpuResident: true } }, 1022), false);
});

test('shelf slots never overlap, keep their gutter and stay inside their layer', () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const size = 256;
  const packer = new ShelfPacker(size, 2);
  const slots = [];
  for (let index = 0; index < 400; index++) {
    const width = 1 + Math.floor(random() * 60);
    const height = 1 + Math.floor(random() * 60);
    const slot = packer.place(width, height);
    if (slot) slots.push({ ...slot, width, height });
  }
  assert.ok(slots.length > 20);
  for (const slot of slots) {
    assert.ok(slot.x >= 0 && slot.y >= 0);
    assert.ok(slot.x + slot.width + ALBEDO_PAGE_GUTTER <= size && slot.y + slot.height + ALBEDO_PAGE_GUTTER <= size);
  }
  for (let a = 0; a < slots.length; a++) {
    for (let b = a + 1; b < slots.length; b++) {
      const p = slots[a];
      const q = slots[b];
      if (p.layer !== q.layer) continue;
      const apart = p.x + p.width + ALBEDO_PAGE_GUTTER <= q.x || q.x + q.width + ALBEDO_PAGE_GUTTER <= p.x
        || p.y + p.height + ALBEDO_PAGE_GUTTER <= q.y || q.y + q.height + ALBEDO_PAGE_GUTTER <= p.y;
      assert.ok(apart, `slots ${a} and ${b} overlap`);
    }
  }
  assert.equal(new ShelfPacker(size, 1).place(size, 8), null);
});
