import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HULL_DIRECTIONS,
    HULL_ROLL_FRAMES,
    hullAuthoredDirections,
    hullDirectionSource,
    hullGeometry,
    hullHeadingDirection,
    hullStrip,
} from '../../claudeville/src/presentation/character-mode/HarborHulls.js';
import { hullSprites } from './support/harbor-sim.mjs';

// Phase 3.5 — directional hulls: [direction][roll] strips, mirrors for the
// unauthored diagonals, per-direction anchor and mastheads, hysteresis.

const dir = (dx, dy) => hullHeadingDirection(dx * 32 - dy * 32, (dx + dy) * 16);

test('travel along each tile diagonal faces its own view', () => {
    assert.equal(dir(1, 0), 'se');
    assert.equal(dir(0, 1), 'sw');
    assert.equal(dir(-1, 0), 'nw');
    assert.equal(dir(0, -1), 'ne');
});

test('a weaving course holds its view until another is clearly nearer', () => {
    // Straight up the screen sits on the NW / NE boundary: neither flips.
    assert.equal(hullHeadingDirection(0.5, -10, 'nw'), 'nw');
    assert.equal(hullHeadingDirection(-0.5, -10, 'ne'), 'ne');
    // A real turn flips it.
    assert.equal(hullHeadingDirection(10, -2, 'nw'), 'ne');
});

test('the manifest names each hull\'s bow and the authored views', () => {
    const { meta } = hullSprites();
    const hulls = [...meta.entries()];
    assert.ok(hulls.length >= 13);
    for (const [id, entry] of hulls) {
        assert.ok(['west', 'east'].includes(entry.bowFacing), `${id} has no bowFacing`);
        // 5.6: the class hulls author SW + NW; single-view strips name their bow.
        const expected = entry.directions || [entry.bowFacing === 'east' ? 'se' : 'sw'];
        assert.deepEqual(hullAuthoredDirections(entry), expected);
        assert.equal(entry.frames, HULL_ROLL_FRAMES * expected.length, `${id} frames`);
    }
    assert.deepEqual(hullAuthoredDirections({ directions: ['sw', 'nw'] }), ['sw', 'nw']);
    assert.deepEqual(hullDirectionSource({ directions: ['sw', 'nw'] }, 'ne'), { source: 'nw', mirrored: true, index: 1, count: 2 });
    assert.deepEqual(hullDirectionSource({ bowFacing: 'west' }, 'nw'), { source: 'sw', mirrored: false, index: 0, count: 1 });
    assert.deepEqual(hullDirectionSource({ bowFacing: 'east' }, 'sw'), { source: 'se', mirrored: true, index: 0, count: 1 });
});

test('every view of every hull puts its bow on its side, mirroring anchor and mastheads', () => {
    const { assets, meta } = hullSprites();
    for (const id of meta.keys()) {
        const sw = hullStrip(assets, id, 'sw');
        for (const direction of HULL_DIRECTIONS) {
            const strip = hullStrip(assets, id, direction);
            assert.equal(strip.direction, direction);
            assert.equal(strip.bowX, direction === 'sw' || direction === 'nw' ? -1 : 1, `${id} ${direction}`);
            assert.equal(strip.mastheads.length, HULL_ROLL_FRAMES);
            // A mirror is checked against its own authored source view
            // (NE against NW on a two-view strip, else against SW).
            const north = direction === 'ne' || direction === 'nw';
            const source = north && meta.get(id).directions?.includes('nw') ? hullStrip(assets, id, 'nw') : sw;
            if (north && source !== sw) {
                if (strip !== source) {
                    assert.equal(strip.anchorX, strip.frameWidth - 1 - source.anchorX, `${id} ${direction} anchor`);
                    strip.mastheads.forEach(([x, y], frame) => {
                        assert.deepEqual([x, y], [strip.frameWidth - 1 - source.mastheads[frame][0], source.mastheads[frame][1]]);
                    });
                }
            } else if (strip.mirrored === sw.mirrored) {
                assert.equal(strip.anchorX, sw.anchorX);
            } else {
                assert.equal(strip.anchorX, strip.frameWidth - 1 - sw.anchorX, `${id} ${direction} anchor`);
                strip.mastheads.forEach(([x, y], frame) => {
                    assert.deepEqual([x, y], [strip.frameWidth - 1 - sw.mastheads[frame][0], sw.mastheads[frame][1]]);
                });
            }
            // The waterline pivot keeps its world position in every view.
            const g = hullGeometry({ strip, frame: 2, x: 100, y: 200, bob: 0, sink: 0 });
            assert.equal(g.x + strip.anchorX, 100);
        }
        assert.equal(hullStrip(assets, id, 'sw'), sw, 'strips are cached per view');
    }
});

test('a two-view strip reads each view from its own five frames', () => {
    const image = { width: 31 * 10, height: 47 };
    const assets = {
        get: () => image,
        getEntry: () => ({ frames: 10, directions: ['sw', 'nw'], anchors: { nw: [14, 45] }, masthead: [15, 1], mastheads: { nw: [16, 2] } }),
        getAnchor: () => [15, 45],
    };
    const nw = hullStrip(assets, 'two-view', 'nw');
    assert.equal(nw.frameOffset, HULL_ROLL_FRAMES);
    assert.equal(nw.anchorX, 14);
    assert.deepEqual(nw.mastheads[2], [16, 2]);
    assert.equal(hullGeometry({ strip: nw, frame: 2, x: 0, y: 0 }).sx, 7 * 31);
    const ne = hullStrip(assets, 'two-view', 'ne');
    assert.equal(ne.mirrored, true);
    assert.equal(ne.anchorX, 31 - 1 - 14);
    assert.equal(hullStrip(assets, 'two-view', 'sw').frameOffset, 0);
});
