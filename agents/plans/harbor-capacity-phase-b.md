# Harbor Capacity — Phase B (Minimal Cut)

Date: 2026-04-26
Status: ready to implement
Scope: `claudeville/src/presentation/character-mode/HarborTraffic.js`, plus a one-line debug hook in `claudeville/src/presentation/character-mode/IsometricRenderer.js`.
Companion (deferred): `agents/plans/harbor-capacity-expansion.md` (Phase A, full 24-berth redesign).

## Why two phases

Phase A (24 berths, label LOD, departure stagger, cluster relocation) is sized for a problem we have not yet measured. The independent reviewers raised five blocking issues against Phase A and one foundational question: *is the harbor actually overflowing in real use?* Phase B answers that question with a minimal, low-risk change while delivering a modest capacity bump that still helps the user today. Phase A becomes a follow-up gated on (a) observed real-world commit volumes and (b) addressing the reviewer-flagged blockers.

## Goal

Raise the visible-pending-commit cap from 8 to **12** by adding 4 carefully placed berths. Keep all existing behavior — labels, sea lanes, departure animation, cluster overflow, failure markers — exactly as today.

## Success criteria

- 12 simultaneous pending commits render as 12 distinct ship sprites with readable labels and no obvious overlap.
- 14 commits → 12 ships + a `+2` cluster tag (existing behavior, no relocation).
- A push covering all 12 commits triggers an orderly departure using the current 4 sea lanes (no stagger added).
- Failed push of 12 commits → 12 red Xs (capped only by the existing logic, no time fade added).
- 0–8 commit cases look identical to today.
- A debug hook lets us inject synthetic events and lets us *measure peak ship counts in normal use* over a few days, informing Phase A's scope.

## Changes

### 1. `HarborTraffic.js`

**a. Bump the visibility cap:**

```diff
-const MAX_VISIBLE_SHIPS = 8;
+const MAX_VISIBLE_SHIPS = 12;
```

**b. Add 4 berths to `BERTHS` (8 → 12).** Coordinates chosen for: (i) clearance from the Pharos footprint `x∈[35,37], y∈[14,18]` *inclusive*, (ii) presence of an adjacent dock plank in `HARBOR_DOCK_TILES`, (iii) ≥0.7-tile separation from every other berth (visual reviewer's threshold).

```diff
 const BERTHS = [
     { tileX: 33.2, tileY: 20.8 },
     { tileX: 34.5, tileY: 21.4 },
     { tileX: 36.4, tileY: 21.6 },
     { tileX: 38.4, tileY: 21.5 },
     { tileX: 37.2, tileY: 18.2 },
     { tileX: 37.2, tileY: 16.2 },
     { tileX: 39.1, tileY: 17.5 },
     { tileX: 39.1, tileY: 15.6 },
+    // Phase B: 4 added berths. All clear of the Pharos footprint
+    // (x∈[35,37], y∈[14,18] inclusive) and adjacent to existing
+    // HARBOR_DOCK_TILES entries in scenery.js.
+    { tileX: 38.6, tileY: 16.6 },   // east column infill (between (39.1,15.6) and (39.1,17.5))
+    { tileX: 39.0, tileY: 22.4 },   // outer south corner, on dock plank (39,22)
+    { tileX: 32.4, tileY: 20.4 },   // inner north pier, west end, on dock plank (32,20)
+    { tileX: 35.5, tileY: 20.4 },   // inner north pier, middle, on dock plank (35,20)
 ];
```

Pairwise separation check (smallest gaps; all ≥ 0.7 tile):

| New berth | Closest existing | Δtile | Separation |
| --- | --- | --- | --- |
| (38.6, 16.6) | (39.1, 17.5) | (0.5, 0.9) | 1.03 |
| (39.0, 22.4) | (38.4, 21.5) | (0.6, 0.9) | 1.08 |
| (32.4, 20.4) | (33.2, 20.8) | (0.8, 0.4) | 0.89 |
| (35.5, 20.4) | (36.4, 21.6) | (0.9, 1.2) | 1.50 |

Pharos clearance (footprint `x∈[35,37], y∈[14,18]`): all four berths have either `x > 37` or `y > 20` — none overlap.

**c. Debug hook for validation.** Expose the running instance on `window` behind a non-production guard so the synthetic-stress validation steps can actually run from the browser console.

```diff
 export class HarborTraffic {
     constructor({ sprites } = {}) {
         this.sprites = sprites || null;
         this.state = cloneState();
         this.motionScale = 1;
         this.frame = 0;
+        if (typeof window !== 'undefined') window.__harbor = this;
     }
```

**d. Lightweight peak-volume instrumentation.** A tiny in-memory counter logged once per minute. Removes a piece of guesswork ("does the harbor ever overflow in real use?") and makes Phase A's scope decision data-driven.

```diff
     update(agents, dt = 16, now = Date.now()) {
         this.frame += (dt / 16) * this.motionScale;
         const events = collectGitEventsFromAgents(agents);
         this.state = reduceHarborTrafficState(this.state, events, {
             now,
             motionScale: this.motionScale,
         });
+        this._observePeakDensity(now);
     }
+
+    _observePeakDensity(now) {
+        if (!this._peakWindow) this._peakWindow = { peak: 0, since: now };
+        if (this.state.ships.size > this._peakWindow.peak) {
+            this._peakWindow.peak = this.state.ships.size;
+        }
+        if (now - this._peakWindow.since > 60000) {
+            if (this._peakWindow.peak >= 8) {
+                console.info(`[harbor] peak ships in last minute: ${this._peakWindow.peak}`);
+            }
+            this._peakWindow = { peak: this.state.ships.size, since: now };
+        }
+    }
```

The threshold of 8 means we only log when we exceed the *old* cap — quiet in normal operation, informative when overflow happens.

### 2. `IsometricRenderer.js`

No source change needed if the debug hook lands in `HarborTraffic` itself. (If, on review, we'd rather isolate the global to a single place: move it to `IsometricRenderer.js` where `HarborTraffic` is instantiated and gate it on a `localStorage.getItem('claudeVilleDebug')` flag. For Phase B, in-class is simpler and removable in one diff.)

### 3. Scenery (`claudeville/src/config/scenery.js`)

**No changes.** All four new berths sit on or directly adjacent to existing `HARBOR_DOCK_TILES` entries.

## Validation

1. `node --check claudeville/src/presentation/character-mode/HarborTraffic.js`
2. `npm run dev`, open `http://localhost:4000`, World mode, locate the harbor.
3. Visual sanity at zooms 1/2/3: with whatever real session data exists, no regression vs today.
4. Synthetic stress (now actually runnable via `window.__harbor`):

   ```js
   const fake = Array.from({length: 12}, (_, i) => ({
       id: `fake-${i}`, type: 'commit', project: 'demo',
       sha: `deadbeef${i.toString(16).padStart(2,'0')}`,
       timestamp: Date.now() + i,
       label: `commit message ${i}`,
   }));
   __harbor.state = (await import('./HarborTraffic.js'))
       .reduceHarborTrafficState(__harbor.state, fake, { now: Date.now() });
   ```

   Expect: 12 ships visible at the 12 berth coordinates, all labels readable. Inspect for any berth that visually reads as "in deep water" or "behind the lighthouse".

5. Overflow test: same snippet with `length: 14`. Expect 12 ships + `+2` cluster tag at the existing cluster anchor.

6. Push test: append `{ id: 'push-1', type: 'push', project: 'demo', timestamp: Date.now()+100, status: 'success' }` and re-reduce. Expect all 12 ships to depart along the existing 4 sea lanes (some bunching is expected and tolerated in Phase B — Phase A handles it via stagger + extra lanes).

7. Failed-push test: same with `status: 'failed'`. Expect 12 red Xs — confirm the harbor isn't visually saturated to the point of blocking the lighthouse silhouette. If it is, Phase A's failure-marker cap becomes a higher priority.

8. Real-session observation: leave the dashboard running for a few normal working days. Watch for `[harbor] peak ships in last minute` console lines. The peak distribution drives Phase A's design:
   - If peak rarely exceeds 12 → Phase A may be unnecessary.
   - If peak routinely hits 14–18 → Phase A goes to ~18 berths, simpler than the original 24.
   - If peak regularly hits 24+ → Phase A goes to the original 24 with the full stagger/LOD/anchorage treatment.

## Out of scope (deferred to Phase A)

- Label LOD (truncation, staggering, anchor swaps).
- Departure stagger / additional sea lanes.
- Cluster anchor relocation.
- Failure-marker time cap.
- Anchorage-queue overflow visual.
- Per-project quotas.
- Caching of `_batchOrigin`.
- Revisiting `RECENT_PUSH_REPLAY_MS = 120000` and the historical-commit drop behaviour.

## Risk assessment

- **Visual regression risk**: Low. Four conservatively placed berths within the existing dock footprint; existing draw code is unchanged.
- **Behavioural regression risk**: Very low. Capacity constants only; no animation, reducer, or LOD changes.
- **Performance risk**: Negligible. Four extra ships at peak; no new per-frame allocations.
- **Reviewer-blocker exposure**: None of the five Phase A blockers apply, because the corresponding code (departure stagger, LOD threading, cluster relocation, problematic berth coordinates) is not introduced here. The validation-snippet blocker is *fixed* by the debug hook.

## Definition of done

- `node --check` passes.
- All 12 berths render distinct ships in the synthetic stress test.
- Real-session observation has run long enough to produce at least one week of peak data, or the user explicitly waives this and asks to advance to Phase A.
- A short note appended to this file recording the observed peaks.
