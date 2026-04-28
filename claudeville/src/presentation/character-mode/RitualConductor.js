import { eventBus } from '../../domain/events/DomainEvent.js';
import { TILE_HEIGHT, TILE_WIDTH } from '../../config/constants.js';

const MAX_CONCURRENT_RITUALS = 6;
const COALESCE_WINDOW_MS = 250;
const DEFAULT_DURATION_MS = 1400;

const RITUAL_META = {
    forge: { kind: 'forge-strike', durationMs: 1500, pulseBand: 'medium' },
    archive: { kind: 'archive-page', durationMs: 1800, pulseBand: 'medium' },
    mine: { kind: 'mine-pick', durationMs: 1500, pulseBand: 'medium' },
    observatory: { kind: 'observatory-sweep', durationMs: 1900, pulseBand: 'slow' },
    portal: { kind: 'portal-mirror', durationMs: 2600, pulseBand: 'medium' },
    taskboard: { kind: 'task-paper', durationMs: 2600, pulseBand: 'fast' },
    command: { kind: 'command-signal', durationMs: 2600, pulseBand: 'static' },
    harbor: { kind: 'harbor-crate', durationMs: 30000, pulseBand: 'static' },
    watchtower: { kind: 'watchtower-flare', durationMs: 1800, pulseBand: 'slow' },
};

function compactText(value, fallback = '') {
    const text = String(value || fallback || '').replace(/\s+/g, ' ').trim();
    if (!text) return fallback;
    const lastSlash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    const base = (lastSlash >= 0 ? text.slice(lastSlash + 1) : text).split(/[?#\s]/)[0] || text;
    return base.length > 14 ? `${base.slice(0, 11)}...` : base;
}

function tryParseInput(input) {
    if (!input || typeof input !== 'string') return input;
    const text = input.trim();
    if (!/^[\[{]/.test(text)) return input;
    try {
        return JSON.parse(text);
    } catch {
        return input;
    }
}

function inputText(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    try {
        return JSON.stringify(input);
    } catch {
        return String(input);
    }
}

function extractHost(input) {
    const parsed = tryParseInput(input);
    const candidates = [];
    const collect = (value) => {
        if (!value) return;
        if (typeof value === 'string') {
            candidates.push(value);
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(collect);
            return;
        }
        if (typeof value === 'object') {
            ['url', 'uri', 'href', 'target', 'query', 'command', 'arguments', 'input'].forEach((key) => collect(value[key]));
        }
    };
    collect(parsed);
    for (const value of candidates) {
        const text = String(value || '');
        const match = text.match(/https?:\/\/[^\s"'<>]+/i);
        if (!match) continue;
        try {
            return new URL(match[0]).hostname.replace(/^www\./, '');
        } catch {
            // Keep looking.
        }
    }
    return '';
}

function hashText(value) {
    const text = String(value || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return Math.abs(hash);
}

function stableIdentityValue(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > 64 ? text.slice(0, 64) : text;
}

function taskItemCompleted(item) {
    if (!item || typeof item !== 'object') return false;
    const status = String(item.status || item.state || item.lifecycle || '').toLowerCase();
    return status === 'completed' || status === 'complete' || status === 'done'
        || item.completed === true || item.done === true || item.checked === true;
}

function taskIdentityFromItem(item) {
    if (item == null) return '';
    if (typeof item !== 'object') return stableIdentityValue(item);
    const idKeys = ['id', 'taskId', 'task_id', 'todoId', 'todo_id', 'itemId', 'item_id', 'key'];
    for (const key of idKeys) {
        const value = stableIdentityValue(item[key]);
        if (value) return `id:${value}`;
    }
    const textKeys = ['title', 'content', 'task', 'todo', 'description', 'name'];
    for (const key of textKeys) {
        const value = stableIdentityValue(item[key]);
        if (value) return `text:${value.toLowerCase()}`;
    }
    return '';
}

function extractTaskKey(input, { preferCompleted = false } = {}) {
    const parsed = tryParseInput(input);
    if (parsed && typeof parsed === 'object') {
        const direct = taskIdentityFromItem(parsed);
        if (direct) return direct;
    }

    const findInValue = (value) => {
        if (!value || typeof value !== 'object') return '';
        if (Array.isArray(value)) {
            const preferred = value.find(item => preferCompleted ? taskItemCompleted(item) : !taskItemCompleted(item));
            return taskIdentityFromItem(preferred || value[0]);
        }
        for (const key of ['todos', 'tasks', 'items', 'checklist', 'subtasks']) {
            if (Array.isArray(value[key])) {
                const keyFromList = findInValue(value[key]);
                if (keyFromList) return keyFromList;
            }
        }
        for (const child of Object.values(value)) {
            if (child && typeof child === 'object') {
                const nested = findInValue(child);
                if (nested) return nested;
            }
        }
        return '';
    };
    if (parsed && typeof parsed === 'object') {
        const nested = findInValue(parsed);
        if (nested) return nested;
    }

    const text = inputText(input);
    const idMatch = text.match(/(?:(?:task|todo|item)[_-]?id|(?:^|["'\s])id)["']?\s*[:=]\s*["']?([A-Za-z0-9_.:-]+)/i);
    if (idMatch?.[1]) return `id:${stableIdentityValue(idMatch[1])}`;
    return '';
}

function ritualMetaFor(event) {
    const building = event?.building;
    const base = RITUAL_META[building];
    if (!base) return null;
    const tool = String(event.tool || '');
    const input = event.input;
    const text = inputText(input);
    const host = extractHost(input);
    const isCompletedTask = /status['"]?\s*[:=]\s*['"]?completed\b/i.test(text) || /\bcompleted\b/i.test(text);
    const label = host ? compactText(host, host) : compactText(input, tool);
    if (tool === '__token_delta') {
        return { ...RITUAL_META.mine, kind: 'mine-pick', label: `+${Number(input) || 0}` };
    }
    if (building === 'taskboard') {
        return {
            ...base,
            action: isCompletedTask ? 'complete' : 'pin',
            taskKey: extractTaskKey(input, { preferCompleted: isCompletedTask }) || null,
            label: compactText(tool, 'TASK'),
        };
    }
    if (building === 'command') {
        const action = tool === 'SendMessage' ? 'message' : tool === 'TeamCreate' ? 'team' : 'command';
        return { ...base, action, label: compactText(tool, 'CMD') };
    }
    if (building === 'observatory') {
        return {
            ...base,
            label: host ? compactText(host, host) : compactText(input, 'SEARCH'),
            angle: ((hashText(host || text || tool) % 220) - 160) * Math.PI / 180,
        };
    }
    if (building === 'portal') {
        return { ...base, label: host ? compactText(host, host) : compactText(tool.replace(/^mcp__|^functions\./, ''), 'PORTAL') };
    }
    return { ...base, label };
}

function screenToTile(x, y) {
    return {
        tileX: (x / (TILE_WIDTH / 2) + y / (TILE_HEIGHT / 2)) / 2,
        tileY: (y / (TILE_HEIGHT / 2) - x / (TILE_WIDTH / 2)) / 2,
    };
}

function agentTile(agent) {
    if (!agent?.position) return null;
    const tileX = Number(agent.position.tileX);
    const tileY = Number(agent.position.tileY);
    if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return null;
    return { tileX, tileY };
}

function spriteTile(sprite) {
    const x = Number(sprite?.x);
    const y = Number(sprite?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (typeof sprite._screenToTile === 'function') return sprite._screenToTile(x, y);
    return screenToTile(x, y);
}

function buildingContainsTile(building, tile) {
    if (!building || !tile) return false;
    if (typeof building.containsPoint === 'function' && building.containsPoint(tile.tileX, tile.tileY)) return true;
    if (typeof building.containsVisitPoint === 'function' && building.containsVisitPoint(tile.tileX, tile.tileY)) return true;
    const visitTile = typeof building.primaryVisitTile === 'function' ? building.primaryVisitTile() : null;
    if (visitTile) return Math.hypot(visitTile.tileX - tile.tileX, visitTile.tileY - tile.tileY) <= 0.85;
    return false;
}

export class RitualConductor {
    constructor({ motionScale = 1 } = {}) {
        this.motionScale = motionScale;
        this.context = {
            world: null,
            agentSprites: null,
            isAgentVisible: null,
        };
        this.rituals = [];
        this.unsubscribers = [
            eventBus.on('tool:invoked', (event) => this.enqueue(event)),
        ];
    }

    dispose() {
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        this.unsubscribers = [];
        this.rituals = [];
        this.context = { world: null, agentSprites: null, isAgentVisible: null };
    }

    setMotionScale(scale) {
        this.motionScale = Number.isFinite(scale) ? scale : 1;
    }

    setContext({ world, agentSprites, isAgentVisible } = {}) {
        if (world !== undefined) this.context.world = world || null;
        if (agentSprites !== undefined) this.context.agentSprites = agentSprites || null;
        if (isAgentVisible !== undefined) {
            this.context.isAgentVisible = typeof isAgentVisible === 'function' ? isAgentVisible : null;
        }
    }

    canAccept(event) {
        if (!event?.agentId || !event?.building) return false;
        const { world, agentSprites, isAgentVisible } = this.context;
        const hasWorld = !!world?.agents?.get;
        const hasBuildings = !!world?.buildings?.get;
        const hasSprites = !!agentSprites?.get;
        const agent = hasWorld ? world.agents.get(event.agentId) : null;
        const sprite = hasSprites ? agentSprites.get(event.agentId) : null;
        const building = hasBuildings ? world.buildings.get(event.building) : null;

        if (hasWorld && !agent) return false;
        if (hasBuildings && !building) return false;
        if (hasSprites && !sprite) return false;
        if (typeof isAgentVisible === 'function' && !isAgentVisible(event.agentId)) return false;
        if (sprite?.isArrivalPending?.()) return false;

        if (!building) return true;
        if (sprite) return buildingContainsTile(building, spriteTile(sprite));
        if (agent && typeof building.isAgentVisiting === 'function') return building.isAgentVisiting(agent);
        return buildingContainsTile(building, agentTile(agent));
    }

    enqueue(event) {
        if (!event?.tool || !event?.building) return null;
        const meta = ritualMetaFor(event);
        if (!meta) return null;
        if (!this.canAccept(event)) return null;
        const now = event.ts || Date.now();
        const existing = this.rituals.find(ritual => (
            ritual.building === event.building
            && ritual.kind === meta.kind
            && ritual.tool === event.tool
            && now - ritual.createdAt <= COALESCE_WINDOW_MS
        ));
        if (existing) {
            existing.count += 1;
            existing.createdAt = now;
            existing.remainingMs = Math.max(existing.remainingMs, meta.durationMs || DEFAULT_DURATION_MS);
            existing.label = meta.label || existing.label;
            return existing;
        }

        if (this.rituals.length >= MAX_CONCURRENT_RITUALS) {
            this.rituals.sort((a, b) => a.createdAt - b.createdAt);
            this.rituals.shift();
        }

        const ritual = {
            id: `${event.agentId}:${event.tool}:${now}`,
            agentId: event.agentId,
            tool: event.tool,
            input: event.input || null,
            building: event.building,
            kind: meta.kind,
            action: meta.action || null,
            taskKey: meta.taskKey || null,
            label: meta.label || '',
            angle: meta.angle || 0,
            pulseBand: meta.pulseBand || 'static',
            phase: 'pending',
            count: 1,
            createdAt: now,
            elapsedMs: 0,
            durationMs: meta.durationMs || DEFAULT_DURATION_MS,
            remainingMs: meta.durationMs || DEFAULT_DURATION_MS,
            motionEnabled: this.motionScale > 0,
        };
        this.rituals.push(ritual);
        return ritual;
    }

    update(dt = 16) {
        const delta = Math.max(0, Number(dt) || 0);
        for (const ritual of this.rituals) {
            ritual.motionEnabled = this.motionScale > 0;
            ritual.elapsedMs += delta;
            ritual.remainingMs -= delta;
            if (ritual.elapsedMs >= 180 && ritual.phase === 'pending') ritual.phase = 'playing';
            if (ritual.remainingMs <= 280 && ritual.phase !== 'done') ritual.phase = 'fading';
            if (ritual.remainingMs <= 0) ritual.phase = 'done';
        }
        this.rituals = this.rituals.filter(ritual => ritual.phase !== 'done');
    }

    getActiveRitualsForBuilding(type) {
        return this.rituals.filter(ritual => ritual.building === type);
    }

    getSnapshot() {
        return this.rituals.map(ritual => ({ ...ritual }));
    }
}

export { MAX_CONCURRENT_RITUALS };
