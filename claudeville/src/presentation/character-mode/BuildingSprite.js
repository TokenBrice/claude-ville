// BuildingSprite replaces BuildingRenderer. Draws buildings from sprites,
// exposes emitter points for particles, supports occlusion split for hero
// buildings. Reimplements the full BuildingRenderer external surface
// (setBuildings, setAgentSprites, setMotionScale, update, drawShadows,
// drawBubbles, getLightSources, hitTest, hoveredBuilding-as-setHovered).
//
// Roof-fade behaviour is intentionally dropped per spec §3.

import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { BUILDING_DEFS } from '../../config/buildings.js';

const LANDMARK_LABEL_TYPES = new Set(
    BUILDING_DEFS
        .filter((b) => b.labelPriority === 'landmark')
        .map((b) => b.type),
);
const LABEL_VISIBLE_ZOOM = 2;
const LABEL_DETAIL_ZOOM = 3;
const LABEL_OVERLAP_TOLERANCE = 0.45;
const LABEL_COMPACT_OVERLAP_TOLERANCE = 0.62;
const LABEL_SHORT_TEXT = Object.fromEntries(
    BUILDING_DEFS
        .filter((building) => typeof building.shortLabel === 'string' && building.shortLabel.trim())
        .map((building) => [building.type, building.shortLabel.trim().toUpperCase()]),
);
const LANDMARK_LABEL_ACCENTS = {
    command: '#f6c85f',
    forge: '#f08a4b',
    portal: '#8bd7ff',
    watchtower: '#ffe59a',
    observatory: '#bda7ff',
    mine: '#ffab47',
    taskboard: '#8bd7ff',
    chathall: '#ffeb8f',
    archive: '#b3d68c',
    alchemy: '#d6a5ff',
    sanctuary: '#95e0d2',
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
        this._lightSourcesCache = null;
        this._labelMetricsCache = new Map();
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
        this._lightSourcesCache = null;
        this._labelMetricsCache.clear();
    }

    setAgentSprites(sprites) { this.agentSprites = sprites; }

    // Hover state does NOT invalidate _drawablesCache — drawDrawable reads
    // this.hovered live at draw time, so a fresh enumerate isn't required.
    setHovered(b) { this.hovered = b; }

    update(dt) {
        this.frame += (dt / 16) * (this.motionScale || 0);
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
    drawLabels(ctx, { zoom = 1, occupiedBoxes = [] } = {}) {
        const occupied = [];
        const normalizedOccupiedBoxes = this._normalizeBoxes(occupiedBoxes);
        const buildingList = [...this.buildings].sort((a, b) => {
            const ac = this._buildingScreenCenter(a);
            const bc = this._buildingScreenCenter(b);
            return ac.y - bc.y;
        });

        for (const b of buildingList) {
            const rawLabel = this._resolveBuildingLabelText(b);
            if (!rawLabel) continue;
            const center = this._buildingScreenCenter(b);
            const dims = this.assets.getDims(`building.${b.type}`);
            if (!dims) continue;
            const isHovered = this.hovered === b;
            const isLandmark = b.labelPriority === 'landmark' || LANDMARK_LABEL_TYPES.has(b.type);
            if (!isHovered && !isLandmark && zoom < LABEL_VISIBLE_ZOOM) continue;
            const localLabelDensity = this._estimateLocalLabelDensity(occupied, center.x, center.y);

            ctx.save();
            const accent = LANDMARK_LABEL_ACCENTS[b.type] || '#d6a951';
            const textColor = isHovered ? '#fff6cf' : isLandmark ? '#ffe7a3' : '#e8c982';
            const baseY = Math.round(center.y - dims.h - (isHovered ? 34 : isLandmark ? 28 : 24));
            const baseX = center.x;

            const blocksAgentRectangles = isHovered || (isLandmark && zoom >= LABEL_DETAIL_ZOOM);
            const labelAttempts = this._labelRenderAttempts(b, {
                isHovered,
                isLandmark,
                zoom,
                localLabelDensity,
            });
            let chosen = null;

            for (const attempt of labelAttempts) {
                ctx.font = attempt.labelFont;
                const { displayText, width: tw } = this._labelMetrics(ctx, b, {
                    text: attempt.text,
                    labelFont: attempt.labelFont,
                    maxTextWidth: attempt.maxTextWidth,
                    zoom,
                    isHovered,
                    isLandmark,
                });
                const tagW = Math.ceil(tw + attempt.iconSize + attempt.iconGap + attempt.padX * 2 + (isLandmark ? 8 : 0));
                const tagH = attempt.tagH;
                const layout = this._resolveLabelLayout({
                    candidates: this._labelLayoutCandidates(isLandmark, isHovered),
                    occupied,
                    occupiedExternal: blocksAgentRectangles ? normalizedOccupiedBoxes : [],
                    centerX: baseX,
                    centerY: baseY,
                    tagW,
                    tagH,
                    isLandmark,
                    maxOverlap: attempt.overlapTolerance,
                    localLabelDensity,
                });
                if (!layout) continue;

                const bx = layout.x;
                const by = layout.y;
                const tagLeft = bx - tagW / 2;
                const tagTop = by - tagH / 2;
                const labelBox = layout.box || {
                    left: tagLeft - 4,
                    top: tagTop - 4,
                    right: tagLeft + tagW + 4,
                    bottom: tagTop + tagH + 10,
                };
                const labelOverlap = layout.overlap != null ? layout.overlap : this._boxesOverlapRatio(labelBox, occupied);
                if (labelOverlap > attempt.overlapTolerance) {
                    continue;
                }
                if (blocksAgentRectangles && attempt.blockAgents && this._boxesOverlapRatio(labelBox, normalizedOccupiedBoxes) > attempt.overlapTolerance) {
                    continue;
                }
                chosen = {
                    ...attempt,
                    displayText,
                    tagW,
                    tagH,
                    bx,
                    by,
                    tagLeft,
                    tagTop,
                    labelBox,
                    layout,
                };
                break;
            }

            if (!chosen) {
                continue;
            }
            const {
                displayText,
                tagW,
                tagH,
                bx,
                by,
                tagLeft,
                tagTop,
                labelBox,
                iconSize,
                iconGap,
                padX,
                degraded = false,
                labelFont: chosenFont,
            } = chosen;
            occupied.push(labelBox);
            const labelAlpha = degraded ? 0.52 : 1;
            const glowAlpha = degraded ? 0.55 : (isHovered ? 1 : 0.92);

            // Banner shadow and landmark glow: deliberately map-like rather than debug UI.
            if (isHovered || isLandmark) {
                ctx.fillStyle = isHovered
                    ? 'rgba(242, 211, 107, 0.28)'
                    : `rgba(214, 169, 81, ${isLandmark ? 0.08 : 0.16})`;
                ctx.beginPath();
                ctx.ellipse(bx, by + tagH / 2 + 3, tagW / 2 + 8, isHovered ? 7 : 5, 0, 0, Math.PI * 2);
                ctx.fill();
            }

            const notch = isHovered || isLandmark ? 6 : 4;
            const poleTop = tagTop + tagH - 1;
            const poleBottom = Math.min(center.y - dims.h * 0.52, tagTop + tagH + (isHovered ? 18 : isLandmark ? 14 : 7));

            ctx.globalAlpha = isHovered ? 1 : degraded ? labelAlpha : isLandmark ? 0.92 : 0.78;
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
                ctx.globalAlpha = isHovered ? 0.95 : glowAlpha;
                ctx.fillRect(tagLeft + 5, tagTop + 3, tagW - 10, 2);
                ctx.globalAlpha = isHovered ? 1 : glowAlpha;
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
                ctx.font = `bold ${chosen.iconFont || 9}px "Press Start 2P", monospace`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(b.icon, iconCx, iconCy + 0.5);
            }

            // Label text.
            ctx.save();
            ctx.fillStyle = textColor;
            ctx.font = chosenFont;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
            ctx.shadowBlur = 4;
            ctx.shadowOffsetY = 1;
            ctx.fillText(displayText, tagLeft + padX + iconSize + iconGap + (isLandmark ? 2 : 0), by + 0.5);
            ctx.restore();

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

    _labelLayoutCandidates(isLandmark, isHovered) {
        const major = isLandmark || isHovered;
        const drift = major ? 9 : 7;
        return [
            { dx: 0, dy: 0 },
            { dx: -drift, dy: -9 },
            { dx: drift, dy: -9 },
            { dx: -drift, dy: 9 },
            { dx: drift, dy: 9 },
            { dx: major ? 0 : -4, dy: -14 },
            { dx: major ? 0 : 4, dy: -14 },
            { dx: 0, dy: major ? 18 : 14 },
            { dx: -drift, dy: major ? 18 : 14 },
            { dx: drift, dy: major ? 18 : 14 },
            { dx: major ? 0 : -6, dy: major ? 26 : 19 },
            { dx: major ? 0 : 6, dy: major ? 26 : 19 },
            { dx: -drift, dy: -18 },
            { dx: drift, dy: -18 },
        ];
    }

    _labelRenderAttempts(building, { isHovered, isLandmark, zoom, localLabelDensity = 0 }) {
        const baseText = this._labelTextFor(building, zoom, isHovered);
        const compactText = this._labelTextFor(building, LABEL_VISIBLE_ZOOM, false);
        const tinyText = this._labelTinyTextFor(building, compactText);
        const densityPacked = localLabelDensity >= 2;
        const widthScale = densityPacked ? 0.86 : 1;
        const scale = densityPacked ? 0.92 : 1;
        const overlapScale = densityPacked ? 1.2 : 1;
        const labelFont = isHovered || isLandmark
            ? 'bold 8px "Press Start 2P", monospace'
            : '7px "Press Start 2P", monospace';
        const attempts = [
            {
                text: baseText,
                labelFont,
                maxTextWidth: Math.round((isHovered ? 190 : isLandmark ? 132 : 96) * widthScale),
                iconSize: building.icon ? (isHovered || isLandmark ? 16 : 13) * scale : 0,
                iconGap: building.icon ? 5 * scale : 0,
                padX: isHovered || isLandmark ? 8 : 6,
                iconFont: isHovered || isLandmark ? 9 : 8,
                tagH: Math.round((isHovered ? 20 : isLandmark ? 18 : 14) * scale),
                overlapTolerance: isHovered || isLandmark ? Math.min(0.92, LABEL_OVERLAP_TOLERANCE * overlapScale) : 0.3,
                blockAgents: true,
                degraded: false,
            },
        ];

        const compactFont = isHovered || isLandmark
            ? 'bold 7px "Press Start 2P", monospace'
            : '6px "Press Start 2P", monospace';
        if (compactText && compactText !== baseText) {
            attempts.push({
                text: compactText,
                labelFont: compactFont,
                maxTextWidth: Math.round((isLandmark ? 92 : 76) * widthScale),
                iconSize: building.icon ? (isHovered || isLandmark ? 14 : 11) * scale : 0,
                iconGap: building.icon ? 4 * scale : 0,
                padX: isHovered || isLandmark ? 7 : 5,
                iconFont: isHovered || isLandmark ? 8 : 7,
                tagH: Math.round((isHovered ? 18 : isLandmark ? 16 : 12) * scale),
                overlapTolerance: isHovered || isLandmark ? Math.min(0.95, LABEL_COMPACT_OVERLAP_TOLERANCE * overlapScale) : 0.38,
                blockAgents: true,
                degraded: false,
            });
        }

        if (tinyText) {
            attempts.push({
                text: tinyText,
                labelFont: '6px "Press Start 2P", monospace',
                maxTextWidth: Math.round((isLandmark ? 64 : 58) * widthScale),
                iconSize: building.icon ? (isHovered || isLandmark ? 13 : 10) * scale : 0,
                iconGap: building.icon ? 3 * scale : 0,
                padX: isHovered || isLandmark ? 6 : 4,
                iconFont: isHovered || isLandmark ? 8 : 7,
                tagH: Math.round((isHovered ? 16 : isLandmark ? 14 : 10) * scale),
                overlapTolerance: isHovered || isLandmark ? Math.min(0.97, 0.78 * overlapScale) : 0.55,
                blockAgents: true,
                degraded: false,
            });
        }

        attempts.push({
            text: tinyText,
            labelFont: '5px "Press Start 2P", monospace',
            maxTextWidth: Math.round(34 * widthScale),
            iconSize: 0,
            iconGap: 0,
            padX: isHovered || isLandmark ? 4 : 3,
            iconFont: isHovered || isLandmark ? 7 : 6,
            tagH: Math.round((isHovered ? 10 : isLandmark ? 9 : 8) * scale),
            overlapTolerance: 1,
            blockAgents: false,
            degraded: true,
        });

        if (zoom <= LABEL_VISIBLE_ZOOM && tinyText) {
            const fallbackText = tinyText;
            attempts.push({
                text: fallbackText,
                labelFont: '5px "Press Start 2P", monospace',
                maxTextWidth: Math.round(38 * widthScale),
                iconSize: 0,
                iconGap: 0,
                padX: isHovered || isLandmark ? 4 : 3,
                iconFont: isHovered || isLandmark ? 7 : 6,
                tagH: Math.round((isHovered ? 12 : isLandmark ? 11 : 10) * scale),
                overlapTolerance: 0.9,
                blockAgents: true,
                degraded: true,
            });
        }

        return attempts;
    }

    _labelTinyTextFor(building, fallbackText) {
        const raw = String(fallbackText || this._resolveBuildingLabelText(building)).trim().toUpperCase();
        if (!raw) return fallbackText;
        const compact = raw.split(/\s+/).filter(Boolean);
        if (compact.length === 1) {
            return compact[0].slice(0, 4);
        }
        const acronym = compact.map((word) => word[0]).join('');
        return acronym.length >= 2 ? acronym : raw.slice(0, 4);
    }

    _resolveLabelLayout({
        candidates,
        occupied,
        occupiedExternal = [],
        centerX,
        centerY,
        tagW,
        tagH,
        maxOverlap = LABEL_OVERLAP_TOLERANCE,
        localLabelDensity = 0,
    }) {
        let best = null;
        let bestOverlap = Number.POSITIVE_INFINITY;
        const boxPad = localLabelDensity >= 2 ? 2 : 4;
        const bottomPad = Math.max(6, Math.round(tagH * 0.55) + (localLabelDensity >= 2 ? 4 : 6));

        for (const { dx, dy } of candidates) {
            const labelX = centerX + dx;
            const labelY = centerY + dy;
            const tagLeft = labelX - tagW / 2;
            const tagTop = labelY - tagH / 2;
            const box = {
                left: tagLeft - boxPad,
                top: tagTop - (boxPad - 1),
                right: tagLeft + tagW + boxPad,
                bottom: tagTop + tagH + bottomPad,
            };
            const blocked = [...occupied, ...occupiedExternal];
            const overlap = this._boxesMaxOverlapRatio(box, blocked);
            if (overlap === 0) {
                return { x: labelX, y: labelY, box };
            }
            if (overlap < bestOverlap) {
                bestOverlap = overlap;
                best = { x: labelX, y: labelY, box, overlap };
            }
        }
        if (bestOverlap > maxOverlap) return null;
        return best;
    }

    _normalizeBoxes(boxes = []) {
        return boxes.map((box) => {
            if (box && 'left' in box && 'right' in box && 'top' in box && 'bottom' in box) return box;
            if (!box || !('w' in box) || !('h' in box)) return null;
            return {
                left: box.x,
                right: box.x + box.w,
                top: box.y,
                bottom: box.y + box.h,
            };
        }).filter(Boolean);
    }

    // Vector chat bubbles preserved (parchment-style overlay).
    // Ported from BuildingRenderer.drawBubbles (legacy file lines 3215-3256),
    // swapping `style.wallHeight` for sprite `dims.h` to anchor above the sprite top.
    drawBubbles(ctx, world) {
        for (const b of this.buildings) {
            const agentsInBuilding = [];
            const occupants = this.agentSprites?.length
                ? this.agentSprites.map((sprite) => ({
                    agent: sprite.agent,
                    position: this._spriteTilePosition(sprite),
                }))
                : Array.from(world.agents.values()).map((agent) => ({ agent, position: agent.position }));

            for (const occupant of occupants) {
                if (!occupant.agent || !occupant.position) continue;
                const agentAtPosition = { ...occupant.agent, position: occupant.position };
                const isVisiting = typeof b.isAgentVisiting === 'function'
                    ? b.isAgentVisiting(agentAtPosition)
                    : b.containsPoint(occupant.position.tileX, occupant.position.tileY);
                if (isVisiting) {
                    agentsInBuilding.push(occupant.agent);
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

    _spriteTilePosition(sprite) {
        if (!sprite || !Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) return null;
        return {
            tileX: (sprite.x / (TILE_WIDTH / 2) + sprite.y / (TILE_HEIGHT / 2)) / 2,
            tileY: (sprite.y / (TILE_HEIGHT / 2) - sprite.x / (TILE_WIDTH / 2)) / 2,
        };
    }

    // Light sources for water/wall additive light passes (Phase 2.5.5).
    // `overlay` is the atmosphere sprite id used for the additive reflection;
    // defaults to the lighthouse beam when the manifest entry omits it.
    getLightSources() {
        if (this._lightSourcesCache) return this._lightSourcesCache;
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
        this._lightSourcesCache = out;
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
        const label = this._resolveBuildingLabelText(building);
        if (isHovered || zoom >= LABEL_DETAIL_ZOOM) return label;
        const short = LABEL_SHORT_TEXT[building.type];
        if (short) return short;
        const words = label.split(/\s+/).filter(Boolean);
        if (words.length === 1) return label;
        if (words.length === 2) return words.join(' ');
        return `${words[0]} ${words[1]}`;
    }

    _resolveBuildingLabelText(building) {
        const explicit = String(building.label || '').trim();
        if (explicit) return explicit.toUpperCase();
        const short = LABEL_SHORT_TEXT[building.type];
        if (short) return short.toUpperCase();
        if (!building.type) return '';
        const tokenized = String(building.type).replace(/[_-]/g, ' ');
        return tokenized
            .split(/\s+/)
            .map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
    }

    _labelMetrics(ctx, building, { text, labelFont, maxTextWidth, zoom, isHovered, isLandmark }) {
        const zoomBucket = zoom >= LABEL_DETAIL_ZOOM ? 'detail' : zoom >= LABEL_VISIBLE_ZOOM ? 'mid' : 'far';
        const key = `${building.type}|${text}|${labelFont}|${maxTextWidth}|${zoomBucket}|${isHovered ? 1 : 0}|${isLandmark ? 1 : 0}`;
        const cached = this._labelMetricsCache.get(key);
        if (cached) return cached;

        let displayText = text;
        if (ctx.measureText(displayText).width > maxTextWidth) {
            while (displayText.length > 1 && ctx.measureText(`${displayText}…`).width > maxTextWidth) {
                displayText = displayText.slice(0, -1);
            }
            if (displayText.length < text.length) {
                displayText = `${displayText}…`;
            }
        }
        const metrics = {
            displayText,
            width: ctx.measureText(displayText).width,
        };
        this._labelMetricsCache.set(key, metrics);
        return metrics;
    }

    _boxesOverlap(a, b) {
        return a.left < b.right
            && a.right > b.left
            && a.top < b.bottom
            && a.bottom > b.top;
    }

    _boxesOverlapRatio(box, boxes) {
        if (!boxes || boxes.length === 0) return 0;
        const boxArea = Math.max(0, (box.right - box.left) * (box.bottom - box.top));
        if (boxArea === 0) return 0;

        let overlapArea = 0;
        for (const other of boxes) {
            const overlapLeft = Math.max(box.left, other.left);
            const overlapTop = Math.max(box.top, other.top);
            const overlapRight = Math.min(box.right, other.right);
            const overlapBottom = Math.min(box.bottom, other.bottom);
            const overlapWidth = overlapRight - overlapLeft;
            const overlapHeight = overlapBottom - overlapTop;
            if (overlapWidth <= 0 || overlapHeight <= 0) continue;
            overlapArea += overlapWidth * overlapHeight;
        }

        return Math.min(1, overlapArea / boxArea);
    }

    _boxesMaxOverlapRatio(box, boxes) {
        if (!boxes || boxes.length === 0) return 0;
        const boxArea = Math.max(0, (box.right - box.left) * (box.bottom - box.top));
        if (boxArea === 0) return 0;

        let maxOverlap = 0;
        for (const other of boxes) {
            const overlapLeft = Math.max(box.left, other.left);
            const overlapTop = Math.max(box.top, other.top);
            const overlapRight = Math.min(box.right, other.right);
            const overlapBottom = Math.min(box.bottom, other.bottom);
            const overlapWidth = overlapRight - overlapLeft;
            const overlapHeight = overlapBottom - overlapTop;
            if (overlapWidth <= 0 || overlapHeight <= 0) continue;
            maxOverlap = Math.max(maxOverlap, (overlapWidth * overlapHeight) / boxArea);
        }

        return Math.min(1, maxOverlap);
    }

    _estimateLocalLabelDensity(occupiedBoxes, centerX, centerY) {
        if (!occupiedBoxes.length) return 0;
        const radius = 95;
        const radiusSq = radius * radius;
        let nearby = 0;

        for (const box of occupiedBoxes) {
            const cx = (box.left + box.right) / 2;
            const cy = (box.top + box.bottom) / 2;
            const dx = cx - centerX;
            const dy = cy - centerY;
            if (dx * dx + dy * dy <= radiusSq) {
                nearby++;
            }
        }

        return nearby;
    }
}
