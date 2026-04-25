import { Position } from '../../domain/value-objects/Position.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { TILE_WIDTH, TILE_HEIGHT, AGENT_SPEED } from '../../config/constants.js';
import { BUILDING_DEFS } from '../../config/buildings.js';
import { THEME } from '../../config/theme.js';

const PROVIDER_PROFILES = {
    claude: {
        family: 'claude',
        shadow: 'rgba(62, 38, 18, 0.58)',
        outline: '#2b1b10',
        robe: ['#8f4f21', '#a85f24', '#7b3f1c'],
        pants: ['#3b2418', '#4b2c1a', '#33231a'],
        trim: ['#f2d36b', '#e9b85f', '#ffd98a'],
        accent: ['#fff1b8', '#f7c96f', '#d8843a'],
        accessory: ['mageHood', 'scholarCap', 'goldCirclet'],
        eyeStyle: ['happy', 'normal', 'sleepy'],
    },
    codex: {
        family: 'codex',
        shadow: 'rgba(13, 45, 48, 0.58)',
        outline: '#0d2d30',
        robe: ['#116466', '#167d86', '#1f6f8b'],
        pants: ['#102f3a', '#12353b', '#18334a'],
        trim: ['#7be3d7', '#55c7f0', '#8ee88e'],
        accent: ['#bff7ee', '#6ee7d8', '#5ad6ff'],
        accessory: ['goggles', 'toolBand', 'rogueMask'],
        eyeStyle: ['determined', 'normal', 'happy'],
    },
    gemini: {
        family: 'gemini',
        shadow: 'rgba(35, 31, 79, 0.58)',
        outline: '#241d50',
        robe: ['#4f46a5', '#5d65c8', '#44528e'],
        pants: ['#201c43', '#27244d', '#1f2d55'],
        trim: ['#b7ccff', '#d6b7ff', '#7bdff2'],
        accent: ['#f2edff', '#b9f2ff', '#d6b7ff'],
        accessory: ['starCrown', 'oracleVeil', 'moonBand'],
        eyeStyle: ['normal', 'determined', 'happy'],
    },
};

const DEFAULT_PROFILE = {
    family: 'default',
    shadow: 'rgba(43, 32, 24, 0.55)',
    outline: '#1d1410',
    robe: null,
    pants: null,
    trim: ['#f2d36b'],
    accent: ['#f2d36b'],
    accessory: null,
    eyeStyle: null,
};

const SPRITE_SCALE = 1.62;
const SPRITE_HIT_HALF_WIDTH = 24;
const SPRITE_HIT_TOP = -44;
const SPRITE_HIT_BOTTOM = 34;

export class AgentSprite {
    constructor(agent) {
        this.agent = agent;
        this.x = 0;
        this.y = 0;
        this.targetX = 0;
        this.targetY = 0;
        this.moving = false;
        this.facingLeft = false;
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

        this._pickTarget();
    }

    _pickTarget() {
        // Move to the partner position when there is a chat partner
        if (this.chatPartner) {
            this.targetX = this.chatPartner.x + (this.x < this.chatPartner.x ? -25 : 25);
            this.targetY = this.chatPartner.y;
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
                this.targetX = screen.x;
                this.targetY = screen.y;
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
        this.targetX = screen.x;
        this.targetY = screen.y;
        this.moving = true;
        this.waitTimer = 0;
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
            // Face each other when chat partners are nearby
            if (this.chatPartner) {
                this.facingLeft = this.chatPartner.x < this.x;
            }
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
                this.facingLeft = cpDx < 0;
                // Put the partner in chat state too
                if (!this.chatPartner.chatting) {
                    this.chatPartner.chatPartner = this;
                    this.chatPartner.chatting = true;
                    this.chatPartner.chatBubbleAnim = 0;
                    this.chatPartner.moving = false;
                    this.chatPartner.walkFrame = 0;
                    this.chatPartner.facingLeft = cpDx > 0;
                }
                return;
            }
            // Refresh target when the partner position changes
            this.targetX = this.chatPartner.x + (this.x < this.chatPartner.x ? -25 : 25);
            this.targetY = this.chatPartner.y;
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

        if (dist < 2) {
            this.moving = false;
            this.waitTimer = this.chatPartner ? 10 : this._waitDurationForState();
            this.walkFrame = 0;
            return;
        }

        const speed = this._speedForState();
        this.x += (dx / dist) * speed;
        this.y += (dy / dist) * speed;
        this.walkFrame += 0.15;
        this.facingLeft = dx < 0;

        if (this.motionScale > 0 && particleSystem && this.agent.status === AgentStatus.WORKING && Math.random() < 0.3) {
            particleSystem.spawn('footstep', this.x, this.y + 16, 1);
        }
    }

    /** Start chat (IsometricRenderercalled from) */
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

        ctx.save();
        ctx.translate(this.x, this.y);

        const sprite = this._getSpriteAppearance();
        const app = sprite.app;
        const profile = sprite.profile;
        this._drawIdentityAura(ctx, sprite);
        this._drawStateRing(ctx);

        ctx.beginPath();
        ctx.ellipse(0, 21, 20, 8, 0, 0, Math.PI * 2);
        ctx.fillStyle = profile.shadow;
        ctx.fill();

        if (this.selected) {
            ctx.beginPath();
            ctx.ellipse(0, 21, 28, 10, 0, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(242, 211, 107, 0.24)';
            ctx.fill();
            ctx.strokeStyle = '#f2d36b';
            ctx.lineWidth = 1.4;
            ctx.stroke();
        }

        const scaleX = this.facingLeft ? -1 : 1;
        ctx.scale(scaleX * SPRITE_SCALE * sprite.modelScale, SPRITE_SCALE * sprite.modelScale);

        const swing = this.moving ? Math.sin(this.walkFrame * 4) * 4 : 0;
        this._drawProviderSilhouette(ctx, sprite);

        // Boots and legs
        ctx.strokeStyle = '#2b2018';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(-3, 8);
        ctx.lineTo(-3 - swing, 16);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(3, 8);
        ctx.lineTo(3 + swing, 16);
        ctx.stroke();
        ctx.strokeStyle = app.pants;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-3, 7);
        ctx.lineTo(-3 - swing, 14);
        ctx.moveTo(3, 7);
        ctx.lineTo(3 + swing, 14);
        ctx.stroke();

        // Cloak shadow
        ctx.fillStyle = profile.shadow;
        ctx.beginPath();
        ctx.moveTo(-sprite.bodyWidth, -3);
        ctx.lineTo(0, 15);
        ctx.lineTo(sprite.bodyWidth, -3);
        ctx.closePath();
        ctx.fill();

        // Body
        ctx.fillStyle = profile.outline;
        ctx.fillRect(-sprite.bodyWidth + 1, -3, (sprite.bodyWidth - 1) * 2, 13);
        ctx.fillStyle = app.shirt;
        ctx.beginPath();
        ctx.moveTo(-sprite.bodyWidth + 2, -2);
        ctx.lineTo(sprite.bodyWidth - 2, -2);
        ctx.lineTo(sprite.bodyWidth - 3, 10);
        ctx.lineTo(-sprite.bodyWidth + 3, 10);
        ctx.closePath();
        ctx.fill();
        this._drawProviderBodyDetails(ctx, sprite);
        this._drawModelInsignia(ctx, sprite);

        // Arms
        ctx.strokeStyle = profile.outline;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(-5, 0);
        ctx.lineTo(-8 + swing, 8);
        ctx.moveTo(5, 0);
        ctx.lineTo(8 - swing, 8);
        ctx.stroke();
        ctx.strokeStyle = app.skin;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-5, 0);
        ctx.lineTo(-8 + swing, 8);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(5, 0);
        ctx.lineTo(8 - swing, 8);
        ctx.stroke();

        // Head
        ctx.fillStyle = profile.outline;
        ctx.beginPath();
        ctx.arc(0, -6, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = app.skin;
        ctx.beginPath();
        ctx.arc(0, -6, 5, 0, Math.PI * 2);
        ctx.fill();

        // Hair
        this._drawHair(ctx, app);

        // Eyes
        this._drawEyes(ctx, app, profile);

        // Accessory
        this._drawAccessory(ctx, app, sprite);
        this._drawProviderHandProp(ctx, sprite, swing);
        this._drawEffortBadge(ctx, sprite);

        ctx.restore();

        // Chatting effects
        if (this.chatting) {
            this._drawChatEffect(ctx);
        }

        // Status indicators (drawn without flip, zoom-independent)
        if (!this.chatting) {
            this._drawStatus(ctx);
        }
        this._drawNameTag(ctx);
    }

    _getSpriteAppearance() {
        const base = this.agent.appearance;
        const providerKey = this._providerKey();
        const profile = PROVIDER_PROFILES[providerKey] || DEFAULT_PROFILE;
        const hash = Math.abs(this._hash(`${this.agent.id}:${this.agent.model || ''}:${providerKey}`));
        const pick = (items, offset = 0) => items[(hash >> offset) % items.length];
        const modelTier = this._modelTier();

        const app = {
            ...base,
            shirt: profile.robe ? pick(profile.robe, 2) : base.shirt,
            pants: profile.pants ? pick(profile.pants, 6) : base.pants,
            accessory: profile.accessory ? pick(profile.accessory, 10) : base.accessory,
            eyeStyle: profile.eyeStyle ? pick(profile.eyeStyle, 14) : base.eyeStyle,
        };

        return {
            app,
            profile,
            hash,
            trim: pick(profile.trim, 18),
            accent: pick(profile.accent, 22),
            variant: hash % 4,
            modelTier,
            effortTier: this._effortTier(),
            providerKey,
            bodyWidth: modelTier === 'apex' ? 10 : modelTier === 'strong' ? 9 : 8,
            modelScale: modelTier === 'apex' ? 1.08 : modelTier === 'swift' ? 0.96 : 1,
        };
    }

    _providerKey() {
        const provider = String(this.agent.provider || '').toLowerCase();
        const model = String(this.agent.model || '').toLowerCase();
        if (provider.includes('gemini') || model.includes('gemini')) return 'gemini';
        if (provider.includes('codex') || model.includes('codex') || model.includes('gpt')) return 'codex';
        if (provider.includes('claude') || model.includes('claude')) return 'claude';
        return 'default';
    }

    _modelTier() {
        const model = String(this.agent.model || '').toLowerCase();
        if (model.includes('opus') || model.includes('5.5') || model.includes('pro')) return 'apex';
        if (model.includes('sonnet') || model.includes('5.4') || model.includes('5.3')) return 'strong';
        if (model.includes('haiku') || model.includes('mini') || model.includes('flash')) return 'swift';
        return 'standard';
    }

    _effortTier() {
        const effort = String(this.agent.effort || '').toLowerCase();
        if (effort.includes('xhigh') || effort.includes('extra')) return 'xhigh';
        if (effort.includes('high')) return 'high';
        if (effort.includes('medium')) return 'medium';
        if (effort.includes('low')) return 'low';
        return null;
    }

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

    _drawIdentityAura(ctx, sprite) {
        const effortAlpha = {
            low: 0.08,
            medium: 0.13,
            high: 0.2,
            xhigh: 0.28,
        }[sprite.effortTier] || 0;
        const modelAlpha = sprite.modelTier === 'apex' ? 0.16 : sprite.modelTier === 'strong' ? 0.09 : 0;
        const alpha = effortAlpha + modelAlpha;
        if (alpha <= 0) return;

        const pulse = this.motionScale ? Math.sin(this.statusAnim * 2.1) * 0.12 : 0;
        ctx.save();
        ctx.strokeStyle = sprite.accent;
        ctx.globalAlpha = Math.max(0, Math.min(0.42, alpha + pulse));
        ctx.lineWidth = sprite.effortTier === 'xhigh' ? 2 : 1.2;
        ctx.beginPath();
        ctx.ellipse(0, 10, 26, 13, 0, 0, Math.PI * 2);
        ctx.stroke();
        if (sprite.modelTier === 'apex') {
            ctx.beginPath();
            ctx.ellipse(0, -12, 15, 6, 0, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawStateRing(ctx) {
        const status = this.agent.status;
        const color = status === AgentStatus.WORKING ? THEME.working :
            status === AgentStatus.WAITING ? THEME.waiting :
                THEME.idle;
        const pulse = this.motionScale ? Math.sin(this.statusAnim * 2.4) : 0;

        ctx.save();
        ctx.translate(0, 21);
        ctx.strokeStyle = color;
        ctx.lineWidth = status === AgentStatus.WORKING ? 2.2 : 1.5;
        ctx.globalAlpha = status === AgentStatus.WORKING
            ? 0.72 + Math.max(0, pulse) * 0.18
            : status === AgentStatus.WAITING
                ? 0.48 + Math.max(0, pulse) * 0.16
                : 0.28;
        if (status === AgentStatus.WORKING) {
            ctx.setLineDash([8, 5]);
            ctx.lineDashOffset = -this.statusAnim * 18;
        } else if (status === AgentStatus.WAITING) {
            ctx.setLineDash([2, 6]);
            ctx.lineDashOffset = -this.statusAnim * 8;
        }
        ctx.beginPath();
        ctx.ellipse(0, 0, status === AgentStatus.WORKING ? 25 : 22, status === AgentStatus.WORKING ? 10 : 8, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    _drawProviderSilhouette(ctx, sprite) {
        if (sprite.profile.family === 'claude') {
            ctx.fillStyle = 'rgba(92, 45, 19, 0.92)';
            ctx.beginPath();
            ctx.moveTo(-10, -1);
            ctx.quadraticCurveTo(-6, -12, 0, -15);
            ctx.quadraticCurveTo(6, -12, 10, -1);
            ctx.lineTo(7, 11);
            ctx.lineTo(-7, 11);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = sprite.trim;
            ctx.lineWidth = 0.9;
            ctx.beginPath();
            ctx.moveTo(-5, -9);
            ctx.quadraticCurveTo(0, -13, 5, -9);
            ctx.stroke();
            return;
        }

        if (sprite.profile.family === 'codex') {
            ctx.fillStyle = 'rgba(8, 37, 41, 0.92)';
            ctx.fillRect(-10, -3, 20, 13);
            ctx.fillStyle = sprite.trim;
            ctx.fillRect(-12, 0, 3, 8);
            ctx.fillRect(9, 0, 3, 8);
            ctx.strokeStyle = sprite.accent;
            ctx.lineWidth = 0.9;
            ctx.beginPath();
            ctx.moveTo(-8, -5);
            ctx.lineTo(8, -5);
            ctx.moveTo(-6, -7);
            ctx.lineTo(-2, -7);
            ctx.moveTo(2, -7);
            ctx.lineTo(6, -7);
            ctx.stroke();
            return;
        }

        if (sprite.profile.family === 'gemini') {
            ctx.strokeStyle = sprite.trim;
            ctx.lineWidth = 1.1;
            ctx.beginPath();
            ctx.arc(0, -9, 11, Math.PI * 1.05, Math.PI * 1.95);
            ctx.stroke();
            ctx.fillStyle = 'rgba(50, 42, 111, 0.9)';
            ctx.beginPath();
            ctx.moveTo(-9, -2);
            ctx.lineTo(0, 13);
            ctx.lineTo(9, -2);
            ctx.lineTo(0, 2);
            ctx.closePath();
            ctx.fill();
        }
    }

    _drawProviderBodyDetails(ctx, sprite) {
        if (sprite.profile.family === 'claude') {
            ctx.fillStyle = sprite.trim;
            ctx.fillRect(-1, -1, 2, 11);
            ctx.fillRect(-4, 3, 8, 1);
            ctx.fillStyle = 'rgba(255, 241, 184, 0.75)';
            ctx.fillRect(sprite.variant % 2 ? 2 : -3, 5, 2, 2);
            return;
        }

        if (sprite.profile.family === 'codex') {
            ctx.fillStyle = sprite.trim;
            ctx.fillRect(-4, 1, 8, 2);
            ctx.fillRect(sprite.variant % 2 ? 2 : -4, -1, 2, 10);
            ctx.fillStyle = '#0b2529';
            ctx.fillRect(-5, 7, 10, 2);
            ctx.fillStyle = sprite.accent;
            ctx.fillRect(-4 + sprite.variant, 7, 2, 2);
            return;
        }

        if (sprite.profile.family === 'gemini') {
            ctx.fillStyle = sprite.trim;
            ctx.beginPath();
            ctx.moveTo(0, -2);
            ctx.lineTo(4, 4);
            ctx.lineTo(0, 10);
            ctx.lineTo(-4, 4);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = sprite.accent;
            ctx.fillRect(-1, 2, 2, 5);
            return;
        }

        ctx.fillStyle = 'rgba(242, 211, 107, 0.65)';
        ctx.fillRect(-1, -1, 2, 11);
        ctx.fillRect(-4, 3, 8, 1);
    }

    _drawModelInsignia(ctx, sprite) {
        const color = {
            apex: '#fff1b8',
            strong: sprite.trim,
            swift: '#9fd9d1',
            standard: 'rgba(242, 211, 107, 0.72)',
        }[sprite.modelTier] || sprite.trim;

        ctx.fillStyle = color;
        if (sprite.modelTier === 'apex') {
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(0, 3, 5, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, -1);
            ctx.lineTo(4, 3);
            ctx.lineTo(0, 7);
            ctx.lineTo(-4, 3);
            ctx.closePath();
            ctx.fill();
        } else if (sprite.modelTier === 'strong') {
            ctx.fillRect(-4, 2, 8, 2);
            ctx.fillRect(-1, -1, 2, 8);
        } else if (sprite.modelTier === 'swift') {
            ctx.beginPath();
            ctx.moveTo(-4, 3);
            ctx.lineTo(2, 0);
            ctx.lineTo(-1, 4);
            ctx.lineTo(4, 4);
            ctx.lineTo(-2, 9);
            ctx.lineTo(0, 5);
            ctx.closePath();
            ctx.fill();
        } else {
            ctx.fillRect(-2, 3, 4, 2);
        }
    }

    _drawHair(ctx, app) {
        ctx.fillStyle = app.hair;
        switch (app.hairStyle) {
            case 'short':
                ctx.beginPath();
                ctx.arc(0, -8, 5, Math.PI, 0);
                ctx.fill();
                ctx.fillRect(-4, -8, 8, 2);
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
            case 'bald':
                break;
        }
    }

    _drawEyes(ctx, app, profile = DEFAULT_PROFILE) {
        ctx.fillStyle = profile.family === 'codex' ? '#bff7ee' : '#000';
        ctx.strokeStyle = profile.family === 'codex' ? '#bff7ee' : '#000';
        switch (app.eyeStyle) {
            case 'normal':
                ctx.fillRect(-3, -7, 2, 2);
                ctx.fillRect(1, -7, 2, 2);
                break;
            case 'happy':
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
    }

    _drawAccessory(ctx, app, sprite = null) {
        if (sprite?.profile.family === 'claude') {
            this._drawClaudeAccessory(ctx, app, sprite);
            return;
        }
        if (sprite?.profile.family === 'codex') {
            this._drawCodexAccessory(ctx, app, sprite);
            return;
        }
        if (sprite?.profile.family === 'gemini') {
            this._drawGeminiAccessory(ctx, app, sprite);
            return;
        }

        switch (app.accessory) {
            case 'crown':
                ctx.fillStyle = '#f2d36b';
                ctx.beginPath();
                ctx.moveTo(-4, -12);
                ctx.lineTo(-4, -15);
                ctx.lineTo(-2, -13);
                ctx.lineTo(0, -16);
                ctx.lineTo(2, -13);
                ctx.lineTo(4, -15);
                ctx.lineTo(4, -12);
                ctx.closePath();
                ctx.fill();
                ctx.strokeStyle = '#5a371d';
                ctx.lineWidth = 0.8;
                ctx.stroke();
                break;
            case 'glasses':
                ctx.strokeStyle = '#2b2018';
                ctx.lineWidth = 0.8;
                ctx.beginPath();
                ctx.rect(-4, -8, 3, 3);
                ctx.rect(1, -8, 3, 3);
                ctx.moveTo(-1, -6.5);
                ctx.lineTo(1, -6.5);
                ctx.stroke();
                break;
            case 'headphones':
                ctx.strokeStyle = '#2b2018';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(0, -7, 6, Math.PI, 0);
                ctx.stroke();
                ctx.fillStyle = '#5c4b39';
                ctx.fillRect(-7, -7, 3, 4);
                ctx.fillRect(4, -7, 3, 4);
                break;
            case 'hat':
                ctx.fillStyle = '#5a371d';
                ctx.fillRect(-7, -12, 14, 2);
                ctx.fillRect(-4, -16, 8, 4);
                ctx.fillStyle = '#f2d36b';
                ctx.fillRect(-3, -13, 6, 1);
                break;
        }
    }

    _drawClaudeAccessory(ctx, app, sprite) {
        switch (app.accessory) {
            case 'mageHood':
                ctx.fillStyle = '#6f3518';
                ctx.beginPath();
                ctx.moveTo(-7, -8);
                ctx.lineTo(0, -17);
                ctx.lineTo(7, -8);
                ctx.closePath();
                ctx.fill();
                ctx.strokeStyle = sprite.trim;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(-4, -10);
                ctx.lineTo(0, -15);
                ctx.lineTo(4, -10);
                ctx.stroke();
                break;
            case 'scholarCap':
                ctx.fillStyle = '#5a371d';
                ctx.fillRect(-6, -13, 12, 2);
                ctx.fillRect(-4, -16, 8, 4);
                ctx.fillStyle = sprite.trim;
                ctx.fillRect(-3, -13, 6, 1);
                ctx.fillRect(5, -13, 1, 4);
                break;
            case 'goldCirclet':
                ctx.strokeStyle = sprite.trim;
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.arc(0, -8, 5, Math.PI * 1.05, Math.PI * 1.95);
                ctx.stroke();
                ctx.fillStyle = sprite.accent;
                ctx.fillRect(-1, -12, 2, 2);
                break;
        }
    }

    _drawCodexAccessory(ctx, app, sprite) {
        switch (app.accessory) {
            case 'goggles':
                ctx.strokeStyle = sprite.trim;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.rect(-5, -9, 4, 3);
                ctx.rect(1, -9, 4, 3);
                ctx.moveTo(-1, -7.5);
                ctx.lineTo(1, -7.5);
                ctx.stroke();
                ctx.fillStyle = 'rgba(191, 247, 238, 0.45)';
                ctx.fillRect(-4, -8, 2, 1);
                ctx.fillRect(2, -8, 2, 1);
                break;
            case 'toolBand':
                ctx.strokeStyle = sprite.trim;
                ctx.lineWidth = 1.4;
                ctx.beginPath();
                ctx.moveTo(-6, -12);
                ctx.lineTo(6, -12);
                ctx.stroke();
                ctx.fillStyle = sprite.accent;
                ctx.fillRect(sprite.variant % 2 ? 3 : -4, -15, 2, 4);
                break;
            case 'rogueMask':
                ctx.fillStyle = '#092529';
                ctx.fillRect(-5, -8, 10, 3);
                ctx.fillStyle = sprite.trim;
                ctx.fillRect(-3, -7, 2, 1);
                ctx.fillRect(1, -7, 2, 1);
                break;
        }
    }

    _drawGeminiAccessory(ctx, app, sprite) {
        switch (app.accessory) {
            case 'starCrown':
                ctx.fillStyle = sprite.trim;
                for (const x of [-4, 0, 4]) {
                    ctx.beginPath();
                    ctx.moveTo(x, -16);
                    ctx.lineTo(x + 2, -12);
                    ctx.lineTo(x - 2, -12);
                    ctx.closePath();
                    ctx.fill();
                }
                ctx.strokeStyle = sprite.accent;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(-6, -12);
                ctx.lineTo(6, -12);
                ctx.stroke();
                break;
            case 'oracleVeil':
                ctx.fillStyle = 'rgba(183, 204, 255, 0.58)';
                ctx.fillRect(-6, -9, 12, 4);
                ctx.fillStyle = sprite.accent;
                ctx.fillRect(-4, -8, 2, 1);
                ctx.fillRect(2, -8, 2, 1);
                break;
            case 'moonBand':
                ctx.strokeStyle = sprite.trim;
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.arc(0, -8, 6, Math.PI * 1.05, Math.PI * 1.95);
                ctx.stroke();
                ctx.fillStyle = sprite.accent;
                ctx.beginPath();
                ctx.arc(4, -12, 2, Math.PI * 0.4, Math.PI * 1.6);
                ctx.fill();
                break;
        }
    }

    _drawProviderHandProp(ctx, sprite, swing) {
        if (sprite.profile.family === 'claude') {
            ctx.fillStyle = '#6b3f1f';
            ctx.fillRect(-11 + swing, 5, 5, 6);
            ctx.fillStyle = sprite.trim;
            ctx.fillRect(-10 + swing, 5, 1, 6);
            ctx.fillStyle = sprite.accent;
            ctx.fillRect(-8 + swing, 4, 2, 1);
            return;
        }

        if (sprite.profile.family === 'codex') {
            ctx.strokeStyle = sprite.accent;
            ctx.lineWidth = 1.3;
            ctx.beginPath();
            ctx.moveTo(8 - swing, 6);
            ctx.lineTo(12 - swing, 2);
            ctx.moveTo(10 - swing, 2);
            ctx.lineTo(12 - swing, 4);
            ctx.stroke();
            ctx.fillStyle = '#0b2529';
            ctx.fillRect(5, -1, 2, 10);
        }

        if (sprite.profile.family === 'gemini') {
            ctx.strokeStyle = sprite.accent;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(-8 + swing, 5);
            ctx.lineTo(-12 + swing, 0);
            ctx.stroke();
            ctx.fillStyle = sprite.trim;
            ctx.beginPath();
            ctx.arc(-12 + swing, 0, 2, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    _drawEffortBadge(ctx, sprite) {
        if (!sprite.effortTier) return;
        const marks = { low: 1, medium: 2, high: 3, xhigh: 4 }[sprite.effortTier] || 0;
        const colors = {
            low: 'rgba(126, 183, 214, 0.82)',
            medium: 'rgba(242, 211, 107, 0.88)',
            high: 'rgba(255, 138, 42, 0.9)',
            xhigh: 'rgba(255, 241, 184, 0.96)',
        };
        ctx.fillStyle = colors[sprite.effortTier];
        for (let i = 0; i < marks; i++) {
            ctx.beginPath();
            ctx.arc(11, -5 + i * 4, 1.7, 0, Math.PI * 2);
            ctx.fill();
        }
        if (sprite.effortTier === 'high' || sprite.effortTier === 'xhigh') {
            ctx.strokeStyle = colors[sprite.effortTier];
            ctx.lineWidth = sprite.effortTier === 'xhigh' ? 1.4 : 0.9;
            ctx.beginPath();
            ctx.arc(0, -6, sprite.effortTier === 'xhigh' ? 12 : 10, Math.PI * 1.12, Math.PI * 1.88);
            ctx.stroke();
        }
    }

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
        const emojis = ['\u{1F4AC}', '\u{1F4AD}', '\u2728'];
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
        const name = this.agent.name;
        ctx.font = 'bold 9px "Press Start 2P", monospace';
        const w = ctx.measureText(name).width + 10;
        ctx.fillStyle = 'rgba(242, 211, 107, 0.94)';
        const h = 16, r = 4;
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
        ctx.fillText(name, 0, 1);
        ctx.restore();
    }

    hitTest(screenX, screenY) {
        const dx = screenX - this.x;
        const dy = screenY - this.y;
        return Math.abs(dx) < SPRITE_HIT_HALF_WIDTH && dy > SPRITE_HIT_TOP && dy < SPRITE_HIT_BOTTOM;
    }
}
