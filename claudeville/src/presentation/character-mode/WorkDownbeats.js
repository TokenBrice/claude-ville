// 6.6 — the work downbeat: a C4 Minor-tier beat struck by a villager's building
// gesture (see RitualConductor.ritualDownbeat for when). Work family: slashes
// and chips in the ember ramp, one cream strike frame, no residue.
//
// Drawn by AgentSprite._drawToolRitualOverlay on the same context as the
// gesture it punctuates, in world texels (camera transform applied): the Canvas
// world pass, or the ungraded resident overlay, so the beat is visible on both
// backends. Only fillRect on integer texels; every tone comes from the C4 kit.
import { EFFECT_COLORS } from '../../config/artPalette.js';
import { PEAK, chips, snap } from './EffectStamps.js';
import { getActiveMarkGovernor, MarkTier } from './MarkGovernor.js';
import { ritualDownbeat } from './RitualConductor.js';

const WORK = EFFECT_COLORS.work; // dark, mid, light ember

// Where each gesture meets its work, in the gesture's local units (the same
// origin and scale AgentSprite draws the gesture with). `x` is mirrored by the
// facing side. Head-height gestures (gaze, signal, scan) use the head origin.
// Hammer and pick strike just under the struck head (its contact point at
// swing 0), so the beat bursts off the tool instead of painting over it.
const STRIKE_POINT = Object.freeze({
    hammer: { x: 4, y: -4, kind: 'slash' },
    pick: { x: 2, y: -1, kind: 'chip' },
    page: { x: 0, y: -4, kind: 'page' },
    scroll: { x: 0, y: -3, kind: 'slash' },
    gaze: { x: 8, y: 2, kind: 'glint' },
    conjure: { x: 0, y: -3, kind: 'slash' },
    signal: { x: 3, y: -4, kind: 'glint' },
    haul: { x: 0, y: -6, kind: 'chip' },
    scan: { x: 4, y: -2, kind: 'glint' },
});

// Three slash directions fanning out from the strike: up-back, up-forward and
// flat-forward (x is mirrored by the facing side), clear of the tool's own
// handle above the strike. Each slash is a 1-texel staircase so no stroke or
// diagonal line ever anti-aliases.
const SLASHES = Object.freeze([
    Object.freeze({ dx: -1, dy: -1 }),
    Object.freeze({ dx: 1, dy: -1 }),
    Object.freeze({ dx: 1, dy: 0 }),
]);

// Draw the beat for `ritual` if one is on screen. (x, y) and `scale` are the
// gesture origin and scale; `side` is +1 facing right, -1 facing left.
export function drawWorkDownbeat(ctx, ritual, x, y, { side = 1, scale = 1, now = Date.now() } = {}) {
    const beat = ritualDownbeat(ritual, now);
    if (!beat) return false;
    const strike = STRIKE_POINT[ritual.pose];
    if (!strike) return false;
    const px = snap(x + strike.x * side * scale);
    const py = snap(y + strike.y * scale);
    // Work evidence from a real tool event: the WORKING tier, so the beat
    // reads beside the villager's status marks and is shed with them, not
    // before them, in a dense frame.
    const gate = getActiveMarkGovernor()?.admit(MarkTier.WORKING, px, py);
    if (gate && !gate.draw) return false;

    ctx.save();
    ctx.globalAlpha *= beat.alpha * (gate?.alpha ?? 1);
    if (beat.phase === 'anticipation') {
        // Wind-up: two ember specks gather toward the strike point.
        const reach = 3 - beat.step;
        ctx.fillStyle = WORK[1];
        ctx.fillRect(px - reach - 1, py, 1, 1);
        ctx.fillRect(px + reach, py, 1, 1);
    } else if (beat.phase === 'peak') {
        // The one cream action frame: a 2×2 core and three short rays.
        ctx.fillStyle = PEAK;
        ctx.fillRect(px - 1, py - 1, 2, 2);
        drawSlashes(ctx, px, py, side, 2, 2, PEAK, PEAK);
    } else {
        // Stepped follow-through: the mark travels one texel per quantum
        // while ALPHA_QUANTA steps it down (alpha applied above).
        const push = 2 + beat.step;
        switch (strike.kind) {
            case 'chip':
                chips(ctx, px, py, beat.t, { count: 4, seed: beat.index + 7, spread: 6, lift: 4, tones: WORK });
                break;
            case 'page': {
                // A leaf flicked up off the book: 2×1 / 1×2 tumbling frames.
                ctx.fillStyle = beat.step === 1 ? WORK[2] : PEAK;
                const flat = beat.step % 2 === 0;
                ctx.fillRect(px + side * beat.step, py - push, flat ? 2 : 1, flat ? 1 : 2);
                ctx.fillStyle = WORK[1];
                ctx.fillRect(px - side * (push - 1), py - 1, 1, 1);
                break;
            }
            case 'glint':
                ctx.fillStyle = WORK[2];
                ctx.fillRect(px, py - push, 1, 1);
                ctx.fillRect(px - push, py, 1, 1);
                ctx.fillRect(px + push, py, 1, 1);
                break;
            default:
                drawSlashes(ctx, px, py, side, push, 2, WORK[1], WORK[2]);
                break;
        }
    }
    ctx.restore();
    return true;
}

// Three staircase slashes starting `offset` texels out from (px, py), each
// `length` texels long, body tone then a lighter tip.
function drawSlashes(ctx, px, py, side, offset, length, body, tip) {
    for (const slash of SLASHES) {
        const sx = slash.dx * side;
        for (let i = 0; i < length; i++) {
            const d = offset + i;
            ctx.fillStyle = i === length - 1 ? tip : body;
            ctx.fillRect(px + sx * d, py + slash.dy * d, 1, 1);
        }
    }
}
