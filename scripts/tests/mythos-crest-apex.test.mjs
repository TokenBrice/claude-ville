import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

import { Compositor, HEAD_APEX_COLUMNS, STRIP_HEAD_MATCHED } from '../../claudeville/src/presentation/character-mode/Compositor.js';

const CELL = 92;
const DIRECTIONS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
const OVERLAY = { w: 16, h: 12, anchor: [8, 10] };

function png(id, name) {
    return PNG.sync.read(readFileSync(new URL(`../../claudeville/assets/sprites/characters/${id}/${name}.png`, import.meta.url)));
}

// Drives the real _compositeAccessory over a sheet or strip and returns the
// crest stamps it draws, as cell-local overlay anchor points.
function crestStamps(id, name) {
    const base = png(id, 'sheet');
    const target = name === 'sheet' ? base : png(id, name);
    const draws = [];
    const ctx = {
        getImageData: () => ({ data: Uint8ClampedArray.from(target.data) }),
        putImageData() {}, save() {}, restore() {}, beginPath() {}, clip() {},
        rect(x, y) { this.cell = [x, y]; },
        drawImage(img, ...args) {
            const [x, y] = args.length === 4 ? args : args.slice(4, 6);
            draws.push({ cellX: this.cell[0], cellY: this.cell[1], x, y });
        },
    };
    const comp = Object.create(Compositor.prototype);
    comp.assets = {
        get: () => ({}),
        getDims: (key) => (key.startsWith('overlay.') ? { w: OVERLAY.w, h: OVERLAY.h } : { w: base.width, h: base.height }),
        getAnchor: () => OVERLAY.anchor,
        palettes: {},
    };
    comp._harmonizeOverlay = () => ({ front: 'front', back: 'back', colBottom: new Int16Array(OVERLAY.w).fill(-1) });
    comp._baseSheetAlpha = () => ({ data: base.data, width: base.width });
    const grid = name === 'sheet' ? null
        : { dims: { w: target.width, h: target.height }, rows: target.height / CELL, cellSize: CELL };
    comp._compositeAccessory(ctx, id, 'crestXhigh', 'claude', grid);
    const occupied = (cellX, cellY) => {
        for (let y = 0; y < CELL; y++) {
            for (let x = 0; x < CELL; x++) if (target.data[((cellY + y) * target.width + cellX + x) * 4 + 3] >= 16) return true;
        }
        return false;
    };
    return draws.filter((d) => occupied(d.cellX, d.cellY)).map((d) => ({
        dir: DIRECTIONS[d.cellX / CELL],
        row: d.cellY / CELL,
        x: d.x + OVERLAY.anchor[0] - d.cellX,
        y: d.y + OVERLAY.anchor[1] - d.cellY,
    }));
}

// Mythos holds its ouroboros staff head level with the hood: an unrestricted
// apex scan drew the crest on the ring (from the back, right of the hood).
test('the Mythos crest sits on the hood in every walk, idle and action cell', () => {
    for (const name of ['sheet', 'actions']) {
        const stamps = crestStamps('agent.claude.mythos', name);
        assert.ok(stamps.length >= 80, name);
        for (const s of stamps) {
            assert.ok(Math.abs(s.x - 46) <= 4, `${name} ${s.dir} row ${s.row}: crest x ${s.x} is off the hood`);
        }
    }
});

// Wait and strike raise a hand above the head; sit and drink drop the head.
// On the bodies listed in STRIP_HEAD_MATCHED the crest follows the head.
test('second-body and Mythos action crests follow the head, not a raised hand', () => {
    for (const id of STRIP_HEAD_MATCHED) {
        const idle = new Map(crestStamps(id, 'sheet').filter((s) => s.row === 6).map((s) => [s.dir, s]));
        for (const s of crestStamps(id, 'actions')) {
            const head = idle.get(s.dir);
            assert.ok(Math.abs(s.x - head.x) <= 6, `${id} ${s.dir} row ${s.row}: x ${s.x} vs head ${head.x}`);
            assert.ok(s.y >= head.y - 4 && s.y <= head.y + 16, `${id} ${s.dir} row ${s.row}: y ${s.y} vs head ${head.y}`);
        }
    }
});

test('the apex column window is reserved for bodies whose staff rises to the hood', () => {
    assert.deepEqual(Object.keys(HEAD_APEX_COLUMNS), ['agent.claude.mythos']);
});
