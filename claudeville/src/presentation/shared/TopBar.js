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
            // Account & Quota
            accountTier: document.getElementById('accountTier'),
            accountActivity: document.getElementById('accountActivity'),
            quotaSection: document.getElementById('quotaSection'),
            quota5hBar: document.getElementById('quota5hBar'),
            quota5hPct: document.getElementById('quota5hPct'),
            quota7dBar: document.getElementById('quota7dBar'),
            quota7dPct: document.getElementById('quota7dPct'),
        };
        this.timeInterval = null;

        this._onUpdate = () => this.render();
        eventBus.on('agent:added', this._onUpdate);
        eventBus.on('agent:updated', this._onUpdate);
        eventBus.on('agent:removed', this._onUpdate);

        this._onUsage = (usage) => this.renderQuota(usage);
        eventBus.on('usage:updated', this._onUsage);

        this._startTimer();
        this.render();
    }

    render() {
        const stats = this.world.getStats();

        this.els.tokens.textContent = this._formatNumber(stats.totalTokens);
        this.els.cost.textContent = this._formatCost(stats.totalCost);
        this.els.working.textContent = stats.working;
        this.els.idle.textContent = stats.idle;
        this.els.waiting.textContent = stats.waiting;
    }

    renderQuota(usage) {
        if (!usage) return;

        // Subscription information
        if (usage.account) {
            const tier = this._formatTier(usage.account.rateLimitTier, usage.account.subscriptionType);
            this.els.accountTier.textContent = tier;
        }

        // Today's activity
        if (usage.activity?.today) {
            const t = usage.activity.today;
            this.els.accountActivity.textContent = `${this._formatNumber(t.messages)} msgs`;
        }

        // Quota bar (shown only when the API succeeds)
        if (usage.quotaAvailable && usage.quota) {
            this.els.quotaSection.style.display = 'flex';
            this._updateQuotaBar(this.els.quota5hBar, this.els.quota5hPct, usage.quota.fiveHour);
            this._updateQuotaBar(this.els.quota7dBar, this.els.quota7dPct, usage.quota.sevenDay);
        }
    }

    _updateQuotaBar(barEl, pctEl, value) {
        if (value == null) return;
        const pct = Math.round(value * 100);
        barEl.style.width = `${pct}%`;
        pctEl.textContent = `${pct}%`;

        // Set color class
        barEl.classList.remove('topbar__quota-fill--warn', 'topbar__quota-fill--danger');
        if (pct >= 80) {
            barEl.classList.add('topbar__quota-fill--danger');
        } else if (pct >= 50) {
            barEl.classList.add('topbar__quota-fill--warn');
        }
    }

    _formatTier(rateLimitTier, subscriptionType) {
        if (rateLimitTier) {
            // "default_claude_max_20x" → "Max 20x"
            const match = rateLimitTier.match(/max_(\d+x)/i);
            if (match) return `Max ${match[1]}`;
        }
        if (subscriptionType) {
            return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
        }
        return 'Free';
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

    _formatCost(cost) {
        if (!Number.isFinite(cost) || cost <= 0) return '$0.0000';
        if (cost < 0.0001) return '<$0.0001';
        if (cost >= 10) return `$${cost.toFixed(2)}`;
        return `$${cost.toFixed(4)}`;
    }

    destroy() {
        if (this.timeInterval) clearInterval(this.timeInterval);
        eventBus.off('agent:added', this._onUpdate);
        eventBus.off('agent:updated', this._onUpdate);
        eventBus.off('agent:removed', this._onUpdate);
        eventBus.off('usage:updated', this._onUsage);
    }
}
