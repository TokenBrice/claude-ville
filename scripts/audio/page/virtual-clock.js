// Injected before any page script on the virtual-clock page only (HAR-1),
// after init.js. Replaces every clock the shipped audio code may read —
// setTimeout / setInterval / requestIdleCallback (and their clears),
// Date.now and performance.now — with one virtual millisecond clock that the
// renderer (page/virtual.js) advances in lock-step with an OfflineAudioContext.
// Math.random is already seeded by init.js. Promises, microtasks, module
// loading and MessagePorts stay real.
//
// A step at audio time T fires every timer due by T with performance.now()
// reading T: a timer runs up to one step late, and both clocks agree on it,
// as a realtime page's timers read the audio clock when they actually run.
//
// `window.__vc` is the harness's handle:
//   now                 the virtual performance.now() in ms
//   advanceTo(ms)       move the clock to `ms`, then fire every timer and idle
//                       callback due by then in due order (each as its own
//                       task: microtasks settle between callbacks), then settle
//                       every tracked async operation
//   settle()            await tracked async work (worklet addModule, offline
//                       bakes, audio decoding) and drain microtasks
//   real                the page's real timer functions, for harness waits
//   errors              exceptions thrown by virtual callbacks
//   audio               the source accounting below (Wave 2)
//   timerStats()        per timer call site: callbacks fired and their real
//                       (synchronous) durations in ms
//
// Timer attribution (S4: a timer may wake a scheduler, never place a sound):
// every setTimeout / setInterval / requestIdleCallback records its call site
// (the first app frame, `layers/BaseLayer.js:55`), and while a timer's task
// runs — its callback, the microtasks it queues and the async work it
// starts — that site is the "current" one. Every source start() on the scene
// context is logged with the current site ('harness' for the harness's own
// timers, 'untimed' outside any timer), its audio time, the context state
// (the shimmed 'suspended' of a paused page), and for buffer sources the
// buffer identity, offset, loop and rate (noise-lane checks). With
// `audio.keepNodes` the node itself is kept and every node→node connect is
// recorded, so the harness can trace which bus a source reaches.
(() => {
    if (window.__vc) return;
    const real = {
        setTimeout: window.setTimeout.bind(window),
        clearTimeout: window.clearTimeout.bind(window),
        setInterval: window.setInterval.bind(window),
        clearInterval: window.clearInterval.bind(window),
        requestIdleCallback: window.requestIdleCallback?.bind(window),
        cancelIdleCallback: window.cancelIdleCallback?.bind(window),
        performanceNow: performance.now.bind(performance),
        dateNow: Date.now,
    };

    // A fixed epoch: mid-July (the harness's summer date), 12:00 local.
    const DATE_EPOCH_MS = new Date(2026, 6, 15, 12, 0, 0).getTime();
    const PERF_EPOCH_MS = 1000;
    // Idle callbacks see a generous frame so they always do their work.
    const IDLE_BUDGET_MS = 50;

    const vc = {
        now: PERF_EPOCH_MS,
        real,
        errors: [],
        fired: 0,
        pending: new Set(),
        audio: null,
    };
    window.__vc = vc;

    // The first two app frames of a stack: `site` keys the timer, `caller`
    // says who asked for it. Harness frames (/__har/) never match.
    const APP_FRAME = /\/src\/(?:presentation\/shared\/audio\/)?([^?#\s)]+?):(\d+):\d+/;
    function siteOf(stack) {
        const frames = [];
        for (const line of String(stack || '').split('\n')) {
            const m = APP_FRAME.exec(line);
            if (m) frames.push(`${m[1]}:${m[2]}`);
            if (frames.length === 2) break;
        }
        return { site: frames[0] || 'harness', caller: frames[1] || null };
    }
    let current = null;
    const timerStats = new Map();
    vc.timerStats = () => [...timerStats.values()].map(s => ({ site: s.site, callers: [...s.callers], fired: s.fired, durationsMs: s.durations }));
    vc.currentSite = () => (current ? current.site : 'untimed');

    // Timers: a binary min-heap on (due, seq) — seq keeps FIFO order for
    // equal due times, as browsers do.
    const heap = [];
    const live = new Map();
    let seq = 0;
    let nextId = 1;
    const less = (a, b) => (a.due < b.due || (a.due === b.due && a.seq < b.seq));
    function push(entry) {
        heap.push(entry);
        let i = heap.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (!less(heap[i], heap[p])) break;
            [heap[i], heap[p]] = [heap[p], heap[i]];
            i = p;
        }
    }
    function pop() {
        const top = heap[0];
        const last = heap.pop();
        if (heap.length) {
            heap[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let m = i;
                if (l < heap.length && less(heap[l], heap[m])) m = l;
                if (r < heap.length && less(heap[r], heap[m])) m = r;
                if (m === i) break;
                [heap[i], heap[m]] = [heap[m], heap[i]];
                i = m;
            }
        }
        return top;
    }

    function schedule(fn, delay, args, interval) {
        const id = nextId++;
        const ms = Math.max(0, Number(delay) || 0);
        const { site, caller } = siteOf(new Error().stack);
        const entry = { id, due: vc.now + ms, seq: seq++, fn, args, interval: interval ? Math.max(1, ms) : 0, site, caller };
        live.set(id, entry);
        push(entry);
        return id;
    }
    function cancel(id) {
        const entry = live.get(id);
        if (entry) { entry.cancelled = true; live.delete(id); }
    }

    window.setTimeout = (fn, delay, ...args) => schedule(fn, delay, args, false);
    window.setInterval = (fn, delay, ...args) => schedule(fn, delay, args, true);
    window.clearTimeout = cancel;
    window.clearInterval = cancel;
    // Idle callbacks run on the next clock step (the harness has no frames).
    window.requestIdleCallback = (fn) => schedule(() => fn({ didTimeout: false, timeRemaining: () => IDLE_BUDGET_MS }), 1, [], false);
    window.cancelIdleCallback = cancel;
    performance.now = () => vc.now;
    Date.now = () => DATE_EPOCH_MS + (vc.now - PERF_EPOCH_MS);
    // `new Date()` reads the same virtual clock (a real wall-clock read made
    // two renders of one scene differ by how far apart they ran).
    const RealDate = Date;
    window.Date = class VirtualDate extends RealDate {
        constructor(...args) {
            if (args.length) super(...args);
            else super(RealDate.now());
        }
    };

    // Async work the clock must not run ahead of: worklet modules, offline
    // bakes (a second OfflineAudioContext rendering) and decoding.
    vc.track = (promise) => {
        const p = Promise.resolve(promise).catch(() => {}).finally(() => vc.pending.delete(p));
        vc.pending.add(p);
        return promise;
    };
    const wrap = (proto, name, owns = () => true) => {
        const orig = proto?.[name];
        if (typeof orig !== 'function') return;
        proto[name] = function vcTracked(...a) {
            const result = orig.apply(this, a);
            return owns(this) ? vc.track(result) : result;
        };
    };
    wrap(window.AudioWorklet?.prototype, 'addModule');
    wrap(window.BaseAudioContext?.prototype, 'decodeAudioData');
    // The scene's own context is started by the renderer, not tracked.
    wrap(window.OfflineAudioContext?.prototype, 'startRendering', ctx => ctx !== vc.sceneContext);

    // One real macrotask: every microtask queued so far has run.
    const channel = new MessageChannel();
    const waiters = [];
    channel.port1.onmessage = () => waiters.shift()?.();
    const macrotask = () => new Promise((resolve) => { waiters.push(resolve); channel.port2.postMessage(0); });

    vc.settle = async () => {
        await macrotask();
        while (vc.pending.size) {
            await Promise.race([...vc.pending]);
            await macrotask();
        }
    };

    vc.advanceTo = async (ms) => {
        vc.now = Math.max(vc.now, ms);
        while (heap.length && heap[0].due <= vc.now) {
            const entry = pop();
            if (entry.cancelled) continue;
            if (entry.interval) {
                entry.due += entry.interval;
                entry.seq = seq++;
                push(entry);
            } else {
                live.delete(entry.id);
            }
            current = entry;
            const t0 = real.performanceNow();
            try {
                if (typeof entry.fn === 'function') entry.fn(...entry.args);
            } catch (err) {
                vc.errors.push(String(err?.stack || err));
            }
            const stat = timerStats.get(entry.site) || { site: entry.site, callers: new Set(), fired: 0, durations: [] };
            stat.fired++;
            if (entry.caller) stat.callers.add(entry.caller);
            if (stat.durations.length < 20000) stat.durations.push(real.performanceNow() - t0);
            timerStats.set(entry.site, stat);
            vc.fired++;
            // Each timer is its own task: let its promise chains run before
            // the next one fires, as the event loop would. They stay
            // attributed to this timer.
            await macrotask();
            if (vc.pending.size) await vc.settle();
            current = null;
        }
        await vc.settle();
    };

    vc.timers = () => live.size;

    // ------------------------------------------------ source accounting ----
    const audio = { starts: [], keepNodes: false, edges: new WeakMap(), limit: 400000 };
    vc.audio = audio;
    const bufferIds = new WeakMap();
    let bufferSeq = 0;
    const bufferId = (b) => {
        if (!b) return null;
        if (!bufferIds.has(b)) bufferIds.set(b, ++bufferSeq);
        return bufferIds.get(b);
    };
    const record = (node, when, offset) => {
        const ctx = node.context;
        if (ctx !== vc.sceneContext || audio.starts.length >= audio.limit) return;
        const entry = {
            t: Math.max(Number(when) || 0, ctx.currentTime),
            at: ctx.currentTime,
            k: node.constructor.name[0],
            site: vc.currentSite(),
            suspended: ctx.state === 'suspended',
            e: Infinity,
        };
        if (node instanceof AudioBufferSourceNode && node.buffer) {
            entry.buf = bufferId(node.buffer);
            entry.len = node.buffer.duration;
            entry.off = Number(offset) || 0;
            entry.loop = node.loop;
            entry.rate = node.playbackRate.value;
        }
        if (audio.keepNodes) entry.node = node;
        node.__vcStart = entry;
        audio.starts.push(entry);
    };
    const srcStart = AudioScheduledSourceNode.prototype.start;
    AudioScheduledSourceNode.prototype.start = function vcStart(when = 0, ...rest) {
        record(this, when, 0);
        return srcStart.call(this, when, ...rest);
    };
    const bufStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function vcBufferStart(when = 0, offset = 0, ...rest) {
        record(this, when, offset);
        return bufStart.call(this, when, offset, ...rest);
    };
    const srcStop = AudioScheduledSourceNode.prototype.stop;
    AudioScheduledSourceNode.prototype.stop = function vcStop(when = 0) {
        const entry = this.__vcStart;
        if (entry) entry.e = Math.min(entry.e, Math.max(Number(when) || 0, this.context.currentTime));
        return srcStop.call(this, when);
    };
    const nodeConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function vcConnect(dest, ...rest) {
        if (audio.keepNodes && dest instanceof AudioNode && this.context === vc.sceneContext) {
            let set = audio.edges.get(this);
            if (!set) audio.edges.set(this, (set = new Set()));
            set.add(dest);
        }
        return nodeConnect.call(this, dest, ...rest);
    };
})();
