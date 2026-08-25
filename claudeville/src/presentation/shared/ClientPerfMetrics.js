const DEFAULT_DELTA_SAMPLES = 240;
const DEFAULT_FRAME_SAMPLES = 600;
const DEFAULT_LONG_TASK_SAMPLES = 120;
const DEFAULT_INPUT_SAMPLES = 120;
const DEFAULT_INPUT_EVENT_NAMES = 32;
const DEFAULT_UPDATE_WINDOWS = 240;
const DEFAULT_RENDER_WINDOWS = 120;
const DEFAULT_PENDING_DELTAS = 128;
const RECENT_SNAPSHOT_SAMPLES = 64;
const MID_FRAME_EPSILON_MS = 0.5;

function defaultNow() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

function defaultRequestFrame(callback) {
    if (typeof requestAnimationFrame !== 'function') return null;
    return requestAnimationFrame(callback);
}

function defaultCancelFrame(handle) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
}

function finite(value) {
    return Number.isFinite(value) ? value : null;
}

function duration(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const value = Number(end) - Number(start);
    return Number.isFinite(value) && value >= 0 ? value : null;
}

function boundedPush(buffer, value, limit, onDrop = null) {
    if (buffer.length >= limit) {
        buffer.shift();
        onDrop?.();
    }
    buffer.push(value);
}

function entriesFrom(list) {
    if (Array.isArray(list)) return list;
    if (typeof list?.getEntries === 'function') return list.getEntries();
    return [];
}

function percentile(values, fraction) {
    const finiteValues = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (finiteValues.length === 0) return null;
    const position = (finiteValues.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return finiteValues[lower];
    return finiteValues[lower] + (finiteValues[upper] - finiteValues[lower]) * (position - lower);
}

function round(value) {
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function summarizeValues(values) {
    const finiteValues = values.filter(Number.isFinite);
    if (finiteValues.length === 0) {
        return { count: 0, p50Ms: null, p95Ms: null, maxMs: null };
    }
    return {
        count: finiteValues.length,
        p50Ms: round(percentile(finiteValues, 0.5)),
        p95Ms: round(percentile(finiteValues, 0.95)),
        maxMs: round(Math.max(...finiteValues)),
    };
}

function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
}

function copyRecent(buffer) {
    return buffer.slice(-RECENT_SNAPSHOT_SAMPLES).map(sample => ({ ...sample }));
}

/**
 * Opt-in browser performance measurements for the session-update path.
 *
 * No observers, animation frames, or sample buffers are created until start()
 * is called. All retained samples are fixed-size rings so a long dashboard
 * session cannot grow memory just because diagnostics were enabled.
 */
export class ClientPerfMetrics {
    constructor({
        clock = defaultNow,
        requestFrame = defaultRequestFrame,
        cancelFrame = defaultCancelFrame,
        PerformanceObserverClass = null,
        maxDeltaSamples = DEFAULT_DELTA_SAMPLES,
        maxFrameSamples = DEFAULT_FRAME_SAMPLES,
        maxLongTaskSamples = DEFAULT_LONG_TASK_SAMPLES,
        maxInputSamples = DEFAULT_INPUT_SAMPLES,
        maxInputEventNames = DEFAULT_INPUT_EVENT_NAMES,
        maxUpdateWindows = DEFAULT_UPDATE_WINDOWS,
        maxRenderWindows = DEFAULT_RENDER_WINDOWS,
        maxPendingDeltas = DEFAULT_PENDING_DELTAS,
    } = {}) {
        this._clock = typeof clock === 'function' ? clock : defaultNow;
        this._requestFrame = typeof requestFrame === 'function' ? requestFrame : defaultRequestFrame;
        this._cancelFrame = typeof cancelFrame === 'function' ? cancelFrame : defaultCancelFrame;
        this._PerformanceObserverClass = PerformanceObserverClass;
        this._limits = {
            deltaSamples: Math.max(1, Math.floor(maxDeltaSamples)),
            frameSamples: Math.max(1, Math.floor(maxFrameSamples)),
            longTaskSamples: Math.max(1, Math.floor(maxLongTaskSamples)),
            inputSamples: Math.max(1, Math.floor(maxInputSamples)),
            inputEventNames: Math.max(1, Math.floor(maxInputEventNames)),
            updateWindows: Math.max(1, Math.floor(maxUpdateWindows)),
            renderWindows: Math.max(1, Math.floor(maxRenderWindows)),
            pendingDeltas: Math.max(1, Math.floor(maxPendingDeltas)),
        };

        this.enabled = false;
        this._deltaSamples = [];
        this._frameSamples = [];
        this._longTaskSamples = [];
        this._inputSamples = [];
        this._updateWindows = [];
        this._renderWindows = [];
        this._pendingDeltas = new Map();
        this._observers = [];
        this._frameHandle = null;
        this._frameScheduled = false;
        this._lastFrameAt = null;
        this._nextDeltaId = 1;
        this._nextRenderId = 1;
        this._capabilities = {
            requestAnimationFrame: false,
            longtask: false,
            event: false,
        };
        this._dropped = {
            deltaSamples: 0,
            frameSamples: 0,
            longTaskSamples: 0,
            inputSamples: 0,
            updateWindows: 0,
            renderWindows: 0,
            pendingDeltas: 0,
        };
        this._longTaskTotals = {
            count: 0,
            totalMs: 0,
            maxMs: 0,
            attribution: { update: 0, render: 0, mixed: 0, other: 0 },
        };
        this._inputTotals = {
            count: 0,
            totalDelayMs: 0,
            maxDelayMs: 0,
            byName: {},
        };

        this._onFrame = timestamp => this._handleFrame(timestamp);
        this._debugHelpers = {
            clientPerf: () => this.getSnapshot(),
            startClientPerf: () => this.start(),
            stopClientPerf: () => this.stop(),
            resetClientPerf: () => this.reset(),
        };
    }

    getDebugHelpers() {
        return this._debugHelpers;
    }

    start({ reset = true } = {}) {
        if (this.enabled) return false;
        if (reset) this.reset();
        this.enabled = true;
        this._capabilities.requestAnimationFrame = this._canRequestFrame();
        this._installPerformanceObservers();
        this._scheduleFrame();
        return true;
    }

    stop() {
        if (!this.enabled) return false;
        this.enabled = false;
        if (this._frameScheduled && this._frameHandle !== null) {
            try { this._cancelFrame(this._frameHandle); } catch { /* diagnostics only */ }
        }
        this._frameHandle = null;
        this._frameScheduled = false;
        this._pendingDeltas.clear();
        for (const observer of this._observers) {
            try { observer.disconnect?.(); } catch { /* diagnostics only */ }
        }
        this._observers = [];
        this._lastFrameAt = null;
        return true;
    }

    reset() {
        this._deltaSamples = [];
        this._frameSamples = [];
        this._longTaskSamples = [];
        this._inputSamples = [];
        this._updateWindows = [];
        this._renderWindows = [];
        this._pendingDeltas.clear();
        this._lastFrameAt = null;
        this._capabilities = {
            requestAnimationFrame: false,
            longtask: false,
            event: false,
        };
        this._nextDeltaId = 1;
        this._nextRenderId = 1;
        this._dropped = {
            deltaSamples: 0,
            frameSamples: 0,
            longTaskSamples: 0,
            inputSamples: 0,
            updateWindows: 0,
            renderWindows: 0,
            pendingDeltas: 0,
        };
        this._longTaskTotals = {
            count: 0,
            totalMs: 0,
            maxMs: 0,
            attribution: { update: 0, render: 0, mixed: 0, other: 0 },
        };
        this._inputTotals = {
            count: 0,
            totalDelayMs: 0,
            maxDelayMs: 0,
            byName: {},
        };
    }

    beginMessage() {
        if (!this.enabled) return null;
        return {
            id: this._nextDeltaId++,
            arrivedAt: this._clock(),
            previousFrameAt: this._lastFrameAt,
        };
    }

    cancelMessage(message) {
        if (!this.enabled || !message) return;
        message.cancelled = true;
    }

    beginDelta(message = null) {
        if (!this.enabled) return null;
        const token = message && Number.isFinite(message.arrivedAt)
            ? message
            : this.beginMessage();
        if (!token) return null;
        token.parseMs = duration(token.arrivedAt, this._clock());
        token.patchStartedAt = null;
        token.patchAppliedAt = null;
        token.fanoutStartedAt = null;
        token.fanoutEndedAt = null;
        token.finished = false;
        return token;
    }

    markPatchStart(token) {
        if (!this.enabled || !token) return;
        token.patchStartedAt = this._clock();
    }

    markPatchApplied(token, operationCount = null) {
        if (!this.enabled || !token) return;
        token.patchAppliedAt = this._clock();
        token.operationCount = Number.isFinite(operationCount) ? operationCount : null;
        token.patchApplyMs = duration(token.patchStartedAt, token.patchAppliedAt);
        token.arrivalToPatchMs = duration(token.arrivedAt, token.patchAppliedAt);
    }

    markFanoutStart(token) {
        if (!this.enabled || !token) return;
        token.fanoutStartedAt = this._clock();
    }

    markFanoutEnd(token) {
        if (!this.enabled || !token) return;
        token.fanoutEndedAt = this._clock();
        token.eventFanoutMs = duration(token.fanoutStartedAt, token.fanoutEndedAt);
        token.arrivalToFanoutMs = duration(token.arrivedAt, token.fanoutEndedAt);
    }

    finishDelta(token, { outcome = 'painted' } = {}) {
        if (!this.enabled || !token || token.finished) return;
        token.finished = true;
        token.outcome = outcome;
        if (!Number.isFinite(token.fanoutEndedAt)) return;
        this._recordUpdateWindow(token);
        this._pendingDeltas.set(token.id, token);
        while (this._pendingDeltas.size > this._limits.pendingDeltas) {
            const oldestId = this._pendingDeltas.keys().next().value;
            this._pendingDeltas.delete(oldestId);
            this._dropped.pendingDeltas++;
        }
        this._scheduleFrame();
    }

    discardDelta(token, outcome = 'discarded') {
        if (!this.enabled || !token || token.finished) return;
        token.finished = true;
        token.outcome = outcome;
    }

    /** Record an actual render-stage window when a renderer integration exists. */
    beginRenderStage(label = 'render') {
        if (!this.enabled) return null;
        return { id: this._nextRenderId++, label, startedAt: this._clock() };
    }

    endRenderStage(token) {
        if (!this.enabled || !token) return;
        const endedAt = this._clock();
        if (!Number.isFinite(token.startedAt)) return;
        boundedPush(
            this._renderWindows,
            { startTime: token.startedAt, endTime: endedAt, label: token.label },
            this._limits.renderWindows,
            () => { this._dropped.renderWindows++; },
        );
    }

    getSnapshot() {
        const deltaPaintValues = this._deltaSamples.map(sample => sample.messageToPaintMs);
        const patchValues = this._deltaSamples.map(sample => sample.patchApplyMs);
        const fanoutValues = this._deltaSamples.map(sample => sample.eventFanoutMs);
        const frameValues = this._frameSamples.map(sample => sample.gapMs);
        const deltaFrameValues = this._frameSamples
            .filter(sample => sample.deltaCount > 0)
            .map(sample => sample.gapMs);
        const baselineFrameValues = this._frameSamples
            .filter(sample => sample.deltaCount === 0)
            .map(sample => sample.gapMs);
        const inputDelayValues = this._inputSamples.map(sample => sample.inputDelayMs);
        const deltaPaint = summarizeValues(deltaPaintValues);
        const deltaFrameGap = summarizeValues(deltaFrameValues);
        const baselineFrameGap = summarizeValues(baselineFrameValues);

        return {
            enabled: this.enabled,
            capabilities: { ...this._capabilities },
            limits: { ...this._limits },
            summary: {
                deltaCount: this._deltaSamples.length,
                deltaToPaintP95Ms: deltaPaint.p95Ms,
                midFrameDeltaCount: this._deltaSamples.filter(sample => sample.landedMidFrame).length,
                deltaFrameGapP95Ms: deltaFrameGap.p95Ms,
                baselineFrameGapP95Ms: baselineFrameGap.p95Ms,
                longTaskCount: this._longTaskTotals.count,
                inputDelayP95Ms: round(percentile(inputDelayValues, 0.95)),
            },
            deltaToPaint: {
                ...deltaPaint,
                patchApply: summarizeValues(patchValues),
                eventFanout: summarizeValues(fanoutValues),
                samples: copyRecent(this._deltaSamples),
            },
            frames: {
                ...summarizeValues(frameValues),
                sampledCount: this._frameSamples.length,
                associatedWithDelta: deltaFrameGap,
                withoutDelta: baselineFrameGap,
                samples: copyRecent(this._frameSamples),
            },
            deltaFrameCorrelation: {
                deltaCount: this._deltaSamples.length,
                midFrameCount: this._deltaSamples.filter(sample => sample.landedMidFrame).length,
                withNextFrameCount: this._deltaSamples.filter(sample => Number.isFinite(sample.frameGapMs)).length,
                associatedFrameGap: deltaFrameGap,
                baselineFrameGap,
                p95DifferenceMs: deltaFrameGap.p95Ms === null || baselineFrameGap.p95Ms === null
                    ? null
                    : round(deltaFrameGap.p95Ms - baselineFrameGap.p95Ms),
            },
            longTasks: {
                count: this._longTaskTotals.count,
                totalMs: round(this._longTaskTotals.totalMs),
                maxMs: round(this._longTaskTotals.maxMs),
                sampledCount: this._longTaskSamples.length,
                sampledDuration: summarizeValues(this._longTaskSamples.map(sample => sample.durationMs)),
                attribution: { ...this._longTaskTotals.attribution },
                renderWindowsObserved: this._renderWindows.length,
                samples: copyRecent(this._longTaskSamples),
            },
            inputTiming: {
                count: this._inputTotals.count,
                totalDelayMs: round(this._inputTotals.totalDelayMs),
                maxDelayMs: round(this._inputTotals.maxDelayMs),
                sampledCount: this._inputSamples.length,
                delay: summarizeValues(inputDelayValues),
                byName: { ...this._inputTotals.byName },
                samples: copyRecent(this._inputSamples),
            },
            pendingDeltas: this._pendingDeltas.size,
            dropped: { ...this._dropped },
        };
    }

    _canRequestFrame() {
        return this._requestFrame === defaultRequestFrame
            ? typeof requestAnimationFrame === 'function'
            : true;
    }

    _scheduleFrame() {
        if (!this.enabled || this._frameScheduled || !this._capabilities.requestAnimationFrame) return;
        try {
            const handle = this._requestFrame(this._onFrame);
            if (handle === null || handle === undefined) {
                this._capabilities.requestAnimationFrame = false;
                return;
            }
            this._frameHandle = handle;
            this._frameScheduled = true;
        } catch {
            this._capabilities.requestAnimationFrame = false;
        }
    }

    _handleFrame(timestamp) {
        if (!this.enabled) return;
        this._frameScheduled = false;
        this._frameHandle = null;
        // The rAF timestamp is the frame's scheduled start. Use the callback's
        // actual clock time so a long task that delays this callback widens the
        // measured gap instead of being hidden by an old timestamp.
        const clockAt = this._clock();
        const frameAt = Number.isFinite(clockAt)
            ? clockAt
            : (Number.isFinite(timestamp) ? timestamp : null);
        const previousFrameAt = this._lastFrameAt;
        const frameGapMs = duration(previousFrameAt, frameAt);
        const painted = [];
        for (const [id, token] of this._pendingDeltas) {
            if (token.fanoutEndedAt <= frameAt + MID_FRAME_EPSILON_MS) {
                this._pendingDeltas.delete(id);
                painted.push(token);
            }
        }

        boundedPush(
            this._frameSamples,
            { at: frameAt, gapMs: frameGapMs, deltaCount: painted.length },
            this._limits.frameSamples,
            () => { this._dropped.frameSamples++; },
        );
        this._lastFrameAt = frameAt;

        for (const token of painted) {
            const framePhaseMs = duration(token.previousFrameAt, token.arrivedAt);
            const sample = {
                id: token.id,
                arrivedAt: token.arrivedAt,
                nextFrameAt: frameAt,
                parseMs: token.parseMs,
                patchApplyMs: token.patchApplyMs,
                eventFanoutMs: token.eventFanoutMs,
                arrivalToPatchMs: token.arrivalToPatchMs,
                arrivalToFanoutMs: token.arrivalToFanoutMs,
                messageToPaintMs: duration(token.arrivedAt, frameAt),
                fanoutToPaintMs: duration(token.fanoutEndedAt, frameAt),
                framePhaseMs,
                frameGapMs,
                operationCount: token.operationCount,
                landedMidFrame: Number.isFinite(framePhaseMs)
                    && framePhaseMs > MID_FRAME_EPSILON_MS
                    && token.arrivedAt < frameAt,
                outcome: token.outcome || 'painted',
            };
            boundedPush(
                this._deltaSamples,
                sample,
                this._limits.deltaSamples,
                () => { this._dropped.deltaSamples++; },
            );
        }

        this._scheduleFrame();
    }

    _recordUpdateWindow(token) {
        boundedPush(
            this._updateWindows,
            { startTime: token.arrivedAt, endTime: token.fanoutEndedAt },
            this._limits.updateWindows,
            () => { this._dropped.updateWindows++; },
        );
    }

    _installPerformanceObservers() {
        const Observer = this._PerformanceObserverClass || globalThis.PerformanceObserver;
        if (typeof Observer !== 'function') return;
        const supported = Array.isArray(Observer.supportedEntryTypes)
            ? Observer.supportedEntryTypes
            : null;

        if (!supported || supported.includes('longtask')) {
            this._capabilities.longtask = this._observe(Observer, 'longtask', entries => {
                this._recordLongTasks(entriesFrom(entries));
            });
        }
        if (!supported || supported.includes('event')) {
            this._capabilities.event = this._observe(Observer, 'event', entries => {
                this._recordInputEvents(entriesFrom(entries));
            });
        }
    }

    _observe(Observer, type, callback) {
        try {
            const observer = new Observer(callback);
            const options = type === 'event'
                ? { type, buffered: true, durationThreshold: 16 }
                : { type, buffered: true };
            observer.observe(options);
            this._observers.push(observer);
            return true;
        } catch {
            return false;
        }
    }

    _recordLongTasks(entries) {
        if (!this.enabled) return;
        for (const entry of entries) {
            const startTime = finite(entry?.startTime);
            const durationMs = finite(entry?.duration);
            if (startTime === null || durationMs === null || durationMs < 0) continue;
            const attribution = this._attributeWindow(startTime, startTime + durationMs);
            this._longTaskTotals.count++;
            this._longTaskTotals.totalMs += durationMs;
            this._longTaskTotals.maxMs = Math.max(this._longTaskTotals.maxMs, durationMs);
            this._longTaskTotals.attribution[attribution]++;
            boundedPush(
                this._longTaskSamples,
                { startTime, durationMs: round(durationMs), attribution },
                this._limits.longTaskSamples,
                () => { this._dropped.longTaskSamples++; },
            );
        }
    }

    _recordInputEvents(entries) {
        if (!this.enabled) return;
        for (const entry of entries) {
            const startTime = finite(entry?.startTime);
            const processingStart = finite(entry?.processingStart);
            if (startTime === null || processingStart === null) continue;
            const inputDelayMs = Math.max(0, processingStart - startTime);
            const name = String(entry?.name || 'unknown');
            this._inputTotals.count++;
            this._inputTotals.totalDelayMs += inputDelayMs;
            this._inputTotals.maxDelayMs = Math.max(this._inputTotals.maxDelayMs, inputDelayMs);
            const knownName = Object.prototype.hasOwnProperty.call(this._inputTotals.byName, name);
            const nameKey = knownName || Object.keys(this._inputTotals.byName).length < this._limits.inputEventNames
                ? name
                : '[other]';
            this._inputTotals.byName[nameKey] = (this._inputTotals.byName[nameKey] || 0) + 1;
            boundedPush(
                this._inputSamples,
                {
                    name,
                    startTime,
                    durationMs: finite(entry?.duration),
                    inputDelayMs: round(inputDelayMs),
                },
                this._limits.inputSamples,
                () => { this._dropped.inputSamples++; },
            );
        }
    }

    _attributeWindow(startTime, endTime) {
        let update = false;
        let render = false;
        for (const window of this._updateWindows) {
            if (overlaps(startTime, endTime, window.startTime, window.endTime)) {
                update = true;
                break;
            }
        }
        for (const window of this._renderWindows) {
            if (overlaps(startTime, endTime, window.startTime, window.endTime)) {
                render = true;
                break;
            }
        }
        if (update && render) return 'mixed';
        if (update) return 'update';
        if (render) return 'render';
        return 'other';
    }
}
