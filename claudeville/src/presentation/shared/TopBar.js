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
            soundVolume: document.getElementById('topbarSoundVolume'),
            cinemaToggle: document.getElementById('topbarCinemaToggle'),
        };
        this.timeInterval = null;
        this._changelogHtml = null;
        this.audio = new AmbientAudioController({
            button: this.els.soundToggle,
            volumeSlider: this.els.soundVolume,
            world: this.world,
        });
        this._initCinemaToggle();

        this._onUpdate = () => this.render();
        eventBus.on('agent:added', this._onUpdate);
        eventBus.on('agent:updated', this._onUpdate);
        eventBus.on('agent:removed', this._onUpdate);

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

    // #attract — topbar toggle for the idle action camera (on by default,
    // persisted). Emits `camera:auto-camera` which the World renderer consumes;
    // also reflects the state if it is flipped elsewhere.
    _initCinemaToggle() {
        const btn = this.els.cinemaToggle;
        if (!btn) return;
        const read = () => {
            try { return window.localStorage?.getItem('cv-auto-camera') !== '0'; } catch (_) { return true; }
        };
        const apply = (on) => {
            btn.classList.toggle('topbar__cinema-btn--on', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            btn.textContent = on ? 'CINEMA ON' : 'CINEMA OFF';
            btn.title = on ? 'Auto-camera on: frames live action when idle' : 'Auto-camera off';
        };
        apply(read());
        btn.addEventListener('click', () => {
            const next = !read();
            try { window.localStorage?.setItem('cv-auto-camera', next ? '1' : '0'); } catch (_) { /* storage unavailable */ }
            apply(next);
            eventBus.emit('camera:auto-camera', { enabled: next });
        });
        this._onAutoCamera = (payload) => apply(payload?.enabled !== false);
        eventBus.on('camera:auto-camera', this._onAutoCamera);
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
        this._applyConnectionChrome(connected);
    }

    // Connection-loss as a felt chrome event: while offline the whole app
    // desaturates and dashboard cards freeze to a muted, shimmering opacity.
    // On reconnect a single warm gold sweep washes color back across the
    // chrome. The sweep is a one-shot class cleared by its animationend (and
    // by a fallback timer for reduced-motion, where the animation never fires).
    _applyConnectionChrome(connected) {
        const body = document.body;
        if (!body) return;
        const wasOffline = body.classList.contains('cv-offline');
        body.classList.toggle('cv-offline', !connected);
        if (connected && wasOffline) {
            this._fireRecoverySweep(body);
        }
    }

    _fireRecoverySweep(body) {
        if (this._sweepTimer) clearTimeout(this._sweepTimer);
        body.classList.remove('cv-reconnect-sweep');
        // Force reflow so re-adding the class restarts the animation.
        void body.offsetWidth;
        body.classList.add('cv-reconnect-sweep');
        this._sweepTimer = setTimeout(() => {
            body.classList.remove('cv-reconnect-sweep');
            this._sweepTimer = null;
        }, 1100);
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
        if (this._sweepTimer) clearTimeout(this._sweepTimer);
        eventBus.off('agent:added', this._onUpdate);
        eventBus.off('agent:updated', this._onUpdate);
        eventBus.off('agent:removed', this._onUpdate);
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
