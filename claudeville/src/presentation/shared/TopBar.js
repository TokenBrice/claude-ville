import { eventBus } from '../../domain/events/DomainEvent.js';
import { Settings } from '../../application/Settings.js';
import { formatCost, formatNumber } from './Formatters.js';

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
            settingsButton: document.getElementById('btnSettings'),
        };
        this.timeInterval = null;

        this._onUpdate = () => this.render();
        eventBus.on('agent:added', this._onUpdate);
        eventBus.on('agent:updated', this._onUpdate);
        eventBus.on('agent:removed', this._onUpdate);

        this._onUsage = (usage) => this.renderQuota(usage);
        eventBus.on('usage:updated', this._onUsage);
        this._unsubscribeSettings = Settings.subscribe(() => this._renderSettingsState());

        this._startTimer();
        this._renderSettingsState();
        this.render();
    }

    render() {
        const stats = this.world.getStats();

        this.els.tokens.textContent = formatNumber(stats.totalTokens);
        this.els.cost.textContent = formatCost(stats.totalCost);
        this.els.working.textContent = stats.working;
        this.els.idle.textContent = stats.idle;
        this.els.waiting.textContent = stats.waiting;
    }

    renderQuota(usage) {
        if (!usage) {
            this._hideQuotaBars();
            return;
        }

        // Subscription information
        if (usage.account) {
            const tier = this._formatTier(usage.account.rateLimitTier, usage.account.subscriptionType);
            this.els.accountTier.textContent = tier;
        }

        // Today's activity
        if (usage.activity?.today) {
            const t = usage.activity.today;
            this.els.accountActivity.textContent = `${formatNumber(t.messages)} msgs`;
        }

        // Quota bar (shown only when the API succeeds)
        if (usage.quotaAvailable && usage.quota) {
            this.els.quotaSection.style.display = 'flex';
            this._updateQuotaBar(this.els.quota5hBar, this.els.quota5hPct, usage.quota.fiveHour);
            this._updateQuotaBar(this.els.quota7dBar, this.els.quota7dPct, usage.quota.sevenDay);
        } else {
            this._hideQuotaBars();
        }
    }

    _updateQuotaBar(barEl, pctEl, value) {
        if (value == null) {
            this._resetQuotaBar(barEl, pctEl);
            return;
        }
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

    _hideQuotaBars() {
        this.els.quotaSection.style.display = 'none';
        this._resetQuotaBar(this.els.quota5hBar, this.els.quota5hPct);
        this._resetQuotaBar(this.els.quota7dBar, this.els.quota7dPct);
    }

    _resetQuotaBar(barEl, pctEl) {
        if (barEl) {
            barEl.style.width = '0%';
            barEl.classList.remove('topbar__quota-fill--warn', 'topbar__quota-fill--danger');
        }
        if (pctEl) pctEl.textContent = '--';
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

    _renderSettingsState() {
        if (!this.els.settingsButton) return;
        const suffix = Settings.privacyRedaction ? ' (privacy redaction on)' : '';
        this.els.settingsButton.title = `Settings${suffix}`;
        this.els.settingsButton.setAttribute('aria-label', `Settings${suffix}`);
    }

    destroy() {
        if (this.timeInterval) clearInterval(this.timeInterval);
        eventBus.off('agent:added', this._onUpdate);
        eventBus.off('agent:updated', this._onUpdate);
        eventBus.off('agent:removed', this._onUpdate);
        eventBus.off('usage:updated', this._onUsage);
        this._unsubscribeSettings?.();
    }
}
