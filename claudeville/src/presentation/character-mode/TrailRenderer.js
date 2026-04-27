import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { eventBus } from '../../domain/events/DomainEvent.js';

const CAPTURE_INTERVAL_MS = 1000;
const FLUSH_INTERVAL_MS = 30000;
const REPAINT_INTERVAL_MS = 2000;
const RETAIN_MS = 60 * 60 * 1000;
const MAX_RENDER_SAMPLES_ZOOMED_OUT = 600;
const PHASE_COLORS = {
    morning: '255, 218, 128',
    afternoon: '232, 224, 194',
    dusk: '255, 164, 96',
    night: '112, 174, 255',
};

function toWorld(tileX, tileY) {
    return {
        x: (tileX - tileY) * TILE_WIDTH / 2,
        y: (tileX + tileY) * TILE_HEIGHT / 2,
    };
}

function sampleId(agentId, ts) {
    return `${agentId}:${Math.floor(ts / 1000)}`;
}

function pageIsVisible() {
    return typeof document === 'undefined' || document.visibilityState === 'visible';
}

function viewportMetrics(viewport = {}) {
    const dpr = viewport.dpr || viewport._claudeVilleDpr || 1;
    const width = viewport._claudeVilleCssWidth || viewport.clientWidth || Math.round((viewport.width || 0) / dpr) || viewport.width || 0;
    const height = viewport._claudeVilleCssHeight || viewport.clientHeight || Math.round((viewport.height || 0) / dpr) || viewport.height || 0;
    return { dpr, width, height };
}

export class TrailRenderer {
    constructor({ store = null, world = null, motionScale = 1 } = {}) {
        this.store = store;
        this.world = world;
        this.motionScale = motionScale;
        this.samplesByAgent = new Map();
        this.pending = [];
        this.cache = null;
        this.cacheKey = '';
        this.lastCaptureAt = 0;
        this.lastFlushAt = 0;
        this.lastRepaintAt = 0;
        this.selectedAgentId = null;
        this.lease = null;
        this._loaded = false;
        this._needsRepaint = true;
        this._unsubscribers = [
            eventBus.on('agent:selected', (agent) => this.setSelectedAgent(agent?.id || null)),
            eventBus.on('agent:deselected', () => this.setSelectedAgent(null)),
        ];
    }

    setMotionScale(scale) {
        this.motionScale = scale === 0 ? 0 : 1;
        this._needsRepaint = true;
    }

    setSelectedAgent(agentId) {
        if (this.selectedAgentId === agentId) return;
        this.selectedAgentId = agentId;
        this._needsRepaint = true;
    }

    async hydrate(now = Date.now()) {
        if (!this.store || this._loaded) return;
        try {
            const records = await this.store.queryRange('trailSamples', 'ts', now - RETAIN_MS, now);
            for (const record of records || []) this._addSample(record, false);
        } catch { /* empty trail on storage failures */ }
        this._loaded = true;
        this._needsRepaint = true;
    }

    async update(agents, now = Date.now(), atmosphere = null) {
        await this.hydrate(now);
        const visible = pageIsVisible();
        if (!visible && this.lease) {
            this.lease.release?.();
            this.lease = null;
        }
        if (visible && !this.lease && this.store) {
            try {
                const lease = this.store.acquireCaptureLease();
                if (lease.acquired) this.lease = lease;
            } catch { /* read-only fallback */ }
        }
        if (this.lease && !this.lease.renew()) this.lease = null;

        if (visible && this.lease && now - this.lastCaptureAt >= CAPTURE_INTERVAL_MS) {
            this.capture(agents, now, atmosphere);
        }
        if (visible && this.lease && now - this.lastFlushAt >= FLUSH_INTERVAL_MS) {
            await this.flush(now);
        }
        this._pruneMemory(now);
    }

    capture(agents, now = Date.now(), atmosphere = null) {
        this.lastCaptureAt = now;
        const list = agents?.values ? agents.values() : (agents || []);
        for (const agent of list) {
            const position = agent?.position;
            if (!agent?.id || !position) continue;
            const tileX = Number(position.tileX);
            const tileY = Number(position.tileY);
            if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) continue;
            const sample = {
                id: sampleId(agent.id, now),
                agentId: agent.id,
                provider: agent.provider || '',
                model: agent.model || '',
                ts: now,
                tileX,
                tileY,
                dayProgress: Number(atmosphere?.dayProgress ?? 0),
                phase: atmosphere?.phase || this._phaseFromDate(now),
            };
            this._addSample(sample, true);
        }
    }

    async flush(now = Date.now()) {
        this.lastFlushAt = now;
        if (!this.pending.length || !this.store) return 0;
        const batch = this.pending.splice(0, this.pending.length);
        try {
            return await this.store.bulkPut('trailSamples', batch);
        } catch {
            return 0;
        }
    }

    draw(ctx, camera, viewport, now = Date.now()) {
        if (!ctx || !camera || !viewport) return;
        if (this._shouldRepaint(camera, viewport, now)) {
            this._repaint(camera, viewport, now);
        }
        if (!this.cache) return;
        const { dpr, width, height } = viewportMetrics(viewport);
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.drawImage(this.cache, 0, 0, width, height);
        ctx.restore();
    }

    dispose() {
        void this.flush();
        this.lease?.release?.();
        this.lease = null;
        for (const off of this._unsubscribers) off?.();
        this._unsubscribers = [];
        this.cache = null;
    }

    _addSample(sample, pending) {
        const list = this.samplesByAgent.get(sample.agentId) || [];
        const last = list.at(-1);
        if (last && Math.floor(last.ts / 1000) === Math.floor(sample.ts / 1000)) return;
        list.push(sample);
        while (list.length > 3600) list.shift();
        this.samplesByAgent.set(sample.agentId, list);
        if (pending) this.pending.push(sample);
        this._needsRepaint = true;
    }

    _shouldRepaint(camera, viewport, now) {
        const { dpr, width, height } = viewportMetrics(viewport);
        const key = [
            width, height, dpr,
            Math.round((camera.x || 0) / 4),
            Math.round((camera.y || 0) / 4),
            Math.round((camera.zoom || 1) * 20),
            this.selectedAgentId || '',
        ].join('|');
        if (this.cacheKey !== key) {
            this.cacheKey = key;
            return true;
        }
        if (this.motionScale === 0) return this._needsRepaint;
        return this._needsRepaint && now - this.lastRepaintAt >= REPAINT_INTERVAL_MS;
    }

    _repaint(camera, viewport, now) {
        const metrics = viewportMetrics(viewport);
        const width = Math.max(1, Math.round(metrics.width || 1));
        const height = Math.max(1, Math.round(metrics.height || 1));
        const dpr = metrics.dpr;
        const canvas = this.cache || document.createElement('canvas');
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        const bounds = camera.getViewportTileBounds?.(3);
        const zoom = camera.zoom || 1;

        for (const [agentId, samples] of this.samplesByAgent) {
            const visible = !bounds || samples.some(sample => (
                sample.tileX >= bounds.startX && sample.tileX <= bounds.endX &&
                sample.tileY >= bounds.startY && sample.tileY <= bounds.endY
            ));
            if (!visible) continue;
            const selected = agentId === this.selectedAgentId;
            const renderSamples = zoom < 1.5 && samples.length > MAX_RENDER_SAMPLES_ZOOMED_OUT
                ? samples.slice(-MAX_RENDER_SAMPLES_ZOOMED_OUT)
                : samples;
            this._drawTrail(ctx, renderSamples, camera, now, selected);
        }

        this.cache = canvas;
        this._needsRepaint = false;
        this.lastRepaintAt = now;
    }

    _drawTrail(ctx, samples, camera, now, selected) {
        if (samples.length < 2) return;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = selected ? 2 : 1;
        for (let i = 1; i < samples.length; i++) {
            const previous = samples[i - 1];
            const current = samples[i];
            const age = Math.max(0, now - current.ts);
            const alpha = Math.max(0.02, 1 - age / RETAIN_MS) * (selected ? 0.5 : 0.18);
            const color = PHASE_COLORS[current.phase] || PHASE_COLORS.afternoon;
            const from = camera.worldToScreen(...Object.values(toWorld(previous.tileX, previous.tileY)));
            const to = camera.worldToScreen(...Object.values(toWorld(current.tileX, current.tileY)));
            ctx.strokeStyle = `rgba(${color}, ${alpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(Math.round(from.x), Math.round(from.y));
            ctx.lineTo(Math.round(to.x), Math.round(to.y));
            ctx.stroke();
        }
        ctx.restore();
    }

    _pruneMemory(now) {
        const cutoff = now - RETAIN_MS;
        for (const [agentId, samples] of this.samplesByAgent) {
            const kept = samples.filter(sample => sample.ts >= cutoff);
            if (kept.length) this.samplesByAgent.set(agentId, kept);
            else this.samplesByAgent.delete(agentId);
        }
    }

    _phaseFromDate(now) {
        const hour = new Date(now).getHours();
        if (hour < 6 || hour >= 21) return 'night';
        if (hour < 12) return 'morning';
        if (hour < 18) return 'afternoon';
        return 'dusk';
    }
}
