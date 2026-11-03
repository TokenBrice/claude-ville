import test from 'node:test';
import assert from 'node:assert/strict';

import { GRADE_KEYFRAMES } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { arrangementKeyframeAt } from '../../claudeville/src/presentation/shared/audio/DayArc.js';

test('the arrangement key is the grade keyframe the day last passed, from its minute on', () => {
    // Without a shift the keys sit on the authored minutes.
    for (const key of GRADE_KEYFRAMES) {
        assert.equal(arrangementKeyframeAt({ minuteOfDay: key.minute }), key.name);
    }
});

test('the keys follow the day\'s sunrise shift, like the picture', () => {
    // LA-2: the shift is the real sun's (a June and a December sunrise).
    const early = 5 * 60 + 30;
    assert.equal(arrangementKeyframeAt({ minuteOfDay: early, shift: { sunriseShift: -40, sunsetShift: 55 } }), 'sunrise');
    assert.equal(arrangementKeyframeAt({ minuteOfDay: early, shift: { sunriseShift: 40, sunsetShift: -55 } }), 'pre-dawn');
});
