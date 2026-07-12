// The soundscape brain. Once per second it reads the world — atmosphere
// snapshot (time-of-day phase, weather, season) and agent stats — and steers
// each ambience layer's intensity with slow slews. Discrete village moments
// arrive over the event bus and become one-shot cues behind the governor.
//
// Atmosphere source: the World renderer broadcasts its per-frame snapshot as
// `atmosphere:updated` (so debug overrides and village weather influence are
// heard, not just seen). When that stream goes quiet — Dashboard mode stops
// the render loop — the director computes its own snapshot; AtmosphereState
// is pure local-clock, so ambience keeps tracking time and weather anywhere.

import { eventBus } from '../../../domain/events/DomainEvent.js';
import { createAtmosphereSnapshot } from '../../character-mode/AtmosphereState.js';
import { seasonTokenForAtmosphere } from '../../character-mode/SeasonalAmbience.js';
import { clamp01, rand } from './AudioEngine.js';
import { scaleForPhase } from './MusicalScale.js';
import { CueGovernor } from './CueGovernor.js';
import { CueKit } from './cues/CueKit.js';
import { WindLayer } from './layers/WindLayer.js';
import { RainLayer } from './layers/RainLayer.js';
import { BirdsLayer } from './layers/BirdsLayer.js';
import { CricketsLayer } from './layers/CricketsLayer.js';
import { VillageHumLayer } from './layers/VillageHumLayer.js';
import { TonalBedLayer } from './layers/TonalBedLayer.js';
import { MusicLayer } from './layers/MusicLayer.js';

const TICK_MS = 1000;
const ATMO_FRESH_MS = 3000;

const BED_LEVEL_BY_PHASE = { dawn: 0.55, day: 0.15, dusk: 0.6, night: 0.32 };
const BIRD_SEASON = { winter: 0.25, spring: 1, summer: 1, autumn: 0.7 };
const CRICKET_SEASON = { winter: 0, spring: 0.45, summer: 1, autumn: 0.55 };

// Daylight 0..1: 1 through the day, ramping through dawn/dusk, 0 at night.
function daylight(phase, phaseProgress) {
    if (phase === 'day') return 1;
    if (phase === 'dawn') return phaseProgress;
    if (phase === 'dusk') return 1 - phaseProgress;
    return 0;
}

export class AudioDirector {
    constructor({ engine, world = null } = {}) {
        this.engine = engine;
        this.world = world;
        this.layers = {};
        this.cueKit = null;
        this.governor = new CueGovernor();
        this.running = false;
        this._interval = null;
        this._unsubscribes = [];
        this._atmosphere = null;
        this._atmosphereAt = 0;
        this._atmosphereSource = 'none';
        this._phase = 'day';
        this._levels = {};
        this._overrides = new Map();
        this._lastBellHour = null;
        this._thunderTimers = new Set();
    }

    start() {
        if (this.running || !this.engine.context) return;
        this.running = true;

        this.layers = {
            wind: new WindLayer(this.engine),
            rain: new RainLayer(this.engine),
            birds: new BirdsLayer(this.engine),
            crickets: new CricketsLayer(this.engine),
            hum: new VillageHumLayer(this.engine),
            bed: new TonalBedLayer(this.engine),
            music: new MusicLayer(this.engine),
        };
        for (const layer of Object.values(this.layers)) layer.start();
        this.cueKit = new CueKit(this.engine, this.governor);

        this._subscribe();
        this._interval = setInterval(() => this._tick(), TICK_MS);
        this._tick();
    }

    stop() {
        if (!this.running) return;
        this.running = false;
        if (this._interval) clearInterval(this._interval);
        this._interval = null;
        for (const id of this._thunderTimers) clearTimeout(id);
        this._thunderTimers.clear();
        for (const unsubscribe of this._unsubscribes) unsubscribe();
        this._unsubscribes = [];
        for (const layer of Object.values(this.layers)) layer.stop();
        this.layers = {};
        this.cueKit = null;
    }

    _subscribe() {
        const on = (event, handler) => {
            this._unsubscribes.push(eventBus.on(event, handler));
        };

        on('atmosphere:updated', (snapshot) => {
            if (!snapshot) return;
            this._atmosphere = snapshot;
            this._atmosphereAt = Date.now();
            this._atmosphereSource = 'world';
        });

        on('village:scene', (scene) => {
            if (scene?.kind === 'arrival') this.cue('arrival');
            else if (scene?.kind === 'departure') this.cue('departure');
        });

        on('distress:watchtower', (payload) => {
            const kind = payload?.kind;
            if (kind === 'errored' || kind === 'rate_limited') this.cue('distress');
            else if (kind === 'recovered') this.cue('recovery');
        });

        on('team:gather', () => this.cue('council'));
        on('chronicle:aurora', () => this.cue('aurora'));

        // Thunder trails the visible lightning by a beat, like real distance.
        on('weather:storm-flash', (payload) => {
            const intensity = clamp01(payload?.intensity, 0.6);
            const id = setTimeout(() => {
                this._thunderTimers.delete(id);
                if (this.running) this.cue('thunder', { intensity });
            }, rand(300, 1200));
            this._thunderTimers.add(id);
        });
    }

    cue(kind, extra = {}) {
        if (!this.cueKit) return false;
        return this.cueKit.play(kind, { phase: this._phase, ...extra });
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
        const stats = this.world?.getStats?.() || {};
        const working = Number(stats.working) || 0;

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
            crickets: clamp01(
                (phase === 'night' ? Math.min(phaseProgress, 1 - phaseProgress) * 10 : 0)
                * (CRICKET_SEASON[season] ?? 0.5)
                * (1 - precipitation * 0.8),
            ),
            hum: clamp01(working / 6) * (0.25 + 0.75 * light),
            bed: BED_LEVEL_BY_PHASE[phase] ?? 0.2,
            music: clamp01(0.75 * (phase === 'night' ? 0.7 : 1) * (storm > 0 ? 0.4 : 1)),
        };

        for (const [name, override] of this._overrides) {
            if (Date.now() > override.until) this._overrides.delete(name);
            else levels[name] = override.level;
        }

        const scale = scaleForPhase(phase);
        this.layers.wind.setWind({
            strength: levels.wind,
            wind: Math.abs(Number(weather.windX) || 0),
            fog: clamp01(weather.fog),
        });
        this.layers.rain.setPrecipitation(levels.rain);
        this.layers.rain.setStorm(storm);
        this.layers.birds.setLevel(levels.birds);
        this.layers.crickets.setLevel(levels.crickets);
        this.layers.hum.setLevel(levels.hum);
        this.layers.bed.setLevel(levels.bed, 6);
        this.layers.bed.setScale(scale);
        this.layers.music.setLevel(levels.music);
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
        if (storm > 0 && this._atmosphereSource === 'local' && Math.random() < 0.03 + storm * 0.04) {
            this.cue('thunder', { intensity: storm });
        }
    }

    snapshot() {
        return {
            running: this.running,
            phase: this._phase,
            atmosphereSource: this._atmosphereSource,
            levels: { ...this._levels },
            lastCue: this.cueKit?.lastCue || null,
            nowPlaying: this.layers.music?.nowPlaying || null,
        };
    }
}
