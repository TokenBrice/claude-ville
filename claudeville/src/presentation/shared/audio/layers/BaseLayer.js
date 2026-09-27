// Common plumbing for a player layer (the Town band's Sequencer): an output
// gain on the layer's group (through its director's crossfade gain), smooth
// intensity targeting, a seeded random stream, Transport registration for
// scheduled layers, Island Air sends taken after the layer's level
// (C-AMB-2), and teardown that ramps to silence before anything stops so
// stops never click.

import { MIN_GAIN } from '../AudioEngine.js';
import { rngStream } from '../Rng.js';

export class BaseLayer {
    // `group` names the engine fader the layer feeds ('music'); the fader
    // moves, never `level`, so a quieter group keeps its density. `director`
    // names the director that owns the layer ('bgm'), whose group gain
    // carries the preset crossfade. `rng` names the layer's own seeded stream
    // (S6: a player never shares one with cue code).
    constructor(engine, { trim = 0.1, group = null, director = null, rng = null } = {}) {
        if (!group) throw new Error(`${new.target.name} needs a mixer group`);
        if (!director) throw new Error(`${new.target.name} needs a director`);
        this.engine = engine;
        this.trim = trim;
        this.group = group;
        this.director = director;
        this.rng = rngStream(rng || new.target.name);
        this.level = 0;
        this.running = false;
        this.out = null;
        this.airOut = null;
        this._nodes = [];
        this._sources = [];
        this._processes = new Set();
    }

    start() {
        if (this.running || !this.engine.context) return;
        const ctx = this.engine.context;
        this.out = ctx.createGain();
        this.out.gain.value = MIN_GAIN;
        this.out.connect(this.engine.groupInput(this.group, this.director));
        this.running = true;
        this._start(ctx);
    }

    // Subclasses build their graph here; nodes registered via track()/trackSource().
    _start(_ctx) {}

    // Intensity 0..1, scaled by the layer's mix trim. Long time constants keep
    // every change inaudible as a transition.
    setLevel(value, timeConstant = 3) {
        this.level = Math.max(0, Math.min(1, Number(value) || 0));
        if (!this.out || !this.engine.context) return;
        const target = this._levelGain();
        const now = this.engine.now();
        this.out.gain.setTargetAtTime(target, now, timeConstant);
        this.airOut?.gain.setTargetAtTime(target, now, timeConstant);
    }

    _levelGain() {
        return Math.max(MIN_GAIN, this.level * this.trim);
    }

    track(...nodes) {
        for (const node of nodes) if (node) this._nodes.push(node);
    }

    trackSource(...sources) {
        for (const source of sources) if (source) this._sources.push(source);
    }

    // Put a scheduler on the engine Transport (S4): `proc.schedule(from, to)`
    // places sounds in audio time; timers never do. Unregistered on stop().
    registerProcess(proc) {
        if (!this.running || !proc) return proc;
        this._processes.add(proc);
        return this.engine.transport.register(proc);
    }

    unregisterProcess(proc) {
        if (!this._processes.delete(proc)) return;
        this.engine.transport.unregister(proc);
    }

    // An Island Air send of `amount` (linear), after the layer's level so dry
    // and wet move together (C-AMB-2), through the director crossfade and the
    // group fader. Without `from` it taps the layer output; `from` is a node
    // upstream of the output (a sub-bus), routed through `airOut`, a gain
    // that mirrors the layer level. Returns the send gain (automate `.gain`).
    airSend(amount, from = null) {
        if (!this.out) return null;
        const route = { group: this.group, director: this.director };
        if (!from || from === this.out) {
            const send = this.engine.airSendFrom(this.out, amount, route);
            this.track(send);
            return send;
        }
        if (!this.airOut) {
            this.airOut = this.engine.context.createGain();
            this.airOut.gain.value = this.out.gain.value;
            this.airOut.gain.setTargetAtTime(this._levelGain(), this.engine.now(), 0.05);
            this.track(this.engine.airSendFrom(this.airOut, 1, route));
        }
        const send = this.engine.context.createGain();
        send.gain.value = Math.max(0, Number(amount) || 0);
        from.connect(send).connect(this.airOut);
        this.track(send);
        return send;
    }

    // Declicked stop (S8): hold the output where it is, ramp it linearly to
    // silence over 80 ms, stop every source just after silence, and
    // disconnect once the ramp is certainly done. Returns the audio time at
    // which the output is silent, so subclasses can stop their own transient
    // voices there too.
    stop() {
        if (!this.running) return undefined;
        this.running = false;
        for (const proc of this._processes) this.engine.transport.unregister(proc);
        this._processes.clear();

        const silentAt = this.out ? this.engine.stopGroup(this.out, 0.08) : this.engine.now();
        if (this.airOut) this.engine.stopGroup(this.airOut, 0.08);
        for (const source of this._sources) {
            try { source.stop(silentAt + 0.01); } catch { /* already stopped */ }
        }
        const doomed = [...this._sources, ...this._nodes, this.out, this.airOut];
        const disconnectMs = Math.max(0, (silentAt - this.engine.now() + 0.2) * 1000);
        setTimeout(() => {
            for (const node of doomed) {
                try { node?.disconnect?.(); } catch { /* already disconnected */ }
            }
        }, disconnectMs);
        this._sources = [];
        this._nodes = [];
        this.out = null;
        this.airOut = null;
        return silentAt;
    }
}
