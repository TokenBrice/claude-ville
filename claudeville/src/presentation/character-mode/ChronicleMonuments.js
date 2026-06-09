import { MonumentPlanter, MonumentRules } from '../../application/MonumentRules.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { collectCommitEvents } from './ChronicleEvents.js';
import { tileToWorld } from './Projection.js';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const KIND_COLORS = {
    release: '#80e8ff',
    feature: '#f2bc5e',
    fix: '#8fd48e',
    performance: '#d5a6ff',
    verified: '#f7f0a3',
};

// Mirrored from HarborTraffic.js constants (HARBOR_FINALE_TILE and
// HARBOR_SQUAD_ANCHORAGES[1] "Inner Quay Basin") — kept here so this module
// stays self-contained without exporting harbor internals.
const HARBOR_FIREWORKS_TILE = { tileX: 38.2, tileY: 6.6 };
const INNER_QUAY_BASIN_TILE = { tileX: 35.15, tileY: 22.55 };

const FIREWORKS_RING_COUNT = 3;
const FIREWORKS_RING_STAGGER_MS = 100;
const FIREWORKS_RING_DURATION_MS = 5000;
const FIREWORKS_LIFETIME_MS = 6000;
const FIREWORKS_MAX_ACTIVE = 8;
const FIREWORKS_MAX_RADIUS = 110;

const MILESTONE_DURATIONS_MS = {
    maiden: 6000,
    ribbon: 8000,
    flagship: 12000,
    aurora: 10000,
};

function toWorld(tileX, tileY) {
    return tileToWorld(tileX, tileY);
}

function projectName(project) {
    const parts = String(project || 'unknown').split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || 'unknown';
}

function reducedMotionPreferred() {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    try {
        return Boolean(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
        return false;
    }
}

function kindIcon(kind) {
    switch (kind) {
        case 'release': return '*';
        case 'feature': return '+';
        case 'fix': return '~';
        case 'performance': return '!';
        case 'verified': return '#';
        case 'founding-layer': return '=';
        default: return '-';
    }
}

export class ChronicleMonuments {
    constructor({
        store = null,
        rules = new MonumentRules(),
        eventTarget = eventBus,
        chronicleStore = null,
        auroraGate = null,
    } = {}) {
        this.store = store;
        this.rules = rules;
        this.eventBus = eventTarget;
        this.records = new Map();
        this.planter = new MonumentPlanter({ store, rules, eventTarget });
        this._loaded = false;
        this._pendingHydrate = null;
        // ChronicleStore is used for lifetime commit-count milestones. It may
        // be the same instance as `store`, but kept as a separate slot so tests
        // can inject a stub.
        this.chronicleStore = chronicleStore || store;
        // AuroraGate is optional. When passed, the 1000th-commit milestone calls
        // `forceTrigger('milestone-1000')` to bypass the daily cap. When absent
        // (current IsometricRenderer wiring), the aurora is omitted but the
        // banner still appears.
        this.auroraGate = auroraGate;
        this._seenCommitIds = new Set();
        this._activeFireworks = [];
        this._activeBanners = [];
        this._pendingMilestones = [];
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
        for (const record of planted) {
            if (record.kind === 'release') this._scheduleReleaseFireworks(record, now);
        }
        await this._processCommitMilestones(gitEvents, now);
        this._dropExpired(now);
        this._dropExpiredOverlays(now);
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

        const drawables = visible
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

        // Append overlays (fireworks rings, milestone banners) — drawn at a sortY
        // above their anchor so they paint on top of nearby monuments.
        for (const firework of this._activeFireworks) {
            const world = toWorld(firework.tileX, firework.tileY);
            drawables.push({
                kind: 'chronicle-fireworks',
                sortY: world.y + 1e6,
                payload: { ...firework, worldX: world.x, worldY: world.y },
            });
        }
        for (const banner of this._activeBanners) {
            const world = toWorld(banner.tileX, banner.tileY);
            drawables.push({
                kind: 'chronicle-banner',
                sortY: world.y + 1e6,
                payload: { ...banner, worldX: world.x, worldY: world.y },
            });
        }
        return drawables;
    }

    draw(ctx, drawable, zoom = 1, now = Date.now()) {
        const record = drawable?.payload || drawable;
        if (!record) return;
        if (drawable?.kind === 'chronicle-fireworks' || record.kind === 'chronicle-fireworks') {
            this._drawFireworks(ctx, record, zoom, now);
            return;
        }
        if (drawable?.kind === 'chronicle-banner' || record.kind === 'chronicle-banner') {
            this._drawBanner(ctx, record, zoom, now);
            return;
        }
        this._drawMonument(ctx, record, zoom, now);
    }

    hitTest(worldX, worldY, now = Date.now()) {
        for (const drawable of this.enumerateDrawables(now)) {
            if (drawable.kind !== 'chronicle-monument') continue;
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
        const ageLabel = ageDays === 0 ? 'today' : `${ageDays}d ago`;
        const label = record.label || record.kind;
        const repo = projectName(record.project);
        const weight = record.weight ? ` [${record.weight}]` : '';
        // 4.8 — monument records may carry a chronicle lore line.
        const lore = String(record.lore || '').trim();
        const loreSuffix = lore ? `\n${lore}` : '';
        return `${kindIcon(record.kind)} ${record.kind}${weight}\nrepo: ${repo}\n${label}\nplanted ${ageLabel}${loreSuffix}`;
    }

    minimapMarkers() {
        return this.enumerateDrawables()
            .filter(drawable => drawable.kind === 'chronicle-monument')
            .map(drawable => drawable.payload)
            .map(record => ({
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

    _drawMonument(ctx, record, zoom, now) {
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
        if (record.kind === 'founding-layer') {
            this._drawFoundingLayer(ctx, alpha, zoom);
            ctx.restore();
            return;
        }

        const weight = record.weight || 'medium';
        if (weight === 'minor') {
            this._drawMinorCairn(ctx, alpha, zoom);
        } else if (weight === 'major') {
            this._drawMajorObelisk(ctx, alpha, zoom, color);
        } else {
            this._drawMediumStone(ctx, alpha, zoom);
        }

        // Energy inset varies with weight: brighter / taller on major releases.
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = color;
        if (weight === 'major') {
            ctx.globalAlpha = alpha * 0.62;
            ctx.fillRect(-3, -16, 6, 18);
        } else if (weight === 'minor') {
            ctx.globalAlpha = alpha * 0.28;
            ctx.fillRect(-2, -6, 4, 7);
        } else {
            ctx.globalAlpha = alpha * 0.42;
            ctx.fillRect(-3, -11, 6, 13);
        }
        ctx.restore();
    }

    _drawMediumStone(ctx, alpha, zoom) {
        ctx.fillStyle = '#9b8a6b';
        ctx.strokeStyle = '#3e3429';
        ctx.lineWidth = 1 / Math.max(1, zoom);
        const scale = 0.75;
        ctx.beginPath();
        ctx.moveTo(0, -24 * scale);
        ctx.lineTo(8 * scale, -8 * scale);
        ctx.lineTo(6 * scale, 8 * scale);
        ctx.lineTo(-7 * scale, 8 * scale);
        ctx.lineTo(-8 * scale, -8 * scale);
        ctx.closePath();
        ctx.globalAlpha = alpha;
        ctx.fill();
        ctx.stroke();
    }

    _drawMajorObelisk(ctx, alpha, zoom, color) {
        ctx.fillStyle = '#a89677';
        ctx.strokeStyle = '#3e3429';
        ctx.lineWidth = 1 / Math.max(1, zoom);
        ctx.beginPath();
        ctx.moveTo(0, -34);
        ctx.lineTo(9, -10);
        ctx.lineTo(7, 9);
        ctx.lineTo(-8, 9);
        ctx.lineTo(-9, -10);
        ctx.closePath();
        ctx.globalAlpha = alpha;
        ctx.fill();
        ctx.stroke();
        // Glowing inset gem centred on the obelisk.
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = alpha * 0.85;
        const gradient = ctx.createRadialGradient(0, -16, 0, 0, -16, 7);
        gradient.addColorStop(0, color);
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(0, -16, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _drawMinorCairn(ctx, alpha, zoom) {
        ctx.strokeStyle = '#3e3429';
        ctx.lineWidth = 1 / Math.max(1, zoom);
        ctx.globalAlpha = alpha;
        // Three stacked rocks, smallest on top.
        const rocks = [
            { x: -4, y: 6, w: 9, h: 5, fill: '#8a7a5e' },
            { x: 2, y: 4, w: 7, h: 4, fill: '#9b8a6b' },
            { x: -2, y: -2, w: 5, h: 4, fill: '#a89677' },
        ];
        for (const rock of rocks) {
            ctx.fillStyle = rock.fill;
            ctx.beginPath();
            ctx.ellipse(rock.x, rock.y, rock.w, rock.h, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
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

    _scheduleReleaseFireworks(record, now) {
        const color = KIND_COLORS[record.kind] || KIND_COLORS.release;
        const anchor = HARBOR_FIREWORKS_TILE;
        this.eventBus?.emit?.('harbor:release-burst', {
            project: record.project,
            label: record.label,
            ts: now,
            color,
        });
        this._pushFirework({
            startedAt: now,
            expiresAt: now + FIREWORKS_LIFETIME_MS,
            tileX: anchor.tileX,
            tileY: anchor.tileY,
            color,
        });
    }

    _pushFirework(firework) {
        this._activeFireworks.push(firework);
        if (this._activeFireworks.length > FIREWORKS_MAX_ACTIVE) {
            // Drop oldest to honour cap.
            this._activeFireworks.splice(0, this._activeFireworks.length - FIREWORKS_MAX_ACTIVE);
        }
    }

    async _processCommitMilestones(gitEvents, now) {
        if (!this.chronicleStore || typeof this.chronicleStore.recordCommit !== 'function') return;
        // Group fresh commits by project so a burst of N commits from one repo
        // increments lifetimeCounts N times in order.
        const fresh = [];
        for (const event of gitEvents || []) {
            if (!event || event.type !== 'commit') continue;
            const id = String(event.id || event.sha || `${event.project}:${event.ts || event.timestamp || ''}`);
            if (this._seenCommitIds.has(id)) continue;
            this._seenCommitIds.add(id);
            fresh.push(event);
        }
        if (this._seenCommitIds.size > 4096) {
            // Trim seen-set to bound memory; oldest entries are unknown so wipe.
            this._seenCommitIds = new Set([...this._seenCommitIds].slice(-2048));
        }
        for (const event of fresh) {
            try {
                const count = await this.chronicleStore.recordCommit(event.project, now);
                const tier = this.rules?.classifyMilestone?.(count) ?? null;
                if (tier) this._spawnMilestone(tier, event, count, now);
            } catch { /* lifetime persistence is best-effort */ }
        }
    }

    _spawnMilestone(tier, event, count, now) {
        const project = String(event.project || 'unknown');
        const repo = projectName(project);
        const duration = MILESTONE_DURATIONS_MS[tier] || 6000;
        const banner = {
            tier,
            project,
            repo,
            count,
            startedAt: now,
            expiresAt: now + duration,
            tileX: INNER_QUAY_BASIN_TILE.tileX,
            tileY: INNER_QUAY_BASIN_TILE.tileY,
            text: this._milestoneText(tier, repo, count),
        };
        if (tier === 'flagship') {
            // Trigger lighthouse lock via event so HarborTraffic / Lighthouse can
            // subscribe without us editing them directly.
            this.eventBus?.emit?.('harbor:milestone-lock', { project, repo, durationMs: 4000, ts: now });
        }
        if (tier === 'aurora') {
            // 1000th commit: force aurora regardless of daily cap.
            this.auroraGate?.forceTrigger?.('milestone-1000', now);
        }
        this._activeBanners.push(banner);
        // Cap banners to keep overdraw bounded.
        if (this._activeBanners.length > 6) {
            this._activeBanners.splice(0, this._activeBanners.length - 6);
        }
        this.eventBus?.emit?.('chronicle:milestone-banner', banner);
    }

    _milestoneText(tier, repo, count) {
        switch (tier) {
            case 'maiden': return `Maiden Voyage - ${repo}`;
            case 'ribbon': return `${repo} - 10 commits`;
            case 'flagship': return `${repo} - 100 commits`;
            case 'aurora': return `${repo} - 1000 commits`;
            default: return `${repo} - ${count} commits`;
        }
    }

    _drawFireworks(ctx, payload, zoom, now) {
        const reduced = reducedMotionPreferred();
        const elapsed = Math.max(0, now - Number(payload.startedAt || now));
        const lineWidth = Math.max(1, 1.5 / Math.max(1, zoom));
        ctx.save();
        ctx.translate(Math.round(payload.worldX), Math.round(payload.worldY));
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = payload.color || KIND_COLORS.release;
        if (reduced) {
            // Static three concentric outlines — no expansion.
            ctx.globalAlpha = 0.85;
            for (let i = 0; i < FIREWORKS_RING_COUNT; i++) {
                const radius = 28 + i * 20;
                ctx.beginPath();
                ctx.arc(0, 0, radius, 0, Math.PI * 2);
                ctx.stroke();
            }
        } else {
            ctx.globalCompositeOperation = 'lighter';
            for (let i = 0; i < FIREWORKS_RING_COUNT; i++) {
                const ringStart = i * FIREWORKS_RING_STAGGER_MS;
                const ringElapsed = elapsed - ringStart;
                if (ringElapsed < 0) continue;
                if (ringElapsed > FIREWORKS_RING_DURATION_MS) continue;
                const t = ringElapsed / FIREWORKS_RING_DURATION_MS;
                const radius = 6 + t * FIREWORKS_MAX_RADIUS;
                ctx.globalAlpha = Math.max(0, 0.85 * (1 - t));
                ctx.beginPath();
                ctx.arc(0, 0, radius, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    _drawBanner(ctx, payload, zoom, now) {
        const reduced = reducedMotionPreferred();
        const elapsed = Math.max(0, now - Number(payload.startedAt || now));
        const duration = Math.max(1, Number(payload.expiresAt || now) - Number(payload.startedAt || now));
        const t = Math.min(1, elapsed / duration);
        const fade = reduced ? 1 : Math.min(1, t < 0.15 ? t / 0.15 : (1 - t) / 0.2);
        if (fade <= 0) return;
        const text = payload.text || '';
        const tier = payload.tier || 'maiden';
        const accent = tier === 'aurora'
            ? '#bff0ff'
            : tier === 'flagship'
                ? '#ffd27a'
                : tier === 'ribbon'
                    ? '#ffea9b'
                    : '#e8f6c8';
        const scale = 1 / Math.max(1, zoom);
        ctx.save();
        ctx.translate(Math.round(payload.worldX), Math.round(payload.worldY));
        ctx.globalAlpha = fade;
        ctx.font = `${Math.round(14 * scale)}px "Press Start 2P", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const lift = tier === 'flagship' ? -84 : tier === 'ribbon' ? -56 : -48;
        const measure = ctx.measureText(text);
        const padX = 10 * scale;
        const padY = 6 * scale;
        const bgW = measure.width + padX * 2;
        const bgH = 18 * scale + padY * 2;
        ctx.fillStyle = 'rgba(16, 12, 24, 0.78)';
        ctx.strokeStyle = accent;
        ctx.lineWidth = Math.max(1, 1.5 * scale);
        ctx.beginPath();
        const x = -bgW / 2;
        const y = lift * scale - bgH;
        ctx.rect(x, y, bgW, bgH);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = accent;
        ctx.fillText(text, 0, lift * scale - padY);
        if (!reduced && tier === 'ribbon') {
            // Small flag-ribbon flourish over the squad flagship anchor.
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.moveTo(bgW / 2, y + bgH / 2);
            ctx.lineTo(bgW / 2 + 12 * scale, y + bgH / 2 - 6 * scale);
            ctx.lineTo(bgW / 2 + 12 * scale, y + bgH / 2 + 6 * scale);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
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

    _dropExpiredOverlays(now) {
        if (this._activeFireworks.length) {
            this._activeFireworks = this._activeFireworks.filter(f => Number(f.expiresAt || 0) > now);
        }
        if (this._activeBanners.length) {
            this._activeBanners = this._activeBanners.filter(b => Number(b.expiresAt || 0) > now);
        }
    }
}
