# Plan Completeness Audit — Reviewer Output

Verdict: approve
Baseline HEAD: 7b5a452
Plan baseline: 1f8baa0 (33 commits)

## Coverage Table

| Task | Status | Commit | Evidence (file:line) | Notes |
| --- | --- | --- | --- | --- |
| 0.1 Asset boot resilience | DELIVERED | bc14bca | `claudeville/src/presentation/character-mode/AssetManager.js:83, 107, 132, 158, 189` | Per-cell `_loadImage` returns `{img, ok}`, falls back to placeholder canvas instead of throwing. |
| 0.2 SendMessage recipient resolver | DELIVERED | a3112b3 | `claudeville/src/domain/services/RecipientResolver.js:1-72`; `IsometricRenderer.js:44, 2149` | `extractRecipientName` imported and called inside `_updateChatMatching` (line 2118 method, 2149 call). |
| 0.3a pull/fetch in GIT_EVENT_TYPES | DELIVERED | e69b1cf | `claudeville/adapters/gitEvents.js:4` | `GIT_EVENT_TYPES = new Set(['commit','push','pull','fetch'])`; positionals parsed at 417, 431, 469. |
| 0.3b force flag detection | DELIVERED | e69b1cf | `claudeville/adapters/gitEvents.js:351-355, 468` | Sets `event.force = true \| 'lease' \| 'includes'`. |
| 0.3c stderr threading | DELIVERED | e69b1cf | `claudeville/adapters/claude.js:516-555`; `codex.js`; `gemini.js`; `GitEventIdentity.js` rejected status added | tool_result indexed and stderr threaded; normalizePushStatus returns 'rejected' on regex match. |
| 0.3d subagent payload enrichment | DELIVERED | e69b1cf | `claudeville/src/presentation/character-mode/AgentEventStream.js:27, 264-266` | `childAgentType`, `childAgentName`, `childSubagentType` added to `subagent:dispatched`. |
| 0.3e teamName population | DELIVERED | e69b1cf | adapter scope — claude.js prepass; smoke `scripts/smoke/adapters.mjs` asserts `teamName/agentName/agentType` on a team-member session | Verified by Phase 5.6 smoke fixture. |
| 0.4 Domain status expansion | DELIVERED | 4373d20 | `claudeville/src/domain/value-objects/AgentStatus.js:6-8`; `AgentManager.js:10-12, 26, 168-173` | `RATE_LIMITED`, `ERRORED`, `WAITING_ON_USER` added; `_resolveStatus` honours priority; `setUsageGetter` wired in App.js (commit f317f13). |
| 0.5 ToolIdentity classifier | DELIVERED | 0d9942a | `claudeville/src/domain/services/ToolIdentity.js:12-15, 30-33, 83-94, 286, 381-398` | EnterPlanMode/ExitPlanMode → taskboard; TaskList/MultiEdit/NotebookEdit/TeamCreate/apply_patch all in labels; Playwright/claude-in-chrome MCP and localhost:* portal routes present. |
| 0.6 Task→Portal ritual route | DELIVERED | a3112b3 | `claudeville/src/presentation/character-mode/RitualConductor.js:162-198, 211-237`; `IsometricRenderer.js` subagent:dispatched → synthetic tool:invoked; `LandmarkActivity.js:85-89` SUMMON suppression | Early `tool === 'Task' \|\| tool === 'Agent'` branch routes to `RITUAL_META.portal`. |
| 0.7 Per-building active-agent map | DELIVERED | 749786b | `claudeville/src/presentation/character-mode/LandmarkActivity.js`; `DomainEvent.js:11-14` BUILDING_EVENTS.ACTIVE_AGENTS | 60s recency map + 500ms emission cadence per plan. |
| 0.8 building:selected event | DELIVERED | a3112b3 / 749786b | `claudeville/src/domain/events/DomainEvent.js:11-14`; `IsometricRenderer.js` click handler emits both | Contract published in 749786b, renderer wiring in a3112b3. |
| 0.9 RelationshipState cache | DELIVERED | 323c25b | `claudeville/src/presentation/character-mode/RelationshipState.js:22-37, 73-75` | `_membershipDirty` flag toggled on agent:added/removed/updated only when parent/team actually changes; `if (this._membershipDirty) this._rebuildMembership()` gates rebuild. |
| 0.10 LandmarkActivity O(1) trim | DELIVERED | 749786b | `claudeville/src/presentation/character-mode/LandmarkActivity.js:403-416` | `_capKind` now per-type `Map<type, string[]>` with `.shift()` semantics. |
| 0.11 Path-aware truncate | DELIVERED | 0d9942a | `claudeville/src/domain/services/ToolIdentity.js:213+ compactToolInput` | Boundary-preferring snap at `/`, `.`, ` `, `:`; first-token preference for Bash/exec_command class. |
| 0.12 HarborTraffic debug gating | DELIVERED | 323c25b | `claudeville/src/presentation/character-mode/HarborTraffic.js:1800` `localStorage.claudeVilleDebug === '1'`; departStartedAt nulled at 1649/1682/1706/1719 | `window.__harbor` + `_observePeakDensity` console.info both gated. |
| 0.13 Boot-time asset miss summary | DELIVERED | bc14bca | `claudeville/src/presentation/character-mode/AssetManager.js:25-188` | Per-image warns replaced by `[AssetManager] missing N assets: [...]` summary after `load()` resolves. |
| 1.1 Baked head accessories | DELIVERED | 985a1eb | `claudeville/src/presentation/shared/RoleAccessory.js:22 runtimeRoleAccessory`; `ModelVisualIdentity.js:1` re-export | Falls back to role-derived accessory when no effort overlay applies. |
| 1.2 Compact name pill glyphs | DELIVERED | 985a1eb | `claudeville/src/presentation/character-mode/AgentSprite.js` (3 glyph stack in `_drawCompactNameStatus`) | Provider/tier/repo glyphs at 6 px left of text. |
| 1.3 Status emote glyph stack | DELIVERED | 985a1eb | `claudeville/src/presentation/character-mode/AgentSprite.js` `_drawStatusEmote` | Procedural 12 px glyphs (no new PNGs needed); covers RATE_LIMITED/ERRORED/WAITING_ON_USER/COMPLETED/thinking. |
| 1.4 Posture stance modifiers | DELIVERED | 985a1eb | `claudeville/src/presentation/character-mode/AgentSprite.js` `_drawStanceOverlay` | Procedural variant (chevrons/hand-wave/tick) over baked sprites; plan permits PNG-or-procedural and explicitly defers full sheet regen. |
| 1.5 Token-burn aura | DELIVERED | 985a1eb | `claudeville/src/presentation/character-mode/AgentSprite.js:1503` | `0.6 + log10(max(1, totalTokens))/6` clamped 0.6–1.4 — matches plan formula. |
| 1.6 Building presence pulse + windows | DELIVERED | 051657a | `claudeville/src/presentation/character-mode/BuildingSprite.js:266-1188` | `eventBus.on(BUILDING_EVENTS.ACTIVE_AGENTS, this._onPresence)`; tier multipliers applied to emitters, lights, windowWarmth. |
| 1.7 Smoke plumes for Forge/Mine | DELIVERED | f476bf0 | `claudeville/src/presentation/character-mode/IsometricRenderer.js` (Forge anchor 28,27; Mine 12,32) | `gatedBy: 'building.activeAgents'`; reduced-motion static fallback. |
| 1.8 State-aware label accents | DELIVERED | 051657a | `claudeville/src/presentation/character-mode/BuildingSprite.js` `drawLabels` brighten + leading dot; Watchtower failed swap | HSL brighten via `brightenHex`. |
| 1.9 Scenery prop placement PR | DELIVERED | ccbf450 | `claudeville/src/config/scenery.js:400-412` | 10 prop placements: workshop (400-402), civic promenade (404-406), gate (408-409), arcane corridor (411-412). |
| 1.10 Phase-coupled water palette | DELIVERED | f476bf0 | `claudeville/src/presentation/character-mode/IsometricRenderer.js` `_drawPhaseWaterTint`; `theme.js:waterTint` | Blends horizon/zenith weighted by warmGlint/nightReflection; early-return at noon. |
| 1.11 Crepuscular rays (godrays) | DELIVERED | 57d867f | `claudeville/src/presentation/character-mode/SkyRenderer.js:109, 168, 444` | `_drawGodrays` called from `draw()` (line 109) AND `drawCanopy()` (line 168, alphaMul 0.4). |
| 1.12 History dedup ×N | DELIVERED | 985a1eb | `claudeville/src/presentation/character-mode/AgentSprite.js` `_activityThread` | Same-category collapse with `<label> ×N` rendering. |
| 1.13 Idle bob + long-wait clock | DELIVERED | 985a1eb | `claudeville/src/presentation/character-mode/AgentSprite.js` IDLE bob 0.4× cadence; clock chevron after `activityAgeMs > 60_000` | Both deltas live in the same commit. |
| 2.1 Subagents spawn at Portal | DELIVERED | 94762c9 | `claudeville/src/presentation/character-mode/IsometricRenderer.js:91 PORTAL_SPAWN_TILE = {7,32}`; `_beginAgentGateArrival` consumes at 1919-1920 with `_gateJitter` | Branches on parentSessionId/parentId/parentAgentId. |
| 2.2 Dispatch wisp from Portal | DELIVERED | 94762c9 | `claudeville/src/presentation/character-mode/ArrivalDeparture.js:136-150 beginSubagentDispatch` accepts `portalScreenPoint` | Renderer passes the screen point for the obelisk tile. |
| 2.3 Portal label honors subagent_type | DELIVERED | 94762c9 | `claudeville/src/presentation/character-mode/RitualConductor.js:179, 187-194` | `childAgentName → childSubagentType → classified.label → parsedInput.subagent_type` chain. |
| 2.4 Persistent parent→child tether | DELIVERED | b11eb04 | `claudeville/src/presentation/character-mode/CouncilRing.js:204 drawFamilyTethers`; `WorldFrameRenderer.js` wiring | Dashed quadratic curves, alpha 0.18-0.28, motion-budget aware. |
| 2.5 Family plaza preference | DELIVERED | b11eb04, 55223e3 | `CouncilRing.js:50 applyTeamPlazaPreferences` second pass at 76-77; `AgentBehaviorState.js:setFamilyPlazaPreference`; `AgentSprite` proxy | Family pass guarded by `typeof === 'function'`. |
| 2.6 Orphan subagent returns through Portal | DELIVERED | 94762c9 | `claudeville/src/presentation/character-mode/ArrivalDeparture.js:203 recordOrphanReturn`; `IsometricRenderer._beginRelationshipDeparture` routes through it | 1.2s fading wisp to PORTAL_SPAWN_TILE. |
| 2.7 facingPoint per visit tile | DELIVERED | 21144bd, 55223e3, f317f13 | `claudeville/src/config/buildings.js` (66 `facingPoint` entries); `AgentSprite._faceBuilding` chain; `VisitTileAllocator` threads it | 66 matches plan's "66 facingPoint fields" count exactly. |
| 2.8 Plan-mode visible behavior | DELIVERED | 55223e3 | `claudeville/src/presentation/character-mode/AgentSprite.js:3222 _drawPlanModeGlyph`; `AgentBehaviorState.observeToolTransition` tracks plan-mode-enter/exit | Reads classifier reasons from 0.5. |
| 2.9 Token cash-out walk to Mine | DELIVERED | f317f13 | `claudeville/src/presentation/character-mode/VisitIntentManager.js:250-252` `reason: 'cash-out'` priority 95 | Token delta ≥ 1024 triggers one-shot intent toward Mine. |
| 2.10 Rate-limit throttle desaturation | DELIVERED | f317f13 | `claudeville/src/presentation/character-mode/VisitIntentManager.js:88` quota:throttled subscription; agent:throttle-tint emit; `App.js:107 setUsageGetter` | Low-priority quota intent + tint event for sprite desaturation. |
| 2.11 Tool retry detection | DELIVERED | 55223e3 | `claudeville/src/presentation/character-mode/AgentBehaviorState.js:observeToolTransition` retry detector; `AgentSprite._drawRetryGlyph` (line 3252) | 20s window, yellow ↻ for 6s. |
| 2.12 Idle stroll gait + road routing | DELIVERED | 55223e3 | `claudeville/src/presentation/character-mode/AgentSprite.js:820 _advanceIdleStopAndLook` (line 1026); `_pickTarget` extended at 299 to IDLE with getRoadTiles | 18-30s stop-and-look loop. |
| 2.13 Council ring gathering | DELIVERED | b11eb04, f317f13 | `CouncilRing.js:86 applyTeamGatherChoreography`; `VisitIntentManager.js:99` team:gather subscription | 12-tile radius, 5-minute team cooldown, priority 70 sticky 30s. |
| 3.1 Force-push as sinking | DELIVERED | 79bc35e | `claudeville/src/presentation/character-mode/HarborTraffic.js:32 FORCE_DEPARTURE_MS=12000`; `_drawFinaleEffect` forceSink branch; 3330 force-with-lease yellow chevron | Parser sets `event.force` (gitEvents.js:468); HarborTraffic renders sink with whirlpool. |
| 3.2 Pull/fetch as inbound ships | DELIVERED | 79bc35e | `claudeville/src/presentation/character-mode/HarborTraffic.js:1445-1488` (arrival reducer); 2887-2934 (draw) | Inbound `'arriving'` status added; pull docks, fetch anchors. |
| 3.3 Rejected vs failed push | DELIVERED | 79bc35e | `claudeville/src/presentation/character-mode/HarborTraffic.js:266 shortLabel rejected`; 1654, 1697-1703 boomerang lifecycle | `PUSH_STATUS_STYLE.rejected` + reject-outbound/inbound split (16s/12s). |
| 3.4 Functional lighthouse | DELIVERED | 16c6cf8 | `claudeville/src/presentation/character-mode/IsometricRenderer.js:6661-6663 _drawLighthouseBeam` calls `this.harborTraffic.getActivePushSignal()` | All five states (idle/departing/failed/rejected/untethered/pulsing) implemented; defensive optional-chain. |
| 3.5 Push lifecycle phases | DELIVERED | 79bc35e | `HarborTraffic.js:1349, 1687 cast-off`; 2785-2793 `'casting-off'` phase; 3049 secondary pennon; 3377 sea-mist fade | Pack-size scaled DEPARTURE_MS + stutter-step + fade. |
| 3.6 Edge cases | DELIVERED | 79bc35e | `HarborTraffic.js:1132 amendCount`; 1135-1140 detached HEAD; 2037-2054 hasUpstream; 2258 broken-rope; 3056 untethered chevron | All three (no remote, detached HEAD, amend) handled. |
| 3.7 Lagoon channel buoy | DELIVERED | 79bc35e | `HarborTraffic.js` `prop.harborBeaconBuoy` at (26,6) pulses in repo accent during `_observeStorageTransfers` | Implemented per plan; tooltip hint included. |
| 4.1 Aurora on push at night | DELIVERED | 3bedfab | `claudeville/src/presentation/character-mode/SkyRenderer.js:80-81 git:pushed + harbor:push-success subscriptions`; `maybeTriggerAuroraForPushSuccess` (line 116) gates phase==='night' + 5-min cooldown | `triggerAurora` now wired. |
| 4.2 Tag/release fireworks | DELIVERED | 9064c5c | `claudeville/src/presentation/character-mode/ChronicleMonuments.js:380 harbor:release-burst`; 170, 189 fireworks ring overlay | Three concentric rings staggered 100ms over 5s; pool cap 8. |
| 4.3 Milestone banners | DELIVERED | 9064c5c | `claudeville/src/infrastructure/ChronicleStore.js:245 recordCommit, 255 getLifetimeCommitCount`; `MonumentRules.js:27 MILESTONE_TIERS`; `ChronicleMonuments.js:443-450 auroraGate.forceTrigger`; `AuroraGate.js:66, 81 forceTrigger` | All four tiers (maiden/ribbon/flagship/aurora at 1/10/100/1000). |
| 4.4 Shooting star on task completion | DELIVERED | 3bedfab | `SkyRenderer.js:82-87 subagent:completed → triggerShootingStar`; 129 method | Pool capped at 3 + 4s flood cooldown; night-gated. |
| 4.5 Sprite rain impacts | DELIVERED | e83d595, a580c10 | `claudeville/src/presentation/character-mode/WeatherRenderer.js:20 RAIN_SPLASH_SPRITE_ID`; 46 setAssets; 306 maybeStampWaterRipple; IsometricRenderer.js wires via `_drawWeatherWaterRipples` | Static fallback present. |
| 4.6 Seasonal ambient particles | DELIVERED | e83d595, a580c10 | `claudeville/src/presentation/character-mode/SeasonalAmbience.js:1-213`; IsometricRenderer construction + frame update + dispose | Month → preset mapping per plan. |
| 4.7 Lighthouse fog/storm | DELIVERED | a580c10 | `claudeville/src/presentation/character-mode/IsometricRenderer.js` `_drawLighthouseBeam` widening + cone block | Multiplies alpha by `1 + intensity*0.6`; volumetric cone in screen-composite. |
| 4.8 Foliage sway | DELIVERED | a580c10 | `claudeville/src/presentation/character-mode/IsometricRenderer.js:671-702 _windSwaySeed + _withTreeSway`; 3789, 3802 helper | ±2 px clamp; boulders/crates skipped; reduced-motion zeroes offset. |
| 4.9 Building-detail panel | DELIVERED | 5e46272 | `claudeville/src/presentation/shared/ActivityPanel.js` (showBuilding + occupants + status rows) | Building mode polls 5s; emits agent:deselected on switch; consumes building:selected. |
| 4.10 Archive shelf-fill | DELIVERED | d50c49b | `claudeville/src/presentation/character-mode/LandmarkActivity.js getArchiveReadIntensity`; `BuildingSprite.js:1378 _drawArchiveEnhancement`; 1790 helper | 120s half-life decay; `building:read-intensity` event. |
| 4.11 Portal two-step | DELIVERED | d50c49b | `claudeville/src/presentation/character-mode/BuildingSprite.js:2473-2553 _drawPortalRitual portal-preview/portal-active branches` | Cool blue inner ring (preview) vs full stack + floating 16×12 screen (active). |
| 4.12 Observatory clock rotation | DELIVERED | d50c49b | `claudeville/src/presentation/character-mode/BuildingSprite.js:275, 350-360 _observatoryClockSpin`; 1632 draw applies spin | Eases back to 0 over 1.5s when WebFetch/WebSearch/web.run ends. |
| 4.13 Watchtower lookout sweep | DELIVERED | a580c10 | `claudeville/src/presentation/character-mode/IsometricRenderer.js:164 gull orbit anchor (28,12)`; 2800, 2877 `_buildWatchtowerBeaconBuoySprites` | 30s loop; 2 buoys on sea line. |
| 4.14 Team-colored sash trim | DELIVERED | 1a6d986 | `claudeville/src/presentation/character-mode/Compositor.js:16, 23-24 teamHash in cache key`; 44-52 `_applyPaletteSwap` second pass; AgentSprite threads teamTrim/teamHash | Cache key segment `${runtimeAccessory ?? '_'}|${teamHash}` confirms. |
| 4.15 Archive fade on agent removal | DELIVERED | a580c10, 1a6d986 | Renderer side: `IsometricRenderer.js:1981 sprite._archiveAnim` + 1997 `_pruneArchiveFadedSprites`; Sprite side: AgentSprite.draw computes `_archiveFadeProgress` + sparkle + FINAL bubble | Split across two commits per plan's batch structure. |
| 4.16 Chronicle stone weight tiers | DELIVERED | 9064c5c | `ChronicleMonuments.js:212 tooltipFor`; three weight variants (minor cairn/medium/major obelisk with glow gem) | Multi-line tooltip with flag + label + age + kind. |
| 4.17 Repo heraldry shields | DELIVERED | 1a6d986 | `claudeville/src/presentation/character-mode/HarborTraffic.js _drawRepoShield + _drawSquadBunting` | Procedural 18×24 chevron with shortName + bunting between adjacent same-squad ships. |
| 5.1 Split IsometricRenderer.js | DEFERRED | — | n/a | Explicit deferral per task brief; monolith remains. |
| 5.2 Scoped watch-fallback | DELIVERED | 76d3874 | `claudeville/server.js` `getWatchFallbackSignature` split into `_walkDirForSignature` with per-dir 10s cache + recentlyActiveDirs gating | Skip subdirs no mtime in 5min; 5s memo on session list. |
| 5.3 WebSocket reconnect jitter | DELIVERED | 76d3874 | `claudeville/src/infrastructure/WebSocketClient.js` `_scheduleReconnect` cap 15s + 0-500ms jitter; reset on first init | Per plan. |
| 5.4 Cache-stamp gate on broadcast | DELIVERED | 76d3874 | `claudeville/server.js` cacheStampCounter; `broadcastUpdate` heartbeat-only skip; `/api/perf` surface | Skips SHA when stamps match. |
| 5.5 Memoise buildDockSquadLayout | DELIVERED | 8d369cb | `claudeville/src/presentation/character-mode/HarborTraffic.js:722 memo comment + 748-770 wrapper + _buildDockSquadLayoutFresh` | LRU 32 entries; keyed on docked shipId:pushStatus:eventTime tuple. Also raised GIT_STATUS_CACHE_TTL_MS 5000→30000. |
| 5.6 Smoke scripts | DELIVERED | 67f99eb | `scripts/smoke/adapters.mjs`, `scripts/smoke/relationship.mjs`, `scripts/smoke/README.md` | Zero new deps; uses node built-ins only; 5/5 + 7/7 PASS. |
| 5.7 Behavior simulation fixture | DELIVERED | 81f202f | `claudeville/src/presentation/character-mode/__simfixture__/AgentSimulator.js:1-356`; `App.js:113 const simMode = new URLSearchParams(location.search).get('sim') === '1'`; 121, 134 gates skip loadInitialData/SessionWatcher | Confirmed `?sim=1` conditional. |
| 5.8 PixelLab regen idle pose rows | DEFERRED | — | n/a | Plan/task brief explicit deferral; credit-heavy. |
| 5.9 Document polling cadence | DELIVERED | fa286bf | `claudeville/CLAUDE.md` § Polling and Cache Cadence | Full table + invariant added per task. |
| 5.10 PR open/merge/close | DEFERRED | — | n/a | Explicit deferral per task brief; needs `gh` parser. |
| 5.11 Cancelled push status | DELIVERED | 8d369cb | `claudeville/src/presentation/shared/GitEventIdentity.js` cancelled/canceled/timed_out/timeout regex; `HarborTraffic.js` PUSH_STATUS_STYLE.cancelled + cancelling transient + finale | Soft grey expanding ring distinct from failed X. |
| 5.12 Appearance cleanup spike | PARTIAL/DEFERRED | 7b5a452 | `claudeville/src/domain/value-objects/Appearance.js:4-16` deprecation header | Task brief explicitly reduces 5.12 to deprecation-comment only; field removal deferred — acceptable. |
| 5.13 Optional new prop sprites | DEFERRED | — | n/a | Plan made conditional on 4.10/4.11 art justification; explicit deferral. |

## Blockers

None.

## Required Fixes

None. The plan calls for all Phase 0-4 work plus most of Phase 5; the explicit deferrals (5.1, 5.8, 5.10, 5.13 and the 5.12 narrowing) are documented up front. Every spot-check passed against the live source.

## Optional Improvements

1. `agents/research/world-enhancement-council-2026-05-17-review/` already contains `05-adapter-server.md` and `visual-insitu/`. If this review will continue across multiple sessions, surface the per-task SHAs in `agents/README.md` so future stale-plan checks have a clear pointer.
2. The plan's Phase 5.12 narrowing (header only) leaves SKIN_COLORS/HAIR_COLORS/EYE_COLORS/SHIRT_COLORS tables in `Appearance.js:40-46` live. Recommend a follow-up issue once `AvatarCanvas` procedural fallback is provably unreachable.
3. 1.4 posture stance landed as procedural overlays rather than baked overlay PNGs. The plan permits this (and explicitly defers PixelLab regen to 5.8), but a single-line note in the plan footer that "1.4 shipped procedurally; baked overlays still available if 5.8 funds them" would help future readers reconcile the gap.

## Deferrals confirmed

- 5.1 IsometricRenderer split — confirmed not undertaken.
- 5.8 PixelLab idle pose regen — confirmed not undertaken.
- 5.10 PR ceremony — confirmed not undertaken.
- 5.13 Optional new prop sprites (mineRailSegment, portalPreviewScreen) — confirmed not added to manifest.
- 5.12 reduced to deprecation header — confirmed, with the four-color tables and per-agent visual fields still live.

## Risk Severity Summary

- High severity: none observed.
- Medium severity: none observed.
- Low severity: 1.4 procedural-vs-baked execution choice is a minor scope interpretation, not a defect.

## Plan-mapped quick stats

- 60 plan tasks audited (0.1–0.13, 1.1–1.13, 2.1–2.13, 3.1–3.7, 4.1–4.17, 5.1–5.13).
- DELIVERED: 55.
- DEFERRED (with explicit justification): 4 (5.1, 5.8, 5.10, 5.13).
- PARTIAL/narrowed by task brief: 1 (5.12).
- MISSING: 0.

## Spot-check confirmations (load-bearing)

- 0.2 chat resolver: `extractRecipientName` import at `IsometricRenderer.js:44`, call at `:2149` inside `_updateChatMatching`. CONFIRMED.
- 0.5 ToolIdentity: EnterPlanMode/ExitPlanMode in `DIRECT_TOOL_CLASSIFICATIONS` (lines 32-33); TaskList (30); MultiEdit (12); apply_patch (14-15); functions.apply_patch (15). CONFIRMED.
- 0.6 Task→Portal: `RitualConductor.ritualMetaFor` early branch `tool === 'Task' || tool === 'Agent'` at line 171, routes to `RITUAL_META.portal` (line 187-188). CONFIRMED.
- 0.9 RelationshipState cache: `_membershipDirty` flag (line 22), set to true on dirty paths only (29, 32-37, 57), gated `if (this._membershipDirty)` at line 73 around `_rebuildMembership()`. CONFIRMED.
- 1.6 building presence pulse: `BuildingSprite.js:266 eventBus.on(BUILDING_EVENTS.ACTIVE_AGENTS, this._onPresence)`. CONFIRMED.
- 1.9 scenery PR: workshop 3 props (400-402), civic 3 props (404-406), gate 2 props (408-409), arcane 2 props (411-412); plan called for 10, delivered 10. CONFIRMED.
- 1.11 godrays: `_drawGodrays` defined at SkyRenderer.js:444, called from `draw()` at line 109 and `drawCanopy()` at line 168. CONFIRMED both call sites.
- 2.1 portal spawn tile: `PORTAL_SPAWN_TILE = Object.freeze({tileX:7, tileY:32})` at IsometricRenderer.js:91; consumed by `_beginAgentGateArrival` at 1919-1920. CONFIRMED.
- 2.7 facingPoint: `grep -c facingPoint buildings.js` returns 66, exactly matching plan's stated count. CONFIRMED.
- 3.1 force-push: gitEvents.js sets `event.force` at line 468; HarborTraffic.js renders sink with `FORCE_DEPARTURE_MS` (line 32) and forceSink finale block. CONFIRMED both.
- 3.2 pull/fetch: gitEvents.js `GIT_EVENT_TYPES` includes pull/fetch (line 4); HarborTraffic.js spawns inbound 'arriving' ships at line 1445-1488. CONFIRMED both.
- 3.4 lighthouse: `_drawLighthouseBeam` at IsometricRenderer.js:6661 calls `this.harborTraffic.getActivePushSignal()` at 6662-6663; method exists at HarborTraffic.js:3566. CONFIRMED.
- 4.3 milestones: `ChronicleStore.js:245 recordCommit`, `:255 getLifetimeCommitCount`. CONFIRMED.
- 4.14 team sash: `Compositor.js:24` cache key includes `${teamHash}`. CONFIRMED.
- 5.5 dock layout memo: `HarborTraffic.js:748-759 buildDockSquadLayout` wraps `_buildDockSquadLayoutFresh` with a memo. CONFIRMED.
- 5.7 sim fixture: `App.js:113 const simMode = new URLSearchParams(location.search).get('sim') === '1'`; gated import + start at 114-118; loadInitialData and SessionWatcher both skipped when simMode. CONFIRMED.
