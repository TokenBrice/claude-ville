import { eventBus } from '../domain/events/DomainEvent.js';

export class ModeManager {
    constructor() {
        this.currentMode = 'character';

        this.characterEl = document.getElementById('characterMode');
        this.dashboardEl = document.getElementById('dashboardMode');
        this.btnCharacter = document.getElementById('btnModeCharacter');
        this.btnDashboard = document.getElementById('btnModeDashboard');

        this._bindButtons();
    }

    switchMode(mode) {
        if (mode === this.currentMode) return;
        this.currentMode = mode;

        if (mode === 'character') {
            this.characterEl.style.display = '';
            this.dashboardEl.style.display = 'none';
            this.btnCharacter.classList.add('topbar__mode-btn--active');
            this.btnDashboard.classList.remove('topbar__mode-btn--active');
        } else {
            this.characterEl.style.display = 'none';
            this.dashboardEl.style.display = '';
            this.btnDashboard.classList.add('topbar__mode-btn--active');
            this.btnCharacter.classList.remove('topbar__mode-btn--active');
        }

        eventBus.emit('mode:changed', mode);
    }

    getCurrentMode() {
        return this.currentMode;
    }

    _bindButtons() {
        this.btnCharacter.addEventListener('click', () => this.switchMode('character'));
        this.btnDashboard.addEventListener('click', () => this.switchMode('dashboard'));
    }
}
