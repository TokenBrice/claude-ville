// Scenario vocabulary shared by the realtime harness (runtime.js) and the
// virtual-clock renderer (virtual.js): synthetic worlds, fixed-date
// atmosphere snapshots, the sound settings a scene starts from, and the
// scripted actions, all through the shipped modules' public surfaces.
import { eventBus } from '/src/domain/events/DomainEvent.js';
import { createAtmosphereSnapshot } from '/src/presentation/character-mode/AtmosphereState.js';
import { seasonTokenForAtmosphere } from '/src/presentation/character-mode/SeasonalAmbience.js';
import { STANDARD_VOLUME_STEP } from '/src/presentation/shared/audio/Loudness.js';

// Every layer the ambient director owns (its forceLayer() names); the sea
// (4.1) plays on the wind group (*Weather & sea*).
export const LAYERS = ['sea', 'wind', 'rain', 'birds', 'crickets', 'hum', 'music'];

// ------------------------------------------------------------ sequencer ----
// Selection pins on the one music sequencer (2.3). The Town band chooses its
// first piece in the Transport window that opens at its start, before any
// caller can reach the instance, so the pin (and the mark observer) is set
// in the sequencer's `_start` — the harness's prototype-patch pattern.
// `holdFirstSec` moves Village's first song slot to at least that long
// after its start (the level slew settles first). Returns false on a tree
// without the sequencer.
export async function pinSequencer({ preset, piece, onMark = null, holdFirstSec = 0 }) {
    const mod = await import('/src/presentation/shared/audio/music/Sequencer.js').catch(() => null);
    if (!mod?.Sequencer) return false;
    const proto = mod.Sequencer.prototype;
    const start = proto._start;
    proto._start = function pinnedStart(...a) {
        if (this.preset !== preset) return start.apply(this, a);
        if (piece) this.pin({ piece });
        if (onMark) this.observe(onMark);
        const result = start.apply(this, a);
        if (holdFirstSec > 0 && this._cur == null && this._nextAt != null) {
            this._nextAt = Math.max(this._nextAt, this.engine.now() + holdFirstSec);
        }
        return result;
    };
    return true;
}

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

// spec: { counts: { status: n }, providers, agents: [{ status, provider,
// ...fields }] } — `agents` adds explicit agents (stale flags, turn
// durations) after the counted ones. An actionable agent starts its wait now.
const ACTIONABLE = new Set(['waiting_on_user', 'errored', 'rate_limited']);
export function makeWorld(spec = {}) {
    const agents = new Map();
    const providers = spec.providers || ['claude', 'codex', 'gemini', 'kimi'];
    let p = 0;
    const add = (agent) => {
        if (ACTIONABLE.has(agent.status) && agent.awaitingSince == null) agent.awaitingSince = Date.now();
        agents.set(agent.id, agent);
    };
    for (const [status, count] of Object.entries(spec.counts || {})) {
        for (let i = 0; i < count; i++) add(makeAgent(status, providers[p++ % providers.length]));
    }
    for (const { status = 'working', provider, ...fields } of spec.agents || []) add(makeAgent(status, provider || providers[p++ % providers.length], fields));
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
// groups take SoundSettings' default step) and the calibration marker, so
// the controller loads them as a calibrated profile instead of resetting them.
export function seedSoundStorage(spec = {}) {
    try {
        localStorage.setItem('claudeville.sound.enabled', spec.soundOff ? 'false' : 'true');
        localStorage.setItem('claudeville.sound.mode', spec.mode || 'ambient');
        localStorage.setItem('claudeville.sound.volume', String(spec.volumeStep ?? STANDARD_VOLUME_STEP));
        localStorage.setItem('claudeville.sound.layers', JSON.stringify(spec.layerSteps || {}));
        localStorage.setItem('claudeville.sound.calibration', '2');
        localStorage.setItem('claudeville.sound.background', 'play');
        // Wave 3 settings (reminders, captions, hour count), when a scene sets them.
        for (const [key, value] of Object.entries(spec.storage || {})) localStorage.setItem(key, String(value));
    } catch { /* storage optional */ }
}

// -------------------------------------------------------------- actions ----
// {status:{index,status,fields}} | {addAgent:{status,provider,parentIndex,fields}} |
// {remove:{index}} | {ack:{index}} | {select:{index}} | {deselect:true} |
// {emit, payload, agentIndex, raw} | {mode} | {cue, payload, agentIndex}.
// Returns the marker it recorded.
// `raw` emits the payload as given (arrays, strings); otherwise it is copied
// and the agent attached.
export function runAction(action, { world, mark, controller }) {
    const agents = [...world.agents.values()];
    const agentFor = index => (index != null ? agents[index] : null);
    if (action.status) {
        const agent = agentFor(action.status.index ?? 0);
        if (agent) {
            const was = agent.status;
            agent.status = action.status.status;
            if (ACTIONABLE.has(agent.status) && agent.status !== was) agent.awaitingSince = Date.now();
            if (!ACTIONABLE.has(agent.status)) delete agent.awaitingSince;
            Object.assign(agent, action.status.fields || {});
            eventBus.emit('agent:updated', agent);
        }
        return mark(action.label || `status:${action.status.status}`, { kind: 'action', agentId: agent?.id ?? null, lane: action.lane ?? null });
    }
    if (action.addAgent) {
        const parent = agentFor(action.addAgent.parentIndex);
        const agent = makeAgent(action.addAgent.status || 'working', action.addAgent.provider || 'claude', {
            ...(parent ? { parentSessionId: parent.id } : {}),
            ...(action.addAgent.fields || {}),
        });
        world.agents.set(agent.id, agent);
        eventBus.emit('agent:added', agent);
        return mark(action.label || `add:${agent.id}`, { kind: 'action', agentId: agent.id, lane: action.lane ?? null });
    }
    if (action.remove) {
        const agent = agentFor(action.remove.index);
        if (agent) {
            world.agents.delete(agent.id);
            eventBus.emit('agent:removed', agent);
        }
        return mark(action.label || `remove:${agent?.id}`, { kind: 'action', agentId: agent?.id ?? null, lane: action.lane ?? null });
    }
    if (action.ack) {
        const agent = agentFor(action.ack.index);
        eventBus.emit('attention:acknowledged', { agentId: agent?.id ?? null });
        return mark(action.label || `ack:${agent?.id}`, { kind: 'action', agentId: agent?.id ?? null });
    }
    if (action.select) {
        const agent = agentFor(action.select.index);
        eventBus.emit('agent:selected', agent);
        return mark(action.label || `select:${agent?.id}`, { kind: 'action', agentId: agent?.id ?? null });
    }
    if (action.deselect) {
        eventBus.emit('agent:deselected');
        return mark(action.label || 'deselect', { kind: 'action' });
    }
    if (action.emit) {
        if (action.raw) {
            const marker = mark(action.label || action.emit, { kind: 'event', lane: action.lane ?? null, agentId: null });
            eventBus.emit(action.emit, action.payload);
            return marker;
        }
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
        // The director that owns the signal route: the active one while it
        // plays, else the ambient director (sound off, or before the Town
        // band starts), as the producers' events would reach them.
        const director = controller.director.running ? controller.director : controller.directors.ambient;
        director.cue(action.cue, payload);
        return marker;
    }
    return null;
}
