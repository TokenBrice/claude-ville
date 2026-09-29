// 10.2 HDR highlights and 10.3 P3 roles (contract §7.1–7.5): the pure policy
// both GPU renderers read. Nothing here touches a canvas except the two media
// helpers and the overlay ink hook at the bottom.
//
// HDR (WebGPU only; WebGL has no drawing-buffer tone mapping): role-1 pixels
// (building and prop emitters with an authored emissive sidecar, never a
// character) gain linear light in three courses stepped by emission luma
// while the lamps are lit, capped below the NEEDS YOU mark's own light;
// role-2 mark records (action-needed marks and the C4 verified-success
// cream peak frame) gain the mark gain in the post-composite mark pass. The
// mark gain is derived from the emitter peak, so marks always ride
// HDR_MARKS_ABOVE_EMITTER above it.
// Anything that is not HDR — setting off, an SDR screen, WebGL2, Canvas —
// takes the shipped pipelines and bytes.
//
// P3 (WebGPU and WebGL2, only under `(color-gamut: p3)`): the canvas is
// display-p3, the end of the composite converts sRGB to P3 (the same colour,
// P3 numbers), and role pixels above the first emission course gain OKLab
// chroma ×P3_ROLE_CHROMA at their own OKLab lightness and hue (fitted to the
// P3 gamut). Water, void, ground and pennants are never role pixels, so they
// are never stretched.
import { HDR_HIGHLIGHT_MODES, HDR_HIGHLIGHTS_DEFAULT, normalizeHdrHighlights } from '../shared/DisplaySettings.js';
import { P3_VARIANTS } from '../../config/p3Variants.js';
import { STATUS_VISUALS, THEME } from '../../config/theme.js';
import { EFFECT_COLORS } from '../../config/artPalette.js';
import { lampCourseAt } from './GradeEvaluator.js';
import { seasonShiftFor } from './AtmosphereState.js';
import { seasonTokenForAtmosphere } from './SeasonalAmbience.js';

export { HDR_HIGHLIGHT_MODES, HDR_HIGHLIGHTS_DEFAULT };

// Action-needed marks sit this far above the brightest emitter course, in
// linear gain. The one constant: the mark gain is emitterPeak + this.
export const HDR_MARKS_ABOVE_EMITTER = 0.5;
// Emission-luma floors of the three emitter courses (ColorHDR's prototype).
export const HDR_EMITTER_COURSE_LUMA = Object.freeze([0.10, 0.30, 0.55]);
// Each course's share of the emitter headroom (peak − 1).
export const HDR_EMITTER_COURSE_SHARE = Object.freeze([0.35, 0.65, 1.0]);
const HDR_EMITTER_PEAK = Object.freeze({ subtle: 1.5, full: 2.0 });
// "Emitters never outshine the action-needed marks" (10.2), in absolute
// light as well as in gain: a lifted emitter pixel's linear luminance stays
// below the primary action mark — the NEEDS YOU hue at its mode's mark gain
// — by this margin. The ordering is measured on that hue: a red or violet
// mark cannot outrank a white flame core without lifting the flame below its
// own SDR value, which the cap never does.
export const HDR_CAP_MARK_HUE = STATUS_VISUALS.waiting_on_user.color;
export const HDR_EMITTER_CAP_MARGIN = 0.02;
// Rec.709 luma of the (linear-ish) emission attachment, for the courses.
export const EMISSION_LUMA = Object.freeze([0.2126, 0.7152, 0.0722]);
export const P3_ROLE_CHROMA = 1.22;
// 10.3 — the role chroma stretch runs in OKLab (Ottosson's matrices), so a
// role pixel keeps its OKLab lightness and hue and only its chroma grows,
// fitted back inside the P3 gamut when x1.22 would leave it.
export const OKLAB_LMS_FROM_LINEAR_SRGB = Object.freeze([
    [0.4122214708, 0.5363325363, 0.0514459929],
    [0.2119034982, 0.6806995451, 0.1073969566],
    [0.0883024619, 0.2817188376, 0.6299787005],
]);
export const OKLAB_FROM_LMS_CBRT = Object.freeze([
    [0.2104542553, 0.7936177850, -0.0040720468],
    [1.9779984951, -2.4285922050, 0.4505937099],
    [0.0259040371, 0.7827717662, -0.8086757660],
]);
export const LMS_CBRT_FROM_OKLAB = Object.freeze([
    [1.0, 0.3963377774, 0.2158037573],
    [1.0, -0.1055613458, -0.0638541728],
    [1.0, -0.0894841775, -1.2914855480],
]);
export const LINEAR_SRGB_FROM_OKLAB_LMS = Object.freeze([
    [4.0767416621, -3.3077115913, 0.2309699292],
    [-1.2684380046, 2.6097574011, -0.3413193965],
    [-0.0041960863, -0.7034186147, 1.7076147010],
]);

/** Relative luminance (linear sRGB Y) of a `#rrggbb` colour. */
export function srgbLuminance(hex) {
    const value = Number.parseInt(String(hex).replace('#', ''), 16);
    const eotf = byte => {
        const c = byte / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return SRGB_LUMA[0] * eotf((value >> 16) & 0xff) + SRGB_LUMA[1] * eotf((value >> 8) & 0xff) + SRGB_LUMA[2] * eotf(value & 0xff);
}

/**
 * The gains a mode applies: `emitter[i]` for emission course i (luma at or
 * above HDR_EMITTER_COURSE_LUMA[i]), `mark` for action-needed mark records,
 * and `emitterCap`, the linear luminance no lifted emitter pixel exceeds
 * (the NEEDS YOU hue at `mark`, less HDR_EMITTER_CAP_MARGIN): a course gain
 * stops where the pixel would reach it, never below 1. `off` lifts nothing
 * (and never reaches a shader: it selects the SDR path), so its cap is SDR
 * white.
 */
export function hdrGainTable(mode) {
    const normalized = normalizeHdrHighlights(mode);
    if (normalized === 'off') return Object.freeze({ mode: 'off', emitter: Object.freeze([1, 1, 1]), emitterPeak: 1, mark: 1, emitterCap: 1 });
    const peak = HDR_EMITTER_PEAK[normalized];
    const mark = peak + HDR_MARKS_ABOVE_EMITTER;
    return Object.freeze({
        mode: normalized,
        emitter: Object.freeze(HDR_EMITTER_COURSE_SHARE.map(share => 1 + (peak - 1) * share)),
        emitterPeak: peak,
        mark,
        emitterCap: srgbLuminance(HDR_CAP_MARK_HUE) * mark - HDR_EMITTER_CAP_MARGIN,
    });
}

// The emitter courses wait for the lamps: the `settling` lamp course
// (GradeEvaluator.lampCourseAt), the minutes BuildingSprite.lampsLitAt and
// the Lighthouse beam use. Marks never wait.
export const HDR_LAMP_COURSE = 1;

export function hdrLampsLit(atmosphere) {
    const minute = Number(atmosphere?.clock?.minuteOfDay);
    if (!Number.isFinite(minute)) return false;
    return lampCourseAt(minute, seasonShiftFor(seasonTokenForAtmosphere(atmosphere))) >= HDR_LAMP_COURSE;
}

/**
 * Which display path a backend takes. HDR needs the WebGPU presenter, a
 * setting other than off and `(dynamic-range: high)`; P3 needs
 * `(color-gamut: p3)` and a GPU world (the Canvas renderer draws 2D only).
 * Everything false is the shipped SDR path, byte for byte.
 */
export function resolveDisplayColor({ backend = 'canvas', hdrMode = HDR_HIGHLIGHTS_DEFAULT, dynamicRangeHigh = false, colorGamutP3 = false, toneMappingSupported = true } = {}) {
    const mode = normalizeHdrHighlights(hdrMode);
    const hdr = backend === 'webgpu' && mode !== 'off' && dynamicRangeHigh === true && toneMappingSupported !== false;
    const p3 = colorGamutP3 === true && (backend === 'webgpu' || backend === 'webgl');
    let reason = 'hdr';
    if (!hdr) {
        reason = backend !== 'webgpu' ? 'needs the WebGPU renderer'
            : mode === 'off' ? 'setting off'
                : dynamicRangeHigh !== true ? 'SDR screen'
                    : 'canvas tone mapping unsupported';
    }
    return { hdr, p3, mode, gains: hdrGainTable(hdr ? mode : 'off'), reason };
}

// CIE 1931 xy primaries and the D65 white both spaces share.
const D65 = [0.3127, 0.3290];
const SRGB_PRIMARIES = [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]];
const P3_PRIMARIES = [[0.680, 0.320], [0.265, 0.690], [0.150, 0.060]];

function invert3(m) {
    const [a, b, c] = m[0];
    const [d, e, f] = m[1];
    const [g, h, i] = m[2];
    const A = e * i - f * h;
    const B = -(d * i - f * g);
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [
        [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
        [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
        [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
    ];
}

function multiply3(a, b) {
    return a.map(row => [0, 1, 2].map(col => row[0] * b[0][col] + row[1] * b[1][col] + row[2] * b[2][col]));
}

// Linear RGB → XYZ for a set of primaries under D65 (rows X, Y, Z).
function rgbToXyz(primaries) {
    const xyz = ([x, y]) => [x / y, 1, (1 - x - y) / y];
    const columns = primaries.map(xyz);
    const p = [0, 1, 2].map(row => columns.map(column => column[row]));
    const white = xyz(D65);
    const inv = invert3(p);
    const s = inv.map(row => row[0] * white[0] + row[1] * white[1] + row[2] * white[2]);
    return p.map(row => row.map((value, col) => value * s[col]));
}

const SRGB_TO_XYZ = rgbToXyz(SRGB_PRIMARIES);
const P3_TO_XYZ = rgbToXyz(P3_PRIMARIES);
/** Linear sRGB → linear Display P3, rows (M · rgb). The same colour, P3 numbers. */
export const SRGB_TO_P3 = Object.freeze(multiply3(invert3(P3_TO_XYZ), SRGB_TO_XYZ).map(row => Object.freeze(row)));
/** Relative luminance weights of linear Display P3 (the Y row). */
export const P3_LUMA = Object.freeze(P3_TO_XYZ[1].slice());
export const SRGB_LUMA = Object.freeze(SRGB_TO_XYZ[1].slice());

/** A 3×3 row matrix as a column-major WGSL/GLSL constructor argument list. */
export function columnMajor(matrix, digits = 9) {
    return [0, 1, 2].map(col => [0, 1, 2].map(row => matrix[row][col].toFixed(digits)).join(', ')).join(', ');
}

// ── P3 role chroma (10.3), the JS twin of the shaders' `p3RoleChroma` ──
function mul3(m, v) {
    return [0, 1, 2].map(row => m[row][0] * v[0] + m[row][1] * v[1] + m[row][2] * v[2]);
}

function srgbEotf(c) {
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function srgbOetf(c) {
    const v = Math.max(c, 0);
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

function p3FromOklab(lab) {
    const lms = mul3(LMS_CBRT_FROM_OKLAB, lab).map(v => v * v * v);
    return mul3(SRGB_TO_P3, mul3(LINEAR_SRGB_FROM_OKLAB_LMS, lms));
}

const outsideUnit = c => c.some(v => v < -1e-4 || v > 1 + 1e-4);

/**
 * A role pixel (linear sRGB in) as linear Display P3 with its OKLab chroma
 * ×P3_ROLE_CHROMA at the same OKLab lightness and hue, the stretch bisected
 * down (8 steps) until it fits the P3 gamut — step for step what the GLSL
 * and WGSL `p3RoleChroma` do to a role pixel or an action-mark texel.
 */
export function p3RoleChroma(lin) {
    const lab = mul3(OKLAB_FROM_LMS_CBRT, mul3(OKLAB_LMS_FROM_LINEAR_SRGB, lin).map(Math.cbrt));
    const stretched = mid => p3FromOklab([lab[0], lab[1] * mid, lab[2] * mid]);
    let p3 = stretched(P3_ROLE_CHROMA);
    if (outsideUnit(p3)) {
        p3 = mul3(SRGB_TO_P3, lin);
        let lo = 1;
        let hi = P3_ROLE_CHROMA;
        for (let i = 0; i < 8; i++) {
            const mid = 0.5 * (lo + hi);
            const t = stretched(mid);
            if (outsideUnit(t)) hi = mid;
            else {
                lo = mid;
                p3 = t;
            }
        }
    }
    return p3.map(v => Math.min(Math.max(v, 0), 1));
}

/** A `#rrggbb` ink as the CSS Display P3 colour the GPU role path gives it. */
export function p3RoleInk(hex) {
    const value = Number.parseInt(String(hex).replace('#', ''), 16);
    const lin = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].map(byte => srgbEotf(byte / 255));
    return `color(display-p3 ${p3RoleChroma(lin).map(v => srgbOetf(v).toFixed(4)).join(' ')})`;
}

// The reserved hues the overlay (and Canvas) draw as their P3 role inks:
// the six status hues and the C4 work ember, success, bell, failure and
// peak. Water, grass, the forge albedo and the C1 emissive ramp are never
// remapped (the emissive ramp gains its chroma in the GPU composite).
export const P3_RESERVED_HUES = Object.freeze([
    THEME.working, THEME.idle, THEME.waiting, THEME.error, THEME.rateLimited, THEME.waitingOnUser,
    ...EFFECT_COLORS.work, EFFECT_COLORS.success, EFFECT_COLORS.bell, EFFECT_COLORS.failure, EFFECT_COLORS.peak,
].map(hex => hex.toLowerCase()));

// ── Media ───────────────────────────────────────────────────────────────
const DYNAMIC_RANGE_QUERY = '(dynamic-range: high)';
const P3_QUERY = '(color-gamut: p3)';

function mediaList(root, query) {
    try { return root?.matchMedia?.(query) || null; } catch { return null; }
}

/** `{ dynamicRangeHigh, colorGamutP3 }` from the window's media queries. */
export function readDisplayMedia(root = globalThis.window) {
    return {
        dynamicRangeHigh: mediaList(root, DYNAMIC_RANGE_QUERY)?.matches === true,
        colorGamutP3: mediaList(root, P3_QUERY)?.matches === true,
    };
}

/** Calls `onChange(readDisplayMedia())` on either query's `change`; returns the unsubscribe. */
export function watchDisplayMedia(onChange, root = globalThis.window) {
    const lists = [mediaList(root, DYNAMIC_RANGE_QUERY), mediaList(root, P3_QUERY)].filter(Boolean);
    const listener = () => onChange(readDisplayMedia(root));
    for (const list of lists) list.addEventListener?.('change', listener);
    return () => {
        for (const list of lists) list.removeEventListener?.('change', listener);
    };
}

// ── Overlay inks (10.3) ─────────────────────────────────────────────────
const P3_INKS = new Map();
for (const [hex, css] of Object.entries(P3_VARIANTS)) {
    P3_INKS.set(hex, css);
    P3_INKS.set(hex.toUpperCase(), css);
}

// Whether the window is on a P3 screen now. A display-p3 overlay context
// keeps its colour space for life (attributes are fixed at the first
// getContext) but draws sRGB strings colorimetrically, so only the variant
// remap follows the screen: off an sRGB screen the reserved hues draw their
// own sRGB bytes again.
let overlayInksP3 = false;

/** The live `(color-gamut: p3)` state (the World's media watch sets it). */
export function setOverlayInksP3(on) {
    overlayInksP3 = on === true;
}

/**
 * On a display-p3 overlay context, every reserved status and C4 hue set as a
 * fill or stroke is drawn as its generated P3 variant while the window is on
 * a P3 screen (`setOverlayInksP3`); every other colour is untouched (the
 * context converts sRGB strings to the same colour in P3). Returns true when
 * the hook was installed.
 */
export function installP3OverlayInks(ctx) {
    if (!ctx || ctx.getContextAttributes?.().colorSpace !== 'display-p3') return false;
    const proto = Object.getPrototypeOf(ctx);
    for (const name of ['fillStyle', 'strokeStyle']) {
        const property = Object.getOwnPropertyDescriptor(proto, name);
        if (!property?.set) continue;
        Object.defineProperty(ctx, name, {
            configurable: true,
            get() { return property.get.call(this); },
            set(value) { property.set.call(this, overlayInksP3 && typeof value === 'string' ? (P3_INKS.get(value) ?? value) : value); },
        });
    }
    return true;
}
