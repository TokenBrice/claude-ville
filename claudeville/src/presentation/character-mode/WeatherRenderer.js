// claudeville/src/presentation/character-mode/WeatherRenderer.js
//
// Screen-space foreground weather. Intended to run after world sprites and
// particles, before labels and status badges, with the canvas transform reset.

const CLEAR_TYPES = new Set(['clear', 'partly-cloudy']);
const RAIN_TYPES = new Set(['rain', 'storm']);

const LOOP_MS = 60000;
const MAX_FRAME_DT = 80;
const RAIN_AREA_DENSITY = 3200;
const RAIN_MAX_STREAKS = 420;
const RAIN_MIN_STREAKS = 24;
const FOG_MAX_BANDS = 9;
const FOG_MIN_BANDS = 3;

const DEFAULT_INTENSITY = {
    overcast: 0.38,
    rain: 0.64,
    fog: 0.58,
    storm: 0.82,
};

export class WeatherRenderer {
    constructor() {
        this.elapsedMs = 0;
    }

    drawForeground(ctx, { canvas = ctx?.canvas, atmosphere = null, dt = 16 } = {}) {
        if (!ctx || !canvas || !canvas.width || !canvas.height) return;

        const weather = normalizeWeather(atmosphere);
        if (!weather || CLEAR_TYPES.has(weather.type) || weather.intensity <= 0) return;

        const particleEnabled = atmosphere?.motion?.particleEnabled !== false;
        if (particleEnabled) {
            const frameDt = Math.max(0, Math.min(MAX_FRAME_DT, Number(dt) || 0));
            this.elapsedMs = (this.elapsedMs + frameDt) % LOOP_MS;
        }

        const seed = seedFromAtmosphere(atmosphere, weather);
        const phaseMs = particleEnabled
            ? this.elapsedMs
            : Math.floor(random01(seed, 401) * LOOP_MS);

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';

        if (weather.type === 'overcast') {
            this._drawOvercast(ctx, canvas, weather.intensity);
            this._drawFogBands(ctx, canvas, weather.intensity * 0.34, phaseMs, seed, particleEnabled);
        } else if (weather.type === 'fog') {
            this._drawFogWash(ctx, canvas, weather.intensity);
            this._drawFogBands(ctx, canvas, weather.intensity, phaseMs, seed, particleEnabled);
        } else if (RAIN_TYPES.has(weather.type)) {
            const storm = weather.type === 'storm';
            this._drawOvercast(ctx, canvas, Math.min(1, weather.intensity * (storm ? 0.62 : 0.48)));
            this._drawRain(ctx, canvas, weather, phaseMs, seed, particleEnabled);
            if (storm && particleEnabled) {
                this._drawStormFlash(ctx, canvas, weather.intensity, seed);
            }
        }

        ctx.restore();
    }

    draw(ctx, options = {}) {
        this.drawForeground(ctx, options);
    }

    dispose() {
        this.elapsedMs = 0;
    }

    _drawOvercast(ctx, canvas, intensity) {
        const alpha = clamp(intensity, 0, 1) * 0.14;
        if (alpha <= 0.005) return;

        const wash = ctx.createLinearGradient(0, 0, 0, canvas.height);
        wash.addColorStop(0, `rgba(65, 78, 88, ${alpha * 0.70})`);
        wash.addColorStop(0.45, `rgba(54, 66, 72, ${alpha * 0.42})`);
        wash.addColorStop(1, `rgba(35, 40, 44, ${alpha})`);
        ctx.fillStyle = wash;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    _drawFogWash(ctx, canvas, intensity) {
        const alpha = clamp(intensity, 0, 1) * 0.12;
        if (alpha <= 0.005) return;

        const wash = ctx.createLinearGradient(0, 0, 0, canvas.height);
        wash.addColorStop(0, 'rgba(210, 225, 224, 0)');
        wash.addColorStop(0.36, `rgba(202, 218, 216, ${alpha * 0.28})`);
        wash.addColorStop(1, `rgba(213, 225, 220, ${alpha})`);
        ctx.fillStyle = wash;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    _drawRain(ctx, canvas, weather, phaseMs, seed, particleEnabled) {
        const intensity = clamp(weather.intensity, 0, 1);
        const area = canvas.width * canvas.height;
        const density = weather.type === 'storm' ? 1.28 : 1;
        const animatedScale = particleEnabled ? 1 : 0.42;
        const count = Math.min(
            RAIN_MAX_STREAKS,
            Math.max(
                RAIN_MIN_STREAKS,
                Math.floor((area / RAIN_AREA_DENSITY) * (0.35 + intensity * 0.95) * density * animatedScale),
            ),
        );

        const windValue = Number(weather.windX);
        const windX = clamp(Number.isFinite(windValue) ? windValue : -0.46, -1.4, 1.4);
        const pad = 48;
        const travel = canvas.height + pad * 2;
        const speed = particleEnabled ? (0.42 + intensity * 0.34) : 0;
        const fall = (phaseMs * speed) % travel;
        const alpha = (particleEnabled ? 0.22 : 0.14) + intensity * (weather.type === 'storm' ? 0.18 : 0.12);

        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = `rgba(190, 218, 230, ${Math.min(0.48, alpha)})`;
        ctx.beginPath();

        for (let i = 0; i < count; i++) {
            const length = 8 + Math.floor(random01(seed, i + 17) * 13);
            const xRand = random01(seed, i + 101);
            const yRand = random01(seed, i + 211);
            const y = ((yRand * travel + fall) % travel) - pad;
            const drift = fall * windX * 0.34;
            const xSpan = canvas.width + pad * 2;
            const rawX = xRand * xSpan - pad + drift;
            const x = wrap(rawX, -pad, canvas.width + pad);
            const dx = Math.round(windX * length);
            const dy = length;

            ctx.moveTo(Math.round(x), Math.round(y));
            ctx.lineTo(Math.round(x + dx), Math.round(y + dy));
        }

        ctx.stroke();

        if (weather.type === 'storm' && intensity > 0.55) {
            ctx.strokeStyle = `rgba(220, 236, 244, ${Math.min(0.34, intensity * 0.18)})`;
            ctx.beginPath();
            const highlightCount = Math.floor(count * 0.18);
            for (let i = 0; i < highlightCount; i++) {
                const idx = i * 5 + 3;
                const length = 12 + Math.floor(random01(seed, idx + 317) * 12);
                const xRand = random01(seed, idx + 419);
                const yRand = random01(seed, idx + 521);
                const y = ((yRand * travel + fall * 1.12) % travel) - pad;
                const rawX = xRand * (canvas.width + pad * 2) - pad + fall * windX * 0.42;
                const x = wrap(rawX, -pad, canvas.width + pad);
                ctx.moveTo(Math.round(x), Math.round(y));
                ctx.lineTo(Math.round(x + windX * length), Math.round(y + length));
            }
            ctx.stroke();
        }

        ctx.restore();
    }

    _drawFogBands(ctx, canvas, intensity, phaseMs, seed, particleEnabled) {
        const alphaBase = clamp(intensity, 0, 1) * (particleEnabled ? 0.12 : 0.075);
        if (alphaBase <= 0.005) return;

        const count = Math.min(
            FOG_MAX_BANDS,
            Math.max(FOG_MIN_BANDS, Math.floor(canvas.height / 150) + Math.ceil(intensity * 3)),
        );
        const drift = particleEnabled ? phaseMs * 0.012 : 0;

        ctx.save();
        for (let i = 0; i < count; i++) {
            const bandSeed = i * 97;
            const bandHeight = 18 + random01(seed, bandSeed + 11) * 42;
            const yBase = canvas.height * (0.38 + random01(seed, bandSeed + 23) * 0.56);
            const y = Math.round(yBase + Math.sin(i * 1.7 + phaseMs * 0.0008) * (particleEnabled ? 5 : 0));
            const width = canvas.width * (0.58 + random01(seed, bandSeed + 37) * 0.56);
            const xDrift = drift * (0.32 + random01(seed, bandSeed + 41) * 0.52);
            const x = wrap(
                random01(seed, bandSeed + 53) * canvas.width - width * 0.5 + xDrift,
                -width,
                canvas.width,
            );
            const alpha = alphaBase * (0.45 + random01(seed, bandSeed + 67) * 0.55);

            this._drawFogBand(ctx, x, y, width, bandHeight, alpha);
            if (x + width < canvas.width) {
                this._drawFogBand(ctx, x + width + canvas.width * 0.18, y, width, bandHeight, alpha * 0.72);
            }
        }
        ctx.restore();
    }

    _drawFogBand(ctx, x, y, width, height, alpha) {
        const grad = ctx.createLinearGradient(x, 0, x + width, 0);
        grad.addColorStop(0, 'rgba(218, 228, 224, 0)');
        grad.addColorStop(0.18, `rgba(218, 228, 224, ${alpha * 0.58})`);
        grad.addColorStop(0.52, `rgba(225, 232, 228, ${alpha})`);
        grad.addColorStop(0.86, `rgba(218, 228, 224, ${alpha * 0.46})`);
        grad.addColorStop(1, 'rgba(218, 228, 224, 0)');

        ctx.fillStyle = grad;
        ctx.fillRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height));
    }

    _drawStormFlash(ctx, canvas, intensity, seed) {
        const cycleMs = 7200;
        const cycle = Math.floor(this.elapsedMs / cycleMs);
        const cycleT = this.elapsedMs % cycleMs;
        const chance = random01(seed, cycle + 701);
        if (chance > 0.18 + intensity * 0.10) return;

        const offset = 900 + random01(seed, cycle + 809) * 4700;
        const age = cycleT - offset;
        const secondAge = cycleT - offset - 170;
        const flashAge = age >= 0 && age < 110 ? age : secondAge >= 0 && secondAge < 70 ? secondAge : -1;
        if (flashAge < 0) return;

        const windowMs = flashAge === age ? 110 : 70;
        const alpha = (1 - flashAge / windowMs) * clamp(intensity, 0, 1) * 0.18;
        if (alpha <= 0.005) return;

        const flash = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        flash.addColorStop(0, `rgba(220, 236, 255, ${alpha})`);
        flash.addColorStop(0.55, `rgba(235, 242, 255, ${alpha * 0.58})`);
        flash.addColorStop(1, 'rgba(220, 236, 255, 0)');
        ctx.fillStyle = flash;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
}

function normalizeWeather(atmosphere) {
    const raw = atmosphere?.weather;
    const rawType = typeof raw === 'string'
        ? raw
        : raw?.type || atmosphere?.weatherType || atmosphere?.type || 'clear';
    const type = normalizeType(rawType);
    const rawIntensity = typeof raw === 'object' && raw
        ? raw.intensity
        : atmosphere?.intensity;
    const intensity = clamp(
        Number.isFinite(Number(rawIntensity))
            ? Number(rawIntensity)
            : DEFAULT_INTENSITY[type] || 0,
        0,
        1,
    );
    const windX = typeof raw === 'object' && raw ? raw.windX : atmosphere?.windX;

    return { type, intensity, windX };
}

function normalizeType(type) {
    const value = String(type || 'clear').trim().toLowerCase().replace(/[\s_]+/g, '-');
    if (value === 'cloudy') return 'overcast';
    if (value === 'stormy' || value === 'thunderstorm') return 'storm';
    if (value === 'partlycloudy') return 'partly-cloudy';
    if (value === 'partly-cloudy' || value === 'overcast' || value === 'rain' || value === 'fog' || value === 'storm') {
        return value;
    }
    return 'clear';
}

function seedFromAtmosphere(atmosphere, weather) {
    const key = [
        atmosphere?.cacheKey || '',
        atmosphere?.phase || '',
        weather.type,
    ].join('|');
    return hashString(key || weather.type);
}

function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function random01(seed, salt) {
    let value = (seed + Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
}

function wrap(value, min, max) {
    const size = max - min;
    if (size <= 0) return min;
    return ((((value - min) % size) + size) % size) + min;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
