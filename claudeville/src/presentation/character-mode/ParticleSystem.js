import { drawEventShape, EVENT_SHAPES } from '../shared/EventShapes.js';
import {
    getActiveMarkGovernor,
    MarkTier,
    ornamentPlan,
    resolveCalmGate,
    sampleFramePressure,
} from './MarkGovernor.js';

const PARTICLE_GRAVITY = 0.05;
const MAX_PARTICLES = 240;

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
    constructor(x, y, vx, vy, life, color, size, gravity, alpha = 1, layer = 'effects', opts = {}) {
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
        this.layer = layer;
        // C6 — shaped-insect draw hints. `shape` keys the draw branch;
        // `phase`/`animRate` give each insect a deterministic, per-particle wing
        // flap cycle seeded once at spawn (never in draw).
        this.shape = opts.shape || null;
        this.phase = opts.phase || 0;
        this.animRate = opts.animRate || 0;
        this.bodyColor = this.shape === 'butterfly' ? darkenHex(color) : null;
        // 0.1 — non-emissive presets (smoke, dust) take the scene's light when
        // replayed on an ungraded layer; emissive ones keep their colour.
        this.lit = !!opts.lit;
        // 6.7 — `tag` lets an emitter count its own live particles (seasonal
        // drift caps); `baseColor` is an emissive tone a smoke puff wears only
        // on its first step (a fire-lit underside at the chimney mouth).
        this.tag = opts.tag || null;
        this.baseColor = opts.baseColor || null;
        // A lit particle whose emitter already graded it for the ungraded
        // overlay (night chimney smoke: moonlit soot held above the dark)
        // wears this instead of the generic lit re-tint.
        this.overlayColor = opts.overlayColor || null;
    }

    update(dt = 16) {
        const frameScale = Math.max(0, Math.min(3, dt / 16));
        this.x += this.vx * frameScale;
        this.y += this.vy * frameScale;
        if (this.gravity) {
            this.vy += PARTICLE_GRAVITY * frameScale;
        }
        this.life -= frameScale;
    }

    get alive() {
        return this.life > 0;
    }

    // 0.1 — every particle lands on whole art pixels: position, size, wing and
    // halo are rounded to the world texel grid so no sub-pixel square blurs or
    // mixes under the camera zoom. `litColor` (optional) re-tints lit presets.
    draw(ctx, motionEnabled = true, litColor = null) {
        const baseAlpha = (this.life / this.maxLife) * this.alpha;
        const age = this.maxLife - this.life;
        const color = litColor && this.lit ? (this.overlayColor || litColor(this.color)) : this.color;
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
    // #33 / 6.7 — chimney smoke: pixel puffs (shape 'puff' steps 2->3->4->3
    // art px) on a cool soot ramp. Callers pass `windX` (a signed drift
    // velocity) so the column leans downwind, may shorten `life` in rain, and
    // may override `colors` with warmer soot tints when a forge runs hot.
    smoke: {
        colors: ['#6b6f78', '#8d919a', '#b3b5ba'],
        size: [2, 3.6],
        life: [90, 140],
        speed: [0.22, 0.36],
        lateral: 0.05,
        gravity: false,
        direction: 'up',
        shape: 'puff',
    },
    // Daytime ambient insects. Longer life + slow wander so they linger and
    // drift like butterflies rather than sparking like fireflies.
    butterfly: {
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
        colors: ['#c0703a', '#d9a441', '#8a5a2b'],
        size: [1, 1],
        life: [110, 180],
        speed: [0.14, 0.3],
        gravity: false,
        direction: 'down',
        shape: 'tumble',
    },
    petal: {
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
    // #35 — ship wake foam. Short-lived white spray flecks flung outward when a
    // force-pushed hull lists and sinks; the burst widens with the foam ring so
    // hull class stays viscerally readable. The renderer owns the widening ring
    // procedurally; this preset is the shared white-foam palette for the fleck
    // burst so the colours stay matched. Never spawned under reduced motion.
    wakeFoam: {
        colors: ['#ffffff', '#e8fcff', '#cdeef0', '#bfe6e8'],
        size: [1, 2.6],
        life: [10, 22],
        speed: [0.4, 1.4],
        gravity: false,
        direction: 'random',
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

// 0.1 — particle layers. `effects` particles live in the world's depth stream:
// the Canvas renderer draws them in the frame; the resident WebGL path defers
// them (not drawn) until GPU particle records exist, because they sit at foot
// or hand height where the ungraded, unsorted overlay would paint them over
// building fronts and bodies. `air` particles rise above roofs or hang in open
// air, so the resident path replays them on the overlay. `screen` particles are
// drawn in screen space on the overlay by both renderers.
export const PARTICLE_LAYER_EFFECTS = 'effects';
export const PARTICLE_LAYER_AIR = 'air';
export const PARTICLE_LAYER_SCREEN = 'screen';

// The admitted open-air set: presets whose every emitter sits at a chimney,
// torch, hearth mouth or in open air. Presets shared with foot/hand-height
// sources (footfalls, rain splashes, token motes) stay `effects`; an emitter
// that is itself open-air (a roof glint, a lantern crown) may opt a spawn in
// with `{ layer: PARTICLE_LAYER_AIR }`. Seasonal drift (leaves, petals, snow,
// butterflies) hangs in open air above the lawns.
export const AIR_PARTICLE_PRESETS = Object.freeze([
    'smoke',
    'torch',
    'buoyTorch',
    'forgeEmber',
    'leaf',
    'petal',
    'snow',
    'butterfly',
]);

// Presets that are matter, not light: they take the scene's light when
// replayed on the ungraded overlay. Everything else is emissive.
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

const AIR_PRESET_SET = new Set(AIR_PARTICLE_PRESETS);
const LIT_PRESET_SET = new Set(LIT_PARTICLE_PRESETS);

export function particleLayerFor(type, requested = null) {
    if (requested) return String(requested);
    return AIR_PRESET_SET.has(type) ? PARTICLE_LAYER_AIR : PARTICLE_LAYER_EFFECTS;
}

// #18 — exported so HarborTraffic's inline buoy flame stays colour-matched to
// the shared `buoyTorch` preset without owning a particle pool.
export const BUOY_TORCH_COLORS = Object.freeze([...PARTICLE_PRESETS.buoyTorch.colors]);

// #33 — cool baseline soot and a warm forge-heat ramp. ChimneySmoke blends
// toward the warm tints as the forge hearth heats, so a hot hearth pushes
// browner, ember-lit smoke while a banked forge stays grey.
export const SMOKE_COOL_COLORS = Object.freeze([...PARTICLE_PRESETS.smoke.colors]);
export const SMOKE_WARM_COLORS = Object.freeze(['#6b5240', '#8a6a4c', '#a8806b']);

// #35 — exported so the wake renderer's sink-ring foam burst stays colour-matched
// to the shared `wakeFoam` preset.
export const WAKE_FOAM_COLORS = Object.freeze([...PARTICLE_PRESETS.wakeFoam.colors]);

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

export class ParticleSystem {
    constructor({ maxParticles = MAX_PARTICLES } = {}) {
        this.particles = [];
        this.maxParticles = maxParticles;
        this.motionEnabled = true;
    }

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
        const layer = particleLayerFor(type, options.layer);
        const lit = LIT_PRESET_SET.has(type);
        // C6 / 6.7 — drawn-shape hints carried from the preset (butterfly
        // wings, tumbling leaves, smoke puffs).
        const shape = options.shape || preset.shape || null;
        const seed = options.seed;
        const tag = options.tag || null;
        const baseColor = typeof options.baseColor === 'string' ? options.baseColor : null;
        // `overlayColors[i]` is the pre-graded overlay tone of `colors[i]`.
        const overlayColors = Array.isArray(options.overlayColors) && options.overlayColors.length === colors.length
            ? options.overlayColors
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
            const opts = { lit, tag, baseColor, overlayColor: overlayColors ? overlayColors[colorIndex] : null };
            if (shape === 'butterfly' || shape === 'tumble' || shape === 'puff') {
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
                layer,
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
    }

    // `litColor` (optional) maps a lit particle's authored hex to the colour
    // it should take on an ungraded layer; emissive particles ignore it.
    draw(ctx, { layer = null, excludeLayer = null, litColor = null } = {}) {
        if (this.particles.length === 0) return;
        const wantedLayer = layer == null ? null : String(layer);
        const excludedLayer = excludeLayer == null ? null : String(excludeLayer);
        for (const p of this.particles) {
            const particleLayer = p.layer || PARTICLE_LAYER_EFFECTS;
            if (wantedLayer && particleLayer !== wantedLayer) continue;
            if (excludedLayer && particleLayer === excludedLayer) continue;
            p.draw(ctx, this.motionEnabled, litColor);
        }
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
