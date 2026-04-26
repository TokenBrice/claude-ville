// BuildingSprite replaces BuildingRenderer. Draws buildings from sprites,
// exposes emitter points for particles, supports occlusion split for hero
// buildings. Reimplements the full BuildingRenderer external surface
// (setBuildings, setAgentSprites, setMotionScale, update, drawShadows,
// drawBubbles, getLightSources, hitTest, hoveredBuilding-as-setHovered).
//
// Roof-fade behaviour is intentionally dropped per spec §3.

import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';

const LANDMARK_LABEL_TYPES = new Set(['command', 'watchtower']);
const LANDMARK_LABEL_ACCENTS = {
    command: '#f6c85f',
    forge: '#f08a4b',
    portal: '#8bd7ff',
    watchtower: '#ffe59a',
    observatory: '#bda7ff',
};

export class BuildingSprite {
    constructor(assets, spriteRenderer, particleSystem) {
        this.assets = assets;
        this.sprites = spriteRenderer;
        this.particles = particleSystem;
        this.buildings = [];
        this.agentSprites = [];
        this.hovered = null;
        this.frame = 0;
        this._drawablesCache = null;
        this.motionScale = (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) ? 0 : 1;
        this._motionMq = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : null;
        this._onMotionChange = (e) => this.setMotionScale(e.matches ? 0 : 1);
        this._motionMq?.addEventListener?.('change', this._onMotionChange);
    }

    dispose() {
        this._motionMq?.removeEventListener?.('change', this._onMotionChange);
    }

    setMotionScale(s) { this.motionScale = s; }

    setBuildings(map) {
        // Accepts a Map (preferred — matches world.buildings) or an Array.
        this.buildings = map instanceof Map ? Array.from(map.values()) : Array.from(map);
        this._drawablesCache = null;
    }

    setAgentSprites(sprites) { this.agentSprites = sprites; }

    // Hover state does NOT invalidate _drawablesCache — drawDrawable reads
    // this.hovered live at draw time, so a fresh enumerate isn't required.
    setHovered(b) { this.hovered = b; }

    update(dt) {
        this.frame += (dt / 16) * (this.motionScale || 0);
        this._drawablesCache = null;        // invalidate once per frame (Phase 2.5.3)
        for (const b of this.buildings) this._spawnEmittersFor(b);
    }

    // Soft drop shadows under each building footprint. Hero buildings use the
    // composed sprite width so the shadow tracks the actual visible footprint
    // rather than the much-smaller tile rect.
    drawShadows(ctx) {
        for (const b of this.buildings) {
            const c = this._buildingScreenCenter(b);
            const tileHalfW = (b.width + b.height) * TILE_WIDTH / 4;
            const dims = this.assets.getDims(`building.${b.type}`);
            const spriteHalfW = dims ? dims.w / 2 : tileHalfW;
            const halfW = Math.max(tileHalfW, spriteHalfW * 0.7);
            const isLandmark = LANDMARK_LABEL_TYPES.has(b.type);
            const isHovered = this.hovered === b;
            ctx.save();
            ctx.fillStyle = 'rgba(15, 22, 30, 0.32)';
            ctx.beginPath();
            ctx.ellipse(Math.round(c.x), Math.round(c.y + 4), halfW, halfW * 0.32, 0, 0, Math.PI * 2);
            ctx.fill();
            if (isLandmark || isHovered) {
                ctx.globalAlpha = isHovered ? 0.82 : 0.46;
                ctx.strokeStyle = isHovered ? 'rgba(255, 232, 166, 0.75)' : 'rgba(213, 169, 88, 0.38)';
                ctx.lineWidth = isHovered ? 2 : 1;
                ctx.beginPath();
                ctx.ellipse(
                    Math.round(c.x),
                    Math.round(c.y + 3),
                    halfW + (isHovered ? 8 : 4),
                    halfW * 0.34 + (isHovered ? 4 : 2),
                    0,
                    0,
                    Math.PI * 2
                );
                ctx.stroke();
            }
            ctx.restore();
        }
    }

    // Persistent building labels (parchment tag + identity badge) above each sprite.
    // Restores parity with the legacy BuildingRenderer label pass and adds a per-type
    // icon glyph so similar-looking sprites stay distinguishable. Drawn as a top overlay
    // (called from IsometricRenderer._render after drawBubbles) so labels stay readable
    // regardless of depth-sort occlusion.
    drawLabels(ctx, { zoom = 1 } = {}) {
        const occupied = [];
        for (const b of this.buildings) {
            if (!b.label) continue;
            const center = this._buildingScreenCenter(b);
            const dims = this.assets.getDims(`building.${b.type}`);
            if (!dims) continue;
            const isHovered = this.hovered === b;
            const isLandmark = LANDMARK_LABEL_TYPES.has(b.type);
            if (!isHovered && !isLandmark && zoom < 3) continue;

            ctx.save();
            const text = this._labelTextFor(b, zoom, isHovered);
            const accent = LANDMARK_LABEL_ACCENTS[b.type] || '#d6a951';
            const labelFont = isHovered || isLandmark
                ? 'bold 8px "Press Start 2P", monospace'
                : '7px "Press Start 2P", monospace';
            const textColor = isHovered ? '#fff6cf' : isLandmark ? '#ffe7a3' : '#e8c982';
            ctx.font = labelFont;
            const tw = ctx.measureText(text).width;
            const iconSize = b.icon ? (isHovered || isLandmark ? 16 : 13) : 0;
            const iconGap = b.icon ? 5 : 0;
            const padX = isHovered || isLandmark ? 8 : 6;
            const tagW = Math.ceil(tw + iconSize + iconGap + padX * 2 + (isLandmark ? 8 : 0));
            const tagH = isHovered ? 20 : isLandmark ? 18 : 14;
            const bx = center.x;
            const by = Math.round(center.y - dims.h - (isHovered ? 34 : isLandmark ? 28 : 24));

            const tagLeft = bx - tagW / 2;
            const tagTop = by - tagH / 2;
            const labelBox = {
                left: tagLeft - 4,
                top: tagTop - 4,
                right: tagLeft + tagW + 4,
                bottom: tagTop + tagH + 10,
            };
            if (!isHovered && occupied.some((box) => this._boxesOverlap(labelBox, box))) {
                continue;
            }
            occupied.push(labelBox);

            // Banner shadow and landmark glow: deliberately map-like rather than debug UI.
            if (isHovered || isLandmark) {
                ctx.fillStyle = isHovered ? 'rgba(242, 211, 107, 0.28)' : 'rgba(214, 169, 81, 0.16)';
                ctx.beginPath();
                ctx.ellipse(bx, by + tagH / 2 + 3, tagW / 2 + 8, isHovered ? 7 : 5, 0, 0, Math.PI * 2);
                ctx.fill();
            }

            const notch = isHovered || isLandmark ? 6 : 4;
            const poleTop = tagTop + tagH - 1;
            const poleBottom = Math.min(center.y - dims.h * 0.52, tagTop + tagH + (isHovered ? 18 : isLandmark ? 14 : 7));

            ctx.globalAlpha = isHovered ? 1 : isLandmark ? 0.92 : 0.78;
            ctx.strokeStyle = isHovered ? 'rgba(255, 242, 197, 0.9)' : isLandmark ? 'rgba(242, 211, 107, 0.72)' : 'rgba(215, 185, 121, 0.62)';
            ctx.lineWidth = isHovered ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(tagLeft + notch, tagTop);
            ctx.lineTo(tagLeft + tagW - notch, tagTop);
            ctx.lineTo(tagLeft + tagW, by);
            ctx.lineTo(tagLeft + tagW - notch, tagTop + tagH);
            ctx.lineTo(tagLeft + notch, tagTop + tagH);
            ctx.lineTo(tagLeft, by);
            ctx.closePath();
            ctx.fillStyle = isHovered
                ? 'rgba(70, 42, 22, 0.97)'
                : isLandmark
                    ? 'rgba(58, 36, 21, 0.93)'
                    : 'rgba(42, 28, 18, 0.88)';
            ctx.fill();
            ctx.stroke();

            if (isHovered || isLandmark) {
                ctx.fillStyle = accent;
                ctx.globalAlpha = isHovered ? 0.95 : 0.72;
                ctx.fillRect(tagLeft + 5, tagTop + 3, tagW - 10, 2);
                ctx.globalAlpha = isHovered ? 1 : 0.92;
            }

            // Identity badge: gold circle with the building's icon glyph.
            if (b.icon) {
                const iconCx = tagLeft + padX + iconSize / 2 + (isLandmark ? 2 : 0);
                const iconCy = by;
                ctx.fillStyle = isHovered ? 'rgba(255, 226, 127, 0.96)' : isLandmark ? accent : 'rgba(214, 169, 81, 0.78)';
                ctx.beginPath();
                ctx.arc(iconCx, iconCy, iconSize / 2, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = 'rgba(43, 28, 17, 0.8)';
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.fillStyle = '#2a1c11';
                ctx.font = `${isHovered || isLandmark ? 10 : 9}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(b.icon, iconCx, iconCy + 0.5);
            }

            // Label text.
            ctx.fillStyle = textColor;
            ctx.font = labelFont;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, tagLeft + padX + iconSize + iconGap + (isLandmark ? 2 : 0), by + 0.5);

            ctx.strokeStyle = isHovered ? 'rgba(255, 242, 197, 0.72)' : isLandmark ? 'rgba(242, 211, 107, 0.5)' : 'rgba(215, 185, 121, 0.26)';
            ctx.lineWidth = isHovered ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(bx, poleTop);
            ctx.lineTo(bx, poleBottom);
            ctx.stroke();

            ctx.fillStyle = isHovered ? 'rgba(255, 232, 166, 0.62)' : 'rgba(151, 99, 43, 0.46)';
            ctx.beginPath();
            ctx.ellipse(bx, poleBottom + 1, isHovered ? 5 : 3, isHovered ? 2 : 1.5, 0, 0, Math.PI * 2);
            ctx.fill();

            ctx.restore();
        }
    }

    // Vector chat bubbles preserved (parchment-style overlay).
    // Ported from BuildingRenderer.drawBubbles (legacy file lines 3215-3256),
    // swapping `style.wallHeight` for sprite `dims.h` to anchor above the sprite top.
    drawBubbles(ctx, world) {
        for (const b of this.buildings) {
            const agentsInBuilding = [];
            for (const agent of world.agents.values()) {
                if (b.containsPoint(agent.position.tileX, agent.position.tileY)) {
                    agentsInBuilding.push(agent);
                }
            }
            if (agentsInBuilding.length === 0) continue;
            const center = this._buildingScreenCenter(b);
            const dims = this.assets.getDims(`building.${b.type}`);
            if (!dims) continue;
            const text = `${agentsInBuilding.length} agent${agentsInBuilding.length > 1 ? 's' : ''}`;
            ctx.save();
            ctx.font = '7px sans-serif';
            const tw = ctx.measureText(text).width + 8;
            const bx = center.x;
            const by = center.y - dims.h - 10;     // anchor above sprite top
            ctx.fillStyle = 'rgba(48, 31, 19, 0.94)';
            ctx.strokeStyle = '#d7b979';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(bx - tw / 2, by - 7);
            ctx.lineTo(bx + tw / 2, by - 7);
            ctx.lineTo(bx + tw / 2 + 4, by - 3);
            ctx.lineTo(bx + tw / 2 + 4, by + 5);
            ctx.lineTo(bx + 4, by + 5);
            ctx.lineTo(bx, by + 10);
            ctx.lineTo(bx - 4, by + 5);
            ctx.lineTo(bx - tw / 2 - 4, by + 5);
            ctx.lineTo(bx - tw / 2 - 4, by - 3);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#f3e2bd';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, bx, by);
            ctx.restore();
        }
    }

    // Light sources for water/wall additive light passes (Phase 2.5.5).
    // `overlay` is the atmosphere sprite id used for the additive reflection;
    // defaults to the lighthouse beam when the manifest entry omits it.
    getLightSources() {
        const out = [];
        for (const b of this.buildings) {
            const entry = this.assets.getEntry(`building.${b.type}`);
            if (!entry?.lightSource) continue;
            const c = this._buildingScreenCenter(b);
            const baseAnchor = this.assets.getAnchor(entry.id);
            const [lx, ly] = entry.lightSource;
            out.push({
                x: c.x - baseAnchor[0] + lx,
                y: c.y - baseAnchor[1] + ly,
                color: entry.lightColor || 'rgba(255,210,140,0.4)',
                radius: entry.lightRadius || 64,
                overlay: entry.lightOverlay || 'atmosphere.light.lighthouse-beam',
            });
        }
        return out;
    }

    // Per-pixel hit test across all buildings (front halves only).
    hitTest(worldX, worldY) {
        const drawables = this.enumerateDrawables();
        for (let i = drawables.length - 1; i >= 0; i--) {
            const d = drawables[i];
            if (d.kind === 'building-back') continue;
            const id = d.entry.id;
            const [ax, ay] = this.assets.getAnchor(id);
            if (this.sprites.hitTest(id, worldX, worldY, d.wx - ax, d.wy - ay)) {
                return d.building;
            }
        }
        return null;
    }

    // Returns drawables (one per building, or two if splitForOcclusion).
    // Memoized per frame; invalidated by update().
    enumerateDrawables() {
        if (this._drawablesCache) return this._drawablesCache;
        const out = [];
        for (const b of this.buildings) {
            const entry = this.assets.getEntry(`building.${b.type}`);
            if (!entry) continue;
            const center = this._buildingScreenCenter(b);
            const wx = center.x;
            const wy = center.y;
            if (entry.splitForOcclusion) {
                const dims = this.assets.getDims(entry.id);
                // Clamp manifest horizonY to a valid sub-rect inside the sprite so
                // the front half (`drawImage(... , h - horizonY, ...)`) never receives
                // a negative or zero source-rect height when manifest values drift.
                const rawHorizon = entry.horizonY ?? Math.floor(dims.h / 2);
                const horizonY = Math.max(1, Math.min(rawHorizon, dims.h - 1));
                out.push({ kind: 'building-back', building: b, entry, wx, wy, horizonY, sortY: wy - dims.h / 2 });
                out.push({ kind: 'building-front', building: b, entry, wx, wy, horizonY, sortY: wy });
            } else {
                out.push({ kind: 'building', building: b, entry, wx, wy, sortY: wy });
            }
        }
        this._drawablesCache = out;
        return out;
    }

    drawDrawable(ctx, d) {
        const id = d.entry.id;
        if (d.kind === 'building') {
            this.sprites.drawSprite(ctx, id, d.wx, d.wy);
            this._drawAnimatedOverlays(ctx, d.entry, d.wx, d.wy);
        } else {
            const dims = this.assets.getDims(id);
            const [ax, ay] = this.assets.getAnchor(id);
            const dx = Math.round(d.wx - ax);
            const dy = Math.round(d.wy - ay);
            const img = this.assets.get(id);
            if (!img) return;
            if (d.kind === 'building-back') {
                ctx.drawImage(img, 0, 0, dims.w, d.horizonY, dx, dy, dims.w, d.horizonY);
            } else {
                ctx.drawImage(img, 0, d.horizonY, dims.w, dims.h - d.horizonY,
                                   dx, dy + d.horizonY, dims.w, dims.h - d.horizonY);
                this._drawAnimatedOverlays(ctx, d.entry, d.wx, d.wy);
            }
        }
        if (this.hovered === d.building) this.sprites.drawOutline(ctx, id, d.wx, d.wy);
    }

    _drawAnimatedOverlays(ctx, entry, wx, wy) {
        if (!entry.layers) return;
        const baseAnchor = this.assets.getAnchor(entry.id);
        for (const [name, layer] of Object.entries(entry.layers)) {
            if (name === 'base') continue;
            const layerId = `${entry.id}.${name}`;
            const layerDims = this.assets.getDims(layerId);
            if (!layerDims) continue;
            const [ax, ay] = layer.anchor || [0, 0];
            const overlayWx = wx - baseAnchor[0] + ax + layerDims.w / 2;
            const overlayWy = wy - baseAnchor[1] + ay + layerDims.h;
            // Animated pulse: fade alpha by sine of frame.
            // 0.08 rad/frame ≈ 1.27 Hz at 60fps (slow heartbeat).
            let alpha = 1;
            if (layer.animation === 'pulse') {
                alpha = 0.6 + 0.4 * Math.sin(this.frame * 0.08);
            }
            this.sprites.drawSprite(ctx, layerId, overlayWx, overlayWy, { alpha });
        }
    }

    _spawnEmittersFor(b) {
        const entry = this.assets.getEntry(`building.${b.type}`);
        if (!entry?.emitters || !this.motionScale) return;
        const center = this._buildingScreenCenter(b);
        const baseAnchor = this.assets.getAnchor(entry.id);
        for (const [particleType, [lx, ly]] of Object.entries(entry.emitters)) {
            // Stochastic spawn rate matching legacy BuildingRenderer emitters
            // (~0.04 → ~2.4 spawns per emitter per second at 60fps).
            if (Math.random() > 0.04) continue;
            const wx = center.x - baseAnchor[0] + lx;
            const wy = center.y - baseAnchor[1] + ly;
            this.particles.spawn(particleType, wx, wy, 1);
        }
    }

    _buildingScreenCenter(b) {
        const cx = b.position.tileX + b.width / 2;
        const cy = b.position.tileY + b.height / 2;
        return {
            x: (cx - cy) * TILE_WIDTH / 2,
            y: (cx + cy) * TILE_HEIGHT / 2,
        };
    }

    _labelTextFor(building, zoom, isHovered) {
        const label = String(building.label || '');
        if (isHovered || zoom >= 2) return label;
        if (label.length <= 14) return label;
        const words = label.split(/\s+/).filter(Boolean);
        if (words.length <= 1) return label.slice(0, 12);
        return words
            .map((word) => word[0])
            .join('');
    }

    _boxesOverlap(a, b) {
        return a.left < b.right
            && a.right > b.left
            && a.top < b.bottom
            && a.bottom > b.top;
    }
}
