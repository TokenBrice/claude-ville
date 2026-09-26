// Common plumbing for ambience layers: an output gain on the layer's group
// (through its director's crossfade gain), smooth intensity targeting, timer
// bookkeeping for scheduled layers, and teardown that ramps to silence
// before anything stops so stops never click.

import { MIN_GAIN } from '../AudioEngine.js';

export class BaseLayer {
    // `group` names the engine fader the layer feeds ('wind', 'rain',
    // 'wildlife', 'hum', 'music'); the mixer trims move that fader, never
    // `level`, so a quieter group keeps its density. `director` names the
    // director that owns the layer ('ambient' or 'bgm'), whose group gain
    // carries the preset crossfade.
    constructor(engine, { trim = 0.1, group = null, director = 'ambient' } = {}) {
        if (!group) throw new Error(`${new.target.name} needs a mixer group`);
        this.engine = engine;
        this.trim = trim;
        this.group = group;
        this.director = director;
        this.level = 0;
        this.running = false;
        this.out = null;
        this._nodes = [];
        this._sources = [];
        this._timers = new Set();
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
        const target = Math.max(MIN_GAIN, this.level * this.trim);
        this.out.gain.setTargetAtTime(target, this.engine.now(), timeConstant);
    }

    track(...nodes) {
        for (const node of nodes) if (node) this._nodes.push(node);
    }

    trackSource(...sources) {
        for (const source of sources) if (source) this._sources.push(source);
    }

    // setTimeout wrapper that self-cleans and no-ops after stop().
    timer(fn, ms) {
        const id = setTimeout(() => {
            this._timers.delete(id);
            if (this.running) fn();
        }, ms);
        this._timers.add(id);
        return id;
    }

    // Declicked stop (S8): hold the output where it is, ramp it linearly to
    // silence over 80 ms, stop every source just after silence, and
    // disconnect once the ramp is certainly done. Returns the audio time at
    // which the output is silent, so subclasses can stop their own transient
    // voices there too.
    stop() {
        if (!this.running) return undefined;
        this.running = false;
        for (const id of this._timers) clearTimeout(id);
        this._timers.clear();

        const silentAt = this.out ? this.engine.stopGroup(this.out, 0.08) : this.engine.now();
        for (const source of this._sources) {
            try { source.stop(silentAt + 0.01); } catch { /* already stopped */ }
        }
        const doomed = [...this._sources, ...this._nodes, this.out];
        const disconnectMs = Math.max(0, (silentAt - this.engine.now() + 0.2) * 1000);
        setTimeout(() => {
            for (const node of doomed) {
                try { node?.disconnect?.(); } catch { /* already disconnected */ }
            }
        }, disconnectMs);
        this._sources = [];
        this._nodes = [];
        this.out = null;
        return silentAt;
    }
}
