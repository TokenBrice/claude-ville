import { eventBus } from '../../domain/events/DomainEvent.js';
import { CAPTION_SETTINGS, readCaptionSetting, readStoredSoundEnabled } from './SoundSettings.js';

const MAX_TOASTS = 5;
const AUTO_DISMISS_MS = 3000;
const MAX_CUE_CAPTIONS = 3;
const ROUTINE_CUE_DISMISS_MS = 4800;
const PRIMARY_CUE_DISMISS_MS = 8000;
// A digest summarises a whole absence, so it needs longer than any single cue.
const DIGEST_DISMISS_MS = 12000;
const CUE_CONTEXT_MAX_AGE_MS = 1500;
const ATTENTION_NOTICE_GRACE_MS = 1500;
const PRIMARY_CUES = new Set(['distress', 'limit', 'summons', 'reminder']);
// The cues a direct attention notice for the same agent folds into.
const ATTENTION_CUES = new Set(['distress', 'limit', 'summons']);
// A newer caption of these kinds replaces the older one instead of counting
// it: the village-wide reminder restates the current wait.
const SUPERSEDING_CUES = new Set(['reminder']);

// Every cue kind by stratum (S1). The caption setting (3.8, S6) chooses the
// strata: signals always caption; events (outcomes and routine) follow the
// setting; scenery captions only what can be heard. The return digest is
// sound-only: the `attention:digest` notice is its one caption.
const CUE_STRATUM = Object.freeze({
    summons: 'signal',
    distress: 'signal',
    limit: 'signal',
    reminder: 'signal',
    answered: 'signal',
    turnDone: 'event',
    subagentReturn: 'event',
    toolFailed: 'event',
    commit: 'event',
    push: 'event',
    release: 'event',
    pushFailed: 'event',
    dispatch: 'event',
    arrival: 'event',
    departure: 'event',
    recovery: 'event',
    council: 'event',
    aggregate: 'event',
    hourBell: 'scenery',
    aurora: 'scenery',
    thunder: 'scenery',
    linkLost: 'scenery',
    linkRestored: 'scenery',
    digest: 'soundOnly',
});

export function cueStratum(kind) {
    return CUE_STRATUM[kind] || 'event';
}

// Pure caption policy: caption setting × sound on/off × cue → shown?
// `auto` is signals only while sound is off and signals and events while it
// is on; scenery needs `all` and sound on.
export function cueCaptionShown(payload, { setting = 'auto', soundOn = false } = {}) {
    if (!payload || typeof payload !== 'object' || payload.soundOnly === true) return false;
    const choice = CAPTION_SETTINGS.includes(setting) ? setting : 'auto';
    switch (cueStratum(cleanLabel(payload.kind))) {
        case 'signal': return true;
        case 'event': return choice === 'events' || choice === 'all' || (choice === 'auto' && Boolean(soundOn));
        case 'scenery': return choice === 'all' && Boolean(soundOn);
        default: return false;
    }
}

// Agent-scoped cues: `<name> <action>`.
const AGENT_CUE_ACTIONS = Object.freeze({
    arrival: 'arrived',
    departure: 'departed',
    distress: 'hit an error',
    limit: 'is rate limited',
    recovery: 'recovered',
    summons: 'needs you',
    answered: 'was answered',
});

const CUE_TYPES = Object.freeze({
    arrival: 'info',
    departure: 'info',
    distress: 'error',
    limit: 'warning',
    recovery: 'success',
    summons: 'warning',
    reminder: 'warning',
    answered: 'success',
    turnDone: 'info',
    subagentReturn: 'info',
    dispatch: 'info',
    toolFailed: 'warning',
    pushFailed: 'warning',
    commit: 'success',
    push: 'success',
    release: 'success',
    council: 'warning',
    hourBell: 'warning',
    linkLost: 'warning',
    linkRestored: 'success',
});

// Reminders restate the village's oldest wait by its family (SIG-2).
const REMINDER_GROUP_COPY = Object.freeze({
    needsYou: 'waiting',
    errors: 'with errors',
    quota: 'rate limited',
});
const REMINDER_ONE_COPY = Object.freeze({
    needsYou: 'still needs you',
    errors: 'still has an error',
    quota: 'is still rate limited',
});

const ATTENTION_REASON_COPY = Object.freeze({
    question: 'asked you a question',
    approval: 'is waiting for approval',
    plan_review: 'wants you to review a plan',
    errored: 'hit an error',
    rate_limited: 'is rate limited',
});

function cleanLabel(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, 96);
}

// Cue captions are a few words; a digest summarises a whole absence and needs
// more room than cleanLabel's 96-character cue budget allows.
function cleanDigestMessage(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, 280);
}

function labelAlreadyDescribesCue(label) {
    return /\b(arrived|departed|left|needs|waiting|distress|recovered|answered|gathering|rang|ringing|reached|thunder|error|rate[- ]limited)\b/i.test(label);
}

function labelIsPredicate(label) {
    return /^(?:is|has|was|hit|reached)\b/i.test(label);
}

// An exact count (aggregates, dispatch fans); a missing count is one.
function cueCount(payload) {
    const count = Math.floor(Number(payload?.count));
    return Number.isFinite(count) && count > 0 ? count : 1;
}

function reminderCaption(payload, name) {
    const count = cueCount(payload);
    const family = cleanLabel(payload.family);
    const oldestMs = Number(payload.oldestMs);
    const minutes = Number.isFinite(oldestMs) && oldestMs > 0 ? Math.max(1, Math.round(oldestMs / 60_000)) : 0;
    if (count > 1) {
        const age = minutes ? ` · oldest ${minutes} min` : '';
        return `${count} ${REMINDER_GROUP_COPY[family] || REMINDER_GROUP_COPY.needsYou}${age}`;
    }
    const age = minutes ? ` · ${minutes} min` : '';
    return `${name || 'An agent'} ${REMINDER_ONE_COPY[family] || REMINDER_ONE_COPY.needsYou}${age}`;
}

// 0–23 → the tower's 12-hour count ("3 o'clock"); anything else → no hour.
function hourBellCaption(payload) {
    const hour = Number(payload.hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return 'Hour bell';
    return `Hour bell · ${hour % 12 || 12} o'clock`;
}

function councilCaption(payload) {
    const team = cleanLabel(payload.teamName);
    const size = Math.floor(Number(payload.teamSize));
    const members = Number.isFinite(size) && size > 0 ? ` (${size})` : '';
    return `${team || 'A team'} gathered${members}`;
}

// Cues whose caption states a fact beyond the agent's name: counts, repos,
// versions, the hour. `name` is the agent's display name, or '' when the cue
// names none. Thunder makes no location claim.
const FACT_CUE_COPY = Object.freeze({
    reminder: reminderCaption,
    turnDone: (payload, name) => (cueCount(payload) > 1
        ? `${cueCount(payload)} turns finished`
        : `${name || 'An agent'} finished a turn`),
    subagentReturn: (payload, name) => (cueCount(payload) > 1
        ? `${cueCount(payload)} sub-agents returned`
        : (name ? `A sub-agent returned to ${name}` : 'A sub-agent returned')),
    toolFailed: (payload, name) => (cueCount(payload) > 1
        ? `${cueCount(payload)} commands failed`
        : (name ? `${name}: a command failed` : 'A command failed')),
    commit: (payload, name) => {
        const repo = cleanLabel(payload.repo);
        const into = repo ? ` to ${repo}` : '';
        return cueCount(payload) > 1
            ? `${cueCount(payload)} commits${into}`
            : `${name || 'An agent'} committed${into}`;
    },
    push: (payload, name) => {
        const repo = cleanLabel(payload.repo);
        return cueCount(payload) > 1
            ? `${cueCount(payload)} pushes${repo ? ` to ${repo}` : ''}`
            : `${name || 'An agent'} pushed${repo ? ` ${repo}` : ''}`;
    },
    release: (payload) => {
        const version = cleanLabel(payload.version);
        const repo = cleanLabel(payload.repo);
        return `${version || repo || 'A release'} released`;
    },
    pushFailed: (payload, name) => (name ? `${name}: git push failed` : 'Git push failed'),
    dispatch: (payload, name) => {
        const count = cueCount(payload);
        return `${name || 'An agent'} dispatched ${count === 1 ? 'a sub-agent' : `${count} sub-agents`}`;
    },
    council: councilCaption,
    hourBell: hourBellCaption,
    aurora: () => 'Village milestone reached',
    thunder: () => 'Thunder',
    linkLost: () => 'Live feed lost',
    linkRestored: () => 'Live feed restored',
});

function attentionAgentId(payload) {
    const value = payload?.agentId ?? payload?.agent?.id;
    return value == null ? '' : cleanLabel(String(value));
}

function attentionNotice(payload, observedAgentLabel = '') {
    if (!payload || typeof payload !== 'object') return '';
    const name = cleanLabel(
        payload.agent?.name
        || payload.agent?.displayName
        || observedAgentLabel,
    );
    const label = cleanLabel(
        payload.label
        || ATTENTION_REASON_COPY[cleanLabel(payload.reason)]
        || ATTENTION_REASON_COPY[cleanLabel(payload.status)]
        || 'needs your attention',
    );
    if (!name) return labelIsPredicate(label) ? `An agent ${label}` : label;
    if (label.toLowerCase().startsWith(`${name.toLowerCase()} `)) return label;
    return `${name} ${label}`;
}

function isAttentionNotice(message) {
    return /\b(?:needs you|needs attention|asked you|waiting for you|waiting for approval|wants you|hit an error|rate[- ]limited)\b/i.test(message);
}

function attentionMessageSpecificity(message) {
    const text = cleanLabel(message);
    if (/\b(?:asked you|waiting for approval|review a plan|hit an error|rate[- ]limited)\b/i.test(text)) return 2;
    if (/\b(?:needs you|needs attention|waiting for you|wants you)\b/i.test(text)) return 1;
    return 0;
}

// Agent-scoped producers may send either a display name or a short reason.
// Prefer the locally observed name when available, while accepting complete
// producer copy without doubling its verb ("Aurora needs you needs you").
// A ceremony that absorbed routine parts keeps their count ("· 5 arrivals").
export function formatCueCaption(payload, observedAgentLabel = '') {
    const message = cueMessage(payload, observedAgentLabel);
    const parts = cleanLabel(payload?.replaces?.parts);
    return message && parts ? `${message} · ${parts}` : message;
}

function cueMessage(payload, observedAgentLabel) {
    if (!payload || typeof payload !== 'object') return '';
    const kind = cleanLabel(payload.kind);
    const label = cleanLabel(payload.label);
    const observedName = cleanLabel(observedAgentLabel);

    if (observedName && kind === 'summons' && labelIsPredicate(label)) {
        return `${observedName} ${label}`;
    }

    const action = AGENT_CUE_ACTIONS[kind];
    if (action) {
        const producerSuppliedCopy = label && labelAlreadyDescribesCue(label);
        if (observedName) return `${observedName} ${action}`;
        if (producerSuppliedCopy) {
            return labelIsPredicate(label) ? `An agent ${label}` : label;
        }
        return `${label || 'An agent'} ${action}`;
    }
    const fact = FACT_CUE_COPY[kind];
    if (fact) {
        // The label names the agent only on an agent-scoped cue; a bare kind
        // is the cue kit's fallback, not a name.
        const labelName = payload.agentId != null && label !== kind ? label : '';
        return fact(payload, observedName || labelName);
    }
    return label || '';
}

// One caption key for both showing a cue and finding the caption a ceremony
// replaces: the agent when the cue names one, else the caption text.
function cueCaptionKey(kind, agentId, message) {
    return `${kind}:${agentId || message}`;
}

export class Toast {
    constructor({
        eventTarget = eventBus,
        documentRef = globalThis.document,
        storage = globalThis.window?.localStorage,
    } = {}) {
        this.documentRef = documentRef;
        // The caption setting and the sound switch are read per cue, so a SET
        // change applies to the next caption with no event of its own.
        this._storage = storage;
        this.container = documentRef?.getElementById?.('toastContainer') || null;
        this.toasts = [];
        this._destroyed = false;
        this._eventTarget = eventTarget;
        this._agentLabels = new Map();
        this._recentCueContext = new Map();
        this._eventUnsubscribes = [];
        const on = (event, handler) => {
            const unsubscribe = eventTarget?.on?.(event, handler);
            if (typeof unsubscribe === 'function') this._eventUnsubscribes.push(unsubscribe);
        };
        on('agent:added', agent => this._rememberAgentLabel(agent));
        on('agent:updated', agent => this._rememberAgentLabel(agent));
        // Keep the last label after removal so the ensuing departure cue can
        // still name its agent; the bounded cache prevents unbounded history.
        on('agent:removed', agent => this._rememberAgentLabel(agent));
        // AttentionService emits this before calling toast.show(). Claim the
        // specific event once here so the subsequent direct notice and the
        // summons caption share one live-region entry.
        on('attention:raised', payload => {
            this.showAttention(payload);
        });
        // Lifecycle audio is emitted synchronously from village scenes. Keep a
        // very short-lived context bridge for producers that use the contract's
        // nullable agentId and generic fallback label.
        on('village:scene', scene => this._rememberCueContext(scene));
        on('audio:cue-played', (payload) => {
            this.showCue(payload);
        });
        // The unattended digest reports what happened while the operator was away.
        // It is pre-composed by AttentionService; render it as a persistent primary
        // notice so it survives the cue traffic that arrives on return.
        on('attention:digest', (payload) => {
            this.showDigest(payload);
        });
        // The one-time D5 reset of stored sound levels (plan 1.2) says so once;
        // SoundSettings owns the copy; the controller emits it only when
        // stored levels were actually replaced.
        on('audio:recalibrated', (payload) => {
            this.showNotice(payload?.message);
        });
        on('chronicle:read-failed', payload => {
            this.show(payload?.message || 'Could not load the Chronicle day.', 'warning');
        });
        on('chronicle:export-failed', payload => {
            this.show(payload?.message || 'Could not export the Chronicle.', 'warning');
        });
    }

    show(message, type = 'info') {
        if (this._destroyed || !this.container) return;

        const cleanMessage = cleanLabel(message);
        const collapsed = this._collapseDirectAttention(cleanMessage, type);
        if (collapsed) return collapsed;

        const agentId = isAttentionNotice(cleanMessage) ? this._agentIdForMessage(cleanMessage) : '';
        return this._show(message, type, {
            dismissMs: AUTO_DISMISS_MS,
            attentionAgentId: agentId,
            attentionExpectedMessages: agentId ? [cleanMessage] : [],
        });
    }

    showAttention(payload) {
        if (this._destroyed || !this.container) return;
        const agentId = attentionAgentId(payload);
        const observedName = this._agentLabels.get(agentId) || '';
        if (payload?.agent) this._rememberAgentLabel(payload.agent);
        const message = attentionNotice(payload, observedName);
        if (!message) return;
        const eventKey = `${agentId}:${cleanLabel(payload?.reason || payload?.status || payload?.label)}`;
        const existing = [...this.toasts]
            .reverse()
            .find(entry => entry.attentionAgentId === agentId && entry.attentionEventKey === eventKey);
        if (existing) {
            this._preferMessage(existing, message);
            return existing;
        }
        return this._show(message, 'warning', {
            dismissMs: PRIMARY_CUE_DISMISS_MS,
            cueKey: `attention:${eventKey}`,
            cueKind: 'attention',
            primary: true,
            attentionAgentId: agentId,
            attentionEventKey: eventKey,
            attentionExpectedMessages: [message],
        });
    }

    showDigest(payload) {
        if (this._destroyed || !this.container) return;

        const message = cleanDigestMessage(payload?.message);
        if (!message) return;

        const type = cleanLabel(payload?.type) || 'info';
        // One digest at a time: a newer summary supersedes an older one rather
        // than stacking two overlapping accounts of the same absence.
        const existing = this.toasts.find(entry => entry.cueKind === 'unattended-digest');
        if (existing) this._remove(existing);

        return this._show(message, type, {
            dismissMs: DIGEST_DISMISS_MS,
            cueKind: 'unattended-digest',
            primary: true,
        });
    }

    // A settings notice: plain, longer-lived than a transient toast, never an
    // alert and never counted against the cue captions.
    showNotice(message) {
        if (this._destroyed || !this.container) return;
        const text = cleanLabel(message);
        if (!text) return;
        return this._show(text, 'info', { dismissMs: PRIMARY_CUE_DISMISS_MS });
    }

    showCue(payload) {
        if (this._destroyed || !this.container) return;
        if (!cueCaptionShown(payload, {
            setting: readCaptionSetting(this._storage),
            soundOn: readStoredSoundEnabled(this._storage),
        })) return;

        const kind = cleanLabel(payload?.kind) || 'unknown';
        const context = this._cueContextFor(kind);
        const contractedAgentId = payload?.agentId == null ? '' : cleanLabel(String(payload.agentId));
        const agentId = contractedAgentId || context?.agentId || '';
        const observedLabel = this._agentLabels.get(agentId) || context?.label;
        const message = formatCueCaption(payload, observedLabel);
        if (!message) return;
        if (payload.replaces) this._removeReplacedCue(payload.replaces);

        // AttentionService's direct notice is more specific than the generic
        // summons caption. Reuse either an event-owned notice or a direct
        // notice that was already shown for the same agent.
        if (ATTENTION_CUES.has(kind)) {
            const attention = [...this.toasts]
                .reverse()
                .find(entry => entry.attentionAgentId === agentId && entry.attentionAt
                    && Date.now() - entry.attentionAt <= ATTENTION_NOTICE_GRACE_MS);
            if (attention) return attention;
        }
        if (SUPERSEDING_CUES.has(kind)) {
            for (const entry of this.toasts.filter(entry => entry.cueKind === kind)) this._remove(entry);
        }

        const key = cueCaptionKey(kind, agentId, message);
        const duplicate = this.toasts.find(entry => entry.cueKey === key);
        const isPrimary = PRIMARY_CUES.has(kind);
        const dismissMs = isPrimary ? PRIMARY_CUE_DISMISS_MS : ROUTINE_CUE_DISMISS_MS;

        if (duplicate) {
            duplicate.count += 1;
            duplicate.el.textContent = `${duplicate.message} ×${duplicate.count}`;
            duplicate.el.setAttribute('aria-label', `${duplicate.message}, repeated ${duplicate.count} times`);
            this._restartDismissTimer(duplicate, dismissMs);
            return duplicate;
        }

        const visibleCues = this.toasts.filter(entry => entry.cueKey);
        if (visibleCues.length >= MAX_CUE_CAPTIONS) {
            const routine = visibleCues.find(entry => !entry.primary);
            // Routine ambience yields first. An all-primary stack may briefly
            // exceed the soft cap so a needs-you or distress cue never vanishes.
            if (routine) this._remove(routine);
            else if (!isPrimary) return;
        }

        const type = CUE_TYPES[kind] || 'info';
        return this._show(message, type, {
            dismissMs,
            cueKey: key,
            cueKind: kind,
            primary: isPrimary,
            agentId,
        });
    }

    // A ceremony supersedes the routine caption of its own parts: the parts'
    // caption leaves and the ceremony's caption carries their count.
    _removeReplacedCue(replaces) {
        const kind = cleanLabel(replaces?.kind);
        if (!kind) return;
        const agentId = replaces.agentId == null ? '' : cleanLabel(String(replaces.agentId));
        const message = cueMessage(replaces, this._agentLabels.get(agentId));
        const key = cueCaptionKey(kind, agentId, message);
        const replaced = this.toasts.find(entry => entry.cueKey === key);
        if (replaced) this._remove(replaced);
    }

    _collapseDirectAttention(message, type) {
        if (!message || !isAttentionNotice(message) || (type !== 'warning' && type !== 'error')) return null;

        const exact = [...this.toasts]
            .reverse()
            .find(entry => entry.attentionExpectedMessages?.has?.(message));
        if (exact) {
            this._preferMessage(exact, message);
            return exact;
        }

        const agentId = this._agentIdForMessage(message);
        if (!agentId) return null;
        const existing = [...this.toasts]
            .reverse()
            .find(entry => (ATTENTION_CUES.has(entry.cueKind) || entry.attentionAgentId === agentId)
                && (entry.agentId === agentId || entry.attentionAgentId === agentId));
        if (!existing) return null;
        existing.attentionAgentId = agentId;
        existing.attentionAt = Date.now();
        existing.attentionExpectedMessages ||= new Set();
        existing.attentionExpectedMessages.add(message);
        this._preferMessage(existing, message);
        return existing;
    }

    _agentIdForMessage(message) {
        for (const [agentId, label] of this._agentLabels) {
            if (message.toLowerCase().startsWith(`${label.toLowerCase()} `)) return agentId;
        }
        return '';
    }

    _preferMessage(entry, message) {
        const next = cleanLabel(message);
        if (!entry || !next || entry.message === next) return;
        if (attentionMessageSpecificity(next) < attentionMessageSpecificity(entry.message)) return;
        entry.message = next;
        entry.el.textContent = next;
        entry.el.setAttribute('aria-label', next);
    }

    _show(message, type, {
        dismissMs,
        cueKey = '',
        cueKind = '',
        primary = false,
        agentId = '',
        attentionAgentId = '',
        attentionEventKey = '',
        attentionExpectedMessages = [],
    }) {
        if (!this._makeRoom(primary)) return;

        const el = this.documentRef?.createElement?.('div');
        if (!el) return;
        el.className = `toast toast--${type}`;
        el.textContent = message;
        if (type === 'error' || primary) el.setAttribute('role', 'alert');
        if (cueKind) {
            el.classList.add('toast--cue');
            el.dataset.cueKind = cueKind;
        }
        this.container.appendChild(el);

        const entry = {
            el,
            message,
            count: 1,
            cueKey,
            cueKind,
            primary,
            agentId,
            attentionAgentId,
            attentionEventKey,
            attentionAt: attentionAgentId || attentionEventKey ? Date.now() : 0,
            attentionExpectedMessages: new Set(attentionExpectedMessages),
            dismissTimer: null,
            removalTimer: null,
        };
        this.toasts.push(entry);
        this._restartDismissTimer(entry, dismissMs);
        return entry;
    }

    _makeRoom(incomingIsPrimary) {
        while (this.toasts.length >= MAX_TOASTS) {
            const routine = this.toasts.find(entry => !entry.primary);
            if (routine) this._remove(routine);
            else if (!incomingIsPrimary) return false;
            else break;
        }
        return true;
    }

    _restartDismissTimer(entry, dismissMs) {
        if (entry.dismissTimer) clearTimeout(entry.dismissTimer);
        entry.dismissTimer = setTimeout(() => {
            entry.dismissTimer = null;
            this._fadeOut(entry);
        }, dismissMs);
    }

    _rememberAgentLabel(agent) {
        const id = agent?.id == null ? '' : cleanLabel(String(agent.id));
        const label = cleanLabel(agent?.name || agent?.displayName || agent?.label);
        if (!id || !label) return;
        this._agentLabels.delete(id);
        this._agentLabels.set(id, label);
        while (this._agentLabels.size > 256) {
            this._agentLabels.delete(this._agentLabels.keys().next().value);
        }
    }

    _rememberCueContext(scene) {
        const kind = cleanLabel(scene?.kind);
        if (kind !== 'arrival' && kind !== 'departure') return;
        const agentId = scene?.agentId == null ? '' : cleanLabel(String(scene.agentId));
        const label = cleanLabel(scene?.label);
        if (!agentId && !label) return;
        this._recentCueContext.set(kind, { agentId, label, at: Date.now() });
    }

    _cueContextFor(kind) {
        const context = this._recentCueContext.get(kind);
        if (!context) return null;
        this._recentCueContext.delete(kind);
        return Date.now() - context.at <= CUE_CONTEXT_MAX_AGE_MS ? context : null;
    }

    _fadeOut(entry) {
        if (this._destroyed || entry.removalTimer || !this.toasts.includes(entry)) return;
        entry.el.classList.add('toast--fadeout');
        entry.removalTimer = setTimeout(() => {
            entry.removalTimer = null;
            this._remove(entry);
        }, 300);
    }

    _remove(entry) {
        if (!entry) return;
        if (entry.dismissTimer) clearTimeout(entry.dismissTimer);
        if (entry.removalTimer) clearTimeout(entry.removalTimer);
        entry.dismissTimer = null;
        entry.removalTimer = null;
        if (entry.el.parentNode) {
            entry.el.parentNode.removeChild(entry.el);
        }
        const idx = this.toasts.indexOf(entry);
        if (idx !== -1) this.toasts.splice(idx, 1);
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        for (const unsubscribe of this._eventUnsubscribes) unsubscribe();
        this._eventUnsubscribes = [];
        this._eventTarget = null;
        this._agentLabels.clear();
        this._recentCueContext.clear();
        for (const entry of [...this.toasts]) this._remove(entry);
        this.container = null;
        this.documentRef = null;
    }
}
