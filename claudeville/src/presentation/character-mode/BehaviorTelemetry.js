const WINDOW_MS = 5 * 60_000;
const SAMPLE_MS = 250;

// Sampled residence, not routed/assigned population. Rings and public result
// objects are allocated once; only new agent/destination identities enter Maps.
export class BehaviorTelemetry {
    constructor({ buildingTypes, windowMs = WINDOW_MS, sampleMs = SAMPLE_MS, maxAgents = 256, maxDestinations = 64 } = {}) {
        this.windowMs = windowMs;
        this.sampleMs = sampleMs;
        this.maxAgents = maxAgents;
        this.maxDestinations = maxDestinations;
        this.capacity = Math.ceil(windowMs / sampleMs) + 1;
        this._buildingTypes = [...new Set(buildingTypes || [])];
        this._outside = this._buildingTypes.length;
        this._buildingTypes.push('outside');
        this._buildingIndices = new Map(this._buildingTypes.map((type, index) => [type, index]));
        this._destinationIndices = new Map();
        this._agentIndices = new Map();
        this._ids = new Array(maxAgents).fill(null);
        this._agentSamples = new Uint32Array(maxAgents);
        this._destinationCounts = new Uint32Array(maxAgents * maxDestinations);
        this._distinct = new Uint16Array(maxAgents);
        this._lastSlot = new Array(maxAgents).fill(null);
        this._lastLateral = new Float64Array(maxAgents);
        this._occupancy = new Uint16Array(this.capacity * maxAgents);
        this._destinations = new Uint16Array(this.capacity * maxAgents);
        this._times = new Float64Array(this.capacity);
        this._durations = new Float64Array(this.capacity);
        this._continuous = new Uint8Array(this.capacity);
        this._samples = new Uint32Array(this.capacity);
        this._moving = new Uint32Array(this.capacity);
        this._slotChanges = new Uint32Array(this.capacity);
        this._allocations = new Float64Array(this.capacity);
        this._overCapacity = new Float64Array(this.capacity);
        this._seconds = new Float64Array(this._buildingTypes.length);
        this._dwells = new Uint32Array(this._buildingTypes.length);
        this._head = 0;
        this._count = 0;
        this._lastAt = null;
        this._firstAt = null;
        this._writing = -1;
        this._allocationBaseline = null;
        this._overCapacityBaseline = null;
        this.metrics = {
            windowMs, sampleMs, maxAgents, maxDestinations,
            sampledAt: null, observedWindowMs: 0, windowSamples: 0,
            agentSamples: 0, agentSeconds: 0, activeAgents: 0, trackedAgents: 0,
            movingSamplePercent: 0, meanDistinctDestinations: 0,
            distinctDestinationsByAgent: Object.create(null),
            allocations: 0, overCapacityAllocations: 0, overCapacityAllocationRatio: 0,
            suppressedBubbleCount: 0, bubbleSlotChanges: 0, bubbleSlotChangesPerMinute: 0,
            droppedAgentSamples: 0, droppedDestinationSamples: 0,
            buildings: Object.fromEntries(this._buildingTypes.map(type => [type, {
                agentSeconds: 0, occupancyShare: 0, dwellVisits: 0, meanDwellSeconds: 0,
            }])),
        };
        this._movingSamples = 0;
    }

    // Count changes can refresh crowd stats earlier than 250 ms. They must not
    // create extra telemetry samples or bias the residence/movement denominator.
    beginSample(now, allocatorMetrics = null) {
        if (!Number.isFinite(now) || this._writing >= 0) return false;
        if (this._lastAt != null && now - this._lastAt < this.sampleMs) return false;
        const cutoff = now - this.windowMs;
        while (this._count && (this._times[this._head] <= cutoff || this._count === this.capacity)) {
            this._expireOldest();
        }
        // Clip a partially overlapping measured interval at the window edge.
        if (this._count) {
            const trim = cutoff - (this._times[this._head] - this._durations[this._head]);
            if (trim > 0) this._trimOldest(trim);
        }
        for (let agent = 0; agent < this.maxAgents; agent++) {
            if (this._ids[agent] == null || this._agentSamples[agent]) continue;
            const id = this._ids[agent];
            this._agentIndices.delete(id);
            delete this.metrics.distinctDestinationsByAgent[id];
            this._ids[agent] = null;
            this._lastSlot[agent] = null;
        }
        const index = (this._head + this._count) % this.capacity;
        this._writing = index;
        this._times[index] = now;
        this._durations[index] = this._lastAt == null ? this.sampleMs : Math.min(this.sampleMs, now - this._lastAt);
        this._continuous[index] = this._lastAt != null && now - this._lastAt <= this.sampleMs * 2 ? 1 : 0;
        const allocations = Math.max(0, Number(allocatorMetrics?.allocations) || 0);
        const overCapacity = Math.max(0, Number(allocatorMetrics?.overCapacityAllocations) || 0);
        // A reset of allocator counters establishes a fresh baseline, not a
        // negative allocation event. The first tick excludes pre-observation work.
        this._allocations[index] = this._allocationBaseline == null ? 0 : Math.max(0, allocations - this._allocationBaseline);
        this._overCapacity[index] = this._overCapacityBaseline == null ? 0 : Math.max(0, overCapacity - this._overCapacityBaseline);
        this._allocationBaseline = allocations;
        this._overCapacityBaseline = overCapacity;
        this.metrics.allocations += this._allocations[index];
        this.metrics.overCapacityAllocations += this._overCapacity[index];
        this.metrics.suppressedBubbleCount = 0;
        if (this._firstAt == null) this._firstAt = now;
        return true;
    }

    observeAgent(id, building, destination, moving, suppressed = false, slot = null, lateral = 0) {
        const index = this._writing;
        if (index < 0 || id == null) return;
        let agent = this._agentIndices.get(id);
        if (agent == null) {
            agent = this._ids.indexOf(null);
            if (agent < 0) {
                this.metrics.droppedAgentSamples++;
                return;
            }
            this._ids[agent] = id;
            this._agentIndices.set(id, agent);
        }
        const cell = index * this.maxAgents + agent;
        if (this._occupancy[cell]) return; // One session, one sample.
        const previous = (index + this.capacity - 1) % this.capacity;
        const previousBuilding = this._count && this._continuous[index]
            ? this._occupancy[previous * this.maxAgents + agent] : 0;
        const buildingIndex = this._buildingIndices.get(building) ?? this._outside;
        const occupancy = buildingIndex + 1;
        this._occupancy[cell] = occupancy;
        if (previousBuilding !== occupancy) this._dwells[buildingIndex]++;
        const seconds = this._durations[index] / 1000;
        this._seconds[buildingIndex] += seconds;
        this.metrics.agentSeconds += seconds;
        this._samples[index]++;
        this._agentSamples[agent]++;
        this.metrics.agentSamples++;
        if (moving) {
            this._moving[index]++;
            this._movingSamples++;
        }
        if (suppressed) this.metrics.suppressedBubbleCount++;
        if (previousBuilding && slot != null && this._lastSlot[agent] != null
            && (slot !== this._lastSlot[agent] || lateral !== this._lastLateral[agent])) {
            this._slotChanges[index]++;
            this.metrics.bubbleSlotChanges++;
        }
        this._lastSlot[agent] = slot;
        this._lastLateral[agent] = lateral;
        if (destination != null) {
            let dest = this._destinationIndices.get(destination);
            if (dest == null && this._destinationIndices.size < this.maxDestinations) {
                dest = this._destinationIndices.size;
                this._destinationIndices.set(destination, dest);
            }
            if (dest == null) {
                this.metrics.droppedDestinationSamples++;
            } else {
                this._destinations[cell] = dest + 1;
                const offset = agent * this.maxDestinations + dest;
                if (this._destinationCounts[offset]++ === 0) this._distinct[agent]++;
            }
        }
    }

    endSample() {
        const index = this._writing;
        if (index < 0) return this.metrics;
        this._count++;
        this._lastAt = this._times[index];
        this._writing = -1;
        const metrics = this.metrics;
        metrics.sampledAt = this._lastAt;
        metrics.observedWindowMs = Math.min(this.windowMs, this._lastAt - this._firstAt + this.sampleMs);
        metrics.windowSamples = this._count;
        metrics.activeAgents = this._samples[index];
        metrics.trackedAgents = this._agentIndices.size;
        metrics.movingSamplePercent = metrics.agentSamples ? 100 * this._movingSamples / metrics.agentSamples : 0;
        metrics.overCapacityAllocationRatio = metrics.allocations ? metrics.overCapacityAllocations / metrics.allocations : 0;
        metrics.bubbleSlotChangesPerMinute = metrics.observedWindowMs ? metrics.bubbleSlotChanges * 60_000 / metrics.observedWindowMs : 0;
        let distinctTotal = 0;
        for (let agent = 0; agent < this.maxAgents; agent++) {
            if (this._ids[agent] == null) continue;
            metrics.distinctDestinationsByAgent[this._ids[agent]] = this._distinct[agent];
            distinctTotal += this._distinct[agent];
        }
        metrics.meanDistinctDestinations = metrics.trackedAgents ? distinctTotal / metrics.trackedAgents : 0;
        for (let building = 0; building < this._buildingTypes.length; building++) {
            const row = metrics.buildings[this._buildingTypes[building]];
            row.agentSeconds = Math.max(0, this._seconds[building]);
            row.occupancyShare = metrics.agentSeconds > 0 ? row.agentSeconds / metrics.agentSeconds : 0;
            row.dwellVisits = this._dwells[building];
            row.meanDwellSeconds = building !== this._outside && row.dwellVisits ? row.agentSeconds / row.dwellVisits : 0;
        }
        return metrics;
    }

    _trimOldest(milliseconds) {
        const index = this._head;
        const trim = Math.min(milliseconds, this._durations[index]);
        const seconds = trim / 1000;
        const base = index * this.maxAgents;
        for (let agent = 0; agent < this.maxAgents; agent++) {
            const occupancy = this._occupancy[base + agent];
            if (occupancy) this._seconds[occupancy - 1] -= seconds;
        }
        this.metrics.agentSeconds = Math.max(0, this.metrics.agentSeconds - seconds * this._samples[index]);
        this._durations[index] -= trim;
    }

    _expireOldest() {
        const index = this._head;
        this._trimOldest(this._durations[index]);
        const next = (index + 1) % this.capacity;
        const base = index * this.maxAgents;
        for (let agent = 0; agent < this.maxAgents; agent++) {
            const occupancy = this._occupancy[base + agent];
            if (!occupancy) continue;
            const continues = this._count > 1 && this._continuous[next]
                && this._occupancy[next * this.maxAgents + agent] === occupancy;
            if (!continues) this._dwells[occupancy - 1]--;
            this._agentSamples[agent]--;
            const destination = this._destinations[base + agent];
            if (destination && --this._destinationCounts[agent * this.maxDestinations + destination - 1] === 0) {
                this._distinct[agent]--;
            }
            this._occupancy[base + agent] = 0;
            this._destinations[base + agent] = 0;
        }
        this.metrics.agentSamples -= this._samples[index];
        this._movingSamples -= this._moving[index];
        this.metrics.bubbleSlotChanges -= this._slotChanges[index];
        this.metrics.allocations -= this._allocations[index];
        this.metrics.overCapacityAllocations -= this._overCapacity[index];
        this._samples[index] = this._moving[index] = this._slotChanges[index] = 0;
        this._allocations[index] = this._overCapacity[index] = 0;
        this._head = next;
        this._count--;
    }
}
