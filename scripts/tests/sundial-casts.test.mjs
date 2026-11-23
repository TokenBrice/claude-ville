import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SHADE_ALPHA,
    SHADE_LENGTH_CAP,
    SHADE_LENGTH_MIN,
    SHADE_SUN_RISEN_DEG,
    castLightingFor,
    frameShadeLayer,
    setFrameCastLighting,
    stampCastFor,
    villagerCastLighting,
    villagerCastStamps,
} from '../../claudeville/src/presentation/character-mode/RakingLight.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';

// One atmosphere snapshot: the three objects the cast reads.
function atmosphere({ rake = 0, sunBand = 1, daylight = 1, night = 0, angle = 0.28, shadowAlpha = 0.28, shadowLength = 1, elevation = 30 } = {}) {
    return {
        lightGrade: { rake, sunBand, daylight, night },
        lighting: { shadowAngleRad: angle, shadowAlpha, shadowLength },
        solar: { elevationDeg: elevation },
    };
}

// The shade's alpha: its one density, times the sun's share and the strength, in 1/32.
const alphaAt = (share = 1, strength = 1) => Math.round(SHADE_ALPHA * share * strength * 32) / 32;

// The cast as it was computed before SD-1 (RakingLight 1.5), field for field.
function castBefore({ lightGrade: grade, lighting }) {
    const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
    const rake = Math.round(Math.pow(clamp(grade.rake) * clamp(grade.daylight / 0.5), 1.5) * 8) / 8;
    const night = grade.night >= 0.5;
    const angle = Math.round(lighting.shadowAngleRad * 16) / 16;
    const length = Math.round((night ? clamp(lighting.shadowLength, 0.45, 2.4) : 0.72 + 1.6 * rake) * 8) / 8;
    const sun = grade.sunBand >= 0.5;
    return {
        rake,
        angle,
        length,
        sun,
        alpha: Math.min(0.74, lighting.shadowAlpha + 0.44 * rake),
        color: [24, 38, 66].map((channel, index) => Math.round(channel + ([42, 35, 70][index] - channel) * rake)),
        key: `${rake}|${angle}|${length}|${sun ? 's' : 'o'}`,
    };
}

const SNAPSHOTS = [
    atmosphere(),
    atmosphere({ rake: 0.19, angle: -0.19, elevation: 17 }),
    atmosphere({ rake: 1, daylight: 0.9, angle: 0.72, shadowAlpha: 0.42, elevation: 5 }),
    atmosphere({ rake: 0.875, sunBand: 0.8, daylight: 0.55, night: 0.1, angle: -0.7, elevation: 3 }),
    atmosphere({ rake: 0.375, sunBand: 0.2, daylight: 0.1, night: 0.5, angle: 0.8, shadowLength: 1.9, elevation: -4 }),
    atmosphere({ rake: 0, sunBand: 0, daylight: 0, night: 1, angle: 0.4, shadowAlpha: 0.2, shadowLength: 2.3, elevation: -40 }),
    atmosphere({ rake: 0.1, sunBand: 0.1, elevation: 22 }),
];

test('at sd1 0 the cast is the cast it was, and nothing is twinned', () => {
    try {
        setLookStrength('sd1', 0);
        for (const snapshot of SNAPSHOTS) {
            const cast = castLightingFor(snapshot);
            const { shade, contact, ...fields } = cast;
            assert.deepEqual(fields, castBefore(snapshot));
            assert.equal(shade, null);
            assert.equal(contact, null);
            assert.equal(stampCastFor(cast), cast);
            assert.equal(villagerCastLighting(10, 20, cast), cast);
            assert.equal(castLightingFor(snapshot), cast, 'memoized on the snapshot');
        }
        // The frame setter still takes the cast alone, and resolves no shade layer.
        const cast = castLightingFor(SNAPSHOTS[2]);
        setFrameCastLighting(cast);
        assert.equal(villagerCastLighting(0, 0), cast);
        assert.equal(frameShadeLayer(), null);
        setFrameCastLighting(cast, { marker: 'renderer' });
        assert.equal(frameShadeLayer(), null, 'no field is asked for while the look is off');
    } finally {
        setFrameCastLighting(null);
        resetLookStrengths();
    }
});

test('at sd1 0 a villager trail is the raking trail it was', () => {
    try {
        setLookStrength('sd1', 0);
        assert.deepEqual(villagerCastStamps(20, castLightingFor(SNAPSHOTS[0])), [], 'none below golden light');
        const cast = castLightingFor(SNAPSHOTS[2]);
        const stamps = villagerCastStamps(20, cast);
        const reach = Math.max(24, 20 * 2.1) * 1.2 * cast.rake;
        assert.equal(stamps.length, Math.max(2, Math.round(reach / 6)));
        const tip = stamps[stamps.length - 1];
        assert.ok(Math.abs(tip.x - Math.cos(cast.angle) * reach) < 1e-9);
        assert.ok(Math.abs(tip.y - Math.sin(cast.angle) * 0.55 * reach) < 1e-9);
        assert.equal(stamps[0].alpha, Math.round((0.25 + 0.3 * cast.rake + (0.3 - 0.25 - 0.3 * cast.rake) / stamps.length) * 8) / 8);
    } finally {
        resetLookStrengths();
    }
});

test('sd1 scales the shade\'s density; the stamps fall back to contact', () => {
    resetLookStrengths();
    setLookStrength('sd1', 1);
    const noon = castLightingFor(SNAPSHOTS[0]);
    const { shade, contact, ...fields } = noon;
    assert.deepEqual(fields, castBefore(SNAPSHOTS[0]), 'the cast\'s own fields never move');
    assert.equal(shade.alpha, alphaAt(), 'midday, in 1/32');
    assert.deepEqual(shade.color, noon.color);
    assert.equal(Object.isFrozen(shade) && Object.isFrozen(contact), true);
    // The contact twin: the same angle and colour, no rake, no sun, the contact alpha alone.
    assert.deepEqual(
        { rake: contact.rake, sun: contact.sun, angle: contact.angle, alpha: contact.alpha, color: contact.color, contactOnly: contact.contactOnly },
        { rake: 0, sun: false, angle: noon.angle, alpha: 0.28, color: noon.color, contactOnly: true },
    );
    assert.notEqual(contact.key, noon.key);
    assert.equal(stampCastFor(noon), contact);
    const golden = castLightingFor(SNAPSHOTS[2]);
    assert.equal(golden.shade.alpha, shade.alpha, 'a raking sun is a weaker light: its shade gains no weight');
    assert.equal(golden.contact.alpha, 0.42, 'the twin drops the rake\'s gain');
    assert.equal(golden.contact.rake, 0);
    assert.notEqual(golden.contact.key, noon.contact.key, 'the twin\'s colour follows the rake');
    setLookStrength('sd1', 0.5);
    assert.equal(castLightingFor(SNAPSHOTS[0]).shade.alpha, alphaAt(1, 0.5));
    assert.equal(castLightingFor(SNAPSHOTS[2]).shade.alpha, alphaAt(1, 0.5));
    setLookStrength('sd1', 0.02);
    assert.equal(castLightingFor(SNAPSHOTS[0]).shade, null, 'under 1/64 of density there is no layer to draw');
    assert.equal(castLightingFor(SNAPSHOTS[0]).contact.contactOnly, true, 'but the sun trails are already retired');
    assert.notEqual(castLightingFor(SNAPSHOTS[0]), noon, 'an override lands on the next read');
    resetLookStrengths();
});

test('the shade follows the sun band out and never appears at night', () => {
    resetLookStrengths();
    setLookStrength('sd1', 1);
    assert.equal(castLightingFor(atmosphere({ rake: 0.875, sunBand: 0.8, daylight: 0.55, elevation: 12 })).shade.alpha, alphaAt(), 'a sun band of 0.8 is a whole sun');
    const dusk = castLightingFor(SNAPSHOTS[4]);
    assert.equal(dusk.shade, null, 'gone at a sun band of 0.2');
    // A veiled low sun: the old cast still rakes, the shade is out.
    const veiled = castLightingFor(atmosphere({ rake: 0.6, sunBand: 0.15, daylight: 0.5, angle: 0.7, elevation: 8 }));
    assert.ok(veiled.rake > 0 && veiled.shade === null);
    assert.equal(stampCastFor(veiled).contactOnly, true, 'and no raking stamp stands in for it');
    assert.deepEqual(villagerCastStamps(20, villagerCastLighting(0, 0, veiled)), []);
    const night = castLightingFor(SNAPSHOTS[5]);
    assert.equal(night.shade, null);
    assert.equal(night.contact, null, 'a night cast is its own contact');
    assert.equal(stampCastFor(night), night);
    assert.equal(villagerCastLighting(0, 0, night), night);
    const overcast = castLightingFor(SNAPSHOTS[6]);
    assert.equal(overcast.shade, null);
    assert.equal(overcast.contact, null);
    const hazy = castLightingFor(atmosphere({ sunBand: 0.5 }));
    assert.equal(hazy.shade.alpha, alphaAt(0.5), 'half the band between 0.2 and 0.8: half the shade');
    resetLookStrengths();
});

test('the shade sets with the sun: none at or under the horizon, whatever the grade still holds', () => {
    resetLookStrengths();
    setLookStrength('sd1', 1);
    setLookStrength('sd2', 1);
    // Dawn and dusk: the grade's sun band and rake outlast the sun (the lamps
    // may already be lit), and the old cast would still rake.
    for (const elevation of [-40, -4.9, -3.3, -1.1, 0]) {
        const cast = castLightingFor(atmosphere({ rake: 1, sunBand: 1, daylight: 0.9, angle: 0.72, elevation }));
        assert.ok(cast.rake > 0 && cast.sun, 'the grade still holds a sun');
        assert.equal(cast.shade, null, `no shade at ${elevation} degrees: no layer, no receivers`);
        assert.equal(stampCastFor(cast).contactOnly, true, 'no sun stamp stands in for it');
        assert.equal(villagerCastLighting(0, 0, cast), cast.contact);
        assert.deepEqual(villagerCastStamps(20, villagerCastLighting(0, 0, cast)), [], 'and no villager trail');
    }
    // It comes in with the sun over its first SHADE_SUN_RISEN_DEG degrees, in eighths.
    assert.equal(SHADE_SUN_RISEN_DEG, 4);
    const at = elevation => castLightingFor(atmosphere({ rake: 1, daylight: 0.9, elevation })).shade;
    assert.equal(at(0.2), null, 'under a sixteenth of the way: still none');
    assert.equal(at(1).alpha, alphaAt(0.25));
    assert.equal(at(2).alpha, alphaAt(0.5));
    assert.equal(at(3).alpha, alphaAt(0.75));
    for (const elevation of [4, 5.2, 12, 23, 64]) assert.equal(at(elevation).alpha, alphaAt(), `whole at ${elevation} degrees`);
    // The receivers' step follows the same share, and the two shares multiply.
    assert.ok(at(1).receivers.cast > at(2).receivers.cast && at(2).receivers.cast > at(4).receivers.cast);
    assert.equal(at(4).receivers.cast, at(64).receivers.cast);
    assert.equal(castLightingFor(atmosphere({ sunBand: 0.5, elevation: 2 })).shade.alpha, alphaAt(0.25));
    // With no solar record the shade is the grade's alone, as before.
    assert.equal(castLightingFor({ lightGrade: { rake: 0, sunBand: 1, daylight: 1, night: 0 }, lighting: { shadowAngleRad: 0.28, shadowAlpha: 0.28 } }).shade.alpha, alphaAt());
    resetLookStrengths();
});

test('MINIMAL sheds the shade and keeps the sun stamps (EFFECT_BUDGET sundial-shade)', () => {
    resetLookStrengths();
    setLookStrength('sd1', 1);
    const snapshot = SNAPSHOTS[2];
    const renderer = { gpuWorld: { _compositeQualityLevel: 1 }, _lastAtmosphere: snapshot };
    setFrameCastLighting(castLightingFor(snapshot), renderer);
    assert.ok(castLightingFor(snapshot).shade, 'REDUCED keeps it');
    renderer.gpuWorld._compositeQualityLevel = 2;
    setFrameCastLighting(castLightingFor(snapshot), renderer);
    const shed = castLightingFor(snapshot);
    const { shade, contact, ...fields } = shed;
    assert.deepEqual([shade, contact], [null, null]);
    assert.deepEqual(fields, castBefore(snapshot));
    assert.equal(villagerCastLighting(0, 0), shed, 'the frame\'s cast is the shed one from the same frame');
    assert.equal(frameShadeLayer(), null);
    renderer.gpuWorld._compositeQualityLevel = 0;
    setFrameCastLighting(castLightingFor(snapshot), renderer);
    assert.ok(castLightingFor(snapshot).shade, 'and it returns with the level');
    setFrameCastLighting(null);
    resetLookStrengths();
});

test('length is the real sun\'s, eased into the sd1len cap; direction keeps the authored fan', () => {
    resetLookStrengths();
    setLookStrength('sd1', 1);
    const lengthAt = elevation => castLightingFor(atmosphere({ elevation })).shade.length;
    const real = elevation => (2 / Math.sqrt(3)) / Math.tan(elevation * Math.PI / 180);
    for (const [look, cap] of [[0, SHADE_LENGTH_CAP[0]], [0.5, (SHADE_LENGTH_CAP[0] + SHADE_LENGTH_CAP[1]) / 2], [1, SHADE_LENGTH_CAP[1]]]) {
        setLookStrength('sd1len', look);
        let previous = Infinity;
        for (const elevation of [0.5, 2, 5, 10, 17, 23, 35, 50, 64, 80]) {
            const length = lengthAt(elevation);
            assert.ok(length <= cap + 1e-9, `sd1len ${look}: ${length} within the cap ${cap}`);
            assert.ok(length <= previous, 'a higher sun never throws a longer shade');
            assert.equal(length * 32, Math.round(length * 32), 'bucketed in 1/32');
            previous = length;
        }
        assert.ok(lengthAt(1) > cap * 0.97, 'a sun on the horizon throws the cap');
        const minBucket = Math.round(Math.min(cap, SHADE_LENGTH_MIN) * 32) / 32;
        assert.equal(lengthAt(64), minBucket, 'summer noon respects minimum readable shadow length');
    }
    setLookStrength('sd1len', 1);
    assert.ok(Math.abs(lengthAt(45) - real(45)) < 0.04);
    assert.ok(lengthAt(23) > 2.4 && lengthAt(23) < real(23), 'a winter noon is eased, not clipped');
    // Direction: the lighting model's angle in 1/64 rad; the sweep is ground px, y halved.
    const cast = castLightingFor(atmosphere({ angle: 0.5, elevation: 45 }));
    assert.equal(cast.shade.angle, Math.round(0.5 * 64) / 64);
    assert.ok(Math.abs(cast.shade.sx - Math.cos(cast.shade.angle) * cast.shade.length) < 1e-12);
    assert.ok(Math.abs(cast.shade.sy - Math.sin(cast.shade.angle) * cast.shade.length / 2) < 1e-12);
    assert.equal(cast.shade.key, castLightingFor(atmosphere({ angle: 0.502, elevation: 45.2 })).shade.key, 'a key holds across its bucket');
    assert.notEqual(cast.shade.key, castLightingFor(atmosphere({ angle: 0.53, elevation: 45 })).shade.key);
    assert.notEqual(cast.shade.key, castLightingFor(atmosphere({ angle: 0.5, elevation: 30 })).shade.key);
    resetLookStrengths();
});

test('a villager in the sun throws a trail of the shade\'s own length and density', () => {
    resetLookStrengths();
    setLookStrength('sd1', 1);
    setLookStrength('sd1len', 1);
    const cast = castLightingFor(atmosphere({ rake: 1, daylight: 0.9, angle: 0.72, elevation: 20 }));
    const twin = villagerCastLighting(40, 40, cast);
    assert.notEqual(twin, cast.contact);
    assert.equal(twin.trail, cast.shade);
    assert.equal(twin.rake, cast.rake, 'a raking sun still outranks the lamp casts');
    assert.ok(twin.key.includes(cast.shade.key) && twin.key !== cast.contact.key);
    assert.equal(villagerCastLighting(90, 12, cast), twin, 'one twin per cast');
    const width = 20;
    const stamps = villagerCastStamps(width, twin);
    const height = Math.max(24, width * 2.1);
    const tip = stamps[stamps.length - 1];
    assert.ok(Math.abs(tip.x - height * cast.shade.sx) < 1e-9);
    assert.ok(Math.abs(tip.y - height * cast.shade.sy) < 1e-9);
    const body = stamps.slice(0, Math.floor(stamps.length * 0.75));
    assert.ok(body.every(stamp => stamp.alpha === cast.shade.alpha), 'one flat course at the shade\'s density');
    assert.ok(Math.abs(tip.alpha - cast.shade.alpha / 3) < 1e-12 && tip.rx < stamps[0].rx, 'thinning to the head');
    for (let i = 1; i < stamps.length; i++) assert.ok(Math.hypot(stamps[i].x - stamps[i - 1].x, stamps[i].y - stamps[i - 1].y) <= 6);
    // Midday: no rake, and still a short shadow, as long as the sun stands high.
    const noon = castLightingFor(atmosphere({ elevation: 60 }));
    const short = villagerCastStamps(width, villagerCastLighting(0, 0, noon));
    assert.ok(short.length >= 2);
    assert.ok(Math.abs(short[short.length - 1].x - height * noon.shade.sx) < 1e-9);
    resetLookStrengths();
});
