import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { BUILDING_DEFS } from '../../config/buildings.js';
import { THEME } from '../../config/theme.js';
import { getModelVisualIdentity } from '../shared/ModelVisualIdentity.js';
import { repoProfile } from '../shared/RepoColor.js';
import { SpriteSheet, dirFromVelocity, WALK_FRAMES, IDLE_FRAMES, DIRECTIONS } from './SpriteSheet.js';
import { Compositor } from './Compositor.js';
import { AgentBehaviorState } from './AgentBehaviorState.js';
import { tileToWorld, worldToTile } from './Projection.js';

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
const MAX_VISIBLE_FAMILIAR_MOTES = 3;
const AMBIENT_BUILDING_SEQUENCE = [
    'command',
    'taskboard',
    'forge',
    'mine',
    'portal',
    'observatory',
    'harbor',
    'archive',
    'watchtower',
];
const PROVIDER_HOME_BUILDINGS = {
    claude: 'command',
    codex: 'forge',
    gemini: 'observatory',
};
const TARGET_AGENT_CONTENT_HEIGHT = 92;
const MIN_AGENT_DRAW_SCALE = 1;
const MAX_AGENT_DRAW_SCALE = 1.25;
const PROCESSED_SPRITE_CACHE = new Map();
const CODEX_EQUIPMENT_BY_CLASS = Object.freeze({
    codex: 'engineerWrench',
    spark: 'multitool',
    gpt54: 'engineerWrench',
    gpt55: 'runeblade',
});
const CODEX_WEAPON_ASSETS = Object.freeze({
    runeblade: {
        id: 'equipment.codex.runeblade',
        fallback: 'runeblade',
        pose: 'rightHand',
        anchor: [31, 70],
        scale: 0.62,
        hands: 'single',
    },
    greatsword: {
        id: 'equipment.codex.greatsword',
        fallback: 'greatsword',
        pose: 'greatswordShoulder',
        backLayer: 'always',
        anchor: [36, 82],
        scale: 0.56,
        hands: 'single',
    },
    polearm: {
        id: 'equipment.codex.polearm',
        fallback: 'polearm',
        pose: 'polearmUpright',
        anchor: [44, 74],
        scale: 0.70,
        hands: 'double',
        handSpacing: 13,
        handVector: [-7, 12],
    },
    engineerWrench: {
        id: 'equipment.codex.engineerWrench',
        fallback: 'wrench',
        pose: 'shoulderRest',
        backPose: 'backCarry',
        anchor: [34, 70],
        scale: 0.62,
        hands: 'single',
    },
});
const EFFORT_FLOOR_RING_VISUALS = Object.freeze({
    low: { stroke: '#d7a456', highlight: '#ffe0a0', glow: 'rgba(215, 164, 86, 0.18)', bands: 1, rx: 17, ry: 5 },
    medium: { stroke: '#b8c4cc', highlight: '#eef7ff', glow: 'rgba(184, 196, 204, 0.18)', bands: 2, rx: 19, ry: 6 },
    high: { stroke: '#f2d36b', highlight: '#fff1b8', glow: 'rgba(242, 211, 107, 0.22)', bands: 3, rx: 21, ry: 7 },
});

export class AgentSprite {
    constructor(agent, {
        pathfinder = null,
        bridgeTiles = null,
        assets = null,
        compositor = null,
        getIntentForAgent = null,
        getBuilding = null,
        allocateVisitTile = null,
        releaseVisitReservation = null,
        renewVisitReservation = null,
        getAmbientDestination = null,
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
        this._lastIntentId = null;
        this._lastTargetTile = null;
        this._lastReservationId = null;
        this._lastReservationRenewedAt = 0;
        this._targetReachable = true;
        this.behavior = new AgentBehaviorState();
        this._targetCycle = 0;
        this.nameTagSlot = 0;
        this.labelAlpha = 1;
        this.bumpFlash = 0;
        this.teamPlazaPreference = false;
        this._arrivalState = 'visible';

        // Chat system
        this.chatPartner = null;     // Chat partner AgentSprite
        this.chatting = false;       // chatting flag
        this.chatTimer = 0;          // chat animation timer
        this.chatBubbleAnim = 0;     // speech bubble animation

        const screen = tileToWorld(agent.position);
        this.x = screen.x;
        this.y = screen.y;

        this.pathfinder = pathfinder;
        this.bridgeTiles = bridgeTiles;
        this.getIntentForAgent = typeof getIntentForAgent === 'function' ? getIntentForAgent : null;
        this.getBuilding = typeof getBuilding === 'function' ? getBuilding : null;
        this.allocateVisitTile = typeof allocateVisitTile === 'function' ? allocateVisitTile : null;
        this.releaseVisitReservation = typeof releaseVisitReservation === 'function' ? releaseVisitReservation : null;
        this.renewVisitReservation = typeof renewVisitReservation === 'function' ? renewVisitReservation : null;
        this.getAmbientDestination = typeof getAmbientDestination === 'function' ? getAmbientDestination : null;
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
        this._bubbleLayoutCacheKey = '';
        this._bubbleLayoutCache = null;
        this._compactNameStatusCacheKey = '';
        this._compactNameStatusCache = null;

        this._pickTarget();
    }

    _pickTarget() {
        // Move to the partner position when there is a chat partner
        if (this.chatPartner) {
            this._releaseVisitReservation();
            this.behavior.transition('chat-approach', 'chat');
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

        const intent = this._activeVisitIntent();
        let buildingType = intent?.building || this._targetBuildingTypeForState();
        let building = this._ambientDestination(intent);

        if (!building && buildingType) {
            building = this._buildingForType(buildingType);
        }

        if (!building) {
            building = this._fallbackBuildingForState();
        }

        const seed = Math.abs(this._hash(`${this.agent.id}:${building.type}:${this._targetCycle++}`));
        const [targetTileX, targetTileY] = this._visitTileForBuilding(building, seed, intent);
        const screen = tileToWorld(targetTileX, targetTileY);
        this._lastBuildingType = building.type;
        this._lastIntentId = intent?.id || null;
        this._lastTargetTile = { tileX: targetTileX, tileY: targetTileY };
        this.behavior.setRoute({
            state: intent ? 'traveling' : (building.type?.startsWith('ambient:') ? 'wandering' : 'roaming'),
            intent,
            building: building.type,
            reason: intent?.reason || (building.type?.startsWith('ambient:') ? 'scenic' : (this.agent.status === AgentStatus.IDLE ? 'ambient' : 'status')),
            targetTile: this._lastTargetTile,
        });
        this._assignTarget(screen.x, screen.y, targetTileX, targetTileY);
        this.moving = this._targetReachable;
        if (!this._targetReachable) {
            this.behavior.transition('blocked', 'no-route');
            this.waitTimer = 90;
            return;
        }
        this.waitTimer = 0;
    }

    _fallbackBuildingForState() {
        const preferred = this._ambientBuildingTypeForState();
        return this._buildingForType(preferred) || BUILDING_DEFS[0];
    }

    _ambientBuildingTypeForState() {
        const seed = Math.abs(this._hash(`${this.agent.id}:ambient:${this._targetCycle}`));
        const lastKnown = this.agent.lastKnownBuildingType || null;

        if (this.agent.status === AgentStatus.WORKING) {
            return lastKnown || 'command';
        }
        if (this.agent.status === AgentStatus.WAITING) {
            return lastKnown || 'taskboard';
        }

        if (lastKnown && (seed % 100) < this._lastKnownRevisitWeight()) return lastKnown;
        if (this.teamPlazaPreference && this.agent.teamName && (seed % 6) < 4) return 'command';
        if (this.agent.isSubagent && (seed % 6) < 2) return 'command';
        const totalTokens = (this.agent.tokens?.input || 0) + (this.agent.tokens?.output || 0);
        if (totalTokens > 0 && seed % 8 === 0) return 'mine';

        const providerHome = PROVIDER_HOME_BUILDINGS[this._providerKey()];
        if (providerHome && seed % 11 === 0 && this._recentBuildingCount(providerHome) < 2) return providerHome;

        return this._ambientSequenceChoice(seed);
    }

    _lastKnownRevisitWeight() {
        const age = Number(this.agent.activityAgeMs);
        if (!Number.isFinite(age)) return 5;
        if (age <= 30000) return 35;
        if (age <= 90000) return 15;
        return 5;
    }

    _ambientSequenceChoice(seed) {
        for (let offset = 0; offset < AMBIENT_BUILDING_SEQUENCE.length; offset++) {
            const candidate = AMBIENT_BUILDING_SEQUENCE[(seed + offset) % AMBIENT_BUILDING_SEQUENCE.length];
            if (this._recentBuildingCount(candidate) < 2) return candidate;
        }
        return AMBIENT_BUILDING_SEQUENCE[seed % AMBIENT_BUILDING_SEQUENCE.length];
    }

    _recentBuildingCount(type) {
        return this.behavior.recentCount(type);
    }

    _ambientDestination(intent = null) {
        if (intent || this.agent.status !== AgentStatus.IDLE || !this.getAmbientDestination) return null;
        if ((this._targetCycle % 3) !== 1) return null;
        return this.getAmbientDestination({
            agent: this.agent,
            sprite: this,
            recentBuildings: this.behavior.recentBuildings,
            cycle: this._targetCycle,
        });
    }

    _visitTileForBuilding(building, seed, intent = null) {
        const allocated = this.allocateVisitTile?.({
            agent: this.agent,
            sprite: this,
            building,
            intent,
        });
        if (allocated && Number.isFinite(Number(allocated.tileX)) && Number.isFinite(Number(allocated.tileY))) {
            this._lastReservationId = allocated.reservationId || null;
            this._lastReservationRenewedAt = Date.now();
            return [Number(allocated.tileX), Number(allocated.tileY)];
        }
        this._lastReservationId = null;
        const candidates = Array.isArray(building.visitTiles) && building.visitTiles.length
            ? building.visitTiles
            : building.entrance
                ? [building.entrance]
                : [{
                    tileX: (building.x ?? building.position?.tileX ?? 0) + Math.floor((building.width || 1) / 2),
                    tileY: (building.y ?? building.position?.tileY ?? 0) + (building.height || 1),
                }];
        const chosen = candidates[seed % candidates.length];
        const jitterScale = this.agent.status === AgentStatus.WORKING ? 0.64 : 0.78;
        const jitterX = (this._noise(seed, 11) - 0.5) * jitterScale;
        const jitterY = (this._noise(seed, 17) - 0.5) * jitterScale;
        return [chosen.tileX + jitterX, chosen.tileY + jitterY];
    }

    _buildingForType(type) {
        if (!type) return null;
        const normalized = type === 'lighthouse' ? 'watchtower' : type;
        return this.getBuilding?.(normalized)
            || BUILDING_DEFS.find((b) => b.type === normalized)
            || null;
    }

    _activeVisitIntent() {
        const intent = this.getIntentForAgent?.(this.agent?.id);
        return intent?.building ? intent : null;
    }

    _releaseVisitReservation() {
        if (!this._lastReservationId && !this.agent?.id) return;
        this.releaseVisitReservation?.(this.agent?.id, this._lastReservationId);
        this._lastReservationId = null;
        this._lastReservationRenewedAt = 0;
    }

    _renewVisitReservation() {
        if (!this._lastReservationId || !this.agent?.id || !this.renewVisitReservation) return;
        const now = Date.now();
        if (now - this._lastReservationRenewedAt < 5000) return;
        if (this.renewVisitReservation(this.agent.id)) {
            this._lastReservationRenewedAt = now;
        }
    }

    _assignTarget(targetScreenX, targetScreenY, targetTileX, targetTileY) {
        this._targetReachable = true;
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
            this._targetReachable = false;
            this._releaseVisitReservation();
            this.waypoints = [];
            this.targetX = this.x;
            this.targetY = this.y;
            return;
        }
        this.waypoints = tilePath.map((t) => ({
            ...tileToWorld(t),
        }));
        const finalTile = tilePath[tilePath.length - 1];
        if (
            finalTile &&
            Math.abs(finalTile.tileX - Math.round(targetTileX)) <= 1 &&
            Math.abs(finalTile.tileY - Math.round(targetTileY)) <= 1 &&
            this._isScreenPointWalkable(targetScreenX, targetScreenY)
        ) {
            this.waypoints[this.waypoints.length - 1] = { x: targetScreenX, y: targetScreenY };
        }
        const head = this.waypoints[0];
        this.targetX = head.x;
        this.targetY = head.y;
    }

    _isScreenPointWalkable(x, y) {
        if (!this.pathfinder) return true;
        const tile = this._screenToTile(x, y);
        return this.pathfinder.isWalkable(Math.round(tile.tileX), Math.round(tile.tileY));
    }

    _screenToTile(x, y) {
        return worldToTile(x, y);
    }

    _snapToNearestWalkable(maxRadius = 8) {
        if (!this.pathfinder || typeof this.pathfinder.nearestWalkable !== 'function') return false;
        const tile = this._screenToTile(this.x, this.y);
        const tileX = Math.round(tile.tileX);
        const tileY = Math.round(tile.tileY);
        if (this.pathfinder.isWalkable(tileX, tileY)) return false;

        const nearest = this.pathfinder.nearestWalkable(tileX, tileY, maxRadius);
        if (!nearest) return false;

        const screen = tileToWorld(nearest);
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
            return this.agent.targetBuildingType || this.agent.lastKnownBuildingType || 'command';
        }
        if (this.agent.status === AgentStatus.WAITING) return this.agent.targetBuildingType || this.agent.lastKnownBuildingType || 'taskboard';
        if (this.agent.status === AgentStatus.IDLE) return this._ambientBuildingTypeForState();
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

    setArrivalState(state) {
        this._arrivalState = state === 'pending' ? 'pending' : 'visible';
        if (this._arrivalState === 'pending') {
            this._releaseVisitReservation();
            this.behavior.transition('departing', 'arrival-state');
            this.moving = false;
            this.waitTimer = 0;
            this.waypoints = [];
            this._lastPathTileKey = null;
        }
    }

    isArrivalPending() {
        return this._arrivalState === 'pending';
    }

    setTeamPlazaPreference(enabled) {
        this.teamPlazaPreference = !!enabled;
    }

    setTilePosition(tileX, tileY) {
        const screen = tileToWorld(tileX, tileY);
        this.x = screen.x;
        this.y = screen.y;
        this.targetX = screen.x;
        this.targetY = screen.y;
        this.moving = false;
        this.waitTimer = 0;
        this.waypoints = [];
        this._lastPathTileKey = null;
        this._resetWalkCycle();
    }

    walkToTile(tileX, tileY) {
        const screen = tileToWorld(tileX, tileY);
        this._releaseVisitReservation();
        this.chatPartner = null;
        this.chatting = false;
        this.chatBubbleAnim = 0;
        this.setArrivalState('visible');
        this._lastPathTileKey = null;
        this._assignTarget(screen.x, screen.y, tileX, tileY);
        this.moving = this._targetReachable;
        this.waitTimer = 0;
    }

    retargetVisit() {
        if (this.chatting || this.chatPartner || this.isArrivalPending()) return false;
        this._releaseVisitReservation();
        this._lastPathTileKey = null;
        this.waitTimer = 0;
        this._pickTarget();
        return true;
    }

    hasReachedTarget(tolerance = 6) {
        return Math.hypot(this.targetX - this.x, this.targetY - this.y) <= tolerance;
    }

    update(particleSystem, dt = 16) {
        if (this.isArrivalPending()) {
            this._advanceIdleAnimation(dt);
            return;
        }
        const frameScale = Math.max(0, Math.min(3, dt / 16));
        this.statusAnim += 0.05 * this.motionScale * frameScale;
        this.bumpFlash = Math.max(0, this.bumpFlash - 0.08 * frameScale);

        // Handle chatting state
        if (this.chatting) {
            this._faceChatPartner();
            this.chatBubbleAnim += 0.06 * frameScale;
            this._advanceIdleAnimation(dt);
            return; // Do not move while chatting
        }

        // Moving toward the chat partner; start chatting when close
        if (this.chatPartner) {
            const cpDx = this.chatPartner.x - this.x;
            const cpDy = this.chatPartner.y - this.y;
            this._faceChatPartner();
            const cpDist = Math.sqrt(cpDx * cpDx + cpDy * cpDy);
            if (cpDist < 35) {
                this.chatting = true;
                this.behavior.transition('chatting', 'chat');
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
                    this.chatPartner.behavior?.transition?.('chatting', 'chat');
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
            const activeIntent = this._activeVisitIntent();
            const curBuilding = activeIntent?.building || (this.agent.status === AgentStatus.IDLE
                ? this._lastBuildingType
                : this._targetBuildingTypeForState());
            const curIntentId = activeIntent?.id || null;
            if (curBuilding !== this._lastBuildingType || (curIntentId && curIntentId !== this._lastIntentId)) {
                this._lastBuildingType = curBuilding;
                this._pickTarget();
            }
        }

        if (this.waitTimer > 0) {
            if (!this.moving) this._snapToNearestWalkable();
            this._renewVisitReservation();
            this.waitTimer -= frameScale;
            if (this.waitTimer <= 0) {
                if (this.behavior.cooldownUntil > Date.now()) {
                    this.behavior.transition('cooldown', this.behavior.reason);
                    this.waitTimer = Math.max(10, Math.ceil((this.behavior.cooldownUntil - Date.now()) / 16));
                    this._advanceIdleAnimation(dt);
                    return;
                }
                this.behavior.finishVisit();
                this._pickTarget();
            }
            this._advanceIdleAnimation(dt);
            return;
        }

        if (!this.moving) {
            this._snapToNearestWalkable();
            this._advanceIdleAnimation(dt);
            this._renewVisitReservation();
            this._pickTarget();
            return;
        }

        this._renewVisitReservation();

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
            this.behavior.arrive({
                state: this._lastIntentId ? 'performing' : 'lingering',
                cooldownMs: this._lastIntentId ? 2000 : 0,
            });
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

    _faceChatPartner() {
        if (!this.chatPartner) return;
        const dir = dirFromVelocity(this.chatPartner.x - this.x, this.chatPartner.y - this.y);
        if (dir != null) this.direction = dir;
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
        this._releaseVisitReservation();
        this.behavior.transition('chat-approach', 'chat');
        this.chatPartner = partnerSprite;
        this.chatting = false;
        this.chatBubbleAnim = 0;
        this._pickTarget(); // start moving toward the partner
    }

    /** End chat */
    endChat() {
        this._releaseVisitReservation();
        this.chatPartner = null;
        this.chatting = false;
        this.chatBubbleAnim = 0;
        this.behavior.finishVisit();
        this.behavior.transition('cooldown', 'chat-ended');
        this._pickTarget(); // resume normal behavior
    }

    getBehaviorDebugSnapshot() {
        const tile = this._screenToTile(this.x, this.y);
        const behavior = this.behavior.snapshot();
        return {
            agentId: this.agent?.id || null,
            name: this.agent?.displayName || this.agent?.name || null,
            status: this.agent?.status || null,
            building: this._lastBuildingType,
            intentId: this._lastIntentId,
            reservationId: this._lastReservationId,
            behaviorState: behavior.state,
            behaviorReason: behavior.reason,
            recentBuildings: behavior.recentBuildings,
            behavior,
            targetTile: this._lastTargetTile ? { ...this._lastTargetTile } : null,
            tile,
            moving: this.moving,
            chatting: this.chatting,
            waypointCount: this.waypoints?.length || 0,
        };
    }

    draw(ctx, zoom = 1) {
        this._zoom = zoom;

        if (this.isArrivalPending()) return;
        if (!this.compositor) return;       // defensive: no compositor → render nothing

        const identity = getModelVisualIdentity(this.agent.model, this.agent.effort, this.agent.provider);
        const provider = this._providerKey();
        const variant = this._hashVariant();
        const spriteId = identity.spriteId || `agent.${provider}.base`;
        const paletteKey = identity.paletteKey || provider;
        const accessory = this._runtimeEffortAccessory(identity);
        const equipmentKey = this._runtimeCodexEquipment(identity) || '_';
        const cleanupKey = this._shouldScrubBakedCodexWeapon(identity)
            ? `clean:${String(identity.modelClass || 'codex').toLowerCase()}`
            : 'raw';
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
        this._drawEffortFloorRing(ctx, identity);

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
        this._drawCodexEquipment(ctx, identity, { dx, dy, bounds, cellSize, drawScale }, 'back');
        this._drawSpriteSilhouette(ctx, cell, dx, dy, drawScale);
        ctx.drawImage(
            this.spriteCanvas,
            cell.sx, cell.sy, cell.sw, cell.sh,
            dx, dy, cell.sw * drawScale, cell.sh * drawScale
        );
        this._drawCodexEquipment(ctx, identity, { dx, dy, bounds, cellSize, drawScale }, 'front');

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
        if (!baseCanvas || !this._shouldScrubBakedCodexWeapon(identity)) return baseCanvas;
        if (PROCESSED_SPRITE_CACHE.has(cacheKey)) return PROCESSED_SPRITE_CACHE.get(cacheKey);

        const canvas = document.createElement('canvas');
        canvas.width = baseCanvas.width;
        canvas.height = baseCanvas.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(baseCanvas, 0, 0);
        this._clearBakedCodexSidearmPixels(ctx, canvas.width, canvas.height, identity.modelClass);
        PROCESSED_SPRITE_CACHE.set(cacheKey, canvas);
        return canvas;
    }

    _shouldScrubBakedCodexWeapon(identity) {
        if (!identity) return false;
        if (identity.suppressBakedWeapon) return true;
        const modelClass = String(identity.modelClass || '').toLowerCase();
        return Object.prototype.hasOwnProperty.call(CODEX_EQUIPMENT_BY_CLASS, modelClass);
    }

    _clearBakedCodexSidearmPixels(ctx, width, height, modelClass = 'codex') {
        const cellSize = Math.round(width / DIRECTIONS.length) || 92;
        const rows = Math.floor(height / cellSize);
        if (!Number.isFinite(cellSize) || cellSize <= 0 || rows <= 0) return;

        const image = ctx.getImageData(0, 0, width, height);
        const data = image.data;
        const marks = new Uint8Array(width * height);
        const selectors = this._bakedWeaponSelectorsForClass(modelClass);
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < DIRECTIONS.length; col++) {
                const zones = this._bakedWeaponMaskZonesForClass(modelClass, DIRECTIONS[col], cellSize);
                for (const zone of zones) {
                    this._markBakedWeaponPixels(data, marks, width, col * cellSize, row * cellSize, zone, selectors);
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

    _bakedWeaponSelectorsForClass(modelClass) {
        const normalizedClass = this._normalizedBakedWeaponClass(modelClass);
        return {
            brightBlade: (r, g, b) => r > 168 && g > 168 && b > 152,
            cyanBlade: normalizedClass === 'spark'
                ? (r, g, b) => g > 180 && b > 150 && Math.abs(g - b) < 56 && r < 170
                : (r, g, b) => g > 150 && b > 150 && Math.abs(g - b) < 56 && r < 170,
            greyMetal: (r, g, b) => r > 78 && g > 78 && b > 78 && Math.max(r, g, b) - Math.min(r, g, b) < 42,
            goldHilt: normalizedClass === 'gpt54'
                ? (r, g, b) => r > 150 && g > 95 && g < 170 && b < 95
                : normalizedClass === 'spark'
                    ? (r, g, b) => r > 165 && g > 95 && g < 190 && b < 95
                    : (r, g, b) => r > 150 && g > 95 && g < 190 && b < 95,
        };
    }

    _bakedWeaponMaskZonesForClass(modelClass, directionKey, cellSize) {
        const z = (x1, y1, x2, y2) => ({
            x1: Math.round(x1 * cellSize),
            y1: Math.round(y1 * cellSize),
            x2: Math.round(x2 * cellSize),
            y2: Math.round(y2 * cellSize),
        });
        const zones = {
            s: [z(0.08, 0.46, 0.40, 0.98), z(0.62, 0.46, 0.92, 0.98)],
            se: [z(0.42, 0.43, 0.96, 0.96)],
            e: [z(0.46, 0.40, 0.98, 0.90)],
            ne: [z(0.46, 0.36, 0.98, 0.88)],
            n: [z(0.08, 0.46, 0.38, 0.96), z(0.62, 0.46, 0.92, 0.96)],
            nw: [z(0.02, 0.36, 0.54, 0.88)],
            w: [z(0.02, 0.40, 0.54, 0.90)],
            sw: [z(0.04, 0.43, 0.58, 0.96)],
        };
        const normalizedClass = this._normalizedBakedWeaponClass(modelClass);
        if (normalizedClass === 'spark') {
            return {
                ...zones,
                s: [z(0.09, 0.50, 0.34, 0.96), z(0.66, 0.50, 0.88, 0.96)],
                se: [z(0.48, 0.46, 0.94, 0.94)],
            }[directionKey] || [];
        }
        if (normalizedClass === 'gpt54') {
            return {
                ...zones,
                nw: [z(0.00, 0.35, 0.58, 0.90)],
                w: [z(0.00, 0.39, 0.58, 0.92)],
            }[directionKey] || [];
        }
        return zones[directionKey] || [];
    }

    _normalizedBakedWeaponClass(modelClass) {
        const normalizedClass = String(modelClass || '').toLowerCase();
        return normalizedClass === 'codex' ? 'gpt54' : normalizedClass;
    }

    _markBakedWeaponPixels(data, marks, width, originX, originY, zone, selectors) {
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
                if (
                    selectors.brightBlade(r, g, b) ||
                    selectors.cyanBlade(r, g, b) ||
                    selectors.greyMetal(r, g, b) ||
                    selectors.goldHilt(r, g, b)
                ) {
                    marks[y * width + x] = 1;
                }
            }
        }
    }

    _drawEffortFloorRing(ctx, identity) {
        const effortRingId = this._runtimeEffortFloorRing(identity);
        if (!effortRingId) return;
        const effortRing = this.assets?.get(effortRingId);
        if (!effortRing) {
            const effortTier = this._effortFloorRingTier(identity, effortRingId);
            if (effortTier) this._drawProceduralEffortFloorRing(ctx, effortTier);
            return;
        }
        const dims = this.assets.getDims(effortRingId);
        const [ax, ay] = this.assets.getAnchor(effortRingId);
        const pulse = 0.76 + 0.24 * Math.sin(this.statusAnim * 1.8);
        ctx.save();
        ctx.globalAlpha = pulse;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(
            effortRing,
            Math.round(this.x - ax),
            Math.round(this.y + 4 - ay),
            dims.w,
            dims.h
        );
        ctx.restore();
    }

    _effortFloorRingTier(identity, effortRingId) {
        const effortTier = String(identity?.effortTier || '').toLowerCase();
        if (EFFORT_FLOOR_RING_VISUALS[effortTier]) return effortTier;
        const id = String(effortRingId || '').toLowerCase();
        if (id.includes('effortlow')) return 'low';
        if (id.includes('effortmedium')) return 'medium';
        if (id.includes('efforthigh')) return 'high';
        return null;
    }

    _drawProceduralEffortFloorRing(ctx, effortTier) {
        const visual = EFFORT_FLOOR_RING_VISUALS[effortTier];
        if (!visual) return;
        const pulse = 0.72 + 0.28 * Math.sin(this.statusAnim * 1.8);
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.translate(Math.round(this.x), Math.round(this.y + 4));
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = pulse;
        ctx.fillStyle = visual.glow;
        ctx.beginPath();
        ctx.ellipse(0, 0, visual.rx + 3, visual.ry + 2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        for (let band = 0; band < visual.bands; band++) {
            const inset = band * 3;
            const yOffset = (band - (visual.bands - 1) / 2) * 1.5;
            ctx.globalAlpha = (0.52 + band * 0.11) * pulse;
            ctx.strokeStyle = band === visual.bands - 1 ? visual.highlight : visual.stroke;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.ellipse(0, yOffset, Math.max(8, visual.rx - inset), Math.max(3, visual.ry - band), 0, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.globalAlpha = 0.78 * pulse;
        ctx.fillStyle = visual.highlight;
        const ticks = effortTier === 'high'
            ? [[-14, -1], [0, -6], [14, -1], [-7, 4], [7, 4]]
            : effortTier === 'medium'
                ? [[-12, -1], [12, -1], [0, 5]]
                : [[0, -5], [0, 5]];
        for (const [x, y] of ticks) {
            ctx.fillRect(Math.round(x), Math.round(y), 2, 1);
        }
        ctx.restore();
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
            const isWorking = this.agent?.status === AgentStatus.WORKING;
            const isWaiting = this.agent?.status === AgentStatus.WAITING;
            const flash = this.bumpFlash ? this.bumpFlash * 0.26 : 0;
            ctx.globalAlpha = this.selected
                ? 0.95
                : isWorking
                    ? 0.30 + 0.22 * pulse + flash
                    : isWaiting
                        ? 0.30 + flash
                        : 0.18 + flash;
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

    _drawCodexEquipment(ctx, identity, frameGeometry, layer = 'front') {
        const equipment = this._normalizedCodexEquipment(this._runtimeCodexEquipment(identity));
        if (!equipment) return;

        const directionKey = DIRECTIONS[this.direction] || 's';
        const geometry = this._codexWeaponGeometry(frameGeometry, directionKey);
        const heavyGearBaked = identity?.codexHeavyGearBaked && this.assets?.has?.(identity.spriteId);
        const heavyArmor = !heavyGearBaked && (equipment === 'greatsword' || equipment === 'polearm');
        const warlord = equipment === 'polearm';
        const assetDef = CODEX_WEAPON_ASSETS[equipment] || null;
        const assetDrawsBehindBody = assetDef && this._assetWeaponBackLayer(assetDef, directionKey);

        if (layer === 'back') {
            if (heavyArmor) {
                this._drawGearAt(ctx, geometry.torso, geometry.drawScale, () => {
                    this._drawCodexCape(ctx, warlord, directionKey);
                });
            }

            if (assetDef && assetDrawsBehindBody) {
                this._drawCodexAssetEquipment(ctx, assetDef, geometry, directionKey, 'asset');
            } else if (equipment === 'engineerWrench' && this._weaponBackCarryDirection(directionKey)) {
                this._drawWeaponAt(ctx, geometry.backCarry, geometry.drawScale, () => this._drawCodexBackWrench(ctx));
            }
            return;
        }

        if (layer !== 'front') return;

        if (heavyArmor) {
            this._drawGearAt(ctx, geometry.torso, geometry.drawScale, () => this._drawCodexHeavyArmor(ctx, warlord, directionKey));
            this._drawGearAt(ctx, geometry.head, geometry.drawScale, () => this._drawCodexHeavyHelmet(ctx, warlord, directionKey));
        }

        if (assetDef) {
            if (!assetDrawsBehindBody) this._drawCodexAssetEquipment(ctx, assetDef, geometry, directionKey, 'asset');
            this._drawCodexAssetEquipment(ctx, assetDef, geometry, directionKey, 'hands');
            return;
        }

        if (equipment === 'multitool') {
            this._drawWeaponAt(ctx, geometry.rightHand, geometry.drawScale, () => {
                this._drawCodexMultitool(ctx);
                this._drawWeaponGripHand(ctx);
            });
        } else if (equipment === 'runeblade') {
            this._drawWeaponAt(ctx, geometry.rightHand, geometry.drawScale, () => {
                this._drawCodexRuneblade(ctx);
                this._drawWeaponGripHand(ctx);
            });
        } else if (equipment === 'swordShield') {
            this._drawWeaponAt(ctx, geometry.shield, geometry.drawScale, () => this._drawCodexShield(ctx, geometry.shieldSlim));
            this._drawWeaponAt(ctx, geometry.rightHand, geometry.drawScale, () => {
                this._drawCodexRuneblade(ctx);
                this._drawWeaponGripHand(ctx);
            });
        } else if (equipment === 'greatsword') {
            this._drawWeaponAt(ctx, geometry.twoHanded, geometry.drawScale, () => {
                this._drawCodexGreatsword(ctx);
                this._drawWeaponGripHands(ctx);
            });
        } else if (equipment === 'polearm') {
            this._drawWeaponAt(ctx, geometry.polearm, geometry.drawScale, () => {
                this._drawCodexPolearm(ctx);
                this._drawWeaponGripHands(ctx);
            });
        } else if (equipment === 'engineerWrench') {
            this._drawWeaponAt(ctx, geometry.shoulderRest, geometry.drawScale, () => {
                this._drawCodexShoulderWrench(ctx);
                this._drawWeaponGripHand(ctx);
            });
        }
    }

    _runtimeEffortAccessory(identity) {
        if (identity?.allowRuntimeEffortAccessory === false) return null;
        return identity?.effortAccessory ?? null;
    }

    _runtimeEffortFloorRing(identity) {
        if (identity?.allowRuntimeEffortFloorRing === false) return null;
        return identity?.effortFloorRing ?? null;
    }

    _runtimeCodexEquipment(identity) {
        if (identity?.allowRuntimeEffortWeapon === false) return null;
        const explicitEquipment = identity?.equipment ?? identity?.codexEquipment ?? null;
        if (explicitEquipment) return explicitEquipment;
        const modelClass = String(identity?.modelClass || '').toLowerCase();
        const classEquipment = CODEX_EQUIPMENT_BY_CLASS[modelClass];
        if (classEquipment) return classEquipment;
        return identity?.effortWeapon ?? null;
    }

    _normalizedCodexEquipment(equipment) {
        const normalized = String(equipment || '').trim();
        if (!normalized) return null;
        if (normalized === 'sword') return 'runeblade';
        if (normalized === 'wrench') return 'engineerWrench';
        if (normalized === 'warlord') return 'polearm';
        return normalized;
    }

    _drawCodexAssetEquipment(ctx, assetDef, geometry, directionKey, part = 'asset') {
        const poseName = this._weaponPoseName(assetDef, directionKey);
        const pose = geometry[poseName] || geometry.rightHand;
        if (!pose) return;

        if (part === 'asset') {
            this._drawWeaponAt(ctx, {
                ...pose,
                scale: (pose.scale || 1) * (assetDef.scale || 1),
            }, geometry.drawScale, () => this._drawCodexWeaponAssetImage(ctx, assetDef));
            return;
        }

        this._drawWeaponAt(ctx, pose, geometry.drawScale, () => {
            if (assetDef.hands === 'double') this._drawWeaponGripHands(ctx, assetDef.handSpacing || 11, assetDef.handVector);
            else this._drawWeaponGripHand(ctx);
        });
    }

    _drawCodexWeaponAssetImage(ctx, assetDef) {
        const img = this.assets?.has?.(assetDef.id) ? this.assets.get(assetDef.id) : null;
        if (img) {
            const dims = this.assets.getDims(assetDef.id) || { w: img.width, h: img.height };
            const [ax, ay] = this._codexWeaponAssetAnchor(assetDef);
            ctx.drawImage(img, Math.round(-ax), Math.round(-ay), dims.w, dims.h);
            return;
        }
        this._drawCodexWeaponFallback(ctx, assetDef.fallback);
    }

    _codexWeaponAssetAnchor(assetDef) {
        const entryAnchor = this.assets?.getEntry?.(assetDef.id)?.anchor;
        if (Array.isArray(entryAnchor) && entryAnchor.length >= 2) return entryAnchor;
        return assetDef.anchor || [0, 0];
    }

    _drawCodexWeaponFallback(ctx, fallback) {
        if (fallback === 'runeblade') this._drawCodexRuneblade(ctx);
        else if (fallback === 'greatsword') this._drawCodexGreatsword(ctx);
        else if (fallback === 'polearm') this._drawCodexPolearm(ctx);
        else if (fallback === 'wrench') this._drawCodexShoulderWrench(ctx);
    }

    _weaponPoseName(assetDef, directionKey) {
        if (assetDef.backPose && this._weaponBackCarryDirection(directionKey)) return assetDef.backPose;
        return assetDef.pose || 'rightHand';
    }

    _assetWeaponBackLayer(assetDef, directionKey) {
        if (assetDef.backLayer === 'always') return true;
        if (Array.isArray(assetDef.backLayerDirections)) return assetDef.backLayerDirections.includes(directionKey);
        if (assetDef.backPose) return this._weaponBackCarryDirection(directionKey);
        return directionKey === 'n' || directionKey === 'ne' || directionKey === 'nw';
    }

    _codexWeaponGeometry({ dx, dy, bounds, drawScale = 1 }, directionKey) {
        const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
        const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
        const centerX = dx + (bounds.minX + bounds.maxX) * drawScale / 2;
        const headY = dy + (bounds.minY + contentHeight * 0.19) * drawScale;
        const shoulderY = dy + (bounds.minY + contentHeight * 0.36) * drawScale;
        const torsoY = dy + (bounds.minY + contentHeight * 0.56) * drawScale;
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
        const twoHanded = {
            x: centerX + sideSign * bodyWidth * 0.13 * drawScale,
            y: torsoY + (handYOffset - 2) * drawScale,
            flipX: sideSign < 0,
            angle: this._greatswordLeanForDirection(directionKey),
            scale: 1.06,
        };
        const greatswordShoulder = {
            x: centerX + sideSign * bodyWidth * 0.24 * drawScale,
            y: shoulderY + 7 * drawScale,
            flipX: sideSign < 0,
            angle: this._greatswordLeanForDirection(directionKey),
            scale: 1.00,
        };
        const polearmUpright = {
            x: centerX + sideSign * bodyWidth * 0.40 * drawScale,
            y: torsoY + (handYOffset + 4) * drawScale,
            flipX: sideSign < 0,
            angle: this._polearmLeanForDirection(directionKey),
            scale: 1.00,
        };
        const shoulderRest = {
            x: centerX + sideSign * bodyWidth * 0.30 * drawScale,
            y: shoulderY,
            flipX: sideSign < 0,
            angle: this._wrenchShoulderLeanForDirection(directionKey),
            scale: 0.94,
        };
        const shieldYOffset = {
            s: -8, se: -10, e: -11, ne: -14,
            n: -14, nw: -14, w: -11, sw: -10,
        }[directionKey] ?? -8;
        const shieldOutset = (directionKey === 'e' || directionKey === 'w')
            ? 0.56
            : ['ne', 'nw', 'se', 'sw'].includes(directionKey)
                ? 0.58
                : 0.62;
        const shield = {
            x: centerX - sideSign * bodyWidth * shieldOutset * drawScale,
            y: torsoY + shieldYOffset * drawScale,
            flipX: sideSign < 0,
            angle: sideSign * (directionKey === 'e' || directionKey === 'w' ? -0.16 : -0.06),
            scale: directionKey === 'e' || directionKey === 'w' ? 0.80 : 0.88,
        };
        const backCarry = {
            x: centerX + sideSign * bodyWidth * 0.10 * drawScale,
            y: shoulderY + 3 * drawScale,
            flipX: sideSign < 0,
            angle: directionKey === 'n' ? -0.06 : 0.04,
            scale: 0.96,
        };
        const torso = {
            x: centerX,
            y: shoulderY + 2 * drawScale,
            flipX: false,
            angle: 0,
            scale: 1,
        };
        const head = {
            x: centerX,
            y: headY,
            flipX: false,
            angle: 0,
            scale: 1,
        };
        return {
            drawScale,
            head,
            torso,
            rightHand,
            twoHanded,
            polearm: polearmUpright,
            greatswordShoulder,
            polearmUpright,
            shoulderRest,
            shield,
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

    _drawGearAt(ctx, pose, drawScale, drawFn) {
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

    _wrenchShoulderLeanForDirection(directionKey) {
        if (directionKey === 'e' || directionKey === 'w') return -0.45;
        if (directionKey === 'se' || directionKey === 'sw') return -0.20;
        if (directionKey === 's') return -0.05;
        return -0.30;
    }

    _greatswordLeanForDirection(directionKey) {
        if (directionKey === 'e' || directionKey === 'w') return -0.50;
        if (directionKey === 'ne' || directionKey === 'nw') return -0.54;
        if (directionKey === 'n') return -0.55;
        if (directionKey === 'se' || directionKey === 'sw') return -0.48;
        return -0.46;
    }

    _polearmLeanForDirection(directionKey) {
        if (directionKey === 'ne' || directionKey === 'nw' || directionKey === 'n') return -0.58;
        if (directionKey === 'e' || directionKey === 'w') return -0.56;
        return -0.54;
    }

    _drawCodexMultitool(ctx) {
        this._drawWeaponStroke(ctx, '#0b2430', 5, [[-6, 5], [6, -3]]);
        this._drawWeaponStroke(ctx, '#7f8f9b', 3, [[-6, 5], [6, -3]]);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(3, -8, 9, 6);
        ctx.fillStyle = '#dce8ec';
        ctx.fillRect(5, -7, 5, 2);
        ctx.fillRect(9, -6, 3, 4);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(9, -4, 4, 2);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(-5, 3, 8, 5);
        ctx.fillStyle = '#b47a35';
        ctx.fillRect(-4, 4, 6, 3);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-1, 4, 2, 2);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(-3, 5, 1, 1);
    }

    _drawCodexRuneblade(ctx) {
        this._drawTaperedBlade(ctx, 0, -2, 10, -29, 4.0, 0.7);
        ctx.strokeStyle = '#7be3d7';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(2, -7);
        ctx.lineTo(8, -24);
        ctx.stroke();
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(4, -17, 2, 2);
        this._drawWeaponStroke(ctx, '#0b2430', 5, [[-8, 4], [8, 7]]);
        this._drawWeaponStroke(ctx, '#f8c45f', 3, [[-8, 4], [8, 7]]);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(-2, 5, 5, 11);
        ctx.fillStyle = '#b47a35';
        ctx.fillRect(-1, 6, 3, 9);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-4, 15, 8, 3);
    }

    _drawCodexGreatsword(ctx, ornate = false) {
        this._drawTaperedBlade(ctx, 0, 2, 14, ornate ? -54 : -48, ornate ? 6.6 : 5.7, 0.9);
        ctx.strokeStyle = ornate ? '#bff7ee' : '#7be3d7';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(2, -4);
        ctx.lineTo(12, ornate ? -43 : -38);
        ctx.stroke();
        if (ornate) {
            ctx.fillStyle = '#7be3d7';
            ctx.fillRect(7, -34, 3, 3);
            ctx.fillRect(10, -24, 2, 2);
        }
        this._drawWeaponStroke(ctx, '#0b2430', 6, [[-11, 7], [11, 10]]);
        this._drawWeaponStroke(ctx, '#f8c45f', 4, [[-11, 7], [11, 10]]);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(-3, 8, 7, 19);
        ctx.fillStyle = '#8a5a2a';
        ctx.fillRect(-2, 9, 5, 17);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-5, 25, 11, 4);
        if (ornate) {
            ctx.fillStyle = '#fff1b8';
            ctx.fillRect(-1, 11, 3, 12);
        }
    }

    _drawCodexPolearm(ctx) {
        this._drawWeaponStroke(ctx, '#071015', 5, [[-11, 23], [15, -38]]);
        this._drawWeaponStroke(ctx, '#2f2321', 3, [[-11, 23], [15, -38]]);
        this._drawWeaponStroke(ctx, '#d7a456', 1, [[-7, 15], [12, -31]]);
        ctx.fillStyle = '#071015';
        this._fillWeaponPolygon(ctx, [[9, -42], [23, -52], [17, -31], [10, -25], [13, -37]]);
        ctx.fillStyle = '#dce8ec';
        this._fillWeaponPolygon(ctx, [[12, -40], [21, -48], [16, -33], [12, -28], [14, -37]]);
        ctx.fillStyle = '#55c7f0';
        this._fillWeaponPolygon(ctx, [[13, -38], [18, -43], [15, -35], [13, -32]]);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(8, -31, 10, 4);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(10, -30, 3, 3);
        ctx.fillStyle = '#071015';
        this._fillWeaponPolygon(ctx, [[0, -36], [10, -47], [9, -34], [2, -29]]);
        ctx.fillStyle = '#a6b2b8';
        this._fillWeaponPolygon(ctx, [[2, -35], [8, -42], [8, -35], [3, -31]]);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-16, 24, 9, 4);
    }

    _drawCodexShield(ctx, slim = false, ornate = false) {
        const outline = slim
            ? [[-7, -15], [9, -11], [8, 8], [1, 18], [-7, 9]]
            : [[-13, -17], [12, -12], [10, 9], [0, 19], [-11, 9]];
        const face = slim
            ? [[-5, -13], [7, -9], [6, 7], [1, 15], [-5, 7]]
            : [[-10, -14], [9, -10], [8, 7], [0, 16], [-9, 7]];
        ctx.fillStyle = '#0b2430';
        this._fillWeaponPolygon(ctx, outline);
        ctx.fillStyle = ornate ? '#a6b2b8' : '#7f8f9b';
        this._fillWeaponPolygon(ctx, face);
        ctx.fillStyle = ornate ? '#2e5360' : '#214b5a';
        this._fillWeaponPolygon(ctx, face.map(([x, y]) => [x + (slim ? 1 : 2), y + 2]));
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(slim ? 0 : -1, -7, 3, 12);
        ctx.fillRect(slim ? -3 : -5, -2, slim ? 9 : 12, 3);
        if (ornate) {
            ctx.fillStyle = '#7be3d7';
            ctx.fillRect(slim ? 1 : 0, -11, 2, 4);
            ctx.fillRect(slim ? 1 : 0, 7, 2, 3);
            ctx.fillStyle = '#fff1b8';
            ctx.fillRect(slim ? -4 : -6, -1, slim ? 11 : 14, 1);
        }
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(slim ? 3 : 5, -5, slim ? 5 : 6, 9);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(slim ? 4 : 6, -4, slim ? 3 : 4, 7);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(slim ? 3 : 5, -1, slim ? 6 : 8, 2);
        ctx.fillStyle = 'rgba(223, 252, 255, 0.75)';
        ctx.fillRect(slim ? -3 : -7, -10, slim ? 3 : 4, 2);
    }

    _drawCodexCape(ctx, majestic = false, directionKey = 's') {
        const sideBias = ['e', 'ne', 'se'].includes(directionKey)
            ? -3
            : ['w', 'nw', 'sw'].includes(directionKey)
                ? 3
                : 0;
        const topHalf = majestic ? 22 : 17;
        const bottomHalf = majestic ? 25 : 19;
        const length = majestic ? 56 : 46;
        const lift = directionKey === 'n' ? -4 : 0;
        const cape = [
            [-topHalf + sideBias, -3 + lift],
            [topHalf + sideBias, -3 + lift],
            [bottomHalf + sideBias + 5, length],
            [0 + sideBias, length + (majestic ? 8 : 4)],
            [-bottomHalf + sideBias - 5, length],
        ];
        ctx.fillStyle = '#0b1118';
        this._fillWeaponPolygon(ctx, cape.map(([x, y]) => [x, y + 2]));
        ctx.fillStyle = majestic ? '#3e183f' : '#26364c';
        this._fillWeaponPolygon(ctx, cape);
        ctx.fillStyle = majestic ? '#64305f' : '#38536b';
        this._fillWeaponPolygon(ctx, [
            [-7 + sideBias, 0 + lift],
            [topHalf - 2 + sideBias, 0 + lift],
            [bottomHalf - 5 + sideBias, length - 2],
            [1 + sideBias, length + (majestic ? 5 : 2)],
        ]);
        ctx.strokeStyle = majestic ? '#f8c45f' : '#7be3d7';
        ctx.lineWidth = majestic ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(-topHalf + sideBias, -1 + lift);
        ctx.lineTo(-bottomHalf + sideBias - 3, length - 1);
        ctx.moveTo(topHalf + sideBias, -1 + lift);
        ctx.lineTo(bottomHalf + sideBias + 3, length - 1);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 241, 184, 0.62)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sideBias, 4 + lift);
        ctx.lineTo(sideBias - 4, length - 6);
        ctx.moveTo(sideBias + 10, 7 + lift);
        ctx.lineTo(sideBias + 7, length - 13);
        ctx.stroke();
    }

    _drawCodexHeavyArmor(ctx, warlord = false, directionKey = 's') {
        const sideView = directionKey === 'e' || directionKey === 'w';
        const torsoW = sideView ? 14 : (warlord ? 22 : 18);
        const armorTop = -4;
        ctx.fillStyle = '#081218';
        ctx.fillRect(-torsoW / 2 - 3, armorTop - 1, torsoW + 6, 32);
        ctx.fillStyle = warlord ? '#233340' : '#263a43';
        this._fillWeaponPolygon(ctx, [
            [-torsoW / 2, armorTop],
            [torsoW / 2, armorTop],
            [torsoW / 2 - 3, 26],
            [0, 32],
            [-torsoW / 2 + 3, 26],
        ]);
        ctx.fillStyle = warlord ? '#526878' : '#415862';
        this._fillWeaponPolygon(ctx, [
            [-torsoW / 2 + 3, 1],
            [torsoW / 2 - 2, 0],
            [torsoW / 2 - 5, 13],
            [0, 18],
            [-torsoW / 2 + 4, 13],
        ]);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(-torsoW / 2 - 2, 15, torsoW + 4, 3);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-torsoW / 2 + 1, 16, torsoW - 2, 1);
        ctx.fillRect(-2, 1, 4, 16);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(-2, 7, 4, 4);

        const pauldronY = warlord ? -3 : 0;
        const shoulderReach = warlord ? 7 : 5;
        const shoulderDrop = warlord ? 6 : 5;
        const leftPauldron = [
            [-torsoW / 2, pauldronY],
            [-torsoW / 2 - shoulderReach, pauldronY + 2],
            [-torsoW / 2 - shoulderReach + 2, pauldronY + shoulderDrop],
            [-torsoW / 2 - 1, pauldronY + shoulderDrop + 1],
        ];
        const rightPauldron = leftPauldron.map(([x, y]) => [-x, y]);
        ctx.fillStyle = '#071015';
        this._fillWeaponPolygon(ctx, leftPauldron);
        this._fillWeaponPolygon(ctx, rightPauldron);
        ctx.fillStyle = warlord ? '#657682' : '#4d626b';
        this._fillWeaponPolygon(ctx, leftPauldron.map(([x, y], index) => [
            x + 1,
            y + (index === 0 ? 1 : 0),
        ]));
        this._fillWeaponPolygon(ctx, rightPauldron.map(([x, y], index) => [
            x - 1,
            y + (index === 0 ? 1 : 0),
        ]));
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(Math.round(-torsoW / 2 - shoulderReach + 3), pauldronY + 2, shoulderReach - 2, 1);
        ctx.fillRect(Math.round(torsoW / 2 + 1), pauldronY + 2, shoulderReach - 2, 1);
        if (warlord) {
            ctx.fillStyle = '#fff1b8';
            ctx.fillRect(-torsoW / 2 - 5, pauldronY + 1, 3, 1);
            ctx.fillRect(torsoW / 2 + 2, pauldronY + 1, 3, 1);
            ctx.fillStyle = '#7be3d7';
            ctx.fillRect(-torsoW / 2 - 3, 7, 1, 2);
            ctx.fillRect(torsoW / 2 + 2, 7, 1, 2);
        }
    }

    _drawCodexHeavyHelmet(ctx, warlord = false, directionKey = 's') {
        const visorHidden = directionKey === 'n' || directionKey === 'nw' || directionKey === 'ne';
        ctx.fillStyle = '#071015';
        this._fillWeaponPolygon(ctx, [
            [-12, -7],
            [-9, -14],
            [0, -18],
            [9, -14],
            [12, -7],
            [9, 7],
            [-9, 7],
        ]);
        ctx.fillStyle = warlord ? '#61717b' : '#4b6068';
        this._fillWeaponPolygon(ctx, [
            [-9, -7],
            [-7, -12],
            [0, -15],
            [7, -12],
            [9, -7],
            [7, 5],
            [-7, 5],
        ]);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-8, -7, 16, 2);
        ctx.fillRect(-1, -14, 3, 20);
        if (!visorHidden) {
            ctx.fillStyle = '#091015';
            ctx.fillRect(-6, -4, 12, 4);
            ctx.fillStyle = '#7be3d7';
            ctx.fillRect(-5, -3, 10, 1);
        }
        ctx.fillStyle = '#26343c';
        ctx.fillRect(-10, -2, 3, 10);
        ctx.fillRect(7, -2, 3, 10);
        if (warlord) {
            ctx.fillStyle = '#0b1118';
            this._fillWeaponPolygon(ctx, [[-5, -15], [0, -26], [5, -15]]);
            ctx.fillStyle = '#f8c45f';
            this._fillWeaponPolygon(ctx, [[-3, -14], [0, -22], [3, -14]]);
            ctx.fillStyle = '#7be3d7';
            ctx.fillRect(-1, -19, 3, 4);
            ctx.fillStyle = '#fff1b8';
            ctx.fillRect(-12, -10, 4, 2);
            ctx.fillRect(8, -10, 4, 2);
        }
    }

    _drawCodexBackArsenal(ctx, directionKey = 's') {
        const lean = directionKey === 'e' || directionKey === 'ne' || directionKey === 'se' ? 2
            : directionKey === 'w' || directionKey === 'nw' || directionKey === 'sw' ? -2
                : 0;
        this._drawWeaponStroke(ctx, '#081015', 5, [[-22 + lean, 36], [-5 + lean, -18]]);
        this._drawWeaponStroke(ctx, '#7f8f9b', 2, [[-22 + lean, 36], [-5 + lean, -18]]);
        this._drawTaperedBlade(ctx, -5 + lean, -16, -2 + lean, -33, 3.2, 0.6);
        this._drawWeaponStroke(ctx, '#081015', 5, [[23 + lean, 37], [6 + lean, -15]]);
        this._drawWeaponStroke(ctx, '#8a5a2a', 2, [[23 + lean, 37], [6 + lean, -15]]);
        ctx.fillStyle = '#081015';
        ctx.fillRect(2 + lean, -24, 12, 8);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(4 + lean, -22, 8, 4);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(7 + lean, -21, 2, 2);
    }

    _drawCodexShoulderWrench(ctx) {
        this._drawWeaponStroke(ctx, '#0b2430', 6, [[-5, 16], [9, -13]]);
        this._drawWeaponStroke(ctx, '#8a5a2a', 3, [[-5, 16], [9, -13]]);
        this._drawWeaponStroke(ctx, '#d7a456', 1, [[-3, 10], [8, -11]]);
        this._drawCodexWrenchHead(ctx, 9, -17);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(3, -2, 2, 2);
    }

    _drawCodexBackWrench(ctx) {
        this._drawWeaponStroke(ctx, '#0b2430', 6, [[-10, 23], [13, -20]]);
        this._drawWeaponStroke(ctx, '#8a5a2a', 3, [[-10, 23], [13, -20]]);
        this._drawWeaponStroke(ctx, '#d7a456', 1, [[-7, 16], [12, -18]]);
        this._drawCodexWrenchHead(ctx, 13, -24);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(2, 0, 2, 2);
    }

    _drawCodexWrenchHead(ctx, x, y) {
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(x - 8, y - 4, 17, 10);
        ctx.fillStyle = '#7f8f9b';
        ctx.fillRect(x - 6, y - 2, 13, 6);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(x - 5, y - 1, 9, 3);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(x + 3, y - 5, 7, 4);
        ctx.fillRect(x + 4, y + 4, 6, 4);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(x - 2, y, 2, 2);
    }

    _drawWeaponGripHand(ctx) {
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(-4, -2, 8, 7);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(-3, -1, 6, 5);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-1, 0, 3, 3);
    }

    _drawWeaponGripHands(ctx, spacing = 11, vector = null) {
        const secondX = Array.isArray(vector) ? vector[0] : 0;
        const secondY = Array.isArray(vector) ? vector[1] : spacing;
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(-5, -2, 10, 6);
        ctx.fillRect(secondX - 5, secondY - 2, 10, 6);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(-4, -1, 8, 4);
        ctx.fillRect(secondX - 4, secondY - 1, 8, 4);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-1, 0, 3, 3);
        ctx.fillRect(secondX - 1, secondY, 3, 3);
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
        const layout = this._bubbleLayout(ctx, text, maxWidth, anchored);
        const displayText = layout.displayText;
        const textWidth = layout.textWidth;
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
        ctx.globalAlpha *= this.selected ? 1 : (this.labelAlpha ?? 1);
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
        const repo = this._repoNameTagProfile();
        ctx.fillStyle = repo.panel;
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
        ctx.strokeStyle = repo.panelBorder || repo.accent;
        ctx.lineWidth = this.selected ? 2 : 1.25;
        ctx.stroke();
        if (this.selected) {
            ctx.strokeStyle = repo.panelBorder || repo.accent;
            ctx.lineWidth = 1;
            ctx.strokeRect(Math.round(-w / 2 + 3) + 0.5, Math.round(-h / 2 + 3) + 0.5, Math.max(1, Math.round(w - 6)), Math.max(1, Math.round(h - 6)));
        }
        ctx.fillStyle = repo.labelText || repo.accent;
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
        ctx.globalAlpha *= this.selected ? 1 : (this.labelAlpha ?? 1);
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
        const repo = this._repoNameTagProfile();
        const rawName = String(this.agent?.name || this.agent?.displayName || '').trim() || 'Agent';
        const s = 1 / (this._zoom || 1);
        const slot = this.overlaySlot ?? this.nameTagSlot ?? 0;

        ctx.save();
        ctx.globalAlpha *= this.selected ? 1 : (this.labelAlpha ?? 1);
        ctx.translate(this.x, this.y);
        ctx.scale(s, s);
        ctx.translate(0, 20 + slot * 11);
        ctx.font = 'bold 6px "Press Start 2P", monospace';
        const layout = this._compactNameStatusLayout(ctx, rawName);
        const text = layout.text;
        const w = layout.width;
        const h = 13;

        ctx.fillStyle = repo.panel;
        ctx.strokeStyle = repo.panelBorder || repo.accent;
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(-w / 2, -h / 2, w, h, 3);
        } else {
            ctx.rect(-w / 2, -h / 2, w, h);
        }
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = repo.labelText || repo.accent;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 0, 0.5);
        ctx.restore();
    }

    _repoNameTagProfile() {
        const project = this.agent?.projectPath || this.agent?.project || this.agent?.teamName || this.agent?.provider || 'unknown';
        return repoProfile(project);
    }

    _activityLabel() {
        const visual = this._statusVisual();
        const bubbleText = String(this.agent?.bubbleText || '').trim();
        return bubbleText || visual?.label || 'IDLE';
    }

    _nameTagLayout(ctx, rawName) {
        const fontStatus = typeof document !== 'undefined' ? document.fonts?.status || 'unknown' : 'unknown';
        const key = `${rawName}|${ctx.font}|${fontStatus}`;
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

    _bubbleLayout(ctx, text, maxWidth, anchored) {
        const source = String(text || '');
        const fontStatus = typeof document !== 'undefined' ? document.fonts?.status || 'unknown' : 'unknown';
        const key = `${source}|${maxWidth}|${ctx.font}|${anchored ? 1 : 0}|${fontStatus}`;
        if (this._bubbleLayoutCacheKey === key && this._bubbleLayoutCache) return this._bubbleLayoutCache;
        let displayText = source;
        while (displayText.length > 0 && ctx.measureText(displayText).width > maxWidth) {
            displayText = displayText.substring(0, displayText.length - 1);
        }
        if (displayText.length < source.length) {
            displayText = displayText.substring(0, displayText.length - 1) + '…';
        }
        const layout = {
            displayText,
            textWidth: ctx.measureText(displayText).width,
        };
        this._bubbleLayoutCacheKey = key;
        this._bubbleLayoutCache = layout;
        return layout;
    }

    _compactNameStatusLayout(ctx, rawName) {
        const fontStatus = typeof document !== 'undefined' ? document.fonts?.status || 'unknown' : 'unknown';
        const key = `${rawName}|${ctx.font}|144|${fontStatus}`;
        if (this._compactNameStatusCacheKey === key && this._compactNameStatusCache) {
            return this._compactNameStatusCache;
        }
        const text = this._fitText(ctx, rawName, 144);
        const width = Math.min(184, Math.max(34, ctx.measureText(text).width + 14));
        const layout = { text, width };
        this._compactNameStatusCacheKey = key;
        this._compactNameStatusCache = layout;
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
        if (this.isArrivalPending()) return false;
        const dx = screenX - this.x;
        const dy = screenY - this.y;
        return Math.abs(dx) < SPRITE_HIT_HALF_WIDTH && dy > SPRITE_HIT_TOP && dy < SPRITE_HIT_BOTTOM;
    }
}

function providerMoteColor(agent) {
    const provider = String(agent?.provider || '').toLowerCase();
    return PROVIDER_TRIM[provider] || PROVIDER_TRIM.default;
}

function hashPhase(value) {
    const text = String(value || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    }
    return (hash >>> 0) / 4294967295;
}

function familiarMoteEntries({
    parentSprite,
    childSprites = [],
    childAgents = [],
    now = performance.now(),
    motionScale = 1,
    maxVisible = MAX_VISIBLE_FAMILIAR_MOTES,
} = {}) {
    if (!parentSprite) return { entries: [], hiddenCount: 0 };
    const children = [...childSprites, ...childAgents]
        .filter(Boolean)
        .slice(0, Math.max(0, maxVisible));
    const hiddenCount = Math.max(0, childSprites.length + childAgents.length - children.length);
    const motion = motionScale === 0 ? 0 : 1;
    const entries = children.map((child, i) => {
        const agent = child.agent || child;
        const base = hashPhase(agent?.id || i);
        const staticAngle = (Math.PI * 2 * i) / Math.max(1, children.length);
        const angle = motion
            ? staticAngle + base * Math.PI * 2 + (now / 900) * (i % 2 ? -1 : 1)
            : staticAngle;
        const orbitX = Math.cos(angle) * 18;
        const orbitY = -50 + Math.sin(angle) * 7;
        return {
            agent,
            index: i,
            x: parentSprite.x + orbitX,
            y: parentSprite.y + orbitY,
            orbitX,
            orbitY,
            radius: 4 + i * 0.6,
            color: providerMoteColor(agent),
        };
    });
    return { entries, hiddenCount };
}

export function familiarMoteLightSources({
    parentSprite,
    childSprites = [],
    childAgents = [],
    now = performance.now(),
    motionScale = 1,
    lighting = null,
    maxVisible = MAX_VISIBLE_FAMILIAR_MOTES,
} = {}) {
    const { entries } = familiarMoteEntries({
        parentSprite,
        childSprites,
        childAgents,
        now,
        motionScale,
        maxVisible,
    });
    const boost = lighting?.lightBoost ?? 1;
    return entries.map(entry => ({
        id: `familiar:${parentSprite?.agent?.id || 'parent'}:${entry.agent?.id || entry.index}`,
        kind: 'spark',
        x: entry.x,
        y: entry.y,
        color: entry.color,
        radius: 24,
        alpha: 0.18,
        intensity: 0.18 * boost,
    }));
}

export function drawFamiliarMotes(ctx, {
    parentSprite,
    childSprites = [],
    childAgents = [],
    zoom = 1,
    now = performance.now(),
    motionScale = 1,
    lighting = null,
    maxVisible = MAX_VISIBLE_FAMILIAR_MOTES,
} = {}) {
    if (!ctx || !parentSprite) return;
    const { entries, hiddenCount } = familiarMoteEntries({
        parentSprite,
        childSprites,
        childAgents,
        now,
        motionScale,
        maxVisible,
    });
    if (!entries.length && hiddenCount <= 0) return;

    const lightBoost = lighting?.lightBoost ?? 1;
    const selectedBoost = parentSprite.selected ? 1.4 : 1;
    const scale = 1 / (zoom || 1);

    ctx.save();
    ctx.translate(parentSprite.x, parentSprite.y);
    ctx.scale(scale, scale);

    for (const entry of entries) {
        const { orbitX, orbitY, radius, color } = entry;
        const alpha = Math.min(1, 0.58 * lightBoost * selectedBoost);

        ctx.globalAlpha = alpha;
        ctx.fillStyle = parentSprite._rgba?.(color, 0.30) || color;
        ctx.beginPath();
        ctx.arc(orbitX, orbitY, radius + 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = Math.min(1, alpha + 0.18);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(orbitX, orbitY, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = Math.min(1, alpha + 0.30);
        ctx.fillStyle = '#fff3bf';
        ctx.fillRect(Math.round(orbitX - 1), Math.round(orbitY - radius + 1), 2, 2);
    }

    if (hiddenCount > 0) {
        ctx.globalAlpha = parentSprite.selected ? 0.98 : 0.82;
        ctx.fillStyle = 'rgba(20, 14, 10, 0.88)';
        ctx.strokeStyle = '#f6cf60';
        ctx.lineWidth = 1;
        const x = 18;
        const y = -38;
        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(x - 9, y - 7, 18, 12, 3);
            ctx.fill();
            ctx.stroke();
        } else {
            ctx.fillRect(x - 9, y - 7, 18, 12);
            ctx.strokeRect(x - 9, y - 7, 18, 12);
        }
        ctx.fillStyle = '#f8ead1';
        ctx.font = 'bold 6px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`+${hiddenCount}`, x, y);
    }

    ctx.restore();
}
