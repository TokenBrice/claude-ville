const STORAGE_KEY = 'claudeville.sound.enabled';

const FADE_TC = 0.35;
const MIN_GAIN = 0.0001;
const PAD_ROOTS = [110, 164.81, 220, 246.94];
const CHIME_NOTES = [220, 246.94, 277.18, 329.63, 369.99, 440, 493.88, 554.37];

function clamp01(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

function safeDisconnect(node) {
    try { node?.disconnect?.(); } catch { /* node may already be disconnected */ }
}

function createNoiseBuffer(ctx, seconds = 3) {
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let previous = 0;

    for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        previous = previous * 0.86 + white * 0.14;
        data[i] = previous * 0.42;
    }

    return buffer;
}

function readStoredPreference() {
    try {
        return window.localStorage?.getItem(STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

function writeStoredPreference(enabled) {
    try {
        window.localStorage?.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {
        // Preference persistence is optional.
    }
}

export class AmbientAudioController {
    constructor({ button } = {}) {
        this.button = button || null;
        this.context = null;
        this.available = this._hasAudioSupport();
        this.enabled = readStoredPreference();
        this.userActivated = false;
        this.ready = false;
        this.running = false;
        this.unlockArmed = false;

        this.masterGain = null;
        this.masterTone = null;
        this.chimeDelay = null;
        this.chimeDelayReturn = null;
        this._nodes = [];
        this._sources = [];
        this._transients = new Set();
        this._chimeTimer = null;
        this._lastChimeIndex = -1;

        this._onButtonClick = () => this._handleToggle();
        this._onUnlockGesture = (event) => this._handleUnlockGesture(event);
        this._onVisibility = () => this._handleVisibility();

        if (this.button) this.button.addEventListener('click', this._onButtonClick);
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this._onVisibility);
        }

        this._renderButton();
        if (this.enabled) this._armUnlockListeners();

        if (typeof window !== 'undefined') {
            window.__claudevilleAudio = () => ({
                enabled: this.enabled,
                userActivated: this.userActivated,
                available: this.available,
                contextState: this.context?.state || null,
                ready: this.ready,
                running: this.running,
                mode: 'simple-ambient',
            });
        }
    }

    _handleToggle() {
        this.userActivated = true;
        this.setEnabled(!this.enabled);
    }

    setEnabled(enabled) {
        if (!this.available) return;

        this.enabled = Boolean(enabled);
        writeStoredPreference(this.enabled);
        this._renderButton();
        this._removeUnlockListeners();

        if (this.enabled) void this._activate();
        else this._deactivate();
    }

    async _activate() {
        if (!this.enabled || !this.available) return;
        const ready = await this._ensureContext();
        if (!ready || !this.enabled) return;

        this._startAtmosphere();
    }

    _deactivate() {
        this._stopAtmosphere();
        void this._suspendContext();
    }

    _handleUnlockGesture(event) {
        if (!this.enabled || this.userActivated) return;
        if (this.button && event?.target && this.button.contains(event.target)) return;

        this.userActivated = true;
        this._removeUnlockListeners();
        void this._activate();
    }

    _handleVisibility() {
        if (typeof document === 'undefined') return;
        if (document.hidden) {
            if (this.enabled) this._deactivate();
        } else if (this.enabled && this.userActivated) {
            void this._activate();
        }
    }

    async _ensureContext() {
        if (!this.context) {
            const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextCtor) {
                this.available = false;
                this._renderButton();
                return false;
            }

            this.context = new AudioContextCtor();
            this._buildMasterGraph();
            this.ready = true;
        }

        if (this.context.state === 'suspended') await this.context.resume();
        return this.context.state === 'running';
    }

    _buildMasterGraph() {
        const ctx = this.context;

        this.masterGain = ctx.createGain();
        this.masterGain.gain.value = MIN_GAIN;

        this.masterTone = ctx.createBiquadFilter();
        this.masterTone.type = 'lowpass';
        this.masterTone.frequency.value = 5200;
        this.masterTone.Q.value = 0.45;

        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -8;
        limiter.knee.value = 18;
        limiter.ratio.value = 5;
        limiter.attack.value = 0.012;
        limiter.release.value = 0.45;

        this.chimeDelay = ctx.createDelay(1.6);
        this.chimeDelay.delayTime.value = 0.38;

        const feedback = ctx.createGain();
        feedback.gain.value = 0.18;

        const delayTone = ctx.createBiquadFilter();
        delayTone.type = 'lowpass';
        delayTone.frequency.value = 2800;
        delayTone.Q.value = 0.3;

        this.chimeDelayReturn = ctx.createGain();
        this.chimeDelayReturn.gain.value = 0.11;

        this.chimeDelay.connect(delayTone).connect(feedback).connect(this.chimeDelay);
        delayTone.connect(this.chimeDelayReturn).connect(this.masterGain);
        this.masterGain.connect(this.masterTone).connect(limiter).connect(ctx.destination);
    }

    _startAtmosphere() {
        if (this.running || !this.context || !this.masterGain) return;
        this.running = true;

        const ctx = this.context;
        const now = ctx.currentTime;
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setTargetAtTime(0.38, now, FADE_TC);

        this._startPad(now);
        this._startAir(now);
        this._playChime(0.16);
        this._scheduleNextChime();
    }

    _startPad(time) {
        const ctx = this.context;
        const padGain = ctx.createGain();
        padGain.gain.value = 0.024;

        const padTone = ctx.createBiquadFilter();
        padTone.type = 'lowpass';
        padTone.frequency.value = 1250;
        padTone.Q.value = 0.55;

        const swell = ctx.createOscillator();
        const swellGain = ctx.createGain();
        swell.type = 'sine';
        swell.frequency.value = 0.035;
        swellGain.gain.value = 0.004;
        swell.connect(swellGain).connect(padGain.gain);

        for (let i = 0; i < PAD_ROOTS.length; i++) {
            const osc = ctx.createOscillator();
            const voiceGain = ctx.createGain();
            osc.type = i === 0 ? 'sine' : 'triangle';
            osc.frequency.value = PAD_ROOTS[i];
            osc.detune.value = [-3, 5, -7, 2][i];
            voiceGain.gain.value = i === 0 ? 0.42 : 0.2;
            osc.connect(voiceGain).connect(padTone);
            osc.start(time);
            this._sources.push(osc);
            this._nodes.push(voiceGain);
        }

        swell.start(time);
        padTone.connect(padGain).connect(this.masterGain);
        this._sources.push(swell);
        this._nodes.push(padGain, padTone, swellGain);
    }

    _startAir(time) {
        const ctx = this.context;
        const source = ctx.createBufferSource();
        source.buffer = createNoiseBuffer(ctx);
        source.loop = true;

        const airGain = ctx.createGain();
        airGain.gain.value = 0.026;

        const airTone = ctx.createBiquadFilter();
        airTone.type = 'bandpass';
        airTone.frequency.value = 620;
        airTone.Q.value = 0.55;

        const shimmerGain = ctx.createGain();
        shimmerGain.gain.value = 0.006;

        const shimmerTone = ctx.createBiquadFilter();
        shimmerTone.type = 'bandpass';
        shimmerTone.frequency.value = 1900;
        shimmerTone.Q.value = 0.85;

        const drift = ctx.createOscillator();
        const driftDepth = ctx.createGain();
        drift.type = 'sine';
        drift.frequency.value = 0.018;
        driftDepth.gain.value = 95;
        drift.connect(driftDepth).connect(airTone.frequency);

        source.connect(airTone).connect(airGain).connect(this.masterGain);
        source.connect(shimmerTone).connect(shimmerGain).connect(this.masterGain);
        source.start(time);
        drift.start(time);

        this._sources.push(source, drift);
        this._nodes.push(airGain, airTone, shimmerGain, shimmerTone, driftDepth);
    }

    _scheduleNextChime() {
        if (!this.running) return;
        const delayMs = 5800 + Math.random() * 6200;
        this._chimeTimer = window.setTimeout(() => {
            this._chimeTimer = null;
            if (!this.running) return;
            this._playChime();
            this._scheduleNextChime();
        }, delayMs);
    }

    _playChime(level = 1) {
        if (!this.running || !this.context || !this.masterGain) return;

        const ctx = this.context;
        const now = ctx.currentTime + 0.02;
        let index = Math.floor(Math.random() * CHIME_NOTES.length);
        if (index === this._lastChimeIndex) index = (index + 2) % CHIME_NOTES.length;
        this._lastChimeIndex = index;

        const frequency = CHIME_NOTES[index];
        const duration = 2.8 + Math.random() * 1.4;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const tone = ctx.createBiquadFilter();
        const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;

        osc.type = 'sine';
        osc.frequency.value = frequency;
        tone.type = 'lowpass';
        tone.frequency.value = 2200;
        tone.Q.value = 0.25;

        gain.gain.setValueAtTime(MIN_GAIN, now);
        gain.gain.exponentialRampToValueAtTime(0.026 * clamp01(level, 1), now + 0.09);
        gain.gain.exponentialRampToValueAtTime(MIN_GAIN, now + duration);

        if (pan) {
            pan.pan.value = -0.35 + Math.random() * 0.7;
            osc.connect(tone).connect(gain).connect(pan).connect(this.masterGain);
            gain.connect(this.chimeDelay);
        } else {
            osc.connect(tone).connect(gain).connect(this.masterGain);
            gain.connect(this.chimeDelay);
        }

        const transientNodes = pan ? [osc, gain, tone, pan] : [osc, gain, tone];
        for (const node of transientNodes) this._transients.add(node);
        osc.start(now);
        osc.stop(now + duration + 0.05);
        osc.onended = () => {
            for (const node of transientNodes) {
                safeDisconnect(node);
                this._transients.delete(node);
            }
        };
    }

    _stopAtmosphere() {
        if (!this.running) return;
        this.running = false;

        if (this._chimeTimer) {
            window.clearTimeout(this._chimeTimer);
            this._chimeTimer = null;
        }

        const ctx = this.context;
        const now = ctx?.currentTime ?? 0;
        if (this.masterGain) {
            this.masterGain.gain.cancelScheduledValues(now);
            this.masterGain.gain.setTargetAtTime(MIN_GAIN, now, 0.18);
        }

        const stopAt = now + 0.75;
        for (const source of this._sources) {
            try { source.stop(stopAt); } catch { /* already stopped */ }
        }

        const nodes = [...this._sources, ...this._nodes, ...this._transients];
        window.setTimeout(() => {
            for (const node of nodes) safeDisconnect(node);
        }, 1100);
        this._sources = [];
        this._nodes = [];
        this._transients.clear();
    }

    async _suspendContext() {
        if (!this.context || this.context.state !== 'running') return;
        try {
            await this.context.suspend();
        } catch {
            // Best effort; the ambience is already faded and stopped.
        }
    }

    _armUnlockListeners() {
        if (!this.enabled || this.userActivated || this.unlockArmed || !this.available) return;
        document.addEventListener('pointerdown', this._onUnlockGesture, true);
        document.addEventListener('keydown', this._onUnlockGesture, true);
        this.unlockArmed = true;
    }

    _removeUnlockListeners() {
        if (!this.unlockArmed) return;
        document.removeEventListener('pointerdown', this._onUnlockGesture, true);
        document.removeEventListener('keydown', this._onUnlockGesture, true);
        this.unlockArmed = false;
    }

    _renderButton() {
        if (!this.button) return;
        this.button.disabled = !this.available;
        this.button.textContent = this.available
            ? (this.enabled ? 'SOUND ON' : 'SOUND OFF')
            : 'SOUND N/A';
        this.button.title = this.available
            ? (this.enabled ? 'Disable sound' : 'Enable sound')
            : 'Sound unavailable';
        this.button.setAttribute('aria-pressed', this.enabled && this.available ? 'true' : 'false');
        this.button.classList.toggle('topbar__sound-btn--on', this.enabled && this.available);
    }

    _hasAudioSupport() {
        return Boolean(window.AudioContext || window.webkitAudioContext);
    }

    destroy() {
        this._removeUnlockListeners();
        this._stopAtmosphere();

        if (this.button) this.button.removeEventListener('click', this._onButtonClick);
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._onVisibility);
        }

        if (this.context) void this.context.close().catch(() => {});
        this.context = null;
        this.ready = false;
        if (typeof window !== 'undefined') delete window.__claudevilleAudio;
    }
}
