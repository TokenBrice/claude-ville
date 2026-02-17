import { eventBus } from '../../domain/events/DomainEvent.js';

export class TopBar {
    constructor(world) {
        this.world = world;
        this.els = {
            tokens: document.getElementById('statTokens'),
            cost: document.getElementById('statCost'),
            time: document.getElementById('statTime'),
            working: document.getElementById('badgeWorking'),
            idle: document.getElementById('badgeIdle'),
            waiting: document.getElementById('badgeWaiting'),
        };
        this.timeInterval = null;

        this._onUpdate = () => this.render();
        eventBus.on('agent:added', this._onUpdate);
        eventBus.on('agent:updated', this._onUpdate);
        eventBus.on('agent:removed', this._onUpdate);

        this._startTimer();
        this.render();
    }

    render() {
        const stats = this.world.getStats();

        this.els.tokens.textContent = this._formatNumber(stats.totalTokens);
        this.els.cost.textContent = `$${stats.totalCost.toFixed(4)}`;
        this.els.working.textContent = stats.working;
        this.els.idle.textContent = stats.idle;
        this.els.waiting.textContent = stats.waiting;
    }

    _startTimer() {
        this.timeInterval = setInterval(() => {
            const seconds = this.world.activeTime;
            const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
            const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
            const s = String(seconds % 60).padStart(2, '0');
            this.els.time.textContent = `${h}:${m}:${s}`;
        }, 1000);
    }

    _formatNumber(num) {
        if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
        if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
        return String(num);
    }

    destroy() {
        if (this.timeInterval) clearInterval(this.timeInterval);
        eventBus.off('agent:added', this._onUpdate);
        eventBus.off('agent:updated', this._onUpdate);
        eventBus.off('agent:removed', this._onUpdate);
    }
}
