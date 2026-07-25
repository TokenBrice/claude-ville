import { eventBus } from '../../domain/events/DomainEvent.js';
import { AmbientAudioController } from './AmbientAudioController.js';
import { formatCost, formatNumber } from './Formatters.js';
import { el, replaceChildren } from './DomSafe.js';

export class TopBar {
    constructor(world, { modal, attention, chronicle, spendLedger } = {}) {
        this.world = world;
        this.modal = modal || null;
        this.attention = attention || null;
        this.chronicle = chronicle || null;
        this.spendLedger = spendLedger || null;
        this.els = {
            root: document.getElementById('topbar'),
            tokens: document.getElementById('statTokens'),
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
            soundMode: document.getElementById('topbarSoundMode'),
            soundVolume: document.getElementById('topbarSoundVolume'),
            cinemaToggle: document.getElementById('topbarCinemaToggle'),
            alertsToggle: document.getElementById('topbarAlertsToggle'),
            chronicleBtn: document.getElementById('topbarChronicle'),
            rate: document.getElementById('statRate'),
            rateWrap: document.getElementById('statRateWrap'),
            quotaWrap: document.getElementById('statQuotaWrap'),
            quota5h: document.getElementById('statQuota5h'),
            quota7d: document.getElementById('statQuota7d'),
            quotaText: document.getElementById('statQuotaText'),
        };
        this._usage = null;
        this.timeInterval = null;
        this._fpsSamples = [];
        this._fpsPanelEl = null;
        this._changelogHtml = null;
        this._changelogController = null;
        this._destroyed = false;
        this.audio = new AmbientAudioController({
            button: this.els.soundToggle,
            modeButton: this.els.soundMode,
            volumeSlider: this.els.soundVolume,
            world: this.world,
        });
        this._initCinemaToggle();
        this._initAttentionControls();
        this._initChronicleButton();

        this._onUpdate = () => this.render();
        eventBus.on('agent:added', this._onUpdate);
        eventBus.on('agent:updated', this._onUpdate);
        eventBus.on('agent:removed', this._onUpdate);

        this._onFps = (fps) => this.renderFps(fps);
        eventBus.on('fps:updated', this._onFps);

        this._onUsage = (usage) => { this._usage = usage; this._renderQuota(); };
        eventBus.on('usage:updated', this._onUsage);

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

        // 4.12 — perf-health readout: hover the FPS chip for a rolling summary.
        if (this.els.fps) {
            this.els.fps.title = 'Render health — hover for details';
            this._onFpsEnter = () => this._showFpsPanel();
            this._onFpsLeave = () => this._hideFpsPanel();
            this.els.fps.addEventListener('mouseenter', this._onFpsEnter);
            this.els.fps.addEventListener('mouseleave', this._onFpsLeave);
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
        this._onCinemaClick = () => {
            const next = !read();
            try { window.localStorage?.setItem('cv-auto-camera', next ? '1' : '0'); } catch (_) { /* storage unavailable */ }
            apply(next);
            eventBus.emit('camera:auto-camera', { enabled: next });
        };
        btn.addEventListener('click', this._onCinemaClick);
        this._onAutoCamera = (payload) => apply(payload?.enabled !== false);
        eventBus.on('camera:auto-camera', this._onAutoCamera);
    }

    // Attention plumbing: the ATTN chip and the `A` hotkey both jump to the
    // longest-waiting agent, and ALERTS opts into desktop notifications from a
    // real user gesture (browsers reject permission prompts otherwise).
    _initAttentionControls() {
        if (!this.attention) return;

        if (this.els.attentionWrap) {
            this._onAttentionClick = () => this.attention.focusNext();
            this.els.attentionWrap.addEventListener('click', this._onAttentionClick);
        }

        const btn = this.els.alertsToggle;
        if (btn) {
            if (!this.attention.desktopAlertsAvailable) {
                btn.hidden = true;
            } else {
                const apply = (on) => {
                    btn.classList.toggle('topbar__sound-btn--on', on);
                    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
                    btn.textContent = on ? 'ALERTS ON' : 'ALERTS OFF';
                };
                apply(this.attention.desktopAlerts);
                this._onAlertsClick = async () => {
                    const on = await this.attention.setDesktopAlerts(!this.attention.desktopAlerts);
                    apply(on);
                    if (!on && Notification.permission === 'denied') {
                        btn.title = 'Blocked by the browser — allow notifications for localhost:4000';
                    }
                };
                btn.addEventListener('click', this._onAlertsClick);
            }
        }

        this._onAttentionKey = (event) => {
            if (event.key !== 'a' && event.key !== 'A') return;
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            const target = event.target;
            const tag = target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
            const agent = this.attention.focusNext();
            if (agent) event.preventDefault();
        };
        document.addEventListener('keydown', this._onAttentionKey);
    }

    _initChronicleButton() {
        const btn = this.els.chronicleBtn;
        if (!btn) return;
        if (!this.chronicle) { btn.hidden = true; return; }
        this._onChronicleClick = () => {
            this.chronicle.open().catch((err) => {
                console.warn('[TopBar] Chronicle unavailable:', err.message);
            });
        };
        btn.addEventListener('click', this._onChronicleClick);
    }

    render() {
        const stats = this.world.getStats();

        this._renderSpend();
        this.els.working.textContent = stats.working;
        this.els.idle.textContent = stats.idle;
        this.els.waiting.textContent = stats.waiting;

        this.els.badgeErrored.textContent = stats.errored;
        this.els.erroredWrap.style.display = stats.errored > 0 ? '' : 'none';
        this.els.badgeAttention.textContent = stats.attention;
        this.els.attentionWrap.style.display = stats.attention > 0 ? '' : 'none';

        this._renderActivityRail(stats);
    }

    // Today's observed spend, the live burn rate, and quota headroom — the
    // three numbers that answer "am I burning tokens?". The old readout summed
    // the lifetime cost of whichever sessions happened to be resident, which
    // moved for reasons that had nothing to do with spending.
    _renderSpend() {
        const today = this.spendLedger?.sample?.() || { tokens: 0, cacheRead: 0, cost: 0 };
        this.els.tokens.textContent = formatNumber(today.tokens);


        // The rate rides alongside today's total in one cell — two numbers
        // about the same thing, and the topbar has no width to spare.
        const rate = this.spendLedger?.burnRate?.();
        this.els.rate.textContent = rate ? `${formatNumber(Math.round(rate.tokensPerHour))}/h` : '';
        if (this.els.rateWrap) {
            this.els.rateWrap.title = rate
                ? `Tokens observed today, now running at about ${formatCost(rate.costPerHour)}/hour at API rates`
                : 'Tokens observed today by this page. A burn rate appears after a couple of minutes of activity.';
        }
    }

    // Quota is the resource that actually runs out on a subscription, so it
    // gets the bars and the dollar figure is labelled an estimate.
    _renderQuota() {
        const quota = this._usage?.quota;
        const wrap = this.els.quotaWrap;
        if (!wrap) return;
        const fiveHour = Number(quota?.fiveHour);
        const sevenDay = Number(quota?.sevenDay);
        if (!Number.isFinite(fiveHour) && !Number.isFinite(sevenDay)) {
            wrap.hidden = true;
            return;
        }
        wrap.hidden = false;
        const pct = (value) => Math.round(Math.max(0, Math.min(1, value || 0)) * 100);
        const five = pct(fiveHour);
        const seven = pct(sevenDay);
        if (this.els.quota5h) this.els.quota5h.style.width = `${five}%`;
        if (this.els.quota7d) this.els.quota7d.style.width = `${seven}%`;
        // Bars carry the glance; the exact numbers live in the tooltip so the
        // meta line stays narrow enough for the center ledger to breathe.
        if (this.els.quotaText) this.els.quotaText.textContent = `${Math.max(five, seven)}%`;
        wrap.title = `Claude usage: ${five}% of the 5-hour window, ${seven}% of the 7-day window`;
        // Near the ceiling the bars stop being scenery.
        const hot = Math.max(fiveHour || 0, sevenDay || 0) > 0.85;
        wrap.classList.toggle('topbar__quota-meta--hot', hot);
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
            this._fpsSamples.length = 0;
            return;
        }
        this.els.fps.textContent = `${fps} FPS`;
        this.els.fps.classList.toggle('topbar__fps--danger', fps < 25);
        this.els.fps.classList.toggle('topbar__fps--warn', fps >= 25 && fps < 45);
        // 4.12 — rolling window for the hover readout (~2/s emits → ~2 min cap).
        this._fpsSamples.push(fps);
        if (this._fpsSamples.length > 240) this._fpsSamples.shift();
    }

    // 4.12 — perf-health hover panel: now/avg/min over the rolling sample
    // window plus the threshold legend behind the warn/danger colors. Built
    // lazily and updated only on hover; pointer-events: none so it never
    // steals the mouseleave that dismisses it.
    _ensureFpsPanel() {
        if (this._fpsPanelEl || !document.body) return;
        this._fpsPanelEl = el('div', {
            className: 'topbar__fps-panel',
            style: {
                position: 'fixed',
                display: 'none',
                zIndex: '1200',
                padding: '8px 10px',
                border: '1px solid var(--cv-border)',
                borderRadius: '3px',
                background: 'var(--cv-panel)',
                boxShadow: 'var(--cv-elev-2)',
                font: '10px var(--font-body)',
                color: 'var(--cv-tan)',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
            },
        });
        document.body.appendChild(this._fpsPanelEl);
    }

    _showFpsPanel() {
        if (this._destroyed || !this.els.fps) return;
        this._ensureFpsPanel();
        const panel = this._fpsPanelEl;
        if (!panel) return;
        const samples = this._fpsSamples;
        if (samples.length === 0) {
            replaceChildren(panel, [
                el('div', {
                    text: 'World render loop idle (dashboard mode)',
                    style: { color: 'var(--cv-text-muted)' },
                }),
            ]);
        } else {
            const current = samples[samples.length - 1];
            let min = Infinity;
            let sum = 0;
            for (const sample of samples) {
                sum += sample;
                if (sample < min) min = sample;
            }
            const avg = Math.round(sum / samples.length);
            const seconds = Math.max(1, Math.round(samples.length / 2));
            replaceChildren(panel, [
                el('div', {
                    text: `now ${current} · avg ${avg} · min ${min} FPS (~${seconds}s window)`,
                    style: {
                        fontWeight: 'bold',
                        color: current < 25
                            ? 'var(--cv-status-errored)'
                            : current < 45
                                ? 'var(--cv-warn-yellow)'
                                : 'rgba(150, 195, 130, 0.95)',
                    },
                }),
                el('div', {
                    text: '≥45 smooth · 25–44 degraded · <25 struggling',
                    style: { color: 'var(--cv-text-muted)', marginTop: '3px' },
                }),
            ]);
        }
        const rect = this.els.fps.getBoundingClientRect();
        panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 240))}px`;
        panel.style.top = `${rect.bottom + 6}px`;
        panel.style.display = 'block';
    }

    _hideFpsPanel() {
        if (this._fpsPanelEl) this._fpsPanelEl.style.display = 'none';
    }

    _startTimer() {
        this.timeInterval = setInterval(() => {
            const seconds = this.world.activeTime;
            const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
            const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
            const s = String(seconds % 60).padStart(2, '0');
            if (this.els.time) this.els.time.textContent = `${h}:${m}:${s}`;
        }, 1000);
    }

    async _openChangelog() {
        if (!this.modal || this._destroyed) return;
        if (!this._changelogHtml) {
            this._changelogController?.abort?.();
            const controller = new AbortController();
            this._changelogController = controller;
            try {
                const res = await fetch('/api/changelog', { signal: controller.signal });
                if (!res.ok) throw new Error(res.statusText);
                this._changelogHtml = this._changelogToHtml(await res.text());
            } catch (err) {
                if (err?.name === 'AbortError') return;
                this._changelogHtml = '<p>Failed to load changelog.</p>';
            } finally {
                if (this._changelogController === controller) this._changelogController = null;
            }
        }
        if (this._destroyed) return;
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
        if (this._destroyed) return this._destroyPromise;
        this._destroyed = true;
        if (this.timeInterval) {
            clearInterval(this.timeInterval);
            this.timeInterval = null;
        }
        if (this._sweepTimer) {
            clearTimeout(this._sweepTimer);
            this._sweepTimer = null;
        }
        this._changelogController?.abort?.();
        this._changelogController = null;
        eventBus.off('agent:added', this._onUpdate);
        eventBus.off('agent:updated', this._onUpdate);
        eventBus.off('agent:removed', this._onUpdate);
        eventBus.off('fps:updated', this._onFps);
        eventBus.off('usage:updated', this._onUsage);
        if (this._onFpsEnter && this.els.fps) {
            this.els.fps.removeEventListener('mouseenter', this._onFpsEnter);
            this.els.fps.removeEventListener('mouseleave', this._onFpsLeave);
        }
        this._fpsPanelEl?.remove();
        this._fpsPanelEl = null;
        this._fpsSamples = [];
        eventBus.off('ws:connected', this._onWsConnected);
        eventBus.off('ws:disconnected', this._onWsDisconnected);
        if (this._onAutoCamera) eventBus.off('camera:auto-camera', this._onAutoCamera);
        if (this._onCinemaClick && this.els.cinemaToggle) {
            this.els.cinemaToggle.removeEventListener('click', this._onCinemaClick);
        }
        if (this._onVersionClick && this.els.version) {
            this.els.version.removeEventListener('click', this._onVersionClick);
        }
        if (this._onVersionKeydown && this.els.version) {
            this.els.version.removeEventListener('keydown', this._onVersionKeydown);
        }
        if (this._onAttentionClick && this.els.attentionWrap) {
            this.els.attentionWrap.removeEventListener('click', this._onAttentionClick);
        }
        if (this._onAlertsClick && this.els.alertsToggle) {
            this.els.alertsToggle.removeEventListener('click', this._onAlertsClick);
        }
        if (this._onAttentionKey) document.removeEventListener('keydown', this._onAttentionKey);
        if (this._onChronicleClick && this.els.chronicleBtn) {
            this.els.chronicleBtn.removeEventListener('click', this._onChronicleClick);
        }
        document.body?.classList.remove('cv-offline', 'cv-reconnect-sweep');
        this._destroyPromise = Promise.resolve(this.audio?.destroy?.());
        this.audio = null;
        return this._destroyPromise;
    }
}
