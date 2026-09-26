// 8.1 — one motion vocabulary for the World camera. Pure functions, no DOM.
//
// Families:
//   wheel     — 150 ms easeOutCubic tier step (a responsive UI answer)
//   director  — cues, attention, re-frames, returns: easeInOutCubic
//   ambient   — the Ambient broadcast and the empty-village tour: easeInOutSine,
//               durations ×2.2 with a 5 s cap
//
// A glide interpolates the SCREEN-CENTRE world point (a straight line between
// the two frames) and the zoom in log space. A glide that both pans and changes
// zoom is split so the pan runs at a resting integer tier and the zoom is one
// step (C3: ≥ 75 % of every glide is pixel-exact): zooming in pans first and
// steps in at the target; zooming out steps out first and then pans. A zoom
// step is never squeezed to fit the 25 % share: it takes ZOOM_STEP_MS per
// resting rung it crosses and the glide grows around it.

export const WHEEL_STEP_MS = 150;
export const FOLLOW_ENTRY_MS = 500;
export const ZOOM_STEP_MS = 450;
// A glide never spends more than this share of its time at a fractional zoom.
const MAX_FRACTIONAL_SHARE = 0.25;
// Below this screen distance a zooming glide is a pure tier step, not a pan.
const PAN_EPSILON_PX = 2;

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

// Plan one glide between two frames given as { cx, cy, zoom } (screen-centre
// world point plus zoom). Returns the segments the camera samples with
// `sampleGlide`. `duration` overrides the formula (the opening is authored);
// it is still lengthened if the zoom steps need more room.
//
// `tiers` is the resting ladder: a zoom that crosses N rungs of it takes
// N × ZOOM_STEP_MS (at least one step), so 3→1 is a 900 ms step, never a
// 325 ms lurch. The total then grows until the fractional share is ≤ 25 %.
// `restingLeadMs` is time the camera already spends resting at `from` as
// part of the same shot (the opening's survey hold); it counts toward the
// pixel-exact share.
//
// `stepped` (the opening dolly) keeps the pan running for the whole move and
// climbs the resting ladder one step per rung, spaced evenly through the
// move, so a multi-tier dolly reads as a continuous push-in with crisp
// landings instead of one long fractional zoom.
export function planGlide(from, to, {
    family = 'director',
    duration = null,
    stepped = false,
    tiers = null,
    restingLeadMs = 0,
} = {}) {
    const fromZoom = from.zoom;
    const toZoom = to.zoom;
    const zoomChanges = Math.abs(toZoom - fromZoom) > 1e-6;
    const zoomingIn = toZoom > fromZoom;
    // The pan runs at the resting tier on the pixel-exact side of the move.
    const panZoom = zoomChanges ? (zoomingIn ? fromZoom : toZoom) : fromZoom;
    const screenPx = Math.hypot(to.cx - from.cx, to.cy - from.cy) * panZoom;
    const requested = Math.max(1, Number.isFinite(duration) && duration > 0
        ? duration
        : glideDurationMs({ screenPx, fromZoom, toZoom, family }));
    const curve = curveForFamily(family);

    if (!zoomChanges) {
        return { total: requested, curve, from, to, segments: [{ kind: 'pan', start: 0, end: requested }] };
    }
    const between = (Array.isArray(tiers) ? tiers : [])
        .filter((z) => z > Math.min(fromZoom, toZoom) + 1e-6 && z < Math.max(fromZoom, toZoom) - 1e-6)
        .sort((a, b) => (zoomingIn ? a - b : b - a));
    const ladder = [fromZoom, ...between, toZoom];
    const rungs = ladder.length - 1;
    const zoomMs = ZOOM_STEP_MS * rungs;
    // Smallest total that keeps the zoom at ≤ 25 % of the shot.
    const lead = Math.max(0, Number(restingLeadMs) || 0);
    const shareFloor = Math.max(0, zoomMs / MAX_FRACTIONAL_SHARE - lead);
    if (stepped) {
        // Rung centres sit at total·(i+1)/(rungs+1); keep a resting gap
        // between neighbouring steps.
        const total = Math.max(requested, shareFloor, (rungs + 1) * ZOOM_STEP_MS);
        const segments = [{ kind: 'pan', start: 0, end: total }];
        for (let index = 0; index < rungs; index++) {
            const middle = (total * (index + 1)) / (rungs + 1);
            segments.push({
                kind: 'zoom',
                start: middle - ZOOM_STEP_MS / 2,
                end: middle + ZOOM_STEP_MS / 2,
                fromZoom: ladder[index],
                toZoom: ladder[index + 1],
            });
        }
        return { total, curve, from, to, segments };
    }
    if (screenPx < PAN_EPSILON_PX) {
        // A pure tier change: one zoom step, no pan to hide it behind.
        return { total: zoomMs, curve, from, to, segments: [{ kind: 'zoom', start: 0, end: zoomMs }] };
    }
    const total = Math.max(requested, shareFloor);
    const segments = zoomingIn
        ? [{ kind: 'pan', start: 0, end: total - zoomMs }, { kind: 'zoom', start: total - zoomMs, end: total }]
        : [{ kind: 'zoom', start: 0, end: zoomMs }, { kind: 'pan', start: zoomMs, end: total }];
    return { total, curve, from, to, segments };
}

// Sample a planned glide at `elapsed` ms → { cx, cy, zoom, done }. Zoom steps
// always use easeInOutCubic in log space; the pan uses the family curve.
export function sampleGlide(plan, elapsed) {
    const { from, to, segments, curve, total } = plan;
    const t = Math.max(0, Math.min(total, elapsed));
    let cx = from.cx;
    let cy = from.cy;
    let zoom = from.zoom;
    for (const segment of segments) {
        if (t <= segment.start) continue;
        const span = Math.max(1e-6, segment.end - segment.start);
        const local = Math.min(1, (t - segment.start) / span);
        if (segment.kind === 'pan') {
            const e = curve(local);
            cx = from.cx + (to.cx - from.cx) * e;
            cy = from.cy + (to.cy - from.cy) * e;
        } else {
            zoom = logZoom(segment.fromZoom ?? from.zoom, segment.toZoom ?? to.zoom, easeInOutCubic(local));
        }
    }
    const done = t >= total;
    if (done) {
        cx = to.cx;
        cy = to.cy;
        zoom = to.zoom;
    }
    return { cx, cy, zoom, done };
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
