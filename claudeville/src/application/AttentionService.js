import { eventBus } from '../domain/events/DomainEvent.js';
import { isAttentionStatus } from '../domain/services/StatusResolver.js';
import { AgentStatus } from '../domain/value-objects/AgentStatus.js';

// The village is meant to be watched from the corner of the eye, which means
// the one thing it must be able to do is reach someone who is not looking at
// it. Everything here is that: the tab title, the favicon, a cue, and a way to
// get from "something needs you" to "I am looking at it" in one keystroke.

const BASE_TITLE = 'ClaudeVille - Agent Visualization';
const FAVICON_IDLE = 'favicon.svg';
const FAVICON_ALERT = 'favicon-alert.svg';
const DESKTOP_ALERTS_KEY = 'claudeville.alerts.desktop';

const REASON_TEXT = {
    question: 'asked you a question',
    approval: 'is waiting for approval',
    plan_review: 'wants you to review a plan',
};

function attentionLabel(agent) {
    if (agent?.status === AgentStatus.ERRORED) return 'hit an error';
    if (agent?.status === AgentStatus.RATE_LIMITED) return 'is rate limited';
    const reason = REASON_TEXT[agent?.waitReason];
    if (reason) return reason;
    return 'is waiting for you';
}

export class AttentionService {
    constructor(world, {
        toast = null,
        document: doc = null,
        NotificationClass = null,
    } = {}) {
        this.world = world;
        this.toast = toast;
        this.doc = doc || (typeof document !== 'undefined' ? document : null);
        this.NotificationClass = NotificationClass
            || (typeof Notification !== 'undefined' ? Notification : null);
        this.desktopAlerts = this._readDesktopAlertsPref();

        this._known = new Set();       // agent ids currently needing a person
        this._notifications = new Map(); // agent id -> owned desktop notification
        this._cursor = 0;              // rotation position for focusNext()
        this._faviconEl = null;
        this._destroyed = false;
        this._desktopAlertRequest = 0;

        this._onWorldChanged = () => this.refresh();
        eventBus.on('agent:added', this._onWorldChanged);
        eventBus.on('agent:updated', this._onWorldChanged);
        eventBus.on('agent:removed', this._onWorldChanged);
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._desktopAlertRequest++;
        eventBus.off('agent:added', this._onWorldChanged);
        eventBus.off('agent:updated', this._onWorldChanged);
        eventBus.off('agent:removed', this._onWorldChanged);
        this._closeAllNotifications();
        this._known.clear();
        this._setTitle(0);
        this._setFavicon(false);
    }

    /** Agents needing a person, longest-waiting first. */
    list() {
        const agents = [...(this.world?.agents?.values?.() || [])]
            .filter(agent => isAttentionStatus(agent.status));
        agents.sort((a, b) => {
            const aSince = a.awaitingSince || a.lastSessionActivity || 0;
            const bSince = b.awaitingSince || b.lastSessionActivity || 0;
            return aSince - bSince;
        });
        return agents;
    }

    refresh() {
        if (this._destroyed) return;
        const agents = this.list();
        const ids = new Set(agents.map(agent => agent.id));

        for (const agent of agents) {
            if (this._known.has(agent.id)) continue;
            this._raise(agent);
        }
        for (const id of this._known) {
            if (!ids.has(id)) {
                this._closeNotification(id);
                eventBus.emit('attention:cleared', { agentId: id });
            }
        }
        this._known = ids;

        this._setTitle(agents.length);
        this._setFavicon(agents.length > 0);
    }

    _raise(agent) {
        const label = attentionLabel(agent);
        eventBus.emit('attention:raised', { agentId: agent.id, status: agent.status, label });
        this.toast?.show(`${agent.name} ${label}`, 'warning');
        this._notify(agent, label);
    }

    /**
     * Select and follow the next agent needing attention. Returns the agent it
     * moved to, or null when the village is calm.
     */
    focusNext() {
        const agents = this.list();
        if (!agents.length) return null;
        const agent = agents[this._cursor % agents.length];
        this._cursor = (this._cursor + 1) % agents.length;
        eventBus.emit('agent:selected', agent);
        return agent;
    }

    // ─── Desktop notifications (opt-in, user gesture only) ───────────────

    get desktopAlertsAvailable() {
        return !!this.NotificationClass;
    }

    /**
     * Toggle desktop notifications. Must be called from a user gesture —
     * browsers reject permission prompts otherwise, and asking unbidden is
     * exactly the kind of nagging this app is supposed to avoid.
     */
    async setDesktopAlerts(enabled) {
        const request = ++this._desktopAlertRequest;
        if (!enabled) {
            this.desktopAlerts = false;
            this._writeDesktopAlertsPref(false);
            this._closeAllNotifications();
            return false;
        }
        if (!this.desktopAlertsAvailable) {
            this.desktopAlerts = false;
            this._writeDesktopAlertsPref(false);
            this._closeAllNotifications();
            return false;
        }
        let permission = this.NotificationClass.permission;
        if (permission === 'default') {
            try {
                permission = await this.NotificationClass.requestPermission();
            } catch {
                permission = 'denied';
            }
        }
        if (this._destroyed || request !== this._desktopAlertRequest) return false;
        this.desktopAlerts = permission === 'granted';
        this._writeDesktopAlertsPref(this.desktopAlerts);
        if (!this.desktopAlerts) this._closeAllNotifications();
        return this.desktopAlerts;
    }

    _notify(agent, label) {
        if (this._destroyed || !this.desktopAlerts || !this.desktopAlertsAvailable) return;
        if (this.NotificationClass.permission !== 'granted') return;
        // Only speak up when nobody is looking at the village.
        if (this.doc && this.doc.visibilityState === 'visible') return;
        const agentId = agent.id;
        this._closeNotification(agentId);
        try {
            const note = new this.NotificationClass(`${agent.name} ${label}`, {
                body: agent.projectPath || 'ClaudeVille',
                tag: `claudeville-${agentId}`,
                icon: FAVICON_ALERT,
            });
            this._notifications.set(agentId, note);
            note.onclose = () => {
                if (this._notifications.get(agentId) === note) {
                    this._notifications.delete(agentId);
                }
            };
            note.onclick = () => {
                try { window.focus(); } catch { /* no-op */ }
                const current = this.world?.agents?.get?.(agentId);
                if (current) eventBus.emit('agent:selected', current);
                this._closeNotification(agentId);
            };
        } catch { /* notifications are best effort */ }
    }

    _closeNotification(agentId) {
        const note = this._notifications.get(agentId);
        if (!note) return;
        this._notifications.delete(agentId);
        note.onclick = null;
        note.onclose = null;
        try { note.close(); } catch { /* notifications are best effort */ }
    }

    _closeAllNotifications() {
        for (const agentId of [...this._notifications.keys()]) {
            this._closeNotification(agentId);
        }
    }

    _readDesktopAlertsPref() {
        try { return localStorage.getItem(DESKTOP_ALERTS_KEY) === '1'; } catch { return false; }
    }

    _writeDesktopAlertsPref(value) {
        try { localStorage.setItem(DESKTOP_ALERTS_KEY, value ? '1' : '0'); } catch { /* no-op */ }
    }

    // ─── Tab marks ───────────────────────────────────────────────────────

    _setTitle(count) {
        if (!this.doc) return;
        this.doc.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
    }

    _setFavicon(alert) {
        if (!this.doc) return;
        if (!this._faviconEl) this._faviconEl = this.doc.querySelector('link[rel="icon"]');
        if (!this._faviconEl) return;
        const href = alert ? FAVICON_ALERT : FAVICON_IDLE;
        if (this._faviconEl.getAttribute('href') === href) return;
        this._faviconEl.setAttribute('href', href);
    }
}
