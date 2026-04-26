import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';

const MAX_ITEMS_PER_KIND = 10;
const SNAPSHOT_TTL_MS = 18000;
const FORGE_HANDOFF_WINDOW_MS = 45000;
const TOKEN_ITEM_TTL_MS = 22000;
const COMMAND_ITEM_TTL_MS = 16000;

const BUILDING_OFFSETS = {
    command: [
        { x: -42, y: -48 }, { x: -16, y: -62 }, { x: 20, y: -58 }, { x: 44, y: -36 },
    ],
    forge: [
        { x: -28, y: -30 }, { x: -6, y: -42 }, { x: 20, y: -30 }, { x: 38, y: -12 },
    ],
    mine: [
        { x: -34, y: -24 }, { x: -10, y: -36 }, { x: 22, y: -30 }, { x: 42, y: -12 },
    ],
    taskboard: [
        { x: -36, y: -34 }, { x: -12, y: -46 }, { x: 14, y: -40 }, { x: 38, y: -24 },
    ],
};

const TOOL_LABELS = {
    forge: 'PATCH',
    taskboard: 'CHECK',
    command: 'SEND',
    mine: 'TOK',
};

function toWorld(tileX, tileY) {
    return {
        x: (tileX - tileY) * TILE_WIDTH / 2,
        y: (tileX + tileY) * TILE_HEIGHT / 2,
    };
}

function tokenTotal(agent) {
    const tokens = agent?.tokens || {};
    const input = Number(tokens.input ?? tokens.totalInput ?? 0) || 0;
    const output = Number(tokens.output ?? tokens.totalOutput ?? 0) || 0;
    const cacheRead = Number(tokens.cacheRead ?? 0) || 0;
    const cacheCreate = Number(tokens.cacheCreate ?? tokens.cacheWrite ?? 0) || 0;
    return input + output + cacheRead + cacheCreate;
}

function contextRatio(agent) {
    const tokens = agent?.tokens || {};
    const current = Number(tokens.contextWindow ?? 0) || 0;
    const max = Number(tokens.contextWindowMax ?? 0) || 0;
    if (current <= 0 || max <= 0) return 0;
    return Math.max(0, Math.min(1, current / max));
}

function stableHash(input) {
    const text = String(input || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

function compactLabel(value, fallback = '') {
    const text = String(value || fallback || '').replace(/\s+/g, ' ').trim();
    if (!text) return fallback;
    const lastSlash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    const base = (lastSlash >= 0 ? text.slice(lastSlash + 1) : text).split(/\s+/)[0] || text;
    return base.length > 10 ? `${base.slice(0, 7)}...` : base;
}

function activityKey(agent, kind) {
    return [
        kind,
        agent?.id || 'unknown',
        agent?.currentTool || agent?.lastTool || '',
        agent?.currentToolInput || agent?.lastToolInput || '',
        agent?.lastSessionActivity || '',
    ].join('|');
}

function isTaskCommand(agent) {
    const text = `${agent?.currentTool || ''} ${agent?.currentToolInput || ''} ${agent?.lastToolInput || ''}`.toLowerCase();
    return /\b(test|check|lint|build|vitest|pytest|playwright\s+test|node\s+--check|sprites:validate)\b/.test(text);
}

function isCommandTool(agent) {
    const tool = String(agent?.currentTool || '').toLowerCase();
    return tool.includes('spawn_agent') ||
        tool.includes('send_input') ||
        tool.includes('resume_agent') ||
        tool.includes('close_agent') ||
        tool.includes('team') ||
        tool.includes('parallel') ||
        tool === 'task' ||
        tool === 'multi_tool_use';
}

function commandActivityLabel(agent) {
    if (agent?.currentTool === 'SendMessage') return 'MSG';
    if (agent?.currentTool === 'Task') return 'SUMMON';
    return compactLabel(agent?.currentTool, TOOL_LABELS.command);
}

export class LandmarkActivity {
    constructor({ world, sprites } = {}) {
        this.world = world || null;
        this.sprites = sprites || null;
        this.motionScale = 1;
        this.frame = 0;
        this.items = new Map();
        this.seenSnapshots = new Set();
        this.previousTokenTotals = new Map();
        this.lastForgeByAgent = new Map();
        this.agentSprites = [];
    }

    setMotionScale(scale) {
        this.motionScale = scale === 0 ? 0 : 1;
    }

    update(agents, agentSprites = [], dt = 16, now = Date.now()) {
        this.frame += (dt / 16) * this.motionScale;
        this.agentSprites = Array.from(agentSprites || []);
        const agentList = Array.from(agents || []);

        for (const agent of agentList) {
            this._observeTokens(agent, now);
            this._observeToolActivity(agent, now);
        }

        this._observeCommandRelationships(agentList, now);
        this._expireItems(now);
    }

    enumerateDrawables(now = Date.now()) {
        const drawables = [];
        for (const item of this.items.values()) {
            const pos = this._itemPosition(item, now);
            if (!pos) continue;
            drawables.push({
                kind: 'landmark-activity',
                sortY: pos.y + (item.sortOffset || 0),
                payload: {
                    ...item,
                    x: pos.x,
                    y: pos.y,
                    progress: pos.progress,
                    alpha: this._itemAlpha(item, now),
                },
            });
        }
        return drawables
            .filter((d) => d.payload.alpha > 0.03)
            .sort((a, b) => a.sortY - b.sortY);
    }

    draw(ctx, drawable, zoom = 1) {
        const item = drawable?.payload || drawable;
        if (!item) return;
        if (item.type === 'forge') return this._drawForgeItem(ctx, item, zoom);
        if (item.type === 'handoff') return this._drawHandoffItem(ctx, item, zoom);
        if (item.type === 'task') return this._drawTaskItem(ctx, item, zoom);
        if (item.type === 'chat') return this._drawChatItem(ctx, item, zoom);
        if (item.type === 'chat-line') return this._drawConnection(ctx, item, '#f2d36b', zoom);
        if (item.type === 'token') return this._drawTokenItem(ctx, item, zoom);
        if (item.type === 'command') return this._drawCommandItem(ctx, item, zoom);
        if (item.type === 'dispatch-line') return this._drawConnection(ctx, item, '#f6c85f', zoom);
    }

    _observeToolActivity(agent, now) {
        if (!agent?.currentTool) return;
        const building = agent.targetBuildingType;
        if (building === 'forge') this._addForgeItem(agent, now);
        if (building === 'taskboard') this._addTaskItem(agent, now);
        if (building === 'command' || isCommandTool(agent)) this._addCommandItem(agent, now);
    }

    _observeTokens(agent, now) {
        if (!agent?.id) return;
        const current = tokenTotal(agent);
        const previous = this.previousTokenTotals.get(agent.id);
        this.previousTokenTotals.set(agent.id, current);
        if (previous == null || current <= previous) return;
        const delta = current - previous;
        if (delta < 128) return;
        const id = `token:${agent.id}:${agent.lastSessionActivity || now}:${Math.round(current / 128)}`;
        if (this.items.has(id)) return;
        this.items.set(id, {
            id,
            type: 'token',
            building: 'mine',
            agentId: agent.id,
            createdAt: now,
            expiresAt: now + TOKEN_ITEM_TTL_MS,
            delta,
            ratio: contextRatio(agent),
            slot: stableHash(id) % BUILDING_OFFSETS.mine.length,
            sortOffset: 4,
        });
        this._capKind('token', MAX_ITEMS_PER_KIND);
    }

    _observeCommandRelationships(agents, now) {
        const byId = new Map();
        for (const sprite of this.agentSprites) {
            if (sprite?.agent?.id) byId.set(sprite.agent.id, sprite);
        }

        for (const agent of agents) {
            if (!agent?.parentSessionId) continue;
            if (Number.isFinite(agent.activityAgeMs) && agent.activityAgeMs > COMMAND_ITEM_TTL_MS) continue;
            const sprite = byId.get(agent.id);
            if (!sprite) continue;
            const id = `dispatch-line:${agent.parentSessionId}:${agent.id}:${agent.lastSessionActivity || 'live'}`;
            if (this.seenSnapshots.has(id)) continue;
            this.seenSnapshots.add(id);
            const command = this._buildingCenter('command');
            if (!command) continue;
            this.items.set(id, {
                id,
                type: 'dispatch-line',
                building: 'command',
                createdAt: now,
                expiresAt: now + 3500,
                startX: command.x,
                startY: command.y - 68,
                endX: sprite.x,
                endY: sprite.y - 42,
                label: 'SUB',
                sortOffset: -80,
            });
            this._capKind('dispatch-line', MAX_ITEMS_PER_KIND);
        }

        for (const sprite of this.agentSprites) {
            if (!sprite?.agent) continue;
            const agent = sprite.agent;
            if (agent.currentTool === 'SendMessage' && sprite.chatPartner) {
                const id = `chat-line:${agent.id}:${sprite.chatPartner.agent?.id || 'target'}`;
                this.items.set(id, {
                    id,
                    type: 'chat-line',
                    building: 'command',
                    createdAt: now,
                    expiresAt: now + 2500,
                    startX: sprite.x,
                    startY: sprite.y - 48,
                    endX: sprite.chatPartner.x,
                    endY: sprite.chatPartner.y - 48,
                    label: 'MSG',
                    sortOffset: -60,
                });
            }
        }
    }

    _addForgeItem(agent, now) {
        const id = activityKey(agent, 'forge');
        if (this.seenSnapshots.has(id)) return;
        this.seenSnapshots.add(id);
        const slot = stableHash(id) % BUILDING_OFFSETS.forge.length;
        this.items.set(id, {
            id,
            type: 'forge',
            building: 'forge',
            agentId: agent.id,
            createdAt: now,
            expiresAt: now + SNAPSHOT_TTL_MS,
            slot,
            label: compactLabel(agent.currentToolInput, TOOL_LABELS.forge),
            sortOffset: 6,
        });
        this.lastForgeByAgent.set(agent.id, { id, at: now });
        this._capKind('forge', MAX_ITEMS_PER_KIND);
    }

    _addTaskItem(agent, now) {
        const id = activityKey(agent, 'task');
        if (this.seenSnapshots.has(id)) return;
        this.seenSnapshots.add(id);
        const slot = stableHash(id) % BUILDING_OFFSETS.taskboard.length;
        this.items.set(id, {
            id,
            type: 'task',
            building: 'taskboard',
            agentId: agent.id,
            createdAt: now,
            expiresAt: now + SNAPSHOT_TTL_MS,
            slot,
            label: isTaskCommand(agent) ? 'VERIFY' : compactLabel(agent.currentTool, TOOL_LABELS.taskboard),
            isCheck: isTaskCommand(agent),
            sortOffset: 5,
        });
        const forge = this.lastForgeByAgent.get(agent.id);
        if (forge && now - forge.at <= FORGE_HANDOFF_WINDOW_MS) {
            const handoffId = `handoff:${agent.id}:${forge.id}:${id}`;
            this.items.set(handoffId, {
                id: handoffId,
                type: 'handoff',
                building: 'forge',
                agentId: agent.id,
                createdAt: now,
                expiresAt: now + 14000,
                label: 'READY',
                sortOffset: 2,
            });
        }
        this._capKind('task', MAX_ITEMS_PER_KIND);
    }

    _addCommandItem(agent, now) {
        const id = activityKey(agent, 'command');
        if (this.seenSnapshots.has(id)) return;
        this.seenSnapshots.add(id);
        const slot = stableHash(id) % BUILDING_OFFSETS.command.length;
        this.items.set(id, {
            id,
            type: 'command',
            building: 'command',
            agentId: agent.id,
            createdAt: now,
            expiresAt: now + COMMAND_ITEM_TTL_MS,
            slot,
            label: commandActivityLabel(agent),
            sortOffset: -2,
        });
        this._capKind('command', MAX_ITEMS_PER_KIND);
    }

    _expireItems(now) {
        for (const [id, item] of this.items) {
            if (item.expiresAt <= now) this.items.delete(id);
        }
        if (this.seenSnapshots.size > 400) {
            this.seenSnapshots = new Set([...this.seenSnapshots].slice(-240));
        }
    }

    _capKind(type, max) {
        const sameType = [...this.items.values()]
            .filter((item) => item.type === type)
            .sort((a, b) => a.createdAt - b.createdAt);
        while (sameType.length > max) {
            const oldest = sameType.shift();
            if (oldest) this.items.delete(oldest.id);
        }
    }

    _itemPosition(item, now) {
        if (item.type === 'handoff') {
            const start = this._buildingCenter('forge');
            const end = this._buildingCenter('taskboard');
            if (!start || !end) return null;
            const progress = this.motionScale === 0
                ? 1
                : Math.max(0, Math.min(1, (now - item.createdAt) / 9000));
            const eased = 1 - Math.pow(1 - progress, 3);
            return {
                x: start.x + (end.x - start.x) * eased,
                y: start.y - 34 + (end.y - start.y) * eased,
                progress,
            };
        }

        const center = this._buildingCenter(item.building);
        if (!center) return null;
        const offsets = BUILDING_OFFSETS[item.building] || [{ x: 0, y: -32 }];
        const offset = offsets[item.slot % offsets.length] || offsets[0];
        const age = now - item.createdAt;
        const bob = this.motionScale ? Math.sin(this.frame * 0.09 + item.slot) * 2 : 0;
        const settle = this.motionScale ? Math.min(1, age / 700) : 1;
        return {
            x: center.x + offset.x,
            y: center.y + offset.y - (1 - settle) * 10 + bob,
            progress: Math.max(0, Math.min(1, age / Math.max(1, item.expiresAt - item.createdAt))),
        };
    }

    _buildingCenter(type) {
        const building = this.world?.buildings?.get(type);
        if (!building) return null;
        const cx = building.position.tileX + building.width / 2;
        const cy = building.position.tileY + building.height / 2;
        return toWorld(cx, cy);
    }

    _itemAlpha(item, now) {
        const ttl = Math.max(1, item.expiresAt - item.createdAt);
        const age = Math.max(0, now - item.createdAt);
        const remaining = Math.max(0, item.expiresAt - now);
        const fadeIn = this.motionScale === 0 ? 1 : Math.min(1, age / 500);
        const fadeOut = Math.min(1, remaining / Math.min(1600, ttl));
        return Math.max(0, Math.min(1, fadeIn * fadeOut));
    }

    _drawForgeItem(ctx, item, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        ctx.save();
        ctx.globalAlpha = item.alpha;
        ctx.fillStyle = 'rgba(255, 137, 66, 0.28)';
        ctx.beginPath();
        ctx.ellipse(item.x, item.y + 4 * s, 20 * s, 10 * s, -0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#f08a4b';
        ctx.strokeStyle = '#3d2517';
        ctx.lineWidth = Math.max(1, Math.round(2 * s));
        ctx.beginPath();
        ctx.moveTo(item.x - 12 * s, item.y - 4 * s);
        ctx.lineTo(item.x + 8 * s, item.y - 10 * s);
        ctx.lineTo(item.x + 16 * s, item.y);
        ctx.lineTo(item.x - 5 * s, item.y + 8 * s);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        this._drawTinyLabel(ctx, item, item.x, item.y - 17 * s, s, '#ffd88a');
        ctx.restore();
    }

    _drawHandoffItem(ctx, item, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        ctx.save();
        ctx.globalAlpha = item.alpha;
        ctx.strokeStyle = 'rgba(242, 211, 107, 0.48)';
        ctx.lineWidth = Math.max(1, Math.round(2 * s));
        const start = this._buildingCenter('forge');
        const end = this._buildingCenter('taskboard');
        if (start && end) {
            ctx.beginPath();
            ctx.moveTo(start.x, start.y - 36);
            ctx.lineTo(end.x, end.y - 28);
            ctx.stroke();
        }
        ctx.fillStyle = '#8a5530';
        ctx.strokeStyle = '#2d1c12';
        ctx.fillRect(Math.round(item.x - 10 * s), Math.round(item.y - 10 * s), Math.round(20 * s), Math.round(14 * s));
        ctx.strokeRect(Math.round(item.x - 10 * s) + 0.5, Math.round(item.y - 10 * s) + 0.5, Math.round(20 * s), Math.round(14 * s));
        ctx.fillStyle = '#f2d36b';
        ctx.fillRect(Math.round(item.x - 2 * s), Math.round(item.y - 10 * s), Math.max(1, Math.round(4 * s)), Math.round(14 * s));
        ctx.restore();
    }

    _drawTaskItem(ctx, item, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        ctx.save();
        ctx.globalAlpha = item.alpha;
        ctx.fillStyle = item.isCheck ? '#f2d36b' : '#e2c48a';
        ctx.strokeStyle = item.isCheck ? '#5f4321' : '#4a3420';
        ctx.lineWidth = 1;
        ctx.fillRect(Math.round(item.x - 13 * s), Math.round(item.y - 12 * s), Math.round(26 * s), Math.round(18 * s));
        ctx.strokeRect(Math.round(item.x - 13 * s) + 0.5, Math.round(item.y - 12 * s) + 0.5, Math.round(26 * s), Math.round(18 * s));
        ctx.strokeStyle = 'rgba(68, 44, 24, 0.55)';
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.moveTo(item.x - 8 * s, item.y - (6 - i * 5) * s);
            ctx.lineTo(item.x + 8 * s, item.y - (6 - i * 5) * s);
            ctx.stroke();
        }
        if (item.isCheck) {
            ctx.strokeStyle = '#2c6b45';
            ctx.lineWidth = Math.max(1, Math.round(2 * s));
            ctx.beginPath();
            ctx.moveTo(item.x - 5 * s, item.y + 8 * s);
            ctx.lineTo(item.x - 1 * s, item.y + 12 * s);
            ctx.lineTo(item.x + 8 * s, item.y + 2 * s);
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawChatItem(ctx, item, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        ctx.save();
        ctx.globalAlpha = item.alpha;
        ctx.fillStyle = '#f4d28b';
        ctx.strokeStyle = '#50351e';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(item.x - 14 * s, item.y - 8 * s);
        ctx.lineTo(item.x + 14 * s, item.y - 8 * s);
        ctx.lineTo(item.x + 11 * s, item.y + 9 * s);
        ctx.lineTo(item.x - 11 * s, item.y + 9 * s);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = 'rgba(80, 53, 30, 0.65)';
        ctx.beginPath();
        ctx.moveTo(item.x - 13 * s, item.y - 7 * s);
        ctx.lineTo(item.x, item.y + 1 * s);
        ctx.lineTo(item.x + 13 * s, item.y - 7 * s);
        ctx.stroke();
        this._drawTinyLabel(ctx, item, item.x, item.y - 18 * s, s, '#ffeb8f');
        ctx.restore();
    }

    _drawTokenItem(ctx, item, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        const fill = Math.max(0.18, Math.min(1, item.ratio || Math.min(1, item.delta / 40000)));
        ctx.save();
        ctx.globalAlpha = item.alpha;
        if (this.sprites?.assets?.get('prop.oreCart')) {
            this.sprites.drawSprite(ctx, 'prop.oreCart', item.x, item.y);
        } else {
            ctx.fillStyle = '#5a3927';
            ctx.fillRect(Math.round(item.x - 15 * s), Math.round(item.y - 10 * s), Math.round(30 * s), Math.round(14 * s));
        }
        ctx.fillStyle = `rgba(242, 211, 107, ${0.28 + fill * 0.62})`;
        ctx.beginPath();
        ctx.ellipse(item.x, item.y - 15 * s, (10 + fill * 8) * s, (5 + fill * 3) * s, -0.15, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _drawCommandItem(ctx, item, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        const pulse = this.motionScale ? 0.65 + Math.sin(this.frame * 0.12 + item.slot) * 0.22 : 0.72;
        ctx.save();
        ctx.globalAlpha = item.alpha;
        ctx.strokeStyle = `rgba(246, 200, 95, ${pulse})`;
        ctx.fillStyle = 'rgba(87, 48, 25, 0.88)';
        ctx.lineWidth = Math.max(1, Math.round(2 * s));
        ctx.beginPath();
        ctx.ellipse(item.x, item.y, 20 * s, 9 * s, -0.22, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(item.x - 9 * s, item.y - 2 * s);
        ctx.lineTo(item.x, item.y - 11 * s);
        ctx.lineTo(item.x + 9 * s, item.y - 2 * s);
        ctx.stroke();
        this._drawTinyLabel(ctx, item, item.x, item.y - 22 * s, s, '#ffe7a3');
        ctx.restore();
    }

    _drawConnection(ctx, item, color, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        ctx.save();
        ctx.globalAlpha = item.alpha * 0.82;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, Math.round(2 * s));
        ctx.setLineDash([Math.max(3, 6 * s), Math.max(2, 4 * s)]);
        ctx.lineDashOffset = this.motionScale ? -this.frame * 0.55 : 0;
        ctx.beginPath();
        const mx = (item.startX + item.endX) / 2;
        const my = Math.min(item.startY, item.endY) - 24 * s;
        ctx.moveTo(item.startX, item.startY);
        ctx.quadraticCurveTo(mx, my, item.endX, item.endY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(item.endX, item.endY, 3 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _drawTinyLabel(ctx, item, x, y, s, color) {
        const label = String(item.label || '').toUpperCase();
        if (!label) return;
        ctx.font = `${Math.max(5, Math.round(6 * s))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        const width = Math.min(52 * s, Math.max(22 * s, ctx.measureText(label).width + 8 * s));
        ctx.fillStyle = 'rgba(38, 26, 16, 0.86)';
        ctx.fillRect(Math.round(x - width / 2), Math.round(y - 6 * s), Math.round(width), Math.round(11 * s));
        ctx.strokeStyle = color;
        ctx.strokeRect(Math.round(x - width / 2) + 0.5, Math.round(y - 6 * s) + 0.5, Math.round(width) - 1, Math.round(11 * s) - 1);
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label.slice(0, 8), Math.round(x), Math.round(y));
    }
}
