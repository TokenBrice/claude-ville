# Architecture, Layer Boundaries, Event-Bus Contracts — Reviewer #2

**Verdict:** approve-with-fixes
**Baseline HEAD:** `7b5a452` vs plan baseline `1f8baa0`
**Scope:** modified files under `claudeville/src/{domain,application,presentation,infrastructure}`

## Layer Findings

Direction flow is clean. No reverse-direction imports introduced.

| Layer | Verified | Notes |
| --- | --- | --- |
| `domain/` | `rg "^import.*from" claudeville/src/domain/` returns only imports from `../events/DomainEvent.js`, `../value-objects/*`, `../services/ToolIdentity.js`, and `../../config/i18n.js`. No upward imports. | `Agent.js` still depends on `../../config/i18n.js` (pre-existing — not in scope for this PR). |
| `application/` | Imports only from `../domain/` and `../config/`. `MonumentRules.js` correctly imports `BUILDING_DEFS` from `../config/buildings.js` and `eventBus` from `../domain/events/DomainEvent.js`. | OK. |
| `presentation/` | No new presentation→infrastructure imports. World/character-mode imports `eventBus` from `../../domain/events/DomainEvent.js` only. | OK. |
| `infrastructure/` | Only `WebSocketClient.js` touched; imports `eventBus` + `WS_RECONNECT_INTERVAL`. | OK. |

`RecipientResolver.js` is correctly placed in `domain/services/` — pure parsing helper with no imports, no DOM, no event-bus coupling, no presentation concerns. Domain placement is appropriate.

`RoleAccessory.js` in `presentation/shared/` is correctly scoped (consumed by `AgentSprite.js` via `../shared/RoleAccessory.js`, and re-exported by `ModelVisualIdentity.js` for backwards compatibility). Pure mapping from agent.role/agent.currentTool → accessory id. Could justifiably live in `domain/services/` since it has no presentation deps, but the precedent (`ModelVisualIdentity.js`) is in `presentation/shared/` and re-export keeps callers stable. Acceptable as-is.

`SeasonalAmbience.js` in `presentation/character-mode/` is correct — particle-system coupling and viewport sampling.

`__simfixture__/` is the only `__`-prefixed directory in the codebase. The convention is **novel** — no other `__test`, `__fixture`, `__mocks__` exists. App.js gates it on `?sim=1` (line 112-115). Directory name is self-documenting and the gating is explicit, so accept the new convention but **note for future**: a comment in `claudeville/CLAUDE.md` referencing `__simfixture__` as the dev-only directory naming convention would prevent future contributors from copying the pattern for production code by mistake.

## Event-Bus Audit

`DomainEvent.js` now carries a header comment listing 13 events (and exports a frozen `BUILDING_EVENTS` constant for 3 of them). The CLAUDE.md event-bus table covers 13 events but **lags significantly** behind reality.

Inventory of every event reachable on the bus (post-7b5a452):

| Event | Emit (file:line) | Subscribe (file:line) | In `DomainEvent.js` header? | In `CLAUDE.md` table? | Dispose? |
| --- | --- | --- | --- | --- | --- |
| `agent:added` | `domain/entities/World.js:13` | `AgentEventStream.js:211`, `RelationshipState.js:27`, `IsometricRenderer.js:1220`, `DashboardRenderer.js:70`, `NotificationService.js:40`, `Sidebar.js:67`, `TopBar.js:28` | yes | yes | mixed — IsometricRenderer/AgentEventStream/RelationshipState track unsub; Sidebar/TopBar/DashboardRenderer don't but are app-lifetime |
| `agent:updated` | `World.js:28` | `AgentEventStream.js:212`, `RelationshipState.js:31`, `IsometricRenderer.js:1237`, `DashboardRenderer.js:71`, `ActivityPanel.js:98`, `Sidebar.js:68`, `TopBar.js:29` | yes | yes | as above |
| `agent:removed` | `World.js:20` | `AgentEventStream.js:213`, `RelationshipState.js:40`, `IsometricRenderer.js:1228`, `DashboardRenderer.js:72`, `ActivityPanel.js:99`, `NotificationService.js:41`, `Sidebar.js:69`, `TopBar.js:30` | yes | yes | as above |
| `agent:selected` | `App.js:243`, `shared/AgentSelection.js:30`, `TrailRenderer.js:57`, `ActivityPanel.js:97` | App.js, ActivityPanel, TrailRenderer, DashboardRenderer | yes | yes | TrailRenderer, App track unsub |
| `agent:deselected` | `App.js:250`, `TrailRenderer.js:58` | App, ActivityPanel, TrailRenderer | yes | yes | as above |
| `building:selected` | `IsometricRenderer.js:2084` (via `BUILDING_EVENTS.SELECTED`) | `ActivityPanel.js:100` | yes | **no** — missing from CLAUDE.md table | constants frozen; subscribed once per panel lifetime |
| `building:deselected` | `IsometricRenderer.js:2086` | `ActivityPanel.js:101` | yes | **no** | as above |
| `building:active-agents` | `LandmarkActivity.js:480` (via `BUILDING_EVENTS.ACTIVE_AGENTS`) | `IsometricRenderer.js:1258`, `BuildingSprite.js:266` | yes | **no** | BuildingSprite has `eventBus.off` in `dispose()` (line 284); IsometricRenderer tracks via `_unsubscribers` |
| `building:read-intensity` | `LandmarkActivity.js:483` | `BuildingSprite.js:273` | **no** — not in header comment | **no** | BuildingSprite `eventBus.off` line 285 |
| `tool:invoked` | `AgentEventStream.js:250,319`, `LandmarkActivity.js:237` | `RitualConductor.js:295` | yes | **no** | RitualConductor `dispose()` line 299 |
| `tool:retried` | `AgentBehaviorState.js:150` | **NONE** (observer-only; `AgentSprite._drawRetryGlyph` reads `behavior.isRetryGlyphActive()` directly) | **no** | **no** | n/a |
| `subagent:dispatched` | `AgentEventStream.js:269` | `IsometricRenderer.js:1252` | yes | **no** | tracked |
| `subagent:completed` | `AgentEventStream.js:307` | `SkyRenderer.js:82` | yes | **no** | SkyRenderer `_unsubscribers` |
| `team:joined` | `AgentEventStream.js:277,293` | **NONE** | **no** | **no** | orphan emit |
| `team:gather` | `CouncilRing.js:139` | `VisitIntentManager.js:99` | **no** | **no** | VisitIntentManager `_eventUnsubscribers` (dispose line 171) |
| `chat:started` | `AgentEventStream.js:359` | **NONE** | **no** | **no** | orphan emit |
| `chat:ended` | `AgentEventStream.js:366,378` | **NONE** | **no** | **no** | orphan emit |
| `harbor:updated` | `WorldFrameRenderer.js:79` | `Sidebar.js:70` | **no** | **no** | Sidebar `eventBus.off` line 301 |
| `harbor:push-success` | **NONE** | `SkyRenderer.js:81` | **no** | **no** | orphan subscriber (relies on `git:pushed` as alternative) |
| `git:pushed` | **NONE** | `SkyRenderer.js:80` | **no** | **no** | orphan subscriber — see Required Fixes |
| `mode:changed` | `application/ModeManager.js:31` | DashboardRenderer, IsometricRenderer, NotificationService | yes | yes | tracked |
| `usage:updated` | `App.js:129`, `SessionWatcher.js:81`, `WebSocketClient.js:79,83` | App, TopBar, ActivityPanel, VisitIntentManager | yes | yes | tracked |
| `quota:throttled` | `App.js:275` | `VisitIntentManager.js:88` | **no** | **no** | tracked |
| `agent:throttle-tint` | `VisitIntentManager.js:449,458` | **NONE** | **no** | **no** | orphan emit |
| `chronicle:milestone` | `application/MonumentRules.js:280` (MonumentPlanter, optional injection) | `App.js:258` | **no** | **no** | App `_eventUnsubscribers` |
| `chronicle:milestone-banner` | `ChronicleMonuments.js:457` | **NONE** | **no** | **no** | orphan emit |
| `chronicle:aurora` | `App.js:265,279` | `App.js:284` | **no** | **no** | App tracks |
| `ws:connected` / `ws:disconnected` / `ws:init` / `ws:update` / `ws:message` | `WebSocketClient.js` | SessionWatcher, NotificationService | yes | yes | app-lifetime |

**Spelling consistency:** all `eventBus.emit`/`on` pairs match by string. No typos found. `BUILDING_EVENTS` constants are used in 4 of 5 places (`IsometricRenderer`, `BuildingSprite`, `ActivityPanel`); `LandmarkActivity` and `WorldFrameRenderer` use bare strings (`'building:active-agents'`, `'building:read-intensity'`, `'harbor:updated'`). Minor inconsistency — see Optional Improvements.

## New Module Placement

- `domain/services/RecipientResolver.js` — **correct.** Pure helper, no imports, no presentation/event coupling. Domain placement is justified because the recipient alias is a domain concept ("Agent X wants to message Agent Y by name"), and the parser has no rendering knowledge. Approve.
- `presentation/shared/RoleAccessory.js` — **correct.** Re-exported by `ModelVisualIdentity.js`, consumed only by AgentSprite. Could marginally fit in `domain/services/` (no DOM deps), but matching the precedent in `shared/` is reasonable.
- `presentation/character-mode/SeasonalAmbience.js` — **correct.** Particle-system coupling and atmosphere snapshot reader belong in character-mode.
- `presentation/character-mode/__simfixture__/AgentSimulator.js` — **novel convention, acceptable.** No other `__`-prefixed directory in `claudeville/src/`. App.js correctly gates it on `?sim=1`. Approve, but document the convention in `claudeville/CLAUDE.md` so future contributors don't replicate the pattern for production code.

## API Stability

New public methods on existing classes (all read as additive surface, no breaking signature changes to pre-existing methods):

| Class | New method | Signature style | Codebase precedent |
| --- | --- | --- | --- |
| `HarborTraffic` | `getActivePushSignal(now = Date.now())` | `get…` with optional `now` default | matches `LandmarkActivity.getArchiveReadIntensity()` (no-arg getter), pre-existing `HarborTraffic.getPendingRepoSummaries()` |
| `LandmarkActivity` | `getArchiveReadIntensity()` | bare getter | OK |
| `WeatherRenderer` | (sprite rain impact additions — internal methods only) | n/a | OK |
| `SkyRenderer` | reactive listeners (`git:pushed`, `harbor:push-success`, `subagent:completed`) attached in `_attachEventListeners` and torn down in `dispose()` line 908 | matches `AgentEventStream.dispose()` and `RitualConductor.dispose()` patterns | OK |
| `AgentBehaviorState` | `observeToolTransition({ agentId, tool, input, reason })`, `isRetryGlyphActive(windowMs = 6000)` | options-object input, optional `windowMs` default | matches surrounding `setRoute`/`arrive` options-object style |
| `AgentSprite` | many new state-derivers (retry glyph drawer, role accessory, etc.) — internal | n/a | OK |
| `Compositor` | `spriteFor(baseSpriteId, paletteKey, paletteVariant, runtimeAccessory, teamTrim = null)` | trailing optional param with default | **breaking-safe — backwards compatible.** No call site needs to change. |
| `AuroraGate` | `recordMilestone(monument, now)`, `handleUsageUpdate(usage, now)`, `evaluate(now, signals)`, `forceTrigger(reason, now)` | options-object, time-injection — testable | OK |
| `ChronicleStore` | `recordCommit(projectId, now)`, `getLifetimeCommitCount(projectId)`, `acquireCaptureLease(...)`, plus async store API | matches existing `put/get/queryRange/setMeta` async pattern | OK |
| `MonumentRules` | `classify`, `classifyMilestone`, `buildRecord`, static `foundingLayerReached`, static `applyDistrictCap`; new `MonumentPlanter` class | options-object constructor with `eventTarget = eventBus` default for testability | **good pattern** — explicit DI default mirrors `AuroraGate({ store })` style |
| `ChronicleMonuments` | `_spawnMilestone(tier, event, count, now)`, `_drawBanner`, `_drawFireworks`, `_collectPushEvents`, `_dropExpired`, `_dropExpiredOverlays` | internal `_…` helpers | OK |

All new APIs follow the codebase style: options-object inputs, optional trailing args with sane defaults, no `null`-padding required at call sites, async returns Promises when the underlying op is async (ChronicleStore), `dispose()`/`setEnabled()`/`setMotionScale()` lifecycle methods where applicable.

## Domain Entity Changes

`Agent.js` — **unchanged.** `git diff 1f8baa0..7b5a452 -- claudeville/src/domain/entities/Agent.js` returns no output. Architecture purity preserved.

`AgentStatus.js` — 3 new constants (`RATE_LIMITED='rate_limited'`, `ERRORED='errored'`, `WAITING_ON_USER='waiting_on_user'`). `KNOWN_STATUSES` Set is built via `Object.values(AgentStatus)` so the new values are accepted by `normalizeAgentStatus` automatically. No `switch` on status anywhere in the codebase — every consumer uses `if/else` chains, includes-tests, or table lookups.

`Appearance.js` — comment-only deprecation note added. No behavior change. Architecturally consistent (defers the field-removal cleanup with a clear pointer to the procedural-fallback callers in `AvatarCanvas.js`).

**New-status consumer gap (presentation):** several whitelists in shared rendering code silently downgrade the new statuses to a fallback bucket:

1. `presentation/shared/Formatters.js:30` — `statusClass()` returns `fallback` ('idle') for any status not in `[WORKING, IDLE, WAITING]`. **Result:** Sidebar dots and Dashboard cards apply `--idle` class to ERRORED/RATE_LIMITED/WAITING_ON_USER agents, masking the new statuses visually.
2. `presentation/shared/AgentPresentation.js:76-89` — `statusPresentation()` only translates `working/idle/waiting` keys (`statusWorking/statusIdle/statusWaiting`), only colors those three. New statuses receive `#8b8b9e` gray and a CamelCase fallback label like "Rate_limited".
3. `presentation/shared/AgentPresentation.js:56-63` — `sortAgentsByStatus` order table only has working/waiting/idle; new statuses sort to position 3 (after idle), so ERRORED agents sort below idle agents.
4. `presentation/dashboard-mode/DashboardRenderer.js:457` — detail-fetch priority bucket only includes `['working', 'waiting']`. ERRORED/RATE_LIMITED/WAITING_ON_USER agents not in `_visibleAgentIds` skip the active bucket. **Soft issue** — they still fall to the `visible` bucket if scrolled into view.

World-mode handles the new statuses correctly: `AgentSprite.js:3186-3188` maps RATE_LIMITED→`'rate_limited'`, ERRORED→`'errored'`, WAITING_ON_USER→`'waiting_on_user'` for emote selection. `CouncilRing.js:99` checks WAITING_ON_USER to block the council. So domain has rolled out everywhere it matters for the world canvas; **dashboard/sidebar UI is the gap.**

## Blockers

None.

## Required Fixes

1. **CLAUDE.md event-bus table is stale.** Add rows for every event used since `1f8baa0`: `building:selected`, `building:deselected`, `building:active-agents`, `building:read-intensity`, `tool:invoked`, `tool:retried`, `subagent:dispatched`, `subagent:completed`, `team:joined`, `team:gather`, `chat:started`, `chat:ended`, `harbor:updated`, `harbor:push-success`, `git:pushed`, `quota:throttled`, `agent:throttle-tint`, `chronicle:milestone`, `chronicle:milestone-banner`, `chronicle:aurora`. Required because the table is the canonical contract; new agents will assume the listed set is exhaustive.
2. **`DomainEvent.js` header comment is also stale.** Sync the listed events with the actual emitted set, or remove the inline list and reference CLAUDE.md as single source of truth.
3. **Resolve orphan emit-only events** (`team:joined`, `chat:started`, `chat:ended`, `agent:throttle-tint`, `chronicle:milestone-banner`). For each: either wire a subscriber (the intended behavior the emit implies) or annotate the emit site with a comment explaining the future consumer ("emitted for external observers; no subscriber yet"). Without annotation, future agents will treat them as dead code and remove the emits.
4. **Resolve orphan subscriber `git:pushed`** in `SkyRenderer.js:80`. No emit anywhere in the repo. Either:
   - Drop the listener (and `harbor:push-success` is sufficient), or
   - Emit `git:pushed` from the gitEvents adapter or HarborTraffic when a successful push lands. Currently the aurora-on-push effect only fires via `harbor:push-success`, which is itself unsourced — verify R3 (harbor reviewer) or R5 (server reviewer) plans to emit one of these.
5. **Cover new AgentStatus values in shared formatters/presentation.** Specifically:
   - `Formatters.statusClass` (line 30): add RATE_LIMITED/ERRORED/WAITING_ON_USER to the whitelist, or invert the test to `KNOWN_STATUSES.includes(normalized)`.
   - `AgentPresentation.statusPresentation` (lines 76-89): add `statusRateLimited`/`statusErrored`/`statusWaitingOnUser` to the key map, and add color entries (red/amber tones to match world-mode emote semantics).
   - `AgentPresentation.sortAgentsByStatus` (line 57): add entries so the new statuses sort meaningfully (e.g., ERRORED before WORKING, WAITING_ON_USER between WORKING and WAITING).
   - Optionally `DashboardRenderer._detailCandidates` (line 457) to include new statuses in the `active` bucket so error/throttled detail is fetched even for off-screen cards.

## Optional Improvements

1. **Use `BUILDING_EVENTS` constants consistently.** `LandmarkActivity.js:480,483` and `WorldFrameRenderer.js:79` use bare strings. Switch to `BUILDING_EVENTS.ACTIVE_AGENTS` and add a frozen export for `building:read-intensity` and `harbor:updated` if you want full coverage.
2. **Add a `__simfixture__` convention note to `claudeville/CLAUDE.md`** under the World Mode section, so future contributors know the dunder prefix marks dev-only fixtures and that App.js gates them on URL params.
3. **Consider centralizing AgentStatus → visual presentation** in a single table (key, label-i18n-key, color, sort-order, dashboard-bucket). Currently the same status is encoded in ~5 places (Formatters whitelist, AgentPresentation map, AgentPresentation order, AgentSprite emote table, DashboardRenderer bucket). One central table keeps future status additions to a single-file change.
4. **`MonumentPlanter` event injection** is a great pattern — consider extending it to `AuroraGate.handleUsageUpdate` (currently `App.js:270-280` emits `quota:throttled`/`chronicle:aurora` inline; moving emit responsibility into AuroraGate behind an injected eventTarget would make it testable in isolation).

## File / Line References

- `claudeville/src/domain/events/DomainEvent.js:1-15` — event header comment (stale)
- `claudeville/src/domain/services/RecipientResolver.js` — new, pure helper, correctly domain-placed
- `claudeville/src/domain/value-objects/AgentStatus.js:6-8` — three new constants
- `claudeville/src/domain/value-objects/Appearance.js:1-17` — deprecation comment, no behavior change
- `claudeville/src/application/MonumentRules.js:261-287` — `MonumentPlanter` w/ eventTarget DI default
- `claudeville/src/application/AuroraGate.js` — new class, time/store-injected, testable
- `claudeville/src/infrastructure/ChronicleStore.js` — IndexedDB wrapper, no event-bus coupling
- `claudeville/src/presentation/shared/RoleAccessory.js` — new, re-exported via `ModelVisualIdentity.js`
- `claudeville/src/presentation/shared/Formatters.js:30` — statusClass whitelist gap
- `claudeville/src/presentation/shared/AgentPresentation.js:56-89` — sort + presentation gap
- `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js:457` — detail bucket whitelist
- `claudeville/src/presentation/character-mode/SeasonalAmbience.js` — new, character-mode-correct
- `claudeville/src/presentation/character-mode/__simfixture__/AgentSimulator.js` — new dunder dir
- `claudeville/src/presentation/character-mode/AgentBehaviorState.js:150` — `tool:retried` emit, no bus subscriber (internal state listener via `isRetryGlyphActive()` is OK)
- `claudeville/src/presentation/character-mode/AgentEventStream.js:277,293,359,366,378` — `team:joined`, `chat:started`, `chat:ended` orphan emits
- `claudeville/src/presentation/character-mode/SkyRenderer.js:80` — orphan `git:pushed` subscriber
- `claudeville/src/presentation/character-mode/VisitIntentManager.js:449,458` — `agent:throttle-tint` orphan emit
- `claudeville/src/presentation/character-mode/ChronicleMonuments.js:457` — `chronicle:milestone-banner` orphan emit
- `claudeville/CLAUDE.md:282-294` — event-bus table (incomplete)

## Risk Severity

**Low.** No layer violations, no breaking API changes, domain entity purity preserved. The status-rendering gaps in `Formatters/AgentPresentation/DashboardRenderer` are real but isolated to the sidebar/dashboard surface (world canvas handles the new statuses). Orphan events are diagnostic rather than functional: subscribers using `harbor:push-success` will still trigger the aurora effect from the harbor codepath, and `git:pushed` is best treated as a future-emit hook with no current consumer. CLAUDE.md staleness is operational risk only — agents reading the table will under-allocate test coverage for emit/subscribe pairs they don't know exist.
