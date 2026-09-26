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
//   track(promise)      add an async operation the clock must wait for
//   real                the page's real timer functions, for harness waits
//   errors              exceptions thrown by virtual callbacks
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
    };
    window.__vc = vc;

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
        const entry = { id, due: vc.now + ms, seq: seq++, fn, args, interval: interval ? Math.max(1, ms) : 0 };
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
            try {
                if (typeof entry.fn === 'function') entry.fn(...entry.args);
            } catch (err) {
                vc.errors.push(String(err?.stack || err));
            }
            vc.fired++;
            // Each timer is its own task: let its promise chains run before
            // the next one fires, as the event loop would.
            await macrotask();
            if (vc.pending.size) await vc.settle();
        }
        await vc.settle();
    };

    vc.timers = () => live.size;
})();
