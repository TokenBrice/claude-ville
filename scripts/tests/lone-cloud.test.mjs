import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoneCloudPose, loneCloudPose, LONE_CLOUD_RADIUS } from '../../claudeville/src/presentation/character-mode/CloudShadowCourses.js';
import { createAmbientScheduler, ambientDebugSnapshot } from '../../claudeville/src/presentation/character-mode/AmbientEvents.js';
import { resolveAtmosphereCourses } from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import { POST_FX_LEVELS } from '../../claudeville/src/presentation/character-mode/postfx/PostFxLadder.js';

const FAIR = Object.freeze({ type: 'clear', nextType: 'clear', cloudCover: 0.1, windX: 0.35, transitionProgress: 0.4 });
const DAY = Object.freeze({ weather: FAIR, phase: 'day', season: 'autumn', motionScale: 1, level: 0, calm: false });
const scheduler = createAmbientScheduler();
const start = new Date(2026, 9, 9, 12).getTime();
let event;
let now;
for (let t = start; t < start + 3600000; t += 10000) {
    const candidate = scheduler.at(t, DAY).frequent;
    if (candidate?.kind === 'lone-cloud' && t >= candidate.startMs && t < candidate.endMs) {
        event = candidate;
        now = t;
        break;
    }
}
assert.ok(event, 'the pinned fair hour contains a lone-cloud event');

function frame(ctx = DAY, level = POST_FX_LEVELS.FULL, reducedMotion = false) {
    const active = scheduler.at(now, ctx).frequent;
    const pose = loneCloudPose(active, now, ctx.weather);
    return resolveAtmosphereCourses(level, { zoom: 1 }, {
        atmosphere: { weather: ctx.weather }, loneCloud: pose, motionScale: ctx.motionScale,
        reducedMotion, timeMs: now,
    }, { cloudShadow: ctx.phase === 'night' || ctx.weather.cloudCover >= 0.85 ? 0 : 1 });
}

test('lone pose is caller-owned, event-bounded and deterministic', () => {
    const out = createLoneCloudPose();
    assert.equal(out.active, false);
    assert.equal(loneCloudPose(event, now, FAIR, out), out);
    assert.equal(out.active, true);
    assert.deepEqual(out, loneCloudPose(event, now, FAIR));
    assert.equal(loneCloudPose(null, now, FAIR, out).active, false);
    assert.equal(loneCloudPose({ ...event, kind: 'gull-fishing-run' }, now, FAIR).active, false);
    assert.equal(loneCloudPose(event, event.startMs - 1, FAIR).active, false);
    assert.equal(loneCloudPose(event, event.endMs, FAIR).active, false);
    assert.equal(loneCloudPose({ ...event, endMs: event.startMs }, now, FAIR).active, false);
});

test('lone cloud forms and dissolves in three held radius courses', () => {
    const sizes = [0, 8000, 16000].map(dt => loneCloudPose(event, event.startMs + dt, FAIR).radius);
    assert.deepEqual(sizes, [0.55, 0.8, 1].map(scale => Math.round(LONE_CLOUD_RADIUS * scale)));
    assert.equal(loneCloudPose(event, event.endMs - 1, FAIR).radius, sizes[0]);
    assert.notDeepEqual(loneCloudPose(event, event.startMs + 16000, FAIR), loneCloudPose(event, event.startMs + 17000, FAIR));
});

test('clear daytime lone-cloud event reaches the two-course GPU branch deterministically', () => {
    const courses = frame();
    assert.equal(courses.courses, 2);
    assert.ok(courses.lone[2] > 0);
    assert.equal(courses.thresholds[2], 2);
    assert.deepEqual(frame(), courses);
    assert.equal(frame({ ...DAY, weather: { ...FAIR, cloudCover: 0.08 } }).courses, 2);
});

test('night, overcast, rain, squall and cloudless skies hold the lone branch', () => {
    for (const ctx of [
        { ...DAY, phase: 'night' },
        { ...DAY, weather: { ...FAIR, type: 'overcast', cloudCover: 0.9 } },
        { ...DAY, weather: { ...FAIR, type: 'rain', cloudCover: 0.95 } },
        { ...DAY, weather: { ...FAIR, nextType: 'storm', transitionProgress: 0.4 } },
        { ...DAY, weather: { ...FAIR, cloudCover: 0.079 } },
    ]) {
        const courses = frame(ctx);
        assert.equal(courses.lone[2], 0, JSON.stringify(ctx));
        assert.notEqual(courses.courses, 2);
    }
});

test('MINIMAL and both reduced-motion signals leave no lone shadow', () => {
    assert.equal(frame(DAY, POST_FX_LEVELS.MINIMAL).lone[2], 0);
    assert.equal(frame(DAY, POST_FX_LEVELS.FULL, true).lone[2], 0);
    assert.equal(frame({ ...DAY, motionScale: 0 }).lone[2], 0);
    assert.equal(frame(DAY, POST_FX_LEVELS.REDUCED).courses, 2);
});

test('lone diagnostics honor the renderer ladder and retain the daily knots under a live weather override', () => {
    const date = new Date(now);
    const host = {
        _lastAtmosphere: { weather: FAIR, phase: 'day', effectiveDate: date, clock: { date } },
        ambientEvents: scheduler.at(now, DAY),
        ambientLoneCloud: loneCloudPose(event, now, FAIR),
        camera: { zoom: 1 }, motionScale: 1, worldRendererMode: 'webgl',
        gpuWorld: { qualityLadder: { getLevel: () => POST_FX_LEVELS.FULL } },
    };
    const snapshot = ambientDebugSnapshot(host);
    assert.deepEqual(snapshot.actors['lone cloud'], { live: 1, cap: 1, reason: null });
    assert.ok(snapshot.weatherKnots.length > 0);
    assert.deepEqual(ambientDebugSnapshot({ ...host, world: { agents: new Map([['busy', { status: 'working' }]]) } }), snapshot);
    const minimal = ambientDebugSnapshot({ ...host, gpuWorld: { qualityLadder: { getLevel: () => POST_FX_LEVELS.MINIMAL } } });
    assert.deepEqual(minimal.actors['lone cloud'], { live: 0, cap: 0, reason: 'minimal' });
    assert.equal(ambientDebugSnapshot({ ...host, motionScale: 0 }).actors['lone cloud'].reason, 'reduced-motion');
    const knots = [{ minute: 0, type: 'clear' }, { minute: 600, type: 'rain' }];
    assert.deepEqual(ambientDebugSnapshot({ ...host, _lastAtmosphere: { ...host._lastAtmosphere, timeline: { knots } } }).weatherKnots, knots);
});
