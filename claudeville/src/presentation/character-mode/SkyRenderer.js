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

const CONSTELLATIONS = [
    {
        anchor: [0.15, 0.20],
        points: [[0, 0], [0.035, -0.030], [0.072, -0.018], [0.104, -0.055], [0.137, -0.024]],
    },
    {
        anchor: [0.53, 0.16],
        points: [[0, 0], [0.028, 0.026], [0.057, 0.006], [0.090, 0.034], [0.119, 0.016]],
    },
    {
        anchor: [0.74, 0.29],
        points: [[0, 0], [0.026, -0.034], [0.052, -0.003], [0.079, -0.034]],
    },
    {
        anchor: [0.33, 0.38],
        points: [[0, 0], [0.024, -0.024], [0.054, -0.016], [0.081, -0.045], [0.112, -0.038]],
    },
];

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
        const canopy = {
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
        if (canopy.sky.sun) {
            const horizonCut = canopy.sky.sun.yFrac > 0.42 ? 0.58 : 1;
            canopy.sky.sun.alpha *= 0.54 * horizonCut;
        }
        if (canopy.sky.cloudLayers?.length) {
            canopy.sky.cloudLayers = canopy.sky.cloudLayers
                .filter((layer, index) => index % 2 === 0 || layer.yFrac < 0.34)
                .map(layer => ({ ...layer, alpha: layer.alpha * 0.58 }));
        }
        return canopy;
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
        if (!weather) return;
        const precipitation = clamp(weather.precipitation ?? 0, 0, 1);
        const fog = clamp(weather.fog ?? 0, 0, 1);
        const cloudCover = clamp(weather.cloudCover ?? 0, 0, 1);
        const active = weather.type === 'overcast'
            || weather.type === 'rain'
            || weather.type === 'storm'
            || weather.type === 'fog'
            || precipitation > 0.02
            || fog > 0.05
            || cloudCover > 0.72;
        if (!active) return;
        const alpha = fog > Math.max(precipitation, cloudCover * 0.45)
            ? 0.10 + Math.max(weather.intensity, fog) * 0.12
            : 0.12 + Math.max(weather.intensity, cloudCover, precipitation) * 0.18;
        const color = fog > Math.max(precipitation, cloudCover * 0.45) ? '210, 226, 236' : '72, 92, 118';
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
        this._drawConstellations(ctx, canvas, atmosphere, alpha, palette);
        ctx.restore();
    }

    _drawConstellations(ctx, canvas, atmosphere, alpha, palette) {
        const drift = ((atmosphere.dayProgress || 0) * 0.16) % 1;
        ctx.save();
        ctx.globalAlpha = Math.min(0.52, alpha * 0.46);
        ctx.strokeStyle = this._hexToRgba(palette.starWarm || '#c9ddff', 0.58);
        ctx.fillStyle = palette.starHot || '#f2f7ff';
        ctx.lineWidth = 1;
        for (const constellation of CONSTELLATIONS) {
            const points = constellation.points.map(([px, py]) => ({
                x: wrap((constellation.anchor[0] + px + drift) * canvas.width, -24, canvas.width + 24),
                y: Math.max(4, Math.min(canvas.height * STAR_CEILING_FRAC, (constellation.anchor[1] + py) * canvas.height)),
            }));
            if (!points.length) continue;
            ctx.beginPath();
            ctx.moveTo(Math.round(points[0].x), Math.round(points[0].y));
            for (let i = 1; i < points.length; i++) {
                ctx.lineTo(Math.round(points[i].x), Math.round(points[i].y));
            }
            ctx.stroke();
            for (const point of points) {
                ctx.fillRect(Math.round(point.x) - 1, Math.round(point.y) - 1, 2, 2);
            }
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
        const squashY = sun.squashY ?? 1;
        const horizonScale = 1 - (sun.horizonOcclusion || 0) * 0.35;
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

        const rayAlpha = Math.min(0.26, sun.alpha * horizonScale * (0.16 + bloomScale * 0.08));
        ctx.strokeStyle = warmth > 0.05
            ? `rgba(255, 188, 86, ${rayAlpha})`
            : `rgba(255, 228, 90, ${rayAlpha})`;
        ctx.lineWidth = Math.max(2, Math.round(radius * 0.08));
        ctx.lineCap = 'round';
        for (let i = 0; i < 12; i++) {
            const angle = (Math.PI * 2 * i) / 12;
            const inner = radius * (1.48 + (i % 2) * 0.16);
            const outer = radius * horizonScale * (2.15 + (i % 3) * 0.18);
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
        ctx.ellipse(x, y, radius, radius * squashY, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = sun.alpha * 0.5;
        ctx.strokeStyle = warmth > 0.05 ? '#ffe0a3' : '#fff0a8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(x, y, radius - 1, (radius - 1) * squashY, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    _drawMoon(ctx, canvas, atmosphere) {
        const moon = atmosphere.sky?.moon;
        if (!moon?.visible || moon.alpha <= 0.01) return;
        const phaseName = moon.phase?.phaseName || 'crescent';
        const illumination = clamp(moon.phase?.illumination ?? 0.24, 0, 1);
        const id = this._firstAvailable([
            atmosphere.sky?.assetIds?.moon,
            FALLBACK_MOON_ID,
        ]);
        if (id && phaseName === 'crescent' && illumination > 0.10 && illumination < 0.31) {
            const img = this.assets.get(id);
            const dims = this.assets.getDims(id);
            const x = canvas.width * moon.xFrac - dims.w / 2;
            const y = canvas.height * moon.yFrac - dims.h / 2;
            ctx.save();
            ctx.globalAlpha = moon.alpha;
            this._drawMoonGlow(ctx, canvas, moon, atmosphere);
            const squashY = moon.squashY ?? 1;
            if (squashY < 0.99) {
                ctx.translate(canvas.width * moon.xFrac, canvas.height * moon.yFrac);
                ctx.scale(1, squashY);
                ctx.drawImage(img, Math.round(-dims.w / 2), Math.round(-dims.h / 2));
            } else {
                ctx.drawImage(img, Math.round(x), Math.round(y));
            }
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
        const squashY = moon.squashY ?? 1;
        const phase = moon.phase || { phaseName: 'crescent', illumination: 0.24, waxing: false };
        const illumination = clamp(phase.illumination ?? 0.24, 0, 1);
        const litWidth = r * (0.22 + illumination * 1.46);
        const shadowOffset = phase.phaseName === 'new'
            ? 0
            : (phase.waxing ? -1 : 1) * r * (0.92 - illumination * 0.84);
        ctx.save();
        ctx.globalAlpha = moon.alpha;
        this._drawMoonGlow(ctx, canvas, { ...moon, alpha: moon.alpha * (0.25 + illumination * 0.75) }, atmosphere);
        ctx.translate(x, y);
        ctx.scale(1, squashY);
        ctx.fillStyle = '#cfe4ff';
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.clip();
        if (phase.phaseName === 'new') {
            ctx.fillStyle = 'rgba(8, 18, 34, 0.76)';
            ctx.fillRect(-r - 2, -r - 2, r * 2 + 4, r * 2 + 4);
            ctx.strokeStyle = 'rgba(190, 216, 255, 0.36)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(0, 0, r - 1, 0, Math.PI * 2);
            ctx.stroke();
        } else {
            ctx.globalCompositeOperation = 'source-atop';
            const shadow = ctx.createRadialGradient(shadowOffset, -r * 0.08, r * 0.12, shadowOffset, 0, r * 1.34);
            shadow.addColorStop(0, 'rgba(20, 36, 58, 0.05)');
            shadow.addColorStop(0.52, 'rgba(14, 26, 44, 0.28)');
            shadow.addColorStop(1, 'rgba(4, 12, 24, 0.82)');
            ctx.fillStyle = shadow;
            const shadowX = phase.waxing ? -r - litWidth * 0.38 : litWidth * 0.38;
            ctx.fillRect(shadowX, -r - 2, r * 2.4, r * 2 + 4);
            ctx.globalCompositeOperation = 'screen';
            ctx.fillStyle = `rgba(238, 247, 255, ${0.06 + illumination * 0.08})`;
            ctx.beginPath();
            ctx.ellipse((phase.waxing ? 1 : -1) * r * 0.12, -r * 0.18, litWidth * 0.32, r * 0.22, -0.24, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    _drawClouds(ctx, camera, canvas, atmosphere) {
        if (!this.assets) return;
        const layers = Array.isArray(atmosphere.sky?.cloudLayers) && atmosphere.sky.cloudLayers.length
            ? atmosphere.sky.cloudLayers
            : null;
        if (layers) {
            this._drawCloudLayerDescriptors(ctx, camera, canvas, atmosphere, layers);
            return;
        }
        const cloudIds = this._availableCloudIds(atmosphere);
        if (!cloudIds.length) return;

        const camX = camera?.x || 0;
        const density = atmosphere.sky?.cloudDensity ?? 0.3;
        const baseAlpha = atmosphere.sky?.cloudAlpha ?? 0.35;
        const clockDrift = atmosphere.motion?.clockDriftPx || 0;
        const windX = atmosphere.motion?.windX || 1;
        const seed = Number.isFinite(Number(atmosphere.weather?.seed))
            ? Number(atmosphere.weather.seed) >>> 0
            : hashString(`${atmosphere.clock?.localDate || ''}|${atmosphere.weather?.type || 'clear'}`);

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

            ctx.save();
            ctx.globalAlpha = Math.min(0.86, baseAlpha * defaults.alphaMul);
            for (let i = -1; i <= count; i++) {
                const salt = index * 1009 + (i + 3) * 131;
                const jitter = (random01(seed, salt + 11) - 0.5) * spacing * 0.62;
                const yJitter = (random01(seed, salt + 23) - 0.5) * canvas.height * 0.055;
                const scale = 0.82 + random01(seed, salt + 37) * 0.36;
                const layerAlpha = 0.74 + random01(seed, salt + 41) * 0.34;
                const y = (defaults.fy + index * 0.045) * canvas.height + yJitter;
                const x = i * spacing + baseOffset + jitter - (dims.w * scale) / 2;
                ctx.globalAlpha = Math.min(0.86, baseAlpha * defaults.alphaMul * layerAlpha);
                ctx.drawImage(
                    img,
                    Math.round(x),
                    Math.round(y),
                    Math.round(dims.w * scale),
                    Math.round(dims.h * scale),
                );
            }
            ctx.restore();
        });
    }

    _drawCloudLayerDescriptors(ctx, camera, canvas, atmosphere, layers) {
        const camX = camera?.x || 0;
        const clockDrift = atmosphere.motion?.clockDriftPx || 0;
        const windX = atmosphere.motion?.windX || 1;
        const wrapWidth = canvas.width + 260;
        ctx.save();
        for (const layer of layers) {
            const id = this.assets.has(layer.assetId) ? layer.assetId : this._availableCloudIds(atmosphere)[0];
            if (!id) continue;
            const img = this.assets.get(id);
            const dims = this.assets.getDims(id);
            if (!img || !dims) continue;
            const scale = Math.max(0.45, Number(layer.scale) || 1);
            const w = dims.w * scale;
            const h = dims.h * scale;
            const parallax = Number(layer.parallax) || 0.04;
            const driftMul = Number(layer.driftMul) || 1;
            const drift = -camX * parallax
                + clockDrift * driftMul
                + this._decorativeCloudOffset * driftMul * windX;
            const y = canvas.height * clamp(layer.yFrac ?? 0.25, 0.04, 0.62);
            const baseX = (layer.xFrac ?? 0.5) * canvas.width + drift;
            const x = wrap(baseX, -w - 130, wrapWidth);
            ctx.globalAlpha = Math.min(0.88, Math.max(0, Number(layer.alpha) || 0));
            ctx.drawImage(img, Math.round(x), Math.round(y), Math.round(w), Math.round(h));
            if (x + w < canvas.width + 80) {
                ctx.drawImage(img, Math.round(x + wrapWidth), Math.round(y), Math.round(w), Math.round(h));
            }
        }
        ctx.restore();
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
        const fog = clamp(weather.fog ?? 0, 0, 1);
        const precipitation = clamp(weather.precipitation ?? 0, 0, 1);
        if (weather.type === 'fog' || fog > 0.05) {
            this._drawFog(ctx, canvas, weather);
        }
        if (weather.type === 'rain' || weather.type === 'storm' || precipitation > 0.02) {
            this._drawRainVeil(ctx, canvas, atmosphere);
        }
    }

    _drawFog(ctx, canvas, weather) {
        const alpha = Math.min(0.22, 0.06 + Math.max(weather.intensity, weather.fog ?? 0) * 0.16);
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
        const alpha = Math.min(0.22, 0.06 + Math.max(atmosphere.weather.intensity, atmosphere.weather.precipitation ?? 0) * 0.18);
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

    _hexToRgba(hex, alpha) {
        const value = String(hex || '#ffffff').replace('#', '').padEnd(6, 'f').slice(0, 6);
        const r = parseInt(value.slice(0, 2), 16);
        const g = parseInt(value.slice(2, 4), 16);
        const b = parseInt(value.slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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

function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
}

function wrap(value, min, max) {
    const range = max - min;
    if (!Number.isFinite(range) || range <= 0) return min;
    return ((value - min) % range + range) % range + min;
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
