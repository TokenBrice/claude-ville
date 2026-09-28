import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStableGpuBatches,
  gpuRecordPageable,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import {
  ALBEDO_PAGE_GUTTER,
  ShelfPacker,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuAlbedoPage.js';

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
