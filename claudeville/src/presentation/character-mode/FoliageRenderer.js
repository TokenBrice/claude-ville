import { SpriteRenderer } from './SpriteRenderer.js';
import { canvasMapPixelCount, releaseCanvasMap } from './CanvasBudget.js';

// Owns fantasy-tree caches and foliage drawing. The host supplies only the
// live atmosphere and motion values shared with the world frame.
export class FoliageRenderer {
    constructor(host) {
        this.host = host;
        this.cache = new Map();
    }

    clear() {
        this.cache.clear();
    }

    releaseCache() {
        releaseCanvasMap(this.cache);
    }

    getRetainedPixels() {
        return canvasMapPixelCount(this.cache);
    }

    get cacheSize() {
        return this.cache.size;
    }

    fantasyTreePropBounds(tree) {
        const cached = this._getFantasyForestTreeCache(tree);
        return {
            left: -cached.anchorX,
            right: cached.canvas.width - cached.anchorX,
            top: -cached.anchorY,
            bottom: cached.canvas.height - cached.anchorY,
            splitY: -cached.anchorY + Math.round(cached.canvas.height * 0.58),
        };
    }

    // Deterministic per-tree phase for wind sway. Mixes tile position and
    // variant into [0, 2π) so neighbouring trees don't pulse in lockstep.
    windSwaySeed(tree) {
        const tx = Number(tree?.tileX) || 0;
        const ty = Number(tree?.tileY) || 0;
        const variant = Number(tree?.variant) || 0;
        const n = Math.sin(tx * 12.9898 + ty * 78.233 + variant * 7.131) * 43758.5453;
        return (n - Math.floor(n)) * Math.PI * 2;
    }

    // Apply a small horizontal offset to a tree drawFn based on the current
    // atmosphere wind. Clamped to ±2 px so pixel-art sprites do not shimmer;
    // skipped under reduced motion (motionScale === 0).
    withTreeSway(ctx, seed, drawFn, tileX = 0) {
        if (typeof drawFn !== 'function') return;
        const motionScale = this.host.motionScale ?? 1;
        const windX = Number(this.host._lastAtmosphere?.motion?.windX) || 0;
        if (motionScale <= 0 || windX === 0) {
            drawFn();
            return;
        }
        const t = (typeof performance !== 'undefined' && performance.now
            ? performance.now()
            : Date.now()) * 0.001;
        // Spatially-phased gust envelope: wind crosses the forest in slow
        // travelling waves (tileX phase offset) so neighbouring canopies crest a
        // beat apart instead of swaying in lockstep. The whole sprite still moves
        // as one unit — the closure-based drawFn can't be cleanly split into
        // canopy vs trunk without doubling per-tree draw cost — so this stays the
        // gust-modulated whole-sprite fallback the motion budget prefers.
        const gust = 0.4 + 0.6 * Math.sin(t * 0.13 + tileX * 0.05);
        let dx = Math.sin(t + seed) * windX * 1.5 * gust;
        if (dx > 2) dx = 2;
        else if (dx < -2) dx = -2;
        const offset = Math.round(dx);
        if (offset === 0) {
            drawFn();
            return;
        }
        ctx.save();
        ctx.translate(offset, 0);
        drawFn();
        ctx.restore();
    }

    drawFantasyForestTree(ctx, x, y, tree) {
        const cached = this._getFantasyForestTreeCache(tree);
        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);
        ctx.drawImage(
            cached.canvas,
            Math.round(x - cached.anchorX),
            Math.round(y - cached.anchorY)
        );
        ctx.restore();
    }

    _getFantasyForestTreeCache(tree) {
        const scaleBucket = Math.round((tree.scale ?? 1) * 100);
        const seedBucket = Math.round((tree.seed ?? 0.5) * 100);
        const variant = tree.variant ?? 1;
        const key = `${variant}:${scaleBucket}:${seedBucket}`;
        const existing = this.cache.get(key);
        if (existing) return existing;

        const scale = scaleBucket / 100;
        const seed = seedBucket / 100;
        const baseWidth = variant === 3 ? 104 : variant === 2 ? 96 : variant === 1 ? 72 : 92;
        const topHeight = variant === 3 ? 92 : variant === 2 ? 100 : variant === 1 ? 82 : 84;
        const bottomPad = 16;
        const padding = 8;
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(baseWidth * scale) + padding * 2;
        canvas.height = Math.ceil((topHeight + bottomPad) * scale) + padding * 2;
        const anchorX = Math.round(canvas.width / 2);
        const anchorY = Math.round(topHeight * scale) + padding;
        const cacheCtx = canvas.getContext('2d');
        SpriteRenderer.disableSmoothing(cacheCtx);
        cacheCtx.translate(anchorX, anchorY);
        cacheCtx.scale(scale, scale);
        this._drawFantasyForestTreeBody(cacheCtx, seed, variant);

        const cached = { canvas, anchorX, anchorY };
        this.cache.set(key, cached);
        return cached;
    }

    _drawFantasyForestTreeBody(ctx, seed, variant) {
        ctx.fillStyle = `rgba(6, 15, 8, ${0.24 + seed * 0.10})`;
        ctx.beginPath();
        ctx.ellipse(0, 2, 20, 7, 0, 0, Math.PI * 2);
        ctx.fill();

        if (variant === 3) {
            this._drawJungleBroadleafSilhouette(ctx, seed);
        } else if (variant === 2) {
            this._drawPalmSilhouette(ctx, seed);
        } else if (variant === 1) {
            this._drawPineSilhouette(ctx, seed);
        } else {
            this._drawOakSilhouette(ctx, seed);
        }
    }

    _drawJungleBroadleafSilhouette(ctx, seed) {
        ctx.save();
        const trunkLean = (seed - 0.5) * 8;
        ctx.fillStyle = '#503016';
        ctx.beginPath();
        ctx.moveTo(-5, 2);
        ctx.lineTo(5, 2);
        ctx.lineTo(8 + trunkLean * 0.35, -46);
        ctx.lineTo(-2 + trunkLean * 0.35, -46);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(28, 16, 8, 0.28)';
        ctx.fillRect(-5, -38, 3, 40);

        const crownX = trunkLean;
        const crownY = -54;
        const leafColors = ['#7ccf45', '#5faf3a', '#3f8d35', '#9bd857'];
        const leaves = [
            { x: -25, y: -8, rx: 30, ry: 12, a: -0.32 },
            { x: 23, y: -10, rx: 32, ry: 12, a: 0.28 },
            { x: -14, y: -24, rx: 25, ry: 13, a: -0.76 },
            { x: 14, y: -27, rx: 27, ry: 13, a: 0.72 },
            { x: -2, y: -34, rx: 24, ry: 12, a: -0.08 },
            { x: -30, y: 6, rx: 21, ry: 10, a: 0.16 },
            { x: 30, y: 4, rx: 22, ry: 10, a: -0.14 },
        ];

        ctx.fillStyle = 'rgba(13, 29, 12, 0.76)';
        for (const leaf of leaves) {
            this._traceBroadLeaf(ctx, crownX + leaf.x + 3, crownY + leaf.y + 5, leaf.rx, leaf.ry, leaf.a);
            ctx.fill();
        }
        for (let i = 0; i < leaves.length; i++) {
            const leaf = leaves[i];
            ctx.fillStyle = leafColors[(i + Math.floor(seed * 4)) % leafColors.length];
            this._traceBroadLeaf(ctx, crownX + leaf.x, crownY + leaf.y, leaf.rx, leaf.ry, leaf.a);
            ctx.fill();
            ctx.strokeStyle = 'rgba(229, 242, 111, 0.16)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(crownX, crownY - 2);
            ctx.lineTo(crownX + leaf.x * 0.72, crownY + leaf.y * 0.72);
            ctx.stroke();
        }

        ctx.fillStyle = '#d49a35';
        ctx.beginPath();
        ctx.arc(crownX - 3, crownY - 1, 3, 0, Math.PI * 2);
        ctx.arc(crownX + 5, crownY + 1, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _traceBroadLeaf(ctx, x, y, radiusX, radiusY, angle) {
        ctx.beginPath();
        ctx.ellipse(x, y, radiusX, radiusY, angle, 0, Math.PI * 2);
        ctx.closePath();
    }

    _drawPalmSilhouette(ctx, seed) {
        const lean = (seed - 0.5) * 12;
        ctx.save();
        ctx.translate(lean * 0.18, 0);

        ctx.lineWidth = 7;
        ctx.lineCap = 'round';
        ctx.strokeStyle = '#3d2517';
        ctx.beginPath();
        ctx.moveTo(-4, 1);
        ctx.quadraticCurveTo(-8 + lean * 0.18, -33, lean, -69);
        ctx.stroke();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#7a4d26';
        ctx.beginPath();
        ctx.moveTo(-1, -1);
        ctx.quadraticCurveTo(-5 + lean * 0.18, -34, lean + 2, -68);
        ctx.stroke();

        const crownX = lean;
        const crownY = -72;
        ctx.fillStyle = '#172414';
        for (let i = 0; i < 7; i++) {
            const angle = -Math.PI * 0.96 + i * (Math.PI * 1.92 / 6);
            this._tracePalmFrond(ctx, crownX + 2, crownY + 4, angle, 39 + (i % 2) * 7, 15);
            ctx.fill();
        }

        const greens = ['#91d34f', '#69b844', '#4a973a', '#2f7532'];
        for (let i = 0; i < 8; i++) {
            const angle = -Math.PI * 0.98 + i * (Math.PI * 1.96 / 7);
            ctx.fillStyle = greens[(i + Math.floor(seed * 4)) % greens.length];
            this._tracePalmFrond(ctx, crownX, crownY, angle, 40 + ((i + 1) % 3) * 8, 13 + (i % 2) * 3);
            ctx.fill();
            ctx.strokeStyle = 'rgba(231, 247, 111, 0.20)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(crownX, crownY);
            ctx.lineTo(crownX + Math.cos(angle) * 28, crownY + Math.sin(angle) * 12);
            ctx.stroke();
        }

        ctx.fillStyle = '#c58a32';
        ctx.beginPath();
        ctx.arc(crownX - 3, crownY + 2, 3, 0, Math.PI * 2);
        ctx.arc(crownX + 4, crownY + 3, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _tracePalmFrond(ctx, x, y, angle, length, width) {
        const tipX = x + Math.cos(angle) * length;
        const tipY = y + Math.sin(angle) * length * 0.52;
        const normalX = -Math.sin(angle);
        const normalY = Math.cos(angle) * 0.52;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(
            x + Math.cos(angle) * length * 0.42 + normalX * width,
            y + Math.sin(angle) * length * 0.26 + normalY * width,
            tipX,
            tipY
        );
        ctx.quadraticCurveTo(
            x + Math.cos(angle) * length * 0.38 - normalX * width * 0.54,
            y + Math.sin(angle) * length * 0.24 - normalY * width * 0.54,
            x,
            y
        );
        ctx.closePath();
    }

    _drawPineSilhouette(ctx, seed) {
        const trunkHeight = 30;
        ctx.fillStyle = '#4a2919';
        ctx.fillRect(-4, -trunkHeight, 8, trunkHeight + 5);
        ctx.fillStyle = '#24130d';
        ctx.fillRect(-4, -trunkHeight, 2, trunkHeight + 4);

        const layers = [
            { y: -70, w: 22, h: 22, color: seed > 0.45 ? '#3f8b42' : '#34783b' },
            { y: -54, w: 30, h: 25, color: seed > 0.50 ? '#2f7437' : '#286832' },
            { y: -36, w: 38, h: 27, color: seed > 0.35 ? '#255d31' : '#1f542e' },
            { y: -17, w: 45, h: 25, color: '#1b4528' },
        ];

        for (const layer of layers) {
            ctx.fillStyle = '#102216';
            this._tracePineLayer(ctx, layer.y + 3, layer.w + 3, layer.h);
            ctx.fill();
            ctx.fillStyle = layer.color;
            this._tracePineLayer(ctx, layer.y, layer.w, layer.h);
            ctx.fill();
            ctx.strokeStyle = 'rgba(158, 214, 91, 0.18)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(-layer.w * 0.34, layer.y + layer.h * 0.34);
            ctx.lineTo(0, layer.y + 3);
            ctx.lineTo(layer.w * 0.28, layer.y + layer.h * 0.30);
            ctx.stroke();
        }
    }

    _tracePineLayer(ctx, y, width, height) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width * 0.52, y + height);
        ctx.lineTo(width * 0.18, y + height - 4);
        ctx.lineTo(width * 0.30, y + height + 4);
        ctx.lineTo(0, y + height - 2);
        ctx.lineTo(-width * 0.30, y + height + 4);
        ctx.lineTo(-width * 0.18, y + height - 4);
        ctx.lineTo(-width * 0.52, y + height);
        ctx.closePath();
    }

    _drawOakSilhouette(ctx, seed) {
        ctx.fillStyle = '#55311d';
        ctx.fillRect(-5, -31, 10, 36);
        ctx.fillStyle = '#2d170e';
        ctx.fillRect(-5, -30, 3, 33);

        const crowns = [
            { x: -17, y: -48, r: 18, color: '#2e6d34' },
            { x: 3, y: -57, r: 22, color: seed > 0.45 ? '#438342' : '#367a3b' },
            { x: 20, y: -43, r: 17, color: '#285f32' },
            { x: -3, y: -34, r: 22, color: '#24582f' },
        ];

        for (const crown of crowns) {
            ctx.fillStyle = '#102214';
            ctx.beginPath();
            ctx.ellipse(crown.x, crown.y + 4, crown.r * 1.05, crown.r * 0.82, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = crown.color;
            ctx.beginPath();
            ctx.ellipse(crown.x, crown.y, crown.r, crown.r * 0.78, 0, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.strokeStyle = 'rgba(180, 222, 99, 0.16)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-14, -56);
        ctx.quadraticCurveTo(1, -67, 16, -55);
        ctx.stroke();
    }
}
