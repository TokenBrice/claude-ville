import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';

// PF-4 — the label pass needs the overlay's CSS width for its device ratio,
// and the renderer maintains `_claudeVilleCssWidth` for exactly that read
// (see Camera._viewportWidth). The reserved-box mapping must consult the
// cached width before it touches the DOM, and still work without it.
test('reserved chrome boxes read the cached CSS width before clientWidth', () => {
    const sprite = Object.create(BuildingSprite.prototype);
    let clientReads = 0;
    const surface = {
        width: 240,
        get clientWidth() { clientReads++; return 120; },
        _claudeVilleCssWidth: 120,
    };
    const ctx = {
        canvas: surface,
        getTransform: () => ({
            a: 2, b: 0, c: 0, d: 2, e: 0, f: 0,
            inverse: () => ({ a: 0.5, b: 0, c: 0, d: 0.5, e: 0, f: 0 }),
        }),
    };
    const reserved = [{ left: 10, top: 20, right: 50, bottom: 40 }];
    const boxes = sprite._reservedWorldBoxes(ctx, reserved).map(box => ({ ...box }));
    assert.equal(clientReads, 0, 'the cached width answers before the DOM read');
    // dpr = 240 / 120 = 2: the device rect (20, 40)-(100, 80) maps back to the
    // same world box under the halving inverse.
    assert.deepEqual(boxes, [{ left: 10, top: 20, right: 50, bottom: 40 }]);

    delete surface._claudeVilleCssWidth;
    const fallback = sprite._reservedWorldBoxes(ctx, reserved).map(box => ({ ...box }));
    assert.equal(clientReads, 1, 'without the cache the DOM read still answers');
    assert.deepEqual(fallback, boxes);
});
