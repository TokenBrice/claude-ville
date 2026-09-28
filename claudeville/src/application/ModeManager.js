import { eventBus } from '../domain/events/DomainEvent.js';

export class ModeManager {
    constructor() {
        this.currentMode = 'character';

        this.characterEl = document.getElementById('characterMode');
        this.dashboardEl = document.getElementById('dashboardMode');
        this.btnCharacter = document.getElementById('btnModeCharacter');
        this.btnDashboard = document.getElementById('btnModeDashboard');
        this._destroyed = false;
        this._onCharacterClick = () => this.switchMode('character');
        this._onDashboardClick = () => this.switchMode('dashboard');

        this._bindButtons();
        this._applyMode('character');
    }

    switchMode(mode) {
        if (this._destroyed || mode === this.currentMode) return;
        this.currentMode = mode;
        this._applyMode(mode);
        eventBus.emit('mode:changed', mode);
    }

    // 0.3 — a mode switch is a cut, whole within one task: the incoming
    // surface is shown and the outgoing one hidden together, then
    // `mode:changed` lets the Dashboard lay itself out (it renders
    // synchronously) and the World measure its last frame into the
    // container's bands before it suspends. The browser paints only after
    // all of that, so the World stays on screen until the Dashboard is laid
    // out and no frame ever shows neither. There is no fade: fading the
    // Dashboard in from opacity 0 was itself the black frame. Coming back,
    // the World container shows the measured bands and its canvases fade in
    // on `world:first-frame` (App).
    _applyMode(mode) {
        const dashboard = mode === 'dashboard';
        if (this.dashboardEl) this.dashboardEl.style.display = dashboard ? '' : 'none';
        if (this.characterEl) this.characterEl.style.display = dashboard ? 'none' : '';
        this.btnCharacter?.classList.toggle('topbar__mode-btn--active', !dashboard);
        this.btnDashboard?.classList.toggle('topbar__mode-btn--active', dashboard);
    }

    getCurrentMode() {
        return this.currentMode;
    }

    _bindButtons() {
        this.btnCharacter?.addEventListener('click', this._onCharacterClick);
        this.btnDashboard?.addEventListener('click', this._onDashboardClick);
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.btnCharacter?.removeEventListener('click', this._onCharacterClick);
        this.btnDashboard?.removeEventListener('click', this._onDashboardClick);
        this.characterEl = null;
        this.dashboardEl = null;
        this.btnCharacter = null;
        this.btnDashboard = null;
    }
}
