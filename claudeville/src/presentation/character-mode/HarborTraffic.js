import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';

const SHIP_SPRITE_ID = 'prop.harborBoat';
const MAX_VISIBLE_SHIPS = 8;
const DEPARTURE_MS = 14000;
const EXIT_HOLD_MS = 1200;
const HISTORICAL_EVENT_GRACE_MS = 5000;
const UNPAIRED_COMMIT_REPLAY_MS = 2 * 60 * 1000;

const BERTHS = [
    { tileX: 37.2, tileY: 14.6 },
    { tileX: 37.2, tileY: 16.2 },
    { tileX: 37.2, tileY: 18.2 },
    { tileX: 39.1, tileY: 15.6 },
    { tileX: 39.1, tileY: 17.5 },
    { tileX: 33.4, tileY: 19.5 },
    { tileX: 36.3, tileY: 21.4 },
    { tileX: 38.2, tileY: 21.3 },
];

const SEA_LANES = [
    { tileX: 43.5, tileY: 13.2 },
    { tileX: 45.0, tileY: 15.2 },
    { tileX: 44.2, tileY: 18.7 },
    { tileX: 42.8, tileY: 21.6 },
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

function cloneState(previous = {}) {
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

function eventAgeMs(event, now) {
    if (!Number.isFinite(event?.timestamp) || event.timestamp <= 0) return Infinity;
    return Math.max(0, now - event.timestamp);
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

function isHistoricalCommittedBeforePush(event, latestPushTimes) {
    const latestPush = latestPushTimes.get(event.project) || 0;
    return latestPush > 0 && Number.isFinite(event.timestamp) && event.timestamp <= latestPush;
}

function shouldIgnoreHistoricalCommit(event, latestPushTimes, now, staleReplayWindowMs) {
    if (isHistoricalCommittedBeforePush(event, latestPushTimes)) return true;
    if (eventAgeMs(event, now) <= staleReplayWindowMs) return false;
    return !latestPushTimes.has(event.project);
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
        label: event.label || event.message || event.subject || '',
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
    const staleReplayWindowMs = Number.isFinite(options.staleReplayWindowMs)
        ? Math.max(0, options.staleReplayWindowMs)
        : UNPAIRED_COMMIT_REPLAY_MS;

    const sorted = [...(events || [])]
        .filter(event => event?.id && event?.type && event?.project)
        .sort((a, b) => (a.timestamp - b.timestamp) || a.id.localeCompare(b.id));
    const latestPushTimes = latestPushTimesByProject(sorted);

    for (const event of sorted) {
        if (state.seenEventIds.has(event.id)) continue;
        state.seenEventIds.add(event.id);

        if (event.type === 'commit') {
            if (shouldIgnoreHistoricalCommit(event, latestPushTimes, now, staleReplayWindowMs)) continue;
            const berthIndex = state.nextSequence % BERTHS.length;
            const laneIndex = stableHash(`${event.project}:${event.id}`) % SEA_LANES.length;
            state.nextSequence++;
            state.ships.set(event.id, {
                id: event.id,
                project: event.project,
                sha: event.sha,
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
            const end = toWorld(lane.tileX, lane.tileY);
            const startedAt = ship.departStartedAt || now;
            progress = this.motionScale === 0 ? 1 : Math.max(0, Math.min(1, (now - startedAt) / DEPARTURE_MS));
            const eased = easedDeparture(progress);
            x = start.x + (end.x - start.x) * eased;
            y = start.y + (end.y - start.y) * eased;
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
                progress,
            },
        };
    }

    _drawShip(ctx, ship, zoom) {
        const alpha = ship.status === 'departing'
            ? Math.max(0, Math.min(1, 1 - Math.max(0, ship.progress - 0.82) / 0.18))
            : 1;
        if (alpha <= 0.02) return;

        if (ship.status === 'departing' && this.motionScale > 0 && ship.progress < 0.92) {
            this._drawWake(ctx, ship);
        }

        if (this.sprites) {
            this.sprites.drawSprite(ctx, SHIP_SPRITE_ID, ship.x, ship.y, { alpha });
        } else {
            this._drawFallbackBoat(ctx, ship.x, ship.y, alpha);
        }

        if (ship.status === 'docked') {
            this._drawMooringTick(ctx, ship, zoom);
        }
    }

    _drawWake(ctx, ship) {
        const phase = this.frame * 0.18 + ship.berthIndex;
        ctx.save();
        ctx.globalAlpha = Math.max(0.12, 0.34 * (1 - ship.progress));
        ctx.strokeStyle = 'rgba(198, 236, 241, 0.7)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
            const offset = i * 8 + Math.sin(phase + i) * 2;
            ctx.beginPath();
            ctx.moveTo(ship.x - 18 - offset, ship.y + 8 + i * 3);
            ctx.quadraticCurveTo(ship.x - 28 - offset, ship.y + 4 + i * 2, ship.x - 38 - offset, ship.y + 11 + i);
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
