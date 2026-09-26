// Scenario vocabulary shared by the realtime harness (runtime.js) and the
// virtual-clock renderer (virtual.js): synthetic worlds, fixed-date
// atmosphere snapshots, the sound settings a scene starts from, and the
// scripted actions, all through the shipped modules' public surfaces.
import { eventBus } from '/src/domain/events/DomainEvent.js';
import { createAtmosphereSnapshot } from '/src/presentation/character-mode/AtmosphereState.js';
import { seasonTokenForAtmosphere } from '/src/presentation/character-mode/SeasonalAmbience.js';
import { STANDARD_VOLUME_STEP } from '/src/presentation/shared/audio/Loudness.js';

// Every layer the ambient director owns (its forceLayer() names).
export const LAYERS = ['wind', 'rain', 'birds', 'crickets', 'hum', 'music'];

// ---------------------------------------------------------------- world ----
let agentSeq = 0;
export function makeAgent(status, provider = 'claude', extra = {}) {
    agentSeq++;
    return {
        id: `har-${agentSeq}`,
        name: `Villager ${agentSeq}`,
        provider,
        status,
        position: { tileX: 10 + (agentSeq * 7) % 20, tileY: 12 + (agentSeq * 5) % 16 },
        ...extra,
    };
}

export function makeWorld(spec = {}) {
    const agents = new Map();
    const providers = spec.providers || ['claude', 'codex', 'gemini', 'kimi'];
    let p = 0;
    for (const [status, count] of Object.entries(spec.counts || {})) {
        for (let i = 0; i < count; i++) {
            const agent = makeAgent(status, providers[p++ % providers.length]);
            agents.set(agent.id, agent);
        }
    }
    return { agents };
}

// ----------------------------------------------------------- atmosphere ----
export const FIXED_DATE = () => new Date(2026, 6, 15, 12, 0, 0); // mid-July: summer

// Find the hour that lands the requested phase at the requested progress for
// this weather, scanning the day in 2-minute steps. Minute 0 is avoided so the
// hour bell never fires inside a render.
export function hourFor(phase, progress = 0.5, weatherOverride = null) {
    let best = null;
    for (let m = 1; m < 1440; m += 2) {
        if (m % 60 === 0) continue;
        const snap = createAtmosphereSnapshot({ now: FIXED_DATE(), hourOverride: m / 60, weatherOverride });
        if (snap.phase !== phase) continue;
        const d = Math.abs((snap.phaseProgress ?? 0) - progress);
        if (!best || d < best.d) best = { d, hour: m / 60 };
    }
    return best ? best.hour : 12.5;
}

export function atmosphereFor(spec = {}) {
    const weatherOverride = spec.weather || { type: 'clear' };
    const hour = spec.hour ?? hourFor(spec.phase || 'day', spec.progress ?? 0.5, weatherOverride);
    const snapshot = createAtmosphereSnapshot({ now: FIXED_DATE(), hourOverride: hour, weatherOverride });
    return { snapshot, hour };
}

export function atmosphereSummary(snapshot) {
    return {
        phase: snapshot.phase,
        phaseProgress: Number((snapshot.phaseProgress ?? 0).toFixed(3)),
        season: seasonTokenForAtmosphere(snapshot),
        clock: snapshot.clock ? { hours: snapshot.clock.hours, minutes: snapshot.clock.minutes } : null,
        weather: snapshot.weather ? {
            type: snapshot.weather.type,
            intensity: Number((snapshot.weather.intensity ?? 0).toFixed(3)),
            precipitation: Number((snapshot.weather.precipitation ?? 0).toFixed(3)),
            fog: Number((snapshot.weather.fog ?? 0).toFixed(3)),
            windX: snapshot.weather.windX,
        } : null,
    };
}

export function plain(value) {
    return JSON.parse(JSON.stringify(value ?? null, (k, v) => (typeof v === 'function' ? undefined : v)));
}

// Markers on a context's audio clock; `mark` returns the marker it records.
export function makeMarker(getCtx) {
    const markers = [];
    const mark = (label, extra = {}) => {
        const ctx = getCtx();
        const marker = { label, t: ctx ? ctx.currentTime : null, ...extra };
        markers.push(marker);
        return marker;
    };
    return { markers, mark };
}

// The stored sound settings a scene starts from: enabled, the preset, the
// master step (default: the standard step), per-group trim steps (missing
// groups stay at 10 = unity) and the calibration marker, so the controller
// loads them as a calibrated profile instead of resetting them.
export function seedSoundStorage(spec = {}) {
    try {
        localStorage.setItem('claudeville.sound.enabled', 'true');
        localStorage.setItem('claudeville.sound.mode', spec.mode || 'ambient');
        localStorage.setItem('claudeville.sound.volume', String(spec.volumeStep ?? STANDARD_VOLUME_STEP));
        localStorage.setItem('claudeville.sound.layers', JSON.stringify(spec.layerSteps || {}));
        localStorage.setItem('claudeville.sound.calibration', '2');
        localStorage.setItem('claudeville.sound.background', 'play');
    } catch { /* storage optional */ }
}

// -------------------------------------------------------------- actions ----
// {status:{index,status}} | {addAgent} | {emit, payload, agentIndex} |
// {mode} | {cue, payload, agentIndex}. Returns the marker it recorded.
export function runAction(action, { world, mark, controller }) {
    const agents = [...world.agents.values()];
    const agentFor = index => (index != null ? agents[index] : null);
    if (action.status) {
        const agent = agentFor(action.status.index ?? 0);
        if (agent) {
            agent.status = action.status.status;
            if (action.status.status === 'waiting_on_user') agent.awaitingSince = Date.now();
            eventBus.emit('agent:updated', agent);
        }
        return mark(`status:${action.status.status}`, { kind: 'action', agentId: agent?.id ?? null });
    }
    if (action.addAgent) {
        const agent = makeAgent(action.addAgent.status || 'working', action.addAgent.provider || 'claude');
        world.agents.set(agent.id, agent);
        eventBus.emit('agent:added', agent);
        return mark(`add:${agent.id}`, { kind: 'action', agentId: agent.id });
    }
    if (action.emit) {
        const payload = { ...(action.payload || {}) };
        const agent = agentFor(action.agentIndex);
        if (agent) {
            payload.agentId = agent.id;
            payload.agent = agent;
            payload.provider = payload.provider || agent.provider;
        }
        const marker = mark(action.label || action.emit, { kind: 'event', lane: action.lane ?? null, agentId: agent?.id ?? payload.agentId ?? null });
        eventBus.emit(action.emit, payload);
        return marker;
    }
    if (action.mode) {
        const marker = mark(`mode:${action.mode}`, { kind: 'action' });
        controller.setMode(action.mode);
        return marker;
    }
    if (action.cue) {
        const payload = { ...(action.payload || {}) };
        const agent = agentFor(action.agentIndex);
        if (agent) {
            payload.agentId = agent.id;
            payload.provider = payload.provider || agent.provider;
        }
        const marker = mark(action.label || `debug-cue:${action.cue}`, { kind: 'event', lane: action.lane ?? null, cueKind: action.cue, agentId: payload.agentId ?? null });
        controller.director.cue(action.cue, payload);
        return marker;
    }
    return null;
}
