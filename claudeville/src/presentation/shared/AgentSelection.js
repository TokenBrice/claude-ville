import { eventBus } from '../../domain/events/DomainEvent.js';

export const AGENT_SELECTED_EVENT = 'agent:selected';
export const AGENT_DESELECTED_EVENT = 'agent:deselected';

export function emitAgentSelected(agent) {
    if (agent) eventBus.emit(AGENT_SELECTED_EVENT, agent);
}

export function emitAgentDeselected() {
    eventBus.emit(AGENT_DESELECTED_EVENT);
}

export function toggleAgentSelection(world, agentId, selectedId) {
    if (!agentId) return;
    if (agentId === selectedId) {
        emitAgentDeselected();
        return;
    }
    const agent = world?.agents?.get?.(agentId);
    emitAgentSelected(agent);
}

export class AgentSelectionMirror {
    constructor({ onChange, notifyOnRepeat = false } = {}) {
        this.selectedId = null;
        this._onChange = onChange;
        this._notifyOnRepeat = notifyOnRepeat;
        this._unsubscribers = [
            eventBus.on(AGENT_SELECTED_EVENT, (agent) => {
                this._setSelectedId(agent?.id || null, { force: this._notifyOnRepeat });
            }),
            eventBus.on(AGENT_DESELECTED_EVENT, () => {
                this._setSelectedId(null);
            }),
        ];
    }

    isSelected(agentId) {
        return Boolean(agentId && agentId === this.selectedId);
    }

    destroy() {
        for (const unsubscribe of this._unsubscribers.splice(0)) {
            unsubscribe?.();
        }
        this._onChange = null;
        this._notifyOnRepeat = false;
    }

    _setSelectedId(nextId, { force = false } = {}) {
        const previousId = this.selectedId;
        this.selectedId = nextId;
        if (force || previousId !== nextId) {
            this._onChange?.(nextId, previousId);
        }
    }
}
