import { Position } from '../../domain/value-objects/Position.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { BUILDING_DEFS } from '../../config/buildings.js';
import { THEME } from '../../config/theme.js';
import { SpriteSheet, dirFromVelocity } from './SpriteSheet.js';
import { Compositor } from './Compositor.js';

// Hit-test geometry (unchanged from vector version).
const SPRITE_HIT_HALF_WIDTH = 24;
const SPRITE_HIT_TOP = -44;
const SPRITE_HIT_BOTTOM = 34;

// Accessory id lists per provider — used by _chooseAccessory().
const PROVIDER_ACCESSORIES = {
    claude: ['mageHood', 'scholarCap', 'goldCirclet'],
    codex:  ['goggles', 'toolBand', 'rogueMask'],
    gemini: ['starCrown', 'oracleVeil', 'moonBand'],
};

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

        // Sprite rendering fields
        this.assets = assets;
        this.compositor = compositor;
        this.direction = 0;          // 0..7 index into DIRECTIONS
        this.animState = 'idle';
        this.frame = 0;
        this.frameTimer = 0;
        this.spriteCanvas = null;
        this.spriteSheet = null;     // cached SpriteSheet wrapper, set on first draw

        this._pickTarget();
    }

    _pickTarget() {
        // Move to the partner position when there is a chat partner
        if (this.chatPartner) {
            this.targetX = this.chatPartner.x + (this.x < this.chatPartner.x ? -25 : 25);
            this.targetY = this.chatPartner.y;
            this.waypoints = [];
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
                const tx = 10 + this._noise(seed, 3) * 20;
                const ty = 10 + this._noise(seed, 7) * 20;
                const target = new Position(tx, ty);
                const screen = target.toScreen(TILE_WIDTH, TILE_HEIGHT);
                this._assignTarget(screen.x, screen.y, target.tileX, target.tileY);
                this.moving = true;
                this.waitTimer = 0;
                return;
            }
        }

        // Move inside the building (near the building center)
        const seed = Math.abs(this._hash(`${this.agent.id}:${building.type}:${this._targetCycle++}`));
        const tx = building.x + 0.3 * building.width + this._noise(seed, 11) * 0.4 * building.width;
        const ty = building.y + 0.3 * building.height + this._noise(seed, 17) * 0.4 * building.height;
        const target = new Position(tx, ty);
        const screen = target.toScreen(TILE_WIDTH, TILE_HEIGHT);
        this._assignTarget(screen.x, screen.y, target.tileX, target.tileY);
        this.moving = true;
        this.waitTimer = 0;
    }

    _assignTarget(targetScreenX, targetScreenY, targetTileX, targetTileY) {
        if (!this.pathfinder) {
            this.targetX = targetScreenX;
            this.targetY = targetScreenY;
            this.waypoints = [];
            return;
        }
        const fromTile = this._screenToTile(this.x, this.y);
        const tileKey = `${Math.round(targetTileX)},${Math.round(targetTileY)}`;
        if (tileKey === this._lastPathTileKey && this.waypoints.length > 0) {
            return;
        }
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

    _targetBuildingTypeForState() {
        if (this.agent.status === AgentStatus.WORKING) {
            return this.agent.targetBuildingType || (this.agent.isSubagent ? 'command' : 'watchtower');
        }
        if (this.agent.status === AgentStatus.WAITING) return 'watchtower';
        if (this.agent.status === AgentStatus.IDLE) return 'sanctuary';
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

    update(particleSystem) {
        this.statusAnim += 0.05 * this.motionScale;

        // Handle chatting state
        if (this.chatting) {
            this.chatBubbleAnim += 0.06;
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
                this.walkFrame = 0;
                // Derive facing direction toward chat partner.
                const dir = dirFromVelocity(cpDx, cpDy);
                if (dir != null) this.direction = dir;
                // Put the partner in chat state too
                if (!this.chatPartner.chatting) {
                    this.chatPartner.chatPartner = this;
                    this.chatPartner.chatting = true;
                    this.chatPartner.chatBubbleAnim = 0;
                    this.chatPartner.moving = false;
                    this.chatPartner.walkFrame = 0;
                    // Partner faces back.
                    const partnerDir = dirFromVelocity(-cpDx, -cpDy);
                    if (partnerDir != null) this.chatPartner.direction = partnerDir;
                }
                return;
            }
            // Refresh target when the partner position changes
            this.targetX = this.chatPartner.x + (this.x < this.chatPartner.x ? -25 : 25);
            this.targetY = this.chatPartner.y;
            this.waypoints = [];
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
            this.waitTimer--;
            if (this.waitTimer <= 0) {
                this._pickTarget();
            }
            return;
        }

        if (!this.moving) {
            this._pickTarget();
            return;
        }

        const dx = this.targetX - this.x;
        const dy = this.targetY - this.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const speed = this._speedForState();

        if (dist < speed) {
            this.x = this.targetX;
            this.y = this.targetY;
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
            this.walkFrame = 0;
            return;
        }

        this.x += (dx / dist) * speed;
        this.y += (dy / dist) * speed;
        this.walkFrame += 0.15;

        if (this.motionScale > 0 && particleSystem && this.agent.status === AgentStatus.WORKING && Math.random() < 0.3) {
            particleSystem.spawn('footstep', this.x, this.y + 16, 1);
        }

        // Derive direction from velocity; hold last direction when stationary.
        const dir = dirFromVelocity(dx, dy);
        if (dir != null) this.direction = dir;

        // Animation state and frame tick.
        this.animState = this.moving ? 'walk' : 'idle';
        // dt approximation: legacy code was frame-driven with no real dt parameter,
        // so 16ms per frame (≈60fps) is a reasonable constant.
        const dt = 16;
        this.frameTimer += dt;
        const fps = this.animState === 'walk' ? 8 : 2;
        const tick = 1000 / fps;
        while (this.frameTimer > tick) {
            this.frame++;
            this.frameTimer -= tick;
        }
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

        if (!this.spriteCanvas) {
            const provider = this._providerKey();
            const variant = this._hashVariant();
            const accessory = this._chooseAccessory();
            this.spriteCanvas = this.compositor.spriteFor(provider, variant, accessory);
            if (this.spriteCanvas) {
                this.spriteSheet = new SpriteSheet(this.spriteCanvas, 64);
            }
        }

        if (!this.spriteCanvas || !this.spriteSheet) return;

        // Ensure animState reflects current movement (idle when not moving).
        this.animState = this.moving ? 'walk' : 'idle';

        const cell = this.spriteSheet.cell(this.animState, this.direction, this.frame);
        const cellSize = this.spriteSheet?.cellSize || 92;
        const dx = Math.round(this.x - cellSize / 2);
        const dy = Math.round(this.y - (cellSize - 12));   // 12px head clearance, anchor at leg-bottom
        ctx.drawImage(
            this.spriteCanvas,
            cell.sx, cell.sy, cell.sw, cell.sh,
            dx, dy, cell.sw, cell.sh
        );

        // Selection ring (if selected) — drawn at feet level.
        if (this.selected) this._drawSelectionRing(ctx);

        // Chat bubble overlay (if chatting).
        // Per-agent floating text bubbles are deferred to Phase 4; the chat
        // ellipsis animation already handled by _drawChatEffect below.
        if (this.chatting) {
            this._drawChatEffect(ctx);
        }

        // Status indicators (drawn without flip, zoom-independent).
        if (!this.chatting) {
            this._drawStatus(ctx);
        }
        this._drawNameTag(ctx);
    }

    _drawSelectionRing(ctx) {
        if (!this.assets) return;
        const ring = this.assets.get('overlay.status.selected');
        if (ring) {
            const dx = Math.round(this.x - ring.width / 2);
            const dy = Math.round(this.y - 6);     // just under feet
            ctx.drawImage(ring, dx, dy);
            return;
        }
        // Fallback: draw a simple ellipse when the overlay asset is not loaded.
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(this.x, this.y + 21, 28, 10, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(242, 211, 107, 0.24)';
        ctx.fill();
        ctx.strokeStyle = '#f2d36b';
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.restore();
    }

    // --- Variant and accessory helpers (used by draw to select sprite) ---

    /** Returns a palette variant index (0..3) stable for this agent. */
    _hashVariant() {
        const hash = Math.abs(this._hash(`${this.agent.id}:${this.agent.model || ''}:${this._providerKey()}`));
        return hash % 4;
    }

    /** Returns the accessory id string for this agent, or null. */
    _chooseAccessory() {
        const provider = this._providerKey();
        const accessories = PROVIDER_ACCESSORIES[provider];
        if (!accessories) return null;
        const hash = Math.abs(this._hash(`${this.agent.id}:${this.agent.model || ''}:${provider}`));
        return accessories[(hash >> 10) % accessories.length];
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

    _drawStatus(ctx) {
        const agent = this.agent;
        const t = this.statusAnim;
        const bubble = agent.bubbleText;
        const s = 1 / (this._zoom || 1); // inverse zoom correction

        if (agent.status === AgentStatus.WORKING || (agent.status === AgentStatus.WAITING && bubble)) {
            this._drawBubble(ctx, bubble || '...', agent.status === AgentStatus.WORKING ? THEME.working : '#f97316');
        } else if (agent.status === AgentStatus.IDLE) {
            ctx.save();
            ctx.translate(this.x, this.y);
            ctx.scale(s, s); // inverse zoom correction
            ctx.fillStyle = THEME.idle;
            ctx.textAlign = 'center';
            const offsetY = Math.sin(t * 1.5) * 4;
            ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 2);
            ctx.font = 'bold 9px sans-serif';
            ctx.fillText('z', 10, -22 + offsetY);
            ctx.font = 'bold 12px sans-serif';
            ctx.fillText('z', 16, -32 + offsetY);
            ctx.font = 'bold 16px sans-serif';
            ctx.fillText('Z', 22, -44 + offsetY);
            ctx.globalAlpha = 1;
            ctx.restore();
        } else if (agent.status === AgentStatus.WAITING) {
            ctx.save();
            ctx.translate(this.x, this.y);
            ctx.scale(s, s); // inverse zoom correction
            ctx.translate(0, -48);
            ctx.fillStyle = 'rgba(34, 24, 19, 0.92)';
            ctx.strokeStyle = '#d8843a';
            ctx.lineWidth = 1.5;
            this._bubblePath(ctx, 36);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#f3e2bd';
            ctx.font = 'bold 12px "Press Start 2P", monospace';
            ctx.textAlign = 'center';
            const dots = '.'.repeat(1 + Math.floor(t * 2) % 3);
            ctx.fillText(dots, 0, 3);
            ctx.restore();
        }
    }

    _drawBubble(ctx, text, accentColor) {
        ctx.save();
        const s = 1 / (this._zoom || 1); // inverse zoom correction

        ctx.translate(this.x, this.y);
        ctx.scale(s, s); // fixed size in screen space

        // Measure text size and auto-truncate
        ctx.font = 'bold 10px "Press Start 2P", monospace';
        const maxWidth = 180;
        let displayText = text;
        // Truncate by actual pixel width instead of character count
        while (displayText.length > 0 && ctx.measureText(displayText).width > maxWidth) {
            displayText = displayText.substring(0, displayText.length - 1);
        }
        if (displayText.length < text.length) {
            displayText = displayText.substring(0, displayText.length - 1) + '…';
        }
        const textWidth = ctx.measureText(displayText).width;
        const bubbleW = textWidth + 20;
        const bubbleH = 24;
        const radius = 6;

        ctx.translate(0, -50);

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
        ctx.lineTo(0, bubbleH / 2 + 7);
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

        // floating emoji particles above
        const floatY = -56 + Math.sin(t * 2) * 4;
        ctx.globalAlpha = 0.5 + 0.3 * Math.sin(t * 3);
        ctx.font = '12px "Press Start 2P", monospace';
        const emojis = ['\u{1F4AC}', '\u{1F4AD}', '✨'];
        ctx.fillText(emojis[Math.floor(t) % emojis.length], 0, floatY);
        ctx.globalAlpha = 1;

        ctx.restore();
    }

    _drawNameTag(ctx) {
        ctx.save();
        const s = 1 / (this._zoom || 1); // inverse zoom correction
        ctx.translate(this.x, this.y);
        ctx.scale(s, s); // fixed size in screen space
        ctx.translate(0, 38);
        const rawName = String(this.agent.name || this.agent.displayName || '').trim() || this.agent.displayName;
        ctx.font = 'bold 8px "Press Start 2P", monospace';
        const lines = this._wrapNameTagLines(ctx, rawName);
        const contentW = Math.max(...lines.map(line => ctx.measureText(line).width));
        const w = Math.min(190, contentW + 12);
        ctx.fillStyle = 'rgba(242, 211, 107, 0.94)';
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
        ctx.strokeStyle = '#5a371d';
        ctx.lineWidth = 1;
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

    hitTest(screenX, screenY) {
        const dx = screenX - this.x;
        const dy = screenY - this.y;
        return Math.abs(dx) < SPRITE_HIT_HALF_WIDTH && dy > SPRITE_HIT_TOP && dy < SPRITE_HIT_BOTTOM;
    }
}
