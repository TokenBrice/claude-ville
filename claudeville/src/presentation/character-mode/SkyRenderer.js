// claudeville/src/presentation/character-mode/SkyRenderer.js
//
// Drawn first thing in IsometricRenderer._render() before the camera
// transform — viewport-fixed.

export class SkyRenderer {
    constructor({ assets } = {}) {
        this.assets = assets || null;
        this.cache = null;
        this.cacheKey = '';
        this._cloudOffset = 0;
    }

    draw(ctx, canvas) {
        ctx.fillStyle = '#ff00ff'; // sentinel magenta — replaced in Task 3
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
}
