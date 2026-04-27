import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { Settings } from '../../application/Settings.js';

const MAX_LABEL_CHARS = 34;
const RECENT_DROP_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PINNED_MS = 7 * DAY_MS;

const PIER_SLOTS = [
    { tileX: 32.4, tileY: 22.7 }, { tileX: 33.1, tileY: 23.0 }, { tileX: 33.8, tileY: 23.3 },
    { tileX: 34.5, tileY: 23.1 }, { tileX: 35.2, tileY: 22.9 }, { tileX: 35.9, tileY: 23.2 },
    { tileX: 36.6, tileY: 22.8 }, { tileX: 37.2, tileY: 22.4 }, { tileX: 32.9, tileY: 23.7 },
    { tileX: 33.7, tileY: 24.0 }, { tileX: 34.5, tileY: 24.2 }, { tileX: 35.3, tileY: 23.9 },
    { tileX: 36.1, tileY: 23.6 }, { tileX: 36.9, tileY: 23.3 }, { tileX: 37.5, tileY: 22.9 },
];

function toWorld(tileX, tileY) {
    return {
        x: (tileX - tileY) * TILE_WIDTH / 2,
        y: (tileX + tileY) * TILE_HEIGHT / 2,
    };
}

function shortText(value, maxChars = MAX_LABEL_CHARS) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1))}...`;
}

function commitMessageFromCommand(command) {
    const text = String(command || '');
    const match = text.match(/(?:^|\s)(?:-m|--message)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
    return String(match?.[1] || match?.[2] || match?.[3] || '').trim();
}

function eventTimestamp(event, fallback = Date.now()) {
    const raw = event?.ts ?? event?.timestamp ?? event?.time ?? event?.createdAt ?? event?.completedAt;
    if (Number.isFinite(Number(raw))) return Number(raw);
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function stableNumber(input) {
    const text = String(input || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return Math.abs(hash);
}

function projectName(project) {
    const parts = String(project || 'unknown').split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || 'unknown';
}

function normalizeGitEvent(event, agent = {}, index = 0) {
    if (!event || typeof event !== 'object') return null;
    const type = String(event.type || event.kind || '').toLowerCase();
    if (type !== 'commit') return null;
    const project = event.project || event.projectPath || event.repository || event.repo || agent.project || 'unknown';
    const ts = eventTimestamp(event, eventTimestamp(agent, Date.now()));
    const label = event.label || event.subject || event.message || commitMessageFromCommand(event.command) || event.sha || 'commit';
    const id = String(event.id || event.eventId || `${type}:${project}:${event.sha || event.commandHash || label}:${ts}:${index}`);
    return {
        id,
        type,
        project: String(project),
        repoName: projectName(project),
        sha: String(event.sha || event.commit || event.hash || ''),
        command: String(event.command || ''),
        label: shortText(label),
        provider: event.provider || agent.provider || '',
        sessionId: event.sessionId || agent.sessionId || agent.id || '',
        sourceId: event.sourceId || '',
        ts,
        success: typeof event.success === 'boolean' ? event.success : null,
        exitCode: Number.isFinite(Number(event.exitCode)) ? Number(event.exitCode) : null,
    };
}

function collectCommitEvents(agents) {
    const events = [];
    for (const agent of agents || []) {
        const sources = [agent?.gitEvents, agent?.git?.events, agent?.vcsEvents].filter(Array.isArray);
        for (const source of sources) {
            source.forEach((event, index) => {
                const normalized = normalizeGitEvent(event, agent, index);
                if (normalized) events.push(normalized);
            });
        }
    }
    events.sort((a, b) => (a.ts - b.ts) || a.id.localeCompare(b.id));
    return events;
}

function plankFromEvent(event) {
    const slot = PIER_SLOTS[stableNumber(event.id) % PIER_SLOTS.length];
    const world = toWorld(slot.tileX, slot.tileY);
    return {
        id: event.id,
        project: event.project,
        repoName: event.repoName,
        label: event.label,
        sha: event.sha,
        provider: event.provider,
        sessionId: event.sessionId,
        sourceId: event.sourceId,
        ts: event.ts,
        createdAt: Date.now(),
        tileX: slot.tileX,
        tileY: slot.tileY,
        worldX: world.x,
        worldY: world.y,
        pinned: false,
        status: event.success === false || event.exitCode > 0 ? 'failed' : 'observed',
        animateDrop: Date.now() - event.ts < RECENT_DROP_MS,
    };
}

export class ChronicleManifests {
    constructor({ store = null, modal = null, settings = Settings } = {}) {
        this.store = store;
        this.modal = modal;
        this.settings = settings;
        this.records = new Map();
        this._loaded = false;
        this._pendingHydrate = null;
    }

    async hydrate(now = Date.now()) {
        if (!this.store || this._loaded) return;
        if (this._pendingHydrate) return this._pendingHydrate;
        this._pendingHydrate = this.store.queryRange('manifests', 'ts', now - PINNED_MS, now + DAY_MS)
            .then((records) => {
                for (const record of records || []) this.records.set(record.id, record);
                this._loaded = true;
            })
            .catch(() => {
                this._loaded = true;
            });
        return this._pendingHydrate;
    }

    async update(agents, now = Date.now()) {
        await this.hydrate(now);
        const additions = [];
        for (const event of collectCommitEvents(agents)) {
            if (this.records.has(event.id)) continue;
            const record = plankFromEvent(event);
            record.createdAt = now;
            record.animateDrop = now - event.ts < RECENT_DROP_MS;
            this.records.set(record.id, record);
            additions.push(record);
        }
        if (additions.length && this.store) {
            try {
                await this.store.bulkPut('manifests', additions);
            } catch { /* degrade to in-memory planks */ }
        }
        this._dropExpired(now);
        return additions;
    }

    enumerateDrawables(now = Date.now(), camera = null) {
        const bounds = camera?.getViewportTileBounds?.(2);
        return [...this.records.values()]
            .filter(record => !this._isExpired(record, now))
            .filter(record => !bounds || (
                record.tileX >= bounds.startX && record.tileX <= bounds.endX &&
                record.tileY >= bounds.startY && record.tileY <= bounds.endY
            ))
            .map(record => ({
                kind: 'chronicle-manifest',
                sortY: (record.worldY || toWorld(record.tileX, record.tileY).y) + 4,
                payload: record,
            }));
    }

    draw(ctx, drawable, zoom = 1, now = Date.now()) {
        const record = drawable?.payload || drawable;
        if (!record) return;
        const world = record.worldX == null ? toWorld(record.tileX, record.tileY) : { x: record.worldX, y: record.worldY };
        const age = Math.max(0, now - Number(record.ts || now));
        const life = record.pinned ? PINNED_MS : DAY_MS;
        const alpha = record.pinned ? 0.88 : Math.max(0.3, 1 - age / life * 0.7);
        const drop = record.animateDrop && age < RECENT_DROP_MS ? (1 - age / RECENT_DROP_MS) * -10 : 0;
        const label = this._displayLabel(record);

        ctx.save();
        ctx.translate(Math.round(world.x), Math.round(world.y + drop));
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#7a4a2d';
        ctx.strokeStyle = '#3b2418';
        ctx.lineWidth = 1 / Math.max(1, zoom);
        ctx.beginPath();
        ctx.moveTo(-18, -5);
        ctx.lineTo(17, -8);
        ctx.lineTo(20, 1);
        ctx.lineTo(-16, 5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = record.status === 'failed' ? '#ef9a7a' : '#f3d08d';
        ctx.font = `${Math.max(5, 7 / Math.max(1, zoom * 0.35))}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(shortText(label, 18), 1, -1);
        ctx.restore();
    }

    hitTest(worldX, worldY, now = Date.now()) {
        for (const record of this.records.values()) {
            if (this._isExpired(record, now)) continue;
            const world = record.worldX == null ? toWorld(record.tileX, record.tileY) : { x: record.worldX, y: record.worldY };
            if (worldX >= world.x - 22 && worldX <= world.x + 22 && worldY >= world.y - 12 && worldY <= world.y + 10) {
                return record;
            }
        }
        return null;
    }

    openManifestModal(recordOrId) {
        const record = typeof recordOrId === 'string' ? this.records.get(recordOrId) : recordOrId;
        if (!record || !this.modal) return false;
        const label = this._displayLabel(record);
        const sha = record.sha ? `<div><strong>SHA</strong> ${this._escape(record.sha.slice(0, 12))}</div>` : '';
        this.modal.open('Manifest', `
            <div class="chronicle-manifest-modal">
                <div><strong>Subject</strong> ${this._escape(label)}</div>
                <div><strong>Repository</strong> ${this._escape(record.repoName || projectName(record.project))}</div>
                ${sha}
                <div><strong>Provider</strong> ${this._escape(record.provider || 'unknown')}</div>
                <div><strong>Status</strong> ${this._escape(record.status || 'observed')}</div>
                <button class="settings-lang-btn" data-chronicle-pin="${this._escape(record.id)}">${record.pinned ? 'Pinned' : 'Pin for 7 days'}</button>
            </div>
        `);
        document.querySelector('[data-chronicle-pin]')?.addEventListener('click', () => {
            void this.pin(record.id);
        }, { once: true });
        return true;
    }

    async pin(id, now = Date.now()) {
        const record = this.records.get(id);
        if (!record) return null;
        record.pinned = true;
        record.pinnedAt = now;
        if (this.store) {
            try {
                await this.store.put('manifests', record);
            } catch { /* in-memory fallback remains pinned */ }
        }
        this.openManifestModal(record);
        return record;
    }

    _displayLabel(record) {
        return this.settings?.privacyRedaction ? '[redacted commit]' : shortText(record.label || 'commit');
    }

    _isExpired(record, now) {
        const age = now - Number(record.ts || 0);
        return age > (record.pinned ? PINNED_MS : DAY_MS);
    }

    _dropExpired(now) {
        for (const [id, record] of this.records) {
            if (this._isExpired(record, now)) this.records.delete(id);
        }
    }

    _escape(value) {
        return String(value || '').replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[char]));
    }
}

export { collectCommitEvents, commitMessageFromCommand };
