// claudeville/src/presentation/character-mode/SkyRenderer.js
//
// Drawn first thing in IsometricRenderer._render() before the camera
// transform — viewport-fixed.

const PALETTE = {
    zenith: '#1e0f08',
    upperBand: '#3d1c0c',
    midBand: '#7a3a14',
    horizon: '#c85a18',
    starWarm: '#f5e8c0',
    starHot: '#f5c84a',
};

// Demoted distant glow rather than UI-looking discs: large radii, low alphas.
const HALO_POSITIONS = [
    { fx: 0.18, fy: 0.22, radiusPx: 110, color: '245, 144, 26', alpha: 0.16 },
    { fx: 0.74, fy: 0.30, radiusPx: 90,  color: '245, 200, 74', alpha: 0.13 },
];

const STAR_COUNT = 80;
const STAR_CEILING_FRAC = 0.58;

export class SkyRenderer {
    constructor({ assets } = {}) {
        this.assets = assets || null;
        this.cache = null;
        this.cacheKey = '';
        this._cloudOffset = 0;
    }

    draw(ctx, camera, canvas) {
        const cached = this._getCachedBackground(canvas);
        ctx.drawImage(cached, 0, 0);
        // Cloud + moon overlays added in Task 6.
    }

    _getCachedBackground(canvas) {
        const key = `${canvas.width}x${canvas.height}`;
        if (this.cache && this.cacheKey === key) return this.cache;
        const off = document.createElement('canvas');
        off.width = canvas.width;
        off.height = canvas.height;
        const o = off.getContext('2d');
        this._paintGradient(o, canvas);
        this._paintHalos(o, canvas);
        this._paintStars(o, canvas);
        this.cache = off;
        this.cacheKey = key;
        return off;
    }

    _paintGradient(ctx, canvas) {
        const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
        g.addColorStop(0.00, PALETTE.zenith);
        g.addColorStop(0.45, PALETTE.upperBand);
        g.addColorStop(0.78, PALETTE.midBand);
        g.addColorStop(1.00, PALETTE.horizon);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    _paintHalos(ctx, canvas) {
        for (const halo of HALO_POSITIONS) {
            const cx = halo.fx * canvas.width;
            const cy = halo.fy * canvas.height;
            const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, halo.radiusPx);
            grad.addColorStop(0, `rgba(${halo.color}, ${halo.alpha})`);
            grad.addColorStop(1, `rgba(${halo.color}, 0)`);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
    }

    _paintStars(ctx, canvas) {
        // Tiny LCG keeps the star field identical across reloads / resizes.
        const ceilingY = canvas.height * STAR_CEILING_FRAC;
        let seed = 12345;
        const next = () => {
            seed = (seed * 9301 + 49297) % 233280;
            return seed / 233280;
        };
        for (let i = 0; i < STAR_COUNT; i++) {
            const x = Math.round(next() * canvas.width);
            const y = Math.round(next() * ceilingY);
            const hot = next() < 0.18;
            const size = hot ? 2 : 1;
            ctx.fillStyle = hot ? PALETTE.starHot : PALETTE.starWarm;
            ctx.fillRect(x, y, size, size);
        }
    }
}
