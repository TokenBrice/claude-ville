// Director for BGM mode: continuous town music instead of the reactive
// ambience. Music-first by design — no wind/rain/wildlife layers — with
// village event cues ringing over the score like game jingles (they duck
// the music through the engine's cue bus). Time of day picks the playlist;
// the phase comes from the renderer's atmosphere broadcast, with a pure
// local-clock fallback when the World loop is stopped.

import { eventBus } from '../../../domain/events/DomainEvent.js';
import { createAtmosphereSnapshot } from '../../character-mode/AtmosphereState.js';
import { CueGovernor } from './CueGovernor.js';
import { CueKit } from './cues/CueKit.js';
import { BgmPlayer } from './bgm/BgmPlayer.js';

const TICK_MS = 1000;
const ATMO_FRESH_MS = 3000;
const AGENT_CUE_DEDUPE_MS = 2500;

function cuePayload(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const agent = source.agent && typeof source.agent === 'object' ? source.agent : {};
    return {
        // Keep the original event fields (position, urgency, provider-specific
        // context, and any future additions) intact for CueKit consumers.
        ...source,
        agentId: source.agentId ?? agent.id ?? source.id ?? null,
        label: agent.name || agent.displayName || agent.agentName
            || source.agentName || source.displayName || source.name || source.label || null,
        provider: source.provider || agent.provider || null,
    };
}

export class BgmDirector {
    constructor({ engine } = {}) {
        this.engine = engine;
        this.player = null;
        this.cueKit = null;
        this.governor = new CueGovernor();
        this.running = false;
        this._interval = null;
        this._unsubscribes = [];
        this._atmosphere = null;
        this._atmosphereAt = 0;
        this._atmosphereSource = 'none';
        this._phase = 'day';
        this._lastBellHour = null;
        this._recentAgentCues = new Map();
    }

    start() {
        if (this.running || !this.engine.context) return;
        this.running = true;

        this.player = new BgmPlayer(this.engine);
        this.player.start();
        this.player.setLevel(0.9, 0.5);
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
        for (const unsubscribe of this._unsubscribes) unsubscribe();
        this._unsubscribes = [];
        this.player?.stop();
        this.player = null;
        this.cueKit = null;
        this._recentAgentCues.clear();
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
            if (scene?.kind === 'arrival') this.cue('arrival', cuePayload(scene));
            else if (scene?.kind === 'departure') this.cue('departure', cuePayload(scene));
        });
        on('distress:watchtower', (payload) => {
            const kind = payload?.kind;
            if (kind === 'errored' || kind === 'rate_limited') {
                this._playAgentCue('distress', cuePayload(payload));
            } else if (kind === 'recovered') {
                const details = cuePayload(payload);
                this._recentAgentCues.delete(details.agentId);
                this.cue('recovery', details);
            }
        });
        on('team:gather', (payload) => this.cue('council', {
            ...cuePayload(payload),
            teamSize: Array.isArray(payload?.members)
                ? payload.members.length
                : payload?.teamSize ?? payload?.size,
        }));
        on('chronicle:aurora', (payload) => this.cue('aurora', cuePayload(payload)));
        // The one cue that is about the listener rather than the world.
        on('attention:raised', payload => this._playAgentCue('summons', cuePayload(payload)));
    }

    _agentCueIsRecent(agentId) {
        if (agentId == null || agentId === '') return false;
        const recent = this._recentAgentCues.get(agentId);
        if (!recent) return false;
        if (Date.now() - recent.at >= AGENT_CUE_DEDUPE_MS) {
            this._recentAgentCues.delete(agentId);
            return false;
        }
        return true;
    }

    _playAgentCue(kind, payload) {
        const agentId = payload?.agentId ?? payload?.agent?.id ?? null;
        if (this._agentCueIsRecent(agentId)) return false;
        const played = this.cue(kind, payload);
        if (played && agentId != null && agentId !== '') {
            this._recentAgentCues.set(agentId, { kind, at: Date.now() });
        }
        return played;
    }

    cue(kind, extra = {}) {
        if (!this.cueKit) return false;
        return this.cueKit.play(kind, { phase: this._phase, ...extra });
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
        this._phase = atmosphere.phase || 'day';
        this.player.setPhase(this._phase);

        const clock = atmosphere.clock || {};
        if (clock.minutes === 0 && clock.hours >= 8 && clock.hours <= 20
            && this._lastBellHour !== clock.hours) {
            if (this.cue('hourBell')) this._lastBellHour = clock.hours;
        }
    }

    snapshot() {
        return {
            running: this.running,
            phase: this._phase,
            atmosphereSource: this._atmosphereSource,
            levels: { bgm: this.player?.level ?? 0 },
            lastCue: this.cueKit?.lastCue || null,
            nowPlaying: this.player?.nowPlaying || null,
        };
    }
}
