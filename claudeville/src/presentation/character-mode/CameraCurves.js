// 8.1 — one motion vocabulary for the World camera. Pure functions, no DOM.
//
// Families:
//   wheel     — 150 ms easeOutCubic tier step (a responsive UI answer)
//   director  — cues, attention, re-frames, returns: easeInOutCubic
//   ambient   — the Ambient broadcast and the empty-village tour: easeInOutSine,
//               durations ×2.2 with a 5 s cap
//
// 4.6 (M4) — a glide is one continuous dolly. The SCREEN-CENTRE world point
// and the zoom move together on one eased parameter e (the family curve):
// the zoom in log space, z(e) = z0·(z1/z0)^e, and the centre along the
// straight line between the two frames by the zoom-weighted share
// w(e) = (1 − r^−e) / (1 − r^−1), r = z1/z0, which moves the picture across
// the screen at one rate for the whole move (dw/de ∝ 1/z(e)): a push-in
// covers its ground while it is still wide and closes on the subject, a
// pull-out opens before it travels. There is no pan-then-step split and no
// plateau: flight frames are fractional and render fat-pixel (4.6, C3
// "resting frames integer-k nearest; flight frames fat-pixel"), and every
// glide ends exactly on its target, a resting tier.
//
// Without the GL fat path (the Canvas world) a fractional k is a nearest
// crawl, so the same dolly is planned STEPPED (`rungs`): the zoom rests on the
// resting rung nearest (in log space) to the dolly's zoom and changes rung in
// one short easeInOutCubic step centred where the dolly crosses the log
// midpoint between two rungs. Each step takes a quarter of the glide shared
// among its rungs, held to 150–450 ms, so ≥ 75 % of the frames sit at an
// integer k (a short glide crossing many rungs spends a little more on 150 ms
// steps). The centre is derived from the zoom actually shown: the tighter
// frame's centre (the target of a push-in, the start of a pull-out) keeps the
// continuous dolly's screen path exactly, so it and the other frame's centre
// both travel one way, never backing up while a rung step scales the picture.

export const WHEEL_STEP_MS = 150;
export const FOLLOW_ENTRY_MS = 500;
// The longest rung step of a stepped glide (also the Canvas soft-follow
// tier step, which has no pan to share).
export const ZOOM_STEP_MS = 450;
// A stepped glide spends at most this share of its time between rungs.
const MAX_FRACTIONAL_SHARE = 0.25;

const DURATION_MIN_MS = 700;
const DURATION_MAX_MS = 2400;
const AMBIENT_DURATION_SCALE = 2.2;
const AMBIENT_DURATION_MAX_MS = 5000;

export function easeOutCubic(t) {
    const u = 1 - clamp01(t);
    return 1 - u * u * u;
}

export function easeInOutCubic(t) {
    const x = clamp01(t);
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function easeInOutSine(t) {
    return -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;
}

export function curveForFamily(family = 'director') {
    if (family === 'wheel') return easeOutCubic;
    if (family === 'ambient') return easeInOutSine;
    return easeInOutCubic;
}

// z(e) = z0 · (z1/z0)^e — equal eased time buys an equal zoom RATIO, so a
// 1→2 move no longer rushes at the start and crawls at the end.
export function logZoom(fromZoom, toZoom, eased) {
    if (!(fromZoom > 0) || !(toZoom > 0)) return toZoom;
    if (Math.abs(fromZoom - toZoom) < 1e-9) return toZoom;
    return fromZoom * Math.pow(toZoom / fromZoom, clamp01(eased));
}

// clamp(600 + 0.55·screenPx + 350·|log2 z1/z0|, 700, 2400) ms; the ambient
// family is ×2.2, capped at 5 s.
export function glideDurationMs({ screenPx = 0, fromZoom = 1, toZoom = 1, family = 'director' } = {}) {
    const px = Math.max(0, Number(screenPx) || 0);
    const ratio = fromZoom > 0 && toZoom > 0 ? Math.abs(Math.log2(toZoom / fromZoom)) : 0;
    const base = Math.min(DURATION_MAX_MS, Math.max(DURATION_MIN_MS, 600 + 0.55 * px + 350 * ratio));
    if (family === 'ambient') return Math.min(AMBIENT_DURATION_MAX_MS, base * AMBIENT_DURATION_SCALE);
    return base;
}

// 4.6 — the centre's share of the move at eased parameter e for a zoom ratio
// r = z1/z0: w(e) = (1 − r^−e) / (1 − r^−1), which is e when the zoom holds.
// Its slope is proportional to 1/z(e), so the screen travels at one rate.
function dollyShare(ratio, eased) {
    const e = clamp01(eased);
    const lnRatio = Math.log(ratio);
    if (!Number.isFinite(lnRatio) || Math.abs(lnRatio) < 1e-9) return e;
    return (1 - Math.exp(-lnRatio * e)) / (1 - Math.exp(-lnRatio));
}

// The screen distance a dolly's picture travels: |Δcentre| · z0 · ln r / (1 − 1/r)
// (|Δcentre| · z0 when the zoom holds).
function dollyScreenPx(from, to) {
    const distance = Math.hypot(to.cx - from.cx, to.cy - from.cy);
    const ratio = to.zoom / from.zoom;
    const lnRatio = Math.log(ratio);
    if (!Number.isFinite(lnRatio) || Math.abs(lnRatio) < 1e-9) return distance * from.zoom;
    return (distance * from.zoom * lnRatio) / (1 - 1 / ratio);
}

// Plan one glide between two frames given as { cx, cy, zoom } (screen-centre
// world point plus zoom) for `sampleGlide`. The duration is the formula on the
// dolly's own screen travel and zoom ratio; `duration` overrides it (the
// opening is authored). `rungs` (the resting zooms a stepped glide may rest
// on) plans the stepped family for a renderer without fat flight frames.
export function planGlide(from, to, { family = 'director', duration = null, rungs = null } = {}) {
    const ratio = from.zoom > 0 && to.zoom > 0 ? to.zoom / from.zoom : 1;
    const total = Math.max(1, Number.isFinite(duration) && duration > 0
        ? duration
        : glideDurationMs({
            screenPx: dollyScreenPx(from, to),
            fromZoom: from.zoom,
            toZoom: to.zoom,
            family,
        }));
    const curve = curveForFamily(family);
    const steps = Array.isArray(rungs) && Math.abs(Math.log(ratio)) > 1e-9
        ? rungSteps(from.zoom, to.zoom, rungs, curve, total)
        : null;
    return { total, curve, from, to, ratio, steps };
}

// The stepped family's rung steps in time order, { start, end, fromZoom,
// toZoom }: one per rung crossed, each centred where the dolly's zoom crosses
// the log midpoint of its two rungs, all the same length, fitted inside the
// glide without overlapping.
function rungSteps(fromZoom, toZoom, rungs, curve, total) {
    const zoomingIn = toZoom > fromZoom;
    const low = Math.min(fromZoom, toZoom) * (1 + 1e-6);
    const high = Math.max(fromZoom, toZoom) * (1 - 1e-6);
    const between = rungs
        .filter((zoom) => zoom > low && zoom < high)
        .sort((a, b) => (zoomingIn ? a - b : b - a));
    const ladder = [fromZoom, ...between, toZoom];
    const count = ladder.length - 1;
    const stepMs = Math.min(
        total / count,
        Math.max(WHEEL_STEP_MS, Math.min(ZOOM_STEP_MS, (MAX_FRACTIONAL_SHARE * total) / count)),
    );
    const lnRatio = Math.log(toZoom / fromZoom);
    const steps = [];
    let floor = 0;
    for (let index = 0; index < count; index++) {
        const crossing = Math.log(Math.sqrt(ladder[index] * ladder[index + 1]) / fromZoom) / lnRatio;
        const start = Math.max(floor, total * inverseCurve(curve, crossing) - stepMs / 2);
        steps.push({ start, end: start + stepMs, fromZoom: ladder[index], toZoom: ladder[index + 1] });
        floor = start + stepMs;
    }
    let ceiling = total;
    for (let index = count - 1; index >= 0; index--) {
        const step = steps[index];
        step.end = Math.min(step.end, ceiling);
        step.start = step.end - stepMs;
        ceiling = step.start;
    }
    return steps;
}

// t in [0, 1] with curve(t) = eased, for a monotone family curve.
function inverseCurve(curve, eased) {
    const target = clamp01(eased);
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (curve(mid) < target) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

// A stepped glide's zoom at `t` ms: the rung it rests on, or the eased
// log-zoom inside a rung step.
function steppedZoom(steps, fromZoom, t) {
    let zoom = fromZoom;
    for (const step of steps) {
        if (t >= step.end) {
            zoom = step.toZoom;
            continue;
        }
        if (t > step.start) return logZoom(step.fromZoom, step.toZoom, easeInOutCubic((t - step.start) / (step.end - step.start)));
        break;
    }
    return zoom;
}

// Sample a planned glide at `elapsed` ms → { cx, cy, zoom, done }: centre and
// zoom on the one family curve; the final sample is exactly the target. A
// stepped plan shows its rung zoom z_s where the dolly has z_c, and moves the
// centre so the tighter frame's centre sits where the dolly would put it:
// push-in (1 − w′)·z_s = (1 − w)·z_c, pull-out w′·z_s = w·z_c.
export function sampleGlide(plan, elapsed) {
    const { from, to, curve, total, ratio, steps } = plan;
    const t = Math.max(0, Math.min(total, elapsed));
    if (t >= total) return { cx: to.cx, cy: to.cy, zoom: to.zoom, done: true };
    const e = curve(t / total);
    const dolly = dollyShare(ratio, e);
    let zoom = logZoom(from.zoom, to.zoom, e);
    let share = dolly;
    if (steps) {
        const shown = steppedZoom(steps, from.zoom, t);
        share = clamp01(ratio > 1 ? 1 - ((1 - dolly) * zoom) / shown : (dolly * zoom) / shown);
        zoom = shown;
    }
    return {
        cx: from.cx + (to.cx - from.cx) * share,
        cy: from.cy + (to.cy - from.cy) * share,
        zoom,
        done: false,
    };
}

// 8.2 — one exact step of a critically damped spring toward `target`
// (x'' = ω²(target − x) + 2ω(targetVelocity − x')). Solved in the frame that
// moves with the target, so a target walking at a steady speed is tracked
// with no trailing lag; exact for any dt, so a slow frame never overshoots.
// dt in ms; velocities in units/ms; returns { x, v }.
export function criticalSpringStep(x, v, target, omegaPerSecond, dtMs, targetVelocity = 0) {
    const omega = omegaPerSecond / 1000;
    const dt = Math.max(0, dtMs);
    const e = x - target;
    const u = v - targetVelocity;
    const decay = Math.exp(-omega * dt);
    const c = u + omega * e;
    return {
        x: target + targetVelocity * dt + (e + c * dt) * decay,
        v: targetVelocity + (u - omega * c * dt) * decay,
    };
}

function clamp01(t) {
    const x = Number(t);
    if (!Number.isFinite(x)) return 1;
    return x < 0 ? 0 : x > 1 ? 1 : x;
}
