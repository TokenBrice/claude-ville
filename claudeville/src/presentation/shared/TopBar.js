import { eventBus } from '../../domain/events/DomainEvent.js';
import { formatCost, formatNumber, shortProjectName } from './Formatters.js';
import { el, replaceChildren } from './DomSafe.js';
import {
    installReducedMotionOverride,
    readReducedMotionOverride,
    SettingsPanel,
} from './SettingsPanel.js';
import {
    initialVillageState,
    isStale,
    LinkState,
    linkStatusText,
    snapshotAgeMs,
    VillagePhase,
} from '../../application/VillageState.js';
import { TokenUsage } from '../../domain/value-objects/TokenUsage.js';
import { eventShapeSvgPath } from './EventShapes.js';
import {
    DEFAULT_TOWN_BAND_VOICE,
    HUSH_DURATION_MS,
    SOUND_PRESETS,
    SOUND_PRESET_DETAILS,
    SOUND_PRESET_LABELS,
    SOUND_RECALIBRATED_MESSAGE,
    SOUND_SETTING_DEFAULTS,
    SOUND_STEP_MAX,
    presetForMode,
    readPresetVolumeStep,
    readSoundChipSeen,
    readSoundSettings,
    writePresetVolumeStep,
    writeSoundChipSeen,
} from './SoundSettings.js';

const SETTINGS_MODAL_OWNER = 'topbar-settings';
const UNKNOWN_MODEL_DATE_KEY = 'claudeville.pricing.unknownModelDate';
// The actionable buckets in display precedence (SignalLedger ACTIONABLE_BUCKETS
// order), with the same words and motifs the World's attention plates use,
// and the frame-kit slice (9.5) the lit slot wears when the bucket leads.
export const ATTENTION_PARTS = Object.freeze([
    Object.freeze({ key: 'needsYou', word: 'NEEDS YOU', modifier: 'needs-you', noun: 'waiting for you', motif: 'needs-you', frame: 'cv-frame--attn' }),
    Object.freeze({ key: 'errors', word: 'ERROR', modifier: 'error', noun: 'errored', motif: 'alert', frame: 'cv-frame--attn-error' }),
    Object.freeze({ key: 'quota', word: 'LIMIT', modifier: 'limit', noun: 'rate-limited', motif: 'limit-gate', frame: 'cv-frame--attn-limit' }),
]);
const SVG_NS = 'http://www.w3.org/2000/svg';
// The boot-idle build of the sound controller: the idle slot's deadline, and
// the delay where `requestIdleCallback` is missing (Safari).
const AUDIO_ROUTE_IDLE_TIMEOUT_MS = 4000;
const AUDIO_ROUTE_FALLBACK_DELAY_MS = 1500;

const CONNECTION_REASON_COPY = Object.freeze({
    'connection-refused': 'The local session link refused the connection.',
    'econnrefused': 'The local session link refused the connection.',
    'connection-reset': 'The local session link was reset.',
    'econnreset': 'The local session link was reset.',
    'socket-closed': 'The local session link closed unexpectedly.',
    'socket-error': 'The local session link reported a transport problem.',
    'websocket-closed': 'The local session link closed unexpectedly.',
    'initial-sync-failed': 'The initial local session sync did not complete.',
    'message-invalid': 'A session update could not be understood.',
    'delta-baseline-mismatch': 'A session update did not match the last snapshot.',
    'patch-failed': 'A session update could not be applied safely.',
    'watcher-unavailable': 'The local session watcher is unavailable.',
    'watcher-failed': 'The local session watcher could not read session updates.',
    'poll-timeout': 'The local session poll took too long.',
    'session-poll-failed': 'The local session watcher could not refresh sessions.',
    'poll-failed': 'The local session watcher could not complete a refresh.',
    'source-failed': 'A local session source could not be read.',
    'timeout': 'The local session link timed out.',
    'timed-out': 'The local session link timed out.',
});

/** Safe operator copy from a normalized code; raw diagnostic text never passes through. */
export function connectionReasonText(code) {
    const normalized = String(code || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return CONNECTION_REASON_COPY[normalized] || 'Connection interrupted; ClaudeVille will keep retrying locally.';
}

// Every sound key (SoundSettings owns them, the calibration key last, so a
// reset never needs the D5 recalibration) and the view preferences.
export const PERSISTED_SETTING_DEFAULTS = Object.freeze({
    ...SOUND_SETTING_DEFAULTS,
    'cv-auto-camera': '1',
    'cv-ambient-standing': '0',
    'claudeville.alerts.desktop': '0',
    'claudeville.sidebarCollapsed': 'false',
});

function storageValue(storage, key) {
    try { return storage?.getItem(key) ?? null; } catch { return null; }
}

function focusWithoutScroll(element) {
    if (!element?.focus) return;
    try { element.focus({ preventScroll: true }); } catch { element.focus(); }
}

export function readPersistedSettings(storage = globalThis.window?.localStorage) {
    return {
        ...readSoundSettings(storage),
        autoCamera: storageValue(storage, 'cv-auto-camera') !== '0',
        desktopAlerts: storageValue(storage, 'claudeville.alerts.desktop') === '1',
        sidebarCollapsed: storageValue(storage, 'claudeville.sidebarCollapsed') === 'true',
    };
}

// ── Sound chip and popover helpers (plan 7.1–7.3, UX-2/UX-7 copy) ──
const SOUND_PANEL_WIDTH = 308;
const SOUND_FIRST_TITLE = 'Sound off — click to choose what you hear';
const SOUND_ARMED_TITLE = 'Sound on — click anywhere to start it';
const SOUND_ARMED_LINE = 'Waiting for a click — browsers start sound on your first click';

// Before the controller's boot-idle build no context can be running: a
// stored preset reads armed, never playing. The same shape as the
// controller's `soundView()`.
function storedSoundView(storage = globalThis.window?.localStorage) {
    const settings = readSoundSettings(storage);
    const preset = settings.soundPreset;
    const lastPreset = preset !== 'off' ? preset : presetForMode(settings.soundMode);
    const armed = preset !== 'off';
    return {
        available: true,
        preset,
        lastPreset,
        soundState: armed ? 'armed' : 'off',
        volumeStep: readPresetVolumeStep(preset, storage),
        nowLine: armed ? SOUND_ARMED_LINE : '',
        chipTitle: armed ? SOUND_ARMED_TITLE : `Sound off — click to turn on ${SOUND_PRESET_LABELS[lastPreset]}`,
        hushedUntil: null,
        quietActive: false,
        recalibrated: false,
    };
}

function isKeyboardEditTarget(target) {
    const tag = String(target?.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target?.isContentEditable);
}

function stepReadout(step) {
    return `${step} / ${SOUND_STEP_MAX}`;
}

function stepValueText(step) {
    return step > 0 ? `${step} of ${SOUND_STEP_MAX}` : 'Off';
}

// DOM writes only when the value changed (no writes while nothing moved).
function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
}

function setAttr(node, name, value) {
    if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function setHidden(node, hidden) {
    if (node && node.hidden !== hidden) node.hidden = hidden;
}

function setSliderStep(slider, step) {
    const value = String(step);
    if (slider.input.value !== value) slider.input.value = value;
    setAttr(slider.input, 'aria-valuetext', stepValueText(step));
    setText(slider.value, stepReadout(step));
}

export function resetPersistedSettings(storage = globalThis.window?.localStorage) {
    for (const [key, value] of Object.entries(PERSISTED_SETTING_DEFAULTS)) {
        try { storage?.setItem(key, value); } catch { /* persistence is optional */ }
    }
    return readPersistedSettings(storage);
}

export function usageCoverage(agents = []) {
    const counts = { observed: 0, partial: 0, unavailable: 0 };
    for (const agent of agents) {
        const availability = TokenUsage.normalize(agent?.tokens).availability;
        counts[availability]++;
    }
    return counts;
}

/**
 * Counts are unknown (not zero) until the first snapshot lands, and stay
 * unknown while a source is unreadable and nothing was read: a failed read
 * is not evidence of an empty village.
 */
export function countsPending(state) {
    const phase = state?.phase;
    if (phase === VillagePhase.STARTING || phase === VillagePhase.SYNCING) return true;
    if (phase === VillagePhase.DEGRADED) return !(Number(state?.agentCount) > 0);
    return phase === VillagePhase.FAILED && !state?.link?.lastSnapshotAt;
}

/**
 * The connection chip follows the village phase: it never says LIVE (or
 * lights green) while the village is still syncing, and says DEGRADED while
 * the world says a watchtower is unreadable.
 */
export function connectionChip(state, now = Date.now()) {
    const phase = state?.phase;
    if (phase === VillagePhase.STARTING || phase === VillagePhase.SYNCING) {
        return { label: 'SYNCING', state: LinkState.SYNCING, stale: false };
    }
    if (phase === VillagePhase.DEGRADED) {
        return { label: 'DEGRADED', state: LinkState.RECONNECTING, stale: false };
    }
    const stale = isStale(state, now);
    return {
        label: linkStatusText(state, now),
        state: stale ? LinkState.STALE
            : state?.source === 'simulator' ? LinkState.LIVE : state?.link?.state,
        stale,
    };
}

export class TopBar {
    constructor(world, { modal, attention, chronicle, spendLedger, frameAttention } = {}) {
        this._motionOverride = installReducedMotionOverride();
        this.world = world;
        this.modal = modal || null;
        this.attention = attention || null;
        this.frameAttention = frameAttention;
        this.chronicle = chronicle || null;
        this.spendLedger = spendLedger || null;
        this.els = {
            root: document.getElementById('topbar'),
            tokens: document.getElementById('statTokens'),
            time: document.getElementById('statTime'),
            clock: document.getElementById('villageClock'),
            working: document.getElementById('badgeWorking'),
            idle: document.getElementById('badgeIdle'),
            waiting: document.getElementById('badgeWaiting'),
            connection: document.getElementById('topbarConnection'),
            version: document.querySelector('.topbar__version'),
            soundGroup: document.querySelector('.topbar__sound'),
            soundToggle: document.getElementById('topbarSoundToggle'),
            soundMenu: document.getElementById('topbarSoundMenu'),
            alertsToggle: document.getElementById('topbarAlertsToggle'),
            chronicleBtn: document.getElementById('topbarChronicle'),
            rate: document.getElementById('statRate'),
            rateWrap: document.getElementById('statRateWrap'),
            fps: document.getElementById('statFps'),
        };
        this.els.center = this.els.root?.querySelector('.topbar__center') || null;
        // The centre sits between the brand and the controls on
        // space-between, so an odd free width puts the lit slot (and every
        // tip anchored to it) on a half CSS pixel. One px of right padding,
        // chosen from the unpadded position, keeps its left edge integral.
        this._centerSnap = typeof ResizeObserver === 'function' && this.els.center
            ? new ResizeObserver(() => this._snapCenter())
            : null;
        if (this._centerSnap) {
            this._centerSnap.observe(this.els.root);
            this._centerSnap.observe(this.els.center);
        }
        // The one loud slot counts every agent that needs action — needs-you,
        // errored and rate-limited — one exact numeral per non-zero bucket, in
        // the bucket's status colour, inside a single lit frame. Each numeral
        // rides beside its bucket's motif at 2× (the plates' 8×8 motif).
        this.els.attentionParts = Object.fromEntries(ATTENTION_PARTS.map(({ key, word, modifier, motif }) => {
            const num = el('span', { className: 'topbar__kpi-num', text: '0' });
            const glyph = document.createElementNS(SVG_NS, 'svg');
            glyph.setAttribute('class', 'topbar__attn-glyph');
            glyph.setAttribute('viewBox', '4 4 8 8');
            glyph.setAttribute('aria-hidden', 'true');
            glyph.setAttribute('focusable', 'false');
            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('fill', 'currentColor');
            path.setAttribute('d', eventShapeSvgPath(motif));
            glyph.appendChild(path);
            const part = el('span', { className: `topbar__attn-part topbar__attn-part--${modifier}` }, [
                el('span', { className: 'topbar__attn-count' }, [glyph, num]),
                el('span', { className: 'topbar__kpi-cap', text: word }),
            ]);
            part.hidden = true;
            return [key, { part, num }];
        }));
        this.els.attention = el('span', { className: 'topbar__seg topbar__seg--attention cv-frame cv-frame--attn' },
            ATTENTION_PARTS.map(({ key }) => this.els.attentionParts[key].part));
        this.els.attention.id = 'badgeAttention';
        this.els.attention.hidden = true;
        this.els.waiting?.parentElement?.parentElement?.prepend(this.els.attention);
        this._usage = null;
        this.timeInterval = null;
        this._lastFps = null;
        this._settingsPanel = null;
        this._hookSeenAtByProvider = new Map();
        this._chronicleStatus = 'unknown';
        this._changelogHtml = null;
        this._changelogController = null;
        this._destroyed = false;
        this._villageState = initialVillageState();
        this._connectionAnnouncementKey = null;
        this._recoverySweepPending = false;
        this._recoveryBaselineSnapshotAt = null;
        this._lastSweptSnapshotAt = null;
        this._staleTimer = null;
        this.audio = null;
        this._audioLoadPromise = null;
        // The controller is DOM-free (C-UX1): the chip and the popover are
        // this bar's views of its `audio:sound-state`. A click inside them is
        // theirs, never an unlock gesture as well.
        this._audioOptions = {
            world: this.world,
            ownsGesture: (target) => Boolean(target && (
                this.els.soundGroup?.contains?.(target) || this._soundEls?.panel?.contains?.(target)
            )),
            reducedMotion: () => globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true,
        };
        this._audioIdleHandle = null;
        this._audioIdleTimer = null;
        this._initSound();
        this._scheduleAudioRoute();
        this._initAttentionControls();
        this._initChronicleButton();
        this._initSpendBreakdown();
        this._initSettingsButton();

        this._onUpdate = (agent) => {
            this._observeHookSignal(agent);
            this.render();
        };
        eventBus.on('agent:added', this._onUpdate);
        eventBus.on('agent:updated', this._onUpdate);
        eventBus.on('agent:removed', this._onUpdate);

        this._onFps = (fps) => this.renderFps(fps);
        eventBus.on('fps:updated', this._onFps);
        this._onAtmosphere = snapshot => this._renderWitnessClock(snapshot);
        eventBus.on('atmosphere:updated', this._onAtmosphere);

        this._onUsage = (usage) => { this._usage = usage; };
        eventBus.on('usage:updated', this._onUsage);

        this._onVillageState = (state) => {
            if (!state?.link) return;
            this._villageState = state;
            const connected = state.source === 'simulator'
                || (Boolean(state.link.lastSnapshotAt) && !isStale(state)
                    && [LinkState.LIVE, LinkState.POLLING].includes(state.link.state));
            this._applyConnectionChrome(connected);
            this._renderConnection();
            // The first snapshot turns the count placeholders into real numbers.
            if (this._countsPending !== countsPending(state)) this.render();
        };
        eventBus.on('village:state', this._onVillageState);
        this._onChronicleStatus = (payload = {}) => {
            this._chronicleStatus = String(payload.status || 'unknown');
        };
        eventBus.on('chronicle:status', this._onChronicleStatus);
        this._initConnectionInstrument();

        if (this.modal && this.els.version) {
            this.els.version.dataset.tip = 'View changelog';
            this._onVersionClick = () => this._openChangelog();
            this.els.version.addEventListener('click', this._onVersionClick);
            this._onVersionKeydown = (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    if (e.key === ' ') e.preventDefault();
                    this._openChangelog();
                }
            };
            this.els.version.addEventListener('keydown', this._onVersionKeydown);
        }

        this._startTimer();
        this.render();
    }

    _renderWitnessClock(snapshot) {
        const clock = snapshot?.clock;
        const node = this.els.clock;
        if (!node || !clock?.label) return;
        const weather = snapshot.weather?.type || 'clear';
        const timeline = snapshot.timeline;
        const override = timeline?.hourOverride != null || timeline?.frozen || timeline?.mode === 'fixed'
            ? 'FIXED' : this._villageState.source === 'simulator' ? 'SIM' : '';
        const phase = String(snapshot.phase || '').toUpperCase();
        const signature = `${clock.label}|${phase}|${weather}|${override}`;
        if (signature === this._clockSignature) return;
        this._clockSignature = signature;
        node.hidden = false;
        node.querySelector('.topbar__clock-time').textContent = clock.label;
        node.querySelector('.topbar__clock-phase').textContent = phase;
        const tag = node.querySelector('.topbar__clock-override');
        tag.textContent = override;
        tag.hidden = !override;
        const glyph = /rain|storm|snow/.test(weather) ? 'weather-rain'
            : /cloud|fog|overcast/.test(weather) ? 'weather-cloud' : 'weather-clear';
        node.querySelector('path').setAttribute('d', eventShapeSvgPath(glyph));
        node.dataset.tip = `Modeled village weather: ${weather}${override ? ` · ${override.toLowerCase()} timeline` : ''}`;
    }

    // The `A` hotkey jumps to the longest-waiting actionable agent, and ALERTS
    // opts into desktop notifications from a real user gesture (browsers reject
    // permission prompts otherwise).
    _initAttentionControls() {
        if (!this.attention) return;

        const btn = this.els.alertsToggle;
        if (btn) {
            if (!this.attention.desktopAlertsAvailable) {
                btn.hidden = true;
            } else {
                this._applyAlertsState(this.attention.desktopAlerts);
                this._onAlertsClick = async () => {
                    const on = await this.attention.setDesktopAlerts(!this.attention.desktopAlerts);
                    this._applyAlertsState(on);
                    if (!on && Notification.permission === 'denied') {
                        btn.dataset.tip = 'Blocked by the browser · allow notifications for localhost:4000';
                    }
                };
                btn.addEventListener('click', this._onAlertsClick);
            }
        }

        this._onAttentionKey = (event) => {
            if (event.key !== 'a' && event.key !== 'A') return;
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            const target = event.target;
            const tag = target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
            if (this.frameAttention?.()) {
                event.preventDefault();
                return;
            }
            const agent = this.attention.focusNext();
            if (agent) event.preventDefault();
        };
        document.addEventListener('keydown', this._onAttentionKey);
    }

    _applyAlertsState(on) {
        const btn = this.els.alertsToggle;
        if (!btn) return;
        btn.classList.toggle('topbar__sound-btn--on', Boolean(on));
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.dataset.tip = on ? 'Disable desktop notifications' : 'Enable desktop notifications';
    }

    _initChronicleButton() {
        const btn = this.els.chronicleBtn;
        if (!btn) return;
        if (!this.chronicle) { btn.hidden = true; return; }
        this._onChronicleClick = () => {
            this.chronicle.open().catch((err) => {
                console.warn('[TopBar] Chronicle unavailable:', err.message);
            });
        };
        btn.addEventListener('click', this._onChronicleClick);
    }

    // Settings sits after the sound group, so the bar's right cluster is
    // the same controls at the same x in World and Dashboard (9.1).
    _initSettingsButton() {
        if (!this.modal || !this.els.root) return;
        const anchor = this.els.soundGroup;
        if (!anchor?.parentElement) return;
        const button = el('button', {
            className: 'topbar__sound-btn topbar__icon-btn topbar__icon-btn--action',
            ariaLabel: 'Open settings',
        });
        button.type = 'button';
        button.dataset.tip = 'Settings and health';
        button.setAttribute('aria-haspopup', 'dialog');
        button.appendChild(el('span', { className: 'topbar__settings-icon' }));
        this._onSettingsClick = () => this._openSettings();
        button.addEventListener('click', this._onSettingsClick);
        anchor.insertAdjacentElement('afterend', button);
        this._settingsButtonEl = button;
    }

    _openSettings({ section = null } = {}) {
        if (!this.modal || this._destroyed) return;
        this._hideSoundPanel({ restoreFocus: false });
        this._hideSpendPanel({ restoreFocus: false });
        this.modal.openContent('Settings', this._buildSettingsContent(), {
            wide: true,
            owner: SETTINGS_MODAL_OWNER,
        });
        if (section === 'sound') this._settingsPanel?.focusSound?.();
    }

    // SET's SOUND rows and the popover are two views of one controller
    // state (C-UX1): every change goes through the controller, and SET
    // re-reads storage on `audio:sound-state`.
    _buildSettingsContent() {
        this._settingsPanel?.destroy();
        const sound = (apply, stored) => this._soundSetting(apply, stored);
        this._settingsPanel = new SettingsPanel({
            readSettings: () => ({
                ...readPersistedSettings(),
                reducedMotion: readReducedMotionOverride(),
            }),
            onSoundPreset: (preset) => sound(
                audio => audio.setPreset(preset, { fromUser: true }),
                settings => settings.soundPreset,
            ),
            onSoundVolume: (preset, step) => sound(
                audio => (audio.soundView().preset === preset
                    ? audio.setVolumeStep(step)
                    : this._writePresetVolume(preset, step)),
                () => this._writePresetVolume(preset, step),
            ),
            onSoundBackground: (value) => sound(audio => audio.setBackground(value), settings => settings.soundBackground),
            onSoundOutput: (value) => sound(audio => audio.setOutput(value), settings => settings.soundOutput),
            onSoundTone: (value) => sound(audio => audio.setTone(value), settings => settings.soundTone),
            onSoundSoften: (value) => sound(audio => audio.setSoften(value), settings => settings.soundSoften),
            onSoundQuietHours: (value) => sound(audio => audio.setQuietHours(value), settings => settings.soundQuietHours),
            onSoundHush: (on) => sound((audio) => {
                if (on) audio.hush(HUSH_DURATION_MS);
                else audio.resumeFromHush();
                return audio.soundView().hushedUntil ?? 0;
            }, settings => settings.soundHushUntil),
            onAutoCamera: (enabled) => this._setAutoCamera(enabled),
            onDesktopAlerts: (enabled) => this._setDesktopAlerts(enabled),
            onSidebarCollapsed: (collapsed) => this._setSidebarCollapsed(collapsed),
            onReducedMotion: (reduced) => this._setReducedMotion(reduced),
            onReset: () => this._resetSettings(),
            getVillageState: () => this._villageState,
            getChronicleStatus: () => globalThis.window?.__chronicle?.status || this._chronicleStatus,
            getCurrentFps: () => this._lastFps,
            getHookFreshness: (provider, now) => this._hookFreshness(provider, now),
            unknownModelSeenToday: () => this._unknownModelSeenToday(),
            alertsAvailable: this.attention?.desktopAlertsAvailable === true,
        });
        return this._settingsPanel.build();
    }

    // Reset writes every default, then brings the live controller to them:
    // sound Off, every level and listening preference at its default.
    _resetSettings() {
        resetPersistedSettings();
        this._setReducedMotion(false);
        const audio = this.audio;
        if (audio) {
            const defaults = readSoundSettings();
            audio.setPreset('off');
            if (audio.soundView().hushedUntil) audio.resumeFromHush();
            audio.setVolumeStep(readPresetVolumeStep('off'));
            audio.setBackground(defaults.soundBackground);
            audio.setOutput(defaults.soundOutput);
            audio.setTone(defaults.soundTone);
            audio.setSoften(defaults.soundSoften);
            audio.setQuietHours(defaults.soundQuietHours);
        } else {
            this._applySoundView(storedSoundView());
        }
        eventBus.emit('sound:town-band-voice', { voice: DEFAULT_TOWN_BAND_VOICE });
        eventBus.emit('camera:auto-camera', { enabled: true });
        if (this.attention) {
            void this.attention.setDesktopAlerts(false).then((on) => this._applyAlertsState(on));
        }
        const sidebar = document.getElementById('sidebar');
        if (sidebar?.classList.contains('sidebar--collapsed')) {
            document.getElementById('sidebarToggle')?.click();
        }
        this._settingsPanel?.syncControls();
    }

    // One SET sound setter: through the controller once it exists (it
    // persists and applies, returning the stored value), else the stored
    // value as it stands.
    async _soundSetting(apply, stored) {
        try {
            const audio = await this._ensureAudio();
            if (audio && !this._destroyed) return apply(audio);
        } catch (error) {
            console.warn('[TopBar] Audio unavailable:', error.message);
        }
        return stored(readSoundSettings());
    }

    // A preset that is not the current one keeps its own volume step (7.8);
    // the controller reads it when that preset next plays.
    _writePresetVolume(preset, step) {
        writePresetVolumeStep(preset, step);
        return readPresetVolumeStep(preset);
    }

    // SET's Auto camera row is the FREE | AUTO half of the World dock's camera
    // control (App): persist, then announce; the dock and the renderer follow.
    _setAutoCamera(enabled) {
        const next = Boolean(enabled);
        if (readPersistedSettings().autoCamera !== next) {
            try { window.localStorage?.setItem('cv-auto-camera', next ? '1' : '0'); } catch { /* persistence is optional */ }
            eventBus.emit('camera:auto-camera', { enabled: next });
        }
        return readPersistedSettings().autoCamera;
    }

    async _setDesktopAlerts(enabled) {
        if (!this.attention?.desktopAlertsAvailable) return false;
        const on = await this.attention.setDesktopAlerts(Boolean(enabled));
        this._applyAlertsState(on);
        return on;
    }

    _setSidebarCollapsed(collapsed) {
        const next = Boolean(collapsed);
        const sidebar = document.getElementById('sidebar');
        const current = sidebar?.classList.contains('sidebar--collapsed')
            ?? readPersistedSettings().sidebarCollapsed;
        if (current !== next) document.getElementById('sidebarToggle')?.click();
        return document.getElementById('sidebar')?.classList.contains('sidebar--collapsed') ?? next;
    }

    _setReducedMotion(reduced) {
        this._motionOverride = this._motionOverride || installReducedMotionOverride();
        const applied = this._motionOverride?.set(Boolean(reduced)) ?? Boolean(reduced);
        // Soften sudden sounds follows Reduce motion unless set (7.7).
        this.audio?.syncReducedMotion?.();
        return applied;
    }

    _observeHookSignal(agent) {
        if (agent?.signalSource !== 'hook') return;
        const provider = String(agent.provider || '').trim().toLowerCase();
        if (provider) this._hookSeenAtByProvider.set(provider, Date.now());
    }

    _hookFreshness(provider, now = Date.now()) {
        const seenAt = this._hookSeenAtByProvider.get(String(provider || '').trim().toLowerCase());
        return Number.isFinite(seenAt) ? Math.max(0, now - seenAt) : null;
    }

    _unknownModelSeenToday() {
        const date = new Date();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const today = `${date.getFullYear()}-${month}-${day}`;
        const agents = this.world?.agents?.values?.() || [];
        if ([...agents].some((agent) => agent.cost?.unknownModel === true)) {
            try { window.localStorage?.setItem(UNKNOWN_MODEL_DATE_KEY, today); } catch { /* persistence is optional */ }
            return true;
        }
        return storageValue(globalThis.window?.localStorage, UNKNOWN_MODEL_DATE_KEY) === today;
    }

    _closeSettings() {
        if (this.modal?.isOpen(SETTINGS_MODAL_OWNER)) this.modal.close();
    }

    // The signal route (captions, the returning-user unlock, hidden-tab
    // wakes) exists from boot: the controller is built in the first idle
    // slot, at most 4 s after boot. It creates no AudioContext, and the
    // audio modules stay off the critical path (the v0.37 deferral).
    _scheduleAudioRoute() {
        const build = () => {
            this._audioIdleHandle = null;
            this._audioIdleTimer = null;
            if (this._destroyed) return;
            void this._ensureAudio().catch((error) => {
                console.warn('[TopBar] Audio unavailable:', error.message);
                this._applySoundView(storedSoundView());
            });
        };
        if (typeof requestIdleCallback === 'function') {
            this._audioIdleHandle = requestIdleCallback(build, { timeout: AUDIO_ROUTE_IDLE_TIMEOUT_MS });
        } else {
            this._audioIdleTimer = setTimeout(build, AUDIO_ROUTE_FALLBACK_DELAY_MS);
        }
    }

    _cancelAudioRoute() {
        if (this._audioIdleHandle != null && typeof cancelIdleCallback === 'function') {
            cancelIdleCallback(this._audioIdleHandle);
        }
        if (this._audioIdleTimer != null) clearTimeout(this._audioIdleTimer);
        this._audioIdleHandle = null;
        this._audioIdleTimer = null;
    }

    _ensureAudio() {
        if (this.audio) return Promise.resolve(this.audio);
        if (!this._audioLoadPromise) {
            this._audioLoadPromise = import('./AmbientAudioController.js').then((module) => {
                if (this._destroyed) return null;
                this.audio = new module.AmbientAudioController(this._audioOptions);
                // The views start from the controller's state, not only its
                // next change.
                this._applySoundView(this.audio.soundView?.());
                return this.audio;
            }).catch((error) => {
                this._audioLoadPromise = null;
                throw error;
            });
        }
        return this._audioLoadPromise;
    }

    // ── Sound (plan 7.1–7.3, 7.5, 7.6): the note, its chevron and the SOUND
    // popover are views of the controller's one state (`audio:sound-state`,
    // C-UX1); before the boot-idle build they read storage. The group is a
    // constant 44 px, so no sound state moves the bar.
    _initSound() {
        this._soundView = storedSoundView();
        this._soundChipKey = null;
        this._soundTogglePending = false;
        // 7.4: a hand approaching the note or a preset warms the context and
        // worklets (suspended, silent) once the controller exists, so the
        // first press sounds within 150 ms. Never at boot: armed keeps no
        // AudioContext.
        this._onSoundPrewarm = () => this.audio?.prewarm?.();
        this._buildSoundPanel();
        this._onSoundToggleClick = (event) => {
            event.preventDefault();
            this._onSoundChip();
        };
        this.els.soundToggle?.addEventListener('click', this._onSoundToggleClick);
        this.els.soundGroup?.addEventListener('pointerenter', this._onSoundPrewarm);
        this.els.soundGroup?.addEventListener('focusin', this._onSoundPrewarm);
        this._onSoundState = (view) => this._applySoundView(view);
        eventBus.on('audio:sound-state', this._onSoundState);
        // 7.5: the invite's accept runs inside its click, so the activation holds.
        this._onSoundInviteAccepted = ({ bucket } = {}) => this._withAudio((audio) => {
            audio.setPreset('signals', { fromUser: true });
            audio.testCall(bucket);
        });
        eventBus.on('sound:invite-accepted', this._onSoundInviteAccepted);
        // 7.6: `M` turns sound on and off from anywhere (a key press is a
        // user activation), never from a text field or under a modal.
        this._onSoundKey = (event) => {
            if (event.key !== 'm' && event.key !== 'M') return;
            if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
            if (isKeyboardEditTarget(event.target) || this.modal?.isOpen?.()) return;
            event.preventDefault();
            this._toggleSound({ announce: true });
        };
        document.addEventListener('keydown', this._onSoundKey);
        this._reducedMotionQuery = globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
        this._onReducedMotionChange = () => this.audio?.syncReducedMotion?.();
        this._reducedMotionQuery?.addEventListener?.('change', this._onReducedMotionChange);
        this._renderSoundChip();
    }

    _applySoundView(view) {
        if (!view || this._destroyed) return;
        this._soundView = view;
        this._renderSoundChip();
        if (this._soundPanelOpen()) this._renderSoundPanel();
    }

    // The first-ever click on the note opens the presets instead of picking
    // one (7.1); afterwards it turns sound Off ↔ the last preset.
    _onSoundChip() {
        if (this._destroyed) return;
        if (this._soundView.preset === 'off' && !readSoundChipSeen()) {
            writeSoundChipSeen();
            this._soundChipKey = null;
            this._renderSoundChip();
            this._showSoundPanel();
            return;
        }
        this._toggleSound();
    }

    _toggleSound({ announce = false } = {}) {
        if (this._soundTogglePending) return;
        const toggle = (audio) => {
            audio.toggleFromUser();
            if (!announce) return;
            const { preset } = audio.soundView();
            eventBus.emit('sound:status', {
                message: preset === 'off' ? 'Sound off' : `Sound on · ${SOUND_PRESET_LABELS[preset]}`,
            });
        };
        if (this.audio) {
            toggle(this.audio);
            return;
        }
        // A toggle before the boot-idle build waits for the controller; the
        // page's sticky activation carries the gesture across the load.
        this._soundTogglePending = true;
        this.els.soundToggle?.setAttribute('aria-busy', 'true');
        void this._withAudio(toggle).finally(() => {
            this._soundTogglePending = false;
            this.els.soundToggle?.removeAttribute('aria-busy');
        });
    }

    _withAudio(fn) {
        if (this.audio) {
            fn(this.audio);
            return Promise.resolve();
        }
        return this._ensureAudio().then((audio) => {
            if (audio && !this._destroyed) fn(audio);
        }).catch((error) => {
            console.warn('[TopBar] Audio unavailable:', error.message);
        });
    }

    // The chip: `data-sound-state`, its title and pressed state, written
    // only when one of them changed (no DOM writes while nothing moved).
    _renderSoundChip() {
        const button = this.els.soundToggle;
        if (!button) return;
        const view = this._soundView;
        const available = view.available !== false;
        const state = available ? view.soundState : 'off';
        const title = !available
            ? (view.chipTitle || 'Sound unavailable in this browser')
            : (view.preset === 'off' && !readSoundChipSeen() ? SOUND_FIRST_TITLE : view.chipTitle);
        const pressed = available && view.preset !== 'off' ? 'true' : 'false';
        const key = `${state}\u001f${title}\u001f${pressed}\u001f${available}`;
        if (key === this._soundChipKey) return;
        this._soundChipKey = key;
        setAttr(button, 'data-sound-state', state);
        setAttr(button, 'aria-pressed', pressed);
        button.dataset.tip = title;
        button.disabled = !available;
        if (this.els.soundMenu) this.els.soundMenu.disabled = !available;
    }

    // The SOUND popover (UX-2): heading, the `Listen to` radiogroup, volume,
    // the now line, the recalibration note (D5), the needs-you preview and
    // hush, and a link to SET. Fixed and right-anchored under the chevron, so
    // it escapes the bar's overflow clipping and never covers the NEEDS YOU
    // slot.
    _buildSoundPanel() {
        const trigger = this.els.soundMenu;
        if (!trigger || !document.body) return;
        const panel = el('div', { className: 'topbar__sound-panel' });
        panel.id = 'soundPanel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-labelledby', 'soundPanelHeading');
        panel.tabIndex = -1;
        panel.hidden = true;

        const heading = el('div', { className: 'topbar__sound-heading', text: 'SOUND' });
        heading.id = 'soundPanelHeading';

        const presets = el('div', { className: 'topbar__sound-presets' });
        presets.id = 'soundPresets';
        presets.setAttribute('role', 'radiogroup');
        presets.setAttribute('aria-label', 'Listen to');
        const radios = {};
        for (const preset of SOUND_PRESETS) {
            const radio = el('button', { className: 'topbar__sound-preset' }, [
                el('span', { className: 'topbar__sound-preset-name', text: SOUND_PRESET_LABELS[preset] }),
                el('span', { className: 'topbar__sound-preset-detail', text: SOUND_PRESET_DETAILS[preset] }),
            ]);
            radio.type = 'button';
            radio.setAttribute('role', 'radio');
            radio.setAttribute('aria-checked', 'false');
            radio.dataset.preset = preset;
            radio.tabIndex = -1;
            presets.appendChild(radio);
            radios[preset] = radio;
        }

        const volume = this._soundSlider('Volume', 'Volume');
        volume.input.id = 'soundVolume';

        const now = el('div', { className: 'topbar__sound-now' });
        now.id = 'soundNow';
        now.setAttribute('role', 'status');
        const note = el('div', { className: 'topbar__sound-note', text: SOUND_RECALIBRATED_MESSAGE });
        note.hidden = true;

        const preview = this._soundAction('soundPreview', 'PLAY THE NEEDS-YOU BELL');
        const hush = this._soundAction('soundHush', 'HUSH FOR 1 HOUR');
        const actions = el('div', { className: 'topbar__sound-actions' }, [preview, hush]);

        const more = this._soundAction('soundMore', 'MORE IN SETTINGS');
        const footer = el('div', { className: 'topbar__sound-footer' }, [more]);

        panel.append(heading, presets, volume.row, now, note, actions, footer);
        document.body.appendChild(panel);
        this._soundEls = { panel, presets, radios, volume, now, note, actions, preview, hush, more };

        this._onSoundMenuClick = (event) => {
            event.stopPropagation();
            if (this._soundPanelOpen()) this._hideSoundPanel();
            else this._showSoundPanel();
        };
        this._onSoundPanelKeydown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                this._hideSoundPanel();
                return;
            }
            if (presets.contains(event.target)) this._onSoundPresetKey(event);
        };
        this._onSoundMenuKeydown = (event) => {
            if (event.key !== 'Escape' || !this._soundPanelOpen()) return;
            event.preventDefault();
            event.stopPropagation();
            this._hideSoundPanel();
        };
        this._onSoundPanelClick = (event) => {
            const radio = event.target?.closest?.('[role="radio"]');
            if (radio && presets.contains(radio)) {
                this._chooseSoundPreset(radio.dataset.preset);
                return;
            }
            if (preview.contains(event.target)) void this._withAudio(audio => audio.playPreviewBell());
            else if (hush.contains(event.target)) this._toggleHush();
            else if (more.contains(event.target)) this._openSettings({ section: 'sound' });
        };
        this._onSoundPanelInput = (event) => this._onSoundSliderInput(event.target);
        this._onSoundFocusOut = (event) => {
            if (!this._soundPanelOpen()) return;
            const next = event.relatedTarget;
            if (next && (panel.contains(next) || this.els.soundGroup?.contains?.(next))) return;
            // Focus that left for elsewhere dismisses the panel without
            // pulling focus back.
            this._hideSoundPanel({ restoreFocus: false });
        };
        this._onSoundOutside = (event) => {
            if (!this._soundPanelOpen()) return;
            if (!panel.contains(event.target) && !this.els.soundGroup?.contains?.(event.target)) {
                this._hideSoundPanel({ restoreFocus: false });
            }
        };
        this._onSoundResize = () => this._hideSoundPanel({ restoreFocus: false });
        trigger.addEventListener('click', this._onSoundMenuClick);
        trigger.addEventListener('keydown', this._onSoundMenuKeydown);
        trigger.addEventListener('focusout', this._onSoundFocusOut);
        panel.addEventListener('keydown', this._onSoundPanelKeydown);
        panel.addEventListener('click', this._onSoundPanelClick);
        panel.addEventListener('input', this._onSoundPanelInput);
        panel.addEventListener('focusout', this._onSoundFocusOut);
        panel.addEventListener('pointerenter', this._onSoundPrewarm);
        panel.addEventListener('focusin', this._onSoundPrewarm);
        document.addEventListener('pointerdown', this._onSoundOutside);
        window.addEventListener('resize', this._onSoundResize);
    }

    // A 0–10 step slider row: `n / 10`, `aria-valuetext` `n of 10` or `Off`.
    _soundSlider(name, label) {
        const input = el('input', { className: 'topbar__sound-vol', ariaLabel: name });
        input.type = 'range';
        input.min = '0';
        input.max = String(SOUND_STEP_MAX);
        input.step = '1';
        const value = el('span', { className: 'topbar__sound-value' });
        const row = el('label', { className: 'topbar__sound-row' }, [
            el('span', { className: 'topbar__sound-label', text: label }),
            input,
            value,
        ]);
        return { row, input, value };
    }

    _soundAction(id, text) {
        const button = el('button', { className: 'topbar__sound-btn topbar__sound-action', text });
        button.type = 'button';
        button.id = id;
        return button;
    }

    _soundPanelOpen() {
        return Boolean(this._soundEls && !this._soundEls.panel.hidden);
    }

    _showSoundPanel() {
        if (this._destroyed || !this._soundEls || !this.els.soundMenu) return;
        this._closeSettings?.();
        this._hideSpendPanel({ restoreFocus: false });
        const { panel } = this._soundEls;
        const rect = this.els.soundMenu.getBoundingClientRect();
        panel.style.left = `${Math.round(Math.max(8, Math.min(rect.right - SOUND_PANEL_WIDTH, window.innerWidth - SOUND_PANEL_WIDTH - 8)))}px`;
        panel.style.top = `${Math.round(rect.bottom + 7)}px`;
        this._renderSoundPanel();
        panel.hidden = false;
        this.els.soundMenu.setAttribute('aria-expanded', 'true');
        focusWithoutScroll(this._soundEls.radios[this._soundView.preset] || panel);
    }

    _hideSoundPanel({ restoreFocus = true } = {}) {
        if (!this._soundPanelOpen()) return;
        this._soundEls.panel.hidden = true;
        this.els.soundMenu?.setAttribute('aria-expanded', 'false');
        if (restoreFocus) focusWithoutScroll(this.els.soundMenu);
    }

    // Written only while open, and then only what changed.
    _renderSoundPanel() {
        const els = this._soundEls;
        if (!els) return;
        const view = this._soundView;
        const available = view.available !== false;
        const on = available && view.preset !== 'off';
        const hushed = view.soundState === 'hushed';
        this._renderSoundPresets(view.preset);
        setHidden(els.volume.row, !on);
        setSliderStep(els.volume, Number(view.volumeStep) || 0);
        setText(els.now, view.nowLine || '');
        setHidden(els.note, !view.recalibrated);
        setHidden(els.preview, !on);
        // Hush drops a playing preset to Signals for an hour; while hushed
        // the same button resumes. Quiet hours end on their own.
        const hushable = hushed ? !view.quietActive : on && view.preset !== 'signals';
        setHidden(els.hush, !hushable);
        // Off with nothing to resume: no empty action row under the presets.
        setHidden(els.actions, !on && !hushable);
        setText(els.hush, hushed ? 'RESUME NOW' : 'HUSH FOR 1 HOUR');
    }

    // A real radiogroup with a roving tab stop on the checked preset.
    _renderSoundPresets(checked) {
        for (const [preset, radio] of Object.entries(this._soundEls.radios)) {
            const on = preset === checked;
            setAttr(radio, 'aria-checked', on ? 'true' : 'false');
            const tabIndex = on ? 0 : -1;
            if (radio.tabIndex !== tabIndex) radio.tabIndex = tabIndex;
        }
    }

    _onSoundPresetKey(event) {
        const order = SOUND_PRESETS;
        const current = order.indexOf(event.target?.closest?.('[role="radio"]')?.dataset?.preset);
        if (current < 0) return;
        let next = null;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (current + 1) % order.length;
        else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (current - 1 + order.length) % order.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = order.length - 1;
        if (next == null) return;
        event.preventDefault();
        const preset = order[next];
        focusWithoutScroll(this._soundEls.radios[preset]);
        this._chooseSoundPreset(preset);
    }

    _chooseSoundPreset(preset) {
        if (!SOUND_PRESETS.includes(preset)) return;
        writeSoundChipSeen();
        this._renderSoundPresets(preset);
        void this._withAudio(audio => audio.setPreset(preset, { fromUser: true }));
    }

    _onSoundSliderInput(input) {
        const els = this._soundEls;
        if (!els || input?.type !== 'range') return;
        const step = Math.max(0, Math.min(SOUND_STEP_MAX, Math.round(Number(input.value) || 0)));
        if (input !== els.volume.input) return;
        setSliderStep(els.volume, step);
        void this._withAudio(audio => audio.setVolumeStep(step));
    }

    _toggleHush() {
        void this._withAudio((audio) => {
            if (audio.soundView().soundState === 'hushed') audio.resumeFromHush();
            else audio.hush(HUSH_DURATION_MS);
        });
    }

    // Keep the thin topbar as the glance surface; its TODAY cell opens a
    // stable, inspectable spend map rather than trying to squeeze project names
    // between status badges. Click (rather than hover) also gives keyboard
    // users and operators chasing a spike time to read the rows.
    _initSpendBreakdown() {
        const trigger = this.els.rateWrap;
        if (!trigger || !this.spendLedger) return;
        trigger.tabIndex = 0;
        trigger.setAttribute('role', 'button');
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-controls', 'spendBreakdownPanel');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.dataset.tip = 'Open project and provider spend map';
        this._onSpendClick = (event) => {
            event.stopPropagation();
            this._toggleSpendPanel();
        };
        this._onSpendKeydown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                this._hideSpendPanel();
            } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this._toggleSpendPanel();
            }
        };
        this._onSpendPanelKeydown = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            this._hideSpendPanel();
        };
        this._onSpendFocusOut = (event) => {
            if (!this._spendPanelEl || this._spendPanelEl.style.display === 'none') return;
            const next = event.relatedTarget;
            if (next && (this._spendPanelEl.contains?.(next) || trigger.contains?.(next))) return;
            this._hideSpendPanel({ restoreFocus: false });
        };
        this._onSpendOutside = (event) => {
            if (!this._spendPanelEl || this._spendPanelEl.style.display === 'none') return;
            if (!this._spendPanelEl.contains(event.target) && !trigger.contains(event.target)) {
                this._hideSpendPanel({ restoreFocus: false });
            }
        };
        this._onSpendResize = () => this._hideSpendPanel({ restoreFocus: false });
        trigger.addEventListener('click', this._onSpendClick);
        trigger.addEventListener('keydown', this._onSpendKeydown);
        trigger.addEventListener('focusout', this._onSpendFocusOut);
        document.addEventListener('pointerdown', this._onSpendOutside);
        window.addEventListener('resize', this._onSpendResize);
    }

    render() {
        const stats = this.world.getStats();
        for (const agent of this.world?.agents?.values?.() || []) this._observeHookSignal(agent);
        this._unknownModelSeenToday();

        // Until the first snapshot the counts are unknown, not zero: show '–'.
        const pending = countsPending(this._villageState);
        this._countsPending = pending;
        this.els.center?.classList.toggle('topbar--pending', pending);
        this._renderSpend(pending);
        this._renderCount(this.els.working, stats.working, pending);
        this._renderCount(this.els.idle, stats.idle, pending);
        this._renderCount(this.els.waiting, stats.waiting, pending);
        this._renderAttention(stats, pending);

        this._renderActivityRail(stats);
    }

    // Before the first snapshot the slot claims nothing it has not seen. The
    // frame takes the colour of the first lit bucket; every numeral is exact.
    _renderAttention(stats, pending) {
        const frame = this.els.attention;
        if (!frame) return;
        const lit = [];
        for (const { key, noun } of ATTENTION_PARTS) {
            const count = pending ? 0 : Math.max(0, Number(stats?.[key]) || 0);
            const refs = this.els.attentionParts?.[key];
            if (refs) {
                refs.part.hidden = count <= 0;
                refs.num.textContent = String(count);
            }
            if (count > 0) lit.push({ key, count, noun });
        }
        frame.hidden = lit.length === 0;
        if (!lit.length) return;
        const lead = ATTENTION_PARTS.find(({ key }) => key === lit[0].key);
        if (frame.dataset.lead !== lead.key) {
            for (const { frame: slice } of ATTENTION_PARTS) frame.classList.toggle(slice, slice === lead.frame);
            frame.dataset.lead = lead.key;
        }
        frame.dataset.tip = `Needs action: ${lit.map(({ count, noun }) => `${count} ${noun}`).join(' · ')} · frame them`;
        frame.dataset.tipKey = 'A';
    }

    _renderCount(node, value, pending) {
        if (!node) return;
        const count = Number(value) || 0;
        node.textContent = pending ? '–' : String(count);
        node.parentElement?.classList.toggle('topbar__seg--zero', !pending && count === 0);
    }

    // Today's observed spend, the live burn rate, and quota headroom — the
    // three numbers that answer "am I burning tokens?". The old readout summed
    // the lifetime cost of whichever sessions happened to be resident, which
    // moved for reasons that had nothing to do with spending.
    _renderSpend(pending = this._countsPending) {
        const now = Date.now();
        const today = this.spendLedger?.sample?.(now) || { tokens: 0, cacheRead: 0, cost: 0 };
        const coverage = usageCoverage(this.world?.agents?.values?.() || []);
        const incomplete = coverage.partial + coverage.unavailable;
        this._coverageNote = incomplete ? `Partial coverage: ${coverage.partial} partial, ${coverage.unavailable} unavailable among current sessions.` : '';
        this.els.tokens.textContent = pending ? '–' : formatNumber(today.tokens);
        this.els.rateWrap?.classList.toggle('topbar__seg-stat--zero', !pending && !(today.tokens > 0));

        // The rate and the coverage caveat ride beside today's total — two
        // facts about the same number, and the topbar has no width to spare.
        const rate = this.spendLedger?.burnRate?.(now);
        this._spendRollups = this.spendLedger?.rollups?.(now) || { projects: [], providers: [] };
        const rateText = rate ? `${formatNumber(Math.round(rate.tokensPerHour))}/h` : '';
        this.els.rate.textContent = pending ? '' : [rateText, incomplete ? 'partial' : ''].filter(Boolean).join(' · ');
        if (this.els.rateWrap) {
            this.els.rateWrap.dataset.tip = rate
                ? `Tokens observed today, now running at about ~${formatCost(rate.costPerHour)}/hour at estimated API rates. Rate match: mixed session models; revision ${TokenUsage.rateRevision}. Click for project and provider detail.`
                : 'Tokens observed today by this page. A burn rate appears after a couple of minutes of activity. Click for project and provider detail.';
        }
        if (this.els.rateWrap && this._coverageNote) this.els.rateWrap.dataset.tip += ` ${this._coverageNote}`;
        if (this._spendPanelEl?.style.display !== 'none') this._renderSpendPanel();
    }

    _ensureSpendPanel() {
        if (this._spendPanelEl || !document.body) return;
        this._spendPanelEl = el('div', {
            className: 'topbar__spend-panel',
            ariaLabel: 'Spend by project and provider',
            style: { display: 'none' },
        });
        this._spendPanelEl.id = 'spendBreakdownPanel';
        this._spendPanelEl.setAttribute('role', 'dialog');
        this._spendPanelEl.tabIndex = -1;
        this._spendPanelEl.addEventListener('keydown', this._onSpendPanelKeydown);
        this._spendPanelEl.addEventListener('focusout', this._onSpendFocusOut);
        document.body.appendChild(this._spendPanelEl);
    }

    _toggleSpendPanel() {
        this._ensureSpendPanel();
        if (!this._spendPanelEl) return;
        if (this._spendPanelEl.style.display === 'none') this._showSpendPanel();
        else this._hideSpendPanel();
    }

    _showSpendPanel() {
        if (this._destroyed || !this.els.rateWrap) return;
        this._closeSettings?.();
        this._hideSoundPanel({ restoreFocus: false });
        this._ensureSpendPanel();
        this._renderSpendPanel();
        const panel = this._spendPanelEl;
        const rect = this.els.rateWrap.getBoundingClientRect();
        panel.style.left = `${Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - 516)))}px`;
        panel.style.top = `${Math.round(rect.bottom + 7)}px`;
        panel.style.display = 'block';
        this.els.rateWrap.setAttribute('aria-expanded', 'true');
        focusWithoutScroll(panel);
    }

    _hideSpendPanel({ restoreFocus = true } = {}) {
        const wasOpen = this._spendPanelEl?.style.display !== 'none';
        if (this._spendPanelEl) this._spendPanelEl.style.display = 'none';
        this.els.rateWrap?.setAttribute('aria-expanded', 'false');
        if (restoreFocus && wasOpen) focusWithoutScroll(this.els.rateWrap);
    }

    _renderSpendPanel() {
        const panel = this._spendPanelEl;
        if (!panel) return;
        const rollups = this._spendRollups || { projects: [], providers: [] };
        const heading = el('div', {
            text: 'SPEND MAP',
            className: 'topbar__spend-heading',
        });
        const hasUnknownModel = [...(this.world?.agents?.values?.() || [])]
            .some((agent) => agent.cost?.unknownModel === true);
        const note = el('div', {
            className: 'topbar__spend-note',
            title: `Estimated API pricing · rate match: mixed session models · revision ${TokenUsage.rateRevision}`,
        }, [
            `5-minute burn rate first · today observed totals · estimated API pricing, revision ${TokenUsage.rateRevision}. ${this._coverageNote || ''}`,
            hasUnknownModel ? ' ' : null,
            hasUnknownModel ? el('span', { className: 'dash-card__provider-badge', text: 'default rate' }) : null,
        ]);
        const columns = el('div', {
            className: 'topbar__spend-columns',
        }, [
            this._spendSection('PROJECTS', rollups.projects, true),
            this._spendSection('PROVIDERS', rollups.providers, false),
        ]);
        replaceChildren(panel, [heading, note, columns]);
    }

    _spendSection(title, rows, projects) {
        const section = el('section', {
            className: `topbar__spend-section topbar__spend-section--${projects ? 'projects' : 'providers'}`,
        });
        section.appendChild(el('div', {
            text: title,
            className: 'topbar__spend-section-heading',
        }));

        const visible = (rows || []).slice(0, 5);
        const projectLabels = projects ? this._projectLabels(rows) : null;
        if (visible.length === 0) {
            section.appendChild(el('div', {
                text: 'No sessions observed',
                className: 'topbar__spend-empty',
            }));
            return section;
        }

        for (const row of visible) {
            const name = projects
                ? projectLabels.get(row.key)
                : this._providerLabel(row.key);
            const burning = row.burnRate && row.burnRate.tokensPerHour > 0;
            const activeNoSpend = row.activeSessions > 0 && row.tokens === 0 && row.cost === 0;
            const unknownRate = [...(this.world?.agents?.values?.() || [])].some((agent) => {
                const key = projects
                    ? String(agent.projectPath || '').trim() || 'unattributed'
                    : String(agent.provider || '').trim().toLowerCase() || 'unknown';
                return key === row.key && agent.cost?.unknownModel === true;
            });
            const primary = burning
                ? `${formatNumber(Math.round(row.burnRate.tokensPerHour))}/h · ~${formatCost(row.burnRate.costPerHour)}/h`
                : activeNoSpend ? 'WATCHING · no spend observed' : 'QUIET';
            const detail = `${formatNumber(row.tokens)} tokens · ~${formatCost(row.cost)}`;
            section.appendChild(el('div', {
                title: `${projects ? row.key : `${name} provider`} · estimated API rates · rate match: mixed session models · revision ${TokenUsage.rateRevision}`,
                className: 'topbar__spend-row',
            }, [
                el('div', {
                    text: `${row.activeSessions > 0 ? '◆' : '·'} ${name}`,
                    className: `topbar__spend-name${row.activeSessions > 0 ? ' topbar__spend-name--active' : ''}`,
                }),
                el('div', {}, [
                    el('div', {
                        text: primary,
                        className: `topbar__spend-primary${burning ? ' topbar__spend-primary--burning' : ''}`,
                    }),
                    el('div', {
                        text: detail,
                        className: 'topbar__spend-detail',
                    }),
                    unknownRate ? ' ' : null,
                    unknownRate ? el('span', { className: 'dash-card__provider-badge', text: 'default rate' }) : null,
                ]),
            ]));
        }
        if (rows.length > visible.length) {
            section.appendChild(el('div', {
                text: `+${rows.length - visible.length} quieter ${projects ? 'projects' : 'providers'}`,
                className: 'topbar__spend-more',
            }));
        }
        return section;
    }

    _projectLabels(rows) {
        const names = new Map();
        const counts = new Map();
        for (const row of rows || []) {
            const name = row.key === 'unattributed' ? 'Unattributed' : shortProjectName(row.key, 'Unattributed');
            names.set(row.key, name);
            counts.set(name, (counts.get(name) || 0) + 1);
        }
        for (const row of rows || []) {
            const name = names.get(row.key);
            if ((counts.get(name) || 0) < 2 || row.key === 'unattributed') continue;
            const parts = String(row.key).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
            names.set(row.key, parts.slice(-2).join('/'));
        }
        return names;
    }

    _providerLabel(provider) {
        const labels = {
            claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grok: 'Grok',
            kimi: 'Kimi', opencode: 'OpenCode', omp: 'OMP', unknown: 'Unknown',
        };
        return labels[provider] || String(provider || 'Unknown');
    }

    // Fault rail: a static 1px red strip on the bar's bevel whose length is the
    // errored share of the fleet. A calm village shows nothing; there is no
    // decorative shimmer.
    _renderActivityRail(stats) {
        if (!this.els.root) return;
        const total = stats.total || 0;
        const erroredRatio = total > 0 ? Math.min(1, (stats.errored || 0) / total) : 0;
        this.els.root.style.setProperty('--cv-rail-errored', `${Math.round(erroredRatio * 100)}%`);
    }

    _initConnectionInstrument() {
        const chip = this.els.connection;
        if (!chip) return;
        chip.tabIndex = 0;
        chip.setAttribute('role', 'button');
        chip.setAttribute('aria-haspopup', 'dialog');
        chip.setAttribute('aria-controls', 'topbarConnectionDetails');
        chip.setAttribute('aria-expanded', 'false');
        // No data-tip: hover and focus open the connection panel itself.
        this._connectionLiveEl = el('span', {
            className: 'topbar__connection-live',
        });
        this._connectionLiveEl.setAttribute('aria-live', 'polite');
        chip.insertAdjacentElement('afterend', this._connectionLiveEl);
        this._onConnectionClick = (event) => {
            event.stopPropagation();
            this._toggleConnectionDetails();
        };
        this._onConnectionEnter = () => this._showConnectionDetails({ focus: false });
        this._onConnectionLeave = (event) => {
            if (this._connectionPanelEl?.contains(event.relatedTarget)) return;
            this._hideConnectionDetails({ restoreFocus: false });
        };
        this._onConnectionKeydown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                this._hideConnectionDetails();
            } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this._toggleConnectionDetails();
            }
        };
        this._onConnectionOutside = (event) => {
            if (this._connectionPanelEl?.contains(event.target) || chip.contains(event.target)) return;
            this._hideConnectionDetails({ restoreFocus: false });
        };
        chip.addEventListener('click', this._onConnectionClick);
        chip.addEventListener('mouseenter', this._onConnectionEnter);
        chip.addEventListener('mouseleave', this._onConnectionLeave);
        chip.addEventListener('keydown', this._onConnectionKeydown);
        document.addEventListener('pointerdown', this._onConnectionOutside);
        this._renderConnection();
    }

    _renderConnection(now = Date.now()) {
        const chip = this.els.connection;
        if (!chip) return;
        const { label, state, stale } = connectionChip(this._villageState, now);
        chip.textContent = label;
        chip.classList.toggle('topbar__conn--connected', state === LinkState.LIVE);
        chip.classList.toggle('topbar__conn--disconnected', state === LinkState.RECONNECTING);
        chip.classList.toggle('topbar__conn--syncing', state === LinkState.SYNCING);
        chip.classList.toggle('topbar__conn--polling', state === LinkState.POLLING);
        chip.classList.toggle('topbar__conn--reconnecting', state === LinkState.RECONNECTING);
        chip.classList.toggle('topbar__conn--stale', stale);
        const announcementKey = stale ? LinkState.STALE : state;
        if (announcementKey !== this._connectionAnnouncementKey) {
            this._connectionAnnouncementKey = announcementKey;
            if (this._connectionLiveEl) this._connectionLiveEl.textContent = `Connection ${label}`;
        }
        this._renderConnectionDetails(now);
        if (stale) this._scheduleStaleTick();
        else this._stopStaleTick();
    }

    _scheduleStaleTick() {
        if (this._staleTimer || this._destroyed) return;
        this._staleTimer = setTimeout(() => {
            this._staleTimer = null;
            if (!this._destroyed && isStale(this._villageState)) this._renderConnection();
        }, 1000);
    }

    _stopStaleTick() {
        if (!this._staleTimer) return;
        clearTimeout(this._staleTimer);
        this._staleTimer = null;
    }

    _ensureConnectionDetails() {
        if (this._connectionPanelEl || !document.body) return;
        this._connectionPanelEl = el('div', {
            className: 'topbar__connection-panel',
            ariaLabel: 'Connection details',
            style: { display: 'none' },
        });
        this._connectionPanelEl.id = 'topbarConnectionDetails';
        this._connectionPanelEl.setAttribute('role', 'dialog');
        this._connectionPanelEl.tabIndex = -1;
        this._connectionPanelEl.addEventListener('keydown', this._onConnectionKeydown);
        this._onConnectionPanelLeave = (event) => {
            if (this.els.connection?.contains(event.relatedTarget)) return;
            this._hideConnectionDetails({ restoreFocus: false });
        };
        this._connectionPanelEl.addEventListener('mouseleave', this._onConnectionPanelLeave);
        document.body.appendChild(this._connectionPanelEl);
    }

    _toggleConnectionDetails() {
        this._ensureConnectionDetails();
        if (this._connectionPanelEl?.style.display === 'none') this._showConnectionDetails();
        else this._hideConnectionDetails();
    }

    _showConnectionDetails({ focus = true } = {}) {
        if (this._destroyed || !this.els.connection) return;
        this._ensureConnectionDetails();
        const panel = this._connectionPanelEl;
        if (!panel) return;
        this._renderConnectionDetails();
        const rect = this.els.connection.getBoundingClientRect();
        panel.style.left = `${Math.round(Math.max(8, rect.left))}px`;
        panel.style.top = `${Math.round(rect.bottom)}px`;
        panel.style.display = 'grid';
        this.els.connection.setAttribute('aria-expanded', 'true');
        if (focus) focusWithoutScroll(panel);
    }

    _hideConnectionDetails({ restoreFocus = true } = {}) {
        const wasOpen = this._connectionPanelEl?.style.display !== 'none';
        if (this._connectionPanelEl) this._connectionPanelEl.style.display = 'none';
        this.els.connection?.setAttribute('aria-expanded', 'false');
        if (restoreFocus && wasOpen) focusWithoutScroll(this.els.connection);
    }

    _renderConnectionDetails(now = Date.now()) {
        const panel = this._connectionPanelEl;
        if (!panel) return;
        const link = this._villageState.link;
        const age = snapshotAgeMs(this._villageState, now);
        const snapshot = age === null
            ? 'Last successful snapshot: not received yet'
            : `Last successful snapshot: ${Math.round(age / 1000)}s ago`;
        const rows = [el('div', { text: snapshot })];
        if (link.state === LinkState.RECONNECTING && link.nextRetryAt) {
            const retryMs = Math.max(0, link.nextRetryAt - now);
            rows.push(el('div', { text: `Next retry: in ${Math.ceil(retryMs / 1000)}s` }));
        }
        const code = link.lastErrorCode || this._villageState.failureCode;
        if (code) rows.push(el('div', { text: `Reason: ${connectionReasonText(code)}` }));
        replaceChildren(panel, rows);
    }

    // Connection-loss as a felt chrome event: while offline the whole app
    // desaturates and dashboard cards freeze to a muted, shimmering opacity.
    // On reconnect a single warm gold sweep washes color back across the
    // chrome. The sweep waits for a new successful snapshot and its class is
    // cleared by a fallback timer, including when reduced motion is enabled.
    _applyConnectionChrome(connected) {
        const body = document.body;
        if (!body) return;
        if (!connected && !this._recoverySweepPending) {
            this._recoverySweepPending = true;
            this._recoveryBaselineSnapshotAt = this._villageState.link.lastSnapshotAt;
        }
        body.classList.toggle('cv-offline', !connected);
        const snapshotAt = this._villageState.link.lastSnapshotAt;
        if (connected
            && this._recoverySweepPending
            && snapshotAt
            && snapshotAt !== this._recoveryBaselineSnapshotAt
            && snapshotAt !== this._lastSweptSnapshotAt) {
            this._recoverySweepPending = false;
            this._recoveryBaselineSnapshotAt = snapshotAt;
            this._lastSweptSnapshotAt = snapshotAt;
            this._fireRecoverySweep(body);
        }
    }

    _fireRecoverySweep(body) {
        if (this._sweepTimer) clearTimeout(this._sweepTimer);
        body.classList.remove('cv-reconnect-sweep');
        // Force reflow so re-adding the class restarts the animation.
        void body.offsetWidth;
        body.classList.add('cv-reconnect-sweep');
        this._sweepTimer = setTimeout(() => {
            body.classList.remove('cv-reconnect-sweep');
            this._sweepTimer = null;
        }, 1100);
    }

    // Permanent header instrument; null means suspended, never a fabricated zero.
    renderFps(fps) {
        this._lastFps = typeof fps === 'number' && Number.isFinite(fps) && fps >= 0 ? fps : null;
        const counter = this.els.fps;
        if (!counter) return;
        counter.textContent = this._lastFps === null ? 'FPS idle' : `${Math.round(this._lastFps)} FPS`;
        counter.dataset.tip = this._lastFps === null
            ? 'World render loop is idle'
            : 'World render-loop frames per second, averaged over at least 500 ms; includes reused idle frames';
    }

    _startTimer() {
        this.timeInterval = setInterval(() => {
            const seconds = this.world.activeTime;
            const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
            const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
            const s = String(seconds % 60).padStart(2, '0');
            if (this.els.time) this.els.time.textContent = `${h}:${m}:${s}`;
        }, 1000);
    }

    async _openChangelog() {
        if (!this.modal || this._destroyed) return;
        const request = this.modal.beginRequest();
        if (request === null) return;
        if (!this._changelogHtml) {
            this._changelogController?.abort?.();
            const controller = new AbortController();
            this._changelogController = controller;
            try {
                const res = await fetch('/api/changelog', { signal: controller.signal });
                if (!res.ok) throw new Error(res.statusText);
                this._changelogHtml = this._changelogToHtml(await res.text());
            } catch (err) {
                if (err?.name === 'AbortError') return;
                this._changelogHtml = '<p>Failed to load changelog.</p>';
            } finally {
                if (this._changelogController === controller) this._changelogController = null;
            }
        }
        if (this._destroyed || !this.modal.isRequestCurrent(request)) return;
        this.modal.open('Changelog', this._changelogHtml, { wide: true, request });
    }

    _changelogToHtml(md) {
        const lines = md.split('\n');
        const parts = [];
        let inList = false;

        const closeList = () => {
            if (inList) { parts.push('</ul>'); inList = false; }
        };

        for (const line of lines) {
            if (line.startsWith('# ') || line === '---') {
                closeList();
            } else if (line.startsWith('## ')) {
                closeList();
                const text = line.slice(3).trim();
                const hotfixM = text.match(/^(v[\d.]+)\s+·\s+(.+?)\s+—\s+Hotfix/);
                const namedM  = text.match(/^(v[\d.]+)\s+—\s+\*(.+?)\*\s+·\s+(.+)/);
                if (namedM) {
                    const [, ver, name, date] = namedM;
                    parts.push(
                        `<div class="cl-release">` +
                        `<span class="cl-ver">${ver}</span>` +
                        `<span class="cl-name">${name}</span>` +
                        `<span class="cl-date">${date}</span>` +
                        `</div>`
                    );
                } else if (hotfixM) {
                    const [, ver, date] = hotfixM;
                    parts.push(
                        `<div class="cl-release cl-release--hotfix">` +
                        `<span class="cl-ver">${ver}</span>` +
                        `<span class="cl-hotfix-badge">Hotfix</span>` +
                        `<span class="cl-date">${date}</span>` +
                        `</div>`
                    );
                }
            } else if (line.startsWith('- ')) {
                if (!inList) { parts.push('<ul class="cl-list">'); inList = true; }
                parts.push(`<li>${this._inline(line.slice(2))}</li>`);
            } else if (line.trim() === '') {
                closeList();
            } else {
                closeList();
                parts.push(`<p>${this._inline(line)}</p>`);
            }
        }
        closeList();
        return parts.join('');
    }

    _inline(text) {
        return text
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`(.+?)`/g, '<code>$1</code>');
    }

    _snapCenter() {
        const center = this.els.center;
        if (!center?.isConnected) return;
        const pad = center.style.paddingRight === '1px' ? 1 : 0;
        // Adding 1 px of width moves a space-between item left by 0.5 px.
        const unpaddedLeft = center.getBoundingClientRect().left + pad / 2;
        const next = Math.abs(unpaddedLeft - Math.round(unpaddedLeft)) > 0.25 ? 1 : 0;
        if (next !== pad) center.style.paddingRight = next ? '1px' : '';
    }

    destroy() {
        if (this._destroyed) return this._destroyPromise;
        this._destroyed = true;
        eventBus.off('atmosphere:updated', this._onAtmosphere);
        this.els.attention?.remove();
        if (this.timeInterval) {
            clearInterval(this.timeInterval);
            this.timeInterval = null;
        }
        if (this._sweepTimer) {
            clearTimeout(this._sweepTimer);
            this._sweepTimer = null;
        }
        this._stopStaleTick();
        this._changelogController?.abort?.();
        this._changelogController = null;
        eventBus.off('agent:added', this._onUpdate);
        eventBus.off('agent:updated', this._onUpdate);
        eventBus.off('agent:removed', this._onUpdate);
        eventBus.off('fps:updated', this._onFps);
        eventBus.off('usage:updated', this._onUsage);
        eventBus.off('village:state', this._onVillageState);
        eventBus.off('chronicle:status', this._onChronicleStatus);
        if (this.els.connection) {
            this.els.connection.removeEventListener('click', this._onConnectionClick);
            this.els.connection.removeEventListener('mouseenter', this._onConnectionEnter);
            this.els.connection.removeEventListener('mouseleave', this._onConnectionLeave);
            this.els.connection.removeEventListener('keydown', this._onConnectionKeydown);
        }
        this._centerSnap?.disconnect();
        this._centerSnap = null;
        if (this._onConnectionOutside) document.removeEventListener('pointerdown', this._onConnectionOutside);
        if (this._connectionPanelEl && this._onConnectionPanelLeave) {
            this._connectionPanelEl.removeEventListener('mouseleave', this._onConnectionPanelLeave);
        }
        this._connectionPanelEl?.remove();
        this._connectionLiveEl?.remove();
        this._connectionPanelEl = null;
        this._connectionLiveEl = null;
        if (this._onVersionClick && this.els.version) {
            this.els.version.removeEventListener('click', this._onVersionClick);
        }
        if (this._onVersionKeydown && this.els.version) {
            this.els.version.removeEventListener('keydown', this._onVersionKeydown);
        }
        if (this._onAlertsClick && this.els.alertsToggle) {
            this.els.alertsToggle.removeEventListener('click', this._onAlertsClick);
        }
        if (this._onAttentionKey) document.removeEventListener('keydown', this._onAttentionKey);
        if (this._onChronicleClick && this.els.chronicleBtn) {
            this.els.chronicleBtn.removeEventListener('click', this._onChronicleClick);
        }
        if (this._onSettingsClick && this._settingsButtonEl) {
            this._settingsButtonEl.removeEventListener('click', this._onSettingsClick);
        }
        this._settingsButtonEl?.remove();
        this._settingsButtonEl = null;
        this._settingsPanel?.destroy();
        this._settingsPanel = null;
        if (this._onSpendClick && this.els.rateWrap) {
            this.els.rateWrap.removeEventListener('click', this._onSpendClick);
            this.els.rateWrap.removeEventListener('keydown', this._onSpendKeydown);
            this.els.rateWrap.removeEventListener('focusout', this._onSpendFocusOut);
        }
        if (this._onSpendOutside) document.removeEventListener('pointerdown', this._onSpendOutside);
        if (this._onSpendResize) window.removeEventListener('resize', this._onSpendResize);
        if (this._spendPanelEl && this._onSpendPanelKeydown) {
            this._spendPanelEl.removeEventListener('keydown', this._onSpendPanelKeydown);
        }
        if (this._spendPanelEl && this._onSpendFocusOut) {
            this._spendPanelEl.removeEventListener('focusout', this._onSpendFocusOut);
        }
        this._spendPanelEl?.remove();
        this._spendPanelEl = null;
        if (this._soundEls) {
            const { panel } = this._soundEls;
            this.els.soundMenu?.removeEventListener('click', this._onSoundMenuClick);
            this.els.soundMenu?.removeEventListener('keydown', this._onSoundMenuKeydown);
            this.els.soundMenu?.removeEventListener('focusout', this._onSoundFocusOut);
            panel.removeEventListener('keydown', this._onSoundPanelKeydown);
            panel.removeEventListener('click', this._onSoundPanelClick);
            panel.removeEventListener('input', this._onSoundPanelInput);
            panel.removeEventListener('focusout', this._onSoundFocusOut);
            panel.removeEventListener('pointerenter', this._onSoundPrewarm);
            panel.removeEventListener('focusin', this._onSoundPrewarm);
            document.removeEventListener('pointerdown', this._onSoundOutside);
            window.removeEventListener('resize', this._onSoundResize);
            panel.remove();
            this._soundEls = null;
        }
        this.els.soundToggle?.removeEventListener('click', this._onSoundToggleClick);
        this.els.soundGroup?.removeEventListener('pointerenter', this._onSoundPrewarm);
        this.els.soundGroup?.removeEventListener('focusin', this._onSoundPrewarm);
        document.removeEventListener('keydown', this._onSoundKey);
        eventBus.off('audio:sound-state', this._onSoundState);
        eventBus.off('sound:invite-accepted', this._onSoundInviteAccepted);
        this._reducedMotionQuery?.removeEventListener?.('change', this._onReducedMotionChange);
        this._reducedMotionQuery = null;
        this.chronicle?.destroy?.();
        this.chronicle = null;
        this._cancelAudioRoute();
        this._audioOptions = null;
        document.body?.classList.remove('cv-offline', 'cv-reconnect-sweep');
        this._destroyPromise = Promise.resolve(this.audio?.destroy?.());
        this.audio = null;
        return this._destroyPromise;
    }
}
