import { eventBus } from '../../domain/events/DomainEvent.js';

const MAX_CONCURRENT_RITUALS = 6;
const COALESCE_WINDOW_MS = 250;
const DEFAULT_DURATION_MS = 1200;

export class RitualConductor {
    constructor({ motionScale = 1 } = {}) {
        this.motionScale = motionScale;
        this.rituals = [];
        this.unsubscribers = [
            eventBus.on('tool:invoked', (event) => this.enqueue(event)),
        ];
    }

    dispose() {
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        this.unsubscribers = [];
        this.rituals = [];
    }

    setMotionScale(scale) {
        this.motionScale = Number.isFinite(scale) ? scale : 1;
    }

    enqueue(event) {
        if (!event?.tool || !event?.building) return null;
        const now = event.ts || Date.now();
        const existing = this.rituals.find(ritual => (
            ritual.building === event.building
            && ritual.tool === event.tool
            && now - ritual.createdAt <= COALESCE_WINDOW_MS
        ));
        if (existing) {
            existing.count += 1;
            existing.createdAt = now;
            existing.remainingMs = Math.max(existing.remainingMs, DEFAULT_DURATION_MS);
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
            phase: 'pending',
            count: 1,
            createdAt: now,
            elapsedMs: 0,
            remainingMs: DEFAULT_DURATION_MS,
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
}

export { MAX_CONCURRENT_RITUALS };
