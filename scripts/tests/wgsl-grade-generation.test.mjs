// Wave 10 (WebGPU contract §1.1 / §5.7): GRADE_GLSL and its WebGPU twin
// GRADE_WGSL are generated from one constants table, so the two dialects
// carry the same numbers and a change to a JS constant reaches both.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GRADE_CONSTANTS, GRADE_GLSL, gradeGlsl } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { GRADE_WGSL, gradeWgsl } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/grade.js';

// Every float literal a shader carries (comments stripped), as a sorted list.
function literals(source) {
  const code = source.replace(/\/\/[^\n]*/g, '');
  return (code.match(/(?<![\w.])\d+\.\d+(?:e[-+]?\d+)?|(?<![\w.])\d+e[-+]?\d+/g) || []).sort();
}

function withConstant(name, value) {
  return { ...GRADE_CONSTANTS, [name]: { ...GRADE_CONSTANTS[name], value } };
}

function count(list, literal) {
  return list.filter(item => item === literal).length;
}

test('the GLSL and WGSL grades carry exactly the same numbers', () => {
  assert.deepEqual(literals(GRADE_WGSL), literals(GRADE_GLSL));
  assert.equal(GRADE_GLSL, gradeGlsl(GRADE_CONSTANTS));
  assert.equal(GRADE_WGSL, gradeWgsl(GRADE_CONSTANTS));
});

test('changing a grade constant in JS changes both dialects identically', () => {
  const cases = [
    ['RECEIVER_OKL_CEILING', 0.901, '0.901'],
    ['WATER_MAX_SATURATION', 0.377, '0.377'],
    ['POOL_RIM', [1.5, 0.925, 0.41], '0.925'],
    ['LAND_SHARE', [0.81, 0.86, 0.93], '0.93'],
    ['RECEIVER_HEADROOM', 0.021, '0.021'],
  ];
  for (const [name, value, marker] of cases) {
    const constants = withConstant(name, value);
    const glsl = literals(gradeGlsl(constants));
    const wgsl = literals(gradeWgsl(constants));
    assert.deepEqual(wgsl, glsl, `${name}: the dialects diverged`);
    assert.notDeepEqual(glsl, literals(GRADE_GLSL), `${name}: GLSL did not move`);
    assert.notDeepEqual(wgsl, literals(GRADE_WGSL), `${name}: WGSL did not move`);
    assert.ok(count(wgsl, marker) > count(literals(GRADE_WGSL), marker), `${name}: the new value is not in WGSL`);
  }
});
