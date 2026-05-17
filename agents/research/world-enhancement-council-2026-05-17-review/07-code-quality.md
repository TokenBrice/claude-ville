# Reviewer 7 — Code Quality, Comment Discipline, Dead Code, Simplification

- HEAD: `7b5a452`
- Baseline: `1f8baa0`
- Scope: 33 commits, ~6,288 added lines across ~50 files
- Smoke: `node scripts/smoke/adapters.mjs` → PASS, `node scripts/smoke/relationship.mjs` → PASS

## Verdict

**ACCEPT WITH OPTIONAL CLEANUPS.** No release blockers. The work is functionally well-scoped, isolated, and verified by smoke fixtures. The principal debt is comment hygiene: ~62 task/phase-referential annotations leak the planning-doc structure into source — they read like Jira tickets, not code documentation, and conflict with the project policy in root `CLAUDE.md` ("no task/PR refs"). A small number of dead instrumentation fields, two truly dead lookups (`behavior.currentReservation` / `behavior.intent`), one feature gate, and a few WHAT-comments round out the list. None of these is load-bearing.

## Comment Discipline Violations

Sample of ~10 representative violations (the file holds 62 task/phase-referential comments and 167 narrative comments overall):

| # | File:line | Comment (verbatim, trimmed) | Why it violates |
| --- | --- | --- | --- |
| 1 | `claudeville/src/presentation/character-mode/AgentSprite.js:295` | `// Task 2.12: IDLE ambient destinations beyond 6 tiles also route via roads.` | Task ref; describes WHAT just below. |
| 2 | `AgentSprite.js:641` | `// route to AgentBehaviorState (30 s TTL); see WU-C task 2.5.` | Worker-unit ref; reader-hostile. |
| 3 | `AgentSprite.js:870` | `// Task 2.12: deliberate stride pause for IDLE strollers.` | Task ref + WHAT (stride pause). |
| 4 | `AgentSprite.js:943` | `// Task 2.7: prefer explicit facingPoint (allocator/reservation thread-through...` | Task ref. |
| 5 | `AgentSprite.js:969` | `// Defensive: WU-E populates building.facingPoint or visitTile.facingPoint.` | WU-letter ref + defensive label without explaining WHY. |
| 6 | `AgentSprite.js:1158` | `// 4.14: team-colored sash trim. teamTrim is null when the agent has no teamName...` | Phase-number ref ("4.14"). |
| 7 | `AgentSprite.js:1253` | `// 4.15: sparkle flash during the first 200 ms of the archive fade.` | Phase-number ref + WHAT. |
| 8 | `AgentSprite.js:3223` | `// Task 2.8: render small blueprint/compass glyph...` | Task ref + WHAT (function name already says it). |
| 9 | `AgentSprite.js:3246` | `// Pivot dot at right-angle vertex.` | Pure WHAT — code is `fillRect` next to a triangle path. |
| 10 | `AgentSprite.js:3269` | `// Arrowhead at the open end.` | Pure WHAT next to two `lineTo` calls. |
| 11 | `BuildingSprite.js:138` | `// Per Phase 1.6 plan; occupancy feeds window warmth via 0.45 + 0.55 * scalar.` | Phase ref + reciting the formula. |
| 12 | `BuildingSprite.js:144` | `// Phase 4.12 — Observatory clock spin while a WebFetch/WebSearch/web.run ritual is active...` | Phase ref. |
| 13 | `BuildingSprite.js:2544` | `// Phase 4.11 — Re-classify the ritual's source tool/input to recover the...` | Phase ref. |
| 14 | `LandmarkActivity.js:15` | `// Phase 4.10 — Archive shelf-fill keyed to local-search counter.` | Phase ref. |
| 15 | `IsometricRenderer.js:619` | `// Bridges (Task 5): two authored river crossings only.` | Task ref. |
| 16 | `IsometricRenderer.js:740` | `// Task 1.7: latest building presence tiers, refreshed via building:active-agents` | Task ref. |
| 17 | `IsometricRenderer.js:494` | `// Phase 4 WU-C: weather renderer needs the AssetManager so its...` | Phase + WU ref. |
| 18 | `RitualConductor.js:172` | `// Priority per Phase 2.3: synthetic dispatch payload (child*)...` | Phase ref. |
| 19 | `config/scenery.js:399` | `// Workshop district: Code Forge approach and Forge → Task Board handoff.` | Region label is fine; "Task Board" is a building name not a task ref (false positive — keep). |
| 20 | `config/theme.js:17` | `// Task 1.10 — phase-coupled water tint mix weights...` | Task ref. |
| 21 | `domain/events/DomainEvent.js:6` | `// building:selected, building:deselected     // emitted by IsometricRenderer click handler (Phase 0 Batch 2)` | Trailing "Phase 0 Batch 2" ref pollutes the event registry comment. |

No `// kept for compat`, no `// removed X`, no `// added for Y`, no `TODO`/`FIXME`/`HACK`/`XXX` markers anywhere in the diff. That part is clean.

WHAT-comment hotspot: `AgentSprite._drawPlanModeGlyph` / `_drawRetryGlyph` (lines ~3222-3279) — most narrative lines there describe the canvas calls that immediately follow.

## Dead Code & Reachability

1. **`AgentBehaviorState.errorBurst`** (`AgentSprite.js`'s `behavior.errorBurst`) — initialized to `0`, exposed via `snapshot()`, never written, never read. Pure dead field.
   - `claudeville/src/presentation/character-mode/AgentBehaviorState.js:46`
   - `claudeville/src/presentation/character-mode/AgentBehaviorState.js:186`

2. **`AgentBehaviorState.completedVisits` / `totalDwellMs` / `reroutes`** — incremented inside `finishVisit()` / `setRoute()`, but no caller reads them (only `snapshot()` packs them; no consumer pulls those keys). Dead instrumentation.
   - `claudeville/src/presentation/character-mode/AgentBehaviorState.js:35-37, 86-87, 178-180`

3. **`AgentSprite._inferFacingPoint` reads `this.behavior?.currentReservation` and `this.behavior?.intent`** — neither field is ever assigned on `AgentBehaviorState`. Two whole fall-through branches (`fromReservation`, `fromIntent`) can never fire today.
   - `claudeville/src/presentation/character-mode/AgentSprite.js:963-968`

4. **`MonumentRules.enableVerifiedStones` feature gate** — constructor option defaulted `false`, no caller ever passes `true`, so `_verifiedStone(event)` and the entire `type === 'test-summary'` branch are dead.
   - `claudeville/src/application/MonumentRules.js:111-113, 123-124, 159-168`

5. **`ENABLE_ERROR_HEURISTIC` const wired to `false`** (per brief: keep the const but flag deeper deadness): `ERROR_MESSAGE_PATTERN` is only referenced inside the dead `if`, so the regex is dead.
   - `claudeville/src/application/AgentManager.js:8, 14, 203-205`

6. **`ModelVisualIdentity.js` re-exports `runtimeRoleAccessory` from `RoleAccessory.js`** — every consumer either calls `runtimeRoleAccessory` from `../shared/RoleAccessory.js` directly (AgentSprite) or doesn't touch it at all. The re-export is a backward-compat alias with zero readers.
   - `claudeville/src/presentation/shared/ModelVisualIdentity.js:1`

No unused imports detected in the new code paths (sampled across AgentSprite, BuildingSprite, IsometricRenderer, HarborTraffic, server.js — all added imports are referenced).

## Over-Abstraction

1. **`RecipientResolver.js` (full module)** — pure helpers, 73 lines, with **one** caller (`IsometricRenderer.js:2149`). Three internal helpers (`tryJsonRecipient`, `tryFieldPattern`, `tryPlainAlias`) plus `stripQuotes` for a single-callsite parse. Could be inlined into IsometricRenderer (~25 lines) without losing clarity. Domain-services placement is aspirational rather than load-bearing.

2. **`MonumentRules` constructor option bag** — `{ enableVerifiedStones = false } = {}` is the *only* option, never set by callers (see Dead Code §4). If the feature gate is dropped, the constructor needs no args; if kept, a plain boolean param would be cheaper than an option bag.

3. **`ArrivalDeparture._drawWisp` option bag** — `{ fadeOut = false } = {}` is the only option, called three times (twice with default, once with `{ fadeOut: true }`). A plain positional boolean would be ~equivalent and one keystroke shorter. Borderline keep-as-is, but flag.

4. **`Appearance.js` doc-comment block** — 17-line JSDoc DEPRECATED preamble is a doc bomb explaining lifecycle for fields that *are not removed*. Once the dashboard fallback is retired this becomes a chore; today it's the right call (the file admits it in the doc itself). Leave as-is, but it is technically over-explanation.

5. **Defensive optional chaining on `this.behavior?`** in `AgentSprite.js` — `this.behavior` is assigned `new AgentBehaviorState()` unconditionally in the constructor (line 189). Every later `this.behavior?.x` is therefore guaranteed non-null. Six call sites use `?.` defensively:
   - `AgentSprite.js:691, 711, 963, 966, 3227, 3255`
   - The chain on the called *method* (`this.behavior?.isRetryGlyphActive?.()`) is double-defensive; both objects are guaranteed.

6. **Mirrored constants** (`HARBOR_FIREWORKS_TILE`, `INNER_QUAY_BASIN_TILE`) at `ChronicleMonuments.js:16-20`: comment explains they "mirror HarborTraffic.js constants" — that's a sync hazard a hand-rolled comment cannot enforce. Better to import or compute, or leave the comment but drop the rationale (the comment itself signals the smell).

## Backward-Compat Hacks

- `ModelVisualIdentity.js:1` — `export { runtimeRoleAccessory } from './RoleAccessory.js'` is a compat re-export; the actual consumer imports directly. Drop after verifying.
- No renamed-but-still-aliased fields detected on `Agent`/`Session` payloads; the WU work introduced new fields cleanly.

## Duplication

- Three `[motionScale === 0 ? hard-cut : ramp]` patterns in AgentSprite archive fade + sparkle + status-emote pulse share structure (`AgentSprite.js:1127-1200` cluster); they are short enough that DRYing them would not improve clarity. Leave.
- `_drawHourglassGlyph` / `_drawAlertCircleGlyph` / `_drawCheckGlyph` / `_drawQuestionGlyph` (~`AgentSprite.js:3282-3349`) share a `ctx.save/translate/scale/draw/restore` envelope. The shared envelope is already lifted into `_drawStatusEmote`. Fine.
- Server.js double-bail (`!signatureSkipped && signature === lastBroadcastSignature` then immediately `if (signatureSkipped)`) at `server.js:827-840` — two consecutive early-returns with identical bodies. Could collapse to one (`if (signatureSkipped || signature === lastBroadcastSignature)`), but the two-branch form makes the perf intent explicit. Borderline.

## Top Simplifications (≥5)

1. **Drop `behavior.errorBurst`** — three lines deleted, no behavior change.
   - `AgentBehaviorState.js:46, 186` and any callers (none).

2. **Drop `behavior.completedVisits`, `totalDwellMs`, `reroutes`** — instrumentation no consumer reads.
   - `AgentBehaviorState.js:35-37, 54-55, 86-87, 176-180`

3. **Drop `_inferFacingPoint`'s dead reservation/intent branches** — neither field is ever set on `AgentBehaviorState`. Removes 4 lines and one false-positive in the unused field surface.
   - `AgentSprite.js:963-968`

4. **Strip `MonumentRules.enableVerifiedStones`** (and `_verifiedStone`, and the `'test-summary'` branch in `classify`) OR explicitly land the verified-stone caller; today it is purely speculative.
   - `MonumentRules.js:111-113, 118 (test-summary), 123-124, 159-168`

5. **Drop the compat re-export** `export { runtimeRoleAccessory } from './RoleAccessory.js'` from `ModelVisualIdentity.js:1` after a quick grep of the consumer list (already done; only AgentSprite imports it, and it imports from RoleAccessory directly).

6. **Inline `RecipientResolver` into `IsometricRenderer.js`** (single-caller helper); or keep it but drop two of the three heuristic helpers — `tryPlainAlias` and `stripQuotes` could be one block.
   - `claudeville/src/domain/services/RecipientResolver.js` (whole file) + `IsometricRenderer.js:2149`

7. **Remove task/phase prefixes from new comments** — 62 instances, mechanical edit. Many of the comments would survive without the prefix; some lose their entire content (e.g., `// Task 2.12: deliberate stride pause for IDLE strollers.` → either drop or rewrite to explain WHY pause length is 6/12 frames).

8. **Drop defensive `this.behavior?.` chains in AgentSprite** — six sites. Replace with `this.behavior.` since the field is constructor-initialized.
   - `AgentSprite.js:691, 711, 963, 966, 3227, 3255`

9. **Collapse the `signatureSkipped` double-bail in `server.js`** to a single early-return; reduces a ~14-line block to ~6.
   - `claudeville/server.js:827-840`

## Smoke Status

- `node scripts/smoke/adapters.mjs` → **PASS** (fixture HOME `/tmp/cv-smoke-claude-XR8Otp`, 5/5 cases).
- `node scripts/smoke/relationship.mjs` → **PASS** (7/7 assertions, includes parent/child, team membership, membership-cache identity invariants).
- One harmless `MODULE_TYPELESS_PACKAGE_JSON` warning when loading `RelationshipState.js` as ESM (does not affect outcome; could be silenced with `"type": "module"` in package.json but that's outside review scope).

## Blockers

None.

## Required Fixes

None (no policy-violating commits, no broken syntax, smokes green).

## Optional Improvements (priority order)

1. Strip task/phase prefixes from new comments (~62 lines, mechanical).
2. Delete unread `AgentBehaviorState` instrumentation fields (`errorBurst`, `completedVisits`, `totalDwellMs`, `reroutes`).
3. Delete dead reservation/intent branches in `_inferFacingPoint`.
4. Either land the `enableVerifiedStones` caller or strip the feature gate end-to-end.
5. Drop the `runtimeRoleAccessory` re-export in `ModelVisualIdentity.js`.
6. Decide on `RecipientResolver`: keep as domain helper (then add a second caller or unit test) or inline.
7. Strip the WHAT comments around the procedural glyph draws (`AgentSprite.js:3222-3349`).
8. De-`?.` the `this.behavior` chains in AgentSprite.
9. Collapse the server.js double-bail block.

## Risk Severity

- **Low.** All optional. Smoke green; no public API or persisted-data surface affected.

## File / Line Index

- `claudeville/server.js:813-840` (double-bail), `:948-965` (`getRecentlyActiveDirs`), `:967-1017` (`_walkDirForSignature`)
- `claudeville/src/application/AgentManager.js:8, 14, 203-205` (`ENABLE_ERROR_HEURISTIC` dead)
- `claudeville/src/application/MonumentRules.js:111-113, 118, 123-124, 159-168, 261` (`enableVerifiedStones` dead)
- `claudeville/src/domain/services/RecipientResolver.js:1-73` (whole module, single caller)
- `claudeville/src/domain/events/DomainEvent.js:6` (event-name comment with task ref)
- `claudeville/src/domain/value-objects/Appearance.js:1-17` (long DEPRECATED preamble)
- `claudeville/src/presentation/shared/RoleAccessory.js:1-37` (single direct consumer in AgentSprite)
- `claudeville/src/presentation/shared/ModelVisualIdentity.js:1` (compat re-export)
- `claudeville/src/presentation/character-mode/AgentBehaviorState.js:35-37, 46, 86-87, 176-186` (dead fields)
- `claudeville/src/presentation/character-mode/AgentSprite.js:189, 295, 641, 691, 711, 819, 870, 943, 963-968, 969, 1007, 1027, 1127, 1158, 1246, 1253, 3223, 3246, 3253, 3269` (mix of `?.` defensive chains, task refs, WHAT comments, dead branches)
- `claudeville/src/presentation/character-mode/BuildingSprite.js:138, 144, 178, 267, 274, 345, 976, 1629, 1797, 2463, 2522, 2544, 2560, 2866` (phase refs)
- `claudeville/src/presentation/character-mode/IsometricRenderer.js:494, 499, 619, 727, 740, 1133, 1255, 1363, 1976, 2081, 2308, 2423, 2708, 3990, 4087, 1706` (phase + task refs, "Defensive fallback" without WHY)
- `claudeville/src/presentation/character-mode/LandmarkActivity.js:15, 110, 130, 481` (phase refs)
- `claudeville/src/presentation/character-mode/RitualConductor.js:172-173` (phase ref)
- `claudeville/src/presentation/character-mode/ChronicleMonuments.js:16-20` (mirrored-constants drift hazard)
- `claudeville/src/presentation/character-mode/SpriteRenderer.js:48` (`Per Phase 2.5.3:` phase ref — was pre-existing? check; included for completeness)
- `claudeville/src/config/theme.js:17` (task ref)

## Returned Summary (≤200 words)

The diff is functionally clean and smoke-green (adapters.mjs + relationship.mjs PASS), but it imports the planning-doc vocabulary into source: 62 `Task X.Y` / `Phase N.M` / `WU-letter` comments leak ticket structure into the code. Several otherwise-tracked fields (`AgentBehaviorState.errorBurst`, `completedVisits`, `totalDwellMs`, `reroutes`) are written but never read, and `_inferFacingPoint` reads two fields that are never set on `AgentBehaviorState`. `MonumentRules.enableVerifiedStones` is a feature gate with no caller. None blocks merge.

**Top 5 simplifications**:
1. Strip the ~62 task/phase prefixes from comments; rewrite the WHAT-glyph comments (AgentSprite.js:3222-3349) into pure-WHY or delete them.
2. Drop unread instrumentation fields in `AgentBehaviorState`.
3. Delete dead `behavior.currentReservation` / `behavior.intent` branches in `AgentSprite._inferFacingPoint` (lines 963-968) since neither field is ever assigned.
4. Strip `MonumentRules.enableVerifiedStones` (constructor + `_verifiedStone` + `test-summary` branch) — pure speculative config.
5. Drop the `runtimeRoleAccessory` compat re-export from `ModelVisualIdentity.js:1`; the only consumer already imports from `RoleAccessory.js` directly.
