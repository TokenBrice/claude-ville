import test from 'node:test';
import assert from 'node:assert/strict';

import { WebSocketClient } from '../../claudeville/src/infrastructure/WebSocketClient.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import {
  ClientPerfMetrics,
  createHeapTrend,
  recordHeapSample,
  summarizeHeapTrend,
} from '../../claudeville/src/presentation/shared/ClientPerfMetrics.js';

function frameDriver() {
    let nextHandle = 1;
    let callback = null;
    return {
        requestFrame(next) {
            callback = next;
            return nextHandle++;
        },
        cancelFrame() {},
        tick(timestamp) {
            assert.ok(callback, 'a frame callback should be scheduled while profiling');
            const current = callback;
            callback = null;
            current(timestamp);
        },
    };
}

test('client perf stays inert until explicitly started', () => {
    let scheduled = 0;
    const metrics = new ClientPerfMetrics({
        requestFrame: () => {
            scheduled++;
            return 1;
        },
    });

    assert.equal(metrics.beginMessage(), null);
    assert.equal(metrics.getSnapshot().enabled, false);
    assert.equal(scheduled, 0);
    assert.deepEqual(metrics.getSnapshot().deltaToPaint, {
        count: 0,
        p50Ms: null,
        p95Ms: null,
        maxMs: null,
        patchApply: { count: 0, p50Ms: null, p95Ms: null, maxMs: null },
        eventFanout: { count: 0, p50Ms: null, p95Ms: null, maxMs: null },
        samples: [],
    });
});

test('delta samples include patch, fan-out, next-frame, and mid-frame correlation', () => {
    let now = 0;
    const frames = frameDriver();
    const metrics = new ClientPerfMetrics({
        clock: () => now,
        requestFrame: frames.requestFrame,
        cancelFrame: frames.cancelFrame,
    });

    metrics.start();
    frames.tick(0);
    now = 16;
    frames.tick(16);

    now = 20;
    const message = metrics.beginMessage();
    now = 21;
    const delta = metrics.beginDelta(message);
    metrics.markPatchStart(delta);
    now = 24;
    metrics.markPatchApplied(delta, 2);
    metrics.markFanoutStart(delta);
    now = 29;
    metrics.markFanoutEnd(delta);
    metrics.finishDelta(delta);

    now = 40;
    frames.tick(40);
    const snapshot = metrics.getSnapshot();
    const sample = snapshot.deltaToPaint.samples[0];

    assert.equal(snapshot.deltaToPaint.count, 1);
    assert.equal(sample.parseMs, 1);
    assert.equal(sample.patchApplyMs, 3);
    assert.equal(sample.eventFanoutMs, 5);
    assert.equal(sample.messageToPaintMs, 20);
    assert.equal(sample.fanoutToPaintMs, 11);
    assert.equal(sample.framePhaseMs, 4);
    assert.equal(sample.frameGapMs, 24);
    assert.equal(sample.landedMidFrame, true);
    assert.equal(snapshot.deltaFrameCorrelation.midFrameCount, 1);
    assert.equal(snapshot.deltaFrameCorrelation.associatedFrameGap.p95Ms, 24);
    assert.equal(snapshot.deltaFrameCorrelation.baselineFrameGap.p95Ms, 16);
    assert.equal(snapshot.deltaFrameCorrelation.p95DifferenceMs, 8);

    metrics.stop();
});

test('long tasks and event timing are bounded and attributed to observed windows', () => {
    let now = 100;
    const frames = frameDriver();
    class FakePerformanceObserver {
        static supportedEntryTypes = ['longtask', 'event'];
        static instances = [];

        constructor(callback) {
            this.callback = callback;
            this.options = null;
            this.disconnected = false;
            FakePerformanceObserver.instances.push(this);
        }

        observe(options) {
            this.options = options;
        }

        disconnect() {
            this.disconnected = true;
        }

        emit(entries) {
            this.callback({ getEntries: () => entries });
        }
    }

    const metrics = new ClientPerfMetrics({
        clock: () => now,
        requestFrame: frames.requestFrame,
        cancelFrame: frames.cancelFrame,
        PerformanceObserverClass: FakePerformanceObserver,
        maxLongTaskSamples: 2,
        maxInputSamples: 2,
    });
    metrics.start();
    assert.deepEqual(
        FakePerformanceObserver.instances.map(observer => observer.options.type).sort(),
        ['event', 'longtask'],
    );

    const message = metrics.beginMessage();
    now = 120;
    const delta = metrics.beginDelta(message);
    metrics.markPatchStart(delta);
    now = 125;
    metrics.markPatchApplied(delta, 1);
    metrics.markFanoutStart(delta);
    now = 140;
    metrics.markFanoutEnd(delta);
    metrics.finishDelta(delta);

    now = 160;
    const render = metrics.beginRenderStage('test-render');
    now = 170;
    metrics.endRenderStage(render);

    const longTaskObserver = FakePerformanceObserver.instances
        .find(observer => observer.options.type === 'longtask');
    const eventObserver = FakePerformanceObserver.instances
        .find(observer => observer.options.type === 'event');
    longTaskObserver.emit([
        { startTime: 130, duration: 5 },
        { startTime: 160, duration: 5 },
        { startTime: 200, duration: 5 },
    ]);
    eventObserver.emit([
        { name: 'click', startTime: 10, processingStart: 22, duration: 20 },
        { name: 'keydown', startTime: 30, processingStart: 31, duration: 5 },
        { name: 'click', startTime: 40, processingStart: 50, duration: 20 },
    ]);

    const snapshot = metrics.getSnapshot();
    assert.equal(snapshot.longTasks.count, 3);
    assert.equal(snapshot.longTasks.attribution.update, 1);
    assert.equal(snapshot.longTasks.attribution.render, 1);
    assert.equal(snapshot.longTasks.attribution.other, 1);
    assert.equal(snapshot.longTasks.sampledCount, 2);
    assert.equal(snapshot.inputTiming.count, 3);
    assert.equal(snapshot.inputTiming.delay.p95Ms, 9.55);
    assert.equal(snapshot.inputTiming.sampledCount, 2);
    assert.deepEqual(snapshot.inputTiming.byName, { click: 2, keydown: 1 });

    metrics.stop();
    assert.equal(longTaskObserver.disconnected, true);
    assert.equal(eventObserver.disconnected, true);
});

test('heap trend min/max track only the samples inside the rolling window', () => {
    const trend = createHeapTrend(8);
    assert.equal(recordHeapSample(trend, 0, 100), true);
    assert.equal(recordHeapSample(trend, 1000, 300), true);
    assert.equal(recordHeapSample(trend, 2000, 200), true);
    assert.deepEqual(summarizeHeapTrend(trend, 2000), {
        sampleCount: 3,
        lastBytes: 200,
        lastAt: 2000,
        minBytes: 100,
        maxBytes: 300,
    });
    // The oldest sample left the window: it no longer anchors the minimum.
    assert.deepEqual(summarizeHeapTrend(trend, 2000, 1500), {
        sampleCount: 2,
        lastBytes: 200,
        lastAt: 2000,
        minBytes: 200,
        maxBytes: 300,
    });
    // Every sample aged out: min/max go null, while the last sample stays
    // reported with its timestamp so staleness stays readable.
    const empty = summarizeHeapTrend(trend, 620_000);
    assert.equal(empty.sampleCount, 0);
    assert.equal(empty.minBytes, null);
    assert.equal(empty.maxBytes, null);
    assert.equal(empty.lastBytes, 200);
    assert.equal(empty.lastAt, 2000);
});

test('heap trend ring capacity bounds retention and rejects invalid samples', () => {
    const trend = createHeapTrend(4);
    for (let index = 0; index < 6; index++) {
        assert.equal(recordHeapSample(trend, index * 1000, 10 * (index + 1)), true);
    }
    assert.equal(trend.count, 4);
    assert.deepEqual(summarizeHeapTrend(trend, 5000), {
        sampleCount: 4,
        lastBytes: 60,
        lastAt: 5000,
        minBytes: 30,
        maxBytes: 60,
    });
    assert.equal(recordHeapSample(trend, Number.NaN, 5), false);
    assert.equal(recordHeapSample(trend, 6000, -1), false);
    assert.equal(recordHeapSample(trend, 6000, Number.NaN), false);
    assert.equal(summarizeHeapTrend(null).sampleCount, 0);
    assert.equal(recordHeapSample(null, 0, 1), false);
});

test('heap trend samples at most once per second on the frame tick', () => {
    let now = 0;
    const frames = frameDriver();
    const previousDocument = globalThis.document;
    globalThis.document = { getElementsByTagName: () => ({ length: 42 }) };
    let usedBytes = 20_000_000;
    const metrics = new ClientPerfMetrics({
        clock: () => now,
        requestFrame: frames.requestFrame,
        cancelFrame: frames.cancelFrame,
        readMemory: () => ({
            usedJSHeapSize: usedBytes,
            totalJSHeapSize: usedBytes + 1_000_000,
            jsHeapSizeLimit: 4_000_000_000,
        }),
    });
    try {
        // Before start(): the readout exists but holds no samples.
        assert.equal(metrics.getSnapshot().memory.sampleCount, 0);
        assert.equal(metrics.getDebugHelpers().memoryTrend().supported, true);

        metrics.start();
        for (let index = 1; index <= 10; index++) {
            now = index * 250;
            usedBytes = 20_000_000 + index * 1_000_000;
            frames.tick(now);
        }

        const memory = metrics.getSnapshot().memory;
        assert.equal(memory.supported, true);
        // Ten frames at 250 ms took three samples (0.25 s, 1.25 s, 2.25 s),
        // never one per frame.
        assert.equal(memory.sampleCount, 3);
        assert.equal(memory.lastAt, 2250);
        assert.equal(memory.lastBytes, 29_000_000);
        assert.equal(memory.minBytes, 21_000_000);
        assert.equal(memory.maxBytes, 29_000_000);
        assert.equal(memory.totalBytes, 30_000_000);
        assert.equal(memory.limitBytes, 4_000_000_000);
        assert.equal(memory.domNodes, 42);

        // Stop retains the window; reset clears it.
        metrics.stop();
        assert.equal(metrics.getSnapshot().memory.sampleCount, 3);
        metrics.reset();
        const cleared = metrics.getSnapshot().memory;
        assert.equal(cleared.sampleCount, 0);
        assert.equal(cleared.lastBytes, null);
        assert.equal(cleared.totalBytes, null);
        assert.equal(cleared.domNodes, null);
    } finally {
        globalThis.document = previousDocument;
    }
});

test('heap trend reports unsupported without performance.memory', () => {
    let now = 0;
    const frames = frameDriver();
    const metrics = new ClientPerfMetrics({
        clock: () => now,
        requestFrame: frames.requestFrame,
        cancelFrame: frames.cancelFrame,
        readMemory: () => null,
    });
    metrics.start();
    frames.tick(0);
    now = 5000;
    frames.tick(5000);
    const memory = metrics.getSnapshot().memory;
    assert.equal(memory.supported, false);
    assert.equal(memory.sampleCount, 0);
    assert.equal(memory.minBytes, null);
    assert.equal(memory.maxBytes, null);
    assert.equal(memory.domNodes, null);
    metrics.stop();
});

test('bounded rings retain recent samples while counters retain totals', () => {
    let now = 0;
    const frames = frameDriver();
    const metrics = new ClientPerfMetrics({
        clock: () => now,
        requestFrame: frames.requestFrame,
        cancelFrame: frames.cancelFrame,
        maxDeltaSamples: 2,
        maxFrameSamples: 2,
        maxLongTaskSamples: 2,
        maxInputSamples: 2,
    });
    metrics.start();
    frames.tick(0);

    for (let index = 0; index < 3; index++) {
        now = index * 20 + 1;
        const message = metrics.beginMessage();
        const delta = metrics.beginDelta(message);
        metrics.markPatchStart(delta);
        now++;
        metrics.markPatchApplied(delta, 1);
        metrics.markFanoutStart(delta);
        now++;
        metrics.markFanoutEnd(delta);
        metrics.finishDelta(delta);
        now = (index + 1) * 20;
        frames.tick(now);
    }

    const snapshot = metrics.getSnapshot();
    assert.equal(snapshot.deltaToPaint.samples.length, 2);
    assert.equal(snapshot.frames.samples.length, 2);
    assert.equal(snapshot.dropped.deltaSamples, 1);
    assert.ok(snapshot.limits.deltaSamples <= 2);
    assert.ok(snapshot.limits.frameSamples <= 2);
    metrics.stop();
});

test('WebSocketClient delta diagnostics include patching and synchronous fan-out through next paint', () => {
    const previousWindow = globalThis.window;
    globalThis.window = { location: { protocol: 'http:', host: 'localhost:4000' } };
    let now = 0;
    const frames = frameDriver();
    const perf = new ClientPerfMetrics({
        clock: () => now++,
        requestFrame: frames.requestFrame,
        cancelFrame: frames.cancelFrame,
    });
    perf.start();
    frames.tick(0);
    now = 10;
    const client = new WebSocketClient({ performanceMetrics: perf });
    client._rememberSnapshot({
        seq: 1,
        sessions: [{ sessionId: 'one', status: 'working' }],
        teams: [],
    });

    const updates = [];
    const unsubscribe = eventBus.on('ws:update', payload => {
        updates.push(payload);
        now += 5;
    });
    try {
        client._handleMessage({
            type: 'update-delta',
            deltaVersion: 2,
            baseSeq: 1,
            seq: 2,
            patch: [{ op: 'replace', path: '/sessionsById/one/status', value: 'waiting_on_user' }],
        });
        now = 40;
        frames.tick(40);
        assert.equal(updates[0].sessions[0].status, 'waiting_on_user');
        const sample = perf.getSnapshot().deltaToPaint.samples[0];
        assert.equal(sample.operationCount, 1);
        assert.ok(sample.patchApplyMs > 0);
        assert.ok(sample.eventFanoutMs >= 5);
        assert.equal(sample.nextFrameAt, 40);
        assert.equal(sample.messageToPaintMs, 30);
    } finally {
        perf.stop();
        client.disconnect();
        unsubscribe();
        globalThis.window = previousWindow;
    }

});
