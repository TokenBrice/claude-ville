import test from 'node:test';
import assert from 'node:assert/strict';
import { GRADE_CONSTANTS, GRADE_GLSL } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { GRADE_WGSL } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/grade.js';
import { buildPoolDodgeStamp } from '../../claudeville/src/presentation/character-mode/CanvasGrade.js';
import { VILLAGE_NIGHT_LAMPS, AMBIENT_SCENIC_POINTS } from '../../claudeville/src/config/scenery.js';
import { APPROACH_FILES, REST_SEATS, COMMAND_QUEUE } from '../../claudeville/src/config/townPlan.js';
import { BUILDING_DEFS, VISIT_OVERFLOW_TILES } from '../../claudeville/src/config/buildings.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';

test('fourteen low lamp feet keep every standing place and approach file clear', () => {
    assert.equal(VILLAGE_NIGHT_LAMPS.length, 14);
    const places = [...REST_SEATS, ...COMMAND_QUEUE.slots, ...COMMAND_QUEUE.overflow,
        ...AMBIENT_SCENIC_POINTS, ...Object.values(APPROACH_FILES).flat(),
        ...Object.values(VISIT_OVERFLOW_TILES).flat(),
        ...BUILDING_DEFS.flatMap(def => [def.entrance, ...def.visitTiles])];
    for (const lamp of VILLAGE_NIGHT_LAMPS) {
        assert.equal(lamp.id, 'prop.lantern');
        assert.equal(lamp.layer, 'cache');
        assert.equal(lamp.walkBlock, true);
        assert.ok(Number.isInteger(lamp.tileX) && Number.isInteger(lamp.tileY));
        for (const place of places) {
            const dx = ((place.tileX - place.tileY) - (lamp.tileX - lamp.tileY)) * 32;
            const dy = ((place.tileX + place.tileY) - (lamp.tileX + lamp.tileY)) * 16;
            assert.ok(!(Math.abs(dx) < 21 && dy > -8 && dy < 44),
                `${lamp.tileX},${lamp.tileY} covers place ${place.tileX},${place.tileY}`);
        }
    }
});

test('street fixture pools use only the lamps clock gate, not weather or occupants', () => {
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer._lanternGlowSources = () => [{ x: 100, y: 90, tileX: 6, tileY: 22, fixture: 'lantern' }];
    renderer._hearthLightSources = () => [];
    renderer._lastAtmosphere = { clock: { minuteOfDay: 12 * 60 } };
    assert.equal(renderer.villageLampsLit(), false);
    assert.deepEqual(renderer._lanternGroundLightSources({ beaconIntensity: 1 }), []);
    renderer._lastAtmosphere = { clock: { minuteOfDay: 23 * 60 } };
    assert.equal(renderer.villageLampsLit(), true);
    const [light] = renderer._lanternGroundLightSources({ beaconIntensity: 0 });
    assert.equal(light.role, 'fixture');
    assert.equal(light.fire, false);
    assert.deepEqual(light.ground, { x: 100, y: 100 });
    assert.equal(light.height, 24);
    assert.equal(light.ownerId, null);
});

const stops = GRADE_CONSTANTS.AMBIENT_POOL_STOPS.value;
const weights = GRADE_CONSTANTS.AMBIENT_POOL_WEIGHTS.value;
const chroma = GRADE_CONSTANTS.AMBIENT_POOL_CHROMA.value;
const weightAt = (q, thresholds, values) => {
    const course = thresholds.filter(stop => q >= stop).length;
    return course ? values[course - 1] : 0;
};

test('ambient pools have six rising held courses with a faint low-chroma rim', () => {
    assert.equal(stops.length, 6);
    for (let i = 1; i < 6; i++) {
        assert.ok(stops[i] > stops[i - 1]);
        assert.ok(weights[i] > weights[i - 1]);
        assert.ok(chroma[i] > chroma[i - 1]);
    }
    assert.ok(weights[0] < 0.05);
    assert.ok(chroma[0] < 0.25);
    assert.equal(weights[5], 0.76);
});

test('ordered-dither six-course pools spend less integrated energy than old discs', () => {
    let oldEnergy = 0;
    let newEnergy = 0;
    for (let radius = 0; radius < 1000; radius++) {
        const r = (radius + 0.5) / 1000;
        const falloff = 1 - r * r * (3 - 2 * r);
        for (let order = 0; order < 16; order++) {
            const q = falloff + (order / 16 - 0.5) * 0.08;
            oldEnergy += r * weightAt(q, [0.12, 0.40, 0.75], [0.30, 0.54, 0.76]);
            newEnergy += r * weightAt(q, stops, weights);
        }
    }
    assert.ok(newEnergy < oldEnergy * 0.8, `${newEnergy} vs ${oldEnergy}`);
});

test('GLSL and WGSL use identical shared ambient tables and retain attention helpers', () => {
    for (const source of [GRADE_GLSL, GRADE_WGSL]) {
        for (const name of ['AMBIENT_POOL_STOPS', 'AMBIENT_POOL_WEIGHTS', 'AMBIENT_POOL_CHROMA', 'AMBIENT_POOL_SHARE']) {
            const { value, digits } = GRADE_CONSTANTS[name];
            assert.ok(source.includes(value.map(v => v.toFixed(digits)).join(', ')), name);
        }
        assert.match(source, /ambientPoolTint\(ambient, ambientSteps/);
        assert.match(source, /poolTint\(attention, attentionSteps/);
        assert.match(source, /step\(0\.12, q\) \+ step\(0\.40, q\) \+ step\(0\.75, q\)/);
    }
});

test('Canvas stamps resolve six ambient courses, preserve attention and receiver ceiling', () => {
    const original = globalThis.document;
    globalThis.document = { createElement: () => {
        const canvas = { width: 0, height: 0 };
        canvas.getContext = () => ({
            createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
            putImageData: image => { canvas.image = image; },
        });
        return canvas;
    } };
    try {
        const options = { radius: 96, energy: 0.8, ambientTint: [0.3, 0.3, 0.3], poolGain: 1, receiver: [0.4, 0.4, 0.4] };
        const ambient = buildPoolDodgeStamp(options);
        const attention = buildPoolDodgeStamp({ ...options, attention: true });
        const colours = stamp => {
            const set = new Set();
            const data = stamp.image.data;
            for (let y = 0; y < stamp._poolRows; y++) {
                for (let x = 0; x < stamp._poolCells; x++) {
                    const offset = (y * stamp.width + x) * 4;
                    if (!data[offset + 3]) continue;
                    set.add(Array.from(data.slice(offset, offset + 3)).join(','));
                    let luma = 0;
                    for (let c = 0; c < 3; c++) {
                        const multiply = data[offset + stamp._poolCells * 4 + c] / 255;
                        const dodge = data[offset + c] / 255;
                        luma += [0.2126, 0.7152, 0.0722][c] * 0.4 * multiply / (1 - dodge);
                    }
                    assert.ok(luma <= GRADE_CONSTANTS.RECEIVER_LUMA_CEILING.value + 0.008, luma);
                }
            }
            return set;
        };
        assert.equal(colours(ambient).size, 6);
        assert.equal(colours(attention).size, 3);
    } finally {
        globalThis.document = original;
    }
});
