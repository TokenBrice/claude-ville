import test from 'node:test';
import assert from 'node:assert/strict';

import { shotScaleTiers, zoomTierLadder } from '../../claudeville/src/presentation/character-mode/Camera.js';
import { CameraDirector } from '../../claudeville/src/presentation/character-mode/CameraDirector.js';

// Viewports are the World canvas in CSS px: the window less the 240 px sidebar
// and the 48 px top bar.
const scalesFor = (canvasW, canvasH, dpr) => ({ ...shotScaleTiers(canvasW, canvasH, zoomTierLadder(dpr)) });

test('1920×1080 at DPR 1 has no survey: wide 1, medium 2, close 3', () => {
    assert.deepEqual(scalesFor(1680, 1032, 1), { survey: null, wide: 1, medium: 2, close: 3 });
});

test('5120×1440 at DPR 1 surveys 1:1 at z1 and rests the wide at z2, the medium at z3', () => {
    assert.deepEqual(scalesFor(4880, 1392, 1), { survey: 1, wide: 2, medium: 3, close: 3 });
});

test('2560×1440 at DPR 1 surveys at z1 and meets wide and medium at z2', () => {
    assert.deepEqual(scalesFor(2320, 1392, 1), { survey: 1, wide: 2, medium: 2, close: 3 });
});

test('1512×982 at DPR 2 keeps shots on logical tiers even where a half rung is nearer', () => {
    // Zoom 1.5 shows 0.53e6 world px², nearer the medium target than zoom 2
    // does, but the half rungs are operator rests, never shot scales.
    assert.deepEqual(scalesFor(1272, 934, 2), { survey: 0.5, wide: 1, medium: 2, close: 2 });
});

test('1800×1169 at DPR 2 surveys at 0.5: wide 1, medium 2, close 3', () => {
    assert.deepEqual(scalesFor(1560, 1121, 2), { survey: 0.5, wide: 1, medium: 2, close: 3 });
});

test('backing DPR 2 exposes every whole backing-pixel scale; DPR 1 keeps three tiers', () => {
    assert.deepEqual([...zoomTierLadder(2).steps], [0.5, 1, 1.5, 2, 2.5, 3]);
    assert.deepEqual([...zoomTierLadder(1).steps], [1, 2, 3]);
});

test('ordinary Auto rests no closer than the wide scale and never zooms past a wider rest', () => {
    const autoCap = (wide, tier) => CameraDirector.prototype._currentMaxZoom.call({
        camera: { shotTier: () => wide, currentZoomTier: () => tier },
    });
    assert.equal(autoCap(2, 3), 2);
    assert.equal(autoCap(2, 1), 1);
    assert.equal(autoCap(1, 2.5), 1);
});

test('an Ambient cohort shot frames only the members standing at its building', () => {
    const center = { x: -80, y: 536 }; // Command
    const sprite = (id, x, y, fold = null) => ({ agent: { id }, x, y, _foldBuildingType: fold });
    const sprites = [
        sprite('folded', -96, 624, 'command'),
        sprite('apron', -256, 576),
        sprite('chatting-at-portal', -798, 602, 'portal'),
        sprite('walking-far', -837, 643),
        sprite('not-a-member', -60, 560, 'command'),
    ];
    const cohort = { type: 'command', center, agentIds: ['folded', 'apron', 'chatting-at-portal', 'walking-far'] };
    const subject = CameraDirector.prototype._cohortSubject.call({}, cohort, sprites);
    assert.deepEqual(subject.ids, ['apron', 'folded']);
    assert.ok(subject.box.minX > -400, 'the Portal is not in the subject box');

    const nobodyThere = CameraDirector.prototype._cohortSubject.call({}, { ...cohort, agentIds: ['walking-far'] }, sprites);
    assert.deepEqual(nobodyThere.ids, []);
    assert.ok(nobodyThere.box.minX <= center.x && nobodyThere.box.maxX >= center.x, 'the building alone');
});
