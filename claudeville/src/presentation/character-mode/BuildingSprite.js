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
const LABEL_VISIBLE_ZOOM = 1;
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
    harbor: '#ffd37a',
    observatory: '#bda7ff',
    mine: '#ffab47',
    taskboard: '#8bd7ff',
    archive: '#b3d68c',
};
const PARTICLE_ALIASES = {
    sparkle2: 'sparkle',
    sparkle3: 'sparkle',
    torch2: 'torch',
    torch3: 'torch',
    torch4: 'torch',
};
const BUILDING_EMITTER_FALLBACKS = {
    forge: [
        { type: 'forgeEmber', at: [66, 76], chance: 0.06, count: 1 },
        { type: 'forgeSpark', at: [48, 83], chance: 0.032, count: 1 },
        { type: 'smoke', at: [88, 13], chance: 0.035, count: 1 },
    ],
    mine: [
        { type: 'mineDust', at: [82, 98], chance: 0.035, count: 1 },
        { type: 'mining', at: [102, 124], chance: 0.026, count: 1 },
    ],
    portal: [
        { type: 'portalRune', at: [144, 60], chance: 0.05, count: 1 },
        { type: 'sparkle', at: [122, 80], chance: 0.025, count: 1 },
    ],
    watchtower: [
        { type: 'beaconMote', at: [196, 32], chance: 0.038, count: 1 },
    ],
    harbor: [
        { type: 'torch', at: [48, 42], chance: 0.026, count: 1 },
        { type: 'sparkle', at: [70, 58], chance: 0.014, count: 1 },
    ],
    taskboard: [
        { type: 'questPing', at: [56, 58], chance: 0.024, count: 1 },
    ],
    archive: [
        { type: 'archiveMote', at: [154, 82], chance: 0.034, count: 1 },
        { type: 'archiveMote', at: [61, 149], chance: 0.018, count: 1 },
        { type: 'archiveMote', at: [246, 141], chance: 0.018, count: 1 },
    ],
};
const BUILDING_LIGHT_FALLBACKS = {
    forge: { at: [64, 78], color: '#ff8a33', radius: 62, overlay: 'atmosphere.light.fire-glow' },
    mine: { at: [84, 98], color: '#ffb84d', radius: 68, overlay: 'atmosphere.light.lantern-glow' },
    taskboard: { at: [56, 58], color: '#8bd7ff', radius: 42, overlay: 'atmosphere.light.lantern-glow' },
    archive: { at: [154, 96], color: '#b3d68c', radius: 96, overlay: 'atmosphere.light.lantern-glow' },
    harbor: { at: [48, 42], color: '#ffd37a', radius: 58, overlay: 'atmosphere.light.lantern-glow' },
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
        this._visitorCountByType = new Map();
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
        this._updateVisitorCounts();
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
            const c = this._buildingScreenCenter(b);
            if (entry?.lightSource) {
                const baseAnchor = this.assets.getAnchor(entry.id);
                const [lx, ly] = entry.lightSource;
                out.push({
                    x: c.x - baseAnchor[0] + lx,
                    y: c.y - baseAnchor[1] + ly,
                    color: entry.lightColor || 'rgba(255,210,140,0.4)',
                    radius: entry.lightRadius || 64,
                    overlay: entry.lightOverlay || 'atmosphere.light.lighthouse-beam',
                    buildingType: b.type,
                });
                continue;
            }
            const fallback = BUILDING_LIGHT_FALLBACKS[b.type];
            if (fallback) {
                const baseAnchor = this.assets.getAnchor(`building.${b.type}`);
                const [lx, ly] = fallback.at;
                out.push({
                    x: c.x - baseAnchor[0] + lx,
                    y: c.y - baseAnchor[1] + ly,
                    color: fallback.color,
                    radius: fallback.radius,
                    overlay: fallback.overlay,
                    buildingType: b.type,
                });
            }
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
            this._drawAnimatedOverlays(ctx, d.entry, d.wx, d.wy, d.building);
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
                this._drawAnimatedOverlays(ctx, d.entry, d.wx, d.wy, d.building);
            }
        }
        if (this.hovered === d.building) this.sprites.drawOutline(ctx, id, d.wx, d.wy);
    }

    _drawAnimatedOverlays(ctx, entry, wx, wy, building = null) {
        if (entry.layers) {
            this._drawManifestLayers(ctx, entry, wx, wy);
        }
        if (building) {
            this._drawFunctionalOverlay(ctx, building, entry, wx, wy);
        }
    }

    _drawManifestLayers(ctx, entry, wx, wy) {
        const baseAnchor = this.assets.getAnchor(entry.id);
        for (const [name, layer] of Object.entries(entry.layers)) {
            if (name === 'base') continue;
            if (entry.id === 'building.watchtower' && name === 'beacon') continue;
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

    _drawFunctionalOverlay(ctx, building, entry, wx, wy) {
        const baseAnchor = this.assets.getAnchor(entry.id);
        const localPoint = (lx, ly) => ({ x: Math.round(wx - baseAnchor[0] + lx), y: Math.round(wy - baseAnchor[1] + ly) });
        const pulse = this.motionScale ? (Math.sin(this.frame * 0.1) + 1) / 2 : 0.55;

        ctx.save();
        if (building.type === 'forge') {
            this._drawForgeEnhancement(ctx, localPoint, pulse);
        } else if (building.type === 'mine') {
            const mouth = localPoint(84, 98);
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = 0.24 + pulse * 0.18;
            ctx.fillStyle = '#ffc15a';
            ctx.beginPath();
            ctx.ellipse(mouth.x, mouth.y - 1, 31, 13, -0.22, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 0.75;
            ctx.strokeStyle = '#8f6a3d';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(mouth.x - 34, mouth.y + 14);
            ctx.lineTo(mouth.x + 37, mouth.y - 6);
            ctx.moveTo(mouth.x - 26, mouth.y + 23);
            ctx.lineTo(mouth.x + 44, mouth.y + 3);
            ctx.stroke();
        } else if (building.type === 'taskboard') {
            const board = localPoint(56, 60);
            const swing = this.motionScale ? Math.sin(this.frame * 0.08) * 1.5 : 0;
            ctx.globalAlpha = 0.94;
            ctx.fillStyle = 'rgba(58, 38, 22, 0.88)';
            ctx.strokeStyle = '#8bd7ff';
            ctx.lineWidth = 1.5;
            ctx.fillRect(board.x - 23, board.y - 22 + swing, 46, 30);
            ctx.strokeRect(board.x - 23.5, board.y - 22.5 + swing, 47, 31);
            const notes = [
                [-16, -15, '#f2d36b'], [-2, -16, '#e2c48a'], [12, -14, '#f5e4b7'],
                [-12, -2, '#f5e4b7'], [5, -1, '#f2d36b'],
            ];
            for (const [dx, dy, color] of notes) {
                ctx.fillStyle = color;
                ctx.fillRect(board.x + dx, board.y + dy + swing, 9, 8);
            }
            ctx.strokeStyle = '#2c6b45';
            ctx.beginPath();
            ctx.moveTo(board.x + 14, board.y + 5 + swing);
            ctx.lineTo(board.x + 18, board.y + 9 + swing);
            ctx.lineTo(board.x + 25, board.y + 0 + swing);
            ctx.stroke();
        } else if (building.type === 'portal') {
            const gate = localPoint(144, 60);
            const visitors = this._visitorCountFor(building);
            const activeBoost = visitors > 0 ? 0.28 : 0;
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = 0.28 + pulse * 0.22 + activeBoost;
            ctx.strokeStyle = '#8feaff';
            ctx.lineWidth = 2;
            for (let i = 0; i < 3; i++) {
                const r = 19 + i * 8 + Math.sin(this.frame * 0.06 + i) * 2;
                ctx.beginPath();
                ctx.ellipse(gate.x, gate.y, r, r * 0.58, this.frame * 0.012 + i * 0.8, 0, Math.PI * 2);
                ctx.stroke();
            }
            if (visitors > 0) {
                ctx.fillStyle = '#bda7ff';
                ctx.beginPath();
                ctx.ellipse(gate.x, gate.y + 4, 34, 17, 0, 0, Math.PI * 2);
                ctx.fill();
            }
        } else if (building.type === 'watchtower') {
            const beacon = localPoint(196, 34);
            this._drawWatchtowerFire(ctx, beacon, pulse);
        } else if (building.type === 'harbor') {
            this._drawHarborMasterOffice(ctx, localPoint, pulse);
        } else if (building.type === 'archive') {
            this._drawArchiveEnhancement(ctx, localPoint, pulse);
        }
        ctx.restore();
    }

    _drawHarborMasterOffice(ctx, localPoint, pulse) {
        const signal = localPoint(74, 37);
        const lantern = localPoint(171, 96);
        const quayLight = localPoint(102, 151);
        const pier = localPoint(256, 184);
        const flagLift = this.motionScale ? Math.sin(this.frame * 0.08) * 1.8 : 0;

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.14 + pulse * 0.14;
        ctx.fillStyle = '#ffd37a';
        for (const point of [signal, lantern, quayLight]) {
            ctx.beginPath();
            ctx.ellipse(point.x, point.y, 24, 13, -0.12, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.46;
        ctx.strokeStyle = 'rgba(229, 235, 203, 0.72)';
        ctx.lineWidth = 1.1;
        for (const [dx, dy, rx] of [[-27, 2, 21], [8, 7, 27], [34, -3, 18]]) {
            ctx.beginPath();
            ctx.ellipse(pier.x + dx, pier.y + dy, rx, 3.5, -0.18, 0, Math.PI);
            ctx.stroke();
        }

        ctx.globalAlpha = 0.86;
        ctx.strokeStyle = '#1f120c';
        ctx.lineWidth = 1.2;
        for (const [dy, color] of [[-18, '#f2d36b'], [-8, '#5bc0c9'], [2, '#c23f36']]) {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(signal.x + 4, signal.y + dy + flagLift * 0.35);
            ctx.lineTo(signal.x + 24, signal.y + dy + 4 + flagLift * 0.35);
            ctx.lineTo(signal.x + 4, signal.y + dy + 10 + flagLift * 0.35);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.10 + pulse * 0.12;
        ctx.fillStyle = '#f5c964';
        ctx.beginPath();
        ctx.ellipse(pier.x, pier.y, 32, 10, -0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
    }

    _drawArchiveEnhancement(ctx, localPoint, pulse) {
        const focus = localPoint(215, 118);
        const window = localPoint(168, 68);
        const leftLamp = localPoint(68, 104);
        const rightLamp = localPoint(268, 104);

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.08 + pulse * 0.08;
        ctx.fillStyle = '#b3d68c';
        ctx.beginPath();
        ctx.ellipse(window.x, window.y, 34, 18, -0.12, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.26 + pulse * 0.3;
        ctx.fillStyle = '#b3d68c';
        ctx.beginPath();
        ctx.ellipse(focus.x, focus.y, 37, 29, -0.08, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = '#e9ffd2';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(focus.x, focus.y, 22 + pulse * 5, 13 + pulse * 3, this.frame * 0.018, 0, Math.PI * 2);
        ctx.ellipse(focus.x, focus.y, 30 + pulse * 4, 17 + pulse * 2, -this.frame * 0.014, 0, Math.PI * 2);
        ctx.moveTo(focus.x - 28, focus.y);
        ctx.lineTo(focus.x + 28, focus.y);
        ctx.moveTo(focus.x, focus.y - 25);
        ctx.lineTo(focus.x, focus.y + 25);
        ctx.stroke();

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.18 + pulse * 0.16;
        ctx.fillStyle = '#ffd36a';
        for (const lamp of [leftLamp, rightLamp]) {
            ctx.beginPath();
            ctx.ellipse(lamp.x, lamp.y, 28, 17, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
    }

    _drawForgeEnhancement(ctx, localPoint, pulse) {
        const hearth = localPoint(64, 78);
        const chimney = localPoint(85, 19);
        const anvil = localPoint(44, 84);
        const workbench = localPoint(82, 86);
        const coal = localPoint(31, 90);
        const trough = localPoint(63, 101);
        const flicker = this.motionScale
            ? Math.sin(this.frame * 0.25) * 1.8 + Math.sin(this.frame * 0.43) * 1.1
            : 0.8;

        this._drawForgeStoneApron(ctx, hearth, trough);
        this._drawForgeHeatBloom(ctx, hearth, pulse);
        this._drawForgeSmithyMass(ctx, hearth);
        this._drawForgeRoofAndStack(ctx, chimney, hearth, flicker, pulse);
        this._drawForgeMouth(ctx, hearth, flicker, pulse);
        this._drawForgeMoltenTrough(ctx, trough, pulse, flicker);
        this._drawForgeYardTools(ctx, anvil, workbench, coal, pulse);
    }

    _drawForgeStoneApron(ctx, hearth, trough) {
        ctx.globalAlpha = 0.78;
        ctx.fillStyle = '#51483f';
        ctx.strokeStyle = '#201713';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(hearth.x - 42, hearth.y + 8);
        ctx.lineTo(hearth.x + 29, hearth.y - 8);
        ctx.lineTo(trough.x + 31, trough.y - 4);
        ctx.lineTo(trough.x - 42, trough.y + 12);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = '#837765';
        ctx.lineWidth = 1;
        const seams = [
            [[hearth.x - 23, hearth.y + 11], [trough.x - 15, trough.y + 8]],
            [[hearth.x + 1, hearth.y + 5], [trough.x + 9, trough.y + 2]],
            [[hearth.x + 23, hearth.y], [trough.x + 30, trough.y - 3]],
            [[hearth.x - 33, hearth.y + 23], [hearth.x + 37, hearth.y + 7]],
        ];
        for (const [[x1, y1], [x2, y2]] of seams) {
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }

    _drawForgeSmithyMass(ctx, hearth) {
        ctx.globalAlpha = 0.94;
        ctx.fillStyle = '#6c6257';
        ctx.strokeStyle = '#1f1714';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(hearth.x - 39, hearth.y - 38);
        ctx.lineTo(hearth.x + 19, hearth.y - 53);
        ctx.lineTo(hearth.x + 45, hearth.y - 31);
        ctx.lineTo(hearth.x + 39, hearth.y + 11);
        ctx.lineTo(hearth.x - 29, hearth.y + 24);
        ctx.lineTo(hearth.x - 43, hearth.y + 3);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.globalAlpha = 0.48;
        ctx.strokeStyle = '#b1a188';
        ctx.lineWidth = 1;
        for (const [x1, y1, x2, y2] of [
            [-31, -24, 28, -38],
            [-38, -8, 38, -25],
            [-28, 8, 35, -7],
            [-20, -35, -14, 16],
            [2, -42, 7, 10],
            [24, -36, 27, 1],
        ]) {
            ctx.beginPath();
            ctx.moveTo(hearth.x + x1, hearth.y + y1);
            ctx.lineTo(hearth.x + x2, hearth.y + y2);
            ctx.stroke();
        }

        ctx.globalAlpha = 0.72;
        ctx.fillStyle = '#35241b';
        ctx.strokeStyle = '#15100d';
        for (const beam of [{ x: -36, h: 43 }, { x: 37, h: 37 }]) {
            ctx.fillRect(hearth.x + beam.x - 4, hearth.y - beam.h, 8, beam.h + 21);
            ctx.strokeRect(hearth.x + beam.x - 4, hearth.y - beam.h, 8, beam.h + 21);
        }
        ctx.globalAlpha = 1;
    }

    _drawForgeHeatBloom(ctx, hearth, pulse) {
        ctx.globalCompositeOperation = 'screen';
        const glow = ctx.createRadialGradient(hearth.x, hearth.y, 1, hearth.x, hearth.y, 52 + pulse * 13);
        glow.addColorStop(0, 'rgba(255, 239, 154, 0.74)');
        glow.addColorStop(0.35, 'rgba(255, 126, 39, 0.34)');
        glow.addColorStop(1, 'rgba(255, 75, 24, 0)');
        ctx.globalAlpha = 0.58 + pulse * 0.26;
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.ellipse(hearth.x + 2, hearth.y - 1, 55, 32, -0.24, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
    }

    _drawForgeRoofAndStack(ctx, chimney, hearth, flicker, pulse) {
        ctx.globalAlpha = 0.96;
        ctx.fillStyle = '#a9552d';
        ctx.strokeStyle = '#21130e';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(hearth.x - 50, hearth.y - 50);
        ctx.lineTo(hearth.x + 9, hearth.y - 76);
        ctx.lineTo(hearth.x + 55, hearth.y - 45);
        ctx.lineTo(hearth.x + 36, hearth.y - 31);
        ctx.lineTo(hearth.x - 54, hearth.y - 36);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.35 + pulse * 0.14;
        ctx.fillStyle = '#ffb34d';
        ctx.beginPath();
        ctx.moveTo(hearth.x - 43, hearth.y - 48);
        ctx.lineTo(hearth.x + 7, hearth.y - 70);
        ctx.lineTo(hearth.x + 47, hearth.y - 45);
        ctx.lineTo(hearth.x + 32, hearth.y - 37);
        ctx.lineTo(hearth.x - 47, hearth.y - 40);
        ctx.closePath();
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        ctx.globalAlpha = 0.78;
        ctx.strokeStyle = '#f0a255';
        ctx.lineWidth = 1.25;
        for (const offset of [-38, -24, -10, 4, 18, 32, 45]) {
            ctx.beginPath();
            ctx.moveTo(hearth.x + offset, hearth.y - 58 + Math.abs(offset) * 0.07);
            ctx.lineTo(hearth.x + offset + 31, hearth.y - 37);
            ctx.stroke();
        }
        ctx.strokeStyle = '#321c14';
        for (const yOffset of [-66, -55, -44]) {
            ctx.beginPath();
            ctx.moveTo(hearth.x - 42, hearth.y + yOffset + 13);
            ctx.lineTo(hearth.x + 45, hearth.y + yOffset);
            ctx.stroke();
        }

        ctx.globalAlpha = 0.82;
        ctx.fillStyle = '#4b2d1d';
        for (const post of [{ x: hearth.x - 33, h: 40 }, { x: hearth.x + 37, h: 34 }]) {
            ctx.fillRect(post.x - 3, hearth.y - post.h, 6, post.h + 18);
            ctx.strokeStyle = '#1f120c';
            ctx.strokeRect(post.x - 3, hearth.y - post.h, 6, post.h + 18);
        }

        ctx.globalAlpha = 0.92;
        const stack = [
            { x: chimney.x - 15, y: chimney.y + 42 },
            { x: chimney.x - 12, y: chimney.y - 5 },
            { x: chimney.x + 8, y: chimney.y - 13 },
            { x: chimney.x + 18, y: chimney.y + 34 },
            { x: chimney.x + 4, y: chimney.y + 45 },
        ];
        ctx.fillStyle = '#4d4a45';
        ctx.strokeStyle = '#211711';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(stack[0].x, stack[0].y);
        for (let i = 1; i < stack.length; i++) ctx.lineTo(stack[i].x, stack[i].y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#837c6e';
        for (const [dx, dy, w] of [[-8, -2, 14], [-11, 8, 22], [-7, 19, 18], [-12, 30, 24]]) {
            ctx.fillRect(chimney.x + dx, chimney.y + dy, w, 3);
        }
        ctx.fillStyle = '#2d2a28';
        ctx.beginPath();
        ctx.moveTo(chimney.x - 16, chimney.y + 12);
        ctx.lineTo(chimney.x + 16, chimney.y + 4);
        ctx.lineTo(chimney.x + 20, chimney.y + 12);
        ctx.lineTo(chimney.x - 11, chimney.y + 20);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#2d2420';
        ctx.fillRect(chimney.x - 14, chimney.y - 12, 30, 8);
        ctx.fillStyle = '#7a6f61';
        ctx.fillRect(chimney.x - 10, chimney.y - 16, 21, 5);

        this._drawForgeChimneyVent(ctx, { x: chimney.x + 1, y: chimney.y - 17 }, pulse);
    }

    _drawForgeChimneyVent(ctx, top, pulse) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.88;
        ctx.fillStyle = '#241a16';
        ctx.strokeStyle = '#6e6256';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(top.x, top.y + 3, 13, 5, -0.08, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.14 + pulse * 0.06;
        ctx.fillStyle = '#9a8d7f';
        ctx.beginPath();
        ctx.ellipse(top.x + 2, top.y - 5, 18, 10, -0.25, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
    }

    _drawForgeMouth(ctx, hearth, flicker, pulse) {
        ctx.globalAlpha = 0.96;
        ctx.fillStyle = '#786d60';
        ctx.strokeStyle = '#211711';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(hearth.x - 35, hearth.y + 12);
        ctx.lineTo(hearth.x - 29, hearth.y - 9);
        ctx.quadraticCurveTo(hearth.x - 17, hearth.y - 31, hearth.x + 4, hearth.y - 33);
        ctx.quadraticCurveTo(hearth.x + 30, hearth.y - 25, hearth.x + 35, hearth.y + 9);
        ctx.lineTo(hearth.x + 26, hearth.y + 17);
        ctx.lineTo(hearth.x - 25, hearth.y + 20);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.globalAlpha = 0.92;
        ctx.strokeStyle = '#aa967e';
        ctx.lineWidth = 1;
        for (const [dx, dy, r] of [[-24, -1, 5], [-14, -20, 6], [4, -27, 7], [23, -13, 6], [25, 8, 5], [-17, 13, 5]]) {
            ctx.beginPath();
            ctx.ellipse(hearth.x + dx, hearth.y + dy, r, r * 0.68, -0.2, 0, Math.PI * 2);
            ctx.stroke();
        }

        ctx.globalAlpha = 0.98;
        ctx.fillStyle = 'rgba(36, 22, 16, 0.94)';
        ctx.strokeStyle = '#2b160f';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(hearth.x - 24, hearth.y + 6);
        ctx.quadraticCurveTo(hearth.x - 16, hearth.y - 18, hearth.x + 3, hearth.y - 22);
        ctx.quadraticCurveTo(hearth.x + 24, hearth.y - 16, hearth.x + 26, hearth.y + 8);
        ctx.lineTo(hearth.x + 14, hearth.y + 14);
        ctx.lineTo(hearth.x - 18, hearth.y + 14);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.62 + pulse * 0.32;
        ctx.fillStyle = '#ff7a2f';
        ctx.beginPath();
        ctx.ellipse(hearth.x + 1, hearth.y, 29, 14, -0.18, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.96;
        ctx.fillStyle = '#ff8a33';
        ctx.beginPath();
        ctx.moveTo(hearth.x - 15, hearth.y + 8);
        ctx.quadraticCurveTo(hearth.x - 20, hearth.y - 7 - flicker, hearth.x - 6, hearth.y - 24 - flicker);
        ctx.quadraticCurveTo(hearth.x + 8, hearth.y - 8, hearth.x + 5, hearth.y + 9);
        ctx.closePath();
        ctx.fill();

        ctx.globalAlpha = 0.98;
        ctx.fillStyle = '#ffd66f';
        ctx.beginPath();
        ctx.moveTo(hearth.x - 5, hearth.y + 8);
        ctx.quadraticCurveTo(hearth.x - 7, hearth.y - 5 - flicker * 0.7, hearth.x + 2, hearth.y - 18 - flicker * 0.7);
        ctx.quadraticCurveTo(hearth.x + 9, hearth.y - 4, hearth.x + 5, hearth.y + 9);
        ctx.closePath();
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;

        ctx.globalAlpha = 0.78;
        ctx.strokeStyle = '#ffcf6a';
        ctx.lineWidth = 1.5;
        for (const mark of [-18, 18]) {
            ctx.beginPath();
            ctx.moveTo(hearth.x + mark - 3, hearth.y - 11);
            ctx.lineTo(hearth.x + mark + 3, hearth.y - 16);
            ctx.lineTo(hearth.x + mark + 1, hearth.y - 6);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }

    _drawForgeMoltenTrough(ctx, trough, pulse, flicker) {
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = '#2b211c';
        ctx.strokeStyle = '#130d0a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(trough.x - 26, trough.y - 4);
        ctx.lineTo(trough.x + 18, trough.y - 14);
        ctx.lineTo(trough.x + 31, trough.y - 7);
        ctx.lineTo(trough.x - 14, trough.y + 5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.66 + pulse * 0.24;
        ctx.fillStyle = '#ff8a25';
        ctx.beginPath();
        ctx.moveTo(trough.x - 19, trough.y - 2);
        ctx.lineTo(trough.x + 17, trough.y - 10);
        ctx.quadraticCurveTo(trough.x + 21, trough.y - 7 - flicker * 0.4, trough.x + 27, trough.y - 5);
        ctx.lineTo(trough.x - 10, trough.y + 4);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#ffe071';
        ctx.beginPath();
        ctx.moveTo(trough.x - 9, trough.y - 2);
        ctx.lineTo(trough.x + 12, trough.y - 7);
        ctx.lineTo(trough.x + 18, trough.y - 4);
        ctx.lineTo(trough.x - 3, trough.y + 1);
        ctx.closePath();
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
    }

    _drawForgeYardTools(ctx, anvil, workbench, coal, pulse) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#4a3122';
        ctx.strokeStyle = '#1f140d';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(workbench.x - 21, workbench.y - 5);
        ctx.lineTo(workbench.x + 13, workbench.y - 13);
        ctx.lineTo(workbench.x + 20, workbench.y - 4);
        ctx.lineTo(workbench.x - 15, workbench.y + 5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.strokeStyle = '#986038';
        ctx.lineWidth = 1.5;
        for (const offset of [-13, -3, 7]) {
            ctx.beginPath();
            ctx.moveTo(workbench.x + offset, workbench.y - 9);
            ctx.lineTo(workbench.x + offset + 15, workbench.y - 2);
            ctx.stroke();
        }

        ctx.globalAlpha = 0.84;
        ctx.fillStyle = '#9f7650';
        ctx.strokeStyle = '#25170f';
        ctx.lineWidth = 1;
        const bellows = { x: workbench.x + 25, y: workbench.y - 18 };
        ctx.beginPath();
        ctx.moveTo(bellows.x - 13, bellows.y + 3);
        ctx.quadraticCurveTo(bellows.x - 2, bellows.y - 9, bellows.x + 15, bellows.y - 4);
        ctx.lineTo(bellows.x + 12, bellows.y + 7);
        ctx.quadraticCurveTo(bellows.x - 3, bellows.y + 11, bellows.x - 13, bellows.y + 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#d5b06e';
        ctx.beginPath();
        ctx.moveTo(bellows.x + 13, bellows.y - 3);
        ctx.lineTo(bellows.x + 23, bellows.y - 2);
        ctx.lineTo(bellows.x + 14, bellows.y + 4);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        this._drawForgeAnvil(ctx, anvil, pulse);

        ctx.globalAlpha = 0.86;
        ctx.fillStyle = '#2b2521';
        ctx.strokeStyle = '#1b120e';
        ctx.beginPath();
        ctx.ellipse(coal.x, coal.y, 15, 7, -0.25, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.2 + pulse * 0.18;
        ctx.fillStyle = '#ff7a2f';
        ctx.beginPath();
        ctx.ellipse(coal.x + 2, coal.y - 1, 10, 4, -0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        ctx.globalAlpha = 0.86;
        for (const [x, y, h] of [[workbench.x + 31, workbench.y - 6, 15], [workbench.x + 38, workbench.y - 2, 12]]) {
            ctx.fillStyle = '#60391f';
            ctx.strokeStyle = '#22140d';
            ctx.beginPath();
            ctx.ellipse(x, y - h, 5, 3, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillRect(x - 5, y - h, 10, h);
            ctx.beginPath();
            ctx.ellipse(x, y, 5, 3, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    }

    _drawForgeAnvil(ctx, anvil, pulse) {
        const hammer = Math.sin(this.frame * 0.18) * 0.75 - 0.25;
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = '#1d1510';
        ctx.fillStyle = '#c8a066';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(anvil.x - 19, anvil.y + 3);
        ctx.lineTo(anvil.x + 13, anvil.y - 5);
        ctx.lineTo(anvil.x + 20, anvil.y + 1);
        ctx.lineTo(anvil.x - 10, anvil.y + 10);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#806044';
        ctx.fillRect(anvil.x - 6, anvil.y + 8, 10, 8);
        ctx.fillStyle = '#4c3221';
        ctx.fillRect(anvil.x - 13, anvil.y + 16, 24, 4);

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.28 + pulse * 0.18;
        ctx.fillStyle = '#ffd66f';
        ctx.beginPath();
        ctx.ellipse(anvil.x + 2, anvil.y - 2, 18, 7, -0.22, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        ctx.save();
        ctx.translate(anvil.x - 4, anvil.y - 13);
        ctx.rotate(hammer);
        ctx.fillStyle = '#5d3f2a';
        ctx.fillRect(-2, -19, 4, 23);
        ctx.fillStyle = '#d9b36f';
        ctx.strokeStyle = '#2b1d13';
        ctx.lineWidth = 1;
        ctx.fillRect(-10, -24, 20, 7);
        ctx.strokeRect(-10, -24, 20, 7);
        ctx.restore();
    }

    _drawWatchtowerFire(ctx, beacon, pulse) {
        const flicker = this.motionScale ? Math.sin(this.frame * 0.23) * 2.2 + Math.sin(this.frame * 0.41) * 1.1 : 0.8;
        const lean = this.motionScale ? Math.sin(this.frame * 0.13) * 2.6 : 1.2;

        ctx.globalCompositeOperation = 'screen';
        const glow = ctx.createRadialGradient(beacon.x, beacon.y, 1, beacon.x, beacon.y, 30 + pulse * 8);
        glow.addColorStop(0, 'rgba(255, 236, 150, 0.78)');
        glow.addColorStop(0.36, 'rgba(255, 142, 51, 0.34)');
        glow.addColorStop(1, 'rgba(255, 91, 26, 0)');
        ctx.globalAlpha = 0.62 + pulse * 0.16;
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(beacon.x, beacon.y, 30 + pulse * 7, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = '#6b351c';
        ctx.strokeStyle = '#2f1d12';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(beacon.x, beacon.y + 7, 13, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = '#ff7a2f';
        ctx.beginPath();
        ctx.moveTo(beacon.x - 7, beacon.y + 5);
        ctx.quadraticCurveTo(beacon.x - 10 + lean, beacon.y - 4 - flicker, beacon.x - 1 + lean, beacon.y - 19 - flicker);
        ctx.quadraticCurveTo(beacon.x + 11 + lean, beacon.y - 2, beacon.x + 7, beacon.y + 6);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = '#ffe68a';
        ctx.globalAlpha = 0.95;
        ctx.beginPath();
        ctx.moveTo(beacon.x - 3, beacon.y + 4);
        ctx.quadraticCurveTo(beacon.x - 4 + lean * 0.4, beacon.y - 4 - flicker * 0.5, beacon.x + 2 + lean * 0.3, beacon.y - 12 - flicker * 0.5);
        ctx.quadraticCurveTo(beacon.x + 6 + lean * 0.2, beacon.y - 1, beacon.x + 3, beacon.y + 5);
        ctx.closePath();
        ctx.fill();

        ctx.globalAlpha = 0.44 + pulse * 0.18;
        ctx.strokeStyle = '#ffd66f';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(beacon.x - 18, beacon.y + 2);
        ctx.lineTo(beacon.x + 18, beacon.y + 2);
        ctx.moveTo(beacon.x, beacon.y - 16);
        ctx.lineTo(beacon.x, beacon.y + 18);
        ctx.stroke();
    }

    _spawnEmittersFor(b) {
        const entry = this.assets.getEntry(`building.${b.type}`);
        if (!this.motionScale) return;
        const center = this._buildingScreenCenter(b);
        const entryId = entry?.id || `building.${b.type}`;
        const baseAnchor = this.assets.getAnchor(entryId);
        for (const [particleType, [lx, ly]] of Object.entries(entry?.emitters || {})) {
            const normalizedType = PARTICLE_ALIASES[particleType] || particleType;
            this._spawnBuildingParticle(normalizedType, center, baseAnchor, [lx, ly], 0.035, 1);
        }
        for (const emitter of BUILDING_EMITTER_FALLBACKS[b.type] || []) {
            const chance = emitter.chance * (this._visitorCountFor(b) > 0 ? 1.6 : 1);
            this._spawnBuildingParticle(emitter.type, center, baseAnchor, emitter.at, chance, emitter.count || 1);
        }
    }

    _spawnBuildingParticle(type, center, baseAnchor, at, chance, count) {
        if (Math.random() > chance) return;
        const [lx, ly] = at;
        const wx = center.x - baseAnchor[0] + lx;
        const wy = center.y - baseAnchor[1] + ly;
        this.particles.spawn(type, wx, wy, count);
    }

    _updateVisitorCounts() {
        this._visitorCountByType.clear();
        if (!this.agentSprites?.length || !this.buildings.length) return;

        for (const sprite of this.agentSprites) {
            const position = this._spriteTilePosition(sprite);
            if (!position) continue;
            const agentAtPosition = { ...sprite.agent, position };
            for (const building of this.buildings) {
                const isVisiting = typeof building.isAgentVisiting === 'function'
                    ? building.isAgentVisiting(agentAtPosition)
                    : building.containsPoint(position.tileX, position.tileY);
                if (!isVisiting) continue;
                this._visitorCountByType.set(building.type, (this._visitorCountByType.get(building.type) || 0) + 1);
            }
        }
    }

    _visitorCountFor(building) {
        return this._visitorCountByType.get(building?.type) || 0;
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
        if (zoom >= LABEL_DETAIL_ZOOM) return label;
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
