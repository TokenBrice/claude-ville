import test from 'node:test';
import assert from 'node:assert/strict';

import * as SoundSettings from '../../claudeville/src/presentation/shared/SoundSettings.js';
import { AmbientAudioController } from '../../claudeville/src/presentation/shared/AmbientAudioController.js';
import { BgmDirector } from '../../claudeville/src/presentation/shared/audio/BgmDirector.js';
import { SignalDirector, URGENT_SOUNDING } from '../../claudeville/src/presentation/shared/audio/SignalDirector.js';
import { CueGovernor } from '../../claudeville/src/presentation/shared/audio/CueGovernor.js';
import { CueKit, laneForCueKind } from '../../claudeville/src/presentation/shared/audio/cues/CueKit.js';
import { AudioEngine } from '../../claudeville/src/presentation/shared/audio/AudioEngine.js';
import { VOICE_REGISTRY } from '../../claudeville/src/presentation/shared/audio/Loudness.js';
import { VOICES } from '../../claudeville/src/presentation/shared/audio/music/Voicings.js';
import { INSTRUMENTS } from '../../claudeville/src/presentation/shared/audio/music/Instruments.js';
import { cueCaptionShown } from '../../claudeville/src/presentation/shared/Toast.js';
import { SettingsPanel } from '../../claudeville/src/presentation/shared/SettingsPanel.js';
import { TopBar } from '../../claudeville/src/presentation/shared/TopBar.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

function memoryStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: key => (values.has(key) ? values.get(key) : null),
        setItem: (key, value) => values.set(key, String(value)),
    };
}

function collectEvents(name) {
    const payloads = [];
    const off = eventBus.on(name, payload => payloads.push(payload));
    return { payloads, off };
}

function fakeParam(value = 1) {
    return {
        value,
        setValueAtTime() {},
        linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {},
        setTargetAtTime() {},
        cancelScheduledValues() {},
    };
}

const fakeNode = (extra = {}) => ({ connect: n => n, disconnect() {}, ...extra });

function spyEngine() {
    let voices = 0;
    let ducks = 0;
    const engine = {
        started: true,
        softened: false,
        now: () => 10,
        connectVoice() {
            voices++;
            return { output: fakeNode(), dispose() {} };
        },
        bedLoudness: () => -45,
        releaseVoice() {},
        duck() {
            ducks++;
            return { cancel() {} };
        },
        context: {
            state: 'running',
            sampleRate: 48000,
            currentTime: 10,
            createGain: () => fakeNode({ gain: fakeParam() }),
            createBiquadFilter: () => fakeNode({ type: 'lowpass', frequency: fakeParam(350), Q: fakeParam(1), gain: fakeParam(0) }),
            createOscillator: () => fakeNode({ frequency: fakeParam(440), type: 'sine', start() {}, stop() {} }),
            createBufferSource: () => fakeNode({ playbackRate: fakeParam(1), start() {}, stop() {} }),
        },
    };
    return {
        engine,
        get voices() { return voices; },
        get ducks() { return ducks; },
        reset() { voices = 0; ducks = 0; },
    };
}

// ---------------------------------------------------------------------------
// 3.A — 4th Preset (`Town band only`), seamless bgm ↔ bgmOnly, bell-state, hush
// ---------------------------------------------------------------------------

test('3.A: Town band only switches in place from Town band with zero crossfade or restart', () => {
    const log = [];
    const bellStates = collectEvents('audio:bell-state');
    const makeDirector = (id) => ({
        running: false,
        paused: false,
        cuesEnabled: true,
        signals: false,
        start() { this.running = true; log.push(`${id}:start`); },
        stop() { this.running = false; log.push(`${id}:stop`); },
        setSignalRouting(on) { this.signals = on; },
        setCuesEnabled(on) { this.cuesEnabled = on; log.push(`${id}:cues:${on}`); },
    });

    const controller = Object.create(AmbientAudioController.prototype);
    Object.assign(controller, {
        _destroyed: false,
        _windowBlurred: false,
        _quietMix: { active: false, preset: null },
        _crossfadeStops: new Map(),
        _playingMode: 'bgm',
        _silenced: false,
        _quietActive: false,
        hushedUntil: 0,
        available: true,
        background: 'play',
        enabled: true,
        mode: 'bgm',
        volumeStep: 6,
        directors: { signals: makeDirector('signals'), bgm: makeDirector('bgm') },
        engine: {
            context: { state: 'running' },
            now: () => 10,
            setVolumeStep() {},
            setGroupLevel() {},
            setBedCompensation() {},
            fadeDirector: (id, to, { duration }) => {
                log.push(`${id}->${to}@${duration}`);
                return 0.01;
            },
        },
        _publishView() {},
    });
    controller.directors.bgm.running = true;

    try {
        // Town band → Town band only: in place, no fade, no stop/start.
        controller.setPreset('townBandOnly');
        assert.equal(controller.mode, 'bgmOnly');
        assert.equal(controller._playingMode, 'bgmOnly');
        assert.equal(controller.directors.bgm.running, true);
        assert.equal(controller.directors.bgm.cuesEnabled, false);
        assert.equal(controller.directors.signals.cuesEnabled, false);
        assert.deepEqual(log, ['bgm:cues:false', 'signals:cues:false']);
        assert.deepEqual(bellStates.payloads.at(-1), { rings: false }, 'OS Desktop Alerts stay unmuted in Town band only');

        // Town band only → Town band: also in place, no fade, no stop/start.
        log.length = 0;
        controller.setPreset('townBand');
        assert.equal(controller.mode, 'bgm');
        assert.equal(controller._playingMode, 'bgm');
        assert.equal(controller.directors.bgm.running, true);
        assert.equal(controller.directors.bgm.cuesEnabled, true);
        assert.equal(controller.directors.signals.cuesEnabled, true);
        assert.deepEqual(log, ['bgm:cues:true', 'signals:cues:true']);
        assert.deepEqual(bellStates.payloads.at(-1), { rings: true });
    } finally {
        bellStates.off();
    }
});

test('3.A: hush and quiet hours in Town band only stop music cleanly without turning bells on', () => {
    const log = [];
    const bellStates = collectEvents('audio:bell-state');
    const makeDirector = (id) => ({
        running: false,
        paused: false,
        cuesEnabled: false,
        signals: false,
        start() { this.running = true; log.push(`${id}:start`); },
        stop() { this.running = false; log.push(`${id}:stop`); },
        setSignalRouting(on) { this.signals = on; },
        setCuesEnabled(on) { this.cuesEnabled = on; },
    });

    const controller = Object.create(AmbientAudioController.prototype);
    Object.assign(controller, {
        _destroyed: false,
        _gestureSeen: true,
        _windowBlurred: false,
        _quietMix: { active: false, preset: null },
        _crossfadeStops: new Map(),
        _playingMode: 'bgmOnly',
        _silenced: false,
        _quietActive: false,
        _recalibrated: false,
        hushedUntil: 0,
        quietHours: 'off',
        output: 'speakers',
        soften: 'auto',
        available: true,
        background: 'play',
        enabled: true,
        mode: 'bgmOnly',
        volumeStep: 6,
        directors: { signals: makeDirector('signals'), bgm: makeDirector('bgm') },
        engine: {
            context: { state: 'running' },
            now: () => 10,
            setVolumeStep() {},
            setGroupLevel() {},
            setBedCompensation() {},
            fadeDirector: (id, to, { duration }) => {
                log.push(`${id}->${to}@${duration}`);
                return 0.01;
            },
        },
        _publishView() {},
    });
    controller.directors.bgm.running = true;

    try {
        // Away copy in Town band only drops "· signals still ring".
        assert.equal(controller._nowLine('away'), "Paused while you're away");

        // Hush in bgmOnly: effective mode is null, bgm stops, signals NEVER starts.
        controller.hush(60_000);
        assert.equal(controller._effectiveMode(), null);
        assert.equal(controller.directors.bgm.running, false);
        assert.equal(controller.directors.signals.running, false);
        assert.equal(controller._silenced, true);
        assert.equal(controller.isRunning(), true);
        assert.equal(controller.soundView().soundState, 'hushed');
        assert.deepEqual(bellStates.payloads.at(-1), { rings: false });
        assert.ok(!log.includes('signals:start'), 'signals must never start when hushed in Town band only');

        // Resume from hush: bgm restarts with cues still disabled.
        log.length = 0;
        controller.resumeFromHush();
        assert.equal(controller._effectiveMode(), 'bgmOnly');
        assert.equal(controller._silenced, false);
        assert.equal(controller.directors.bgm.running, true);
        assert.equal(controller.directors.bgm.cuesEnabled, false);
        assert.equal(controller.directors.signals.running, false);
        assert.ok(log.includes('bgm:start'));
        assert.ok(!log.includes('signals:start'));

        // Quiet hours in bgmOnly follow the exact same path.
        log.length = 0;
        controller._quietActive = true;
        controller._applyEffectiveMode();
        assert.equal(controller.directors.bgm.running, false);
        assert.equal(controller.directors.signals.running, false);
        assert.equal(controller._silenced, true);

        log.length = 0;
        controller._quietActive = false;
        controller._applyEffectiveMode();
        assert.equal(controller.directors.bgm.running, true);
        assert.equal(controller.directors.bgm.cuesEnabled, false);
        assert.equal(controller.directors.signals.running, false);
    } finally {
        bellStates.off();
    }
});

test('3.A: Town band only never wakes AudioContext on hidden summons or reminders', async () => {
    const events = [];
    const controller = Object.create(AmbientAudioController.prototype);
    Object.assign(controller, {
        _destroyed: false,
        _visibilityGeneration: 1,
        _hiddenSummonsPending: new Set(),
        _suspendTimer: null,
        _wakeToken: 0,
        _wakeHoldUntil: 0,
        _wakeCount: 0,
        _windowBlurred: true,
        _quietActive: false,
        _ladderHistory: [],
        _ladderWait: null,
        hushedUntil: 0,
        background: 'signals',
        _gestureSeen: true,
        enabled: true,
        mode: 'bgmOnly',
        available: true,
        cues: { kit: { lastLevel: null } },
        engine: {
            now: () => 10,
            wake: async () => { events.push('wake'); return true; },
            endWake: async () => { events.push('endWake'); return true; },
            suspend: async () => { events.push('suspend'); },
        },
        directors: {
            signals: {
                running: false,
                cue: (kind, payload) => events.push(`signals:${kind}:${payload.announceOnly}`),
                playReminder: () => false,
            },
            bgm: {
                running: true,
                playReminder: (reminder) => { events.push(`bgm:reminder:${reminder.announceOnly}`); return true; },
            },
        },
    });

    assert.equal(controller._signalsAudible(), false);
    controller._handleHiddenSummons({ agentId: 'a1', audioCueKind: 'summons' });
    controller._playReminder(
        { family: 'needsYou', level: 2, agentId: 'a1', count: 1, oldestMs: 120_000 },
        [{ id: 'a1', name: 'Aurora' }],
        Date.now(),
    );
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(events.includes('wake'), false, 'AudioContext must never wake in Town band only');
    assert.ok(events.includes('signals:summons:true'), 'hidden summons routes announceOnly');
    assert.ok(events.includes('bgm:reminder:true'), 'reminder routes announceOnly');
});

// ---------------------------------------------------------------------------
// 3.B — Urgent-Only Signal Diet across Signals, Town band, and Town band only
// ---------------------------------------------------------------------------

const ROUTINE_AND_OUTCOME_KINDS = [
    ['turnDone', { count: 1, long: false }],
    ['turnDone', { count: 1, long: true, durationMs: 180_000 }],
    ['answered', {}],
    ['recovery', {}],
    ['arrival', {}],
    ['departure', {}],
    ['council', { teamName: 'Harbor', teamSize: 3 }],
    ['subagentReturn', { count: 1 }],
    ['dispatch', { count: 2 }],
    ['toolFailed', { count: 1 }],
    ['pushFailed', {}],
    ['commit', { repo: 'cv' }],
    ['mended', {}],
    ['push', { repo: 'cv' }],
    ['release', { version: 'v0.69.0' }],
    ['aurora', {}],
    ['hourBell', { hour: 15 }],
    ['linkRestored', {}],
    ['digest', { notes: ['gold', 'amber'] }],
];

test('3.B: Signals and Town band sound only URGENT_SOUNDING; routine/outcome/long-turn cues stay silent', () => {
    assert.deepEqual([...URGENT_SOUNDING].sort(), ['distress', 'limit', 'linkLost', 'reminder', 'summons']);

    const spy = spyEngine();
    const governor = new CueGovernor({ maxPerMinute: 120, minSpacingMs: 0 });
    const kit = new CueKit(spy.engine, governor);

    const signals = new SignalDirector({
        engine: spy.engine,
        cues: { governor, kit },
    });
    signals.setHiddenSummonsHandler(() => { throw new Error('must not wake hidden summons for non-urgent cue'); });
    signals.running = true;

    // In Signals: every routine/outcome/scenery/long-turn cue produces zero synthesis & zero ducks.
    for (let i = 0; i < ROUTINE_AND_OUTCOME_KINDS.length; i++) {
        const [kind, payload] = ROUTINE_AND_OUTCOME_KINDS[i];
        spy.reset();
        signals.cue(kind, { ...payload, agentId: `sig-${i}` });
        assert.equal(spy.voices, 0, `Signals: ${kind} must not synthesize`);
        assert.equal(spy.ducks, 0, `Signals: ${kind} must not duck`);
    }

    // In Signals: urgent cues synthesize (reminder & linkLost tested before summons/distress/limit so they aren't blocked by the 2.8 s entry guard).
    const urgentOrder = ['reminder', 'linkLost', 'summons', 'distress', 'limit'];
    for (const [idx, kind] of urgentOrder.entries()) {
        spy.reset();
        const extra = kind === 'reminder' ? { level: 2, family: 'needsYou', count: 1, oldestMs: 120_000 } : {};
        signals.cue(kind, { ...extra, agentId: `sig-u-${idx}` });
        assert.ok(spy.voices > 0, `Signals: urgent ${kind} must synthesize`);
    }

    // In Town band: identical calm diet!
    const bgmGovernor = new CueGovernor({ maxPerMinute: 120, minSpacingMs: 0 });
    const bgmKit = new CueKit(spy.engine, bgmGovernor);
    const bgm = new BgmDirector({ engine: spy.engine, cues: { governor: bgmGovernor, kit: bgmKit } });
    bgm.running = true;
    bgm.setCuesEnabled(true);

    for (let i = 0; i < ROUTINE_AND_OUTCOME_KINDS.length; i++) {
        const [kind, payload] = ROUTINE_AND_OUTCOME_KINDS[i];
        spy.reset();
        bgm.cue(kind, { ...payload, agentId: `bgm-${i}` });
        assert.equal(spy.voices, 0, `Town band: ${kind} must not synthesize`);
        assert.equal(spy.ducks, 0, `Town band: ${kind} must not duck`);
    }

    for (const [idx, kind] of urgentOrder.entries()) {
        spy.reset();
        const extra = kind === 'reminder' ? { level: 2, family: 'needsYou', count: 1, oldestMs: 120_000 } : {};
        bgm.cue(kind, { ...extra, agentId: `bgm-u-${idx}` });
        assert.ok(spy.voices > 0, `Town band: urgent ${kind} must synthesize`);
    }

    // In Town band only (`setCuesEnabled(false)`): even urgent cues & flocked bursts stay completely silent,
    // while captions (`audio:cue-played`) still fire!
    const played = collectEvents('audio:cue-played');
    try {
        bgm.setCuesEnabled(false);
        for (const [idx, kind] of [...URGENT_SOUNDING].entries()) {
            spy.reset();
            const extra = kind === 'reminder' ? { level: 2, family: 'needsYou', count: 1, oldestMs: 120_000 } : {};
            bgm.cue(kind, { ...extra, agentId: `only-u-${idx}` });
            assert.equal(spy.voices, 0, `Town band only: ${kind} must not synthesize`);
            assert.equal(spy.ducks, 0, `Town band only: ${kind} must not duck`);
        }
        // Simultaneous urgent flock burst must also stay silent in Town band only.
        spy.reset();
        bgmKit._playFlock({ kind: 'summons', lane: laneForCueKind('summons'), agentId: 'flock-1', clusterIndex: 1, announceOnly: true });
        assert.equal(spy.voices, 0, 'Flock strike with announceOnly must not synthesize');
        assert.equal(spy.ducks, 0, 'Flock strike with announceOnly must not duck');
        assert.ok(played.payloads.some(p => p.kind === 'summons' && p.agentId === 'flock-1'), 'captions still fire');
    } finally {
        played.off();
        signals.destroy();
        bgm.destroy();
        governor.destroy();
        bgmGovernor.destroy();
    }
});

test('3.B: BgmDirector.setCuesEnabled(false) disables waiting cadence and attention dip', () => {
    const spy = spyEngine();
    spy.engine.setAttentionLevel = () => {};
    const bgm = new BgmDirector({
        engine: spy.engine,
        world: { agents: new Map([['w1', { id: 'w1', status: 'waiting_on_user' }]]) },
    });
    const waitingCalls = [];
    bgm.running = true;
    bgm.player = { setWaiting: v => waitingCalls.push(v), setBand() {}, setArrangement() {}, setWorkshopDensity() {}, setPhase() {}, setLevel() {}, stop() {}, snapshot: () => ({}) };
    bgm.setCuesEnabled(false);
    assert.equal(waitingCalls.at(-1), false);
    assert.equal(bgm.snapshot().cuesEnabled, false);
    bgm.destroy();
});

test('3.B: Toast auto captions show signals only whether sound is off or on', () => {
    for (const soundOn of [false, true]) {
        assert.equal(cueCaptionShown({ kind: 'summons' }, { setting: 'auto', soundOn }), true);
        assert.equal(cueCaptionShown({ kind: 'distress' }, { setting: 'auto', soundOn }), true);
        assert.equal(cueCaptionShown({ kind: 'limit' }, { setting: 'auto', soundOn }), true);
        assert.equal(cueCaptionShown({ kind: 'turnDone' }, { setting: 'auto', soundOn }), false);
        assert.equal(cueCaptionShown({ kind: 'arrival' }, { setting: 'auto', soundOn }), false);
        assert.equal(cueCaptionShown({ kind: 'push' }, { setting: 'auto', soundOn }), false);
        assert.equal(cueCaptionShown({ kind: 'release' }, { setting: 'auto', soundOn }), false);
        assert.equal(cueCaptionShown({ kind: 'push' }, { setting: 'events', soundOn }), true);
        assert.equal(cueCaptionShown({ kind: 'arrival' }, { setting: 'events', soundOn }), true);
    }
});

// ---------------------------------------------------------------------------
// 4.A & 4.B — Stripped Town Band Voice / Chip, Tone, and Count the hours
// ---------------------------------------------------------------------------

test('4.A & 4.B: chip voice, tone shelf, and count-hours exports and registries are gone', () => {
    assert.deepEqual([...VOICES], ['isle']);
    assert.equal(Object.keys(INSTRUMENTS).some(name => name.startsWith('chip')), false);
    assert.equal(Object.keys(VOICE_REGISTRY).some(name => name.startsWith('music.chip')), false);

    const engine = new AudioEngine();
    assert.equal(typeof engine.setTone, 'undefined');
    assert.equal(typeof engine.wave, 'undefined');
    assert.equal('tone' in engine.outputSnapshot(), false);
    assert.equal('toneDb' in engine.outputSnapshot(), false);

    for (const retired of [
        'readSoundTone', 'writeSoundTone', 'toneDb',
        'readTownBandVoice', 'writeTownBandVoice',
        'readCountHours', 'writeCountHours',
    ]) {
        assert.equal(retired in SoundSettings, false, `${retired} should be removed from SoundSettings`);
    }
});

// ---------------------------------------------------------------------------
// Minimal DOM harness for 4.C (Options Consolidation) & 4.D (Watchtowers Fix)
// ---------------------------------------------------------------------------

class FakeNode {
    constructor(tagName) {
        this.tagName = tagName ? tagName.toUpperCase() : '#TEXT';
        this.children = [];
        this.parentNode = null;
        this.attributes = new Map();
        this.dataset = {};
        const styleProps = new Map();
        this.style = {
            getPropertyValue: name => styleProps.get(name) ?? '',
            setProperty: (name, value) => styleProps.set(name, String(value)),
            removeProperty: name => styleProps.delete(name),
        };
        this.listeners = new Map();
        this.hidden = false;
        this.disabled = false;
        this.checked = false;
        this.open = false;
        this.value = '';
        this.type = '';
        this._text = '';
        this._classes = new Set();
        this.classList = {
            add: (...names) => { for (const n of names) if (n) this._classes.add(n); },
            remove: (...names) => { for (const n of names) this._classes.delete(n); },
            contains: name => this._classes.has(name),
            toggle: (name, force) => {
                const on = force === undefined ? !this._classes.has(name) : Boolean(force);
                if (on) this._classes.add(name);
                else this._classes.delete(name);
                return on;
            },
        };
    }

    get className() { return [...this._classes].join(' '); }
    set className(value) { this._classes = new Set(String(value || '').split(/\s+/).filter(Boolean)); }

    get textContent() {
        if (this.tagName === '#TEXT') return this._text;
        if (!this.children.length) return this._text;
        return this.children.map(c => c.textContent).join('');
    }
    set textContent(value) {
        this.children = [];
        this._text = String(value ?? '');
    }

    get firstChild() { return this.children[0] ?? null; }

    appendChild(child) {
        if (typeof child === 'string') {
            const text = new FakeNode(null);
            text._text = child;
            child = text;
        }
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    append(...nodes) {
        for (const node of nodes) this.appendChild(node);
    }

    removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx !== -1) this.children.splice(idx, 1);
        child.parentNode = null;
        return child;
    }

    replaceChildren(...nodes) {
        this.children = [];
        this._text = '';
        this.append(...nodes);
    }

    setAttribute(name, value) {
        const str = String(value);
        this.attributes.set(name, str);
        if (name === 'id') this.id = str;
        if (name === 'class') this.className = str;
    }

    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    removeAttribute(name) { this.attributes.delete(name); }

    addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
    }

    findAll(pred, out = []) {
        if (pred(this)) out.push(this);
        for (const child of this.children) child.findAll(pred, out);
        return out;
    }

    querySelector(selector) {
        if (selector.startsWith('.')) {
            const cls = selector.slice(1);
            return this.findAll(n => n.classList.contains(cls))[0] ?? null;
        }
        const tag = selector.toUpperCase();
        return this.findAll(n => n.tagName === tag)[0] ?? null;
    }

    querySelectorAll(selector) {
        if (selector.startsWith('.')) {
            const cls = selector.slice(1);
            return this.findAll(n => n.classList.contains(cls));
        }
        const tag = selector.toUpperCase();
        return this.findAll(n => n.tagName === tag);
    }

    closest(selector) {
        let cur = this;
        const isCls = selector.startsWith('.');
        const target = isCls ? selector.slice(1) : selector.toUpperCase();
        while (cur) {
            if (isCls ? cur.classList.contains(target) : cur.tagName === target) return cur;
            cur = cur.parentNode;
        }
        return null;
    }
}

async function withFakeDom(run) {
    const prevDoc = globalThis.document;
    const prevWin = globalThis.window;
    const prevNode = globalThis.Node;
    const prevFetch = globalThis.fetch;
    const prevSetInterval = globalThis.setInterval;
    const prevClearInterval = globalThis.clearInterval;

    const storage = memoryStorage();
    const doc = {
        createElement: tag => new FakeNode(tag),
        createTextNode: text => {
            const node = new FakeNode(null);
            node._text = String(text ?? '');
            return node;
        },
        documentElement: new FakeNode('html'),
    };
    globalThis.Node = FakeNode;
    globalThis.document = doc;
    globalThis.window = {
        localStorage: storage,
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    };
    const timers = new Set();
    let timerId = 1;
    globalThis.setInterval = (fn) => { const id = timerId++; timers.add({ id, fn }); return id; };
    globalThis.clearInterval = (id) => { for (const t of timers) if (t.id === id) timers.delete(t); };

    try {
        return await run({ doc, storage, timers });
    } finally {
        if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
        if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
        if (prevNode === undefined) delete globalThis.Node; else globalThis.Node = prevNode;
        if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
        globalThis.setInterval = prevSetInterval;
        globalThis.clearInterval = prevClearInterval;
    }
}

function defaultSettings(overrides = {}) {
    return {
        soundEnabled: true,
        soundMode: 'bgm',
        soundPreset: 'townBand',
        soundVolumes: { signals: 6, bgm: 6 },
        soundBackground: 'play',
        soundReminders: 'standard',
        captions: 'auto',
        soundOutput: 'speakers',
        soundSoften: 'auto',
        soundHushUntil: 0,
        soundQuietHours: 'off',
        soundInvited: false,
        soundChipSeen: false,
        autoCamera: true,
        desktopAlerts: false,
        sidebarCollapsed: false,
        hdrHighlights: 'auto',
        signage: 'compact',
        glass: 'off',
        villageWeather: 'modeled',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// 4.D — Watchtowers bug fix: strict fetch receiver + _providerLoadState guard
// ---------------------------------------------------------------------------

test('4.D: Watchtowers uses receiver-safe default fetch and never clobbers loading/error with empty state', async () => {
    await withFakeDom(async ({ storage }) => {
        // Strict WebIDL receiver check matching native browser window.fetch.
        let resolveFetch;
        let fetchCalls = 0;
        globalThis.fetch = function strictFetch(url) {
            if (this !== globalThis && this !== undefined) {
                throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
            }
            fetchCalls++;
            assert.equal(url, '/api/providers');
            return new Promise((resolve) => { resolveFetch = resolve; });
        };

        const panel = new SettingsPanel({
            storage,
            getSettings: () => defaultSettings(),
            getSoundState: () => ({ available: true, preset: 'townBand', volumeStep: 6 }),
        });
        const root = panel.build();

        assert.equal(fetchCalls, 1);
        assert.equal(panel._providerLoadState, 'loading');
        assert.match(panel.watchtowerList.textContent, /Reading local provider health/);

        // Simulate 1 Hz health tick while fetch is still in flight: must NOT say "No providers were reported."
        panel._refreshOperationalRows();
        assert.match(panel.watchtowerList.textContent, /Reading local provider health/);
        assert.equal(panel.watchtowerList.textContent.includes('No providers were reported.'), false);

        // Resolve with real providers payload.
        resolveFetch({
            ok: true,
            json: async () => ({
                providers: [
                    { id: 'claude', name: 'Claude Code', status: 'watching', activeSessions: 2, lastActivityAt: Date.now() },
                    { id: 'codex', name: 'Codex CLI', status: 'installed', activeSessions: 0 },
                ],
                hooks: { live: false },
            }),
        });
        await new Promise(resolve => setTimeout(resolve, 10));

        assert.equal(panel._providerLoadState, 'loaded');
        const rows = root.findAll(n => n.classList.contains('settings-provider'));
        assert.equal(rows.length, 2);
        assert.equal(panel.watchtowerList.textContent.includes('No providers were reported.'), false);

        // 1 Hz refresh after load keeps rendering the providers cleanly.
        panel._refreshOperationalRows();
        assert.equal(root.findAll(n => n.classList.contains('settings-provider')).length, 2);
        panel.destroy();

        // Error case: fetch rejects -> shows "Provider health is unavailable." and 1 Hz tick preserves it.
        const errPanel = new SettingsPanel({
            storage,
            fetchImpl: async () => { throw new Error('offline'); },
            getSettings: () => defaultSettings(),
            getSoundState: () => ({ available: true, preset: 'townBand', volumeStep: 6 }),
        });
        errPanel.build();
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(errPanel._providerLoadState, 'error');
        assert.match(errPanel.watchtowerList.textContent, /Provider health is unavailable/);
        errPanel._refreshOperationalRows();
        assert.match(errPanel.watchtowerList.textContent, /Provider health is unavailable/);
        assert.equal(errPanel.watchtowerList.textContent.includes('No providers were reported.'), false);
        errPanel.destroy();
    });
});

// ---------------------------------------------------------------------------
// 4.C — Consolidated 4-section Options menu & TopBar preview hiding
// ---------------------------------------------------------------------------

test('4.C: SettingsPanel renders 4 consolidated sections, collapsible details, 4 presets, and omits retired controls', async () => {
    await withFakeDom(async ({ storage }) => {
        let currentSettings = defaultSettings({ soundPreset: 'townBandOnly', soundMode: 'bgmOnly' });
        const panel = new SettingsPanel({
            storage,
            fetchImpl: async () => ({ ok: true, json: async () => ({ providers: [], hooks: {} }) }),
            getSettings: () => currentSettings,
            getSoundState: () => ({ available: true, preset: currentSettings.soundPreset, volumeStep: 6 }),
        });
        const root = panel.build();

        const sections = root.findAll(n => n.classList.contains('settings-section'));
        assert.equal(sections.length, 4, 'exactly 4 sections');
        const headings = sections.map(s => s.findAll(n => n.classList.contains('settings-section__heading'))[0]?.textContent);
        assert.deepEqual(headings, [
            'SOUND & ALERTS',
            'DISPLAY & WORLD',
            'PROVIDERS (WATCHTOWERS)',
            'SYSTEM & DIAGNOSTICS',
        ]);

        // Collapsible <details> inside Sound & alerts and System & diagnostics, closed by default.
        const details = root.findAll(n => n.tagName === 'DETAILS' && n.classList.contains('settings-section__details'));
        assert.equal(details.length, 2);
        assert.equal(details.every(d => d.open === false), true);

        // Desktop alerts lives inside Sound & alerts.
        assert.ok(sections[0].textContent.includes('Desktop alerts'));

        // 4 preset choices in Sound & alerts.
        const presetSelect = sections[0].findAll(n => n.tagName === 'SELECT')[0];
        const presetOptions = presetSelect.findAll(n => n.tagName === 'OPTION');
        assert.deepEqual(presetOptions.map(o => o.value), ['off', 'signals', 'townBand', 'townBandOnly']);

        // Calls preview row hidden in townBandOnly and off, visible in signals and townBand.
        assert.equal(panel._sound.callsRow.hidden, true, 'callsRow hidden in townBandOnly');
        currentSettings = defaultSettings({ soundPreset: 'off', soundEnabled: false });
        panel._renderPreset(currentSettings);
        assert.equal(panel._sound.callsRow.hidden, true, 'callsRow hidden in off');
        currentSettings = defaultSettings({ soundPreset: 'signals', soundMode: 'signals' });
        panel._renderPreset(currentSettings);
        assert.equal(panel._sound.callsRow.hidden, false, 'callsRow visible in signals');
        currentSettings = defaultSettings({ soundPreset: 'townBand', soundMode: 'bgm' });
        panel._renderPreset(currentSettings);
        assert.equal(panel._sound.callsRow.hidden, false, 'callsRow visible in townBand');

        // Removed controls must not appear anywhere in SettingsPanel DOM.
        const allText = root.textContent;
        for (const removed of [
            'Town band voice',
            'Count the hours',
            'Automatic camera',
            'Collapse sidebar',
            'Hush for 1 hour',
            'Sound tone',
        ]) {
            assert.equal(allText.includes(removed), false, `"${removed}" should not appear in Settings`);
        }
        // Also ensure no "Tone" control label exists.
        const labels = root.findAll(n => n.classList.contains('settings-control__label')).map(n => n.textContent);
        assert.equal(labels.includes('Tone'), false, 'Tone control removed');

        panel.destroy();
    });
});

test('4.C / 3.A: TopBar sound popover hides Preview in Off and Town band only', () => {
    const bar = Object.create(TopBar.prototype);
    const radios = Object.fromEntries(SoundSettings.SOUND_PRESETS.map((p) => {
        const node = new FakeNode('button');
        node.dataset.preset = p;
        node.tabIndex = -1;
        return [p, node];
    }));
    bar._soundEls = {
        radios,
        volume: { row: new FakeNode('label'), input: new FakeNode('input'), value: new FakeNode('span') },
        now: new FakeNode('div'),
        note: new FakeNode('div'),
        actions: new FakeNode('div'),
        preview: new FakeNode('button'),
        hush: new FakeNode('button'),
    };
    bar.els = { soundBtn: null };

    // Town band only: preview hidden, hush visible (since music plays), actions visible.
    bar._soundView = { available: true, enabled: true, preset: 'townBandOnly', soundState: 'playing', volumeStep: 6, nowLine: 'Now · Willowbrook', recalibrated: false, hushedUntil: 0, quietActive: false, chipTitle: '' };
    bar._renderSoundPanel();
    assert.equal(bar._soundEls.preview.hidden, true);
    assert.equal(bar._soundEls.hush.hidden, false);
    assert.equal(bar._soundEls.actions.hidden, false);

    // Off: both preview and hush hidden, actions row hidden.
    bar._soundView = { ...bar._soundView, enabled: false, preset: 'off', soundState: 'off' };
    bar._renderSoundPanel();
    assert.equal(bar._soundEls.preview.hidden, true);
    assert.equal(bar._soundEls.hush.hidden, true);
    assert.equal(bar._soundEls.actions.hidden, true);

    // Signals: preview visible, hush hidden, actions row visible.
    bar._soundView = { ...bar._soundView, enabled: true, preset: 'signals', soundState: 'playing' };
    bar._renderSoundPanel();
    assert.equal(bar._soundEls.preview.hidden, false);
    assert.equal(bar._soundEls.hush.hidden, true);
    assert.equal(bar._soundEls.actions.hidden, false);

    // Town band: both preview and hush visible.
    bar._soundView = { ...bar._soundView, enabled: true, preset: 'townBand', soundState: 'playing' };
    bar._renderSoundPanel();
    assert.equal(bar._soundEls.preview.hidden, false);
    assert.equal(bar._soundEls.hush.hidden, false);
    assert.equal(bar._soundEls.actions.hidden, false);
});
