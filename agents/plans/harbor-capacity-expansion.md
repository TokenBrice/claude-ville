# Harbor Capacity Expansion — Implementation Plan (Phase A — DEFERRED)

> **Status: deferred behind Phase B.** This document is the full 24-berth redesign. Three independent reviewers found five blocking issues (lighthouse-footprint berth collisions, broken departure stagger gating, new-commit-during-departure berth reuse, unspecified LOD threading, and a fictional console validation snippet) plus several should-fix concerns. Before this plan is implementable it must be rewritten to absorb that feedback. It is also not yet justified by measured real-world commit volume.
>
> **Active plan: [`harbor-capacity-phase-b.md`](./harbor-capacity-phase-b.md)** — minimal cut to 12 berths with a debug hook and peak-volume instrumentation. Phase A revives once Phase B observation data justifies the larger redesign.
>
> Reviewer findings to address when reviving Phase A:
> - **Berth layout (§5):** Pharos footprint is `x∈[35,37], y∈[14,18]` *inclusive*; berths 17, 20, 23 collide with the lighthouse; berths 13/18/19 float in deep water with no dock backing; berths 21/11 and 22/16 violate the plan's own ≥0.7-tile rule; cluster anchor at `(34.5, 22.7)` lands under the minimap.
> - **Departure stagger (§6):** assigning `departStartedAt` to a future time leaves `_drawWake` running around a stationary ship; needs a separate `departScheduledAt` and a status-flip gate. Stagger by `eventTime` ascending (queue drains oldest first), not by `berthIndex` (scatter).
> - **Berth assignment (§3.3):** `nextSequence % 24` reuses berths still occupied by departing ships during the ~57 s departure window; assign to first non-occupied berth instead.
> - **LOD threading (§8):** `density` cannot reach `_drawCommitPennant` through the current `draw → _drawShip` signature; cache it as `this._renderDensity` in `enumerateDrawables`.
> - **Validation (§12):** `reduceHarborTrafficState` is not exposed on `window`; Phase B's debug hook fixes this.
> - **Real-volume calibration:** measure first (Phase B's `_observePeakDensity`) before sizing the cap.
> - **Should-fix:** cache `_batchOrigin` per batch; clear `failedAt` on success transition; anchor failure-marker cap on `mountTime` not wall clock; consider per-project quotas; replace `+N` cluster tag with an "anchorage queue" of dimmed offshore ships; add alternating L/R label anchors and per-zoom truncation; revisit `RECENT_PUSH_REPLAY_MS = 120000`.
>
> Everything below is preserved as the original Phase A draft for reference.

---

Date: 2026-04-26
Owner: agent (handover-friendly)
Scope: `claudeville/src/presentation/character-mode/HarborTraffic.js`, with light, contained edits to `claudeville/src/config/scenery.js` for any berth coordinates that need new dock backing.

## 1. Goal

Scale the visible-pending-commit capacity of the harbor scene from the current ~8 ships (with a `+N` cluster overflow) up to a comfortable **20–24 ships** while preserving the established metaphor:

- One ship per pending commit, labeled with the commit message (or short SHA fallback).
- Ship leaves the harbor along a sea lane when the commit is pushed (success).
- Ship stays docked with a red X marker if the push failed.
- The lighthouse/Pharos and the dock geometry remain visually intact.
- Capacity gracefully tolerates the 0-commit case (empty harbor) and the 30+-commit case (cluster tag for the residual overflow).

## 2. Success Criteria

- A single agent producing 24 unpushed commits results in 24 distinct ship sprites with readable labels, no overlap that hides labels entirely, no z-order glitches.
- A push covering all 24 commits triggers an orderly, staggered departure — no two ships occupy the same screen pixel during the animation.
- For 30 commits, 24 are visible at piers; the remaining 6 surface as a `+6` cluster tag near the harbor mouth.
- For 0 commits, the harbor is empty (no debug ships, no leftover labels).
- A failed push of 24 commits keeps all 24 docked with a clear failure indicator without visually saturating the scene.
- Existing visual smoke (`npm run dev`, World mode camera at zooms 1/2/3) still renders the harbor cleanly.

## 3. Current State (verified)

Findings below are confirmed by direct file reads, not summary.

### 3.1 Capacity bottlenecks

| Symbol | File | Line | Current value | Effect |
| --- | --- | --- | --- | --- |
| `BERTHS` | `HarborTraffic.js` | 16–25 | 8 hardcoded `{tileX,tileY}` | Berth assignment uses `nextSequence % BERTHS.length`; the 9th docked ship reuses berth 0 → visual collision. |
| `MAX_VISIBLE_SHIPS` | `HarborTraffic.js` | 4 | 8 | `enumerateDrawables` slices candidates to the last 8; the rest collapse into a single `+N` cluster tag. |
| `SEA_LANES` | `HarborTraffic.js` | 27–60 | 4 paths | `laneIndex = stableHash(...) % SEA_LANES.length`. With ≥6 simultaneous departures lanes start carrying multiple ships in lockstep. |
| `MAX_LABEL_CHARS` | `HarborTraffic.js` | 12 | 30 | Label width caps at 142 px; at high density, neighboring labels overlap. |
| `_drawCommitPennant` | `HarborTraffic.js` | 893–916 | Single fixed pennant geometry (12 px tall, 44 px above ship) | No staggering; adjacent ships' labels collide. |
| `_drawClusterTag` | `HarborTraffic.js` | 985–1004 | Drawn at `BERTHS[(nextSequence + 1) % BERTHS.length]` | When `BERTHS` count grows the tag still anchors to a real berth and can collide with a docked ship's label. |

### 3.2 Geometry already supports more berths

`HARBOR_DOCK_TILES` in `scenery.js:92–142` covers a roughly L-shaped harbor:

```
y\x  29 30 31 32 33 34 35 36 37 38 39
14                           [Pharos footprint x:35-37, y:14-18]
15                                    .  .  D
16                                    .  .  D
17                                    .  D  D
18                                    .  .  D
19   D  D  D  D  D  D  D  D  D  D  D     <-- causeway (y=19)
20            D  D  D  D     D  D
21            D  D  D  D  D  D  D  D
22                        D  D  D  D
```

Dots `.` are tiles already in `HARBOR_DOCK_TILES`. The current 8 berths sit at tile-fraction positions on these tiles' water-side edges. The footprint comfortably hosts ~24 docked ship anchors **without adding any new dock tiles**, except for one optional westward extension (see §5).

### 3.3 Push → depart pipeline (must be preserved)

`reduceHarborTrafficState` in `HarborTraffic.js:380–523` already handles the pipeline cleanly:

- New `commit` events get a berth slot (`berthIndex = state.nextSequence % BERTHS.length`) and a deterministic lane.
- New `push` events flip matching docked ships to `status='departing'` (success) or annotate `pushStatus='failed'` (failure).
- Departure animation runs over `DEPARTURE_MS = 48 s`; ships fade and are deleted after `DEPARTURE_MS + FADE_DELAY_MS + EXIT_FADE_MS + EXIT_HOLD_MS`.

This logic is already capacity-agnostic. It only references `BERTHS.length` and `SEA_LANES.length` via modulo. **Increasing those array sizes is sufficient for the data path.** The visual layer is where the real work lives.

## 4. Design Decision

Pick **Option E: Dense Berth Grid + Adaptive Label LOD + Lane Spread** over alternatives.

### Considered alternatives (rejected)

- **A. Just bump `BERTHS` and `MAX_VISIBLE_SHIPS`.** Simple, but ships at adjacent positions stack labels into illegible mush at zoom 1.
- **B. Replace ship sprites with smaller variants when count is high.** Cleaner density, but violates the asset-first metaphor and would require new sprite generation.
- **C. Anchor overflow ships offshore as a queue.** Adds a new visual concept ("ships waiting to enter the harbor"). Strong metaphor, but more code surface and a new ship state — out of proportion for a capacity bump.
- **D. Hover-reveal labels.** Currently the harbor has no hit-testing for ships. Adding a hover/click layer is a larger feature.

### Why E

- **Keeps the data path untouched.** All the existing reducer/animation/state code already handles arbitrary berth/lane counts via modulo.
- **All visual changes localized to `HarborTraffic.js`.** Scenery touches are at most a few extra dock tiles.
- **Degrades gracefully.** When the harbor has 3 commits it looks identical to today. When it has 24, density is managed by a label LOD policy. When it has 30+, the existing `+N` cluster tag handles residual overflow with the existing rendering.
- **Reversible.** Constants and small helpers; no new modules, no manifest changes, no sprite regeneration.

## 5. Berth Layout Proposal

24 berth slots distributed across the existing dock footprint. Coordinates use the same tile-fraction convention as today (anchor floats slightly off-tile to sit on the water side of a dock plank).

Numbering matches `BERTHS` array order (index 0..23). Order is chosen so that `nextSequence % 24` distributes new commits across the harbor rather than filling one cluster first.

```
y\x  29 30 31 32 33 34 35 36 37 38 39

15                                 23   <- north tip, x=39 column
16                                 17   <- (existing)
17                            20    9   <- (x=37, x=39)
18         18 19              13        <- west causeway berths (NEW), (existing 37,18.2)
19   --- causeway (no berths) ---
20             4 14  6        15        <- inner pier north (NEW row)
21             0 12  3 21  5 22  7      <- inner pier south (current row, more spots)
22                       1 11  2 16     <- outer pier (NEW row)
```

Indices 8 and 10 absent above are the lighthouse-side north berths preserved from today (37,16.2) and the back of the eastern column. Final array order in code:

```js
const BERTHS = [
    // Inner pier south row (y≈21)
    { tileX: 33.2, tileY: 20.8 },   // 0  (existing)
    { tileX: 36.5, tileY: 21.9 },   // 1  NEW outer-row anchor
    { tileX: 38.2, tileY: 21.9 },   // 2
    { tileX: 36.4, tileY: 21.6 },   // 3  (existing)
    // Inner pier north row (y≈20.5) — NEW
    { tileX: 32.6, tileY: 20.5 },   // 4
    { tileX: 35.4, tileY: 20.5 },   // 5
    { tileX: 33.7, tileY: 20.4 },   // 6
    { tileX: 39.0, tileY: 22.4 },   // 7  outer south
    // Eastern column x=39 (preserved + filled)
    { tileX: 39.1, tileY: 17.5 },   // 8  (existing)
    { tileX: 39.1, tileY: 16.6 },   // 9  NEW (between existing 15.6 and 17.5)
    { tileX: 39.1, tileY: 15.6 },   // 10 (existing)
    { tileX: 39.0, tileY: 21.4 },   // 11 NEW
    // Inner pier south fillers
    { tileX: 34.5, tileY: 21.4 },   // 12 (existing)
    // Lighthouse-side west finger (NEW)
    { tileX: 30.6, tileY: 18.5 },   // 13
    { tileX: 34.8, tileY: 20.5 },   // 14
    { tileX: 36.0, tileY: 20.5 },   // 15 NEW north row
    { tileX: 37.5, tileY: 22.0 },   // 16
    { tileX: 37.2, tileY: 16.2 },   // 17 (existing)
    { tileX: 31.4, tileY: 18.5 },   // 18 NEW west causeway
    { tileX: 32.4, tileY: 18.5 },   // 19 NEW west causeway
    { tileX: 37.2, tileY: 17.4 },   // 20 NEW
    { tileX: 38.4, tileY: 21.5 },   // 21 (existing)
    { tileX: 37.6, tileY: 21.6 },   // 22 NEW
    { tileX: 39.1, tileY: 14.7 },   // 23 NEW north tip of eastern column
];
```

Sanity checks for this layout:

- Every berth coordinate falls within ±0.6 tiles of an existing `HARBOR_DOCK_TILES` entry, so the ship sprite reads as docked.
- The two "west causeway" berths (13, 18, 19) sit at `y=18.5` — north of the y=19 causeway, mirroring the convention used by the existing `37,18.2` berth.
- No berth coordinate overlaps the lighthouse footprint (`x∈[35,37], y∈[14,18]`).
- Adjacent berths in screen space differ by ≥0.7 tiles in one axis, giving the 64×64 ship sprite enough room before labels are considered.

### Optional scenery extension

Berths 13, 18, 19 sit just north of the existing causeway. They render fine on water (no dock tile under them is required for sprite display), but for visual coherence we may add a tiny dock spur — three EW dock tiles at `y=18.4` would suggest a moored row. **Default: skip the spur**; reconsider only if review shows the ships look untethered.

## 6. Sea Lane Spread

Add 2 more lanes (4 → 6). Six lanes mean a 24-ship batch sends an average of 4 ships per lane, staggered by berth-index — much less visually congested than 6.

New lanes (added to the existing four) follow waypoints that hug the eastern edge so they do not cross-paint over the lighthouse beam:

```js
SEA_LANES.push(
    [ // outer right curl
        { tileX: 39.0, tileY: 21.0 },
        { tileX: 39.6, tileY: 17.0 },
        { tileX: 39.4, tileY: 12.5 },
        { tileX: 38.8, tileY: 9.0 },
        { tileX: 38.6, tileY: 5.6 },
        { tileX: 38.4, tileY: 2.8 },
    ],
    [ // inner left curl
        { tileX: 33.0, tileY: 20.0 },
        { tileX: 35.0, tileY: 17.5 },
        { tileX: 36.4, tileY: 13.4 },
        { tileX: 37.0, tileY: 10.6 },
        { tileX: 37.6, tileY: 7.2 },
        { tileX: 37.8, tileY: 4.0 },
    ],
);
```

### Departure stagger

To keep batched departures readable, stagger `departStartedAt` by `ship.berthIndex` modulo 6:

```js
ship.departStartedAt = skipDepartureAnimation
    ? <existing skip math>
    : ship.departStartedAt || (now + (ship.berthIndex % 6) * 600);
```

A 600 ms × 0–5 = 0–3000 ms offset is well below the 48-second `DEPARTURE_MS`, so the overall push narrative still reads as "burst leaves in unison" while individual ships arrive at the harbor mouth at different beats.

## 7. Visibility Cap and Cluster Tag

```js
const MAX_VISIBLE_SHIPS = 24;       // was 8
```

`enumerateDrawables` already takes the *most recent* `MAX_VISIBLE_SHIPS`. With 30 commits, the 6 oldest are absorbed into the `+6` cluster tag.

Move the cluster anchor offshore so it does not collide with a docked ship's label. Replace:

```js
const berth = BERTHS[(this.state.nextSequence + 1) % BERTHS.length];
```

with a fixed offshore anchor (e.g. tile `(34.5, 22.7)`) for the cluster tag's world position. This keeps it in-frame and visually attached to the harbor without competing for a berth's air-space.

## 8. Label LOD (Level Of Detail)

Today every pennant draws at the same size with up to 30 chars. At 24 ships some labels overlap. Strategy:

- **Shipsize-aware truncation**: count `state.ships.size` once per render. If `≤ 12`, full label (current behavior). If `13–18`, cap label at 18 chars. If `> 18`, cap at 12 chars and use SHA-fallback rendering when the message would exceed.
- **Vertical staggering**: shift the pennant Y offset by `(berthIndex % 3) * 6` pixels at zoom-1. Three staggered "rows" of labels visually break up dense clusters; zoom 2/3 already separates labels enough that staggering is barely visible (and harmless).
- **Pennant box opacity** drops from 0.9 → 0.78 when more than 12 ships are docked, reducing background noise without losing readability.

Implementation point in `_drawCommitPennant`:

```js
_drawCommitPennant(ctx, ship, zoom, alpha = 1, density = 0) {
    const labelCap = density > 18 ? 12 : density > 12 ? 18 : MAX_LABEL_CHARS;
    const stagger  = (ship.berthIndex % 3) * 6;        // 0, 6, or 12 px
    const yOffset  = 44 + stagger;
    const panelAlpha = density > 12 ? 0.78 : 0.9;
    // ...rest as today, with shortenLabel(label, labelCap), y = ship.y - yOffset*s, fillStyle alpha = panelAlpha*alpha
}
```

`density` is computed once in `enumerateDrawables` (`const density = candidates.length`) and threaded through `draw → _drawShip → _drawCommitPennant`.

## 9. Failure Mode at Scale

Current behavior: failed push leaves every ship docked with a red X icon and a fading wave finale. With 24 failed commits, 24 simultaneous red Xs would saturate the scene.

Cap on visible failure markers:

- Show the red X only for ships whose `failedAt` is within the last 30 seconds (still managed by `failedAt` already set in the reducer).
- After 30 s the ship retains `pushStatus='failed'` and label colour, but `_drawFailedPushMark` skips the X icon.
- The screen summary banner (`drawScreenSummary`) is already singular per latest batch; no change needed.

This avoids the "harbor full of red Xs forever" failure mode without losing the "failed" status semantics.

## 10. Edge Cases

| Case | Plan |
| --- | --- |
| 0 commits | Nothing renders. `BERTHS` size is irrelevant; `enumerateDrawables` returns []. |
| 1 commit | Single ship at berth 0 (innermost south pier), full label, no LOD changes — visually identical to current behavior. |
| 8 commits (the old cap) | All visible, full labels, no staggering jolts (density ≤ 12 → labelCap untouched, stagger active but at low density nothing collides). |
| 24 commits, none pushed | Every berth filled, label LOD at "high density" tier. |
| 30 commits, none pushed | 24 ships visible + `+6` cluster tag offshore. |
| 24 commits → push success | Burst departure, staggered 0–3 s by berth. All ships drain over ~50 s. Cluster tag (if any) updates as ships leave. |
| 24 commits → push failed | All stay docked, red Xs visible for 30 s, then fade to label-only failure styling. |
| Camera zoom = 1 | LOD truncations and staggers active and useful. |
| Camera zoom = 3 | Labels widely spaced; staggering is invisible but harmless; no overlap to fix. |
| Mixed batch (push covering only 12 of 24 ships) | Reducer already filters by `project` and `eventTime ≤ pushTime`. Only matching ships depart; the other 12 keep their berths. |

## 11. Code Changes Summary

| File | Change | Risk |
| --- | --- | --- |
| `claudeville/src/presentation/character-mode/HarborTraffic.js` | `MAX_VISIBLE_SHIPS` → 24; `BERTHS` → 24 entries; `SEA_LANES` → 6 entries; departure stagger in reducer; LOD wiring in draw path; cluster anchor offshore; failure-marker time cap. | Low. Single file, no public API change, all referenced from the same module. |
| `claudeville/src/config/scenery.js` | **Optional** 3 EW dock tiles at `y=18.4` for west-causeway visual coherence. | Trivial. Only added if review indicates west-causeway berths look untethered. |

No changes to:

- `claudeville/adapters/gitEvents.js` — event normalization is already capacity-agnostic.
- `claudeville/src/config/buildings.js` — Pharos position untouched.
- `claudeville/assets/sprites/manifest.yaml` — same sprite, same dimensions.
- `claudeville/src/config/townPlan.js` — `harbor-berths` road already covers the berth area.

## 12. Validation Plan

1. `node --check claudeville/src/presentation/character-mode/HarborTraffic.js`
2. `npm run dev`, open `http://localhost:4000`, World mode, locate the harbor.
3. Visual inspection at zooms 1, 2, 3 with current real session data (whatever pending commits exist).
4. **Synthetic stress** — temporarily inject 24 fake commit events through the existing `reduceHarborTrafficState` from a console snippet:

   ```js
   const fake = Array.from({length: 24}, (_, i) => ({
       id: `fake-${i}`, type: 'commit', project: 'demo',
       sha: `deadbeef${i}`, timestamp: Date.now() + i,
       label: `commit message number ${i}`,
   }));
   // pass `fake` into a manual `reduceHarborTrafficState` call from a debug hook
   ```

   Verify: 24 ships visible, labels distinguishable, no z-fight with lighthouse, FPS stable.

5. **Synthetic push stress** — emit a `push` event for `project='demo'` and verify all 24 ships depart with visible stagger and ultimately disappear.

6. **30-commit overflow test** — synthetic 30 commits → 24 ships + `+6` cluster tag offshore.

7. **Failed push test** — synthetic push with `success: false` → 24 ships keep berths, red Xs visible briefly, then fade to label-only failure styling.

8. Sanity diff: confirm no behavior regression for low commit counts by replaying the scene with 1, 3, and 8 fake commits — visuals should match today's behaviour to the eye.

## 13. Out of Scope

- New ship sprite variants or palette shifts.
- Hover/click interaction on individual ships.
- Persisted per-project anchorage queues.
- Server-side or adapter changes.
- Replacing the `+N` cluster tag with a richer overflow visual (could be a follow-up).
- Refactoring `HarborTraffic.js` for testability — current single-file structure is fine for the scope.

## 14. Open Questions for Reviewers

1. Is 24 the right cap? Some pushes might routinely hit 30+ — should we plan for the cluster tag to handle that, or push the cap higher and accept tighter density?
2. Is staggering by `berthIndex % 3` and label truncation enough, or do we need a more aggressive policy (e.g., merging adjacent ships into a single "stack" sprite)?
3. The west causeway berths (13, 18, 19) sit just off the lighthouse causeway. Should we add the optional dock-tile spur for visual coherence, or trust the ship-on-water reading?
4. Is the 600 ms × index departure stagger noticeable without feeling laggy, or should we tune it (e.g., 300 ms × index)?
5. Should the failure-marker fade after 30 s be configurable, or is 30 s an acceptable hardcoded default?
