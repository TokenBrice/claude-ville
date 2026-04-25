// BuildingSprite replaces BuildingRenderer. Draws buildings from sprites,
// exposes emitter points for particles, supports occlusion split for hero
// buildings. Reimplements the full BuildingRenderer external surface
// (setBuildings, setAgentSprites, setMotionScale, update, drawShadows,
// drawBubbles, getLightSources, hitTest, hoveredBuilding-as-setHovered).
//
// Roof-fade behaviour is intentionally dropped per spec §3.

import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';

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

    // Soft drop shadows under each building footprint.
    drawShadows(ctx) {
        for (const b of this.buildings) {
            const c = this._buildingScreenCenter(b);
            const halfW = (b.width + b.height) * TILE_WIDTH / 4;
            ctx.save();
            ctx.fillStyle = 'rgba(15, 22, 30, 0.32)';
            ctx.beginPath();
            ctx.ellipse(Math.round(c.x), Math.round(c.y + 4), halfW, halfW * 0.32, 0, 0, Math.PI * 2);
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
                const horizonY = entry.horizonY ?? Math.floor(dims.h / 2);
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
}
