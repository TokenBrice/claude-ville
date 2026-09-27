// In-page driver for the audio probe's live-app checks (scripts/audio/probe.mjs).
// Injected into the real app (isolated server, ?sim=1) after init.js. It only
// uses the app's public/dev surfaces: the event bus, the ?sim=1 fixture
// driver (`app.agentSimulator`), `window.__claudevilleAudio()`, and real
// window/document events for blur, focus, hide and show. Every log entry is
// stamped with performance.now() so probe.mjs can lay it on the same wall
// clock as the tapped audio (see init.js chunk arrival stamps).
(() => {
    if (window.__probe) return;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const app = () => window.__claudeVilleApp;
    const sim = () => app()?.agentSimulator;
    const controller = () => app()?.topBar?.audio;
    const audio = () => window.__claudevilleAudio?.() || null;
    const log = [];
    let eventBus = null;

    let hidden = false;
    let hiddenInstalled = false;
    function setHidden(value) {
        if (!hiddenInstalled) {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
            hiddenInstalled = true;
        }
        hidden = value;
        document.dispatchEvent(new Event('visibilitychange'));
    }

    const pick = (p, keys) => {
        const o = {};
        for (const k of keys) if (p?.[k] != null) o[k] = typeof p[k] === 'object' ? JSON.parse(JSON.stringify(p[k])) : p[k];
        return o;
    };

    // Largest sample on the engine's cue bus over `ms`: evidence that the cue
    // voice itself sounded, independent of the bed under it. The bus is
    // re-read every poll because a wake or resume may rebuild the graph.
    function watchCueBus(ms) {
        return new Promise((resolve) => {
            const taps = new Map();
            let peak = 0;
            const poll = () => {
                const engine = controller()?.engine;
                if (!engine?.context) return;
                const bus = engine.busInput('cue');
                if (!bus) return;
                let tap = taps.get(bus);
                if (!tap) {
                    const analyser = engine.context.createAnalyser();
                    analyser.fftSize = 2048;
                    bus.connect(analyser);
                    tap = { analyser, bus, buf: new Float32Array(analyser.fftSize) };
                    taps.set(bus, tap);
                }
                tap.analyser.getFloatTimeDomainData(tap.buf);
                for (let i = 0; i < tap.buf.length; i++) {
                    const a = Math.abs(tap.buf[i]);
                    if (a > peak) peak = a;
                }
            };
            const timer = setInterval(poll, 20);
            poll();
            setTimeout(() => {
                clearInterval(timer);
                for (const tap of taps.values()) {
                    try { tap.bus.disconnect(tap.analyser); } catch { /* graph rebuilt */ }
                }
                resolve(peak > 0 ? 20 * Math.log10(peak) : null);
            }, ms);
        });
    }

    // Poll until the context runs again; returns ms from `since` or null.
    async function waitRunning(since, timeoutMs) {
        let contextMs = null;
        let directorMs = null;
        while (performance.now() - since < timeoutMs) {
            const a = audio();
            if (contextMs == null && a?.contextState === 'running') contextMs = performance.now() - since;
            if (directorMs == null && a?.running === true) directorMs = performance.now() - since;
            if (contextMs != null && directorMs != null) break;
            await sleep(10);
        }
        return { contextMs, directorMs };
    }

    window.__probe = {
        log,

        async install() {
            ({ eventBus } = await import('/src/domain/events/DomainEvent.js'));
            const push = (type, detail) => log.push({ type, wall: performance.now(), ...detail });
            eventBus.on('audio:cue-played', p => push('cue', pick(p, ['kind', 'agentId', 'label', 'replaces', 'familyLine'])));
            eventBus.on('attention:raised', p => push('attention:raised', pick(p, ['agentId', 'status'])));
            eventBus.on('distress:watchtower', p => push('distress:watchtower', pick(p, ['agentId', 'kind'])));
            eventBus.on('team:gather', p => push('team:gather', { teamName: p?.teamName ?? null, size: p?.members?.length ?? null }));
            // Wave 7: the awakening (7.4), every pointer press on the sound
            // controls (the enable's user activation), and every caption toast.
            eventBus.on('audio:awakened', p => push('awakened', pick(p, ['contextTime', 'perfAt', 'preset'])));
            document.addEventListener('pointerdown', (e) => {
                const el = e.target?.closest?.('#topbarSoundToggle, #topbarSoundMenu, [role="radio"][data-preset]');
                if (el) push('press', { id: el.id || null, preset: el.getAttribute('data-preset') });
            }, true);
            const toasts = document.getElementById('toastContainer');
            if (toasts) {
                new MutationObserver((records) => {
                    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) push('toast', { text: n.textContent.trim().replace(/\s+/g, ' ') });
                }).observe(toasts, { childList: true });
            }
        },

        setAtmosphere(hour, weather) {
            window.__claudeVilleAtmosphere?.setHour?.(hour);
            window.__claudeVilleAtmosphere?.setWeather?.(weather);
        },

        addAgents(specs) {
            for (const spec of specs) sim()._addAgent(spec);
        },

        // An agent enters an actionable status. 'live' goes through the real
        // producers (world update → VillageDirector distress + AttentionService
        // attention, in their subscription order); the two ordered variants
        // set the status without an update event and emit the producers'
        // payloads in a fixed order, synchronously, so no other raise can
        // interleave.
        signal(agentId, status, order) {
            const wall = performance.now();
            if (order === 'live') {
                sim()._applyStep({ agentId, status, tool: null, lastMessage: `probe ${status}` });
                return wall;
            }
            const agent = app().world.agents.get(agentId);
            agent.status = status;
            const attention = () => eventBus.emit('attention:raised', {
                agentId, status, label: status, agent, reason: status, waitingCount: 1, oldestWaitMs: 0,
            });
            const distress = () => eventBus.emit('distress:watchtower', {
                agentId, kind: status, label: status, ts: Date.now(),
            });
            if (order === 'attention-first') { attention(); distress(); } else { distress(); attention(); }
            return wall;
        },

        // One away episode: leave (blur, blur with the signals-only
        // background, or hide), settle, raise a needs-you through the real
        // producers, watch the cue bus, come back and time the resume.
        async away({ how, agentId, settleMs, listenMs, returnTimeoutMs }) {
            if (how === 'blur-signals') localStorage.setItem('claudeville.sound.background', 'signals');
            const awayAt = performance.now();
            if (how === 'hidden') setHidden(true);
            else window.dispatchEvent(new Event('blur'));
            await sleep(settleMs);
            const before = audio();
            const summonsAt = performance.now();
            sim()._applyStep({
                agentId, status: 'waiting_on_user', tool: 'AskUserQuestion',
                input: 'question=Proceed?', lastMessage: 'Proceed?',
            });
            const cueBusPeakDb = await watchCueBus(listenMs);
            const during = audio();
            const returnAt = performance.now();
            if (how === 'hidden') setHidden(false);
            else window.dispatchEvent(new Event('focus'));
            const resumed = await waitRunning(returnAt, returnTimeoutMs);
            if (how === 'blur-signals') localStorage.setItem('claudeville.sound.background', 'play');
            return {
                how, agentId, awayAt, summonsAt, returnAt, cueBusPeakDb,
                stateBefore: before?.contextState ?? null,
                stateDuring: during?.contextState ?? null,
                wakeCount: during?.wakeCount ?? null,
                background: during?.background ?? null,
                resumed,
            };
        },

        async enableWait(timeoutMs) {
            const since = performance.now();
            while (performance.now() - since < timeoutMs) {
                const a = audio();
                if (a?.contextState === 'running' && a?.running === true) return performance.now() - since;
                await sleep(20);
            }
            return null;
        },

        // 2.1 continuity: blur for `blurMs`, focus, and the piece before, at
        // the end of the blur and `afterMs` after focus.
        async blurFocus({ blurMs, afterMs }) {
            const piece = () => { const np = audio()?.nowPlaying; return np ? JSON.parse(JSON.stringify(np)) : null; };
            const before = piece();
            const blurAt = performance.now();
            window.dispatchEvent(new Event('blur'));
            await sleep(blurMs);
            const during = piece();
            const focusAt = performance.now();
            window.dispatchEvent(new Event('focus'));
            await sleep(afterMs);
            return { before, during, after: piece(), blurAt, focusAt, contextState: audio()?.contextState ?? null };
        },

        // Frame profile (the world benchmark's appTotalMs samples).
        startFrames() {
            window.__claudeVillePerf?.startFrameProfile?.();
        },
        stopFrames() {
            const p = window.__claudeVillePerf?.stopFrameProfile?.();
            return (p?.samples || []).map(s => s.totalMs).filter(Number.isFinite);
        },

        restartScenario(id) {
            sim().stop();
            sim().start(id);
            return performance.now();
        },

        snapshot() {
            const a = audio();
            if (!a) return null;
            return JSON.parse(JSON.stringify(a, (k, v) => (typeof v === 'function' ? undefined : v)));
        },
    };
})();
