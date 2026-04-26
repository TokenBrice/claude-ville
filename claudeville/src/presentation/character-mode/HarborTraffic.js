import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';

const SHIP_SPRITE_ID = 'prop.harborBoat';
const MAX_VISIBLE_SHIPS = 8;
const DEPARTURE_MS = 24000;
const EXIT_HOLD_MS = 1200;
const HISTORICAL_EVENT_GRACE_MS = 5000;
const MAX_LABEL_CHARS = 30;

const BERTHS = [
    { tileX: 38.2, tileY: 21.3 },
    { tileX: 36.3, tileY: 21.4 },
    { tileX: 39.1, tileY: 17.5 },
    { tileX: 39.1, tileY: 15.6 },
    { tileX: 37.2, tileY: 18.2 },
    { tileX: 37.2, tileY: 16.2 },
    { tileX: 37.2, tileY: 14.6 },
    { tileX: 33.4, tileY: 19.5 },
];

const SEA_LANES = [
    [
        { tileX: 38.6, tileY: 20.7 },
        { tileX: 39.0, tileY: 18.1 },
        { tileX: 39.0, tileY: 15.4 },
        { tileX: 38.4, tileY: 12.8 },
    ],
    [
        { tileX: 39.0, tileY: 19.6 },
        { tileX: 38.8, tileY: 17.3 },
        { tileX: 38.4, tileY: 14.7 },
        { tileX: 37.9, tileY: 12.3 },
    ],
    [
        { tileX: 38.2, tileY: 19.1 },
        { tileX: 38.8, tileY: 16.8 },
        { tileX: 38.3, tileY: 14.2 },
        { tileX: 37.7, tileY: 11.9 },
    ],
    [
        { tileX: 37.8, tileY: 20.4 },
        { tileX: 38.7, tileY: 18.2 },
        { tileX: 39.0, tileY: 15.8 },
        { tileX: 38.3, tileY: 13.3 },
    ],
];

function toWorld(tileX, tileY) {
    return {
        x: (tileX - tileY) * TILE_WIDTH / 2,
        y: (tileX + tileY) * TILE_HEIGHT / 2,
    };
}

function parseTime(value, fallback = 0) {
    if (Number.isFinite(Number(value))) return Number(value);
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

function stableHash(input) {
    const text = String(input || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

function shortenLabel(value, maxChars = MAX_LABEL_CHARS) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function stripShellQuotes(value = '') {
    const text = String(value).trim();
    if (text.length >= 2) {
        const first = text[0];
        const last = text[text.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return text.slice(1, -1);
        }
    }
    return text;
}

function commitMessageFromCommand(command) {
    const text = String(command || '');
    const match = text.match(/(?:^|\s)(?:-m|--message)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
    if (!match) return '';
    return stripShellQuotes(match[1] || match[2] || match[3] || '');
}

function eventLabel(event, type, sha) {
    const explicit = event.label || event.message || event.subject || event.title || '';
    if (explicit) return shortenLabel(explicit);
    if (type === 'commit') {
        const commandLabel = commitMessageFromCommand(event.command);
        if (commandLabel) return shortenLabel(commandLabel);
    }
    if (sha) return shortenLabel(sha.slice(0, 10));
    return shortenLabel(event.commandHash || event.id || type);
}

function cloneState(previous = {}) {
    previous = previous || {};
    const seenEventIds = previous.seenEventIds instanceof Set
        ? new Set(previous.seenEventIds)
        : new Set(previous.seenEventIds || []);
    const sourceShips = previous.ships instanceof Map
        ? previous.ships.entries()
        : Object.entries(previous.ships || {});
    const ships = new Map();
    for (const [id, ship] of sourceShips) {
        ships.set(id, { ...ship });
    }
    return {
        seenEventIds,
        ships,
        nextSequence: Number.isFinite(previous.nextSequence) ? previous.nextSequence : ships.size,
    };
}

function latestPushTimesByProject(events) {
    const latest = new Map();
    for (const event of events) {
        if (event?.type !== 'push' || !event.project || !Number.isFinite(event.timestamp) || event.timestamp <= 0) continue;
        const previous = latest.get(event.project) || 0;
        if (event.timestamp > previous) latest.set(event.project, event.timestamp);
    }
    return latest;
}

function pointAlongPath(points, progress) {
    if (!Array.isArray(points) || points.length === 0) return { x: 0, y: 0 };
    if (points.length === 1) return points[0];

    const lengths = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        lengths.push(length);
        total += length;
    }
    if (total <= 0) return points[points.length - 1];

    let remaining = Math.max(0, Math.min(1, progress)) * total;
    for (let i = 1; i < points.length; i++) {
        const length = lengths[i - 1];
        if (remaining <= length || i === points.length - 1) {
            const a = points[i - 1];
            const b = points[i];
            const t = length <= 0 ? 1 : remaining / length;
            return {
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
            };
        }
        remaining -= length;
    }

    return points[points.length - 1];
}

function isHistoricalCommittedBeforePush(event, latestPushTimes, now) {
    const latestPush = latestPushTimes.get(event.project) || 0;
    if (!latestPush || !Number.isFinite(event.timestamp) || event.timestamp > latestPush) return false;
    return Math.max(0, now - latestPush) > HISTORICAL_EVENT_GRACE_MS;
}

export function snapshotHarborTrafficState(state) {
    const cloned = cloneState(state);
    return {
        nextSequence: cloned.nextSequence,
        seenEventIds: [...cloned.seenEventIds].sort(),
        ships: [...cloned.ships.values()]
            .map(ship => ({
                id: ship.id,
                project: ship.project,
                sha: ship.sha || '',
                label: ship.label || '',
                status: ship.status,
                berthIndex: ship.berthIndex,
                laneIndex: ship.laneIndex,
                eventTime: ship.eventTime,
                departEventId: ship.departEventId || null,
                departStartedAt: ship.departStartedAt || null,
            }))
            .sort((a, b) => (a.eventTime - b.eventTime) || a.id.localeCompare(b.id)),
    };
}

function eventKind(event) {
    const raw = String(event?.type || event?.kind || event?.action || event?.event || event?.name || '').toLowerCase();
    if (raw.includes('push')) return 'push';
    if (raw.includes('commit')) return 'commit';
    if (event?.pushed === true || Array.isArray(event?.commits)) return 'push';
    if (event?.sha || event?.commit || event?.hash) return 'commit';
    return null;
}

export function normalizeGitEvent(event, agent = {}, index = 0) {
    if (!event || typeof event !== 'object') return null;

    const type = eventKind(event);
    if (!type) return null;

    const project = event.project
        || event.projectPath
        || event.repository
        || event.repo
        || event.workspace
        || agent.projectPath
        || agent.teamName
        || agent.project
        || 'unknown';
    const sha = event.sha || event.commit || event.hash || event.commitSha || event.revision || '';
    const timestamp = parseTime(
        event.timestamp || event.time || event.ts || event.date || event.createdAt || event.created_at,
        parseTime(agent.lastSessionActivity, 0)
    );
    const id = event.id
        || event.eventId
        || event.uuid
        || event.key
        || `${type}:${project}:${sha}:${timestamp}:${index}`;

    return {
        id: String(id),
        type,
        project: String(project),
        sha: sha ? String(sha) : '',
        timestamp,
        label: eventLabel(event, type, sha),
    };
}

export function collectGitEventsFromAgents(agents) {
    const events = [];
    for (const agent of agents || []) {
        const sources = [
            agent?.gitEvents,
            agent?.git?.events,
            agent?.vcsEvents,
        ].filter(Array.isArray);
        for (const source of sources) {
            source.forEach((event, index) => {
                const normalized = normalizeGitEvent(event, agent, index);
                if (normalized) events.push(normalized);
            });
        }
    }
    events.sort((a, b) => (a.timestamp - b.timestamp) || a.id.localeCompare(b.id));
    return events;
}

export function reduceHarborTrafficState(previous, events, options = {}) {
    const state = cloneState(previous);
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const motionScale = options.motionScale === 0 ? 0 : 1;

    const sorted = [...(events || [])]
        .filter(event => event?.id && event?.type && event?.project)
        .sort((a, b) => (a.timestamp - b.timestamp) || a.id.localeCompare(b.id));
    const latestPushTimes = latestPushTimesByProject(sorted);

    for (const event of sorted) {
        if (state.seenEventIds.has(event.id)) continue;
        state.seenEventIds.add(event.id);

        if (event.type === 'commit') {
            if (isHistoricalCommittedBeforePush(event, latestPushTimes, now)) continue;
            const berthIndex = state.nextSequence % BERTHS.length;
            const laneIndex = stableHash(`${event.project}:${event.id}`) % SEA_LANES.length;
            state.nextSequence++;
            state.ships.set(event.id, {
                id: event.id,
                project: event.project,
                sha: event.sha,
                label: event.label,
                status: 'docked',
                berthIndex,
                laneIndex,
                eventTime: event.timestamp || now,
                createdAt: now,
            });
            continue;
        }

        if (event.type === 'push') {
            const eventAge = Number.isFinite(event.timestamp) && event.timestamp > 0
                ? Math.max(0, now - event.timestamp)
                : 0;
            const skipDepartureAnimation = motionScale === 0 || eventAge > HISTORICAL_EVENT_GRACE_MS;
            const pushTime = Number.isFinite(event.timestamp) && event.timestamp > 0 ? event.timestamp : 0;
            for (const ship of state.ships.values()) {
                if (ship.project !== event.project || ship.status !== 'docked') continue;
                if (pushTime > 0 && Number.isFinite(ship.eventTime) && ship.eventTime > pushTime) continue;
                ship.status = 'departing';
                ship.departEventId = event.id;
                ship.departStartedAt = skipDepartureAnimation
                    ? now - DEPARTURE_MS - EXIT_HOLD_MS - 1
                    : now;
                ship.departEventTime = event.timestamp || now;
            }
        }
    }

    for (const [id, ship] of state.ships) {
        if (ship.status !== 'departing') continue;
        const startedAt = ship.departStartedAt || now;
        const progress = motionScale === 0 ? 1 : Math.max(0, Math.min(1, (now - startedAt) / DEPARTURE_MS));
        if (progress >= 1 && now - startedAt > DEPARTURE_MS + EXIT_HOLD_MS) {
            state.ships.delete(id);
        }
    }

    return state;
}

function easedDeparture(progress) {
    const t = Math.max(0, Math.min(1, progress));
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export class HarborTraffic {
    constructor({ sprites } = {}) {
        this.sprites = sprites || null;
        this.state = cloneState();
        this.motionScale = 1;
        this.frame = 0;
    }

    setMotionScale(scale) {
        this.motionScale = scale === 0 ? 0 : 1;
    }

    update(agents, dt = 16, now = Date.now()) {
        this.frame += (dt / 16) * this.motionScale;
        const events = collectGitEventsFromAgents(agents);
        this.state = reduceHarborTrafficState(this.state, events, {
            now,
            motionScale: this.motionScale,
        });
    }

    enumerateDrawables(now = Date.now()) {
        const candidates = [];
        for (const ship of this.state.ships.values()) {
            const drawable = this._shipDrawable(ship, now);
            if (drawable) candidates.push(drawable);
        }

        candidates.sort((a, b) => {
            if (a.payload.status !== b.payload.status) {
                return a.payload.status === 'departing' ? 1 : -1;
            }
            return (a.payload.eventTime - b.payload.eventTime) || a.payload.id.localeCompare(b.payload.id);
        });

        const visible = candidates.slice(-MAX_VISIBLE_SHIPS);
        const hiddenCount = candidates.length - visible.length;
        if (hiddenCount > 0) {
            const berth = BERTHS[(this.state.nextSequence + 1) % BERTHS.length];
            const pos = toWorld(berth.tileX, berth.tileY);
            visible.push({
                kind: 'harbor-traffic',
                sortY: pos.y + 2,
                payload: {
                    type: 'cluster',
                    count: hiddenCount,
                    x: pos.x,
                    y: pos.y,
                },
            });
        }

        return visible.sort((a, b) => a.sortY - b.sortY);
    }

    draw(ctx, drawable, zoom = 1) {
        if (!drawable?.payload) return;
        if (drawable.payload.type === 'cluster') {
            this._drawClusterTag(ctx, drawable.payload, zoom);
            return;
        }
        this._drawShip(ctx, drawable.payload, zoom);
    }

    _shipDrawable(ship, now) {
        const berth = BERTHS[ship.berthIndex % BERTHS.length];
        const start = toWorld(berth.tileX, berth.tileY);
        let x = start.x;
        let y = start.y;
        let progress = 0;

        if (ship.status === 'departing') {
            const lane = SEA_LANES[ship.laneIndex % SEA_LANES.length];
            const route = [
                start,
                ...lane.map(point => toWorld(point.tileX, point.tileY)),
            ];
            const startedAt = ship.departStartedAt || now;
            progress = this.motionScale === 0 ? 1 : Math.max(0, Math.min(1, (now - startedAt) / DEPARTURE_MS));
            const eased = easedDeparture(progress);
            const pos = pointAlongPath(route, eased);
            const previous = pointAlongPath(route, Math.max(0, eased - 0.035));
            x = pos.x;
            y = pos.y;
            ship.tailX = previous.x;
            ship.tailY = previous.y;
            if (progress >= 1 && this.motionScale === 0) return null;
        }

        return {
            kind: 'harbor-traffic',
            sortY: y,
            payload: {
                ...ship,
                type: 'ship',
                x,
                y,
                tailX: ship.tailX,
                tailY: ship.tailY,
                progress,
            },
        };
    }

    _drawShip(ctx, ship, zoom) {
        const alpha = ship.status === 'departing'
            ? Math.max(0, Math.min(1, 1 - Math.max(0, ship.progress - 0.82) / 0.18))
            : 1;
        if (alpha <= 0.02) return;

        if (ship.status === 'docked') {
            this._drawDockedShipWake(ctx, ship, zoom);
        }

        if (ship.status === 'departing' && this.motionScale > 0 && ship.progress < 0.94) {
            this._drawWake(ctx, ship, alpha);
        }

        if (this.sprites) {
            this.sprites.drawSprite(ctx, SHIP_SPRITE_ID, ship.x, ship.y, { alpha });
        } else {
            this._drawFallbackBoat(ctx, ship.x, ship.y, alpha);
        }

        if (ship.status === 'docked') {
            this._drawMooringTick(ctx, ship, zoom);
        }
        this._drawCommitPennant(ctx, ship, zoom, alpha);
    }

    _drawDockedShipWake(ctx, ship, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        const pulse = this.motionScale > 0
            ? 0.55 + 0.25 * Math.sin(this.frame * 0.08 + ship.berthIndex)
            : 0.62;
        ctx.save();
        ctx.globalAlpha = pulse;
        ctx.strokeStyle = 'rgba(249, 214, 105, 0.72)';
        ctx.lineWidth = Math.max(1, Math.round(2 * s));
        ctx.beginPath();
        ctx.ellipse(Math.round(ship.x), Math.round(ship.y + 4 * s), 30 * s, 16 * s, -0.18, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = 'rgba(255, 232, 132, 0.16)';
        ctx.beginPath();
        ctx.ellipse(Math.round(ship.x), Math.round(ship.y + 5 * s), 26 * s, 13 * s, -0.18, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _drawWake(ctx, ship, alpha = 1) {
        const phase = this.frame * 0.18 + ship.berthIndex;
        const dx = ship.x - (ship.tailX ?? ship.x - 1);
        const dy = ship.y - (ship.tailY ?? ship.y);
        const length = Math.hypot(dx, dy) || 1;
        const ux = dx / length;
        const uy = dy / length;
        const px = -uy;
        const py = ux;
        ctx.save();
        ctx.globalAlpha = Math.max(0.12, 0.34 * (1 - ship.progress)) * alpha;
        ctx.strokeStyle = 'rgba(198, 236, 241, 0.7)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
            const offset = i * 8 + Math.sin(phase + i) * 2;
            const spread = 4 + i * 2;
            const startBack = 14 + offset;
            const endBack = 30 + offset;
            ctx.beginPath();
            ctx.moveTo(ship.x - ux * startBack + px * spread, ship.y - uy * startBack + py * spread);
            ctx.quadraticCurveTo(
                ship.x - ux * ((startBack + endBack) / 2) + px * Math.sin(phase + i) * 3,
                ship.y - uy * ((startBack + endBack) / 2) + py * Math.sin(phase + i) * 3,
                ship.x - ux * endBack - px * spread,
                ship.y - uy * endBack - py * spread
            );
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawMooringTick(ctx, ship, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        ctx.save();
        ctx.fillStyle = 'rgba(251, 224, 141, 0.82)';
        ctx.fillRect(Math.round(ship.x + 17 * s), Math.round(ship.y - 23 * s), Math.max(1, Math.round(2 * s)), Math.max(1, Math.round(5 * s)));
        ctx.restore();
    }

    _drawCommitPennant(ctx, ship, zoom, alpha = 1) {
        const s = 1 / Math.max(1, zoom || 1);
        const label = shortenLabel(ship.label || ship.sha || ship.id, MAX_LABEL_CHARS);
        const textSize = Math.max(7, Math.round(8 * s));
        const width = Math.max(42 * s, Math.min(142 * s, label.length * textSize * 0.62 + 12 * s));
        const x = Math.round(ship.x - width / 2);
        const y = Math.round(ship.y - 44 * s);
        const height = 12 * s;
        ctx.save();
        ctx.globalAlpha = 0.94 * alpha;
        ctx.fillStyle = 'rgba(24, 42, 39, 0.9)';
        ctx.fillRect(x, y, Math.round(width), Math.round(height));
        ctx.strokeStyle = 'rgba(246, 207, 96, 0.9)';
        ctx.strokeRect(x + 0.5, y + 0.5, Math.round(width) - 1, Math.round(height) - 1);
        ctx.fillStyle = '#f6cf60';
        ctx.font = `${textSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, Math.round(ship.x), Math.round(y + height / 2 + 0.5));
        ctx.fillStyle = 'rgba(108, 219, 148, 0.9)';
        ctx.fillRect(Math.round(ship.x - 22 * s), Math.round(ship.y - 31 * s), Math.max(1, Math.round(3 * s)), Math.max(1, Math.round(11 * s)));
        ctx.restore();
    }

    _drawClusterTag(ctx, payload, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        const label = `+${payload.count}`;
        const width = Math.max(18, label.length * 6 + 8) * s;
        const height = 13 * s;
        const x = payload.x - width / 2;
        const y = payload.y - 34 * s;

        ctx.save();
        ctx.fillStyle = 'rgba(27, 43, 48, 0.86)';
        ctx.fillRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height));
        ctx.strokeStyle = 'rgba(242, 211, 107, 0.82)';
        ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(width) - 1, Math.round(height) - 1);
        ctx.fillStyle = '#f2d36b';
        ctx.font = `${Math.max(8, Math.round(10 * s))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, Math.round(payload.x), Math.round(y + height / 2));
        ctx.restore();
    }

    _drawFallbackBoat(ctx, x, y, alpha) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#6a3f2a';
        ctx.beginPath();
        ctx.moveTo(x - 20, y + 5);
        ctx.lineTo(x + 17, y - 4);
        ctx.lineTo(x + 10, y + 10);
        ctx.lineTo(x - 13, y + 14);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#d9c99a';
        ctx.fillRect(Math.round(x - 3), Math.round(y - 23), 3, 22);
        ctx.fillStyle = '#9fb9b5';
        ctx.beginPath();
        ctx.moveTo(x, y - 22);
        ctx.lineTo(x + 13, y - 9);
        ctx.lineTo(x + 1, y - 7);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }
}
