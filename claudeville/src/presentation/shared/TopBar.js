import { eventBus } from '../../domain/events/DomainEvent.js';
import { AmbientAudioController } from './AmbientAudioController.js';
import { formatCost, formatNumber } from './Formatters.js';

export class TopBar {
    constructor(world, { modal } = {}) {
        this.world = world;
        this.modal = modal || null;
        this.els = {
            root: document.getElementById('topbar'),
            tokens: document.getElementById('statTokens'),
            cost: document.getElementById('statCost'),
            time: document.getElementById('statTime'),
            fps: document.getElementById('statFps'),
            working: document.getElementById('badgeWorking'),
            idle: document.getElementById('badgeIdle'),
            waiting: document.getElementById('badgeWaiting'),
            badgeErrored: document.getElementById('badgeErrored'),
            badgeAttention: document.getElementById('badgeAttention'),
            erroredWrap: document.getElementById('badgeErroredWrap'),
            attentionWrap: document.getElementById('badgeAttentionWrap'),
            connection: document.getElementById('topbarConnection'),
            version: document.querySelector('.topbar__version'),
            soundToggle: document.getElementById('topbarSoundToggle'),
            // Token limit chip
            quotaSection: document.getElementById('quotaSection'),
            quota5hPct: document.getElementById('quota5hPct'),
            quota7dPct: document.getElementById('quota7dPct'),
        };
        this.timeInterval = null;
        this._changelogHtml = null;
        this.audio = new AmbientAudioController({ button: this.els.soundToggle });

        this._onUpdate = () => this.render();
        eventBus.on('agent:added', this._onUpdate);
        eventBus.on('agent:updated', this._onUpdate);
        eventBus.on('agent:removed', this._onUpdate);

        this._onUsage = (usage) => this.renderQuota(usage);
        eventBus.on('usage:updated', this._onUsage);

        this._onFps = (fps) => this.renderFps(fps);
        eventBus.on('fps:updated', this._onFps);

        this._onWsConnected = () => this._setConnection(true);
        this._onWsDisconnected = () => this._setConnection(false);
        eventBus.on('ws:connected', this._onWsConnected);
        eventBus.on('ws:disconnected', this._onWsDisconnected);

        if (this.modal && this.els.version) {
            this.els.version.title = 'View changelog';
            this._onVersionClick = () => this._openChangelog();
            this.els.version.addEventListener('click', this._onVersionClick);
            this._onVersionKeydown = (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    if (e.key === ' ') e.preventDefault();
                    this._openChangelog();
                }
            };
            this.els.version.addEventListener('keydown', this._onVersionKeydown);
        }

        this._startTimer();
        this.render();
    }

    render() {
        const stats = this.world.getStats();

        this.els.tokens.textContent = formatNumber(stats.totalTokens);
        this.els.cost.textContent = formatCost(stats.totalCost);
        this.els.working.textContent = stats.working;
        this.els.idle.textContent = stats.idle;
        this.els.waiting.textContent = stats.waiting;

        this.els.badgeErrored.textContent = stats.errored;
        this.els.erroredWrap.style.display = stats.errored > 0 ? '' : 'none';
        this.els.badgeAttention.textContent = stats.attention;
        this.els.attentionWrap.style.display = stats.attention > 0 ? '' : 'none';

        this._renderActivityRail(stats);
    }

    // Living activity rail: a 2px strip along the topbar bottom whose hue and
    // intensity echo the fleet's status mix. Mostly-working reads as a warm
    // gold; any errored agent bleeds red in from the left, weighted by how much
    // of the fleet is failing. Driven by CSS custom props the rail strip reads.
    _renderActivityRail(stats) {
        if (!this.els.root) return;
        const total = stats.total || 0;
        const erroredRatio = total > 0 ? stats.errored / total : 0;
        const activeRatio = total > 0 ? (stats.working + stats.waiting) / total : 0;

        // Hue: 45deg warm gold by default, pulled toward 8deg red as the
        // errored fraction climbs. Alpha rises with both trouble and activity
        // so an idle/empty village rests dim.
        const hue = Math.round(45 - 37 * erroredRatio);
        const alpha = (0.18 + 0.42 * activeRatio + 0.4 * erroredRatio).toFixed(3);
        // Red bleed origin: 100% (offscreen right) when calm, sliding left as
        // more agents error so the red enters from the left edge.
        const bleed = Math.round(100 - 100 * erroredRatio);

        const style = this.els.root.style;
        style.setProperty('--cv-rail-hue', `${hue}`);
        style.setProperty('--cv-rail-alpha', `${alpha}`);
        style.setProperty('--cv-rail-bleed', `${bleed}%`);
    }

    _setConnection(connected) {
        if (!this.els.connection) return;
        this.els.connection.textContent = connected ? 'LIVE' : 'OFFLINE';
        this.els.connection.classList.toggle('topbar__conn--connected', connected);
        this.els.connection.classList.toggle('topbar__conn--disconnected', !connected);
    }

    // fps is a number while the World render loop runs, null when it stops.
    renderFps(fps) {
        if (!this.els.fps) return;
        if (fps == null) {
            this.els.fps.textContent = '-- FPS';
            this.els.fps.classList.remove('topbar__fps--warn', 'topbar__fps--danger');
            return;
        }
        this.els.fps.textContent = `${fps} FPS`;
        this.els.fps.classList.toggle('topbar__fps--danger', fps < 25);
        this.els.fps.classList.toggle('topbar__fps--warn', fps >= 25 && fps < 45);
    }

    renderQuota(usage) {
        if (!usage) {
            this._hideQuotaChip();
            return;
        }

        // Token limit chip (shown only when the API succeeds)
        if (usage.quotaAvailable && usage.quota) {
            this._updateQuotaChip(usage.quota);
        } else {
            this._hideQuotaChip();
        }
    }

    // World mode's mine renders remaining reserves as ore; this chip is the
    // always-on, cross-mode echo and reports usage of both windows (the familiar
    // figures, matching the OS widget), colored by whichever window sits closest
    // to its limit.
    _updateQuotaChip(quota) {
        const five = Number(quota.fiveHour);
        const seven = Number(quota.sevenDay);
        if (!Number.isFinite(five) && !Number.isFinite(seven)) {
            this._hideQuotaChip();
            return;
        }
        const fivePct = Number.isFinite(five) ? `${Math.round(five * 100)}%` : '--';
        const sevenPct = Number.isFinite(seven) ? `${Math.round(seven * 100)}%` : '--';
        this.els.quotaSection.style.display = 'flex';
        this.els.quota5hPct.textContent = fivePct;
        this.els.quota7dPct.textContent = sevenPct;
        this.els.quotaSection.title = `Token limit used · 5h ${fivePct} · 7d ${sevenPct}`;

        const worst = Math.max(
            Number.isFinite(five) ? five : 0,
            Number.isFinite(seven) ? seven : 0,
        );
        this.els.quotaSection.classList.remove('topbar__quota-chip--warn', 'topbar__quota-chip--danger');
        if (worst >= 0.8) {
            this.els.quotaSection.classList.add('topbar__quota-chip--danger');
        } else if (worst >= 0.5) {
            this.els.quotaSection.classList.add('topbar__quota-chip--warn');
        }
    }

    _hideQuotaChip() {
        if (!this.els.quotaSection) return;
        this.els.quotaSection.style.display = 'none';
        this.els.quotaSection.classList.remove('topbar__quota-chip--warn', 'topbar__quota-chip--danger');
        if (this.els.quota5hPct) this.els.quota5hPct.textContent = '--';
        if (this.els.quota7dPct) this.els.quota7dPct.textContent = '--';
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

    async _openChangelog() {
        if (!this.modal) return;
        if (!this._changelogHtml) {
            try {
                const res = await fetch('/api/changelog');
                if (!res.ok) throw new Error(res.statusText);
                this._changelogHtml = this._changelogToHtml(await res.text());
            } catch {
                this._changelogHtml = '<p>Failed to load changelog.</p>';
            }
        }
        this.modal.open('Changelog', this._changelogHtml, { wide: true });
    }

    _changelogToHtml(md) {
        const lines = md.split('\n');
        const parts = [];
        let inList = false;

        const closeList = () => {
            if (inList) { parts.push('</ul>'); inList = false; }
        };

        for (const line of lines) {
            if (line.startsWith('# ') || line === '---') {
                closeList();
            } else if (line.startsWith('## ')) {
                closeList();
                const text = line.slice(3).trim();
                const hotfixM = text.match(/^(v[\d.]+)\s+·\s+(.+?)\s+—\s+Hotfix/);
                const namedM  = text.match(/^(v[\d.]+)\s+—\s+\*(.+?)\*\s+·\s+(.+)/);
                if (namedM) {
                    const [, ver, name, date] = namedM;
                    parts.push(
                        `<div class="cl-release">` +
                        `<span class="cl-ver">${ver}</span>` +
                        `<span class="cl-name">${name}</span>` +
                        `<span class="cl-date">${date}</span>` +
                        `</div>`
                    );
                } else if (hotfixM) {
                    const [, ver, date] = hotfixM;
                    parts.push(
                        `<div class="cl-release cl-release--hotfix">` +
                        `<span class="cl-ver">${ver}</span>` +
                        `<span class="cl-hotfix-badge">Hotfix</span>` +
                        `<span class="cl-date">${date}</span>` +
                        `</div>`
                    );
                }
            } else if (line.startsWith('- ')) {
                if (!inList) { parts.push('<ul class="cl-list">'); inList = true; }
                parts.push(`<li>${this._inline(line.slice(2))}</li>`);
            } else if (line.trim() === '') {
                closeList();
            } else {
                closeList();
                parts.push(`<p>${this._inline(line)}</p>`);
            }
        }
        closeList();
        return parts.join('');
    }

    _inline(text) {
        return text
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`(.+?)`/g, '<code>$1</code>');
    }

    destroy() {
        if (this.timeInterval) clearInterval(this.timeInterval);
        eventBus.off('agent:added', this._onUpdate);
        eventBus.off('agent:updated', this._onUpdate);
        eventBus.off('agent:removed', this._onUpdate);
        eventBus.off('usage:updated', this._onUsage);
        eventBus.off('fps:updated', this._onFps);
        eventBus.off('ws:connected', this._onWsConnected);
        eventBus.off('ws:disconnected', this._onWsDisconnected);
        if (this._onVersionClick && this.els.version) {
            this.els.version.removeEventListener('click', this._onVersionClick);
        }
        if (this._onVersionKeydown && this.els.version) {
            this.els.version.removeEventListener('keydown', this._onVersionKeydown);
        }
        this.audio?.destroy();
    }
}
