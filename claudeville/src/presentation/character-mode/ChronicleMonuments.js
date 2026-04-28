import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { Settings } from '../../application/Settings.js';
import { MonumentPlanter, MonumentRules } from '../../application/MonumentRules.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { collectCommitEvents } from './ChronicleEvents.js';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const KIND_COLORS = {
    release: '#80e8ff',
    feature: '#f2bc5e',
    fix: '#8fd48e',
    performance: '#d5a6ff',
    verified: '#f7f0a3',
};

function toWorld(tileX, tileY) {
    return {
        x: (tileX - tileY) * TILE_WIDTH / 2,
        y: (tileX + tileY) * TILE_HEIGHT / 2,
    };
}

function projectName(project) {
    const parts = String(project || 'unknown').split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || 'unknown';
}

export class ChronicleMonuments {
    constructor({ store = null, settings = Settings, rules = new MonumentRules(), eventTarget = eventBus } = {}) {
        this.store = store;
        this.settings = settings;
        this.rules = rules;
        this.records = new Map();
        this.planter = new MonumentPlanter({ store, rules, eventTarget });
        this._loaded = false;
        this._pendingHydrate = null;
    }

    async hydrate(now = Date.now()) {
        if (!this.store || this._loaded) return;
        if (this._pendingHydrate) return this._pendingHydrate;
        this._pendingHydrate = this.store.queryRange('monuments', 'plantedAt', now - MONTH_MS, now + MONTH_MS)
            .then((records) => {
                for (const record of records || []) this.records.set(record.id, record);
                this._loaded = true;
            })
            .catch(() => {
                this._loaded = true;
            });
        return this._pendingHydrate;
    }

    async update(agents, context = {}, now = Date.now()) {
        await this.hydrate(now);
        const gitEvents = collectCommitEvents(agents);
        const pushEvents = this._collectPushEvents(agents);
        const planted = await this.planter.processEvents([...gitEvents, ...pushEvents], {
            ...context,
            now,
            monuments: [...this.records.values()],
        });
        for (const record of planted) this.records.set(record.id, record);
        this._dropExpired(now);
        return planted;
    }

    enumerateDrawables(now = Date.now(), camera = null) {
        const bounds = camera?.getViewportTileBounds?.(2);
        const byDistrict = new Map();
        for (const record of this.records.values()) {
            if (now - Number(record.plantedAt || record.ts || 0) > MONTH_MS) continue;
            const group = byDistrict.get(record.district) || [];
            group.push(record);
            byDistrict.set(record.district, group);
        }
        const visible = [];
        for (const [district, records] of byDistrict) {
            const capped = MonumentRules.applyDistrictCap(records);
            visible.push(...capped.visible);
            if (capped.foundingLayer) visible.push(this._foundingLayerRecord(district, records));
        }

        return visible
            .filter(record => now - Number(record.plantedAt || record.ts || 0) <= MONTH_MS)
            .filter(record => !bounds || (
                record.tileX >= bounds.startX && record.tileX <= bounds.endX &&
                record.tileY >= bounds.startY && record.tileY <= bounds.endY
            ))
            .map(record => {
                const world = toWorld(record.tileX, record.tileY);
                return {
                    kind: 'chronicle-monument',
                    sortY: world.y + 18,
                    payload: { ...record, worldX: world.x, worldY: world.y },
                };
            });
    }

    draw(ctx, drawable, zoom = 1, now = Date.now()) {
        const record = drawable?.payload || drawable;
        if (!record) return;
        const world = record.worldX == null ? toWorld(record.tileX, record.tileY) : record;
        const age = Math.max(0, now - Number(record.plantedAt || record.ts || now));
        const alpha = Math.max(0.55, 1 - age / MONTH_MS * 0.45);
        const color = KIND_COLORS[record.kind] || '#d8b96d';

        ctx.save();
        ctx.translate(Math.round(world.worldX ?? world.x), Math.round(world.worldY ?? world.y));
        ctx.globalAlpha = alpha;
        ctx.fillStyle = 'rgba(26, 22, 18, 0.35)';
        ctx.beginPath();
        ctx.ellipse(0, 11, 13, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#9b8a6b';
        if (record.kind === 'founding-layer') {
            this._drawFoundingLayer(ctx, alpha, zoom);
            ctx.restore();
            return;
        }
        ctx.strokeStyle = '#3e3429';
        ctx.lineWidth = 1 / Math.max(1, zoom);
        ctx.beginPath();
        ctx.moveTo(0, -24);
        ctx.lineTo(8, -8);
        ctx.lineTo(6, 8);
        ctx.lineTo(-7, 8);
        ctx.lineTo(-8, -8);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha * 0.42;
        ctx.fillRect(-3, -11, 6, 13);
        ctx.restore();
    }

    hitTest(worldX, worldY, now = Date.now()) {
        for (const drawable of this.enumerateDrawables(now)) {
            const record = drawable.payload;
            if (worldX >= record.worldX - 12 && worldX <= record.worldX + 12 &&
                worldY >= record.worldY - 28 && worldY <= record.worldY + 12) {
                return record;
            }
        }
        return null;
    }

    tooltipFor(record, now = Date.now()) {
        if (!record) return '';
        const ageDays = Math.max(0, Math.floor((now - Number(record.plantedAt || record.ts || now)) / 86400000));
        const label = this.settings?.privacyRedaction
            ? (record.kind === 'release' ? '[redacted release]' : '[redacted commit]')
            : (record.label || record.kind);
        return `${record.kind} stone - ${projectName(record.project)} - ${label} - ${ageDays}d old`;
    }

    minimapMarkers() {
        return this.enumerateDrawables().map(drawable => drawable.payload).map(record => ({
            tileX: record.tileX,
            tileY: record.tileY,
            kind: record.kind,
            color: KIND_COLORS[record.kind] || '#d8b96d',
        }));
    }

    _foundingLayerRecord(district, records) {
        const oldest = [...records].sort((a, b) => Number(a.plantedAt || a.ts || 0) - Number(b.plantedAt || b.ts || 0))[0];
        return {
            ...oldest,
            id: `founding:${district}`,
            kind: 'founding-layer',
            label: 'Founding layer',
            district,
            plantedAt: oldest?.plantedAt || oldest?.ts || Date.now(),
        };
    }

    _drawFoundingLayer(ctx, alpha, zoom) {
        ctx.strokeStyle = '#3e3429';
        ctx.lineWidth = 1 / Math.max(1, zoom);
        for (let i = 0; i < 3; i++) {
            const x = -9 + i * 8;
            const h = 10 + i * 3;
            ctx.fillStyle = i === 1 ? '#a49677' : '#82745d';
            ctx.beginPath();
            ctx.moveTo(x, -h - 4);
            ctx.lineTo(x + 5, -h + 2);
            ctx.lineTo(x + 5, 7);
            ctx.lineTo(x - 4, 7);
            ctx.lineTo(x - 5, -h + 2);
            ctx.closePath();
            ctx.globalAlpha = alpha * (0.84 + i * 0.05);
            ctx.fill();
            ctx.stroke();
        }
    }

    _collectPushEvents(agents) {
        const events = [];
        for (const agent of agents || []) {
            const sources = [agent?.gitEvents, agent?.git?.events, agent?.vcsEvents].filter(Array.isArray);
            for (const source of sources) {
                for (const event of source) {
                    const type = String(event?.type || event?.kind || '').toLowerCase();
                    if (type === 'push' || type === 'tag') {
                        events.push({ ...event, project: event.project || agent.project, provider: event.provider || agent.provider });
                    }
                }
            }
        }
        return events;
    }

    _dropExpired(now) {
        for (const [id, record] of this.records) {
            if (now - Number(record.plantedAt || record.ts || 0) > MONTH_MS) this.records.delete(id);
        }
    }
}
