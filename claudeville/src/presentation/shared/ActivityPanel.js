import { eventBus, BUILDING_EVENTS } from '../../domain/events/DomainEvent.js';
import { TokenUsage } from '../../domain/value-objects/TokenUsage.js';
import { sessionDetailsService } from './SessionDetailsService.js';
import { SESSION_DETAIL_PANEL_REFRESH_INTERVAL } from '../../config/constants.js';
import { el, replaceChildren } from './DomSafe.js';
import { formatCost, formatTokens, hashRows, truncateText } from './Formatters.js';
import { emitAgentDeselected, emitAgentSelected } from './AgentSelection.js';
import {
    currentToolPresentation,
    modelPresentation,
    statusPresentation,
    toolHistoryNodes,
    toolHistorySignature,
} from './AgentPresentation.js';
import { contextWindowLimitForModel } from './ModelVisualIdentity.js';

const PANEL_TOOL_LIMIT = 30;
const PANEL_MESSAGE_LIMIT = 12;
const BUILDING_OCCUPANT_REFRESH_INTERVAL = 5000;
const JOURNEY_BREADCRUMB_LIMIT = 5;

const BEHAVIOR_STATE_LABELS = Object.freeze({
    blocked: 'Blocked',
    cooldown: 'Cooling down',
    performing: 'On site',
    roaming: 'Roaming',
    traveling: 'Traveling',
    wandering: 'Wandering',
});

const BEHAVIOR_PHASE_LABELS = Object.freeze({
    coordinating: 'Coordinating',
    editing: 'Editing',
    git: 'Git work',
    'quota/resource': 'Quota check',
    reading: 'Reading',
    researching: 'Researching',
    testing: 'Testing',
    waiting: 'Waiting',
});

const AGENT_GOAL_LABELS = Object.freeze({
    'assist-parent': 'Assist parent',
    'complete-task': 'Complete task',
    'monitor-quota': 'Monitor quota',
    'recover-error': 'Recover error',
});

const PUSH_STATUS_LABELS = Object.freeze({
    cancelled: 'Push cancelled',
    canceled: 'Push cancelled',
    failed: 'Push failed',
    rejected: 'Push rejected',
});

const REASON_LABELS = Object.freeze({
    'quota/resource': 'Quota check',
    'quota-resource': 'Quota check',
});

export class ActivityPanel {
    constructor({ world = null, renderer = null, harborTraffic = null } = {}) {
        const getterFor = (value) => (typeof value === 'function' ? value : () => value);
        this.panelEl = document.getElementById('activityPanel');
        this.closeBtn = document.getElementById('panelClose');
        this._dependencies = {
            world: getterFor(world),
            renderer: getterFor(renderer),
            harborTraffic: getterFor(harborTraffic),
        };
        this.currentAgent = null;
        this._mode = null;
        this._selectedBuilding = null;
        this._latestUsage = null;
        this._pollTimer = null;
        this._buildingPollTimer = null;
        this.dom = {
            panelAgentName: document.getElementById('panelAgentName'),
            panelAgentStatus: document.getElementById('panelAgentStatus'),
            panelModel: document.getElementById('panelModel'),
            panelProvider: document.getElementById('panelProvider'),
            panelRole: document.getElementById('panelRole'),
            panelLevel: document.getElementById('panelLevel'),
            panelTeam: document.getElementById('panelTeam'),
            panelCurrentTool: document.getElementById('panelCurrentTool'),
            panelToolHistory: document.getElementById('panelToolHistory'),
            panelMessages: document.getElementById('panelMessages'),
            panelContextSize: document.getElementById('panelContextSize'),
            panelContextBar: document.getElementById('panelContextBar'),
            panelInputTokens: document.getElementById('panelInputTokens'),
            panelOutputTokens: document.getElementById('panelOutputTokens'),
            panelCacheRead: document.getElementById('panelCacheRead'),
            panelTurnCount: document.getElementById('panelTurnCount'),
            panelEstCost: document.getElementById('panelEstCost'),
        };
        this._toolEls = {
            icon: this.dom.panelCurrentTool.querySelector('.activity-panel__tool-icon'),
            name: this.dom.panelCurrentTool.querySelector('.activity-panel__tool-name'),
            input: this.dom.panelCurrentTool.querySelector('.activity-panel__tool-input'),
        };
        this._journeySectionEl = null;
        this._journeyBodyEl = null;
        this._ensureJourneySection();
        // Sections that belong to agent mode and must be hidden when a building is selected.
        this._agentSections = Array.from(this.panelEl?.querySelectorAll('.activity-panel__meta, .activity-panel__section') || []);
        // Building-mode content container is created on demand and inserted after the header.
        this._buildingContentEl = null;
        this._renderSignatures = {
            journey: '',
            toolHistory: '',
            messages: '',
            tokenUsage: '',
        };

        this._bind();
    }

    _bind() {
        this._onCloseClick = () => this.hide();
        this._onAgentSelected = (agent) => {
            if (agent) this.show(agent);
        };
        this._onAgentUpdated = (agent) => {
            if (this._mode === 'agent' && this.currentAgent && agent.id === this.currentAgent.id) {
                this.currentAgent = agent;
                this._updateInfo(agent);
                this._updateCurrentTool(agent);
                this._updateJourney(agent);
            }
        };
        this._onAgentRemoved = (agent) => {
            sessionDetailsService.deleteForAgent(agent);
            if (this._mode === 'agent' && this.currentAgent && agent.id === this.currentAgent.id) {
                this.hide();
            }
        };
        this._onBuildingSelected = (building) => {
            if (building) this.showBuilding(building);
        };
        this._onBuildingDeselected = () => {
            if (this._mode === 'building') this.hide();
        };
        this._onUsageUpdated = (usage) => {
            this._latestUsage = usage || null;
            if (this._mode === 'building') this._renderBuildingState();
        };

        this.closeBtn.addEventListener('click', this._onCloseClick);
        eventBus.on('agent:selected', this._onAgentSelected);
        eventBus.on('agent:updated', this._onAgentUpdated);
        eventBus.on('agent:removed', this._onAgentRemoved);
        eventBus.on(BUILDING_EVENTS.SELECTED, this._onBuildingSelected);
        eventBus.on(BUILDING_EVENTS.DESELECTED, this._onBuildingDeselected);
        eventBus.on('usage:updated', this._onUsageUpdated);
    }

    show(agent) {
        // Agent selection takes over the panel: tear down any building view first.
        if (this._mode === 'building') {
            this._teardownBuildingView();
        }
        this._mode = 'agent';
        this.currentAgent = agent;
        this._renderSignatures = {
            journey: '',
            toolHistory: '',
            messages: '',
            tokenUsage: '',
        };
        this._showAgentSections();
        this.panelEl.style.display = '';
        this._updateInfo(agent);
        this._updateCurrentTool(agent);
        this._updateJourney(agent);
        this._startPolling();
    }

    showBuilding(building) {
        // Building selection overrides agent selection. Close any agent state first.
        if (this._mode === 'agent') {
            this._stopPolling();
            this.currentAgent = null;
            // Notify renderer/sidebar/dashboard so highlight clears.
            emitAgentDeselected();
        }
        this._mode = 'building';
        this._selectedBuilding = building;
        this._hideAgentSections();
        this._ensureBuildingContentEl();
        this.panelEl.style.display = '';
        this._renderBuildingView();
        this._startBuildingPolling();
    }

    hide() {
        const wasAgent = this._mode === 'agent';
        const wasBuilding = this._mode === 'building';
        this.panelEl.style.display = 'none';
        this.currentAgent = null;
        this._renderSignatures = {
            journey: '',
            toolHistory: '',
            messages: '',
            tokenUsage: '',
        };
        this._stopPolling();
        this._stopBuildingPolling();
        if (wasBuilding) this._teardownBuildingView();
        this._mode = null;
        if (wasAgent) emitAgentDeselected();
    }

    _updateInfo(agent) {
        const statusInfo = statusPresentation(agent.status);
        this.dom.panelAgentName.textContent = agent.name;
        const statusEl = this.dom.panelAgentStatus;
        statusEl.textContent = statusInfo.label.toUpperCase();
        statusEl.style.color = statusInfo.color;

        const model = modelPresentation(agent);
        this.dom.panelModel.textContent = model.label;
        this.dom.panelModel.style.color = model.color;
        this.dom.panelModel.title = model.title;
        this.dom.panelProvider.textContent = agent.provider || 'claude';
        this.dom.panelRole.textContent = agent.role || 'general';
        this.dom.panelLevel.textContent = this._formatAgentLevel(model.identity);
        this.dom.panelLevel.style.color = model.identity.accent?.[1] || model.identity.accent?.[0] || '';
        this.dom.panelTeam.textContent = agent.teamName || '-';
    }

    _formatAgentLevel(identity) {
        const tier = identity?.effortTier;
        if (!tier || tier === 'none') return '-';
        return {
            low: 'Low',
            medium: 'Medium',
            high: 'High',
            xhigh: 'Extra High',
            max: 'Max',
        }[tier] || tier;
    }

    _updateCurrentTool(agent) {
        const container = this.dom.panelCurrentTool;
        const iconEl = this._toolEls.icon;
        const nameEl = this._toolEls.name;
        const inputEl = this._toolEls.input;
        const tool = currentToolPresentation(agent);

        container.classList.toggle('activity-panel__current-tool--idle', tool.isIdle);
        iconEl.textContent = tool.icon;
        nameEl.textContent = tool.name;
        inputEl.textContent = tool.detail;
    }

    // ─── Live polling ────────────────────────────────

    _startPolling() {
        this._stopPolling();
        this._fetchDetail();
        this._pollTimer = setInterval(() => this._fetchDetail(), SESSION_DETAIL_PANEL_REFRESH_INTERVAL);
    }

    _stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

    _startBuildingPolling() {
        this._stopBuildingPolling();
        this._buildingPollTimer = setInterval(() => {
            if (this._mode !== 'building') return;
            this._renderBuildingOccupants();
            this._renderBuildingState();
        }, BUILDING_OCCUPANT_REFRESH_INTERVAL);
    }

    _stopBuildingPolling() {
        if (this._buildingPollTimer) {
            clearInterval(this._buildingPollTimer);
            this._buildingPollTimer = null;
        }
    }

    async _fetchDetail() {
        if (!this.currentAgent) return;
        const agent = this.currentAgent;
        this._updateJourney(agent);
        const data = await sessionDetailsService.fetchSessionDetail(agent);
        if (!data || !this.currentAgent || this.currentAgent.id !== agent.id) return;
        this._renderToolHistory(data.toolHistory || []);
        this._renderMessages(data.messages || []);
        this._renderTokenUsage(data.tokenUsage || data.tokens || data.usage);
    }

    // ─── Rendering ─────────────────────────────────────

    _renderToolHistory(tools) {
        const limited = (tools || []).slice(-PANEL_TOOL_LIMIT);
        const signature = toolHistorySignature(limited, {
            limit: PANEL_TOOL_LIMIT,
            detailLength: 45,
        });
        if (signature === this._renderSignatures.toolHistory) return;
        this._renderSignatures.toolHistory = signature;

        const container = this.dom.panelToolHistory;
        replaceChildren(container, toolHistoryNodes(limited, {
            limit: PANEL_TOOL_LIMIT,
            detailLength: 45,
            emptyText: 'No tool usage',
            emptyClass: 'activity-panel__empty',
            itemClass: 'activity-panel__tool-item',
            iconClass: 'activity-panel__tool-item-icon',
            nameClass: 'activity-panel__tool-item-name',
            detailClass: 'activity-panel__tool-item-detail',
        }));
    }

    _renderMessages(messages) {
        const limited = (messages || []).slice(-PANEL_MESSAGE_LIMIT);
        const signature = `${limited.length}|${hashRows(limited, [
            row => row?.ts || 0,
            row => row?.role || '',
            row => (row?.text || '').slice(0, 60),
        ])}`;
        if (signature === this._renderSignatures.messages) return;
        this._renderSignatures.messages = signature;

        const container = this.dom.panelMessages;
        if (!limited.length) {
            replaceChildren(container, [
                this._emptyState('No messages'),
            ]);
            return;
        }
        const reversed = [...limited].reverse();
        replaceChildren(container, reversed.map(m => {
            const cls = m.role === 'assistant' ? 'assistant' : 'user';
            return el('div', {
                className: ['activity-panel__msg', `activity-panel__msg--${cls}`],
            }, [
                el('div', { className: 'activity-panel__msg-role', text: m.role || '' }),
                el('div', { text: truncateText(m.text || '', 60) }),
            ]);
        }));
    }

    _renderTokenUsage(usage) {
        if (!usage) return;

        const normalizedUsage = TokenUsage.normalize(usage);
        const usageSignature = `${normalizedUsage.totalInput}|${normalizedUsage.totalOutput}|${normalizedUsage.cacheRead}|${normalizedUsage.cacheCreate}|${normalizedUsage.contextWindow}|${normalizedUsage.contextWindowMax}|${normalizedUsage.turnCount}`;
        if (usageSignature === this._renderSignatures.tokenUsage) return;
        this._renderSignatures.tokenUsage = usageSignature;

        const maxContext = normalizedUsage.contextWindowMax || contextWindowLimitForModel(
            this.currentAgent?.model,
            this.currentAgent?.provider,
        );
        const contextPct = maxContext ? Math.min(100, (normalizedUsage.contextWindow / maxContext) * 100) : 0;

        // Context size (human-readable form)
        this.dom.panelContextSize.textContent =
            formatTokens(normalizedUsage.contextWindow) + ` / ${formatTokens(maxContext)}`;

        // Context bar
        const bar = this.dom.panelContextBar;
        bar.style.width = contextPct + '%';
        bar.className = 'activity-panel__context-bar';
        if (contextPct > 80) bar.classList.add('activity-panel__context-bar--danger');
        else if (contextPct > 50) bar.classList.add('activity-panel__context-bar--warning');

        // Token cells
        this.dom.panelInputTokens.textContent =
            formatTokens(normalizedUsage.totalInput);
        this.dom.panelOutputTokens.textContent =
            formatTokens(normalizedUsage.totalOutput);
        this.dom.panelCacheRead.textContent =
            formatTokens(normalizedUsage.cacheRead);
        this.dom.panelTurnCount.textContent =
            normalizedUsage.turnCount.toLocaleString();

        const cost = TokenUsage.estimateCost(
            normalizedUsage,
            this.currentAgent?.model,
            this.currentAgent?.provider,
        );
        this.dom.panelEstCost.textContent = formatCost(cost);
    }

    _emptyState(text) {
        return el('div', { className: 'activity-panel__empty', text });
    }

    // ─── Selected-agent journey ────────────────────────

    _ensureJourneySection() {
        if (this._journeySectionEl && this._journeyBodyEl) return;
        const body = el('div', { className: ['activity-panel__token-usage', 'activity-panel__journey'] });
        const section = el('div', {
            className: 'activity-panel__section',
            style: { display: 'none' },
        }, [
            el('div', { className: 'activity-panel__section-title', text: 'Journey' }),
            body,
        ]);
        const meta = this.panelEl?.querySelector('.activity-panel__meta');
        if (meta?.nextSibling) {
            this.panelEl.insertBefore(section, meta.nextSibling);
        } else if (meta) {
            this.panelEl.appendChild(section);
        }
        this._journeySectionEl = section;
        this._journeyBodyEl = body;
    }

    _updateJourney(agent) {
        if (!this._journeySectionEl || !this._journeyBodyEl) return;
        if (this._mode !== 'agent' || !agent) {
            this._journeySectionEl.style.display = 'none';
            return;
        }

        const snapshot = this._getAgentBehaviorSnapshot(agent);
        const rows = this._agentJourneyRows(agent, snapshot);
        const signature = hashRows(rows, [
            row => row.label,
            row => row.value,
        ]);
        if (!rows.length) {
            this._journeySectionEl.style.display = 'none';
            this._renderSignatures.journey = '';
            return;
        }
        this._journeySectionEl.style.display = '';
        if (signature === this._renderSignatures.journey) return;
        this._renderSignatures.journey = signature;
        replaceChildren(this._journeyBodyEl, rows.map(row => this._journeyRow(row.label, row.value)));
    }

    _agentJourneyRows(agent, snapshot) {
        if (!snapshot) return [];
        const behavior = snapshot.behavior || {};
        const currentIntent = behavior.currentIntent || {};
        const buildingType = behavior.building
            || snapshot.building
            || currentIntent.building
            || agent.lastKnownBuildingType
            || null;
        const buildingLabel = this._buildingLabel(buildingType);
        const state = snapshot.behaviorState || behavior.state || null;
        const phase = behavior.currentPhase || currentIntent.phase || null;
        const reason = this._formatReasonLabel(
            currentIntent.label
                || behavior.reason
                || snapshot.behaviorReason
                || currentIntent.reason
                || currentIntent.source
                || '',
        );
        const targetTile = behavior.targetTile || snapshot.targetTile || currentIntent.targetTile || null;
        const reservation = this._getVisitReservation(agent, snapshot);
        const breadcrumb = this._formatBreadcrumb(behavior.recentBuildings || snapshot.recentBuildings);
        const goal = this._formatGoalLabel(
            behavior.currentGoal
                || currentIntent.goal
                || snapshot.goal
                || snapshot.routeIntent?.goal,
        );
        const itinerary = this._formatItinerary(
            behavior.currentItinerary
                || currentIntent.itinerary
                || snapshot.itinerary
                || snapshot.routeIntent?.itinerary,
        );
        const rows = [];
        if (goal) rows.push({ label: 'Goal', value: goal });
        const why = this._journeyExplanation({
            state,
            moving: snapshot.moving,
            buildingLabel,
            phase,
            reason,
        });
        if (why) rows.push({ label: 'Why', value: why });
        if (buildingLabel) rows.push({ label: 'Building', value: buildingLabel });

        const route = this._formatRoute({ state, moving: snapshot.moving, targetTile, waypointCount: snapshot.waypointCount });
        if (route) rows.push({ label: 'Route', value: route });
        if (itinerary) rows.push({ label: 'Itinerary', value: itinerary });
        if (reason) rows.push({ label: 'Reason', value: reason });

        const reservationText = this._formatReservation(reservation, snapshot);
        if (reservationText) rows.push({ label: 'Reservation', value: reservationText });
        if (breadcrumb) rows.push({ label: 'Breadcrumb', value: breadcrumb });
        return rows;
    }

    _journeyExplanation({ state, moving, buildingLabel, phase, reason }) {
        const action = this._formatBehaviorAction(state, moving);
        const phaseLabel = this._formatPhaseLabel(phase);
        const destination = buildingLabel ? ` ${buildingLabel}` : '';
        const purpose = phaseLabel && phaseLabel !== 'Waiting' ? phaseLabel : reason;
        if (action && destination && purpose) return `${action}${destination} for ${purpose.toLowerCase()}`;
        if (action && destination) return `${action}${destination}`;
        if (action && purpose) return `${action} for ${purpose.toLowerCase()}`;
        return '';
    }

    _formatBehaviorAction(state, moving) {
        const normalized = String(state || '').toLowerCase();
        if (moving || normalized === 'traveling') return 'Moving to';
        if (normalized === 'performing') return 'Working at';
        if (normalized === 'blocked') return 'Blocked near';
        if (normalized === 'cooldown') return 'Leaving';
        if (normalized === 'wandering' || normalized === 'roaming') return 'Roaming near';
        return '';
    }

    _formatRoute({ state, moving, targetTile, waypointCount }) {
        const parts = [];
        const stateLabel = BEHAVIOR_STATE_LABELS[String(state || '').toLowerCase()] || '';
        if (stateLabel) parts.push(stateLabel);
        else if (moving) parts.push('Moving');
        const tile = this._formatTile(targetTile);
        if (tile) parts.push(`target ${tile}`);
        const stops = Number(waypointCount);
        if (Number.isFinite(stops) && stops > 0) parts.push(`${stops} waypoint${stops === 1 ? '' : 's'}`);
        return parts.join(', ');
    }

    _formatReservation(reservation, snapshot) {
        if (!reservation && !snapshot?.reservationId) return '';
        const parts = [];
        const slot = reservation?.slotId || snapshot?.visitSlotId || '';
        if (slot) parts.push(`slot ${this._titleize(String(slot).replace(/[:/]+/g, ' ')).toLowerCase()}`);
        const tile = this._formatTile(reservation || snapshot?.targetTile);
        if (tile) parts.push(tile);
        const queueIndex = Number(reservation?.queueIndex);
        const queueDepth = Number(reservation?.queueDepth);
        if (Number.isFinite(queueIndex) && queueIndex > 0) {
            const position = queueIndex + 1;
            const total = Number.isFinite(queueDepth) && queueDepth >= 0
                ? Math.max(position, queueDepth + 1)
                : null;
            parts.push(Number.isFinite(queueDepth) && queueDepth > 0
                ? `queue ${position}/${total}`
                : `queue ${position}`);
        }
        if (reservation?.overflow || reservation?.queueOverflow) parts.push('overflow');
        if (!parts.length && snapshot?.reservationId) parts.push(String(snapshot.reservationId));
        return parts.join(', ');
    }

    _formatBreadcrumb(buildings) {
        const list = Array.isArray(buildings) ? buildings : [];
        const labels = list
            .slice(-JOURNEY_BREADCRUMB_LIMIT)
            .map(type => this._buildingLabel(type))
            .filter(Boolean);
        return labels.join(' > ');
    }

    _formatGoalLabel(goal) {
        const key = String(goal || '')
            .trim()
            .replace(/([a-z])([A-Z])/g, '$1-$2')
            .replace(/[_\s]+/g, '-')
            .toLowerCase();
        return AGENT_GOAL_LABELS[key] || '';
    }

    _formatItinerary(itinerary) {
        const route = Array.isArray(itinerary?.route)
            ? itinerary.route
            : (Array.isArray(itinerary?.stops) ? itinerary.stops : []);
        if (route.length < 2) return '';
        const currentIndex = Number(itinerary?.currentIndex);
        return route
            .map((stop, index) => {
                const label = this._buildingLabel(
                    typeof stop === 'string'
                        ? stop
                        : (stop?.building || stop?.buildingType || stop?.type || stop?.id),
                );
                if (!label) return '';
                return Number.isFinite(currentIndex) && Math.round(currentIndex) === index
                    ? `${label} (now)`
                    : label;
            })
            .filter(Boolean)
            .join(' > ');
    }

    _formatTile(value) {
        const x = Number(value?.tileX);
        const y = Number(value?.tileY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return '';
        return `tile ${Math.round(x)},${Math.round(y)}`;
    }

    _formatPhaseLabel(phase) {
        const key = String(phase || '').trim().toLowerCase();
        return BEHAVIOR_PHASE_LABELS[key] || this._titleize(key);
    }

    _formatReasonLabel(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const reasonKey = raw.toLowerCase().replace(/[_\s]+/g, '-');
        if (REASON_LABELS[reasonKey]) return REASON_LABELS[reasonKey];
        const normalized = raw.toLowerCase().replace(/[\/_-]+/g, ' ');
        const pushMatch = normalized.match(/\bpush\s+(failed|rejected|cancelled|canceled)\b/)
            || normalized.match(/\b(failed|rejected|cancelled|canceled)\s+push\b/);
        if (pushMatch) return PUSH_STATUS_LABELS[pushMatch[1]] || raw;
        return this._titleize(normalized);
    }

    _titleize(value) {
        return String(value || '')
            .replace(/[\/_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/\b\w/g, char => char.toUpperCase());
    }

    _buildingLabel(type) {
        const key = String(type || '').trim();
        if (!key) return '';
        const building = this._getBuildingByType(key);
        return building?.shortLabel || building?.label || this._titleize(key.replace(/^ambient:/, ''));
    }

    _getBuildingByType(type) {
        const world = this._getWorld();
        if (!world?.buildings) return null;
        if (typeof world.buildings.get === 'function') return world.buildings.get(type) || null;
        if (Array.isArray(world.buildings)) return world.buildings.find(building => building?.type === type) || null;
        return null;
    }

    _getAgentBehaviorSnapshot(agent) {
        const sprite = this._getAgentSprite(agent);
        if (!sprite || typeof sprite.getBehaviorDebugSnapshot !== 'function') return null;
        try {
            return sprite.getBehaviorDebugSnapshot() || null;
        } catch {
            return null;
        }
    }

    _getAgentSprite(agent) {
        if (!agent?.id) return null;
        return this._getRenderer()?.agentSprites?.get?.(agent.id) || null;
    }

    _getVisitReservation(agent, snapshot) {
        const allocator = this._getRenderer()?.visitTileAllocator;
        if (!allocator || typeof allocator.snapshot !== 'function') return null;
        let reservations = [];
        try {
            reservations = allocator.snapshot?.()?.reservations || [];
        } catch {
            reservations = [];
        }
        if (!Array.isArray(reservations) || !reservations.length) return null;
        const reservationId = snapshot?.reservationId;
        return reservations.find(reservation => (
            (reservationId && reservation.id === reservationId)
            || (agent?.id && reservation.agentId === agent.id)
        )) || null;
    }

    // ─── Building mode ─────────────────────────────────

    _hideAgentSections() {
        for (const node of this._agentSections) {
            if (node) node.style.display = 'none';
        }
    }

    _showAgentSections() {
        for (const node of this._agentSections) {
            if (node) node.style.display = '';
        }
    }

    _ensureBuildingContentEl() {
        if (this._buildingContentEl && this._buildingContentEl.isConnected) return;
        const container = el('div', { className: 'activity-panel__building' });
        // Insert immediately after the header so building content occupies the
        // same vertical region the agent meta+sections would.
        const header = this.panelEl.querySelector('.activity-panel__header');
        if (header && header.nextSibling) {
            this.panelEl.insertBefore(container, header.nextSibling);
        } else {
            this.panelEl.appendChild(container);
        }
        this._buildingContentEl = container;
    }

    _teardownBuildingView() {
        if (this._buildingContentEl && this._buildingContentEl.parentNode) {
            this._buildingContentEl.parentNode.removeChild(this._buildingContentEl);
        }
        this._buildingContentEl = null;
        this._selectedBuilding = null;
        this._showAgentSections();
    }

    _renderBuildingView() {
        const building = this._selectedBuilding;
        if (!building) return;
        // Header title doubles as the building label (reuse the agent name slot).
        const labelText = building.label || building.shortLabel || building.type || 'BUILDING';
        const iconText = building.icon || '';
        this.dom.panelAgentName.textContent = iconText ? `${iconText}  ${labelText}` : labelText;
        const statusEl = this.dom.panelAgentStatus;
        statusEl.textContent = (building.district || 'BUILDING').toUpperCase();
        statusEl.style.color = '';

        this._renderBuildingBody();
        this._renderBuildingOccupants();
        this._renderBuildingState();
    }

    _renderBuildingBody() {
        if (!this._buildingContentEl) return;
        const building = this._selectedBuilding;
        const description = building?.description || '';
        const occupantsSection = el('div', {
            className: 'activity-panel__section',
            dataset: { role: 'occupants' },
        }, [
            el('div', { className: 'activity-panel__section-title', text: 'Occupants' }),
            el('div', { className: 'activity-panel__messages', dataset: { role: 'occupants-list' } }, [
                this._emptyState('-'),
            ]),
        ]);
        const stateSection = el('div', {
            className: 'activity-panel__section',
            dataset: { role: 'state' },
        }, [
            el('div', { className: 'activity-panel__section-title', text: 'Status' }),
            el('div', { className: 'activity-panel__token-usage', dataset: { role: 'state-body' } }, [
                this._emptyState('-'),
            ]),
        ]);
        const aboutSection = el('div', {
            className: 'activity-panel__section activity-panel__section--grow',
        }, [
            el('div', { className: 'activity-panel__section-title', text: 'Purpose' }),
            el('div', { className: 'activity-panel__tool-input', text: description || 'No description' }),
        ]);
        replaceChildren(this._buildingContentEl, [occupantsSection, stateSection, aboutSection]);
    }

    _renderBuildingOccupants() {
        if (!this._buildingContentEl) return;
        const building = this._selectedBuilding;
        if (!building) return;
        const list = this._buildingContentEl.querySelector('[data-role="occupants-list"]');
        if (!list) return;
        const world = this._getWorld();
        const occupants = [];
        if (world?.agents?.values) {
            for (const agent of world.agents.values()) {
                if (typeof building.isAgentVisiting === 'function' && building.isAgentVisiting(agent)) {
                    occupants.push(agent);
                }
            }
        }
        if (!occupants.length) {
            replaceChildren(list, [this._emptyState('No agents currently here')]);
            return;
        }
        const rows = occupants.map((agent) => {
            const statusInfo = statusPresentation(agent.status);
            const row = el('div', {
                className: ['activity-panel__msg', 'activity-panel__msg--assistant'],
                style: { cursor: 'pointer' },
                title: 'Switch to agent details',
            }, [
                el('div', { className: 'activity-panel__msg-role', text: statusInfo.label }),
                el('div', { text: agent.name || agent.id }),
            ]);
            row.addEventListener('click', () => emitAgentSelected(agent));
            return row;
        });
        replaceChildren(list, rows);
    }

    _renderBuildingState() {
        if (!this._buildingContentEl) return;
        const building = this._selectedBuilding;
        if (!building) return;
        const body = this._buildingContentEl.querySelector('[data-role="state-body"]');
        if (!body) return;
        const rows = this._buildingStateRows(building);
        if (!rows.length) {
            replaceChildren(body, [this._emptyState('-')]);
            return;
        }
        replaceChildren(body, rows);
    }

    _buildingStateRows(building) {
        const type = building.type;
        if (type === 'mine') {
            const fiveHour = Number(this._latestUsage?.quota?.fiveHour);
            if (!Number.isFinite(fiveHour)) return [this._buildingRow('5h quota', 'unknown')];
            const pct = Math.max(0, Math.min(100, fiveHour * 100));
            return [this._buildingRow('5h quota', `${pct.toFixed(1)}%`)];
        }
        if (type === 'watchtower') {
            const harbor = this._getHarborTraffic();
            const failed = harbor?.getFailedPushState?.();
            const active = !!(failed && failed.hasFailedPush);
            return [this._buildingRow('Push issue', active ? 'Push failed' : 'clear')];
        }
        if (type === 'harbor') {
            const repos = this._getHarborRepoSummaries();
            if (!repos.length) return [this._buildingRow('Pending repos', 'none')];
            return repos.slice(0, 8).map((repo) => this._buildingRow(
                repo.shortName || repo.repoName || repo.project || 'repo',
                this._formatRepoLedger(repo),
            ));
        }
        return [];
    }

    _formatRepoLedger(repo) {
        const pending = Number(repo.pendingCommits) || 0;
        const docked = Number(repo.dockedCommits) || 0;
        const failed = Number(repo.failedPushes) || 0;
        const parts = [];
        if (pending) parts.push(`${pending} pending`);
        if (docked) parts.push(`${docked} docked`);
        if (failed) parts.push(this._formatPushIssueCount(failed, 'failed'));
        return parts.length ? parts.join(', ') : '0 pending';
    }

    _formatPushIssueCount(count, status) {
        const normalized = String(status || '').toLowerCase();
        if (normalized === 'failed') return `${count} ${count === 1 ? 'push failed' : 'pushes failed'}`;
        if (normalized === 'rejected') return `${count} ${count === 1 ? 'push rejected' : 'pushes rejected'}`;
        if (normalized === 'cancelled' || normalized === 'canceled') {
            return `${count} ${count === 1 ? 'push cancelled' : 'pushes cancelled'}`;
        }
        return `${count} ${this._titleize(status).toLowerCase()}`;
    }

    _buildingRow(label, value) {
        return el('div', { className: 'activity-panel__token-row' }, [
            el('span', { className: 'activity-panel__token-label', text: label }),
            el('span', { className: 'activity-panel__token-value', text: String(value) }),
        ]);
    }

    _journeyRow(label, value) {
        return el('div', { className: 'activity-panel__journey-row' }, [
            el('div', { className: 'activity-panel__journey-label', text: label }),
            el('div', { className: 'activity-panel__journey-value', text: String(value) }),
        ]);
    }

    _getWorld() {
        return this._dependencies.world?.() || null;
    }

    _getRenderer() {
        return this._dependencies.renderer?.() || null;
    }

    _getHarborTraffic() {
        return this._dependencies.harborTraffic?.() || this._getRenderer()?.harborTraffic || null;
    }

    _getHarborRepoSummaries() {
        const harbor = this._getHarborTraffic();
        if (!harbor) return [];
        if (typeof harbor.getRepoSummaries === 'function') {
            return harbor.getRepoSummaries() || [];
        }
        if (typeof harbor.getPendingRepoSummaries === 'function') {
            return harbor.getPendingRepoSummaries() || [];
        }
        return [];
    }

    destroy() {
        this._stopPolling();
        this._stopBuildingPolling();
        this._teardownBuildingView();
        this.closeBtn.removeEventListener('click', this._onCloseClick);
        eventBus.off('agent:selected', this._onAgentSelected);
        eventBus.off('agent:updated', this._onAgentUpdated);
        eventBus.off('agent:removed', this._onAgentRemoved);
        eventBus.off(BUILDING_EVENTS.SELECTED, this._onBuildingSelected);
        eventBus.off(BUILDING_EVENTS.DESELECTED, this._onBuildingDeselected);
        eventBus.off('usage:updated', this._onUsageUpdated);
    }
}
