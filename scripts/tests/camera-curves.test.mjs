import test from 'node:test';
import assert from 'node:assert/strict';

import { planGlide, sampleGlide } from '../../claudeville/src/presentation/character-mode/CameraCurves.js';

// 4.6 (M4) — glides are one continuous dolly: centre and log-zoom on one
// easing, no pan-then-step plateau, landing exactly on the target tier.
// Without fat flight frames (the Canvas world) the same dolly is planned
// stepped on the resting rungs.

function samples(plan, stepMs = 1000 / 60) {
    const out = [];
    for (let t = 0; t <= plan.total + stepMs; t += stepMs) out.push(sampleGlide(plan, t));
    return out;
}

test('a glide that pans and zooms moves both together on every flight frame', () => {
    for (const family of ['director', 'ambient']) {
        const plan = planGlide({ cx: 400, cy: 900, zoom: 3 }, { cx: 1100, cy: 640, zoom: 1 }, { family });
        const frames = samples(plan).filter((s) => !s.done);
        let plateaus = 0;
        for (let i = 2; i < frames.length - 1; i++) {
            const dz = frames[i].zoom - frames[i - 1].zoom;
            const dc = Math.hypot(frames[i].cx - frames[i - 1].cx, frames[i].cy - frames[i - 1].cy);
            assert.ok(dz <= 0, `${family}: the zoom never reverses (frame ${i})`);
            if (dz === 0 || dc === 0) plateaus++;
        }
        assert.equal(plateaus, 0, `${family}: no frame holds the zoom or the centre while the other moves`);
    }
});

test('every glide ends exactly on its target and reports done', () => {
    const to = { cx: 1310.25, cy: 402.5, zoom: 2 };
    const plan = planGlide({ cx: 900, cy: 700, zoom: 1 }, to);
    for (const elapsed of [plan.total, plan.total + 500]) {
        assert.deepEqual(sampleGlide(plan, elapsed), { cx: to.cx, cy: to.cy, zoom: to.zoom, done: true });
    }
    assert.equal(sampleGlide(plan, plan.total - 1).done, false);
});

test('the duration is clamp(600 + 0.55·screenPx + 350·|log2 z1/z0|, 700, 2400) on the dolly travel', () => {
    // A pure 3 → 1 zoom: no screen travel.
    const zoomOnly = planGlide({ cx: 500, cy: 500, zoom: 3 }, { cx: 500, cy: 500, zoom: 1 });
    assert.ok(Math.abs(zoomOnly.total - (600 + 350 * Math.log2(3))) < 1e-9);
    // A pure pan at z2: 500 world px is 1000 screen px.
    const panOnly = planGlide({ cx: 0, cy: 0, zoom: 2 }, { cx: 500, cy: 0, zoom: 2 });
    assert.ok(Math.abs(panOnly.total - (600 + 0.55 * 1000)) < 1e-9);
    // Short moves and long ones clamp; the ambient family is ×2.2 up to 5 s.
    assert.equal(planGlide({ cx: 0, cy: 0, zoom: 2 }, { cx: 20, cy: 0, zoom: 2 }).total, 700);
    assert.equal(planGlide({ cx: 0, cy: 0, zoom: 1 }, { cx: 5000, cy: 0, zoom: 2 }).total, 2400);
    assert.equal(planGlide({ cx: 0, cy: 0, zoom: 1 }, { cx: 5000, cy: 0, zoom: 2 }, { family: 'ambient' }).total, 5000);
    // The authored opening keeps its own length.
    assert.equal(planGlide({ cx: 0, cy: 0, zoom: 1 }, { cx: 800, cy: 200, zoom: 3 }, { duration: 2400 }).total, 2400);
});

test('a stepped (Canvas) glide rests on integer rungs for ≥ 75 % of its frames', () => {
    const rungs = [0.5, 1, 2, 3];
    const onRung = (zoom) => rungs.some((rung) => Math.abs(rung - zoom) < 1e-9);
    const cases = [
        [{ cx: 400, cy: 900, zoom: 3 }, { cx: 560, cy: 960, zoom: 1 }, {}],
        [{ cx: 500, cy: 500, zoom: 1 }, { cx: 500, cy: 500, zoom: 3 }, {}],
        [{ cx: 0, cy: 0, zoom: 0.5 }, { cx: 300, cy: 100, zoom: 2 }, { duration: 2400 }],
        [{ cx: 0, cy: 0, zoom: 1 }, { cx: 800, cy: 0, zoom: 2 }, { family: 'ambient' }],
    ];
    for (const [from, to, options] of cases) {
        const continuous = planGlide(from, to, options);
        const stepped = planGlide(from, to, { ...options, rungs });
        const label = `${from.zoom} → ${to.zoom}`;
        assert.equal(stepped.total, continuous.total, `${label}: same duration formula`);
        const frames = samples(stepped).filter((s) => !s.done);
        const fractional = frames.filter((s) => !onRung(s.zoom)).length;
        assert.ok(fractional / frames.length <= 0.27, `${label}: ${fractional}/${frames.length} frames between rungs`);
        let previous = from.zoom;
        frames.forEach((s, i) => {
            // The zoom never reverses or skips a rung.
            assert.ok(to.zoom > from.zoom ? s.zoom >= previous - 1e-12 : s.zoom <= previous + 1e-12, `${label}: monotonic ${i}`);
            previous = s.zoom;
        });
        const crossed = rungs.filter((rung) => rung > Math.min(from.zoom, to.zoom) && rung < Math.max(from.zoom, to.zoom));
        for (const rung of crossed) assert.ok(frames.some((s) => s.zoom === rung), `${label}: rests on ${rung}`);
        assert.deepEqual(sampleGlide(stepped, stepped.total), { cx: to.cx, cy: to.cy, zoom: to.zoom, done: true });
    }
    // A pan with no zoom change is the same move on either renderer.
    assert.equal(planGlide({ cx: 0, cy: 0, zoom: 2 }, { cx: 400, cy: 0, zoom: 2 }, { rungs }).steps, null);
});

// The screen offset of world point p along the move, (p − c)·D̂·z.
function screenAlong(sample, point, from, to) {
    const dx = to.cx - from.cx;
    const dy = to.cy - from.cy;
    const length = Math.hypot(dx, dy);
    return (((point.cx - sample.cx) * dx + (point.cy - sample.cy) * dy) / length) * sample.zoom;
}

test('a stepped (Canvas) glide never backs its framing up during a rung step', () => {
    const rungs = [0.5, 1, 2, 3];
    const cases = [
        [{ cx: 400, cy: 900, zoom: 3 }, { cx: 1100, cy: 640, zoom: 1 }, {}],
        [{ cx: 900, cy: 700, zoom: 1 }, { cx: 1310, cy: 402, zoom: 3 }, {}],
        [{ cx: 0, cy: 0, zoom: 0.5 }, { cx: 300, cy: 100, zoom: 2 }, { duration: 2400 }],
        [{ cx: 0, cy: 0, zoom: 1 }, { cx: 800, cy: 0, zoom: 2 }, { family: 'ambient' }],
        [{ cx: 0, cy: 0, zoom: 2 }, { cx: -600, cy: 300, zoom: 0.5 }, {}],
    ];
    for (const [from, to, options] of cases) {
        const label = `${from.zoom} → ${to.zoom}`;
        const stepped = samples(planGlide(from, to, { ...options, rungs }));
        const smooth = samples(planGlide(from, to, options));
        // Both frames' centres cross the screen one way, from start to landing.
        for (const anchor of [from, to]) {
            let previous = screenAlong(stepped[0], anchor, from, to);
            stepped.forEach((s, i) => {
                const along = screenAlong(s, anchor, from, to);
                assert.ok(along <= previous + 1e-9, `${label}: anchor (${anchor.cx}, ${anchor.cy}) backs up at frame ${i}`);
                previous = along;
            });
        }
        // The tighter frame's centre keeps the continuous dolly's screen path.
        const tight = to.zoom > from.zoom ? to : from;
        stepped.forEach((s, i) => {
            const drift = screenAlong(s, tight, from, to) - screenAlong(smooth[i], tight, from, to);
            assert.ok(Math.abs(drift) < 1e-6, `${label}: tight anchor off the dolly by ${drift} at frame ${i}`);
        });
    }
});
