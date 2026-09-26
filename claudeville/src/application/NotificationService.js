import { eventBus } from '../domain/events/DomainEvent.js';
import { i18n } from '../config/i18n.js';

export class NotificationService {
    constructor(toast) {
        this.toast = toast;
        this.wsEverConnected = false;
        // Agents present in the first snapshot are the village as it already
        // was, not arrivals: joins stay silent until that snapshot has been
        // applied (village:state carries its lastSnapshotAt).
        this.snapshotApplied = false;

        this._onVillageState = (state) => {
            if (state?.link?.lastSnapshotAt) this.snapshotApplied = true;
        };

        this._onAgentAdded = (agent) => {
            if (!this.snapshotApplied) return;
            const msg = i18n.t('agentJoined');
            this.toast.show(typeof msg === 'function' ? msg(agent.name) : msg, 'info');
        };

        // A session ending is routine news, not a warning.
        this._onAgentRemoved = (agent) => {
            const msg = i18n.t('agentLeft');
            this.toast.show(typeof msg === 'function' ? msg(agent.name) : msg, 'info');
        };

        this._onWsConnected = () => {
            // Suppress the toast on the first connection of the page load; only
            // announce genuine reconnections.
            if (this.wsEverConnected) {
                this.toast.show(i18n.t('serverConnected'), 'success');
            }
            this.wsEverConnected = true;
        };

        this._onWsDisconnected = () => {
            if (this.wsEverConnected) {
                this.toast.show(i18n.t('serverDisconnected'), 'error');
            }
        };

        eventBus.on('village:state', this._onVillageState);
        eventBus.on('agent:added', this._onAgentAdded);
        eventBus.on('agent:removed', this._onAgentRemoved);
        eventBus.on('ws:connected', this._onWsConnected);
        eventBus.on('ws:disconnected', this._onWsDisconnected);
    }

    destroy() {
        eventBus.off('village:state', this._onVillageState);
        eventBus.off('agent:added', this._onAgentAdded);
        eventBus.off('agent:removed', this._onAgentRemoved);
        eventBus.off('ws:connected', this._onWsConnected);
        eventBus.off('ws:disconnected', this._onWsDisconnected);
    }
}
