import { drawEventShape, EVENT_SHAPES } from '../shared/EventShapes.js';
import {
    getActiveMarkGovernor,
    MarkTier,
    ornamentPlan,
    resolveCalmGate,
    sampleFramePressure,
} from './MarkGovernor.js';
import {
    gpuDepthKey,
    GPU_PARTICLE_FLAGS,
    GPU_PARTICLE_INSTANCE_BYTES,
    GPU_PARTICLE_MOTIF_SIZE,
    GPU_PARTICLE_SHAPES,
    SMOKE_PUFF_LIT_GAIN,
    SMOKE_PUFF_SHADE_GAIN,
} from './gpu/GpuWorldPolicy.js';

const PARTICLE_GRAVITY = 0.05;
const MAX_PARTICLES = 240;
// 0.6 — open-air drift (snow) sorts in front of the whole village: a flake
// between the camera and a roof is in front of that roof. Finite, so the
// Canvas sort and the GPU depth key (clamped to its nearest step) agree.
export const PARTICLE_SORT_Y_OPEN_AIR = 100000;

// 0.6 — event-shape motifs as one R8 mask: each 8x8 motif core (the drawn
// rows and columns 4-11 of its padded 16x16 grid) stacked vertically in
// EVENT_SHAPES order. The resident particle draw reads it with texelFetch.
export const PARTICLE_MOTIF_IDS = Object.freeze(Object.keys(EVENT_SHAPES));
const MOTIF_INDEX = new Map(PARTICLE_MOTIF_IDS.map((id, index) => [id, index]));
const MOTIF_PAD = 4;
let _motifMask = null;

export function particleMotifMask() {
    if (_motifMask) return _motifMask;
    const size = GPU_PARTICLE_MOTIF_SIZE;
    const data = new Uint8Array(size * size * PARTICLE_MOTIF_IDS.length);
    PARTICLE_MOTIF_IDS.forEach((id, index) => {
        const rows = EVENT_SHAPES[id];
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (rows[y + MOTIF_PAD]?.[x + MOTIF_PAD] === '1') data[(index * size + y) * size + x] = 255;
            }
        }
    });
    _motifMask = Object.freeze({
        width: size,
        height: size * PARTICLE_MOTIF_IDS.length,
        data,
        revision: `particle-motifs:${PARTICLE_MOTIF_IDS.length}`,
    });
    return _motifMask;
}

// Particle colours arrive as `#rgb`, `#rrggbb`, `rgb()` or `rgba()`; parsed
// once per distinct string for the GPU instance bytes.
const PARTICLE_COLOR_CACHE_LIMIT = 256;
const _particleColors = new Map();

function particleColor(text) {
    let parsed = _particleColors.get(text);
    if (parsed !== undefined) return parsed;
    parsed = null;
    const value = String(text || '').trim();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
    if (hex) {
        const digits = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
        const number = Number.parseInt(digits, 16);
        parsed = [(number >> 16) & 255, (number >> 8) & 255, number & 255, 1];
    } else {
        const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value);
        if (rgb) {
            const channel = (v) => Math.max(0, Math.min(255, Math.round(Number(v))));
            parsed = [channel(rgb[1]), channel(rgb[2]), channel(rgb[3]), rgb[4] == null ? 1 : Math.max(0, Math.min(1, Number(rgb[4])))];
        }
    }
    if (_particleColors.size >= PARTICLE_COLOR_CACHE_LIMIT) _particleColors.clear();
    _particleColors.set(text, parsed);
    return parsed;
}
export const PARTICLE_ROLES = Object.freeze({
    fauna: Object.freeze(['butterfly', 'dragonfly']),
    ambient: Object.freeze(['sparkle', 'leaf', 'petal', 'snow']),
});

export function particleRole(type) {
    if (PARTICLE_ROLES.fauna.includes(type)) return 'fauna';
    if (PARTICLE_ROLES.ambient.includes(type)) return 'ambient';
    return 'semantic';
}

export function particleSpawnAllowed(type, {
    level = 0,
    calm = false,
    motionEnabled = true,
} = {}) {
    if (!motionEnabled) return false;
    const plan = ornamentPlan({ level, calm, motionScale: 1 });
    const role = particleRole(type);
    if (role === 'fauna' && plan.faunaCadence !== 'on') return false;
    if (role === 'ambient') {
        if (plan.ambientParticles === 'off') return false;
        if (type === 'sparkle' && plan.ambientSparkle === 'off') return false;
    }
    return true;
}

// C6 — halve a `#rrggbb` color to a darker `rgb()` for the butterfly body seam.
function darkenHex(hex) {
    const h = String(hex).replace('#', '');
    if (h.length !== 6) return 'rgb(40,30,20)';
    const r = (parseInt(h.slice(0, 2), 16) * 0.5) | 0;
    const g = (parseInt(h.slice(2, 4), 16) * 0.5) | 0;
    const b = (parseInt(h.slice(4, 6), 16) * 0.5) | 0;
    if (!Number.isFinite(r + g + b)) return 'rgb(40,30,20)';
    return `rgb(${r},${g},${b})`;
}

class Particle {
    constructor(x, y, vx, vy, life, color, size, gravity, alpha = 1, opts = {}) {
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.life = life;
        this.maxLife = life;
        this.color = color;
        this.size = size;
        this.gravity = gravity;
        this.alpha = alpha;
        // 0.6 — the painter depth the particle sorts at, fixed at spawn (its
        // emitter's ground line or owner), and its GPU depth key.
        this.sortY = opts.sortY;
        this.depthKey = gpuDepthKey(opts.sortY);
        // C6 — shaped-insect draw hints. `shape` keys the draw branch;
        // `phase`/`animRate` give each insect a deterministic, per-particle wing
        // flap cycle seeded once at spawn (never in draw).
        this.shape = opts.shape || null;
        this.phase = opts.phase || 0;
        this.animRate = opts.animRate || 0;
        this.bodyColor = this.shape === 'butterfly' ? darkenHex(color) : null;
        // Matter (smoke, dust, leaves) takes the scene's grade; every other
        // preset is light and keeps its colour.
        this.lit = !!opts.lit;
        // 6.7 — `tag` lets an emitter count its own live particles (seasonal
        // drift caps); `baseColor` is an emissive tone a smoke puff wears only
        // on its first step (a fire-lit underside at the chimney mouth).
        this.tag = opts.tag || null;
        this.baseColor = opts.baseColor || null;
        // A lit particle whose emitter already graded it (night chimney
        // smoke: moonlit soot held above the dark). A backend that grades
        // particles itself (the resident GPU draw) wears this ungraded; the
        // Canvas frame grades `color` after the fact instead.
        this.gradedColor = opts.gradedColor || null;
        // 6.4 — the chimney mouth a smoke puff rose from: its alpha quantum
        // steps with height above it, and it is gone at SMOKE_COLUMN_PX.
        this.originY = Number.isFinite(opts.originY) ? opts.originY : y;
    }

    update(dt = 16) {
        const frameScale = Math.max(0, Math.min(3, dt / 16));
        this.x += this.vx * frameScale;
        this.y += this.vy * frameScale;
        if (this.gravity) {
            this.vy += PARTICLE_GRAVITY * frameScale;
        }
        this.life -= frameScale;
        if (this.shape === 'smoke' && this.originY - this.y >= SMOKE_COLUMN_PX) this.life = 0;
    }

    get alive() {
        return this.life > 0;
    }

    // 0.6 — one resident GPU instance with exactly the rects `draw` paints on
    // Canvas (GpuWorldPolicy GPU_PARTICLE_INSTANCE_BYTES layout). Returns
    // false for a particle that paints nothing.
    writeGpuInstance(views, index, motionEnabled = true) {
        const age = this.maxLife - this.life;
        const cx = Math.round(this.x);
        const cy = Math.round(this.y);
        let alpha = (this.life / this.maxLife) * this.alpha;
        let color = this.lit && this.gradedColor ? this.gradedColor : this.color;
        let flags = this.lit
            ? (this.gradedColor ? 0 : GPU_PARTICLE_FLAGS.graded)
            : GPU_PARTICLE_FLAGS.emits;
        let shape = GPU_PARTICLE_SHAPES.rect;
        let motif = 0;
        let left;
        let top;
        let width;
        let height;
        const motifIndex = MOTIF_INDEX.get(this.shape);
        if (this.shape === 'smoke') {
            // 6.4 — one round three-tone puff; the shader cuts the disc and
            // steps the lit and shade rims from the body tone.
            const radius = smokePuffRadius(age, this.maxLife);
            const step0 = radius === SMOKE_PUFF_RADII[0];
            if (step0 && this.baseColor) {
                color = this.baseColor;
                flags = 0;
            }
            alpha = smokePuffAlpha(this.originY - this.y) * this.alpha;
            shape = GPU_PARTICLE_SHAPES.smoke;
            left = cx - radius;
            top = cy - radius;
            width = radius * 2;
            height = radius * 2;
        } else if (motifIndex !== undefined) {
            shape = GPU_PARTICLE_SHAPES.motif;
            motif = motifIndex;
            left = cx - 8 + MOTIF_PAD;
            top = cy - 8 + MOTIF_PAD;
            width = GPU_PARTICLE_MOTIF_SIZE;
            height = GPU_PARTICLE_MOTIF_SIZE;
        } else if (this.shape === 'butterfly') {
            const scale = motionEnabled ? Math.abs(Math.sin(age * this.animRate + this.phase)) : 0.6;
            const wingW = Math.max(1, Math.round(this.size * scale));
            height = Math.max(1, Math.round(this.size * 0.85));
            shape = GPU_PARTICLE_SHAPES.wings;
            left = cx - wingW;
            top = cy - (height >> 1);
            width = wingW * 2 + 1;
        } else if (this.shape === 'tumble') {
            const upright = motionEnabled && Math.floor(age * this.animRate + this.phase) % 2 === 1;
            left = cx;
            top = cy;
            width = upright ? 1 : 2;
            height = upright ? 2 : 1;
        } else {
            let size = Math.max(1, Math.round(this.size));
            if (this.shape === 'puff') {
                const step = Math.min(3, Math.floor((age / this.maxLife) * 4));
                size = PUFF_STEP_SIZES[step] + (this.size >= 3 ? 1 : 0);
                alpha = PUFF_STEP_ALPHA[step] * this.alpha;
                if (step === 0 && this.baseColor) {
                    // The fire-lit underside is light on the smoke: unlit, no bloom.
                    color = this.baseColor;
                    flags = 0;
                }
            }
            if (size >= 3) shape = GPU_PARTICLE_SHAPES.blob;
            left = cx - (size >> 1);
            top = cy - (size >> 1);
            width = size;
            height = size;
        }
        const rgba = particleColor(color);
        if (!rgba) return false;
        const coverage = Math.max(0, Math.min(1, alpha * rgba[3]));
        if (coverage <= 0) return false;
        const byte = index * GPU_PARTICLE_INSTANCE_BYTES;
        const f = byte >> 2;
        views.f32[f] = left;
        views.f32[f + 1] = top;
        views.f32[f + 2] = width;
        views.f32[f + 3] = height;
        views.u8[byte + 16] = rgba[0];
        views.u8[byte + 17] = rgba[1];
        views.u8[byte + 18] = rgba[2];
        views.u8[byte + 19] = Math.round(coverage * 255);
        views.u8[byte + 20] = shape;
        views.u8[byte + 21] = flags;
        views.u8[byte + 22] = motif;
        views.u8[byte + 23] = 0;
        views.u16[(byte >> 1) + 12] = this.depthKey;
        views.u16[(byte >> 1) + 13] = 0;
        return true;
    }

    // 0.1 — every particle lands on whole art pixels: position, size, wing and
    // halo are rounded to the world texel grid so no sub-pixel square blurs or
    // mixes under the camera zoom. `writeGpuInstance` cuts the same rects.
    draw(ctx, motionEnabled = true) {
        const baseAlpha = (this.life / this.maxLife) * this.alpha;
        const age = this.maxLife - this.life;
        const color = this.color;
        const cx = Math.round(this.x);
        const cy = Math.round(this.y);

        if (EVENT_SHAPES[this.shape]) {
            ctx.globalAlpha = baseAlpha;
            drawEventShape(ctx, this.shape, cx - 8, cy - 8, 1, color);
            ctx.globalAlpha = 1;
            return;
        }

        // C6 — butterfly: two mirrored wing rects flapping about a 1px darker
        // body. Wing x-scale rides |sin| for a 2-frame flutter feel; a fixed
        // mid-flap pose stands in when motion is disabled.
        if (this.shape === 'butterfly') {
            const scale = motionEnabled ? Math.abs(Math.sin(age * this.animRate + this.phase)) : 0.6;
            const wingW = Math.max(1, Math.round(this.size * scale));
            const wingH = Math.max(1, Math.round(this.size * 0.85));
            const top = cy - (wingH >> 1);
            ctx.globalAlpha = baseAlpha;
            ctx.fillStyle = color;
            ctx.fillRect(cx - wingW, top, wingW, wingH);
            ctx.fillRect(cx + 1, top, wingW, wingH);
            ctx.fillStyle = this.bodyColor;
            ctx.fillRect(cx, top, 1, wingH);
            ctx.globalAlpha = 1;
            return;
        }

        // 6.7 — a leaf or petal tumbles: a 2×1 / 1×2 art-pixel pair that
        // alternates every few frames (held flat when motion is off).
        if (this.shape === 'tumble') {
            const upright = motionEnabled && Math.floor(age * this.animRate + this.phase) % 2 === 1;
            ctx.globalAlpha = baseAlpha;
            ctx.fillStyle = color;
            ctx.fillRect(cx, cy, upright ? 1 : 2, upright ? 2 : 1);
            ctx.globalAlpha = 1;
            return;
        }
        // 6.4 — chimney smoke: a round puff in three tones (lit rim upper
        // left, body, shade rim lower right) growing 2 -> 5 art px in radius
        // over its life, thinning in four alpha quanta by height.
        if (this.shape === 'smoke') {
            const radius = smokePuffRadius(age, this.maxLife);
            const fire = radius === SMOKE_PUFF_RADII[0] && this.baseColor;
            drawSmokePuff(ctx, cx, cy, radius, fire ? this.baseColor : color,
                smokePuffAlpha(this.originY - this.y) * this.alpha, { flat: Boolean(fire) });
            return;
        }

        // 6.7 — a smoke puff grows 2 -> 3 -> 4 -> 3 art pixels over its life
        // and thins in four alpha steps instead of a smooth fade; the first
        // step may wear the fire-lit base tone, which is light and so skips
        // the scene grade.
        let size = Math.max(1, Math.round(this.size));
        let fill = color;
        let alpha = baseAlpha;
        if (this.shape === 'puff') {
            const step = Math.min(3, Math.floor((age / this.maxLife) * 4));
            size = PUFF_STEP_SIZES[step] + (this.size >= 3 ? 1 : 0);
            alpha = PUFF_STEP_ALPHA[step] * this.alpha;
            if (step === 0 && this.baseColor) fill = this.baseColor;
        }
        const left = cx - (size >> 1);
        const top = cy - (size >> 1);

        ctx.globalAlpha = alpha;
        ctx.fillStyle = fill;
        if (size >= 3) {
            // A puff, not a tile: the four corner pixels drop out so smoke and
            // dust read as rounded pixel blobs. Three disjoint rects keep the
            // alpha even across the blob.
            ctx.fillRect(left + 1, top, size - 2, size);
            ctx.fillRect(left, top + 1, 1, size - 2);
            ctx.fillRect(left + size - 1, top + 1, 1, size - 2);
        } else {
            ctx.fillRect(left, top, size, size);
        }
        ctx.globalAlpha = 1;
    }
}

const PUFF_STEP_SIZES = Object.freeze([2, 3, 4, 3]);
const PUFF_STEP_ALPHA = Object.freeze([0.9, 0.75, 0.5, 0.25]);

// 6.4 — chimney smoke puffs. Radius steps 2 -> 5 art px over life; alpha
// steps in four quanta by height above the mouth; the column ends at
// SMOKE_COLUMN_PX. Tones: body `#a9aeb8`, lit `#d3d6dc`, shade `#787c86`,
// the rims derived from any body by the same per-channel gains the resident
// particle shader applies (GpuWorldPolicy), so both backends agree.
export const SMOKE_PUFF_RADII = Object.freeze([2, 3, 4, 5]);
export const SMOKE_PUFF_ALPHA = Object.freeze([1, 0.84, 0.66, 0.44]);
export const SMOKE_COLUMN_PX = 60;
const SMOKE_ALPHA_BAND_PX = SMOKE_COLUMN_PX / SMOKE_PUFF_ALPHA.length;

export function smokePuffRadius(age, maxLife) {
    const t = maxLife > 0 ? age / maxLife : 0;
    return SMOKE_PUFF_RADII[Math.max(0, Math.min(SMOKE_PUFF_RADII.length - 1, Math.floor(t * SMOKE_PUFF_RADII.length)))];
}

export function smokePuffAlpha(rise) {
    const band = Math.floor(Math.max(0, rise) / SMOKE_ALPHA_BAND_PX);
    return SMOKE_PUFF_ALPHA[Math.min(SMOKE_PUFF_ALPHA.length - 1, band)];
}

// Disc and rims on the texel grid, in half-texel integers so the shader's
// test is the same arithmetic: tone 0 body, 1 lit, 2 shade, -1 outside.
function smokePuffTone(x, y, radius) {
    const limit = 4 * radius * radius;
    const dx = 2 * x + 1 - 2 * radius;
    const dy = 2 * y + 1 - 2 * radius;
    if (dx * dx + dy * dy > limit) return -1;
    const lx = dx - 2;
    const ly = dy - 2;
    if (lx * lx + ly * ly > limit) return 1;
    // The shade crescent is 2 texels deep (3 from radius 4): the lower-right
    // mass is what separates a puff from light plaza stone behind it.
    const shade = radius >= 4 ? 6 : 4;
    const sx = dx + shade;
    const sy = dy + shade;
    return sx * sx + sy * sy > limit ? 2 : 0;
}

const smokeRunCache = new Map();

// Row runs per tone for one radius: [{ y, x, w, tone }].
function smokePuffRuns(radius) {
    let runs = smokeRunCache.get(radius);
    if (runs) return runs;
    runs = [];
    const size = radius * 2;
    for (let y = 0; y < size; y++) {
        let start = 0;
        let tone = smokePuffTone(0, y, radius);
        for (let x = 1; x <= size; x++) {
            const next = x < size ? smokePuffTone(x, y, radius) : -2;
            if (next === tone) continue;
            if (tone >= 0) runs.push(Object.freeze({ y, x: start, w: x - start, tone }));
            start = x;
            tone = next;
        }
    }
    smokeRunCache.set(radius, runs = Object.freeze(runs));
    return runs;
}

const smokeToneCache = new Map();

function parseColor(value) {
    const text = String(value).trim();
    if (text.startsWith('#') && text.length === 7) {
        const n = Number.parseInt(text.slice(1), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const match = text.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    return match[1].split(',').slice(0, 3).map((part) => Number.parseFloat(part));
}

/** `[body, lit, shade]` CSS colours for a body tone. */
export function smokePuffTones(body) {
    let tones = smokeToneCache.get(body);
    if (tones) return tones;
    const rgb = parseColor(body);
    const tone = (gain) => rgb
        ? `rgb(${rgb.map((c, i) => Math.min(255, Math.round(c * gain[i]))).join(', ')})`
        : body;
    tones = Object.freeze([body, tone(SMOKE_PUFF_LIT_GAIN), tone(SMOKE_PUFF_SHADE_GAIN)]);
    if (smokeToneCache.size > 64) smokeToneCache.clear();
    smokeToneCache.set(body, tones);
    return tones;
}

/**
 * Paints one smoke puff centred on the art-grid point (cx, cy). `flat` paints
 * the whole disc in `body` (the fire-lit underside at the mouth).
 */
export function drawSmokePuff(ctx, cx, cy, radius, body, alpha, { flat = false } = {}) {
    const tones = flat ? [body, body, body] : smokePuffTones(body);
    const left = Math.round(cx) - radius;
    const top = Math.round(cy) - radius;
    ctx.globalAlpha = alpha;
    for (let tone = 0; tone < 3; tone++) {
        ctx.fillStyle = tones[tone];
        for (const run of smokePuffRuns(radius)) {
            if (run.tone === tone) ctx.fillRect(left + run.x, top + run.y, run.w, 1);
        }
    }
    ctx.globalAlpha = 1;
}

const PARTICLE_PRESETS = {
    // Default dirt-path footfall: a low brown dust kick (the fallback when no
    // terrain class is resolved). #42 dispatches one of the three terrain-keyed
    // presets below instead when the tile under the stride is cobble/grass/shallow.
    footstep: {
        colors: ['#6b5b3a', '#7a6a49', '#5a4a2a'],
        size: [1, 2],
        life: [10, 20],
        speed: [0.2, 0.5],
        gravity: false,
        direction: 'down',
    },
    // #42 — cobble/flagstone scuff: a small grit kick with a cool stone-grey
    // cast and the occasional warm spark glint where a boot grinds the stone.
    cobbleScuff: {
        colors: ['#9a948a', '#b5ac9c', '#7d756a', '#ffd98a'],
        size: [1, 2],
        life: [8, 16],
        speed: [0.25, 0.6],
        gravity: false,
        direction: 'up',
    },
    // #42 — grass footfall: faint green-gold pollen motes that lift and drift
    // off the blades rather than kicking dust.
    grassMote: {
        colors: ['#8fbf58', '#b8d890', '#cfe89a'],
        size: [1, 2],
        life: [14, 28],
        speed: [0.1, 0.32],
        gravity: false,
        direction: 'up',
    },
    // #42 — shallow-water splash: pale spray flecks flung up where a stride
    // breaks the surface. Falls back to gravity so the droplets arc and settle.
    shallowSplash: {
        colors: ['#cfe9f7', '#a8d4ee', '#e8f6ff'],
        size: [1, 2],
        life: [8, 16],
        speed: [0.3, 0.7],
        gravity: true,
        direction: 'up',
    },
    mining: {
        shape: 'district-mine',
        colors: ['#ffd700', '#ff922b', '#ffec99'],
        size: [2, 4],
        life: [20, 40],
        speed: [0.5, 1.5],
        gravity: true,
        direction: 'up',
    },
    sparkle: {
        colors: ['#ffffff', '#ffd43b', '#ffec99'],
        size: [1, 3],
        life: [15, 30],
        speed: [0.3, 0.8],
        gravity: false,
        direction: 'random',
    },
    torch: {
        colors: ['#ff4500', '#ff6b00', '#ffd700'],
        size: [2, 4],
        life: [15, 30],
        speed: [0.3, 0.8],
        gravity: false,
        direction: 'up',
    },
    // #18 — active repo-anchorage buoy flame. Smaller, cooler, slower-rising
    // embers than the building torch so the buoy reads as a signal-light, not a
    // bonfire. HarborTraffic draws this flame inline (it has no particle pool),
    // so the palette is exported below as the shared source of truth.
    buoyTorch: {
        colors: ['#ffb04a', '#ff7a2f', '#ffe39a'],
        size: [1.4, 2.6],
        life: [12, 24],
        speed: [0.18, 0.5],
        gravity: false,
        direction: 'up',
    },
    // #33 / 6.4 — chimney smoke: round three-tone puffs (shape 'smoke', radius
    // 2 -> 5 art px) on the soot body tone. Callers pass `windX` (a signed
    // drift velocity) so the column leans downwind, may flatten it in rain,
    // and may warm the body when a forge runs hot. A puff rises about 60 px.
    smoke: {
        colors: ['#a9aeb8'],
        size: [4, 4],
        life: [104, 132],
        speed: [0.46, 0.54],
        lateral: 0.04,
        gravity: false,
        direction: 'up',
        shape: 'smoke',
    },
    // Daytime ambient insects. Longer life + slow wander so they linger and
    // drift like butterflies rather than sparking like fireflies.
    butterfly: {
        // 0.6 — rises from flower tiles anchored ~6 px above the tile centre.
        groundOffset: 8,
        colors: ['#f4a93c', '#f6d35a', '#e8743b', '#7ab8ec', '#f2f2f2'],
        size: [2, 3.4],
        life: [120, 240],
        speed: [0.10, 0.30],
        gravity: false,
        direction: 'random',
        // C6 — draw as flapping wings rather than a square.
        shape: 'butterfly',
    },
    dragonfly: {
        colors: ['#5fd6c4', '#7fe0a8', '#9fe8ff', '#c8f0e0'],
        size: [1.6, 2.8],
        life: [90, 180],
        speed: [0.30, 0.62],
        gravity: false,
        direction: 'random',
    },
    snow: {
        // 0.6 — falls anywhere in view, between the camera and the village.
        openAir: true,
        colors: ['#e8f4ff', '#cce8ff', '#ffffff'],
        size: [1, 2],
        life: [60, 120],
        speed: [0.06, 0.18],
        gravity: false,
        direction: 'down',
    },
    // 6.7 — autumn leaves and spring petals tumble down from canopies as a
    // 2×1 / 1×2 art-pixel pair (shape 'tumble').
    leaf: {
        // 0.6 — falls from a canopy anchor 30 world px above its tree's base:
        // sort just in front of that tree.
        groundOffset: 40,
        colors: ['#c0703a', '#d9a441', '#8a5a2b'],
        size: [1, 1],
        life: [110, 180],
        speed: [0.14, 0.3],
        gravity: false,
        direction: 'down',
        shape: 'tumble',
    },
    petal: {
        groundOffset: 40,
        colors: ['#f2b8c6', '#e89aae'],
        size: [1, 1],
        life: [110, 180],
        speed: [0.12, 0.26],
        gravity: false,
        direction: 'down',
        shape: 'tumble',
    },
    portalRune: {
        shape: 'child-return',
        colors: ['#8feaff', '#76d8ff', '#d7b8ff'],
        size: [1.5, 3],
        life: [22, 44],
        speed: [0.2, 0.6],
        gravity: false,
        direction: 'up',
    },
    forgeEmber: {
        colors: ['#ffb347', '#ff6b2b', '#ffd166'],
        size: [1.4, 3],
        life: [18, 38],
        speed: [0.22, 0.7],
        gravity: false,
        direction: 'up',
    },
    forgeSpark: {
        shape: 'edit-strike',
        colors: ['#fff3a3', '#ffd43b', '#ff7a2f'],
        size: [1, 2.2],
        life: [10, 22],
        speed: [0.6, 1.8],
        gravity: true,
        direction: 'random',
    },
    mineDust: {
        shape: 'district-mine',
        colors: ['#8a7356', '#b79b70', '#d0b07d'],
        size: [1.6, 3.8],
        life: [28, 60],
        speed: [0.08, 0.28],
        gravity: false,
        direction: 'up',
    },
    archiveMote: {
        shape: 'read-page',
        colors: ['#e9d89a', '#b7d890', '#fff1bd'],
        size: [1, 2.2],
        life: [34, 74],
        speed: [0.08, 0.32],
        gravity: false,
        direction: 'random',
    },
    beaconMote: {
        shape: 'incident-bracket',
        colors: ['#fff2a3', '#ffd66f', '#ffffff'],
        size: [1.2, 2.8],
        life: [24, 52],
        speed: [0.12, 0.5],
        gravity: false,
        direction: 'random',
    },
    questPing: {
        shape: 'message-scroll',
        colors: ['#8bd7ff', '#f2d36b', '#ffffff'],
        size: [1.2, 2.6],
        life: [18, 34],
        speed: [0.2, 0.7],
        gravity: false,
        direction: 'up',
    },
    crowdBump: {
        colors: ['#c7b98a', '#9f8f66', '#efe1ad'],
        size: [1, 2.2],
        life: [10, 18],
        speed: [0.16, 0.42],
        gravity: false,
        direction: 'random',
    },
    // #13 — distressed-mood fret mote: a small, faint, slow-sinking worry speck
    // (mood accent `distressed` #ff8a7a). Sinks rather than rises so the cue
    // reads as a sagging fret, not a celebratory spark.
    fretMote: {
        shape: 'incident-bracket',
        colors: ['#ff8a7a', '#e57a6c', '#d9a08f'],
        size: [1, 2],
        life: [22, 40],
        speed: [0.1, 0.28],
        gravity: false,
        direction: 'down',
    },
    rainSplash: {
        colors: ['#cfe9f7', '#a8d4ee', '#e8f6ff'],
        size: [1, 2],
        life: [8, 16],
        speed: [0.25, 0.6],
        gravity: true,
        direction: 'up',
    },
    // #36 — context-pressure strain sweat. A single cool bead that beads off the
    // brow and falls when the context window is nearly full (ratio >= 0.85). Pale
    // blue-white, gravity-fed so it arcs down past the temple. Never spawned under
    // reduced motion — the static arc + chip carry the strain cue in that case.
    sweatDrop: {
        colors: ['#cfe9f7', '#bfe0f2', '#e8f6ff'],
        size: [1, 2],
        life: [16, 30],
        speed: [0.12, 0.32],
        gravity: true,
        direction: 'down',
    },
    // #40 — distress-recovery relief spark. A short warm green-gold burst that
    // rises as an errored agent straightens under the Pharos, signalling the
    // incident has cleared. Brighter and faster than a fret mote so the relief
    // reads as a release of tension, not lingering worry. Reduced motion never
    // spawns it — the agent's static upright posture is the recovery cue.
    distressRelief: {
        shape: 'incident-bracket',
        colors: ['#b8f58a', '#fff1a8', '#86efac', '#fffbe6'],
        size: [1.4, 3],
        life: [16, 34],
        speed: [0.4, 1.1],
        gravity: false,
        direction: 'up',
    },
};

// 0.6 — every world particle sorts by its painter depth on both backends:
// Canvas paints it as a small depth drawable (DrawablePass), the resident
// WebGL path draws all of them in one instanced call against the painter
// depth buffer. `spawn(type, x, y, { sortY })`: an emitter at hand or roof
// height passes its owner's sortY (a body's painter sortY, a building half's
// sortY + 1); otherwise the particle sorts at `y + preset.groundOffset` (its
// ground line), or in front of everything for open-air drift.

// Presets that are matter, not light: they take the scene's C2 grade. Every
// other preset is emissive and keeps its colour (and feeds bloom on WebGL).
export const LIT_PARTICLE_PRESETS = Object.freeze([
    'smoke',
    'mineDust',
    'footstep',
    'cobbleScuff',
    'crowdBump',
    'leaf',
    'petal',
    'snow',
    'butterfly',
]);

const LIT_PRESET_SET = new Set(LIT_PARTICLE_PRESETS);

// The painter sortY a spawn sorts at: the caller's explicit owner sortY, the
// open-air front, or the spawn point's ground line.
export function particleSortY(type, y, sortY = null) {
    const explicit = sortY == null ? Number.NaN : Number(sortY);
    if (!Number.isNaN(explicit)) return explicit;
    const preset = PARTICLE_PRESETS[type];
    if (preset?.openAir) return PARTICLE_SORT_Y_OPEN_AIR;
    return Number(y) + (Number(preset?.groundOffset) || 0);
}

// #18 — exported so HarborTraffic's inline buoy flame stays colour-matched to
// the shared `buoyTorch` preset without owning a particle pool.
export const BUOY_TORCH_COLORS = Object.freeze([...PARTICLE_PRESETS.buoyTorch.colors]);

// #33 — cool baseline soot and a warm forge-heat ramp. ChimneySmoke blends
// toward the warm tints as the forge hearth heats, so a hot hearth pushes
// browner, ember-lit smoke while a banked forge stays grey.
export const SMOKE_COOL_COLORS = Object.freeze([...PARTICLE_PRESETS.smoke.colors]);
export const SMOKE_WARM_COLORS = Object.freeze(['#a8836c']);

function rand(min, max) {
    return min + Math.random() * (max - min);
}

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function normalizeRange(value, fallback) {
    if (Array.isArray(value) && value.length >= 2) {
        const a = Number(value[0]);
        const b = Number(value[1]);
        if (Number.isFinite(a) && Number.isFinite(b)) return [Math.min(a, b), Math.max(a, b)];
    }
    const single = Number(value);
    if (Number.isFinite(single)) return [single, single];
    return fallback;
}

function seededRandom(seed, index) {
    let x = (Number(seed) || 0) + Math.imul(index + 1, 0x9e3779b1);
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d);
    x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b);
    x ^= x >>> 16;
    return (x >>> 0) / 0xffffffff;
}

function randFrom(rng, min, max) {
    return min + rng() * (max - min);
}

// AW-P8a — dragonflies over the lily pads on summer days, on their own small
// pool: never in `particles`, so they never count against MAX_PARTICLES or
// evict a semantic particle. WildlifeRenderer owns them (it spawns to its
// budget, sheds them under pressure and draws them in the fauna layer, on
// both backends). The look is the `dragonfly` preset's colours and sizes; the
// life is its own: a dragonfly holds still over the water, darts a short hop
// to another hover point near its home, holds again, and leaves after 30–60 s,
// fading in and out over DRAGONFLY_FADE frames. Wings are drawn open, never
// flickered. With motion off a dragonfly holds its pose: no hop, no fade, no
// ageing.
export const DRAGONFLY_POOL_MAX = 4;
const DRAGONFLY_LIFE = Object.freeze([1800, 3600]);
const DRAGONFLY_HOVER = Object.freeze([110, 260]);
const DRAGONFLY_FADE = 45;
const DRAGONFLY_DART_SPEED = 3;
const DRAGONFLY_WING = '#e6f6f4';
const DRAGONFLY_HEAD = 'rgba(12, 40, 44, 0.6)';
const DRAGONFLY_SHADOW = 'rgba(7, 18, 30, 0.18)';

class Dragonfly {
    constructor(x, y, { color, size, altitude, rangeX, rangeY, seed }) {
        this._seed = Number.isFinite(Number(seed)) ? Number(seed) : Math.floor(Math.random() * 0x7fffffff);
        this._draw = 0;
        const preset = PARTICLE_PRESETS.dragonfly;
        this.homeX = x;
        this.homeY = y;
        this.rangeX = rangeX;
        this.rangeY = rangeY;
        this.x = x;
        this.y = y;
        this.fromX = x;
        this.fromY = y;
        this.toX = x;
        this.toY = y;
        this.color = color || preset.colors[Math.floor(this._rand() * preset.colors.length)];
        const bodySize = Number.isFinite(size) ? size : randFrom(() => this._rand(), preset.size[0], preset.size[1]);
        this.length = Math.max(3, Math.round(bodySize) + 2);
        this.speed = randFrom(() => this._rand(), preset.speed[0], preset.speed[1]) * DRAGONFLY_DART_SPEED;
        this.altitude = Number.isFinite(altitude) ? altitude : 5 + Math.floor(this._rand() * 4);
        this.maxLife = Math.floor(randFrom(() => this._rand(), DRAGONFLY_LIFE[0], DRAGONFLY_LIFE[1]));
        this.life = this.maxLife;
        this.age = 0;
        this.facing = this._rand() < 0.5 ? -1 : 1;
        this.dart = 0;
        this.dartFrames = 0;
        this.hover = randFrom(() => this._rand(), DRAGONFLY_HOVER[0], DRAGONFLY_HOVER[1]);
    }

    _rand() {
        return seededRandom(this._seed, this._draw++);
    }

    get alive() {
        return this.life > 0;
    }

    get leaving() {
        return this.life <= DRAGONFLY_FADE;
    }

    // Start the fade-out now (or keep the one already running).
    release() {
        this.life = Math.min(this.life, DRAGONFLY_FADE);
    }

    update(frameScale) {
        this.age += frameScale;
        this.life -= frameScale;
        if (this.dartFrames > 0) {
            this.dart = Math.min(this.dartFrames, this.dart + frameScale);
            const t = this.dart / this.dartFrames;
            const ease = 1 - (1 - t) * (1 - t) * (1 - t);
            this.x = this.fromX + (this.toX - this.fromX) * ease;
            this.y = this.fromY + (this.toY - this.fromY) * ease;
            if (this.dart >= this.dartFrames) {
                this.dartFrames = 0;
                this.hover = randFrom(() => this._rand(), DRAGONFLY_HOVER[0], DRAGONFLY_HOVER[1]);
            }
            return;
        }
        this.hover -= frameScale;
        if (this.hover > 0 || this.leaving) return;
        // A hop to another hover point inside the home ellipse.
        const angle = this._rand() * Math.PI * 2;
        const reach = 0.35 + this._rand() * 0.65;
        this.fromX = this.x;
        this.fromY = this.y;
        this.toX = this.homeX + Math.cos(angle) * this.rangeX * reach;
        this.toY = this.homeY + Math.sin(angle) * this.rangeY * reach;
        const dx = this.toX - this.fromX;
        if (Math.abs(dx) >= 1) this.facing = dx < 0 ? -1 : 1;
        this.dart = 0;
        this.dartFrames = Math.max(8, Math.hypot(dx, this.toY - this.fromY) / Math.max(0.1, this.speed));
    }

    alphaFor(motionEnabled) {
        if (!motionEnabled) return 1;
        return Math.max(0, Math.min(1, this.age / DRAGONFLY_FADE, this.life / DRAGONFLY_FADE));
    }

    // On the art grid: a faint shadow on the water, then a 3–5 px body with
    // the head at the leading end (shaded so it reads which way it faces)
    // and one pale wing pixel pair above and below, just behind the head.
    // `color` is the caller's graded body.
    draw(ctx, motionEnabled = true, color = this.color) {
        const alpha = this.alphaFor(motionEnabled);
        if (alpha <= 0) return false;
        const cx = Math.round(this.x);
        const cy = Math.round(this.y);
        const top = cy - this.altitude;
        const tail = this.facing > 0 ? cx - this.length + 1 : cx;
        const wingX = this.facing > 0 ? cx - 2 : cx + 1;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = DRAGONFLY_SHADOW;
        ctx.fillRect(tail + 1, cy, this.length - 2, 1);
        ctx.fillStyle = color;
        ctx.fillRect(tail, top, this.length, 1);
        ctx.fillStyle = DRAGONFLY_HEAD;
        ctx.fillRect(cx, top, 1, 1);
        ctx.globalAlpha = alpha * 0.75;
        ctx.fillStyle = DRAGONFLY_WING;
        ctx.fillRect(wingX, top - 1, 2, 1);
        ctx.fillRect(wingX, top + 1, 2, 1);
        ctx.globalAlpha = 1;
        return true;
    }
}

export class ParticleSystem {
    constructor({ maxParticles = MAX_PARTICLES } = {}) {
        this.particles = [];
        this.maxParticles = maxParticles;
        this.motionEnabled = true;
        // AW-P8a — the dragonfly sub-pool (see Dragonfly); outside `particles`.
        this.dragonflies = [];
    }

    // Dragonflies are not cleared with motion off: they hold their pose.
    setMotionEnabled(enabled) {
        this.motionEnabled = enabled;
        if (!enabled) {
            this.clear();
        }
    }

    spawn(type, x, y, count = 3, options = {}) {
        if (count && typeof count === 'object') {
            options = count;
            count = options.count ?? 3;
        }
        const preset = PARTICLE_PRESETS[type];
        if (!preset || !this.motionEnabled) return;

        const pressureLevel = Number.isFinite(Number(options.pressureLevel))
            ? Number(options.pressureLevel)
            : sampleFramePressure().level;
        const calm = Object.prototype.hasOwnProperty.call(options, 'calm')
            ? Boolean(options.calm)
            : resolveCalmGate();
        if (!particleSpawnAllowed(type, {
            level: pressureLevel,
            calm,
            motionEnabled: this.motionEnabled,
        })) return;

        const semanticTier = options.semanticTier || (particleRole(type) === 'semantic' ? MarkTier.SECONDARY : MarkTier.AMBIENT);
        const gate = getActiveMarkGovernor()?.admit(semanticTier, x, y);
        if (gate && !gate.draw) return;
        if (gate && semanticTier === MarkTier.AMBIENT) count = Math.ceil(count * gate.alpha);

        const spawnCount = Math.min(Math.max(0, Math.floor(count)), this.maxParticles);
        if (spawnCount === 0) return;

        const overflow = this.particles.length + spawnCount - this.maxParticles;
        if (overflow > 0) {
            this.particles.splice(0, overflow);
        }

        const colors = Array.isArray(options.colors) && options.colors.length ? options.colors : preset.colors;
        const sizeRange = normalizeRange(options.size, preset.size);
        const lifeRange = normalizeRange(options.life, preset.life);
        const speedRange = normalizeRange(options.speed, preset.speed);
        const alphaRange = normalizeRange(options.alpha, [1, 1]);
        const spreadRange = normalizeRange(options.spread, [3, 3]);
        const gravity = options.gravity ?? preset.gravity;
        const direction = options.direction || preset.direction;
        // 6.7 — sideways jitter for up/down presets (a chimney column wants
        // almost none; the legacy default is ±0.3).
        const lateral = Number.isFinite(preset.lateral) ? preset.lateral : 0.3;
        // 0.6 — the painter depth the whole burst sorts at (its emitter's).
        const sortY = particleSortY(type, y, options.sortY);
        const lit = LIT_PRESET_SET.has(type);
        // C6 / 6.7 — drawn-shape hints carried from the preset (butterfly
        // wings, tumbling leaves, smoke puffs).
        const shape = options.shape || preset.shape || null;
        const seed = options.seed;
        const tag = options.tag || null;
        const baseColor = typeof options.baseColor === 'string' ? options.baseColor : null;
        // `gradedColors[i]` is the emitter's own graded tone of `colors[i]`.
        const gradedColors = Array.isArray(options.gradedColors) && options.gradedColors.length === colors.length
            ? options.gradedColors
            : null;
        // #33 — signed horizontal drift (world units / 16ms) added to every
        // particle's vx so a rising smoke column leans downwind. Defaults to 0
        // so existing callers are unaffected.
        const windDrift = Number.isFinite(Number(options.windX)) ? Number(options.windX) : 0;
        // #34 — signed vertical drift paired with `windX`, letting a caller bias
        // particles toward an arbitrary point (token-flow motes drifting from a
        // working agent toward its bound building). Defaults to 0.
        const driftY = Number.isFinite(Number(options.driftY)) ? Number(options.driftY) : 0;

        for (let i = 0; i < spawnCount; i++) {
            let seedIndex = i * 11;
            const rng = Number.isFinite(Number(seed))
                ? () => seededRandom(seed, seedIndex++)
                : Math.random;
            const size = randFrom(rng, sizeRange[0], sizeRange[1]);
            const life = Math.floor(randFrom(rng, lifeRange[0], lifeRange[1]));
            const speed = randFrom(rng, speedRange[0], speedRange[1]);
            const colorIndex = Math.min(colors.length - 1, Math.floor(rng() * colors.length));
            const color = colors[colorIndex];
            const alpha = randFrom(rng, alphaRange[0], alphaRange[1]);
            const spread = randFrom(rng, spreadRange[0], spreadRange[1]);

            let vx = 0;
            let vy = 0;

            switch (direction) {
                case 'up':
                    vx = randFrom(rng, -lateral, lateral);
                    vy = -speed;
                    break;
                case 'down':
                    vx = randFrom(rng, -lateral, lateral);
                    vy = speed * 0.3;
                    break;
                case 'random':
                    const angle = rng() * Math.PI * 2;
                    vx = Math.cos(angle) * speed;
                    vy = Math.sin(angle) * speed;
                    break;
            }

            vx += windDrift;
            vy += driftY;

            // Drawn shapes get a deterministic flap/tumble phase seeded from
            // the spawn rng so animation never calls Math.random in draw.
            const opts = { lit, tag, baseColor, sortY, originY: y, gradedColor: gradedColors ? gradedColors[colorIndex] : null };
            if (shape === 'butterfly' || shape === 'tumble' || shape === 'puff' || shape === 'smoke') {
                opts.shape = shape;
                opts.phase = rng() * Math.PI * 2;
                opts.animRate = (shape === 'butterfly' ? 0.35 : 0.12) * (0.85 + 0.3 * rng());
            }

            this.particles.push(new Particle(
                x + randFrom(rng, -spread, spread),
                y + randFrom(rng, -spread, spread),
                vx,
                vy,
                life,
                color,
                size,
                gravity,
                alpha,
                opts,
            ));
        }
    }

    update(dt = 16) {
        let next = 0;
        for (let i = 0; i < this.particles.length; i++) {
            const particle = this.particles[i];
            particle.update(dt);
            if (particle.alive) {
                this.particles[next++] = particle;
            }
        }
        this.particles.length = next;
        if (this.motionEnabled && this.dragonflies.length) {
            const frameScale = Math.max(0, Math.min(3, dt / 16));
            next = 0;
            for (let i = 0; i < this.dragonflies.length; i++) {
                const dragonfly = this.dragonflies[i];
                dragonfly.update(frameScale);
                if (dragonfly.alive) this.dragonflies[next++] = dragonfly;
            }
            this.dragonflies.length = next;
        }
    }

    /**
     * AW-P8a — one dragonfly hovering about world point (x, y) (its water
     * surface point), hopping within `rangeX` × `rangeY` px of it. Returns
     * the dragonfly, or null once DRAGONFLY_POOL_MAX are alive. The caller
     * owns the gate (WildlifeRenderer's `dragonflyBudget`); with motion off
     * the dragonfly is placed and held still.
     */
    spawnDragonfly(x, y, { rangeX = 16, rangeY = 8, seed, color, size, altitude } = {}) {
        if (this.dragonflies.length >= DRAGONFLY_POOL_MAX) return null;
        const dragonfly = new Dragonfly(x, y, { color, size, altitude, rangeX, rangeY, seed });
        this.dragonflies.push(dragonfly);
        return dragonfly;
    }

    // Shed the dragonflies: each fades out over DRAGONFLY_FADE frames, or
    // goes at once while motion is off (a held frame has no fade to play).
    releaseDragonflies(count = Infinity) {
        let released = 0;
        for (let i = this.dragonflies.length - 1; i >= 0 && released < count; i--) {
            const dragonfly = this.dragonflies[i];
            if (dragonfly.leaving) continue;
            dragonfly.release();
            released++;
        }
        if (!this.motionEnabled) this.dragonflies = this.dragonflies.filter(dragonfly => !dragonfly.leaving);
        return released;
    }

    // 0.6 — the resident GPU particle instances (GpuWorldPolicy layout) in
    // Canvas painter order: by depth key, then spawn order, so overlapping
    // particles blend as the depth-sorted Canvas pass paints them. Returns
    // the instance count (at most `views.capacity`).
    packGpuInstances(views) {
        const particles = this.particles;
        const order = this._gpuOrder || (this._gpuOrder = []);
        order.length = particles.length;
        for (let index = 0; index < particles.length; index++) order[index] = index;
        order.sort(this._compareGpuOrder || (this._compareGpuOrder = (a, b) => (
            (this.particles[a].depthKey - this.particles[b].depthKey) || (a - b)
        )));
        let count = 0;
        for (let index = 0; index < order.length && count < views.capacity; index++) {
            if (particles[order[index]].writeGpuInstance(views, count, this.motionEnabled)) count++;
        }
        return count;
    }

    // 6.7 — live particles an emitter spawned under `tag` (visible caps).
    countTagged(tag) {
        let count = 0;
        for (const p of this.particles) if (p.tag === tag) count++;
        return count;
    }

    clear() {
        this.particles = [];
    }
}
