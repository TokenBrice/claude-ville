// claudeville/src/presentation/character-mode/SkyRenderer.js
//
// Drawn first thing in IsometricRenderer._render() before the camera
// transform — viewport-fixed.

import { AtmosphereState } from './AtmosphereState.js';

const STAR_COUNT = 90;
const STAR_CEILING_FRAC = 0.60;
const FALLBACK_CLOUD_IDS = ['atmosphere.cloud.cumulus', 'atmosphere.cloud.wisp'];
const FALLBACK_MOON_ID = 'atmosphere.moon.crescent';
const CLOUD_DRIFT_PX_PER_MS = 0.0012;
const CANOPY_HEIGHT_FRAC = 0.52;
const CANOPY_MIN_HEIGHT = 240;
const CANOPY_MAX_HEIGHT = 520;
const AURORA_DURATION_MS = 12000;
const AURORA_FADE_IN_MS = 2000;
const AURORA_HOLD_MS = 6000;

const CLOUD_LAYER_DEFAULTS = [
    { fy: 0.20, parallax: 0.03, driftMul: 0.55, alphaMul: 0.72 },
    { fy: 0.30, parallax: 0.07, driftMul: 0.92, alphaMul: 0.46 },
    { fy: 0.40, parallax: 0.11, driftMul: 1.20, alphaMul: 0.32 },
];

export class SkyRenderer {
    constructor({ assets } = {}) {
        this.assets = assets || null;
        this.cache = null;
        this.cacheKey = '';
        this._decorativeCloudOffset = 0;
        this._fallbackAtmosphere = null;
        this._auroraStartedAt = 0;
    }

    draw(ctx, arg1 = {}, arg2 = null, arg3 = 16, arg4 = 1) {
        const { canvas, camera, dt, atmosphere, motionScale } = this._normalizeDrawArgs(arg1, arg2, arg3, arg4);
        if (!canvas) return;
        const snapshot = atmosphere || this._getFallbackAtmosphere(motionScale);
        const cached = this._getCachedBackground(canvas, snapshot);
        ctx.drawImage(cached, 0, 0, canvas.width, canvas.height);

        if (snapshot.motion?.driftEnabled) {
            this._decorativeCloudOffset = (this._decorativeCloudOffset + dt * CLOUD_DRIFT_PX_PER_MS) % Math.max(1, canvas.width);
        }

        this._drawStars(ctx, canvas, snapshot);
        this._drawSun(ctx, canvas, snapshot);
        this._drawMoon(ctx, canvas, snapshot);
        this._drawClouds(ctx, camera, canvas, snapshot);
        this._drawAurora(ctx, canvas, snapshot, motionScale);
        this._drawBackgroundWeather(ctx, canvas, snapshot);
    }

    triggerAurora(now = Date.now()) {
        this._auroraStartedAt = now;
    }

    drawCanopy(ctx, { canvas, camera = null, dt = 16, atmosphere = null, motionScale = 1 } = {}) {
        if (!canvas) return;
        const source = atmosphere || this._getFallbackAtmosphere(motionScale);
        const canopy = this._buildCanopySnapshot(source);
        const height = Math.max(
            CANOPY_MIN_HEIGHT,
            Math.min(CANOPY_MAX_HEIGHT, canvas.height * CANOPY_HEIGHT_FRAC),
        );

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, canvas.width, height);
        ctx.clip();
        ctx.globalCompositeOperation = 'screen';
        this._drawStars(ctx, canvas, canopy);
        this._drawSun(ctx, canvas, canopy);
        this._drawMoon(ctx, canvas, canopy);
        ctx.globalCompositeOperation = 'source-over';
        this._drawClouds(ctx, camera, canvas, canopy);
        ctx.restore();
    }

    _buildCanopySnapshot(atmosphere) {
        const sky = atmosphere.sky || {};
        return {
            ...atmosphere,
            sky: {
                ...sky,
                starsAlpha: (sky.starsAlpha || 0) * 0.72,
                cloudAlpha: (sky.cloudAlpha || 0) * 0.34,
                cloudDensity: Math.min(1, (sky.cloudDensity || 0) * 0.72),
                sun: sky.sun ? { ...sky.sun, alpha: sky.sun.alpha * 0.34 } : sky.sun,
                moon: sky.moon ? { ...sky.moon, alpha: sky.moon.alpha * 0.62 } : sky.moon,
            },
        };
    }

    _normalizeDrawArgs(arg1, arg2, arg3, arg4) {
        if (arg1 && typeof arg1 === 'object' && arg1.canvas) {
            return {
                canvas: arg1.canvas,
                camera: arg1.camera || null,
                dt: Number.isFinite(arg1.dt) ? arg1.dt : 16,
                atmosphere: arg1.atmosphere || null,
                motionScale: Number.isFinite(arg1.motionScale) ? arg1.motionScale : 1,
            };
        }
        return {
            camera: arg1 || null,
            canvas: arg2 || null,
            dt: Number.isFinite(arg3) ? arg3 : 16,
            atmosphere: null,
            motionScale: Number.isFinite(arg4) ? arg4 : 1,
        };
    }

    _getFallbackAtmosphere(motionScale) {
        if (!this._fallbackAtmosphere) {
            this._fallbackAtmosphere = new AtmosphereState();
        }
        return this._fallbackAtmosphere.update({ motionScale });
    }

    _getCachedBackground(canvas, atmosphere) {
        const dpr = canvas._claudeVilleDpr || 1;
        const key = `${canvas.width}x${canvas.height}@${dpr}|${atmosphere.cacheKey}`;
        if (this.cache && this.cacheKey === key) return this.cache;
        const off = document.createElement('canvas');
        off.width = Math.max(1, Math.round(canvas.width * dpr));
        off.height = Math.max(1, Math.round(canvas.height * dpr));
        const o = off.getContext('2d');
        o.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._paintGradient(o, canvas, atmosphere);
        this._paintHorizonWash(o, canvas, atmosphere);
        this._paintStaticWeatherPlate(o, canvas, atmosphere);
        this.cache = off;
        this.cacheKey = key;
        return off;
    }

    _paintGradient(ctx, canvas, atmosphere) {
        const palette = atmosphere.sky?.palette || {};
        const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
        g.addColorStop(0.00, palette.zenith || '#236eb8');
        g.addColorStop(0.30, palette.upperBand || '#4aa0dd');
        g.addColorStop(0.65, palette.midBand || '#86cdf0');
        g.addColorStop(1.00, palette.horizon || '#d5f3ff');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    _paintHorizonWash(ctx, canvas, atmosphere) {
        const palette = atmosphere.sky?.palette || {};
        const alpha = atmosphere.grade?.horizonWash ?? 0.12;
        const horizonGlow = palette.horizonGlow || '196, 235, 255';
        const farGlow = atmosphere.lighting?.ambientTint || horizonGlow;
        const layers = [
            { yFrac: 0.89, radius: 0.86, color: farGlow, alpha: alpha * 0.45 },
            { yFrac: 0.84, radius: 0.62, color: horizonGlow, alpha: alpha * 0.76 },
            { yFrac: 0.79, radius: 0.36, color: horizonGlow, alpha: alpha * 0.30 },
        ];
        for (const layer of layers) {
            const y = canvas.height * layer.yFrac;
            const grad = ctx.createRadialGradient(
                canvas.width * 0.5,
                y,
                0,
                canvas.width * 0.5,
                y,
                Math.max(canvas.width, canvas.height) * layer.radius,
            );
            grad.addColorStop(0, `rgba(${layer.color}, ${layer.alpha})`);
            grad.addColorStop(1, `rgba(${layer.color}, 0)`);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
    }

    _paintStaticWeatherPlate(ctx, canvas, atmosphere) {
        const { weather } = atmosphere;
        if (!weather || (weather.type !== 'overcast' && weather.type !== 'rain' && weather.type !== 'fog')) return;
        const alpha = weather.type === 'fog'
            ? 0.10 + weather.intensity * 0.12
            : 0.16 + weather.intensity * 0.18;
        const color = weather.type === 'fog' ? '210, 226, 236' : '72, 92, 118';
        const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
        g.addColorStop(0, `rgba(${color}, ${alpha})`);
        g.addColorStop(0.62, `rgba(${color}, ${alpha * 0.62})`);
        g.addColorStop(1, `rgba(${color}, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    _drawStars(ctx, canvas, atmosphere) {
        const alpha = atmosphere.sky?.starsAlpha ?? 0;
        if (alpha <= 0.01) return;
        const palette = atmosphere.sky?.palette || {};
        const ceilingY = canvas.height * STAR_CEILING_FRAC;
        const timeOffset = (atmosphere.dayProgress || 0) * canvas.width;
        let seed = 12345;
        const next = () => {
            seed = (seed * 9301 + 49297) % 233280;
            return seed / 233280;
        };

        ctx.save();
        ctx.globalAlpha = alpha;
        for (let i = 0; i < STAR_COUNT; i++) {
            const xBase = next() * canvas.width;
            const y = Math.round(next() * ceilingY);
            const hot = next() < 0.18;
            const size = hot ? 2 : 1;
            const drift = timeOffset * (0.12 + (i % 5) * 0.018);
            const x = Math.round(((xBase + drift) % canvas.width + canvas.width) % canvas.width);
            ctx.fillStyle = hot ? (palette.starHot || '#f2f7ff') : (palette.starWarm || '#c9ddff');
            ctx.fillRect(x, y, size, size);
        }
        ctx.restore();
    }

    _drawSun(ctx, canvas, atmosphere) {
        const sun = atmosphere.sky?.sun;
        if (!sun?.visible || sun.alpha <= 0.01) return;
        const x = canvas.width * sun.xFrac;
        const y = canvas.height * sun.yFrac;
        const radius = Math.max(22, Math.min(canvas.width, canvas.height) * 0.042);
        const lighting = atmosphere.lighting || {};
        const warmth = lighting.sunWarmth ?? 0;
        const bloomScale = lighting.sunBloomScale ?? 1;
        const glowRadius = radius * (4.3 + warmth * 3.0) * bloomScale;
        const warmG = Math.round(232 - warmth * 42);
        const warmB = Math.round(170 - warmth * 58);
        const hazeG = Math.round(156 - warmth * 34);

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        const glow = ctx.createRadialGradient(x, y, 0, x, y, glowRadius);
        glow.addColorStop(0, `rgba(255, ${warmth ? warmG : 238}, ${warmth ? warmB : 128}, ${0.46 * sun.alpha})`);
        glow.addColorStop(0.38, warmth
            ? `rgba(255, ${hazeG}, 80, ${0.22 * sun.alpha * bloomScale})`
            : `rgba(255, 222, 92, ${0.18 * sun.alpha})`);
        glow.addColorStop(1, 'rgba(255, 222, 92, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const rayAlpha = Math.min(0.26, sun.alpha * (0.16 + bloomScale * 0.08));
        ctx.strokeStyle = warmth > 0.05
            ? `rgba(255, 188, 86, ${rayAlpha})`
            : `rgba(255, 228, 90, ${rayAlpha})`;
        ctx.lineWidth = Math.max(2, Math.round(radius * 0.08));
        ctx.lineCap = 'round';
        for (let i = 0; i < 12; i++) {
            const angle = (Math.PI * 2 * i) / 12;
            const inner = radius * (1.48 + (i % 2) * 0.16);
            const outer = radius * (2.15 + (i % 3) * 0.18);
            ctx.beginPath();
            ctx.moveTo(
                Math.round(x + Math.cos(angle) * inner),
                Math.round(y + Math.sin(angle) * inner),
            );
            ctx.lineTo(
                Math.round(x + Math.cos(angle) * outer),
                Math.round(y + Math.sin(angle) * outer),
            );
            ctx.stroke();
        }

        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = sun.alpha;
        const body = ctx.createRadialGradient(
            x - radius * 0.28,
            y - radius * 0.32,
            radius * 0.12,
            x,
            y,
            radius,
        );
        body.addColorStop(0, '#fff9bf');
        body.addColorStop(0.58, warmth > 0.05 ? '#ffd176' : '#ffe36b');
        body.addColorStop(1, warmth > 0.05 ? '#f3a14d' : '#ffc842');
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = sun.alpha * 0.5;
        ctx.strokeStyle = warmth > 0.05 ? '#ffe0a3' : '#fff0a8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, radius - 1, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    _drawMoon(ctx, canvas, atmosphere) {
        const moon = atmosphere.sky?.moon;
        if (!moon?.visible || moon.alpha <= 0.01) return;
        const id = this._firstAvailable([
            atmosphere.sky?.assetIds?.moon,
            FALLBACK_MOON_ID,
        ]);
        if (id) {
            const img = this.assets.get(id);
            const dims = this.assets.getDims(id);
            const x = canvas.width * moon.xFrac - dims.w / 2;
            const y = canvas.height * moon.yFrac - dims.h / 2;
            ctx.save();
            ctx.globalAlpha = moon.alpha;
            this._drawMoonGlow(ctx, canvas, moon, atmosphere);
            ctx.drawImage(img, Math.round(x), Math.round(y));
            ctx.restore();
            return;
        }
        this._drawCodeMoon(ctx, canvas, moon, atmosphere);
    }

    _drawMoonGlow(ctx, canvas, moon, atmosphere = null) {
        const x = canvas.width * moon.xFrac;
        const y = canvas.height * moon.yFrac;
        const radius = Math.max(42, Math.min(canvas.width, canvas.height) * 0.10);
        const corona = atmosphere?.lighting?.beaconIntensity ?? 0.5;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, radius * 1.42);
        glow.addColorStop(0, `rgba(166, 205, 255, ${0.18 * moon.alpha})`);
        glow.addColorStop(0.56, `rgba(190, 218, 255, ${0.08 * moon.alpha * corona})`);
        glow.addColorStop(0.74, `rgba(230, 238, 255, ${0.045 * moon.alpha * corona})`);
        glow.addColorStop(1, 'rgba(166, 205, 255, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    _drawCodeMoon(ctx, canvas, moon, atmosphere = null) {
        const x = canvas.width * moon.xFrac;
        const y = canvas.height * moon.yFrac;
        const r = Math.max(14, Math.min(canvas.width, canvas.height) * 0.026);
        ctx.save();
        ctx.globalAlpha = moon.alpha;
        this._drawMoonGlow(ctx, canvas, moon, atmosphere);
        ctx.fillStyle = '#cfe4ff';
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath();
        ctx.arc(x + r * 0.42, y - r * 0.10, r * 0.92, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _drawClouds(ctx, camera, canvas, atmosphere) {
        if (!this.assets) return;
        const cloudIds = this._availableCloudIds(atmosphere);
        if (!cloudIds.length) return;

        const camX = camera?.x || 0;
        const density = atmosphere.sky?.cloudDensity ?? 0.3;
        const baseAlpha = atmosphere.sky?.cloudAlpha ?? 0.35;
        const clockDrift = atmosphere.motion?.clockDriftPx || 0;
        const windX = atmosphere.motion?.windX || 1;

        cloudIds.forEach((id, index) => {
            const img = this.assets.get(id);
            const dims = this.assets.getDims(id);
            if (!img || !dims) return;
            const defaults = CLOUD_LAYER_DEFAULTS[index % CLOUD_LAYER_DEFAULTS.length];
            const count = Math.max(2, Math.round(2 + density * 5) - index);
            const spacing = canvas.width / count;
            const rawOffset = -camX * defaults.parallax
                + clockDrift * defaults.driftMul
                + this._decorativeCloudOffset * defaults.driftMul * windX;
            const baseOffset = ((rawOffset % spacing) + spacing) % spacing;
            const y = (defaults.fy + index * 0.045) * canvas.height;

            ctx.save();
            ctx.globalAlpha = Math.min(0.86, baseAlpha * defaults.alphaMul);
            for (let i = -1; i <= count; i++) {
                const x = i * spacing + baseOffset - dims.w / 2;
                ctx.drawImage(img, Math.round(x), Math.round(y));
            }
            ctx.restore();
        });
    }

    _drawAurora(ctx, canvas, atmosphere, motionScale = 1) {
        if (!this._auroraStartedAt) return;
        const elapsed = Date.now() - this._auroraStartedAt;
        if (elapsed > AURORA_DURATION_MS) {
            this._auroraStartedAt = 0;
            return;
        }
        const alpha = this._auroraAlpha(elapsed, motionScale);
        if (alpha <= 0.005) return;
        const beacon = atmosphere?.lighting?.beaconIntensity ?? 0.65;
        const yBase = canvas.height * 0.23;
        const width = canvas.width;
        const time = motionScale === 0 ? 0.75 : elapsed / 1000;

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = Math.min(0.22, alpha * (0.78 + beacon * 0.35));
        for (let band = 0; band < 3; band++) {
            const yOffset = band * 18;
            const hue = band === 0 ? '102, 255, 196' : band === 1 ? '104, 190, 255' : '196, 126, 255';
            const grad = ctx.createLinearGradient(0, yBase - 42 + yOffset, 0, yBase + 64 + yOffset);
            grad.addColorStop(0, `rgba(${hue}, 0)`);
            grad.addColorStop(0.42, `rgba(${hue}, ${0.38 - band * 0.07})`);
            grad.addColorStop(1, `rgba(${hue}, 0)`);
            ctx.strokeStyle = grad;
            ctx.lineWidth = 22 - band * 4;
            ctx.beginPath();
            for (let x = -20; x <= width + 20; x += 28) {
                const t = x / Math.max(1, width);
                const y = yBase + yOffset
                    + Math.cos(t * Math.PI * 2.1 + band * 0.85 + time * 0.45) * (18 + band * 5)
                    + Math.cos(t * Math.PI * 5.2 - time * 0.25) * 5;
                if (x === -20) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    _auroraAlpha(elapsed, motionScale) {
        if (motionScale === 0) return 1;
        if (elapsed < AURORA_FADE_IN_MS) return elapsed / AURORA_FADE_IN_MS;
        if (elapsed < AURORA_FADE_IN_MS + AURORA_HOLD_MS) return 1;
        const fadeElapsed = elapsed - AURORA_FADE_IN_MS - AURORA_HOLD_MS;
        return Math.max(0, 1 - fadeElapsed / (AURORA_DURATION_MS - AURORA_FADE_IN_MS - AURORA_HOLD_MS));
    }

    _drawBackgroundWeather(ctx, canvas, atmosphere) {
        const weather = atmosphere.weather;
        if (!weather) return;
        if (weather.type === 'fog') {
            this._drawFog(ctx, canvas, weather);
        } else if (weather.type === 'rain') {
            this._drawRainVeil(ctx, canvas, atmosphere);
        }
    }

    _drawFog(ctx, canvas, weather) {
        const alpha = Math.min(0.22, 0.08 + weather.intensity * 0.16);
        ctx.save();
        ctx.globalAlpha = alpha;
        for (let i = 0; i < 4; i++) {
            const y = canvas.height * (0.34 + i * 0.12);
            const grad = ctx.createLinearGradient(0, y - 24, 0, y + 42);
            grad.addColorStop(0, 'rgba(220, 234, 240, 0)');
            grad.addColorStop(0.5, 'rgba(220, 234, 240, 0.55)');
            grad.addColorStop(1, 'rgba(220, 234, 240, 0)');
            ctx.fillStyle = grad;
            ctx.fillRect(0, y - 24, canvas.width, 66);
        }
        ctx.restore();
    }

    _drawRainVeil(ctx, canvas, atmosphere) {
        if (!atmosphere.motion?.particleEnabled) return;
        const alpha = Math.min(0.22, 0.08 + atmosphere.weather.intensity * 0.18);
        const spacing = 34;
        const offset = ((atmosphere.motion.clockDriftPx || 0) % spacing + spacing) % spacing;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = '#b7d3e9';
        ctx.lineWidth = 1;
        for (let x = -spacing; x < canvas.width + spacing; x += spacing) {
            for (let y = -spacing; y < canvas.height * 0.72; y += spacing) {
                ctx.beginPath();
                ctx.moveTo(x + offset, y);
                ctx.lineTo(x + offset - 10, y + 24);
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    _availableCloudIds(atmosphere) {
        const requested = atmosphere.sky?.assetIds?.clouds || [];
        const available = requested.filter(id => this.assets?.has(id));
        if (available.length) return available;
        return FALLBACK_CLOUD_IDS.filter(id => this.assets?.has(id));
    }

    _firstAvailable(ids) {
        if (!this.assets) return null;
        for (const id of ids) {
            if (id && this.assets.has(id)) return id;
        }
        return null;
    }

    dispose() {
        this.cache = null;
        this.cacheKey = '';
        this._decorativeCloudOffset = 0;
        this._auroraStartedAt = 0;
        this._fallbackAtmosphere?.dispose?.();
        this._fallbackAtmosphere = null;
    }
}
