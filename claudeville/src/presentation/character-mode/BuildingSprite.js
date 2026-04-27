// BuildingSprite replaces BuildingRenderer. Draws buildings from sprites,
// exposes emitter points for particles, supports occlusion split for hero
// buildings. Reimplements the full BuildingRenderer external surface
// (setBuildings, setAgentSprites, setMotionScale, update, drawShadows,
// drawBubbles, getLightSources, hitTest, hoveredBuilding-as-setHovered).
//
// Roof-fade behaviour is intentionally dropped per spec §3.

import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { BUILDING_DEFS } from '../../config/buildings.js';
import { normalizeLightSource } from './LightSourceRegistry.js';
import { normalizeLightingState } from './AtmosphereState.js';

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
const LANDMARK_LABEL_EMBLEMS = {
    command: 'crown',
    forge: 'hammer',
    portal: 'rune',
    watchtower: 'flame',
    harbor: 'anchor',
    observatory: 'star',
    mine: 'pick',
    taskboard: 'scroll',
    archive: 'book',
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
        { type: 'forgeEmber', at: [51, 66], chance: 0.06, count: 1 },
        { type: 'forgeSpark', at: [50, 70], chance: 0.032, count: 1 },
        { type: 'smoke', at: [39, 8], chance: 0.035, count: 1 },
    ],
    mine: [
        { type: 'mineDust', at: [73, 95], chance: 0.035, count: 1 },
        { type: 'mining', at: [78, 122], chance: 0.026, count: 1 },
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
        { type: 'archiveMote', at: [168, 82], chance: 0.034, count: 1 },
        { type: 'archiveMote', at: [142, 128], chance: 0.018, count: 1 },
        { type: 'archiveMote', at: [194, 128], chance: 0.018, count: 1 },
    ],
};
const BUILDING_LIGHT_FALLBACKS = {
    forge: { at: [51, 66], color: '#ff8a33', radius: 62, overlay: 'atmosphere.light.fire-glow' },
    mine: { at: [73, 95], color: '#ffb84d', radius: 68, overlay: 'atmosphere.light.lantern-glow' },
    taskboard: { at: [56, 58], color: '#8bd7ff', radius: 42, overlay: 'atmosphere.light.lantern-glow' },
    archive: { at: [168, 88], color: '#b3d68c', radius: 96, overlay: 'atmosphere.light.lantern-glow' },
    harbor: { at: [48, 42], color: '#ffd37a', radius: 58, overlay: 'atmosphere.light.lantern-glow' },
};
const LIGHT_SOURCE_REGISTRY = {
    watchtower: [
        {
            kind: 'beam',
            at: [196, 32],
            color: '#ffd36a',
            radius: 132,
            length: 390,
            width: 96,
            alpha: 0.12,
            overlay: 'atmosphere.light.lighthouse-beam',
        },
    ],
};
const EMITTER_LIGHTS = {
    torch: { color: '#ffbc62', radius: 42, overlay: 'atmosphere.light.fire-glow' },
    signal: { color: '#ffd37a', radius: 48, overlay: 'atmosphere.light.lantern-glow' },
    forgeEmber: { color: '#ff8a33', radius: 42, overlay: 'atmosphere.light.fire-glow' },
    forgeSpark: { color: '#ff9f3f', radius: 34, overlay: 'atmosphere.light.fire-glow' },
};
const OBSERVATORY_CLOCK_FACE = Object.freeze({
    // Calibrated against the generated 312x208 clock observatory base.
    // Composite reference is asserted at first draw so a regenerated sprite
    // with different dimensions logs a visible warning instead of silently
    // misplacing the clock hands.
    compositeRef: Object.freeze({ w: 312, h: 208 }),
    center: [133, 73],
    radius: 30,
    sourceSize: 40,
    sourceCenter: 20,
    sourceRadius: 18,
    hourHandLength: 10,
    minuteHandLength: 15,
});
const MINE_SEAM_COLORS = ['#ffc15a', '#ff8a33', '#ff4528'];

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function hexToRgb(hex) {
    const text = String(hex || '').replace('#', '');
    const normalized = text.length === 3
        ? text.split('').map(char => char + char).join('')
        : text.padEnd(6, '0').slice(0, 6);
    const value = parseInt(normalized, 16);
    return {
        r: (value >> 16) & 255,
        g: (value >> 8) & 255,
        b: value & 255,
    };
}

function mixHex(a, b, t) {
    const from = hexToRgb(a);
    const to = hexToRgb(b);
    return `rgb(${Math.round(lerp(from.r, to.r, t))}, ${Math.round(lerp(from.g, to.g, t))}, ${Math.round(lerp(from.b, to.b, t))})`;
}

function compactRitualLabel(value, fallback = '') {
    const text = String(value || fallback || '').replace(/\s+/g, ' ').trim();
    if (!text) return fallback;
    return text.length > 10 ? `${text.slice(0, 8)}..` : text;
}

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
        this._clockCanvas = null;
        this._clockCanvasKey = '';
        this.lightingState = null;
        this.ritualConductor = null;
        this.quotaState = null;
        this.motionScale = (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) ? 0 : 1;
        this._motionMq = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : null;
        this._onMotionChange = (e) => this.setMotionScale(e.matches ? 0 : 1);
        this._motionMq?.addEventListener?.('change', this._onMotionChange);
    }

    dispose() {
        this._motionMq?.removeEventListener?.('change', this._onMotionChange);
    }

    setMotionScale(s) { this.motionScale = s; }

    setLightingState(state) {
        this.lightingState = state ? normalizeLightingState(state) : null;
    }

    setRitualConductor(conductor) {
        this.ritualConductor = conductor || null;
    }

    setQuotaState(state) {
        this.quotaState = state || null;
    }

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
        const lighting = this.lightingState || {};
        const shadowLength = lighting.shadowLength ?? 1;
        const shadowAlpha = lighting.shadowAlpha ?? 0.22;
        const shadowAngle = lighting.shadowAngleRad ?? 0.28;
        const offsetX = Math.cos(shadowAngle) * 12 * shadowLength;
        const offsetY = Math.sin(shadowAngle) * 7 * shadowLength;
        for (const b of this.buildings) {
            const c = this._buildingScreenCenter(b);
            const tileHalfW = (b.width + b.height) * TILE_WIDTH / 4;
            const dims = this.assets.getDims(`building.${b.type}`);
            const spriteHalfW = dims ? dims.w / 2 : tileHalfW;
            const halfW = Math.max(tileHalfW, spriteHalfW * 0.7);
            const isLandmark = LANDMARK_LABEL_TYPES.has(b.type);
            const isHovered = this.hovered === b;
            ctx.save();
            ctx.fillStyle = `rgba(15, 22, 30, ${shadowAlpha})`;
            ctx.beginPath();
            ctx.ellipse(
                Math.round(c.x + offsetX),
                Math.round(c.y + 4 + offsetY),
                halfW * (0.92 + shadowLength * 0.16),
                halfW * (0.27 + shadowLength * 0.08),
                shadowAngle * 0.22,
                0,
                Math.PI * 2
            );
            ctx.fill();
            this._drawFootprintContactPad(ctx, b, { isLandmark, isHovered });
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
    drawLabels(ctx, { zoom = 1, occupiedBoxes = [], harborPendingRepos = [] } = {}) {
        const occupied = [];
        const normalizedOccupiedBoxes = this._normalizeBoxes(occupiedBoxes);
        const harborLedgerRows = this._harborLedgerRows(harborPendingRepos);
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
                harborLedgerRows,
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
                let displaySubText = '';
                let displaySubRows = [];
                let subTw = 0;
                if (Array.isArray(attempt.subRows) && attempt.subRows.length) {
                    ctx.font = attempt.subFont || attempt.labelFont;
                    displaySubRows = attempt.subRows.map((row) => {
                        const subMetrics = this._labelMetrics(ctx, b, {
                            text: row.label,
                            labelFont: attempt.subFont || attempt.labelFont,
                            maxTextWidth: attempt.subMaxTextWidth || attempt.maxTextWidth,
                            zoom,
                            isHovered,
                            isLandmark,
                        });
                        subTw = Math.max(subTw, subMetrics.width);
                        return { ...row, label: subMetrics.displayText };
                    });
                } else if (attempt.subText) {
                    ctx.font = attempt.subFont || attempt.labelFont;
                    const subMetrics = this._labelMetrics(ctx, b, {
                        text: attempt.subText,
                        labelFont: attempt.subFont || attempt.labelFont,
                        maxTextWidth: attempt.subMaxTextWidth || attempt.maxTextWidth,
                        zoom,
                        isHovered,
                        isLandmark,
                    });
                    displaySubText = subMetrics.displayText;
                    subTw = subMetrics.width;
                }
                const tagW = Math.ceil(Math.max(tw, subTw) + attempt.iconSize + attempt.iconGap + attempt.padX * 2 + (isLandmark ? 8 : 0));
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
                    displaySubText,
                    displaySubRows,
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
                displaySubText,
                displaySubRows = [],
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
                subFont,
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
            const isHarborLedger = b.type === 'harbor' && (displaySubText || displaySubRows.length);
            const poleTop = tagTop + tagH - 1;
            const poleBottom = Math.min(center.y - dims.h * 0.52, tagTop + tagH + (isHovered ? 18 : isLandmark ? 14 : 7));

            ctx.globalAlpha = isHovered ? 1 : degraded ? labelAlpha : isLandmark ? 0.96 : 0.78;
            ctx.strokeStyle = isHovered ? 'rgba(255, 242, 197, 0.9)' : isHarborLedger ? 'rgba(113, 73, 31, 0.92)' : isLandmark ? 'rgba(242, 211, 107, 0.72)' : 'rgba(215, 185, 121, 0.62)';
            ctx.lineWidth = isHovered ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(tagLeft + notch, tagTop);
            ctx.lineTo(tagLeft + tagW - notch, tagTop);
            ctx.lineTo(tagLeft + tagW, by);
            ctx.lineTo(tagLeft + tagW - notch, tagTop + tagH);
            ctx.lineTo(tagLeft + notch, tagTop + tagH);
            ctx.lineTo(tagLeft, by);
            ctx.closePath();
            ctx.fillStyle = isHarborLedger
                ? (isHovered ? 'rgba(99, 62, 29, 0.98)' : 'rgba(72, 45, 24, 0.95)')
                : isHovered
                    ? 'rgba(70, 42, 22, 0.97)'
                    : isLandmark
                        ? 'rgba(58, 36, 21, 0.93)'
                        : 'rgba(42, 28, 18, 0.88)';
            ctx.fill();
            ctx.stroke();

            if (isLandmark || isHovered) {
                ctx.fillStyle = 'rgba(255, 225, 139, 0.13)';
                ctx.fillRect(tagLeft + 8, tagTop + 6, tagW - 16, 1);
                ctx.fillStyle = 'rgba(25, 15, 9, 0.22)';
                ctx.fillRect(tagLeft + 7, tagTop + tagH - 5, tagW - 14, 1);
                ctx.fillStyle = 'rgba(185, 123, 54, 0.5)';
                ctx.fillRect(tagLeft + 4, by - 1, 3, 3);
                ctx.fillRect(tagLeft + tagW - 7, by - 1, 3, 3);
            }

            if (isHovered || isLandmark) {
                ctx.fillStyle = accent;
                ctx.globalAlpha = isHovered ? 0.95 : glowAlpha;
                ctx.fillRect(tagLeft + 5, tagTop + 3, tagW - 10, 2);
                if (isHarborLedger) {
                    ctx.fillStyle = 'rgba(35, 21, 12, 0.6)';
                    ctx.fillRect(tagLeft + padX + iconSize + iconGap, by + 1, tagW - padX * 2 - iconSize - iconGap - 4, 1);
                }
                ctx.globalAlpha = isHovered ? 1 : glowAlpha;
            }

            // Identity badge: hand-drawn guild emblem, not a plain letter token.
            if (b.icon) {
                const iconCx = tagLeft + padX + iconSize / 2 + (isLandmark ? 2 : 0);
                const iconCy = by;
                this._drawLabelEmblem(ctx, b, iconCx, iconCy, iconSize, {
                    accent,
                    isHovered,
                    isLandmark,
                });
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
            const textX = tagLeft + padX + iconSize + iconGap + (isLandmark ? 2 : 0);
            if (displaySubRows.length) {
                ctx.fillText(displayText, textX, by - 5);
                ctx.font = subFont || chosenFont;
                displaySubRows.forEach((row, index) => {
                    ctx.fillStyle = row.color || '#f6d384';
                    ctx.fillText(row.label, textX, by + 6 + index * 8);
                });
            } else if (displaySubText) {
                ctx.fillText(displayText, textX, by - 5);
                ctx.fillStyle = isHarborLedger ? '#f6d384' : textColor;
                ctx.font = subFont || chosenFont;
                ctx.fillText(displaySubText, textX, by + 6);
            } else {
                ctx.fillText(displayText, textX, by + 0.5);
            }
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

    _labelRenderAttempts(building, { isHovered, isLandmark, zoom, localLabelDensity = 0, harborLedgerRows = [] }) {
        const baseText = this._labelTextFor(building, zoom, isHovered);
        const compactText = this._labelTextFor(building, LABEL_VISIBLE_ZOOM, false);
        const tinyText = this._labelTinyTextFor(building, compactText);
        const densityPacked = localLabelDensity >= 2;
        const widthScale = densityPacked ? 0.86 : 1;
        const scale = densityPacked ? 0.92 : 1;
        const overlapScale = densityPacked ? 1.2 : 1;
        const isHarborLedger = building.type === 'harbor' && harborLedgerRows.length > 0;
        const labelFont = isHovered || isLandmark
            ? 'bold 9px "Press Start 2P", monospace'
            : '7px "Press Start 2P", monospace';
        const attempts = [
            {
                text: isHarborLedger ? compactText : baseText,
                subRows: isHarborLedger ? harborLedgerRows : [],
                subFont: '7px "Press Start 2P", monospace',
                subMaxTextWidth: Math.round((isHovered ? 158 : 132) * widthScale),
                labelFont,
                maxTextWidth: Math.round((isHovered ? 190 : isLandmark ? 132 : 96) * widthScale),
                iconSize: building.icon ? (isHovered || isLandmark ? 22 : 16) * scale : 0,
                iconGap: building.icon ? 7 * scale : 0,
                padX: isHovered || isLandmark ? 11 : 7,
                iconFont: isHovered || isLandmark ? 9 : 8,
                tagH: Math.round((isHarborLedger ? (isHovered ? 44 : 40) : isHovered ? 28 : isLandmark ? 24 : 16) * scale),
                overlapTolerance: isHovered || isLandmark ? Math.min(0.92, LABEL_OVERLAP_TOLERANCE * overlapScale) : 0.3,
                blockAgents: true,
                degraded: false,
            },
        ];

        const compactFont = isHovered || isLandmark
            ? 'bold 8px "Press Start 2P", monospace'
            : '6px "Press Start 2P", monospace';
        if (compactText && compactText !== baseText) {
            attempts.push({
                text: compactText,
                labelFont: compactFont,
                maxTextWidth: Math.round((isLandmark ? 92 : 76) * widthScale),
                iconSize: building.icon ? (isHovered || isLandmark ? 19 : 13) * scale : 0,
                iconGap: building.icon ? 6 * scale : 0,
                padX: isHovered || isLandmark ? 10 : 6,
                iconFont: isHovered || isLandmark ? 8 : 7,
                tagH: Math.round((isHovered ? 24 : isLandmark ? 21 : 13) * scale),
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
                iconSize: building.icon ? (isHovered || isLandmark ? 17 : 11) * scale : 0,
                iconGap: building.icon ? 5 * scale : 0,
                padX: isHovered || isLandmark ? 8 : 5,
                iconFont: isHovered || isLandmark ? 8 : 7,
                tagH: Math.round((isHovered ? 21 : isLandmark ? 18 : 11) * scale),
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
    getLightSources(lightingState = this.lightingState) {
        const lightBoost = lightingState?.lightBoost ?? 1;
        const staticSources = this._staticLightSources();
        const out = staticSources.map(source => {
            const visitors = source.building ? this._visitorCountFor(source.building) : 0;
            const activity = source.buildingType === 'forge'
                ? (visitors > 0 ? 1.35 : 0.58)
                : visitors > 0 ? 1.12 : 1;
            const radius = source.radius * Math.min(1.55, 0.72 + lightBoost * 0.28 + (activity - 1) * 0.18);
            return normalizeLightSource({
                ...source,
                intensity: activity,
                radius,
                origin: source.origin || { x: source.x, y: source.y },
            }, {
                buildingType: source.buildingType,
                building: source.building,
            });
        });
        for (const source of this._ritualLightSources(lightBoost)) out.push(source);
        return out;
    }

    _staticLightSources() {
        if (this._lightSourcesCache) return this._lightSourcesCache;
        const out = [];
        for (const b of this.buildings) {
            const entry = this.assets.getEntry(`building.${b.type}`);
            const c = this._buildingScreenCenter(b);
            const seen = new Set();
            const pushSource = (source) => {
                if (!source?.at) return;
                const baseAnchor = this.assets.getAnchor(entry?.id || `building.${b.type}`);
                const [lx, ly] = source.at;
                const key = `${source.kind || 'point'}|${Math.round(lx)},${Math.round(ly)}|${source.overlay || ''}`;
                if (seen.has(key)) return;
                seen.add(key);
                const origin = {
                    x: c.x - baseAnchor[0] + lx,
                    y: c.y - baseAnchor[1] + ly,
                };
                out.push(normalizeLightSource({
                    id: source.id || `building.${b.type}.${source.kind || 'point'}.${Math.round(lx)}.${Math.round(ly)}`,
                    origin,
                    color: source.color || entry?.lightColor || '#ffcc66',
                    radius: source.radius || entry?.lightRadius || 64,
                    overlay: source.overlay || entry?.lightOverlay || 'atmosphere.light.lighthouse-beam',
                    buildingType: b.type,
                    kind: source.kind || 'point',
                    building: b,
                    length: source.length,
                    width: source.width,
                    alpha: source.alpha,
                    ttl: source.ttl,
                    createdAt: source.createdAt,
                    endpoints: source.endpoints,
                    controlPoint: source.controlPoint,
                    parent: source.parent,
                }, {
                    buildingType: b.type,
                    building: b,
                }));
            };

            if (Array.isArray(entry?.lightSources)) {
                for (const source of entry.lightSources) pushSource(source);
            }
            if (entry?.lightSource) {
                pushSource({
                    at: entry.lightSource,
                    color: entry.lightColor || 'rgba(255,210,140,0.4)',
                    radius: entry.lightRadius || 64,
                    overlay: entry.lightOverlay || 'atmosphere.light.lighthouse-beam',
                });
            }
            for (const source of LIGHT_SOURCE_REGISTRY[b.type] || []) {
                pushSource(source);
            }
            if (entry?.emitters) {
                for (const [name, at] of Object.entries(entry.emitters)) {
                    const baseName = name.replace(/\d+$/, '');
                    const light = EMITTER_LIGHTS[baseName] || EMITTER_LIGHTS[name];
                    if (light) pushSource({ ...light, at });
                }
            }
            const fallback = BUILDING_LIGHT_FALLBACKS[b.type];
            if (fallback) {
                pushSource(fallback);
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
                out.push({ kind: 'building-front', building: b, entry, wx, wy, horizonY, sortY: this._buildingFrontSortY(b, wy) });
            } else {
                out.push({ kind: 'building', building: b, entry, wx, wy, sortY: this._buildingWholeSortY(b, wy) });
            }
        }
        this._drawablesCache = out;
        return out;
    }

    drawDrawable(ctx, d) {
        const id = d.entry.id;
        if (d.kind === 'building') {
            this.sprites.drawSprite(ctx, id, d.wx, d.wy);
            this._drawAnimatedOverlays(ctx, d.entry, d.wx, d.wy, d.building, 'whole');
        } else {
            const dims = this.assets.getDims(id);
            const [ax, ay] = this.assets.getAnchor(id);
            const dx = Math.round(d.wx - ax);
            const dy = Math.round(d.wy - ay);
            const img = this.assets.get(id);
            if (!img) return;
            if (d.kind === 'building-back') {
                ctx.drawImage(img, 0, 0, dims.w, d.horizonY, dx, dy, dims.w, d.horizonY);
                this._drawAnimatedOverlays(ctx, d.entry, d.wx, d.wy, d.building, 'back', d.horizonY);
            } else {
                ctx.drawImage(img, 0, d.horizonY, dims.w, dims.h - d.horizonY,
                                   dx, dy + d.horizonY, dims.w, dims.h - d.horizonY);
                this._drawAnimatedOverlays(ctx, d.entry, d.wx, d.wy, d.building, 'front', d.horizonY);
            }
        }
        if (this.hovered === d.building) this.sprites.drawOutline(ctx, id, d.wx, d.wy);
    }

    _drawAnimatedOverlays(ctx, entry, wx, wy, building = null, splitPass = 'whole', horizonY = null) {
        if (entry.layers) {
            this._drawManifestLayers(ctx, entry, wx, wy, splitPass, horizonY);
        }
        if (building) {
            this._drawFunctionalOverlay(ctx, building, entry, wx, wy, splitPass, horizonY);
        }
    }

    _drawManifestLayers(ctx, entry, wx, wy, splitPass = 'whole', horizonY = null) {
        const baseAnchor = this.assets.getAnchor(entry.id);
        for (const [name, layer] of Object.entries(entry.layers)) {
            if (name === 'base') continue;
            const localY = Array.isArray(layer.anchor) ? layer.anchor[1] : 0;
            if (
                splitPass !== 'whole' &&
                Number.isFinite(horizonY) &&
                (splitPass === 'back' ? localY >= horizonY : localY < horizonY)
            ) {
                continue;
            }
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

    _drawFunctionalOverlay(ctx, building, entry, wx, wy, splitPass = 'whole', horizonY = null) {
        const baseAnchor = this.assets.getAnchor(entry.id);
        const localPoint = (lx, ly) => ({ x: Math.round(wx - baseAnchor[0] + lx), y: Math.round(wy - baseAnchor[1] + ly) });
        const pulse = this.motionScale ? (Math.sin(this.frame * 0.1) + 1) / 2 : 0.55;
        const shouldDrawLocalY = (localY) => (
            splitPass === 'whole'
            || !Number.isFinite(horizonY)
            || (splitPass === 'back' ? localY < horizonY : localY >= horizonY)
        );

        ctx.save();
        if (building.type === 'observatory') {
            this._assertObservatoryClockDims(entry);
            if (shouldDrawLocalY(OBSERVATORY_CLOCK_FACE.center[1])) {
                this._drawObservatoryClock(ctx, localPoint);
                this._drawObservatoryRitual(ctx, localPoint, building);
            }
            ctx.restore();
            return;
        }
        if (building.type === 'forge') {
            if (shouldDrawLocalY(66)) this._drawForgeEnhancement(ctx, localPoint, pulse, building);
        } else if (building.type === 'mine') {
            if (!shouldDrawLocalY(95)) {
                ctx.restore();
                return;
            }
            const mouth = localPoint(73, 95);
            const seamColor = this._mineSeamColor();
            const mineRitual = this._latestRitual('mine');
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = 0.16 + pulse * 0.12 + (mineRitual ? 0.12 : 0);
            ctx.fillStyle = seamColor;
            ctx.beginPath();
            ctx.ellipse(mouth.x, mouth.y - 1, 28, 13, -0.22, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 0.42;
            ctx.strokeStyle = '#8f6a3d';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(mouth.x - 26, mouth.y + 23);
            ctx.lineTo(mouth.x + 23, mouth.y + 8);
            ctx.moveTo(mouth.x - 18, mouth.y + 29);
            ctx.lineTo(mouth.x + 30, mouth.y + 14);
            ctx.stroke();
            this._drawMineRitual(ctx, mouth, mineRitual);
        } else if (building.type === 'portal') {
            if (!shouldDrawLocalY(60)) {
                ctx.restore();
                return;
            }
            const gate = localPoint(144, 60);
            const visitors = this._visitorCountFor(building);
            const portalRitual = this._latestRitual('portal');
            const activeBoost = visitors > 0 ? 0.28 : 0;
            const ritualBoost = portalRitual ? 0.24 : 0;
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = 0.28 + pulse * 0.22 + activeBoost + ritualBoost;
            ctx.strokeStyle = '#8feaff';
            ctx.lineWidth = 2;
            for (let i = 0; i < 3; i++) {
                const motion = this.motionScale ? Math.sin(this.frame * 0.06 + i) * 2 : 0;
                const r = 19 + i * 8 + motion + ritualBoost * 10;
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
            this._drawPortalRitual(ctx, gate, portalRitual);
        } else if (building.type === 'watchtower') {
            if (!entry.layers?.beacon && shouldDrawLocalY(34)) {
                const beacon = localPoint(196, 34);
                this._drawWatchtowerFire(ctx, beacon, pulse);
                this._drawWatchtowerRitual(ctx, beacon);
            }
        } else if (building.type === 'harbor') {
            if (splitPass !== 'back') this._drawHarborMasterOffice(ctx, localPoint, pulse);
        } else if (building.type === 'archive') {
            if (splitPass !== 'back') this._drawArchiveEnhancement(ctx, localPoint, pulse);
        } else if (building.type === 'taskboard') {
            if (splitPass !== 'back') this._drawTaskboardRitual(ctx, localPoint, building);
        } else if (building.type === 'command') {
            if (splitPass !== 'back') this._drawCommandRitual(ctx, localPoint, building);
        }
        ctx.restore();
    }

    _ritualsFor(type) {
        return this.ritualConductor?.getActiveRitualsForBuilding?.(type) || [];
    }

    _latestRitual(type, predicate = null) {
        const rituals = this._ritualsFor(type)
            .filter((ritual) => !predicate || predicate(ritual))
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return rituals[0] || null;
    }

    _ritualProgress(ritual) {
        if (!ritual) return 0;
        return clamp01((ritual.elapsedMs || 0) / Math.max(1, ritual.durationMs || 1));
    }

    _ritualFade(ritual) {
        if (!ritual) return 0;
        const duration = Math.max(1, ritual.durationMs || 1);
        const age = Math.max(0, ritual.elapsedMs || 0);
        const inAlpha = ritual.motionEnabled === false ? 1 : Math.min(1, age / 180);
        const outAlpha = Math.min(1, Math.max(0, (duration - age) / 420));
        return clamp01(inAlpha * outAlpha);
    }

    _ritualLightSources(lightBoost = 1) {
        const sources = [];
        for (const building of this.buildings) {
            const rituals = this._ritualsFor(building.type);
            if (!rituals.length) continue;
            const entry = this.assets.getEntry(`building.${building.type}`);
            const center = this._buildingScreenCenter(building);
            const baseAnchor = this.assets.getAnchor(entry?.id || `building.${building.type}`);
            const toOrigin = ([lx, ly]) => ({
                x: center.x - baseAnchor[0] + lx,
                y: center.y - baseAnchor[1] + ly,
            });
            for (const ritual of rituals) {
                const fade = this._ritualFade(ritual);
                if (fade <= 0.03) continue;
                if (building.type === 'forge') {
                    sources.push(normalizeLightSource({
                        id: `ritual:${ritual.id}:spark`,
                        kind: 'spark',
                        origin: toOrigin([26, 76]),
                        color: '#ffcf6a',
                        radius: 24 + this._ritualProgress(ritual) * 34,
                        alpha: fade * 0.5 * lightBoost,
                        overlay: 'atmosphere.light.fire-glow',
                        buildingType: building.type,
                        building,
                    }));
                } else if (building.type === 'mine') {
                    sources.push(normalizeLightSource({
                        id: `ritual:${ritual.id}:ore`,
                        kind: 'spark',
                        origin: toOrigin([73, 95]),
                        color: this._mineSeamColor(),
                        radius: 44 + fade * 24,
                        alpha: fade * 0.3 * lightBoost,
                        overlay: 'atmosphere.light.lantern-glow',
                        buildingType: building.type,
                        building,
                    }));
                } else if (building.type === 'portal') {
                    sources.push(normalizeLightSource({
                        id: `ritual:${ritual.id}:portal`,
                        kind: 'orbit',
                        origin: toOrigin([144, 60]),
                        color: '#8feaff',
                        radius: 58,
                        alpha: fade * 0.26 * lightBoost,
                        overlay: 'atmosphere.light.lantern-glow',
                        buildingType: building.type,
                        building,
                    }));
                }
            }
        }
        return sources;
    }

    _assertObservatoryClockDims(entry) {
        // Warn once per session if the observatory sprite drifts away from the
        // composite size that OBSERVATORY_CLOCK_FACE.center / .radius were
        // calibrated against. Silent drift would misplace the clock hands.
        if (this._observatoryDimsChecked) return;
        this._observatoryDimsChecked = true;
        const dims = entry?.id ? this.assets?.getDims?.(entry.id) : null;
        if (!dims) return;
        const ref = OBSERVATORY_CLOCK_FACE.compositeRef;
        if (dims.w !== ref.w || dims.h !== ref.h) {
            console.warn(
                `[BuildingSprite] observatory sprite is ${dims.w}x${dims.h}; clock-face calibration assumes ${ref.w}x${ref.h}. Hand placement may be off — recalibrate OBSERVATORY_CLOCK_FACE.center / .radius.`
            );
        }
    }

    _drawObservatoryClock(ctx, localPoint) {
        const config = OBSERVATORY_CLOCK_FACE;
        const [cx, cy] = config.center;
        const face = localPoint(cx, cy);
        const time = this._clockTime();
        const hourAngle = (((time.hour % 12) + time.minute / 60) / 12) * Math.PI * 2 - Math.PI / 2;
        const minuteAngle = (time.minute / 60) * Math.PI * 2 - Math.PI / 2;
        const source = this._clockSourceCanvas(config, hourAngle, minuteAngle, `${time.hour}:${time.minute}`);
        const size = config.radius * 2;
        const left = Math.round(face.x - size / 2);
        const top = Math.round(face.y - size / 2);
        const previousSmoothing = ctx.imageSmoothingEnabled;

        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(source, left, top, size, size);
        ctx.imageSmoothingEnabled = previousSmoothing;
    }

    _clockSourceCanvas(config, hourAngle, minuteAngle, cacheKey) {
        if (!this._clockCanvas) {
            this._clockCanvas = document.createElement('canvas');
        }
        const canvas = this._clockCanvas;
        if (canvas.width !== config.sourceSize || canvas.height !== config.sourceSize) {
            canvas.width = config.sourceSize;
            canvas.height = config.sourceSize;
            this._clockCanvasKey = '';
        }
        if (this._clockCanvasKey === cacheKey) return canvas;

        const ctx = canvas.getContext('2d');
        const c = config.sourceCenter;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = false;

        ctx.fillStyle = 'rgba(19, 21, 30, 0.56)';
        this._fillPixelCircle(ctx, c, c, config.sourceRadius);
        ctx.fillStyle = 'rgba(229, 218, 170, 0.72)';
        this._strokePixelCircle(ctx, c, c, config.sourceRadius);
        ctx.fillStyle = 'rgba(255, 241, 190, 0.88)';
        const tickMin = c - config.sourceRadius + 1;
        const tickMax = c + config.sourceRadius - 1;
        for (const [tx, ty] of [[c, tickMin], [c, tickMax], [tickMin, c], [tickMax, c]]) {
            ctx.fillRect(tx - 1, ty - 1, 2, 2);
        }

        this._drawClockHand(ctx, c, c, hourAngle, config.hourHandLength, 3, '#1a1712');
        this._drawClockHand(ctx, c, c, minuteAngle, config.minuteHandLength, 2, '#f7de91');
        ctx.fillStyle = '#21170f';
        ctx.fillRect(c - 1, c - 1, 3, 3);
        ctx.fillStyle = '#ffe6a0';
        ctx.fillRect(c, c, 1, 1);

        this._clockCanvasKey = cacheKey;
        return canvas;
    }

    _clockTime() {
        const now = new Date();
        return { hour: now.getHours(), minute: now.getMinutes() };
    }

    _drawClockHand(ctx, cx, cy, angle, length, width, color) {
        const x1 = Math.round(cx + Math.cos(angle) * length);
        const y1 = Math.round(cy + Math.sin(angle) * length);
        this._drawBlockLine(ctx, cx, cy, x1, y1, width, color);
    }

    _drawBlockLine(ctx, x0, y0, x1, y1, width, color) {
        let dx = Math.abs(x1 - x0);
        let dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        const half = Math.floor(width / 2);

        ctx.fillStyle = color;
        while (true) {
            ctx.fillRect(x0 - half, y0 - half, width, width);
            if (x0 === x1 && y0 === y1) break;
            const e2 = err * 2;
            if (e2 > -dy) {
                err -= dy;
                x0 += sx;
            }
            if (e2 < dx) {
                err += dx;
                y0 += sy;
            }
        }
    }

    _fillPixelCircle(ctx, cx, cy, radius) {
        for (let y = -radius; y <= radius; y++) {
            const halfWidth = Math.floor(Math.sqrt(radius * radius - y * y));
            ctx.fillRect(cx - halfWidth, cy + y, halfWidth * 2 + 1, 1);
        }
    }

    _strokePixelCircle(ctx, cx, cy, radius) {
        for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 24) {
            const x = Math.round(cx + Math.cos(angle) * radius);
            const y = Math.round(cy + Math.sin(angle) * radius);
            ctx.fillRect(x, y, 1, 1);
        }
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
        const crest = localPoint(168, 82);
        const doorway = localPoint(168, 130);
        const leftLamp = localPoint(142, 128);
        const rightLamp = localPoint(194, 128);
        const ritual = this._latestRitual('archive');

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.20;
        ctx.fillStyle = '#b3d68c';
        ctx.beginPath();
        ctx.ellipse(crest.x, crest.y, 26, 18, -0.12, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.24 + (ritual ? this._ritualFade(ritual) * 0.16 : 0);
        ctx.fillStyle = '#ffd36a';
        ctx.beginPath();
        ctx.ellipse(doorway.x, doorway.y, 32, 20, -0.08, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        ctx.globalAlpha = 0.75;
        ctx.strokeStyle = '#e9ffd2';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(crest.x, crest.y, 18, 11, 0.16, 0, Math.PI * 2);
        ctx.moveTo(crest.x - 18, crest.y);
        ctx.lineTo(crest.x + 18, crest.y);
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
        this._drawArchiveRitual(ctx, doorway, ritual);
    }

    _drawForgeEnhancement(ctx, localPoint, pulse, building = null) {
        const hearth = localPoint(51, 66);
        const chimney = localPoint(39, 8);
        const anvil = localPoint(26, 76);
        const activityIntensity = this._visitorCountFor(building) > 0 ? 1.0 : 0.42;
        this._drawForgeHeatBloom(ctx, hearth, pulse, activityIntensity);

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = (0.09 + pulse * 0.05) * (0.7 + activityIntensity * 0.3);
        ctx.fillStyle = '#9a8d7f';
        ctx.beginPath();
        ctx.ellipse(chimney.x, chimney.y - 4, 17, 9, -0.22, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = (0.12 + pulse * 0.10) * (0.55 + activityIntensity * 0.45);
        ctx.fillStyle = '#ffd36a';
        ctx.beginPath();
        ctx.ellipse(anvil.x, anvil.y, 22, 12, -0.18, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
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

    _drawForgeHeatBloom(ctx, hearth, pulse, activityIntensity = 1) {
        ctx.globalCompositeOperation = 'screen';
        const steady = this.motionScale ? pulse : 0.45;
        const glow = ctx.createRadialGradient(hearth.x, hearth.y, 1, hearth.x, hearth.y, 42 + activityIntensity * 20 + steady * 6);
        glow.addColorStop(0, `rgba(255, 239, 154, ${0.34 + activityIntensity * 0.40})`);
        glow.addColorStop(0.35, `rgba(255, 126, 39, ${0.16 + activityIntensity * 0.18})`);
        glow.addColorStop(1, 'rgba(255, 75, 24, 0)');
        ctx.globalAlpha = 0.32 + activityIntensity * 0.42 + steady * 0.08;
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

        this._drawForgeAnvil(ctx, anvil, pulse, this._latestRitual('forge'));

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

    _drawForgeAnvil(ctx, anvil, pulse, ritual = null) {
        const progress = this._ritualProgress(ritual);
        const burst = ritual
            ? (ritual.motionEnabled === false
                ? 0.82
                : Math.max(0, Math.sin(Math.min(1, progress / 0.42) * Math.PI * 6)))
            : 0;
        const hammer = ritual ? -0.95 + burst * 1.55 : -0.82;
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
        ctx.globalAlpha = 0.24 + (ritual ? this._ritualFade(ritual) * 0.38 : pulse * 0.08);
        ctx.fillStyle = '#ffd66f';
        ctx.beginPath();
        ctx.ellipse(anvil.x + 2, anvil.y - 2, 18, 7, -0.22, 0, Math.PI * 2);
        ctx.fill();
        if (ritual) this._drawForgeSparkRing(ctx, anvil, ritual);
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

    _drawForgeSparkRing(ctx, anvil, ritual) {
        const progress = this._ritualProgress(ritual);
        const local = clamp01(progress / 0.22);
        const radius = ritual.motionEnabled === false ? 24 : 14 + local * 28;
        const alpha = ritual.motionEnabled === false ? 0.42 : Math.max(0, 0.62 * (1 - local));
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = '#ffe08a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(anvil.x + 2, anvil.y - 1, radius, radius * 0.42, -0.2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#fff0a6';
        for (let i = 0; i < 5; i++) {
            const angle = -Math.PI * 0.9 + i * Math.PI * 0.34;
            const distance = radius * (0.55 + i * 0.05);
            ctx.fillRect(
                Math.round(anvil.x + Math.cos(angle) * distance),
                Math.round(anvil.y - 2 + Math.sin(angle) * distance * 0.44),
                2,
                2
            );
        }
        ctx.restore();
    }

    _drawArchiveRitual(ctx, doorway, ritual) {
        if (!ritual) return;
        const progress = this._ritualProgress(ritual);
        const fade = this._ritualFade(ritual);
        const flip = ritual.motionEnabled === false
            ? 0.5
            : Math.abs(Math.sin(Math.min(1, progress / 0.42) * Math.PI));
        const pageWidth = 18 * (1 - flip * 0.72);
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.fillStyle = '#5e3c25';
        ctx.strokeStyle = '#2f1d12';
        ctx.lineWidth = 1;
        ctx.fillRect(Math.round(doorway.x - 19), Math.round(doorway.y - 22), 38, 24);
        ctx.strokeRect(Math.round(doorway.x - 19) + 0.5, Math.round(doorway.y - 22) + 0.5, 38, 24);
        ctx.fillStyle = '#e9d7a7';
        ctx.fillRect(Math.round(doorway.x - 16), Math.round(doorway.y - 19), 15, 18);
        ctx.fillStyle = '#f6e8bd';
        ctx.fillRect(Math.round(doorway.x + 2), Math.round(doorway.y - 19), Math.max(2, Math.round(pageWidth)), 18);
        ctx.strokeStyle = 'rgba(78, 51, 30, 0.52)';
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.moveTo(doorway.x - 12, doorway.y - 15 + i * 5);
            ctx.lineTo(doorway.x - 3, doorway.y - 15 + i * 5);
            ctx.moveTo(doorway.x + 5, doorway.y - 15 + i * 5);
            ctx.lineTo(doorway.x + pageWidth - 2, doorway.y - 15 + i * 5);
            ctx.stroke();
        }
        if (ritual.label) this._drawRitualLabel(ctx, doorway.x, doorway.y - 38, ritual.label, '#b3d68c', fade);
        ctx.restore();
    }

    _drawMineRitual(ctx, mouth, ritual) {
        if (!ritual) return;
        const progress = this._ritualProgress(ritual);
        const fade = this._ritualFade(ritual);
        const swing = ritual.motionEnabled === false
            ? -0.45
            : -0.95 + Math.sin(Math.min(1, progress / 0.62) * Math.PI * 2) * 0.9;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(mouth.x - 4, mouth.y + 2);
        ctx.rotate(swing);
        ctx.strokeStyle = '#3a2819';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, -21);
        ctx.lineTo(0, 5);
        ctx.stroke();
        ctx.strokeStyle = '#d7a45c';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-10, -23);
        ctx.lineTo(12, -18);
        ctx.stroke();
        ctx.restore();

        const oreProgress = ritual.motionEnabled === false ? 0.5 : clamp01((progress - 0.18) / 0.58);
        if (oreProgress > 0 && oreProgress < 1) {
            const ox = mouth.x - 8 + oreProgress * 44;
            const oy = mouth.y + 12 - Math.sin(oreProgress * Math.PI) * 28;
            ctx.save();
            ctx.globalAlpha = fade;
            ctx.fillStyle = this._mineSeamColor();
            ctx.strokeStyle = '#4a2f1c';
            ctx.beginPath();
            ctx.moveTo(ox - 5, oy);
            ctx.lineTo(ox + 1, oy - 5);
            ctx.lineTo(ox + 7, oy - 1);
            ctx.lineTo(ox + 3, oy + 5);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        }
    }

    _drawObservatoryRitual(ctx, localPoint, building) {
        const ritual = this._latestRitual('observatory');
        if (!ritual) return;
        const dome = localPoint(133, 54);
        const progress = this._ritualProgress(ritual);
        const fade = this._ritualFade(ritual);
        const target = ritual.angle || -0.7;
        const angle = ritual.motionEnabled === false ? target : lerp(-1.2, target, Math.min(1, progress / 0.5));
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(dome.x, dome.y);
        ctx.rotate(angle);
        ctx.fillStyle = '#6e7585';
        ctx.strokeStyle = '#252532';
        ctx.lineWidth = 1;
        ctx.fillRect(0, -4, 28, 8);
        ctx.strokeRect(0.5, -3.5, 27, 7);
        ctx.fillStyle = '#bda7ff';
        ctx.fillRect(23, -3, 5, 6);
        ctx.restore();

        if (ritual.motionEnabled !== false && progress > 0.48 && progress < 0.86) {
            ctx.save();
            ctx.globalAlpha = fade * 0.72;
            ctx.strokeStyle = '#d9c7ff';
            ctx.setLineDash([3, 5]);
            ctx.beginPath();
            ctx.arc(dome.x, dome.y, 34, -1.2, angle);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#fff1a8';
            for (let i = 0; i < 6; i++) {
                const a = -1.2 + (angle + 1.2) * (i / 5);
                ctx.fillRect(Math.round(dome.x + Math.cos(a) * 34), Math.round(dome.y + Math.sin(a) * 34), 2, 2);
            }
            ctx.restore();
        }
        if (ritual.label) this._drawRitualLabel(ctx, dome.x, dome.y + 54, ritual.label, '#bda7ff', fade);
    }

    _drawPortalRitual(ctx, gate, ritual) {
        if (!ritual) return;
        const fade = this._ritualFade(ritual);
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.fillStyle = 'rgba(22, 35, 48, 0.86)';
        ctx.strokeStyle = '#8feaff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect?.(gate.x - 42, gate.y - 58, 84, 24, 4);
        if (!ctx.roundRect) ctx.rect(gate.x - 42, gate.y - 58, 84, 24);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#d9fbff';
        ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(compactRitualLabel(ritual.label, 'PORTAL'), gate.x, gate.y - 46);
        ctx.restore();
    }

    _drawTaskboardRitual(ctx, localPoint) {
        const rituals = this._ritualsFor('taskboard').slice(-4);
        if (!rituals.length) return;
        const board = localPoint(56, 58);
        rituals.forEach((ritual, index) => {
            const progress = this._ritualProgress(ritual);
            const fade = this._ritualFade(ritual);
            const col = index % 2;
            const row = Math.floor(index / 2);
            const fall = ritual.action === 'complete'
                ? (ritual.motionEnabled === false ? 8 : Math.max(0, progress - 0.22) * 42)
                : 0;
            const x = board.x - 24 + col * 24;
            const y = board.y - 28 + row * 18 + fall;
            ctx.save();
            ctx.globalAlpha = fade;
            ctx.fillStyle = '#e8cf91';
            ctx.strokeStyle = '#4a3420';
            ctx.lineWidth = 1;
            ctx.fillRect(Math.round(x), Math.round(y), 20, 15);
            ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, 19, 14);
            ctx.fillStyle = '#785332';
            ctx.fillRect(Math.round(x + 9), Math.round(y - 2), 3, 4);
            if (ritual.action === 'complete') {
                ctx.strokeStyle = '#2d6b47';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(x + 3, y + 8);
                ctx.lineTo(x + 17, y + 5);
                ctx.stroke();
            }
            ctx.restore();
        });
    }

    _drawCommandRitual(ctx, localPoint) {
        const rituals = this._ritualsFor('command');
        if (!rituals.length) return;
        const keep = localPoint(155, 34);
        for (const ritual of rituals) {
            const fade = this._ritualFade(ritual);
            if (ritual.action === 'message') {
                this._drawCarrierBird(ctx, keep, ritual, fade);
                continue;
            }
            ctx.save();
            ctx.globalAlpha = fade;
            ctx.fillStyle = '#201814';
            ctx.fillRect(Math.round(keep.x), Math.round(keep.y - 38), 2, 34);
            ctx.fillStyle = '#f2d36b';
            ctx.strokeStyle = '#3a2614';
            ctx.beginPath();
            ctx.moveTo(keep.x + 2, keep.y - 38);
            ctx.lineTo(keep.x + 28, keep.y - 31);
            ctx.lineTo(keep.x + 2, keep.y - 24);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        }
    }

    _drawCarrierBird(ctx, source, ritual, fade) {
        const target = this._chatTargetForRitual(ritual) || { x: source.x + 52, y: source.y + 2 };
        const progress = ritual.motionEnabled === false ? 1 : clamp01(this._ritualProgress(ritual) / 0.72);
        const control = { x: (source.x + target.x) / 2, y: Math.min(source.y, target.y) - 70 };
        const inv = 1 - progress;
        const x = inv * inv * source.x + 2 * inv * progress * control.x + progress * progress * target.x;
        const y = inv * inv * (source.y - 24) + 2 * inv * progress * control.y + progress * progress * (target.y - 42);
        if (ritual.motionEnabled === false) {
            this._drawRitualLabel(ctx, source.x, source.y - 54, 'MSG', '#f2d36b', fade);
            return;
        }
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.fillStyle = '#f1ead0';
        ctx.strokeStyle = '#45311c';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(x, y, 7, 4, -0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = '#f2d36b';
        ctx.beginPath();
        ctx.moveTo(x - 2, y);
        ctx.quadraticCurveTo(x - 10, y - 8, x - 15, y - 2);
        ctx.moveTo(x + 2, y);
        ctx.quadraticCurveTo(x + 10, y - 8, x + 15, y - 2);
        ctx.stroke();
        ctx.restore();
    }

    _drawWatchtowerRitual(ctx, beacon) {
        const active = this.agentSprites.filter(sprite => sprite?.agent?.status === 'WORKING').length;
        if (active <= 1) return;
        const intensity = Math.min(1, active / 5);
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.08 + intensity * 0.16;
        ctx.strokeStyle = '#ffd36a';
        ctx.lineWidth = 5 + intensity * 4;
        const angle = this.motionScale ? this.frame * 0.025 * (1 + Math.min(1.4, active / 5)) : -0.35;
        ctx.beginPath();
        ctx.moveTo(beacon.x, beacon.y);
        ctx.lineTo(beacon.x + Math.cos(angle) * 120, beacon.y + Math.sin(angle) * 54);
        ctx.stroke();
        ctx.restore();
    }

    _drawRitualLabel(ctx, x, y, label, color, alpha = 1) {
        const text = compactRitualLabel(label);
        if (!text) return;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        const width = Math.max(28, ctx.measureText(text).width + 10);
        ctx.fillStyle = 'rgba(30, 24, 18, 0.82)';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.fillRect(Math.round(x - width / 2), Math.round(y - 7), Math.round(width), 14);
        ctx.strokeRect(Math.round(x - width / 2) + 0.5, Math.round(y - 7) + 0.5, Math.round(width) - 1, 13);
        ctx.fillStyle = '#fff0c4';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, Math.round(x), Math.round(y));
        ctx.restore();
    }

    _chatTargetForRitual(ritual) {
        const source = this.agentSprites.find(sprite => sprite?.agent?.id === ritual.agentId);
        return source?.chatPartner || null;
    }

    _mineSeamColor() {
        const ratio = clamp01(this.quotaState?.fiveHour ?? this.quotaState?.fiveHourRatio ?? 0);
        if (ratio <= 0.5) return MINE_SEAM_COLORS[0];
        if (ratio <= 0.8) return mixHex(MINE_SEAM_COLORS[0], MINE_SEAM_COLORS[1], (ratio - 0.5) / 0.3);
        return mixHex(MINE_SEAM_COLORS[1], MINE_SEAM_COLORS[2], (ratio - 0.8) / 0.2);
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

    _drawFootprintContactPad(ctx, building, { isLandmark = false, isHovered = false } = {}) {
        const corners = this._buildingFootprintCorners(building);
        ctx.save();
        ctx.globalAlpha = isHovered ? 0.86 : isLandmark ? 0.66 : 0.54;
        ctx.fillStyle = isLandmark ? 'rgba(69, 55, 33, 0.34)' : 'rgba(34, 29, 23, 0.30)';
        this._traceFootprint(ctx, corners);
        ctx.fill();

        ctx.globalAlpha = isHovered ? 0.72 : 0.44;
        ctx.strokeStyle = isHovered ? 'rgba(255, 230, 156, 0.78)' : 'rgba(25, 18, 13, 0.58)';
        ctx.lineWidth = isHovered ? 2 : 1.25;
        this._traceFootprint(ctx, corners);
        ctx.stroke();

        ctx.globalAlpha = isHovered ? 0.52 : 0.34;
        ctx.strokeStyle = 'rgba(8, 10, 12, 0.72)';
        ctx.lineWidth = isHovered ? 5 : 4;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(corners.ne.x, corners.ne.y);
        ctx.lineTo(corners.se.x, corners.se.y);
        ctx.lineTo(corners.sw.x, corners.sw.y);
        ctx.stroke();

        ctx.globalAlpha = isHovered ? 0.42 : 0.24;
        ctx.strokeStyle = 'rgba(230, 200, 126, 0.48)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(corners.nw.x, corners.nw.y);
        ctx.lineTo(corners.ne.x, corners.ne.y);
        ctx.moveTo(corners.nw.x, corners.nw.y);
        ctx.lineTo(corners.sw.x, corners.sw.y);
        ctx.stroke();
        ctx.restore();
    }

    _buildingFootprintCorners(building) {
        const x0 = building.position.tileX;
        const y0 = building.position.tileY;
        const x1 = x0 + building.width;
        const y1 = y0 + building.height;
        return {
            nw: this._tileToScreen(x0, y0),
            ne: this._tileToScreen(x1, y0),
            se: this._tileToScreen(x1, y1),
            sw: this._tileToScreen(x0, y1),
        };
    }

    _traceFootprint(ctx, corners) {
        ctx.beginPath();
        ctx.moveTo(corners.nw.x, corners.nw.y);
        ctx.lineTo(corners.ne.x, corners.ne.y);
        ctx.lineTo(corners.se.x, corners.se.y);
        ctx.lineTo(corners.sw.x, corners.sw.y);
        ctx.closePath();
    }

    _buildingFrontSortY(building, fallbackY) {
        const anchorY = this._anchorSortY(building);
        return Number.isFinite(anchorY) ? Math.max(fallbackY, anchorY - 0.5) : fallbackY;
    }

    _buildingWholeSortY(building, fallbackY) {
        const anchorY = this._anchorSortY(building);
        return Number.isFinite(anchorY) ? anchorY - 0.5 : fallbackY;
    }

    // Depth anchor for building drawables. The minimum visit-tile screen-y
    // ensures every declared visit tile draws in front; clamping by the
    // southeast footprint corner restores standard isometric occlusion when
    // visit tiles sit south of the corner (mine, taskboard, portal, etc.) so
    // characters at the SE edge are no longer covered by the building.
    _anchorSortY(building) {
        const tiles = Array.isArray(building?.visitTiles) ? building.visitTiles : [];
        let minY = Infinity;
        for (const tile of tiles) {
            if (!Number.isFinite(tile?.tileX) || !Number.isFinite(tile?.tileY)) continue;
            const y = this._tileToScreen(tile.tileX, tile.tileY).y;
            if (y < minY) minY = y;
        }
        if (!Number.isFinite(minY) && building?.entrance) {
            const { tileX, tileY } = building.entrance;
            if (Number.isFinite(tileX) && Number.isFinite(tileY)) {
                minY = this._tileToScreen(tileX, tileY).y;
            }
        }
        if (!Number.isFinite(minY)) return null;
        const pos = building?.position;
        if (pos
            && Number.isFinite(pos.tileX)
            && Number.isFinite(pos.tileY)
            && Number.isFinite(building.width)
            && Number.isFinite(building.height)) {
            const seX = pos.tileX + building.width - 1;
            const seY = pos.tileY + building.height - 1;
            return Math.min(minY, this._tileToScreen(seX, seY).y);
        }
        return minY;
    }

    _tileToScreen(tileX, tileY) {
        return {
            x: (tileX - tileY) * TILE_WIDTH / 2,
            y: (tileX + tileY) * TILE_HEIGHT / 2,
        };
    }

    _buildingScreenCenter(b) {
        const cx = b.position.tileX + b.width / 2;
        const cy = b.position.tileY + b.height / 2;
        return {
            x: (cx - cy) * TILE_WIDTH / 2,
            y: (cx + cy) * TILE_HEIGHT / 2,
        };
    }

    _harborLedgerRows(repos = []) {
        const active = (Array.isArray(repos) ? repos : [])
            .filter((repo) => Number(repo?.pendingCommits) > 0)
            .sort((a, b) => (Number(b.pendingCommits) - Number(a.pendingCommits))
                || String(a.repoName || a.shortName || '').localeCompare(String(b.repoName || b.shortName || '')));
        if (!active.length) return [];
        const visible = active.slice(0, 2).map((repo) => {
            const name = String(repo.shortName || repo.repoName || repo.project || 'Repo')
                .replace(/[-_]+/g, ' ')
                .replace(/\b\w/g, (char) => char.toUpperCase());
            return {
                label: `${name} (${Number(repo.pendingCommits)})`,
                color: repo.profile?.accent || '#f6d384',
            };
        });
        const remaining = active.length - visible.length;
        if (remaining > 0 && visible.length) {
            visible[visible.length - 1] = {
                ...visible[visible.length - 1],
                label: `${visible[visible.length - 1].label} +${remaining}`,
            };
        }
        return visible;
    }

    _drawLabelEmblem(ctx, building, cx, cy, size, { accent, isHovered, isLandmark } = {}) {
        const r = size / 2;
        const emblem = LANDMARK_LABEL_EMBLEMS[building.type] || 'mark';
        ctx.save();
        ctx.fillStyle = isHovered ? 'rgba(255, 230, 148, 0.98)' : isLandmark ? accent : 'rgba(214, 169, 81, 0.82)';
        ctx.strokeStyle = 'rgba(43, 28, 17, 0.88)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx + r * 0.78, cy - r * 0.52);
        ctx.lineTo(cx + r * 0.66, cy + r * 0.45);
        ctx.lineTo(cx, cy + r * 0.9);
        ctx.lineTo(cx - r * 0.66, cy + r * 0.45);
        ctx.lineTo(cx - r * 0.78, cy - r * 0.52);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.strokeStyle = '#2a1c11';
        ctx.fillStyle = '#2a1c11';
        ctx.lineWidth = Math.max(1.2, size * 0.09);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const drawLine = (...points) => {
            ctx.beginPath();
            points.forEach((point, index) => {
                if (index === 0) ctx.moveTo(cx + point[0] * r, cy + point[1] * r);
                else ctx.lineTo(cx + point[0] * r, cy + point[1] * r);
            });
            ctx.stroke();
        };

        if (emblem === 'anchor') {
            drawLine([0, -0.55], [0, 0.42]);
            drawLine([-0.32, -0.2], [0.32, -0.2]);
            ctx.beginPath();
            ctx.arc(cx, cy - r * 0.62, r * 0.16, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(cx, cy + r * 0.18, r * 0.42, 0.18 * Math.PI, 0.82 * Math.PI);
            ctx.stroke();
            drawLine([-0.45, 0.15], [-0.62, 0.02]);
            drawLine([0.45, 0.15], [0.62, 0.02]);
        } else if (emblem === 'book') {
            ctx.strokeRect(cx - r * 0.5, cy - r * 0.45, r * 0.43, r * 0.8);
            ctx.strokeRect(cx + r * 0.07, cy - r * 0.45, r * 0.43, r * 0.8);
            drawLine([0, -0.43], [0, 0.42]);
            drawLine([-0.36, -0.16], [-0.16, -0.16]);
            drawLine([0.17, -0.16], [0.36, -0.16]);
        } else if (emblem === 'hammer') {
            drawLine([-0.38, 0.42], [0.34, -0.3]);
            drawLine([0.08, -0.55], [0.55, -0.08]);
            drawLine([0.23, -0.66], [0.66, -0.23]);
        } else if (emblem === 'crown') {
            ctx.beginPath();
            ctx.moveTo(cx - r * 0.52, cy + r * 0.18);
            ctx.lineTo(cx - r * 0.38, cy - r * 0.36);
            ctx.lineTo(cx - r * 0.08, cy + r * 0.02);
            ctx.lineTo(cx + r * 0.2, cy - r * 0.45);
            ctx.lineTo(cx + r * 0.48, cy + r * 0.18);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            drawLine([-0.45, 0.36], [0.48, 0.36]);
        } else if (emblem === 'star') {
            drawLine([0, -0.58], [0.12, -0.12], [0.58, -0.08], [0.2, 0.16], [0.32, 0.58], [0, 0.28], [-0.32, 0.58], [-0.2, 0.16], [-0.58, -0.08], [-0.12, -0.12], [0, -0.58]);
        } else if (emblem === 'rune') {
            drawLine([0, -0.58], [0.46, 0], [0, 0.58], [-0.46, 0], [0, -0.58]);
            drawLine([-0.2, 0], [0.2, 0]);
        } else if (emblem === 'pick') {
            drawLine([-0.32, 0.5], [0.32, -0.42]);
            drawLine([-0.48, -0.3], [-0.04, -0.52], [0.5, -0.34]);
        } else if (emblem === 'scroll') {
            ctx.strokeRect(cx - r * 0.42, cy - r * 0.38, r * 0.84, r * 0.62);
            ctx.beginPath();
            ctx.arc(cx - r * 0.43, cy - r * 0.07, r * 0.16, Math.PI * 0.5, Math.PI * 1.5);
            ctx.stroke();
            drawLine([-0.22, -0.15], [0.28, -0.15]);
            drawLine([-0.22, 0.08], [0.18, 0.08]);
        } else if (emblem === 'flame') {
            ctx.beginPath();
            ctx.moveTo(cx, cy - r * 0.56);
            ctx.bezierCurveTo(cx + r * 0.48, cy - r * 0.05, cx + r * 0.22, cy + r * 0.5, cx, cy + r * 0.52);
            ctx.bezierCurveTo(cx - r * 0.42, cy + r * 0.25, cx - r * 0.24, cy - r * 0.16, cx, cy - r * 0.56);
            ctx.fill();
            ctx.stroke();
        } else {
            ctx.font = `bold ${Math.max(7, Math.round(size * 0.42))}px "Press Start 2P", monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(building.icon || '?', cx, cy + 0.5);
        }
        ctx.restore();
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
