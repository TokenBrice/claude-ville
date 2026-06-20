const PARTICLE_GRAVITY = 0.05;
const MAX_PARTICLES = 240;

class Particle {
    constructor(x, y, vx, vy, life, color, size, gravity, alpha = 1, layer = 'effects') {
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

    draw(ctx) {
        const alpha = this.life / this.maxLife;
        ctx.globalAlpha = alpha * this.alpha;
        ctx.fillStyle = this.color;
        ctx.fillRect(this.x - this.size / 2, this.y - this.size / 2, this.size, this.size);
        ctx.globalAlpha = 1;
    }
}

const PARTICLE_PRESETS = {
    footstep: {
        colors: ['#6b5b3a', '#7a6a49', '#5a4a2a'],
        size: [1, 2],
        life: [10, 20],
        speed: [0.2, 0.5],
        gravity: false,
        direction: 'down',
    },
    mining: {
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
    // #33 — volumetric chimney/forge smoke. A taller, longer-lived column than
    // the legacy puff so density reads as heat. Callers pass `windX` (a signed
    // drift velocity) so the column leans downwind, and may override `colors`
    // with warmer soot tints when the forge runs hot. `warmColors` is the
    // forge-heat ramp, exported below for BuildingSprite's heat scaling.
    smoke: {
        colors: ['#555555', '#777777', '#999999'],
        size: [3, 6.5],
        life: [50, 100],
        speed: [0.12, 0.34],
        gravity: false,
        direction: 'up',
    },
    firefly: {
        colors: ['#fff1a8', '#f6da82', '#b8f58a'],
        size: [1, 2.4],
        life: [34, 72],
        speed: [0.08, 0.28],
        gravity: false,
        direction: 'random',
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
    leaf: {
        colors: ['#8fbf58', '#b8914b', '#6f8f3e'],
        size: [1.4, 3],
        life: [30, 58],
        speed: [0.18, 0.45],
        gravity: false,
        direction: 'down',
    },
    portalRune: {
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
        colors: ['#fff3a3', '#ffd43b', '#ff7a2f'],
        size: [1, 2.2],
        life: [10, 22],
        speed: [0.6, 1.8],
        gravity: true,
        direction: 'random',
    },
    mineDust: {
        colors: ['#8a7356', '#b79b70', '#d0b07d'],
        size: [1.6, 3.8],
        life: [28, 60],
        speed: [0.08, 0.28],
        gravity: false,
        direction: 'up',
    },
    archiveMote: {
        colors: ['#e9d89a', '#b7d890', '#fff1bd'],
        size: [1, 2.2],
        life: [34, 74],
        speed: [0.08, 0.32],
        gravity: false,
        direction: 'random',
    },
    beaconMote: {
        colors: ['#fff2a3', '#ffd66f', '#ffffff'],
        size: [1.2, 2.8],
        life: [24, 52],
        speed: [0.12, 0.5],
        gravity: false,
        direction: 'random',
    },
    questPing: {
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
    // #40 — distress-recovery relief spark. A short warm green-gold burst that
    // rises as an errored agent straightens under the Pharos, signalling the
    // incident has cleared. Brighter and faster than a fret mote so the relief
    // reads as a release of tension, not lingering worry. Reduced motion never
    // spawns it — the agent's static upright posture is the recovery cue.
    distressRelief: {
        colors: ['#b8f58a', '#fff1a8', '#86efac', '#fffbe6'],
        size: [1.4, 3],
        life: [16, 34],
        speed: [0.4, 1.1],
        gravity: false,
        direction: 'up',
    },
};

// #18 — exported so HarborTraffic's inline buoy flame stays colour-matched to
// the shared `buoyTorch` preset without owning a particle pool.
export const BUOY_TORCH_COLORS = Object.freeze([...PARTICLE_PRESETS.buoyTorch.colors]);

// #33 — cool baseline soot and a warm forge-heat ramp. BuildingSprite blends
// toward the warm tints as `_forgeGlow` rises so a hot hearth pushes browner,
// ember-lit smoke while a banked forge stays grey.
export const SMOKE_COOL_COLORS = Object.freeze([...PARTICLE_PRESETS.smoke.colors]);
export const SMOKE_WARM_COLORS = Object.freeze(['#6b5240', '#8a6a4c', '#a8806b']);

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

function pickFrom(rng, arr) {
    return arr[Math.floor(rng() * arr.length)] || arr[0];
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
        const layer = options.layer || preset.layer || 'effects';
        const seed = options.seed;
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
            const color = pickFrom(rng, colors);
            const alpha = randFrom(rng, alphaRange[0], alphaRange[1]);
            const spread = randFrom(rng, spreadRange[0], spreadRange[1]);

            let vx = 0;
            let vy = 0;

            switch (direction) {
                case 'up':
                    vx = randFrom(rng, -0.3, 0.3);
                    vy = -speed;
                    break;
                case 'down':
                    vx = randFrom(rng, -0.3, 0.3);
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

    draw(ctx, { layer = null, excludeLayer = null } = {}) {
        if (this.particles.length === 0) return;
        const wantedLayer = layer == null ? null : String(layer);
        const excludedLayer = excludeLayer == null ? null : String(excludeLayer);
        for (const p of this.particles) {
            const particleLayer = p.layer || 'effects';
            if (wantedLayer && particleLayer !== wantedLayer) continue;
            if (excludedLayer && particleLayer === excludedLayer) continue;
            p.draw(ctx);
        }
    }

    clear() {
        this.particles = [];
    }
}
