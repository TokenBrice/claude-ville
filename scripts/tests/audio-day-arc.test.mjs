import test from 'node:test';
import assert from 'node:assert/strict';

import { GRADE_KEYFRAMES } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { arrangementKeyframeAt } from '../../claudeville/src/presentation/shared/audio/DayArc.js';

test('the arrangement key is the grade keyframe the day last passed, from its minute on', () => {
    // Spring has no sunrise/sunset shift: its keys sit on the authored minutes.
    for (const key of GRADE_KEYFRAMES) {
        assert.equal(arrangementKeyframeAt({ minuteOfDay: key.minute, season: 'spring' }), key.name);
    }
});

test('the keys follow the season\'s sunrise shift, like the picture', () => {
    const early = 5 * 60 + 30;
    assert.equal(arrangementKeyframeAt({ minuteOfDay: early, season: 'summer' }), 'sunrise');
    assert.equal(arrangementKeyframeAt({ minuteOfDay: early, season: 'winter' }), 'pre-dawn');
});
