// The soundscape brain. Once per second it reads the world — atmosphere
// snapshot (time-of-day phase, weather, season) and agent stats — and steers
// each ambience layer's intensity with slow slews, the world bus's weather
// ceiling and the circadian tilt. Discrete village moments arrive over the
// event bus and become one-shot cues through the engine-owned cue arbiter
// (`cues = { kit, governor }`, injected; never built or destroyed here).
//
// Atmosphere source: the World renderer broadcasts its per-frame snapshot as
// `atmosphere:updated` (so debug overrides and village weather influence are
// heard, not just seen). When that stream goes quiet — Dashboard mode stops
// the render loop — the director computes its own snapshot; AtmosphereState
// is pure local-clock, so ambience keeps tracking time and weather anywhere.

import { eventBus } from '../../../domain/events/DomainEvent.js';
import { actionableAgents, bucketCounts } from '../../../domain/services/SignalLedger.js';
import { createAtmosphereSnapshot } from '../../character-mode/AtmosphereState.js';
import { seasonTokenForAtmosphere } from '../../character-mode/SeasonalAmbience.js';
import { clamp01, rand } from './AudioEngine.js';
import { rngStream } from './Rng.js';
import { cueLifecycleDecision, updateQuietFloor } from './CueGovernor.js';
import { cuePlacementKind, laneForCueKind } from './cues/CueKit.js';
import { buildingOf, explicitSpot, resolveCueSpot } from './SpatialField.js';
import { ActionableCueRouter, attentionStatus } from './ActionableRouting.js';
import { WindLayer } from './layers/WindLayer.js';
import { RainLayer } from './layers/RainLayer.js';
import { BirdsLayer } from './layers/BirdsLayer.js';
import { CricketsLayer } from './layers/CricketsLayer.js';
import { VillageHumLayer } from './layers/VillageHumLayer.js';
import { Sequencer } from './music/Sequencer.js';

const TICK_MS = 1000;
const DIRECTOR_ID = 'ambient';
// Pause in place (2.1): the groups close over 80 ms and reopen over 250 ms.
const PAUSE_CLOSE_SEC = 0.08;
const RESUME_OPEN_SEC = 0.25;
const ATMO_FRESH_MS = 3000;
const QUIET_ENTER_MS = 30000;
const QUIET_LEAVE_MS = 4000;

// Weather and resting budgets (plan 1.4; MIX-3, SCN-5).
// The world bus yields up to WEATHER_CEILING_DB as rain or a storm builds,
// reaching it at WEATHER_FULL (a steady rain already counts as full), so
// weather swells without taking the urgent bell's headroom. Measured with
// `node scripts/audio/probe.mjs --only scenes` (PROGRAM_TRIM_DB 28.2,
// standard step, A = −37.9): −7 dB left the rain scene at A + 5.7; −8 dB
// reads rain A + 4.9 and storm A + 7.0, urgent-cue GR ≤ 2.7 dB over both.
export const WEATHER_CEILING_DB = -8;
const WEATHER_FULL = 0.7;
// Rain-day wind at 0.4 sat 9 dB over calm; while it rains, wind stays under this.
export const RAIN_WIND_CAP = 0.3;
// Precipitation above this counts as audible rain (winter snow is hushed upstream).
const RAIN_AUDIBLE = 0.05;
// Resting keeps the world at the S2 pilot light (A − 10 ± 3 LU): weather at
// 0.3 of its waking level (twice the old 0.15 floor), and never less wind
// than the pilot level — wind is the only world bed until the sea lands (4.1).
// Calm-day wind (0.05) carries anchor A on today's bed; 0.018 sits ≈ 9 dB under it.
const RESTING_WEATHER_SCALE = 0.3;
export const RESTING_PILOT_WIND = 0.018;
// The Village composer's level: −6 dB from the pre-calibration 0.75, toward
// S2's "Village music ≤ bed + 3 LU" (the music stem sat at bed + 7). The
// occasion clock (6.6) and Wave 4's bed re-measure replace this constant.
const VILLAGE_MUSIC_LEVEL = 0.375;
// Slew (s) of the first tick after start(): layers reach their targets under
// the director crossfade instead of trailing it by their slow time constants.
const PRIME_TIME_CONSTANT = 0.05;

const BIRD_SEASON = { winter: 0.25, spring: 1, summer: 1, autumn: 0.7 };
const CRICKET_SEASON = { winter: 0, spring: 0.45, summer: 1, autumn: 0.55 };

// Daylight 0..1: 1 through the day, ramping through dawn/dusk, 0 at night.
function daylight(phase, phaseProgress) {
    if (phase === 'day') return 1;
    if (phase === 'dawn') return phaseProgress;
    if (phase === 'dusk') return 1 - phaseProgress;
    return 0;
}

/**
 * Crickets sing through the night, fading in and out at its edges, follow the
 * season, and fall silent as rain arrives — a storm silences them outright
 * (storm precipitation can sit near 0.6, which would otherwise leave a chorus).
 */
export function cricketLevel({ phase, phaseProgress = 0, season = 'summer', precipitation = 0, storm = 0 } = {}) {
    if (phase !== 'night' || storm > 0) return 0;
    const p = clamp01(phaseProgress);
    return clamp01(Math.min(p, 1 - p) * 10)
        * (CRICKET_SEASON[season] ?? 0.5)
        * (1 - clamp01(precipitation));
}

/**
 * Weather and resting budgets on one tick's layer levels (0..1), in place.
 * `precipitation` is the heard rain amount (winter snow already hushed) and
 * `storm` the storm intensity. Wind is capped while it rains, and the
 * Village music rests through rain and storm (S7: no melodic duty there);
 * resting keeps only the world stratum, at the pilot light. Returns the
 * world bus's weather ceiling in dB (≤ 0), scaled by how much weather there is.
 */
export function applyWorldBudgets(levels, { precipitation = 0, storm = 0, resting = false } = {}) {
    const rain = clamp01(precipitation);
    if (rain > RAIN_AUDIBLE) levels.wind = Math.min(levels.wind, RAIN_WIND_CAP);
    if (rain > RAIN_AUDIBLE || storm > 0) levels.music = 0;
    if (resting) {
        levels.wind = Math.max(levels.wind * RESTING_WEATHER_SCALE, RESTING_PILOT_WIND);
        levels.rain *= RESTING_WEATHER_SCALE;
        levels.birds = 0;
        levels.crickets = 0;
        levels.hum = 0;
        levels.music = 0;
    }
    const weather = clamp01(Math.max(rain, clamp01(storm)) / WEATHER_FULL);
    return weather > 0 ? WEATHER_CEILING_DB * weather : 0;
}

function copyPosition(position) {
    if (!position || typeof position !== 'object') return null;
    return {
        ...(Number.isFinite(Number(position.tileX)) ? { tileX: Number(position.tileX) } : {}),
        ...(Number.isFinite(Number(position.tileY)) ? { tileY: Number(position.tileY) } : {}),
        ...(Number.isFinite(Number(position.x)) ? { x: Number(position.x) } : {}),
        ...(Number.isFinite(Number(position.y)) ? { y: Number(position.y) } : {}),
        ...(Number.isFinite(Number(position.screenX)) ? { screenX: Number(position.screenX) } : {}),
    };
}

// The payload fields a cue's place is resolved from (SpatialField.resolveCueSpot).
function spatialFields(payload) {
    return {
        agent: payload?.agent,
        screenX: payload?.screenX,
        screenY: payload?.screenY,
        normalizedScreenX: payload?.normalizedScreenX,
        normalizedScreenY: payload?.normalizedScreenY,
        viewportWidth: payload?.viewportWidth,
        viewportHeight: payload?.viewportHeight,
        screenPosition: payload?.screenPosition,
        position: payload?.position,
        lastTile: payload?.lastTile,
        worldX: payload?.worldX,
        center: payload?.center,
        building: payload?.building,
    };
}

export class AudioDirector {
    // `cues = { kit, governor }` is the engine-wide cue arbiter (one CueKit and
    // one CueGovernor per engine, owned by the controller): budgets and
    // cooldowns survive a preset switch. Without it the director stays mute.
    constructor({ engine, world = null, cues = null } = {}) {
        this.engine = engine;
        this.world = world;
        this.layers = {};
        this.cueKit = cues?.kit ?? null;
        this.governor = cues?.governor ?? null;
        this._weatherBed = false;
        this._primed = false;
        this.running = false;
        this.paused = false;
        this._interval = null;
        this._unsubscribes = [];
        this._signalUnsubscribes = [];
        this._signalRouting = true;
        this.hidden = false;
        this._hiddenSummonsHandler = null;
        this._atmosphere = null;
        this._atmosphereAt = 0;
        this._atmosphereSource = 'none';
        this._phase = 'day';
        this._levels = {};
        this._overrides = new Map();
        this._lastBellHour = null;
        // Thunder is weather: its own stream, never shared with work or cues.
        this._rng = rngStream('weather.thunder');
        this._actionable = new ActionableCueRouter();
        this._agentAudioContext = new Map();
        this._mode = 'character';
        this._quietFloor = { mode: 'active', calmSince: null, activeSince: null };
        this._framePressureLevel = 0;

        // Cue signals stay subscribed while audio is disabled so the
        // accessibility event stream remains useful without an AudioContext.
        this._subscribeSignals();
    }

    start() {
        if (this.running || !this.engine.context) return;
        this.running = true;
        this.paused = false;
        this._primed = false;
        // A rebuild after a long absence starts on a paused Transport.
        this.engine.transport.resume();
        // Layers feed this director's own group inputs, so a preset switch
        // can crossfade the whole director (plan 1.6).
        const options = { director: DIRECTOR_ID };
        this.layers = {
            wind: new WindLayer(this.engine, options),
            rain: new RainLayer(this.engine, options),
            birds: new BirdsLayer(this.engine, options),
            crickets: new CricketsLayer(this.engine, options),
            hum: new VillageHumLayer(this.engine, options),
            music: new Sequencer(this.engine, { ...options, preset: 'village' }),
        };
        for (const layer of Object.values(this.layers)) layer.start();

        this._subscribeRuntime();
        this._interval = setInterval(() => this._tick(), TICK_MS);
        this._tick();
    }

    // The shared governor's prepared routine cue is not this director's to
    // clear: during a crossfade it may belong to the incoming director.
    stop() {
        this.running = false;
        this.paused = false;
        clearInterval(this._interval);
        this._interval = null;
        for (const unsubscribe of this._unsubscribes) unsubscribe();
        this._unsubscribes = [];
        for (const layer of Object.values(this.layers)) layer.stop();
        this.layers = {};
    }

    // Pause in place (2.1, ENG-2): stop waking the Transport and the 1 Hz
    // mapping and close this director's groups over 80 ms. What is already
    // committed stays on the audio clock, which the controller then freezes
    // with `suspend()`, so a resume continues the same piece mid-phrase.
    // Returns the audio time at which the groups are silent.
    pause() {
        if (!this.running || this.paused) return this.engine.now();
        this.paused = true;
        clearInterval(this._interval);
        this._interval = null;
        this.engine.transport.pause();
        return this.engine.fadeDirector(DIRECTOR_ID, 0, { duration: PAUSE_CLOSE_SEC });
    }

    // Reopen over 250 ms and re-arm every process from the current audio
    // time: nothing missed while away is caught up.
    resume() {
        if (!this.running || !this.paused) return;
        this.paused = false;
        this.engine.fadeDirector(DIRECTOR_ID, 1, { duration: RESUME_OPEN_SEC });
        this.engine.transport.resume();
        this._interval = setInterval(() => this._tick(), TICK_MS);
        this._tick();
    }

    // The local clock's phase: the same source before and after an absence
    // (a hidden tab stops the World's broadcast), so comparing the two never
    // mistakes a stale broadcast for a change of phase.
    currentPhase() {
        return createAtmosphereSnapshot({}).phase || 'day';
    }

    destroy() {
        this.stop();
        for (const unsubscribe of this._signalUnsubscribes) unsubscribe();
        this._signalUnsubscribes = [];
        this.cueKit = null;
        this.governor = null;
        this._actionable.clear();
        this._agentAudioContext.clear();
    }

    setSignalRouting(enabled) {
        this._signalRouting = Boolean(enabled);
    }

    setHidden(hidden) {
        this.hidden = Boolean(hidden);
        this.governor?.clearRoutine();
    }

    setHiddenSummonsHandler(handler) {
        this._hiddenSummonsHandler = typeof handler === 'function' ? handler : null;
    }

    _subscribeSignals() {
        const on = (event, handler) => {
            this._signalUnsubscribes.push(eventBus.on(event, handler));
        };

        on('mode:changed', (mode) => {
            this._mode = mode === 'dashboard' ? 'dashboard' : 'character';
            this.governor?.clearRoutine();
        });
        on('agent:added', (agent) => this._rememberAgentAudioContext(agent));
        on('agent:updated', (agent) => this._rememberAgentAudioContext(agent));
        // Keep the last position/provider through the synchronous removal →
        // village:scene sequence so departures can retain their identity.
        on('agent:removed', (agent) => this._rememberAgentAudioContext(agent));

        on('village:scene', (scene) => {
            if (!this._signalRouting) return;
            const agentId = scene?.agentId ?? scene?.agent?.id ?? null;
            const label = scene?.agent?.name || scene?.agent?.agentName || scene?.label;
            const provider = this._agentProvider(scene, agentId);
            if (scene?.kind === 'arrival') {
                this.cue('arrival', {
                    agentId,
                    label,
                    provider,
                    teamName: this._agentTeam(scene, agentId),
                    ...spatialFields(scene),
                });
            }
            else if (scene?.kind === 'departure') {
                this.cue('departure', { agentId, label, provider, ...spatialFields(scene) });
                if (agentId != null) this._agentAudioContext.delete(agentId);
            }
        });

        on('distress:watchtower', (payload) => {
            if (!this._signalRouting) return;
            const kind = payload?.kind;
            const agentId = payload?.agentId ?? payload?.agent?.id ?? null;
            if (kind === 'errored' || kind === 'rate_limited') {
                this._playActionable(payload, kind);
            } else if (kind === 'recovered') {
                this._actionable.forget(agentId);
                this.cue('recovery', {
                    agentId,
                    label: this._agentLabel(payload, agentId),
                    provider: this._agentProvider(payload, agentId),
                    ...spatialFields(payload),
                });
            }
        });

        // A gathering is the ceremony its members' arrivals were part of: it
        // supersedes their routine aggregate instead of losing to its spacing.
        on('team:gather', (payload) => {
            if (!this._signalRouting) return;
            const members = Array.isArray(payload?.members) ? payload.members : [];
            this.cue('council', {
                agentId: payload?.agentId ?? null,
                teamName: payload?.teamName ?? null,
                teamSize: Array.isArray(payload?.members)
                    ? members.length
                    : payload?.teamSize ?? payload?.size,
                supersedes: members,
            });
        });
        on('chronicle:aurora', (payload) => {
            if (!this._signalRouting) return;
            this.cue('aurora', {
                agentId: payload?.agentId ?? null,
                // A release's aurora is its ceremony; the push it absorbs has
                // no voice until the outcome stratum (3.4).
                ...(payload?.reason === 'release' ? { supersedes: [] } : {}),
            });
        });
        // The one cue that is about the listener rather than the world.
        on('attention:raised', (payload) => {
            if (this._signalRouting) this._playActionable(payload, attentionStatus(payload, this.world));
        });

        // Thunder trails the visible lightning by a beat, like real distance;
        // the lag lives on the audio clock (the cue's lead), never a timer.
        on('weather:storm-flash', (payload) => {
            if (!this._signalRouting) return;
            const intensity = clamp01(payload?.intensity, 0.6);
            this.cue('thunder', { intensity, leadMs: rand(this._rng, 300, 1200) });
        });
    }

    _subscribeRuntime() {
        const on = (event, handler) => {
            this._unsubscribes.push(eventBus.on(event, handler));
        };

        on('atmosphere:updated', (snapshot) => {
            if (!snapshot) return;
            this._atmosphere = snapshot;
            this._atmosphereAt = Date.now();
            this._atmosphereSource = 'world';
        });
    }

    _rememberAgentAudioContext(agent) {
        const agentId = agent?.id;
        if (agentId == null) return;
        const previous = this._agentAudioContext.get(agentId) || {};
        this._agentAudioContext.set(agentId, {
            provider: agent?.provider || previous.provider || null,
            teamName: agent?.teamName || previous.teamName || null,
            position: copyPosition(agent?.position) || previous.position || null,
            spot: explicitSpot(agent) ?? previous.spot ?? null,
            building: buildingOf(agent) ?? previous.building ?? null,
            at: Date.now(),
        });
        // A removed agent can wait briefly for its departure scene. Keep this
        // cache bounded when a long-running village cycles many sessions.
        while (this._agentAudioContext.size > 128) {
            const oldest = this._agentAudioContext.keys().next().value;
            if (oldest == null) break;
            this._agentAudioContext.delete(oldest);
        }
    }

    _agentProvider(payload, agentId) {
        return payload?.provider
            || payload?.agent?.provider
            || this._agentAudioContext.get(agentId)?.provider
            || this.world?.agents?.get?.(agentId)?.provider
            || null;
    }

    _agentTeam(payload, agentId) {
        return payload?.agent?.teamName
            || this._agentAudioContext.get(agentId)?.teamName
            || this.world?.agents?.get?.(agentId)?.teamName
            || null;
    }

    // Both actionable events land here; the router picks the voice from the
    // bucket and spends one cue per agent entry. A hidden page hands the
    // routed cue to the controller's wake path instead of the suspended mix.
    _playActionable(payload, status) {
        const agentId = payload?.agentId ?? payload?.agent?.id ?? null;
        return this._actionable.route({ agentId, status }, (kind) => {
            const details = {
                ...spatialFields(payload),
                agentId,
                label: this._agentLabel(payload, agentId),
                provider: this._agentProvider(payload, agentId),
                status,
                waitingCount: payload?.waitingCount,
                oldestWaitMs: payload?.oldestWaitMs,
            };
            if (this.hidden && this._hiddenSummonsHandler) {
                this._hiddenSummonsHandler({ ...payload, ...details, audioCueKind: kind });
                return true;
            }
            return this.cue(kind, details);
        });
    }

    _agentLabel(payload, agentId) {
        return payload?.agent?.name
            || payload?.agent?.agentName
            || this.world?.agents?.get?.(agentId)?.name
            || payload?.label
            || payload?.reason
            || null;
    }

    cue(kind, extra = {}) {
        if (!this.cueKit) return false;
        const payload = { phase: this._phase, ...extra };
        const agentId = payload.agentId ?? payload.agent?.id ?? null;
        if (agentId != null && payload.provider == null) {
            payload.provider = this._agentProvider(payload, agentId);
        }
        // Placed once, here, when the cue is raised; CueKit turns the spot
        // into pan, distance and air at schedule time (plan S5).
        if (cuePlacementKind(kind)) {
            payload.spot ??= resolveCueSpot(payload, {
                agentId,
                dashboard: this._mode === 'dashboard',
                world: this.world,
                remembered: this._agentAudioContext.get(agentId),
            });
        }
        payload.lane = laneForCueKind(kind);
        if (cueLifecycleDecision({ lane: payload.lane, hidden: this.hidden }) !== 'play') {
            return false;
        }
        // The S2 window the bed-aware trim aims at: over weather, over the
        // composer's music, or the plain village bed.
        payload.bed ??= this._bedContext();
        return this.cueKit.play(kind, payload);
    }

    _bedContext() {
        if (this._weatherBed) return 'weather';
        return this.layers.music?.nowPlaying ? 'music' : 'village';
    }

    // QA hook: pin a layer's level for `holdMs`, overriding the tick mapping.
    forceLayer(name, level, holdMs = 15000) {
        if (!this.layers[name]) return false;
        this._overrides.set(name, { level: clamp01(level), until: Date.now() + holdMs });
        this.layers[name].setLevel(clamp01(level), 0.3);
        return true;
    }

    _currentAtmosphere() {
        if (this._atmosphere && Date.now() - this._atmosphereAt < ATMO_FRESH_MS) {
            return this._atmosphere;
        }
        this._atmosphereSource = 'local';
        return createAtmosphereSnapshot({});
    }

    _tick() {
        if (!this.running) return;
        const atmosphere = this._currentAtmosphere();
        const weather = atmosphere.weather || {};
        const phase = atmosphere.phase || 'day';
        const phaseProgress = clamp01(atmosphere.phaseProgress);
        const season = seasonTokenForAtmosphere(atmosphere) || 'summer';
        const counts = bucketCounts(this.world);
        const working = Number(counts.working) || 0;
        const calm = actionableAgents(this.world).length === 0
            && working === 0
            && Number(counts.watchlist) === 0;
        this._quietFloor = updateQuietFloor(this._quietFloor, {
            calm,
            now: Date.now(),
            enterAfterMs: QUIET_ENTER_MS,
            leaveAfterMs: QUIET_LEAVE_MS,
        });

        this._phase = phase;
        const light = daylight(phase, phaseProgress);
        const intensity = clamp01(weather.intensity);
        const winter = season === 'winter';
        // Winter precipitation falls as snow on screen: hush the rain layer
        // and let the wind carry the scene instead.
        const precipitation = winter
            ? clamp01(weather.precipitation) * 0.12
            : clamp01(weather.precipitation);
        const storm = weather.type === 'storm' ? intensity : 0;

        const levels = {
            wind: clamp01(0.05 + intensity * 0.5 + (winter && weather.precipitation > 0.1 ? 0.1 : 0)),
            rain: precipitation,
            birds: clamp01(
                (phase === 'dawn' ? 0.55 + phaseProgress * 0.45
                    : phase === 'day' ? 0.3
                        : phase === 'dusk' ? 0.12 * (1 - phaseProgress) : 0)
                * (1 - precipitation * 0.9)
                * (1 - intensity * 0.35)
                * (BIRD_SEASON[season] ?? 1),
            ),
            crickets: cricketLevel({ phase, phaseProgress, season, precipitation, storm }),
            hum: clamp01(working / 6) * (0.25 + 0.75 * light),
            music: VILLAGE_MUSIC_LEVEL * (phase === 'night' ? 0.7 : 1),
        };

        // Diagnostics only: GPU load never changes what the village sounds
        // like — a busy frame is not a quieter world.
        this._framePressureLevel = this._readFramePressure();

        const resting = this._quietFloor.mode === 'resting';
        // Snow is hushed rain, not weather the wind must yield to.
        const heardRain = winter ? 0 : levels.rain;
        const ceilingDb = applyWorldBudgets(levels, { precipitation: heardRain, storm, resting });
        this._weatherBed = heardRain > RAIN_AUDIBLE || storm > 0;

        for (const [name, override] of this._overrides) {
            if (Date.now() > override.until) this._overrides.delete(name);
            else levels[name] = override.level;
        }

        // The first tick after start() sets every layer at its target at once:
        // the director's own crossfade gain carries the fade-in (plan 1.6),
        // so slow slews here would leave a hole under the switch.
        const prime = this._primed ? null : PRIME_TIME_CONSTANT;
        this._primed = true;
        this.engine.setWeatherCeiling(ceilingDb, prime ?? 4);
        this.engine.setTilt(phase);
        // Island Air follows the phase (a 6 s crossfade between the day and
        // night rooms) and lets rain and fog colour its return (S5).
        this.engine.setAirPhase(phase);
        this.engine.setAirWeather({ rain: precipitation, fog: clamp01(weather.fog) });
        this.layers.wind.setWind({
            strength: levels.wind,
            wind: Math.abs(Number(weather.windX) || 0),
            fog: clamp01(weather.fog),
        }, prime);
        this.layers.rain.setPrecipitation(levels.rain, prime ?? 4);
        this.layers.rain.setStorm(storm, prime ?? 6);
        this.layers.birds.setLevel(levels.birds, prime ?? 3);
        this.layers.crickets.setLevel(levels.crickets, prime ?? 3);
        this.layers.hum.setLevel(levels.hum, prime ?? 3);
        this.layers.music.setLevel(levels.music, prime ?? 3);
        this.layers.music.setPhase(phase);
        this.layers.music.setRestScale(1 - clamp01(working / 8) * 0.35);
        this._levels = levels;

        // Hour bell during waking hours.
        const clock = atmosphere.clock || {};
        if (clock.minutes === 0 && clock.hours >= 8 && clock.hours <= 20
            && this._lastBellHour !== clock.hours) {
            if (this.cue('hourBell')) this._lastBellHour = clock.hours;
        }

        // Storm thunder fallback when the World loop (and its flash events)
        // is not running — Poisson-ish, roughly one strike per 15–25 ticks.
        if (storm > 0 && this._atmosphereSource === 'local' && this._rng() < 0.03 + storm * 0.04) {
            this.cue('thunder', { intensity: storm });
        }
    }

    snapshot() {
        return {
            running: this.running,
            state: this.hidden
                ? 'hidden'
                : (this.running ? this._quietFloor.mode : 'stopped'),
            resting: this.running && this._quietFloor.mode === 'resting',
            phase: this._phase,
            framePressureLevel: this._framePressureLevel,
            atmosphereSource: this._atmosphereSource,
            levels: { ...this._levels },
            lastCue: this.cueKit?.lastCue || null,
            nowPlaying: this.layers.music?.nowPlaying || null,
            ceremonies: this.governor?.snapshot().ceremonies ?? null,
        };
    }

    _readFramePressure() {
        try {
            const snapshot = globalThis.window?.__claudeVillePerf?.frameHealth?.();
            const level = Number(snapshot?.level);
            return Number.isFinite(level) ? Math.max(0, Math.min(3, Math.round(level))) : 0;
        } catch {
            return 0;
        }
    }
}
