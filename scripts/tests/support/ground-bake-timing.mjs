import assert from 'node:assert/strict';
import { groundBakeSlices, GROUND_BAKE_BUDGET } from '../../../claudeville/src/presentation/character-mode/GroundBake.js';

// Keep the worst wall-clock slice in each phase. Replay the same workload so a
// scheduler pause in one phase doesn't discard valid measurements of the others.
export function checkGroundBakeTiming(renderer, season = 'ground') {
    const best = new Map();
    const cap = GROUND_BAKE_BUDGET.sliceCapMs;
    for (let run = 0; run < 5; run++) {
        const worst = new Map();
        const bake = groundBakeSlices(renderer, true);
        let step;
        do {
            const start = performance.now();
            step = bake.next();
            const elapsed = performance.now() - start;
            const phase = step.done ? 'complete' : step.value;
            worst.set(phase, Math.max(worst.get(phase) || 0, elapsed));
        } while (!step.done);
        assert.ok(step.value.stats.maxSliceMs <= Math.max(...worst.values()), 'internal slice timing fits the measured generator steps');
        for (const [phase, ms] of worst) best.set(phase, Math.min(best.get(phase) ?? Infinity, ms));
        if (Math.max(...best.values()) <= cap) break;
    }
    for (const [phase, ms] of best) assert.ok(ms <= cap, `${season} ${phase}: longest slice ${ms.toFixed(2)} ms exceeds ${cap} ms`);
    return Math.max(...best.values());
}
