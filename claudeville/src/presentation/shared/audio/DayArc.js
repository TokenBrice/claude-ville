// The music's place in the day (plan 6.8, MUSL-8): the C2 grade keyframe
// (GradeEvaluator.GRADE_KEYFRAMES) the local clock last passed, with the same
// day shift as the picture (LA-2: the real sun's, `AtmosphereState.dayShiftFor`).
// The Town band reads it once per tick; its arrangement changes at the
// keyframes and nowhere between them. Pure; importable from Node.

import { gradeKeysAt } from '../../character-mode/GradeEvaluator.js';

/**
 * The music's arrangement key: the grade keyframe the day last passed,
 * shifted like the picture (`shift` is `{ sunriseShift, sunsetShift }`; the
 * authored day without one).
 */
export function arrangementKeyframeAt({ minuteOfDay = 12 * 60, shift = null } = {}) {
    return gradeKeysAt(minuteOfDay, shift || undefined).from.name;
}
