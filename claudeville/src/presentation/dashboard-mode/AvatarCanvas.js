/**
 * Mini character avatar canvas for the dashboard
 * Static recreation of AgentSprite drawing logic
 */
import { getModelVisualIdentity } from '../shared/ModelVisualIdentity.js';

let SPRITE_ASSET_VERSION_PROMISE = null;
let SPRITE_ASSET_VERSION = '2026-04-26-visual-revamp'; // overwritten asynchronously on first load
const AVATAR_CANVASES = new Set();

async function getSpriteAssetVersion() {
    if (!SPRITE_ASSET_VERSION_PROMISE) {
        SPRITE_ASSET_VERSION_PROMISE = fetch('assets/sprites/manifest.yaml')
            .then(r => r.text())
            .then(text => {
                const m = text.match(/^\s*assetVersion:\s*"([^"]+)"/m);
                return m ? m[1] : 'unknown';
            })
            .catch(() => 'unknown');
    }
    return SPRITE_ASSET_VERSION_PROMISE;
}

getSpriteAssetVersion().then(v => {
    const previous = SPRITE_ASSET_VERSION;
    SPRITE_ASSET_VERSION = v;
    if (previous === v) return;
    for (const avatar of AVATAR_CANVASES) avatar._onSpriteAssetVersionChanged(previous, v);
});

const SPRITE_IMAGE_CACHE = new Map();
const SPRITE_BOUNDS_CACHE = new Map();

function loadSpriteImage(spriteId) {
    const key = `${spriteId}|${SPRITE_ASSET_VERSION}`;
    const cached = SPRITE_IMAGE_CACHE.get(key);
    if (cached) return cached;

    const image = new Image();
    const record = {
        image,
        loaded: false,
        failed: false,
        promise: null,
    };
    record.promise = new Promise((resolve) => {
        image.onload = () => {
            record.loaded = true;
            resolve(record);
        };
        image.onerror = () => {
            record.failed = true;
            resolve(record);
        };
    });
    image.src = `assets/sprites/characters/${spriteId}/sheet.png?v=${SPRITE_ASSET_VERSION}`;
    SPRITE_IMAGE_CACHE.set(key, record);
    return record;
}

export class AvatarCanvas {
    constructor(agent) {
        this.agent = agent;
        this.canvas = document.createElement('canvas');
        this.canvas.width = 44;
        this.canvas.height = 52;
        this.canvas.style.width = '44px';
        this.canvas.style.height = '52px';
        this.canvas.style.imageRendering = 'pixelated';
        this.spriteImage = null;
        this.spriteId = null;
        this.spriteAssetVersion = null;
        this.spriteFailed = false;
        AVATAR_CANVASES.add(this);
        this.draw();
    }

    draw() {
        const ctx = this.canvas.getContext('2d');
        const w = this.canvas.width;
        const h = this.canvas.height;
        const app = this.agent.appearance;
        const identity = getModelVisualIdentity(this.agent.model, this.agent.effort, this.agent.provider);
        const trim = identity.trim?.[0] || app.shirt;
        const accent = identity.accent?.[0] || app.skin;

        ctx.clearRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = false;

        if (this._drawGeneratedSprite(ctx, identity, accent)) {
            return;
        }

        ctx.save();
        ctx.translate(w / 2, h / 2 + 4);

        // Scale up for visibility
        const scale = 1.3;
        ctx.scale(scale, scale);

        // Legs
        ctx.strokeStyle = app.pants;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-3, 8);
        ctx.lineTo(-4, 16);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(3, 8);
        ctx.lineTo(4, 16);
        ctx.stroke();

        // Body
        ctx.fillStyle = identity.family === 'codex' || identity.family === 'claude' || identity.family === 'kimi' ? trim : app.shirt;
        ctx.fillRect(-5, -2, 10, 12);
        this._drawModelInsignia(ctx, identity, accent, trim);

        // Arms
        ctx.strokeStyle = app.skin;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-5, 0);
        ctx.lineTo(-8, 7);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(5, 0);
        ctx.lineTo(8, 7);
        ctx.stroke();

        // Head
        ctx.fillStyle = app.skin;
        ctx.beginPath();
        ctx.arc(0, -6, 5, 0, Math.PI * 2);
        ctx.fill();

        // Hair
        ctx.fillStyle = app.hair;
        switch (app.hairStyle) {
            case 'short':
                ctx.beginPath();
                ctx.arc(0, -8, 5, Math.PI, 0);
                ctx.fill();
                break;
            case 'long':
                ctx.beginPath();
                ctx.arc(0, -8, 5, Math.PI, 0);
                ctx.fill();
                ctx.fillRect(-5, -8, 2, 8);
                ctx.fillRect(3, -8, 2, 8);
                break;
            case 'spiky':
                ctx.beginPath();
                ctx.moveTo(-4, -8);
                ctx.lineTo(-2, -14);
                ctx.lineTo(0, -9);
                ctx.lineTo(2, -14);
                ctx.lineTo(4, -8);
                ctx.fill();
                break;
            case 'mohawk':
                ctx.fillRect(-1, -14, 2, 6);
                break;
        }

        // Eyes
        ctx.fillStyle = '#000';
        switch (app.eyeStyle) {
            case 'normal':
                ctx.fillRect(-3, -7, 2, 2);
                ctx.fillRect(1, -7, 2, 2);
                break;
            case 'happy':
                ctx.lineWidth = 0.8;
                ctx.strokeStyle = '#000';
                ctx.beginPath();
                ctx.arc(-2, -6, 1.5, 0, Math.PI);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(2, -6, 1.5, 0, Math.PI);
                ctx.stroke();
                break;
            case 'determined':
                ctx.fillRect(-3, -7, 2, 1.5);
                ctx.fillRect(1, -7, 2, 1.5);
                break;
            case 'sleepy':
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(-3, -6);
                ctx.lineTo(-1, -6);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(1, -6);
                ctx.lineTo(3, -6);
                ctx.stroke();
                break;
        }

        this._drawModelHeadgear(ctx, identity, accent, trim, app);

        ctx.restore();
    }

    _drawGeneratedSprite(ctx, identity, accent) {
        const spriteId = identity.spriteId;
        if (!spriteId || this.spriteFailed) return false;
        if (!this._ensureSpriteImage(spriteId)) return false;
        if (!this.spriteImage.complete || !this.spriteImage.naturalWidth) return false;

        const cellSize = Math.floor(this.spriteImage.naturalWidth / 8);
        if (!Number.isFinite(cellSize) || cellSize <= 0) return false;
        const sourceRow = 6; // idle, south-facing frame: matches SpriteSheet.js layout.
        const bounds = this._spriteFrameBounds(cellSize, sourceRow);
        const sourceW = bounds.maxX - bounds.minX + 1;
        const sourceH = bounds.maxY - bounds.minY + 1;
        const targetH = 46;
        const scale = targetH / Math.max(1, sourceH);
        const targetW = Math.min(40, Math.round(sourceW * scale));
        const dx = Math.round((this.canvas.width - targetW) / 2);
        const dy = Math.round(this.canvas.height - targetH - 3);

        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
        ctx.beginPath();
        ctx.ellipse(this.canvas.width / 2, this.canvas.height - 5, 14, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.drawImage(
            this.spriteImage,
            bounds.minX,
            sourceRow * cellSize + bounds.minY,
            sourceW,
            sourceH,
            dx,
            dy,
            targetW,
            targetH
        );
        this._drawEffortCrest(ctx, identity, accent);
        ctx.restore();
        return true;
    }

    _ensureSpriteImage(spriteId) {
        if (this.spriteImage && this.spriteId === spriteId && this.spriteAssetVersion === SPRITE_ASSET_VERSION) return true;
        this.spriteId = spriteId;
        this.spriteAssetVersion = SPRITE_ASSET_VERSION;
        this.spriteFailed = false;
        const record = loadSpriteImage(spriteId);
        this.spriteImage = record.image;
        if (record.failed) {
            this.spriteFailed = true;
            return false;
        }
        if (record.loaded || (record.image.complete && record.image.naturalWidth)) return true;
        record.promise.then(() => this.draw());
        return false;
    }

    _onSpriteAssetVersionChanged() {
        if (!this.spriteId || this.spriteAssetVersion === SPRITE_ASSET_VERSION) return;
        this.spriteImage = null;
        this.spriteFailed = false;
        this.draw();
    }

    _spriteFrameBounds(cellSize, sourceRow) {
        const key = `${this.spriteId}|${SPRITE_ASSET_VERSION}|${cellSize}|${sourceRow}`;
        const cached = SPRITE_BOUNDS_CACHE.get(key);
        if (cached) return cached;

        const scratch = document.createElement('canvas');
        scratch.width = cellSize;
        scratch.height = cellSize;
        const ctx = scratch.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.spriteImage, 0, sourceRow * cellSize, cellSize, cellSize, 0, 0, cellSize, cellSize);
        const data = ctx.getImageData(0, 0, cellSize, cellSize).data;
        let minX = cellSize;
        let minY = cellSize;
        let maxX = 0;
        let maxY = 0;
        for (let y = 0; y < cellSize; y++) {
            for (let x = 0; x < cellSize; x++) {
                const alpha = data[((cellSize * y + x) << 2) + 3];
                if (alpha <= 16) continue;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
        }
        if (minX > maxX || minY > maxY) {
            SPRITE_BOUNDS_CACHE.set(key, { minX: 0, minY: 0, maxX: cellSize - 1, maxY: cellSize - 1 });
        } else {
            SPRITE_BOUNDS_CACHE.set(key, {
                minX: Math.max(0, minX - 2),
                minY: Math.max(0, minY - 2),
                maxX: Math.min(cellSize - 1, maxX + 2),
                maxY: Math.min(cellSize - 1, maxY + 1),
            });
        }
        return SPRITE_BOUNDS_CACHE.get(key);
    }

    _drawEffortCrest(ctx, identity, accent) {
        if (identity.showDashboardEffortCrest === false) return;
        if (!identity.effortTier || identity.effortTier === 'none') return;
        const cx = this.canvas.width - 9;
        const cy = 10;
        ctx.strokeStyle = '#120d09';
        ctx.fillStyle = accent;
        ctx.lineWidth = 2;
        if (identity.effortTier === 'xhigh') {
            ctx.beginPath();
            ctx.arc(cx, cy, 6, 0, Math.PI * 2);
            ctx.stroke();
            ctx.lineWidth = 1;
            ctx.strokeStyle = accent;
            ctx.stroke();
            return;
        }
        if (identity.effortTier === 'high') {
            ctx.beginPath();
            ctx.moveTo(cx - 5, cy + 4);
            ctx.lineTo(cx, cy - 6);
            ctx.lineTo(cx + 5, cy + 4);
            ctx.closePath();
            ctx.stroke();
            ctx.fill();
            return;
        }
        if (identity.effortTier === 'medium') {
            ctx.fillRect(cx - 5, cy - 1, 10, 3);
            return;
        }
        if (identity.effortTier === 'low') {
            ctx.fillRect(cx - 2, cy - 1, 4, 3);
        }
    }

    _drawModelInsignia(ctx, identity, accent, trim) {
        if (identity.modelClass === 'opus') {
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, -2);
            ctx.lineTo(4, 3);
            ctx.lineTo(0, 9);
            ctx.lineTo(-4, 3);
            ctx.closePath();
            ctx.stroke();
            ctx.fillStyle = '#ffe7a8';
            ctx.fillRect(-1, 3, 2, 3);
            return;
        }

        if (identity.modelClass === 'sonnet') {
            ctx.fillStyle = accent;
            ctx.fillRect(-3, 0, 6, 2);
            ctx.strokeStyle = '#fff4cf';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(-4, 7);
            ctx.lineTo(4, 1);
            ctx.stroke();
            return;
        }

        if (identity.modelClass === 'haiku') {
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.moveTo(-3, 4);
            ctx.lineTo(3, 4);
            ctx.lineTo(0, 8);
            ctx.closePath();
            ctx.fill();
            return;
        }

        if (identity.modelClass === 'spark') {
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.moveTo(1, -1);
            ctx.lineTo(5, -1);
            ctx.lineTo(2, 3);
            ctx.lineTo(5, 3);
            ctx.lineTo(-1, 9);
            ctx.lineTo(1, 5);
            ctx.lineTo(-3, 5);
            ctx.closePath();
            ctx.fill();
            return;
        }

        if (identity.modelClass === 'gpt55') {
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(4, 4);
            ctx.lineTo(0, 8);
            ctx.lineTo(-4, 4);
            ctx.closePath();
            ctx.stroke();
            ctx.fillStyle = trim;
            ctx.fillRect(-1, 3, 2, 2);
            return;
        }

        if (identity.modelClass === 'gpt54') {
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(0, 4, 4, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = trim;
            ctx.fillRect(-1, 1, 2, 6);
        }
    }

    _drawModelHeadgear(ctx, identity, accent, trim, app) {
        if (identity.effortTier === 'xhigh') {
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.arc(0, -14, 6, 0, Math.PI * 2);
            ctx.stroke();
        } else if (identity.effortTier === 'high') {
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.moveTo(-5, -12);
            ctx.lineTo(0, -17);
            ctx.lineTo(5, -12);
            ctx.closePath();
            ctx.fill();
        } else if (identity.effortTier === 'medium') {
            ctx.fillStyle = trim;
            ctx.fillRect(-5, -13, 10, 2);
        } else if (identity.effortTier === 'low') {
            ctx.fillStyle = trim;
            ctx.fillRect(-2, -13, 4, 2);
        }

        if (identity.modelClass === 'haiku') {
            // small hooded cap, no brim — apprentice tier
            ctx.fillStyle = trim;
            ctx.beginPath();
            ctx.moveTo(-4, -10);
            ctx.lineTo(0, -13);
            ctx.lineTo(4, -10);
            ctx.lineTo(2, -7);
            ctx.lineTo(-2, -7);
            ctx.closePath();
            ctx.fill();
            return;
        }

        if (identity.family === 'claude') {
            ctx.fillStyle = trim;
            ctx.beginPath();
            ctx.moveTo(-6, -10);
            ctx.lineTo(0, -16);
            ctx.lineTo(6, -10);
            ctx.lineTo(3, -8);
            ctx.lineTo(-3, -8);
            ctx.closePath();
            ctx.fill();
            return;
        }

        if (identity.family === 'codex') {
            ctx.strokeStyle = '#182b31';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.rect(-4, -8, 3, 3);
            ctx.rect(1, -8, 3, 3);
            ctx.moveTo(-1, -6.5);
            ctx.lineTo(1, -6.5);
            ctx.stroke();
            return;
        }

        switch (app.accessory) {
            case 'crown':
                ctx.fillStyle = '#ffd700';
                ctx.fillRect(-4, -14, 8, 2);
                break;
            case 'hat':
                ctx.fillStyle = '#8b4513';
                ctx.fillRect(-6, -12, 12, 2);
                ctx.fillRect(-3, -16, 6, 4);
                break;
        }
    }

    destroy() {
        AVATAR_CANVASES.delete(this);
    }
}
