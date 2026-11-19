import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

import { Compositor, HEAD_APEX_COLUMNS, STRIP_HEAD_MATCHED, overlayOpaqueBounds } from '../../claudeville/src/presentation/character-mode/Compositor.js';

const CELL = 92;
const DIRECTIONS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
// The shipped crest art and anchors (manifest overlay.accessory.effort*).
const CRESTS = { effortXhigh: [16, 18], effortMax: [16, 20], effortUltra: [16, 20] };
function overlay(name) {
    const img = PNG.sync.read(readFileSync(new URL(`../../claudeville/assets/sprites/overlays/overlay.accessory.${name}.png`, import.meta.url)));
    return { img, w: img.width, h: img.height, anchor: CRESTS[name] };
}

function png(id, name) {
    return PNG.sync.read(readFileSync(new URL(`../../claudeville/assets/sprites/characters/${id}/${name}.png`, import.meta.url)));
}

// Drives the real _compositeAccessory over a sheet or strip and returns the
// crest stamps it draws, as cell-local overlay anchor points.
function crestStamps(id, name, crest = 'effortXhigh') {
    const OVERLAY = overlay(crest);
    const base = png(id, 'sheet');
    const target = name === 'sheet' ? base : png(id, name);
    const draws = [];
    const ctx = {
        getImageData: () => ({ data: Uint8ClampedArray.from(target.data) }),
        putImageData() {}, save() {}, restore() {}, beginPath() {}, clip() {},
        rect(x, y) { this.cell = [x, y]; },
        drawImage(img, ...args) {
            const [x, y] = args.length === 4 ? args : args.slice(4, 6);
            const cropH = args.length === 4 ? OVERLAY.h : args[3];
            draws.push({ cellX: this.cell[0], cellY: this.cell[1], x, y, cropH });
        },
    };
    const comp = Object.create(Compositor.prototype);
    comp.assets = {
        get: () => ({}),
        getDims: (key) => (key.startsWith('overlay.') ? { w: OVERLAY.w, h: OVERLAY.h } : { w: base.width, h: base.height }),
        getAnchor: () => OVERLAY.anchor,
        palettes: {},
    };
    comp._harmonizeOverlay = () => ({
        front: 'front', back: 'back',
        colBottom: new Int16Array(OVERLAY.w).fill(-1),
        opaque: overlayOpaqueBounds(OVERLAY.img.data, OVERLAY.w, OVERLAY.h),
    });
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
    // Visible crest pixels the cell clip would cut off.
    const outside = (d) => {
        let n = 0;
        for (let oy = 0; oy < d.cropH; oy++) {
            for (let ox = 0; ox < OVERLAY.w; ox++) {
                if (OVERLAY.img.data[(oy * OVERLAY.w + ox) * 4 + 3] < 16) continue;
                const px = d.x + ox - d.cellX;
                const py = d.y + oy - d.cellY;
                if (px < 0 || py < 0 || px >= CELL || py >= CELL) n++;
            }
        }
        return n;
    };
    return draws.filter((d) => occupied(d.cellX, d.cellY)).map((d) => ({
        dir: DIRECTIONS[d.cellX / CELL],
        row: d.cellY / CELL,
        x: d.x + OVERLAY.anchor[0] - d.cellX,
        y: d.y + OVERLAY.anchor[1] - d.cellY,
        clipped: outside(d),
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

// Astra B's plume puts its head near the cell top, and wait or celebrate
// raise it further: every crest tier must stay whole inside its cell.
test('no crest tier loses a visible pixel to the cell clip on these bodies', () => {
    for (const id of STRIP_HEAD_MATCHED) {
        for (const crest of Object.keys(CRESTS)) {
            for (const name of ['sheet', 'actions']) {
                for (const s of crestStamps(id, name, crest)) {
                    assert.equal(s.clipped, 0, `${id} ${name} ${crest} ${s.dir} row ${s.row}: ${s.clipped} crest px clipped`);
                }
            }
        }
    }
});

test('the apex column window is reserved for bodies whose staff rises to the hood', () => {
    assert.deepEqual(Object.keys(HEAD_APEX_COLUMNS), ['agent.claude.mythos']);
});
