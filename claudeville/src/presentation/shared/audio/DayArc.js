// The music's place in the day (plan 6.8, MUSL-8): the C2 grade keyframe
// (GradeEvaluator.GRADE_KEYFRAMES) the local clock last passed, with the same
// seasonal sunrise/sunset shifts as the picture. The Town band reads it once
// per tick; its arrangement changes at the keyframes and nowhere between
// them. Pure; importable from Node.

import { gradeKeysAt } from '../../character-mode/GradeEvaluator.js';
import { seasonShiftFor } from '../../character-mode/AtmosphereState.js';

/**
 * The music's arrangement key: the grade keyframe the day last passed,
 * season-shifted like the picture.
 */
export function arrangementKeyframeAt({ minuteOfDay = 12 * 60, season = 'summer' } = {}) {
    return gradeKeysAt(minuteOfDay, seasonShiftFor(season)).from.name;
}
