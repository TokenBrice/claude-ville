import test from 'node:test';
import assert from 'node:assert/strict';

import {
    clearMomentStage,
    createCueGate,
    cueGatedAge,
    queueMomentEdgePlate,
    resolveMomentAnchor,
    setMomentStage,
} from '../../claudeville/src/presentation/character-mode/EffectStamps.js';
import { cueNoteDue, expectCueScore, publishCueScore, resetCueScore } from '../../claudeville/src/presentation/shared/audio/CueScore.js';

// Camera at zoom 2 with world (0, 0) at screen (0, 0); a 1000 × 600 CSS-px view.
const camera = {
    zoom: 2,
    worldToScreen: (x, y) => ({ x: x * 2, y: y * 2 }),
};
const viewport = { width: 1000, height: 600 };

// One building sprite: a 100 × 100 fully opaque block at world (200..300,
// 100..200), sorted at y = 200, of type `tower`.
function buildings({ sortY = 200 } = {}) {
    const w = 100;
    const h = 100;
    const mask = new Uint8Array(w * h).fill(1);
    const drawables = [{ kind: 'building', building: { type: 'tower' }, entry: { id: 'building.tower' }, wx: 250, wy: 200, sortY }];
    return {
        enumerateDrawables: () => drawables,
        assets: {
            getDims: () => ({ w, h }),
            getMask: () => mask,
            getAnchor: () => [50, 100],
        },
    };
}

const EXTENT = { left: -10, top: -20, right: 10, bottom: 4 };

test('a clear point stands in place; no stage means in place', () => {
    clearMomentStage();
    assert.equal(resolveMomentAnchor({ x: 100, y: 100 }, { extent: EXTENT }).mode, 'place');
    setMomentStage({ camera, viewport, reserved: [], buildings: buildings() });
    const anchor = resolveMomentAnchor({ x: 100, y: 100 }, { extent: EXTENT });
    assert.equal(anchor.mode, 'place');
    assert.equal(anchor.y, 100);
    clearMomentStage();
});

test('a moment behind a front-sorted building rises up its column above the roof', () => {
    setMomentStage({ camera, viewport, reserved: [], buildings: buildings() });
    // Feet at y = 150 behind the block (the block sorts at 200 > 150).
    const anchor = resolveMomentAnchor({ x: 250, y: 150 }, { extent: EXTENT, actorId: 'a' });
    assert.equal(anchor.mode, 'column');
    assert.ok(anchor.rect.bottom <= 100, `rect bottom ${anchor.rect.bottom} clears the roof`);
    // The same point in front of the block (depth past its sort) is clear.
    assert.equal(resolveMomentAnchor({ x: 250, y: 150 }, { extent: EXTENT, depthY: 260 }).mode, 'place');
    clearMomentStage();
});

test('chrome over the point pushes it along the building column, never under the chrome', () => {
    // A 1000 × 60 CSS-px bar across the top (world rows 0..30).
    const bar = { name: 'top-bar', left: 0, top: 0, right: 1000, bottom: 60 };
    setMomentStage({ camera, viewport, reserved: [bar], buildings: buildings({ sortY: 0 }) });
    const anchor = resolveMomentAnchor({ x: 250, y: 20 }, { extent: EXTENT, building: 'tower' });
    assert.equal(anchor.mode, 'column');
    assert.ok(anchor.screen.top >= 60, `screen top ${anchor.screen.top} is below the bar`);
    clearMomentStage();
});

test('a moment beyond a side edge becomes an edge plate on that side, inside the safe area', () => {
    setMomentStage({ camera, viewport, reserved: [], buildings: buildings() });
    const anchor = resolveMomentAnchor({ x: -80, y: 150 }, { extent: EXTENT, id: 'm', phase: 'peak' });
    assert.equal(anchor.mode, 'edge');
    assert.equal(anchor.side, 'left');
    const plate = queueMomentEdgePlate(anchor, { word: 'RELEASE', peak: true });
    assert.ok(plate.rect.left >= 8 && plate.rect.top >= 8 && plate.rect.bottom <= viewport.height - 8);
    clearMomentStage();
});

test('the peak waits for its note and lands on the frame the note is due', async () => {
    resetCueScore();
    const gate = createCueGate('arrival', 'agent-1');
    const peakAt = 200;
    // No score: the moment keeps its own clock.
    assert.equal(cueGatedAge(createCueGate('arrival', 'nobody'), 250, peakAt), 250);
    publishCueScore({ kind: 'arrival', agentId: 'agent-1', startMs: performance.now() + 60, offsetsMs: [0, 220] });
    assert.equal(cueGatedAge(gate, 250, peakAt), peakAt - 1, 'held on the last anticipation frame');
    await new Promise(resolve => setTimeout(resolve, 90));
    const age = cueGatedAge(gate, 340, peakAt);
    assert.ok(gate.peakOpen && age >= peakAt, `peak opens once the note is due (age ${age})`);
    // Held time never replays: the clock resumes from the held frame.
    assert.equal(age, 340 - (250 - (peakAt - 1)));
    // Reduced motion never gates.
    assert.equal(cueGatedAge(createCueGate('arrival', 'agent-1'), 250, peakAt, null, { reduced: true }), 250);
    resetCueScore();
});

test('a sounding director holds a peak for a cue it expects; its score releases it', () => {
    resetCueScore();
    const now = performance.now();
    assert.equal(cueNoteDue('dispatch', 'parent', 0, now), true, 'silence: nothing expected, already due');
    expectCueScore('dispatch', 'parent', 2000, now);
    assert.equal(cueNoteDue('dispatch', 'parent', 0, now), false);
    assert.equal(cueNoteDue('dispatch', 'other', 0, now), true, 'another key is not held');
    assert.equal(cueNoteDue('dispatch', 'parent', 0, now + 2001), true, 'an expectation lapses on its own');
    publishCueScore({ kind: 'dispatch', agentId: 'parent', startMs: now, offsetsMs: [0] });
    assert.equal(cueNoteDue('dispatch', 'parent', 0, now), true, 'the published note is due');
    resetCueScore();
});
