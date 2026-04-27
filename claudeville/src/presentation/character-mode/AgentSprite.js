import { Position } from '../../domain/value-objects/Position.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { BUILDING_DEFS } from '../../config/buildings.js';
import { THEME } from '../../config/theme.js';
import { getModelVisualIdentity } from '../shared/ModelVisualIdentity.js';
import { SpriteSheet, dirFromVelocity, WALK_FRAMES, IDLE_FRAMES, DIRECTIONS } from './SpriteSheet.js';
import { Compositor } from './Compositor.js';

// Hit-test geometry (unchanged from vector version).
const SPRITE_HIT_HALF_WIDTH = 24;
const SPRITE_HIT_TOP = -72;
const SPRITE_HIT_BOTTOM = 24;
const WALK_PIXELS_PER_FRAME = 4.5;
const DIRECTION_HOLD_MS = 70;
const FOOTFALL_FRAMES = new Set([0, Math.floor(WALK_FRAMES / 2)]);
const STATUS_VISUALS = {
    [AgentStatus.WORKING]: {
        color: THEME.working,
        glow: 'rgba(121, 217, 117, 0.32)',
        label: 'WORK',
    },
    [AgentStatus.WAITING]: {
        color: THEME.waiting,
        glow: 'rgba(223, 140, 63, 0.34)',
        label: 'WAIT',
    },
    [AgentStatus.IDLE]: {
        color: THEME.idle,
        glow: 'rgba(134, 191, 224, 0.22)',
        label: 'IDLE',
    },
    chatting: {
        color: '#f2d36b',
        glow: 'rgba(242, 211, 107, 0.30)',
        label: 'CHAT',
    },
};
const PROVIDER_TRIM = {
    claude: '#c7a6ff',
    codex: '#67f29a',
    gemini: '#7fc7ff',
    default: '#f2d36b',
};
const TARGET_AGENT_CONTENT_HEIGHT = 92;
const MIN_AGENT_DRAW_SCALE = 1;
const MAX_AGENT_DRAW_SCALE = 1.25;
const PROCESSED_SPRITE_CACHE = new Map();

export class AgentSprite {
    constructor(agent, {
        pathfinder = null,
        bridgeTiles = null,
        assets = null,
        compositor = null,
    } = {}) {
        this.agent = agent;
        this.x = 0;
        this.y = 0;
        this.targetX = 0;
        this.targetY = 0;
        this.moving = false;
        this.walkFrame = 0;
        this.waitTimer = 0;
        this.selected = false;
        this.statusAnim = 0;
        this.motionScale = (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) ? 0 : 1;
        this._lastBuildingType = null;
        this._targetCycle = 0;
        this.nameTagSlot = 0;

        // Chat system
        this.chatPartner = null;     // Chat partner AgentSprite
        this.chatting = false;       // chatting flag
        this.chatTimer = 0;          // chat animation timer
        this.chatBubbleAnim = 0;     // speech bubble animation

        const screen = agent.position.toScreen(TILE_WIDTH, TILE_HEIGHT);
        this.x = screen.x;
        this.y = screen.y;

        this.pathfinder = pathfinder;
        this.bridgeTiles = bridgeTiles;
        this.waypoints = [];
        this._lastPathTileKey = null;
        this._pathAgeFrames = 0;

        // Guard: agents spawn from a broad random band that can overlap rivers.
        // Snap to dry walkable ground before the first target is assigned.
        this._snapToNearestWalkable();

        // Sprite rendering fields
        this.assets = assets;
        this.compositor = compositor;
        this.direction = 0;          // 0..7 index into DIRECTIONS
        this.animState = 'idle';
        this.frame = 0;
        this.frameTimer = 0;
        this._strideDistance = 0;
        this._candidateDirection = null;
        this._candidateDirectionMs = 0;
        this.spriteCanvas = null;
        this.spriteSheet = null;     // cached SpriteSheet wrapper, set on first draw
        this._spriteProfileKey = '';
        this._silhouetteCellCache = new Map();
        this._cellBoundsCache = new Map();
        this._nameTagLayoutCacheKey = '';
        this._nameTagLayoutCache = null;

        this._pickTarget();
    }

    _pickTarget() {
        // Move to the partner position when there is a chat partner
        if (this.chatPartner) {
            const offsetX = this.x < this.chatPartner.x ? -25 : 25;
            const chatTargetX = this.chatPartner.x + offsetX;
            const chatTargetY = this.chatPartner.y;
            const targetTile = this._screenToTile(chatTargetX, chatTargetY);
            this._lastPathTileKey = null; // force fresh path on every chat entry
            this._assignTarget(chatTargetX, chatTargetY, targetTile.tileX, targetTile.tileY);
            this.moving = true;
            this.waitTimer = 0;
            return;
        }

        const buildingType = this._targetBuildingTypeForState();
        let building = null;

        if (buildingType) {
            building = BUILDING_DEFS.find(b => b.type === buildingType);
        }

        if (!building) {
            const seed = Math.abs(this._hash(`${this.agent.id}:target:${this._targetCycle++}`));
            // If an active tool has no mapping, choose a stable building 70% of the time and empty ground 30% of the time.
            if (this.agent.status === AgentStatus.WORKING && (seed % 10) < 7) {
                building = BUILDING_DEFS[seed % BUILDING_DEFS.length];
            } else {
                const tile = this.pathfinder
                    ? this.pathfinder.sampleWalkable(this._noise(seed, 3))
                    : { tileX: 10 + this._noise(seed, 3) * 20, tileY: 10 + this._noise(seed, 7) * 20 };
                const target = new Position(tile.tileX, tile.tileY);
                const screen = target.toScreen(TILE_WIDTH, TILE_HEIGHT);
                this._assignTarget(screen.x, screen.y, tile.tileX, tile.tileY);
                this.moving = true;
                this.waitTimer = 0;
                return;
            }
        }

        const seed = Math.abs(this._hash(`${this.agent.id}:${building.type}:${this._targetCycle++}`));
        const target = new Position(...this._visitTileForBuilding(building, seed));
        const screen = target.toScreen(TILE_WIDTH, TILE_HEIGHT);
        this._assignTarget(screen.x, screen.y, target.tileX, target.tileY);
        this.moving = true;
        this.waitTimer = 0;
    }

    _visitTileForBuilding(building, seed) {
        const candidates = Array.isArray(building.visitTiles) && building.visitTiles.length
            ? building.visitTiles
            : building.entrance
                ? [building.entrance]
                : [{ tileX: building.x + Math.floor(building.width / 2), tileY: building.y + building.height }];
        const chosen = candidates[seed % candidates.length];
        const jitterX = (this._noise(seed, 11) - 0.5) * 0.34;
        const jitterY = (this._noise(seed, 17) - 0.5) * 0.34;
        return [chosen.tileX + jitterX, chosen.tileY + jitterY];
    }

    _assignTarget(targetScreenX, targetScreenY, targetTileX, targetTileY) {
        if (!this.pathfinder) {
            this.targetX = targetScreenX;
            this.targetY = targetScreenY;
            this.waypoints = [];
            return;
        }
        this._snapToNearestWalkable();
        const fromTile = this._screenToTile(this.x, this.y);
        const tileKey = `${Math.round(targetTileX)},${Math.round(targetTileY)}`;
        if (tileKey === this._lastPathTileKey && this.waypoints.length > 0 && this._pathAgeFrames < 30) {
            this._pathAgeFrames++;
            return;
        }
        this._pathAgeFrames = 0;
        this._lastPathTileKey = tileKey;
        const tilePath = this.pathfinder.findPath(
            fromTile,
            { tileX: targetTileX, tileY: targetTileY },
            this.bridgeTiles,
        );
        if (tilePath.length === 0) {
            this.waypoints = [];
            this.targetX = this.x;
            this.targetY = this.y;
            return;
        }
        this.waypoints = tilePath.map((t) => ({
            x: (t.tileX - t.tileY) * TILE_WIDTH / 2,
            y: (t.tileX + t.tileY) * TILE_HEIGHT / 2,
        }));
        const head = this.waypoints[0];
        this.targetX = head.x;
        this.targetY = head.y;
    }

    _screenToTile(x, y) {
        const tileX = (x / (TILE_WIDTH / 2) + y / (TILE_HEIGHT / 2)) / 2;
        const tileY = (y / (TILE_HEIGHT / 2) - x / (TILE_WIDTH / 2)) / 2;
        return { tileX, tileY };
    }

    _snapToNearestWalkable(maxRadius = 8) {
        if (!this.pathfinder || typeof this.pathfinder.nearestWalkable !== 'function') return false;
        const tile = this._screenToTile(this.x, this.y);
        const tileX = Math.round(tile.tileX);
        const tileY = Math.round(tile.tileY);
        if (this.pathfinder.isWalkable(tileX, tileY)) return false;

        const nearest = this.pathfinder.nearestWalkable(tileX, tileY, maxRadius);
        if (!nearest) return false;

        const screen = new Position(nearest.tileX, nearest.tileY).toScreen(TILE_WIDTH, TILE_HEIGHT);
        this.x = screen.x;
        this.y = screen.y;
        this.targetX = screen.x;
        this.targetY = screen.y;
        this.waypoints = [];
        this._lastPathTileKey = null;
        return true;
    }

    _targetBuildingTypeForState() {
        if (this.agent.status === AgentStatus.WORKING) {
            return this.agent.targetBuildingType || 'command';
        }
        if (this.agent.status === AgentStatus.WAITING) return this.agent.targetBuildingType || 'taskboard';
        if (this.agent.status === AgentStatus.IDLE) return null;
        return null;
    }

    _waitDurationForState() {
        if (this.agent.status === AgentStatus.WORKING) return 60 + Math.floor(Math.random() * 120);
        if (this.agent.status === AgentStatus.WAITING) return 120 + Math.floor(Math.random() * 160);
        if (this.agent.status === AgentStatus.IDLE) return 240 + Math.floor(Math.random() * 260);
        return 90;
    }

    _speedForState() {
        if (this.chatPartner) return 2.5;
        if (this.agent.status === AgentStatus.WORKING) return 1.5;
        if (this.agent.status === AgentStatus.WAITING) return 1.1;
        if (this.agent.status === AgentStatus.IDLE) return 0.8;
        return 1.2;
    }

    setMotionScale(scale) {
        this.motionScale = scale;
    }

    update(particleSystem, dt = 16) {
        const frameScale = Math.max(0, Math.min(3, dt / 16));
        this.statusAnim += 0.05 * this.motionScale * frameScale;

        // Handle chatting state
        if (this.chatting) {
            this.chatBubbleAnim += 0.06 * frameScale;
            this._advanceIdleAnimation(dt);
            return; // Do not move while chatting
        }

        // Moving toward the chat partner; start chatting when close
        if (this.chatPartner) {
            const cpDx = this.chatPartner.x - this.x;
            const cpDy = this.chatPartner.y - this.y;
            const cpDist = Math.sqrt(cpDx * cpDx + cpDy * cpDy);
            if (cpDist < 35) {
                this.chatting = true;
                this.chatBubbleAnim = 0;
                this.moving = false;
                this._resetWalkCycle();
                // Derive facing direction toward chat partner.
                const dir = dirFromVelocity(cpDx, cpDy);
                if (dir != null) this.direction = dir;
                // Put the partner in chat state too
                if (!this.chatPartner.chatting) {
                    this.chatPartner.chatPartner = this;
                    this.chatPartner.chatting = true;
                    this.chatPartner.chatBubbleAnim = 0;
                    this.chatPartner.moving = false;
                    this.chatPartner._resetWalkCycle();
                    // Partner faces back.
                    const partnerDir = dirFromVelocity(-cpDx, -cpDy);
                    if (partnerDir != null) this.chatPartner.direction = partnerDir;
                }
                return;
            }
            // Refresh target when the partner position changes — route via pathfinder.
            const offsetX = this.x < this.chatPartner.x ? -25 : 25;
            const chatTargetX = this.chatPartner.x + offsetX;
            const chatTargetY = this.chatPartner.y;
            const chatTargetTile = this._screenToTile(chatTargetX, chatTargetY);
            this._assignTarget(chatTargetX, chatTargetY, chatTargetTile.tileX, chatTargetTile.tileY);
        }

        // Reroute immediately when status or fresh tool changes the intended building.
        if (!this.chatPartner) {
            const curBuilding = this._targetBuildingTypeForState();
            if (curBuilding !== this._lastBuildingType) {
                this._lastBuildingType = curBuilding;
                this._pickTarget();
            }
        }

        if (this.waitTimer > 0) {
            this.waitTimer -= frameScale;
            if (this.waitTimer <= 0) {
                this._pickTarget();
            }
            this._advanceIdleAnimation(dt);
            return;
        }

        if (!this.moving) {
            this._snapToNearestWalkable();
            this._advanceIdleAnimation(dt);
            this._pickTarget();
            return;
        }

        const dx = this.targetX - this.x;
        const dy = this.targetY - this.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const speed = this._speedForState();
        const step = speed * frameScale;

        if (dist < step) {
            this.x = this.targetX;
            this.y = this.targetY;
            this._advanceWalkAnimation(dist, dx, dy, dt, particleSystem);
            if (this.waypoints && this.waypoints.length > 0) {
                this.waypoints.shift();
                if (this.waypoints.length > 0) {
                    this.targetX = this.waypoints[0].x;
                    this.targetY = this.waypoints[0].y;
                    return;
                }
            }
            this.moving = false;
            this.waitTimer = this.chatPartner ? 10 : this._waitDurationForState();
            this._resetWalkCycle();
            return;
        }

        this.x += (dx / dist) * step;
        this.y += (dy / dist) * step;
        this._advanceWalkAnimation(step, dx, dy, dt, particleSystem);
    }

    _advanceWalkAnimation(distance, dx, dy, dt, particleSystem) {
        this.animState = this.motionScale > 0 ? 'walk' : 'idle';
        this._updateFacingDirection(dx, dy, dt);

        if (this.motionScale <= 0) {
            this.frame = 0;
            this.frameTimer = 0;
            this.walkFrame = 0;
            return;
        }

        const previousFrame = this.frame % WALK_FRAMES;
        this._strideDistance += Math.max(0, distance);
        this.frame = Math.floor(this._strideDistance / WALK_PIXELS_PER_FRAME) % WALK_FRAMES;
        this.walkFrame = this.frame;
        this.frameTimer = 0;

        if (
            particleSystem &&
            this.agent.status === AgentStatus.WORKING &&
            previousFrame !== this.frame &&
            FOOTFALL_FRAMES.has(this.frame)
        ) {
            const footSide = this.frame === 0 ? -5 : 5;
            particleSystem.spawn('footstep', this.x + footSide, this.y + 7, 1);
        }
    }

    _advanceIdleAnimation(dt) {
        this.animState = 'idle';
        if (this.motionScale <= 0) {
            this.frame = 0;
            this.frameTimer = 0;
            return;
        }
        this.frameTimer += dt;
        const tick = 500;
        while (this.frameTimer > tick) {
            this.frame = (this.frame + 1) % IDLE_FRAMES;
            this.frameTimer -= tick;
        }
    }

    _updateFacingDirection(dx, dy, dt) {
        const dir = dirFromVelocity(dx, dy);
        if (dir == null || dir === this.direction) {
            this._candidateDirection = null;
            this._candidateDirectionMs = 0;
            return;
        }
        if (this._candidateDirection !== dir) {
            this._candidateDirection = dir;
            this._candidateDirectionMs = 0;
        }
        this._candidateDirectionMs += dt;
        if (this._candidateDirectionMs >= DIRECTION_HOLD_MS) {
            this.direction = dir;
            this._candidateDirection = null;
            this._candidateDirectionMs = 0;
        }
    }

    _resetWalkCycle() {
        this.walkFrame = 0;
        this._strideDistance = 0;
        this._candidateDirection = null;
        this._candidateDirectionMs = 0;
        this.frameTimer = 0;
        this.frame = 0;
        this.animState = 'idle';
    }

    /** Start chat (called from IsometricRenderer) */
    startChat(partnerSprite) {
        this.chatPartner = partnerSprite;
        this.chatting = false;
        this.chatBubbleAnim = 0;
        this._pickTarget(); // start moving toward the partner
    }

    /** End chat */
    endChat() {
        this.chatPartner = null;
        this.chatting = false;
        this.chatBubbleAnim = 0;
        this._pickTarget(); // resume normal behavior
    }

    draw(ctx, zoom = 1) {
        this._zoom = zoom;

        if (!this.compositor) return;       // defensive: no compositor → render nothing

        const identity = getModelVisualIdentity(this.agent.model, this.agent.effort, this.agent.provider);
        const provider = this._providerKey();
        const variant = this._hashVariant();
        const spriteId = identity.spriteId || `agent.${provider}.base`;
        const paletteKey = identity.paletteKey || provider;
        const accessory = identity.effortAccessory ?? null;
        const equipmentKey = identity.effortWeapon || '_';
        const cleanupKey = identity.suppressBakedWeapon ? 'clean' : 'raw';
        const profileKey = `${spriteId}|${paletteKey}|${variant}|${accessory || '_'}|${equipmentKey}|${cleanupKey}`;

        if (!this.spriteCanvas || this._spriteProfileKey !== profileKey) {
            const baseCanvas = this.compositor.spriteFor(spriteId, paletteKey, variant, accessory);
            this.spriteCanvas = this._prepareSpriteCanvas(baseCanvas, identity, profileKey);
            if (this.spriteCanvas) {
                this.spriteSheet = new SpriteSheet(this.spriteCanvas);
                this._spriteProfileKey = profileKey;
                this._silhouetteCellCache.clear();
                this._cellBoundsCache.clear();
            }
        }

        if (!this.spriteCanvas || !this.spriteSheet) return;

        // Ensure animState reflects current movement (idle when not moving).
        this.animState = this.moving && this.motionScale > 0 ? 'walk' : 'idle';

        // Strong ground language keeps agents readable against dense pixel-art terrain.
        this._drawGrounding(ctx);

        if (!this.selected && zoom < 1) {
            this._drawLowZoomImpostor(ctx);
            this._drawCompactNameStatus(ctx);
            return;
        }

        const cell = this.spriteSheet.cell(this.animState, this.direction, this.frame);
        const cellSize = this.spriteSheet?.cellSize || 92;
        const bounds = this._getCellContentBounds(cell);
        const drawScale = this._spriteDrawScale(bounds);
        // Subtle ±0.6px sinusoidal bob while idle so the eye can find still agents.
        const bobY = this.animState === 'idle'
            ? Math.round(Math.sin(this.frame * 0.4) * 0.6)
            : 0;
        const drawX = this._snapWorldToScreenPixel(this.x);
        const drawY = this._snapWorldToScreenPixel(this.y);
        const contentCenterX = (bounds.minX + bounds.maxX) / 2;
        const dx = drawX - contentCenterX * drawScale;
        const dy = drawY - bounds.maxY * drawScale + 2 + bobY;
        const contentTopY = dy + bounds.minY * drawScale;
        this._drawCodexEffortWeapon(ctx, identity, { dx, dy, bounds, cellSize, drawScale }, 'back');
        this._drawSpriteSilhouette(ctx, cell, dx, dy, drawScale);
        ctx.drawImage(
            this.spriteCanvas,
            cell.sx, cell.sy, cell.sw, cell.sh,
            dx, dy, cell.sw * drawScale, cell.sh * drawScale
        );
        this._drawCodexEffortWeapon(ctx, identity, { dx, dy, bounds, cellSize, drawScale }, 'front');

        // Effort floor ring — always visible, identity-driven (under feet, under selection halo).
        if (this.assets) {
            const identity = getModelVisualIdentity(this.agent.model, this.agent.effort, this.agent.provider);
            const effortRingId = identity.effortFloorRing;
            if (effortRingId) {
                const effortRing = this.assets.get(effortRingId);
                if (effortRing) {
                    const dims = this.assets.getDims(effortRingId);
                    ctx.drawImage(
                        effortRing,
                        Math.round(this.x - dims.w / 2),
                        Math.round(this.y - dims.h / 2),
                        dims.w,
                        dims.h
                    );
                }
            }
        }

        // Selection halo (if selected) — outer glow + pulsed ring at feet level.
        if (this.selected) {
            ctx.save();
            ctx.fillStyle = 'rgba(242, 211, 107, 0.18)';
            ctx.beginPath();
            ctx.ellipse(Math.round(this.x), Math.round(this.y - 2), 22, 8, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            this._drawFocusPillar(ctx, contentTopY);
            this._drawSelectionRing(ctx);
        }

        // Chat bubble overlay (if chatting).
        // Per-agent floating text bubbles are deferred to Phase 4; the chat
        // ellipsis animation already handled by _drawChatEffect below.
        if (this.chatting) {
            this._drawChatEffect(ctx);
        } else {
            this._drawStatus(ctx, contentTopY);
        }
        this._drawNameTag(ctx);
    }

    _prepareSpriteCanvas(baseCanvas, identity, cacheKey) {
        if (!baseCanvas || !identity?.suppressBakedWeapon) return baseCanvas;
        if (PROCESSED_SPRITE_CACHE.has(cacheKey)) return PROCESSED_SPRITE_CACHE.get(cacheKey);

        const canvas = document.createElement('canvas');
        canvas.width = baseCanvas.width;
        canvas.height = baseCanvas.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(baseCanvas, 0, 0);
        this._clearBakedCodexSidearmPixels(ctx, canvas.width, canvas.height);
        PROCESSED_SPRITE_CACHE.set(cacheKey, canvas);
        return canvas;
    }

    _clearBakedCodexSidearmPixels(ctx, width, height) {
        const cellSize = Math.round(width / DIRECTIONS.length) || 92;
        const rows = Math.floor(height / cellSize);
        if (!Number.isFinite(cellSize) || cellSize <= 0 || rows <= 0) return;

        const image = ctx.getImageData(0, 0, width, height);
        const data = image.data;
        const marks = new Uint8Array(width * height);
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < DIRECTIONS.length; col++) {
                const zones = this._bakedWeaponMaskZones(DIRECTIONS[col], cellSize);
                for (const zone of zones) {
                    this._markBakedWeaponPixels(data, marks, width, col * cellSize, row * cellSize, zone);
                }
            }
        }

        const expanded = new Uint8Array(marks.length);
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = y * width + x;
                if (!marks[idx]) continue;
                for (let oy = -1; oy <= 1; oy++) {
                    for (let ox = -1; ox <= 1; ox++) expanded[(y + oy) * width + x + ox] = 1;
                }
            }
        }
        for (let i = 0; i < expanded.length; i++) {
            if (!expanded[i]) continue;
            data[i * 4 + 3] = 0;
        }
        ctx.putImageData(image, 0, 0);
    }

    _bakedWeaponMaskZones(directionKey, cellSize) {
        const z = (x1, y1, x2, y2) => ({
            x1: Math.round(x1 * cellSize),
            y1: Math.round(y1 * cellSize),
            x2: Math.round(x2 * cellSize),
            y2: Math.round(y2 * cellSize),
        });
        return {
            s: [z(0.08, 0.46, 0.40, 0.98), z(0.62, 0.46, 0.92, 0.98)],
            se: [z(0.42, 0.43, 0.96, 0.96)],
            e: [z(0.46, 0.40, 0.98, 0.90)],
            ne: [z(0.46, 0.36, 0.98, 0.88)],
            n: [z(0.08, 0.46, 0.38, 0.96), z(0.62, 0.46, 0.92, 0.96)],
            nw: [z(0.02, 0.36, 0.54, 0.88)],
            w: [z(0.02, 0.40, 0.54, 0.90)],
            sw: [z(0.04, 0.43, 0.58, 0.96)],
        }[directionKey] || [];
    }

    _markBakedWeaponPixels(data, marks, width, originX, originY, zone) {
        const x1 = Math.max(0, originX + zone.x1);
        const y1 = Math.max(0, originY + zone.y1);
        const x2 = Math.min(width - 1, originX + zone.x2);
        const y2 = Math.min(Math.floor(data.length / 4 / width) - 1, originY + zone.y2);
        for (let y = y1; y <= y2; y++) {
            for (let x = x1; x <= x2; x++) {
                const p = (y * width + x) * 4;
                const a = data[p + 3];
                if (a < 16) continue;
                const r = data[p];
                const g = data[p + 1];
                const b = data[p + 2];
                const brightBlade = r > 168 && g > 168 && b > 152;
                const cyanBlade = g > 150 && b > 150 && Math.abs(g - b) < 56 && r < 170;
                const greyMetal = r > 78 && g > 78 && b > 78 && Math.max(r, g, b) - Math.min(r, g, b) < 42;
                const goldHilt = r > 150 && g > 95 && g < 190 && b < 95;
                if (brightBlade || cyanBlade || greyMetal || goldHilt) marks[y * width + x] = 1;
            }
        }
    }

    _drawGrounding(ctx) {
        const visual = this._statusVisual();
        const trim = this._providerTrimColor();
        const pulse = 0.75 + 0.25 * Math.sin(this.statusAnim * 2.2);
        const walking = this.animState === 'walk' && this.motionScale > 0;
        const strideCompression = walking
            ? Math.abs(Math.sin((this.frame % WALK_FRAMES) / WALK_FRAMES * Math.PI * 2))
            : 0;
        const shadowRadiusX = 20 + strideCompression * 1.6;
        const shadowRadiusY = 7 - strideCompression * 0.9;
        ctx.save();
        ctx.translate(Math.round(this.x), Math.round(this.y));

        ctx.fillStyle = 'rgba(5, 8, 12, 0.56)';
        ctx.beginPath();
        ctx.ellipse(0, 6, shadowRadiusX, shadowRadiusY, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(246, 218, 130, 0.10)';
        ctx.beginPath();
        ctx.ellipse(0, 2, 17, 5, 0, 0, Math.PI * 2);
        ctx.fill();

        if (visual) {
            ctx.globalAlpha = this.selected ? 0.95 : 0.26 + 0.16 * pulse;
            ctx.strokeStyle = visual.color;
            ctx.lineWidth = this.selected ? 2 : 1.2;
            ctx.beginPath();
            ctx.ellipse(0, 4, this.selected ? 24 : 18, this.selected ? 8 : 6, 0, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.globalAlpha = this.selected ? 0.85 : 0.42;
        ctx.strokeStyle = trim;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(0, 4, this.selected ? 17 : 12, this.selected ? 5 : 4, 0, Math.PI * 0.12, Math.PI * 0.88);
        ctx.stroke();
        ctx.restore();
    }

    _drawFocusPillar(ctx, contentTopY) {
        const visual = this._statusVisual();
        const trim = this._providerTrimColor();
        const top = contentTopY - 6;
        const gradient = ctx.createLinearGradient(this.x, top, this.x, this.y + 8);
        gradient.addColorStop(0, this._rgba(trim, 0));
        gradient.addColorStop(0.34, this._rgba(trim, 0.22));
        gradient.addColorStop(1, this._rgba(visual?.color || '#f2d36b', 0.08));
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(this.x - 13, this.y + 8);
        ctx.lineTo(this.x - 4, top);
        ctx.lineTo(this.x + 4, top);
        ctx.lineTo(this.x + 13, this.y + 8);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    // X-ray pass: blits the current animation cell with alpha so a selected
    // agent stays visible behind a building's front-half. Avoids the full-
    // sprite-sheet blit that drawing via SpriteRenderer.drawSilhouette would
    // produce against multi-direction agent sheets.
    drawXraySilhouette(ctx) {
        if (!this.spriteCanvas || !this.spriteSheet) return;
        const cell = this.spriteSheet.cell(this.animState, this.direction, this.frame);
        const bounds = this._getCellContentBounds(cell);
        const drawScale = this._spriteDrawScale(bounds);
        const drawX = this._snapWorldToScreenPixel(this.x);
        const drawY = this._snapWorldToScreenPixel(this.y);
        const contentCenterX = (bounds.minX + bounds.maxX) / 2;
        const dx = drawX - contentCenterX * drawScale;
        const dy = drawY - bounds.maxY * drawScale + 2;
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.globalAlpha = 0.4;
        ctx.drawImage(
            this.spriteCanvas,
            cell.sx, cell.sy, cell.sw, cell.sh,
            dx, dy, cell.sw * drawScale, cell.sh * drawScale
        );
        ctx.restore();
    }

    _drawSpriteSilhouette(ctx, cell, dx, dy, drawScale = 1) {
        const silhouette = this._getSilhouetteCell(cell);
        if (!silhouette) return;
        ctx.drawImage(
            silhouette,
            dx - 2 * drawScale,
            dy - 2 * drawScale,
            silhouette.width * drawScale,
            silhouette.height * drawScale
        );
    }

    _getSilhouetteCell(cell) {
        if (!this.spriteCanvas) return null;
        const key = `${cell.sx},${cell.sy},${cell.sw},${cell.sh}`;
        const cached = this._silhouetteCellCache.get(key);
        if (cached) return cached;

        const pad = 2;
        const black = document.createElement('canvas');
        black.width = cell.sw + pad * 2;
        black.height = cell.sh + pad * 2;
        const blackCtx = black.getContext('2d');
        blackCtx.imageSmoothingEnabled = false;
        blackCtx.drawImage(this.spriteCanvas, cell.sx, cell.sy, cell.sw, cell.sh, pad, pad, cell.sw, cell.sh);
        blackCtx.globalCompositeOperation = 'source-in';
        blackCtx.fillStyle = 'black';
        blackCtx.fillRect(0, 0, black.width, black.height);

        const outline = document.createElement('canvas');
        outline.width = black.width;
        outline.height = black.height;
        const outlineCtx = outline.getContext('2d');
        outlineCtx.imageSmoothingEnabled = false;
        outlineCtx.globalAlpha = 0.54;
        const offsets = [
            [-2, 0], [2, 0], [0, -2], [0, 2],
            [-1, -1], [1, -1], [-1, 1], [1, 1],
        ];
        for (const [ox, oy] of offsets) {
            outlineCtx.drawImage(black, ox, oy);
        }
        this._silhouetteCellCache.set(key, outline);
        return outline;
    }

    _getCellContentBounds(cell) {
        const key = `${cell.sx},${cell.sy},${cell.sw},${cell.sh}`;
        const cached = this._cellBoundsCache.get(key);
        if (cached) return cached;

        const scratch = document.createElement('canvas');
        scratch.width = cell.sw;
        scratch.height = cell.sh;
        const scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
        scratchCtx.imageSmoothingEnabled = false;
        scratchCtx.drawImage(this.spriteCanvas, cell.sx, cell.sy, cell.sw, cell.sh, 0, 0, cell.sw, cell.sh);
        const data = scratchCtx.getImageData(0, 0, cell.sw, cell.sh).data;
        let minX = cell.sw;
        let minY = cell.sh;
        let maxX = 0;
        let maxY = 0;
        for (let y = 0; y < cell.sh; y++) {
            for (let x = 0; x < cell.sw; x++) {
                if (data[(y * cell.sw + x) * 4 + 3] < 16) continue;
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }
        const bounds = maxX > minX && maxY > minY
            ? { minX, minY, maxX, maxY }
            : { minX: 24, minY: 12, maxX: cell.sw - 24, maxY: cell.sh - 18 };
        this._cellBoundsCache.set(key, bounds);
        return bounds;
    }

    _spriteDrawScale(bounds) {
        const height = Math.max(1, bounds.maxY - bounds.minY + 1);
        const scale = TARGET_AGENT_CONTENT_HEIGHT / height;
        return Math.max(MIN_AGENT_DRAW_SCALE, Math.min(MAX_AGENT_DRAW_SCALE, scale));
    }

    _statusVisual() {
        // Sprite-level chatting flag overrides domain status because chat lifecycle
        // is driven by IsometricRenderer, not the adapter feed.
        if (this.chatting) return STATUS_VISUALS.chatting;
        const rawStatus = this.agent?.status;
        const status = typeof rawStatus === 'string' ? rawStatus : (rawStatus?.value || AgentStatus.IDLE);
        return STATUS_VISUALS[status] || STATUS_VISUALS[AgentStatus.IDLE];
    }

    _drawStatusRibbon(ctx, visual) {
        const s = 1 / (this._zoom || 1);
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.scale(s, s);
        ctx.translate(0, -49);
        const w = visual.label.length * 8 + 13;
        const h = 15;
        const pulse = 0.75 + 0.25 * Math.sin(this.statusAnim * 2.4);

        ctx.fillStyle = 'rgba(24, 18, 14, 0.94)';
        ctx.strokeStyle = visual.color;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = visual.color;
        ctx.shadowBlur = 4 * pulse;
        ctx.beginPath();
        ctx.moveTo(-w / 2 + 5, -h / 2);
        ctx.lineTo(w / 2 - 5, -h / 2);
        ctx.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + 5);
        ctx.lineTo(w / 2, h / 2 - 5);
        ctx.quadraticCurveTo(w / 2, h / 2, w / 2 - 5, h / 2);
        ctx.lineTo(-w / 2 + 5, h / 2);
        ctx.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - 5);
        ctx.lineTo(-w / 2, -h / 2 + 5);
        ctx.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + 5, -h / 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.shadowBlur = 0;
        ctx.fillStyle = '#f8ead1';
        ctx.font = 'bold 7px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(visual.label, 0, 1);
        ctx.restore();
    }

    _drawSelectionRing(ctx) {
        if (!this.assets) return;
        // Pulse alpha so the ring breathes (0.7 .. 1.0 sinusoidal).
        const pulseAlpha = 0.7 + 0.3 * Math.sin(this.frame * 0.15);
        const ring = this.assets.get('overlay.status.selected');
        if (ring) {
            const dx = Math.round(this.x - ring.width / 2);
            const dy = Math.round(this.y - 6);     // just under feet
            ctx.save();
            ctx.globalAlpha = pulseAlpha;
            ctx.drawImage(ring, dx, dy);
            ctx.restore();
            return;
        }
        // Fallback: draw a simple ellipse when the overlay asset is not loaded.
        ctx.save();
        ctx.globalAlpha = pulseAlpha;
        ctx.beginPath();
        ctx.ellipse(this.x, this.y + 21, 28, 10, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(242, 211, 107, 0.24)';
        ctx.fill();
        ctx.strokeStyle = '#f2d36b';
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.restore();
    }

    _drawCodexEffortWeapon(ctx, identity, frameGeometry, layer = 'front') {
        const weapon = identity?.effortWeapon;
        if (!weapon) return;

        const directionKey = DIRECTIONS[this.direction] || 's';
        const geometry = this._codexWeaponGeometry(frameGeometry, directionKey);

        if (weapon === 'greatsword' && this._weaponBackCarryDirection(directionKey)) {
            if (layer === 'back') {
                this._drawWeaponAt(ctx, geometry.backCarry, geometry.drawScale, () => this._drawCodexBackGreatsword(ctx));
            }
            return;
        }

        if (weapon === 'polearm') {
            if (layer !== 'front') return;
            this._drawWeaponAt(ctx, geometry.polearm, geometry.drawScale, () => {
                this._drawCodexPolearm(ctx);
                this._drawWeaponGripHand(ctx);
            });
            return;
        }

        if (layer !== 'front') return;

        if (weapon === 'dagger') {
            this._drawWeaponAt(ctx, geometry.rightHand, geometry.drawScale, () => {
                this._drawCodexDagger(ctx);
                this._drawWeaponGripHand(ctx);
            });
        } else if (weapon === 'swordShield') {
            this._drawWeaponAt(ctx, geometry.shield, geometry.drawScale, () => this._drawCodexShield(ctx, geometry.shieldSlim));
            this._drawWeaponAt(ctx, geometry.rightHand, geometry.drawScale, () => {
                this._drawCodexKnightSword(ctx);
                this._drawWeaponGripHand(ctx);
            });
        } else if (weapon === 'greatsword') {
            this._drawWeaponAt(ctx, geometry.greatsword, geometry.drawScale, () => {
                this._drawCodexGreatsword(ctx);
                this._drawWeaponGripHand(ctx);
            });
        } else if (weapon === 'sledgehammer') {
            this._drawWeaponAt(ctx, geometry.polearm, geometry.drawScale, () => this._drawCodexSledgehammer(ctx));
        }
    }

    _codexWeaponGeometry({ dx, dy, bounds, drawScale = 1 }, directionKey) {
        const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
        const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
        const centerX = dx + (bounds.minX + bounds.maxX) * drawScale / 2;
        const shoulderY = dy + (bounds.minY + contentHeight * 0.36) * drawScale;
        const torsoY = dy + (bounds.minY + contentHeight * 0.56) * drawScale;
        const hipY = dy + (bounds.minY + contentHeight * 0.72) * drawScale;
        const bodyWidth = Math.max(22, Math.min(42, contentWidth));
        const sideSign = ['sw', 'w', 'nw', 'n'].includes(directionKey) ? -1 : 1;
        const handYOffset = {
            s: 4, se: 1, e: -2, ne: -7,
            n: -8, nw: -7, w: -2, sw: 1,
        }[directionKey] ?? 0;
        const rightHand = {
            x: centerX + sideSign * bodyWidth * 0.32 * drawScale,
            y: torsoY + handYOffset * drawScale,
            flipX: sideSign < 0,
            angle: this._heldWeaponLeanForDirection(directionKey),
            scale: 0.96,
        };
        const greatsword = {
            ...rightHand,
            x: rightHand.x + sideSign * 2 * drawScale,
            y: rightHand.y + 1 * drawScale,
            angle: this._greatswordLeanForDirection(directionKey),
            scale: 0.98,
        };
        const shield = {
            x: centerX - sideSign * bodyWidth * 0.34 * drawScale,
            y: torsoY + (directionKey === 'n' ? -3 : 5) * drawScale,
            flipX: sideSign < 0,
            angle: sideSign * (directionKey === 'e' || directionKey === 'w' ? -0.08 : 0.04),
            scale: directionKey === 'e' || directionKey === 'w' ? 0.86 : 0.94,
        };
        const polearm = {
            x: centerX + sideSign * bodyWidth * 0.42 * drawScale,
            y: hipY - 1 * drawScale,
            flipX: sideSign < 0,
            angle: this._polearmLeanForDirection(directionKey),
            scale: 1.02,
        };
        const backCarry = {
            x: centerX,
            y: shoulderY + 3 * drawScale,
            flipX: sideSign < 0,
            angle: directionKey === 'n' ? -0.06 : 0.04,
            scale: 0.96,
        };
        return {
            drawScale,
            rightHand,
            greatsword,
            shield,
            polearm,
            backCarry,
            shieldSlim: ['e', 'w', 'ne', 'nw'].includes(directionKey),
        };
    }

    _drawWeaponAt(ctx, pose, drawScale, drawFn) {
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.translate(Math.round(pose.x), Math.round(pose.y));
        ctx.scale(pose.flipX ? -1 : 1, 1);
        ctx.scale(drawScale * (pose.scale || 1), drawScale * (pose.scale || 1));
        ctx.rotate(pose.angle || 0);
        drawFn();
        ctx.restore();
    }

    _weaponBackCarryDirection(directionKey) {
        return directionKey === 'n' || directionKey === 'ne' || directionKey === 'nw';
    }

    _heldWeaponLeanForDirection(directionKey) {
        if (directionKey === 'e' || directionKey === 'w') return -0.20;
        if (directionKey === 'ne' || directionKey === 'nw') return -0.34;
        if (directionKey === 'n') return -0.38;
        if (directionKey === 'se' || directionKey === 'sw') return -0.04;
        return 0.08;
    }

    _greatswordLeanForDirection(directionKey) {
        if (directionKey === 'e' || directionKey === 'w') return -0.30;
        if (directionKey === 'se' || directionKey === 'sw') return -0.12;
        return 0.03;
    }

    _polearmLeanForDirection(directionKey) {
        if (directionKey === 'e' || directionKey === 'w') return -0.30;
        if (directionKey === 'ne' || directionKey === 'nw') return -0.44;
        if (directionKey === 'n') return -0.36;
        if (directionKey === 'se' || directionKey === 'sw') return -0.18;
        return -0.10;
    }

    _drawCodexDagger(ctx) {
        this._drawTaperedBlade(ctx, 0, -1, 9, -15, 3.2, 0.8);
        this._drawWeaponStroke(ctx, '#f8c45f', 3, [[-6, 3], [6, 5]]);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(-2, 4, 4, 8);
        ctx.fillStyle = '#b47a35';
        ctx.fillRect(-1, 4, 2, 7);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-3, 11, 6, 3);
    }

    _drawCodexKnightSword(ctx) {
        this._drawTaperedBlade(ctx, 0, -2, 10, -27, 3.6, 0.9);
        this._drawWeaponStroke(ctx, '#0b2430', 5, [[-8, 4], [8, 7]]);
        this._drawWeaponStroke(ctx, '#f8c45f', 3, [[-8, 4], [8, 7]]);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(-2, 5, 5, 11);
        ctx.fillStyle = '#b47a35';
        ctx.fillRect(-1, 6, 3, 9);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-4, 15, 8, 3);
    }

    _drawCodexShield(ctx, slim = false) {
        const outline = slim
            ? [[-6, -14], [8, -10], [7, 7], [1, 16], [-6, 8]]
            : [[-12, -15], [11, -11], [9, 8], [0, 17], [-10, 8]];
        const face = slim
            ? [[-4, -12], [6, -8], [5, 6], [1, 13], [-4, 6]]
            : [[-9, -12], [8, -9], [7, 6], [0, 14], [-8, 6]];
        ctx.fillStyle = '#0b2430';
        this._fillWeaponPolygon(ctx, outline);
        ctx.fillStyle = '#7f8f9b';
        this._fillWeaponPolygon(ctx, face);
        ctx.fillStyle = '#214b5a';
        this._fillWeaponPolygon(ctx, face.map(([x, y]) => [x + (slim ? 1 : 2), y + 2]));
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(slim ? 0 : -1, -7, 3, 12);
        ctx.fillRect(slim ? -3 : -5, -2, slim ? 9 : 12, 3);
        ctx.fillStyle = 'rgba(223, 252, 255, 0.75)';
        ctx.fillRect(slim ? -3 : -7, -10, slim ? 3 : 4, 2);
    }

    _drawCodexGreatsword(ctx) {
        this._drawTaperedBlade(ctx, 0, -3, 13, -39, 5.2, 1.1);
        ctx.fillStyle = '#102f3a';
        ctx.fillRect(-12, 3, 23, 6);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-10, 4, 19, 3);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(-3, 7, 7, 15);
        ctx.fillStyle = '#b47a35';
        ctx.fillRect(-1, 8, 3, 12);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-5, 20, 10, 4);
    }

    _drawCodexBackGreatsword(ctx) {
        this._drawTaperedBlade(ctx, -13, 23, 16, -31, 4.2, 1.0);
        this._drawWeaponStroke(ctx, '#0b2430', 5, [[8, -28], [24, -20]]);
        this._drawWeaponStroke(ctx, '#f8c45f', 3, [[8, -28], [24, -20]]);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(20, -27, 5, 12);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(19, -17, 7, 3);
    }

    _drawCodexPolearm(ctx) {
        this._drawWeaponStroke(ctx, '#0b2430', 6, [[-7, 30], [17, -48]]);
        this._drawWeaponStroke(ctx, '#8a5a2a', 3, [[-7, 30], [17, -48]]);
        this._drawWeaponStroke(ctx, '#d7a456', 1, [[-4, 19], [16, -45]]);
        ctx.fillStyle = '#0b2430';
        this._fillWeaponPolygon(ctx, [[15, -52], [33, -37], [22, -28], [13, -38]]);
        ctx.fillStyle = '#dce8ec';
        this._fillWeaponPolygon(ctx, [[17, -48], [29, -37], [22, -32], [15, -39]]);
        ctx.fillStyle = '#7be3d7';
        this._fillWeaponPolygon(ctx, [[24, -40], [31, -36], [23, -34]]);
        this._drawWeaponStroke(ctx, '#0b2430', 5, [[9, -31], [25, -25]]);
        this._drawWeaponStroke(ctx, '#f8c45f', 3, [[10, -32], [24, -26]]);
    }

    _drawCodexSledgehammer(ctx) {
        this._drawWeaponStroke(ctx, '#0b2430', 7, [[-3, 19], [21, -34]]);
        this._drawWeaponStroke(ctx, '#b47a35', 4, [[-3, 19], [21, -34]]);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(13, -43, 28, 16);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(16, -40, 22, 10);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(21, -37, 12, 5);
    }

    _drawWeaponGripHand(ctx) {
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(-4, -2, 8, 7);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(-3, -1, 6, 5);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-1, 0, 3, 3);
    }

    _drawWeaponStroke(ctx, color, width, points) {
        if (!points.length) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = 'square';
        ctx.lineJoin = 'miter';
        ctx.beginPath();
        ctx.moveTo(Math.round(points[0][0]), Math.round(points[0][1]));
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(Math.round(points[i][0]), Math.round(points[i][1]));
        }
        ctx.stroke();
    }

    _drawTaperedBlade(ctx, x0, y0, x1, y1, baseHalfWidth, tipHalfWidth) {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const length = Math.hypot(dx, dy) || 1;
        const px = -dy / length;
        const py = dx / length;
        const outline = this._bladePolygon(x0, y0, x1, y1, baseHalfWidth + 1.8, tipHalfWidth + 1.2, px, py);
        const blade = this._bladePolygon(x0, y0, x1, y1, baseHalfWidth, tipHalfWidth, px, py);

        ctx.fillStyle = '#0b2430';
        this._fillWeaponPolygon(ctx, outline);
        ctx.fillStyle = '#dce8ec';
        this._fillWeaponPolygon(ctx, blade);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x0 + px * baseHalfWidth * 0.35), Math.round(y0 + py * baseHalfWidth * 0.35));
        ctx.lineTo(Math.round(x1 - dx * 0.12), Math.round(y1 - dy * 0.12));
        ctx.stroke();
        ctx.strokeStyle = '#55c7f0';
        ctx.beginPath();
        ctx.moveTo(Math.round(x0 - px * baseHalfWidth * 0.55), Math.round(y0 - py * baseHalfWidth * 0.55));
        ctx.lineTo(Math.round(x1 - dx * 0.22), Math.round(y1 - dy * 0.22));
        ctx.stroke();
    }

    _bladePolygon(x0, y0, x1, y1, baseHalfWidth, tipHalfWidth, px, py) {
        return [
            [x0 + px * baseHalfWidth, y0 + py * baseHalfWidth],
            [x1 + px * tipHalfWidth, y1 + py * tipHalfWidth],
            [x1, y1],
            [x1 - px * tipHalfWidth, y1 - py * tipHalfWidth],
            [x0 - px * baseHalfWidth, y0 - py * baseHalfWidth],
        ];
    }

    _fillWeaponPolygon(ctx, points) {
        if (!points.length) return;
        ctx.beginPath();
        ctx.moveTo(Math.round(points[0][0]), Math.round(points[0][1]));
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(Math.round(points[i][0]), Math.round(points[i][1]));
        }
        ctx.closePath();
        ctx.fill();
    }

    // --- Variant and accessory helpers (used by draw to select sprite) ---

    /** Returns a palette variant index (0..3) stable for this agent. */
    _hashVariant() {
        const hash = Math.abs(this._hash(`${this.agent.id}:${this.agent.model || ''}:${this._providerKey()}`));
        return hash % 4;
    }

    // --- Provider / model helpers ---

    _providerKey() {
        const provider = String(this.agent.provider || '').toLowerCase();
        const model = String(this.agent.model || '').toLowerCase();
        if (provider.includes('gemini') || model.includes('gemini')) return 'gemini';
        if (provider.includes('codex') || model.includes('codex') || model.includes('gpt')) return 'codex';
        if (provider.includes('claude') || model.includes('claude')) return 'claude';
        return 'default';
    }

    // --- Utility helpers ---

    _hash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return hash;
    }

    _noise(seed, salt) {
        const n = Math.sin((seed + salt) * 12.9898) * 43758.5453;
        return n - Math.floor(n);
    }

    // --- Status / UI overlay drawing ---

    _drawStatus(ctx, contentTopY = null) {
        const visual = this._statusVisual();
        const text = this._activityLabel();
        this._drawBubble(ctx, text, visual.color, contentTopY);
    }

    _drawBubble(ctx, text, accentColor, contentTopY = null) {
        ctx.save();
        const s = 1 / (this._zoom || 1); // inverse zoom correction

        ctx.translate(this.x, Number.isFinite(contentTopY) ? contentTopY : this.y);
        ctx.scale(s, s); // fixed size in screen space

        // Measure text size and auto-truncate
        const anchored = Number.isFinite(contentTopY);
        ctx.font = `bold ${anchored ? 7 : 10}px "Press Start 2P", monospace`;
        const maxWidth = anchored ? 116 : 180;
        let displayText = text;
        // Truncate by actual pixel width instead of character count
        while (displayText.length > 0 && ctx.measureText(displayText).width > maxWidth) {
            displayText = displayText.substring(0, displayText.length - 1);
        }
        if (displayText.length < text.length) {
            displayText = displayText.substring(0, displayText.length - 1) + '…';
        }
        const textWidth = ctx.measureText(displayText).width;
        const bubbleW = textWidth + (anchored ? 14 : 20);
        const bubbleH = anchored ? 18 : 24;
        const radius = anchored ? 5 : 6;

        ctx.translate(0, anchored ? -18 : -50);

        // Speech bubble background
        const halfW = bubbleW / 2;
        ctx.fillStyle = 'rgba(34, 24, 19, 0.94)';
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-halfW + radius, -bubbleH / 2);
        ctx.lineTo(halfW - radius, -bubbleH / 2);
        ctx.quadraticCurveTo(halfW, -bubbleH / 2, halfW, -bubbleH / 2 + radius);
        ctx.lineTo(halfW, bubbleH / 2 - radius);
        ctx.quadraticCurveTo(halfW, bubbleH / 2, halfW - radius, bubbleH / 2);
        ctx.lineTo(4, bubbleH / 2);
        ctx.lineTo(0, bubbleH / 2 + (anchored ? 6 : 7));
        ctx.lineTo(-4, bubbleH / 2);
        ctx.lineTo(-halfW + radius, bubbleH / 2);
        ctx.quadraticCurveTo(-halfW, bubbleH / 2, -halfW, bubbleH / 2 - radius);
        ctx.lineTo(-halfW, -bubbleH / 2 + radius);
        ctx.quadraticCurveTo(-halfW, -bubbleH / 2, -halfW + radius, -bubbleH / 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Text
        ctx.fillStyle = '#f3e2bd';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(displayText, 0, 0, maxWidth);

        ctx.restore();
    }

    _bubblePath(ctx, width) {
        const hw = width / 2;
        const r = 5;
        ctx.beginPath();
        ctx.moveTo(-hw, -10);
        ctx.lineTo(hw, -10);
        ctx.quadraticCurveTo(hw + r, -10, hw + r, -10 + r);
        ctx.lineTo(hw + r, 4);
        ctx.quadraticCurveTo(hw + r, 8, hw, 8);
        ctx.lineTo(3, 8);
        ctx.lineTo(0, 14);
        ctx.lineTo(-3, 8);
        ctx.lineTo(-hw, 8);
        ctx.quadraticCurveTo(-hw - r, 8, -hw - r, 4);
        ctx.lineTo(-hw - r, -10 + r);
        ctx.quadraticCurveTo(-hw - r, -10, -hw, -10);
        ctx.closePath();
    }

    _drawChatEffect(ctx) {
        ctx.save();
        const s = 1 / (this._zoom || 1);
        ctx.translate(this.x, this.y);
        ctx.scale(s, s);

        const t = this.chatBubbleAnim;

        // Speech bubble (alternating effect)
        const phase = Math.floor(t * 1.5) % 3;
        const bubbleY = -50;

        // Background circle
        ctx.fillStyle = 'rgba(34, 24, 19, 0.94)';
        ctx.strokeStyle = '#72d071';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, bubbleY, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Tail
        ctx.fillStyle = 'rgba(34, 24, 19, 0.94)';
        ctx.beginPath();
        ctx.moveTo(-3, bubbleY + 12);
        ctx.lineTo(0, bubbleY + 18);
        ctx.lineTo(3, bubbleY + 12);
        ctx.fill();

        // Chat icon (ellipsis animation inside the speech bubble)
        ctx.fillStyle = '#72d071';
        ctx.font = 'bold 12px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const dots = ['.', '..', '...'][phase];
        ctx.fillText(dots, 0, bubbleY - 1);

        ctx.restore();
    }

    _drawNameTag(ctx) {
        if (!this.selected && this._zoom < 1.5) {
            this._drawCompactNameStatus(ctx);
            return;
        }
        if (!this.selected && this.nameTagSlot == null) {
            this._drawCompactNameStatus(ctx);
            return;
        }
        ctx.save();
        const s = 1 / (this._zoom || 1); // inverse zoom correction
        ctx.translate(this.x, this.y);
        ctx.scale(s, s); // fixed size in screen space
        ctx.translate(0, 38 + this._nameTagSlotYOffset());
        const rawName = String(this.agent.name || this.agent.displayName || '').trim() || this.agent.displayName;
        ctx.font = 'bold 8px "Press Start 2P", monospace';
        const layout = this._nameTagLayout(ctx, rawName);
        const lines = layout.lines;
        const contentW = layout.contentW;
        const w = Math.min(190, contentW + 12);
        ctx.fillStyle = this.selected ? 'rgba(255, 239, 176, 0.98)' : 'rgba(242, 211, 107, 0.90)';
        const h = lines.length > 1 ? 26 : 16;
        const r = 4;
        ctx.beginPath();
        ctx.moveTo(-w/2 + r, -h/2);
        ctx.lineTo(w/2 - r, -h/2);
        ctx.quadraticCurveTo(w/2, -h/2, w/2, -h/2 + r);
        ctx.lineTo(w/2, h/2 - r);
        ctx.quadraticCurveTo(w/2, h/2, w/2 - r, h/2);
        ctx.lineTo(-w/2 + r, h/2);
        ctx.quadraticCurveTo(-w/2, h/2, -w/2, h/2 - r);
        ctx.lineTo(-w/2, -h/2 + r);
        ctx.quadraticCurveTo(-w/2, -h/2, -w/2 + r, -h/2);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = this.selected ? '#f2d36b' : '#5a371d';
        ctx.lineWidth = this.selected ? 1.5 : 1;
        ctx.stroke();
        ctx.fillStyle = '#241812';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (lines.length === 1) {
            ctx.fillText(lines[0], 0, 1);
        } else {
            ctx.fillText(lines[0], 0, -5);
            ctx.fillText(lines[1], 0, 6);
        }
        ctx.restore();
    }

    _nameTagSlotYOffset() {
        const offsets = [0, -10, 10, -18, 18, -26, 26, -34, 34];
        return offsets[Math.min(this.nameTagSlot || 0, offsets.length - 1)];
    }

    _drawCompactAgentBadge(ctx) {
        const visual = this._statusVisual();
        const trim = this._providerTrimColor();
        const s = 1 / (this._zoom || 1);
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.scale(s, s);
        ctx.translate(0, 16 + (this.overlaySlot || 0) * 9);
        ctx.fillStyle = 'rgba(20, 14, 10, 0.78)';
        ctx.strokeStyle = trim;
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(-9, -5, 18, 10, 3);
        } else {
            ctx.rect(-9, -5, 18, 10);
        }
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = visual?.color || trim;
        ctx.font = 'bold 6px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(visual?.mark || '.', 0, 0.5);
        ctx.restore();
    }

    _drawCompactNameStatus(ctx) {
        const trim = this._providerTrimColor();
        const rawName = String(this.agent?.name || this.agent?.displayName || '').trim() || 'Agent';
        const s = 1 / (this._zoom || 1);
        const slot = this.overlaySlot ?? this.nameTagSlot ?? 0;

        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.scale(s, s);
        ctx.translate(0, 20 + slot * 11);
        ctx.font = 'bold 6px "Press Start 2P", monospace';
        const text = this._fitText(ctx, rawName, 144);
        const w = Math.min(184, Math.max(34, ctx.measureText(text).width + 14));
        const h = 13;

        ctx.fillStyle = 'rgba(20, 14, 10, 0.90)';
        ctx.strokeStyle = trim;
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(-w / 2, -h / 2, w, h, 3);
        } else {
            ctx.rect(-w / 2, -h / 2, w, h);
        }
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#f8ead1';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this._fitText(ctx, text, w - 10), 0, 0.5);
        ctx.restore();
    }

    _activityLabel() {
        const visual = this._statusVisual();
        const bubbleText = String(this.agent?.bubbleText || '').trim();
        return bubbleText || visual?.label || 'IDLE';
    }

    _nameTagLayout(ctx, rawName) {
        const key = `${rawName}|${ctx.font}`;
        if (this._nameTagLayoutCacheKey === key && this._nameTagLayoutCache) {
            return this._nameTagLayoutCache;
        }
        const lines = this._wrapNameTagLines(ctx, rawName);
        const contentW = Math.max(...lines.map(line => ctx.measureText(line).width));
        const layout = { lines, contentW };
        this._nameTagLayoutCacheKey = key;
        this._nameTagLayoutCache = layout;
        return layout;
    }

    _snapWorldToScreenPixel(value) {
        const zoom = this._zoom || 1;
        return Math.round(value * zoom) / zoom;
    }

    _drawLowZoomImpostor(ctx) {
        const visual = this._statusVisual();
        const trim = this._providerTrimColor();
        ctx.save();
        ctx.translate(Math.round(this.x), Math.round(this.y));
        ctx.fillStyle = 'rgba(7, 10, 12, 0.84)';
        ctx.strokeStyle = trim;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(0, -17);
        ctx.lineTo(9, 1);
        ctx.lineTo(0, 8);
        ctx.lineTo(-9, 1);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = visual?.color || trim;
        ctx.beginPath();
        ctx.arc(0, -3, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _providerTrimColor() {
        const identity = getModelVisualIdentity(this.agent.model, this.agent.effort, this.agent.provider);
        return identity.trim?.[0] || PROVIDER_TRIM[this._providerKey()] || PROVIDER_TRIM.default;
    }

    _rgba(color, alpha) {
        if (color.startsWith('#') && color.length === 7) {
            const r = parseInt(color.slice(1, 3), 16);
            const g = parseInt(color.slice(3, 5), 16);
            const b = parseInt(color.slice(5, 7), 16);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        return color;
    }

    _wrapNameTagLines(ctx, rawName) {
        const MAX_WIDTH = 178;
        const name = String(rawName || '').trim();
        if (!name) return ['Agent'];
        if (ctx.measureText(name).width <= MAX_WIDTH) return [name];

        const parts = name
            .replace(/-/g, '- ')
            .split(/\s+/)
            .filter(Boolean);

        const lines = [];
        let current = '';
        for (const part of parts) {
            const joiner = current && !current.endsWith('-') ? ' ' : '';
            const candidate = `${current}${joiner}${part}`;
            if (!current || ctx.measureText(candidate).width <= MAX_WIDTH) {
                current = candidate;
                continue;
            }
            lines.push(current.trim());
            current = part;
            if (lines.length === 1) break;
        }
        if (current && lines.length < 2) lines.push(current.trim());

        if (lines.length === 0) return [this._truncateNameTagLine(ctx, name, MAX_WIDTH)];
        if (lines.length === 1) return [this._truncateNameTagLine(ctx, lines[0], MAX_WIDTH)];

        const consumed = lines.join(' ').replace(/- /g, '-');
        const normalized = name.replace(/\s+/g, ' ');
        if (consumed.length < normalized.length) {
            const remaining = normalized.slice(consumed.length).trim();
            lines[1] = this._truncateNameTagLine(ctx, `${lines[1]} ${remaining}`.trim(), MAX_WIDTH);
        } else {
            lines[1] = this._truncateNameTagLine(ctx, lines[1], MAX_WIDTH);
        }
        return lines.slice(0, 2).map(line => line.replace(/- /g, '-'));
    }

    _truncateNameTagLine(ctx, text, maxWidth) {
        let out = String(text || '').trim().replace(/- /g, '-');
        if (ctx.measureText(out).width <= maxWidth) return out;
        while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
            out = out.slice(0, -1);
        }
        return `${out}…`;
    }

    _fitText(ctx, text, maxWidth) {
        let out = String(text || '').trim();
        if (!out) return '';
        if (ctx.measureText(out).width <= maxWidth) return out;
        while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
            out = out.slice(0, -1);
        }
        return `${out}…`;
    }

    hitTest(screenX, screenY) {
        const dx = screenX - this.x;
        const dy = screenY - this.y;
        return Math.abs(dx) < SPRITE_HIT_HALF_WIDTH && dy > SPRITE_HIT_TOP && dy < SPRITE_HIT_BOTTOM;
    }
}
