# v0.22 Improvement Plan — Warden's Rounds

Status: `historical` (implemented and shipped as v0.22.0 *Warden's Rounds* on 2026-07-10; kept as provenance for what was selected vs. deferred)
Source: 8-agent survey workflow over all subsystems + live-app UX review (2026-07-10, 39 candidates collected; this plan selects 21).
Baseline: main @ b477907 (v0.21.1 local hotfix, unreleased — absorbed into v0.22).

Selection bias: verified bugs, user-visible polish, bounded perf wins. Everything implementable and verifiable locally, no new runtime deps, no framework, port 4000 unchanged.

## Workstream A — Claude adapter & usage services

Owned files: `claudeville/adapters/claude.js`, `claudeville/services/usageQuota.js`

1. **Path-traversal fix in session-detail resolution** (S). `resolveSessionFilePath()` and the subagent-id branch concatenate client-supplied ids into paths with no containment check; `sessionId=../../../../etc/foo` reads arbitrary `*.jsonl`-suffixed files. Mirror `kimi.js`'s `safeExistingFile` realpath-containment. Verify: direct node call with traversal ids returns null.
2. **Orphan/team-member scan caching** (M). `_getOrphanSessions` stats every historical `*.jsonl` under `~/.claude/projects/*` (~2k files) every uncached poll. Cache per-directory listings keyed on dir mtime like codex.js's rollout discovery. Verify: node benchmark before/after; results identical, repeat-scan cost drops.
3. **Account email extraction** (S). `fetchEmail()` regex-matches plaintext but current CLI emits JSON; parse JSON first, keep regex fallback. Verify: service call returns non-null email matching `claude auth status`.
4. **Quota staleness cap** (S). Track last *success* timestamp; after ~30 min of failures stop reporting `quotaAvailable:true` with frozen numbers. Verify: unit-style node check with injected failing fetch.

## Workstream B — Provider adapters (gemini / grok / codex / git events)

Owned files: `claudeville/adapters/gemini.js`, `grok.js`, `codex.js`, `gitEvents.js`

1. **Gemini token usage** (M). Messages carry a `tokens` field the adapter never reads → every Gemini session shows $0.00. Add `getTokenUsage`-style summation wired into the session object. Verify: synthetic session fixture returns non-null tokenUsage.
2. **Grok subagent parenting** (M). Set `agentType` from `summary.session_kind` and resolve `parentSessionId` from `subagents/<id>/meta.json` (`parent_session_id`), replacing the always-null summary field. Verify: against real `~/.grok/sessions` data on disk.
3. **Codex `custom_tool_call` support** (S). Treat `payload.type === 'custom_tool_call'` like `function_call` in `parseRollout`/`getToolHistory`, and `custom_tool_call_output` for completion enrichment. Verify: node run against live rollouts shows tool history where previously empty.
4. **Codex orchestration input summaries** (S). `spawn_agent`/`send_message` inputs currently surface raw JSON with encrypted `message` blobs into bubbles/cards. Summarize to `task_name`/`target` and drop `message` bodies in `summarizeCodexToolPayload`. Verify: node run against live rollouts; no `gAAAA` blobs in lastToolInput/history detail.
5. **`git push --delete` detection** (S). Detect `--delete`/`-d`/leading-`:` refspec and mark the event as a branch deletion instead of a normal push. Verify: node reproduction of both forms.

## Workstream C — Pricing & token math parity

Owned files: `claudeville/src/config/model-pricing.json`, `claudeville/src/domain/value-objects/TokenUsage.js`, `claudeville/adapters/sessionPresentation.js`, `scripts/widget/check-pricing.cjs`

1. **Gemini rate table** (M). Gemini currently falls through to Claude Sonnet rates. Add a `gemini` provider table (research current Gemini API rates; if ambiguous use Gemini 3 Pro tier ~$2/$12 with a `default`) to `model-pricing.json`, mirror in `TokenUsage.js`, branch in both `ratesForModel`/`pricingForModel`, and extend the parity check to cover it. Verify: `npm run validate:quick` pricing check green; node resolution test.
2. **Reasoning-token billing client-side** (S). Port `reasoningTokens`/`reasoningInOutput` fields and the server's billing formula from `sessionPresentation.estimateCost()` into `TokenUsage.js` (defaults, aliases, normalize, estimate). Verify: node comparison — client and server estimates match on an OpenCode-style usage payload.

## Workstream D — Dashboard & shared UI

Owned files: `claudeville/src/presentation/shared/AgentPresentation.js`, `claudeville/src/config/theme.js`, `claudeville/src/presentation/dashboard-mode/AvatarCanvas.js`, `claudeville/src/presentation/shared/ActivityPanel.js`, `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js`, `claudeville/src/application/NotificationService.js`, `claudeville/css/dashboard.css`, `claudeville/src/domain/entities/Agent.js`, `claudeville/src/application/AgentManager.js`

1. **Grok/DeepSeek provider badges** (S). Unknown providers fall back to the "Claude" badge. Add grok+deepseek to `PROVIDER_LABELS`/`PROVIDER_ICONS` and `grok` to `PROVIDER_HUES` (cyan family, match ModelVisualIdentity trim). Verify: node badge-resolution check.
2. **`ultra` tier in remaining maps** (S). `AvatarCanvas.auraColor` byTier and `ActivityPanel._formatAgentLevel` label map lack `ultra` (add `ultra: 2` / `'Ultra'`). Verify: grep + browser.
3. **Pause detail polling in hidden tabs** (S). `visibilitychange` gate on Dashboard `_fetchAllDetails` and ActivityPanel detail/building polling; immediate refresh on visible. No cadence changes. Verify: DevTools network idle when hidden.
4. **Reconnect-only toast** (S). Gate `serverConnected` toast on a prior connection having existed (mirror `_onAgentAdded`'s initial-load suppression). Verify: reload → no toast; simulated reconnect → toast.
5. **Card meta-chip overflow** (S). `.dash-card__meta` chips slide under the status pill; add `min-width:0`/`overflow:hidden` + ellipsis on the age chip. Verify: browser at 1280px.
6. **Unique villager names** (M). 15-name pool collides in busy villages (two Leibnizes today). Expand pool to 60+ village-themed names and probe past names held by live agents on assignment; never override provider/team-supplied names. Verify: node — spawn 30 synthetic agents, all unique.

## Workstream E — World mode polish & perf

Owned files: `claudeville/src/presentation/character-mode/AgentSprite.js`, `IsometricRenderer.js`, `RelationshipState.js`, `claudeville/src/domain/services/ToolIdentity.js`

1. **Bubble de-collision in crowds** (M). Status/speech bubbles overlap unreadably in clusters. Extend the existing `_assignAgentOverlaySlots` rect-slot technique to full-mode bubbles: stagger stacked slots per frame, cap concurrent bubbles per cluster. Verify: simfixture/live cluster screenshot — readable, non-overlapping.
2. **Orchestration tool labels** (S). Add unprefixed aliases (`send_message`→Messaging, `wait_agent`/`wait`→Waiting On, `spawn_agent`→Spawning, `list_agents`→Coordinating, `exec`) to `ToolIdentity` metadata + AgentSprite override map so codex orchestrators read as activities, not snake_case. Verify: browser bubbles.
3. **`!?` low-confidence suffix** (S). Skip the `?` suffix when text already ends in punctuation. Verify: code inspection + browser.
4. **Grok world identity** (S). Add grok branch to `AgentSprite._providerKey`; rely on Workstream D's `PROVIDER_HUES.grok` for color. Verify: compact-mode badge renders cyan for grok sessions.
5. **Mine crowd-guard** (S). The `mine` ambient destination lacks the crowd-guard other magnets have — add it. Verify: code parity with other destinations.
6. **RelationshipState per-frame allocation** (S). Compute the sprite array once per `update()` and pass through instead of 3× `Array.from`. Verify: `node --check` + behavior unchanged in browser.

## Docs sweep (main-loop, at release)

README version badge/text (→ v0.22.0), `/api/changelog` row in README API table, gpt-5.6 variants in troubleshooting cost-model list.

## Deferred (explicitly out of v0.22)

- macOS widget items (status derivation, WebView reload, nvm path): not verifiable on this Linux box.
- WS `agent:updated` diffing: protocol-behavior risk vs. benefit; needs its own careful pass.
- Offline "last active just now" freeze; week-long history.jsonl scan trim; KDE frame drift check; quota `resets_at` exposure; stale doc line-number citations.

## Release checklist

All workstreams merged → `node --check` on all touched runtime files → `npm run validate:quick` → adapter smokes (`scripts/smoke/adapters.mjs`, relationship smoke) → Playwright World+Dashboard verification → CHANGELOG v0.22.0 entry (absorbs unreleased v0.21.1 Grok-rebake hotfix) → version bumps (package.json 0.22.0, index.html chip v0.22, README badge) → commit → push → tag + GitHub release per documented flow.
