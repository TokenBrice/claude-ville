# Character Design — Council Research

Date: 2026-05-17
Status: reference
Baseline HEAD: e919f845c5074487c694d6aa163968df48728de1
Initial git status: ` M AGENTS.md\n M CLAUDE.md`

## Method

Read current state directly. Walked:

- `claudeville/src/presentation/shared/ModelVisualIdentity.js` (identity table — providers, model tiers, effort overlays, codex equipment slot map)
- `claudeville/src/presentation/shared/AgentPresentation.js` (provider badge dict, status colors, model label formatter)
- `claudeville/src/presentation/character-mode/AgentSprite.js` (3001 LOC — draw pipeline, name tag, bubbles, motes, codex weapons)
- `claudeville/src/presentation/character-mode/SpriteSheet.js` (8-dir × 10-row layout, 92px cells, 6 walk + 4 idle frames)
- `claudeville/src/presentation/character-mode/Compositor.js` (palette swap + head overlay; result canvas is the per-agent cache key)
- `claudeville/src/presentation/character-mode/AssetManager.js` (manifest flatten, anchor map, outline bake, placeholder fallback)
- `claudeville/src/presentation/dashboard-mode/AvatarCanvas.js` (44×52 idle-S frame thumbnail; legacy primitive fallback)
- `claudeville/src/presentation/shared/RepoColor.js`, `TeamColor.js` (deterministic hash → HSL profiles)
- `claudeville/src/domain/entities/Agent.js`, `value-objects/Appearance.js`, `value-objects/AgentStatus.js`
- `claudeville/assets/sprites/manifest.yaml` (12 character sheets, 4 Codex equipment, 7 accessories, 4 status overlays + 3 effort rings)

Existing plans verified against code: `chardesign-revamp.md` is historical (Phase 1–3 shipped; 12 character sheets exist; effort floor rings + xhigh/max head crests live; Codex weapon overlays composited at runtime). `codex-equipment-coherence-design.md` plan and `codex-effort-gear` / `codex-weapon-upgrade` / `codex-equipment-coherence` research subtrees describe the shipped Codex slot logic. `familiars-and-council.md` is mostly shipped — `familiarMoteEntries`/`drawFamiliarMotes` live at `AgentSprite.js:2862-3001` and `CouncilRing.js:58-216` exists.

Verification: no source edits, no commits, no server start. `git status --short` re-checked at end — unchanged baseline + this owned file.

## Identity Surface Audit

| Visual signal | Currently used? | Carries info? | Potential |
| --- | --- | --- | --- |
| Sprite silhouette (per model sheet) | Yes — 12 sheets, 4 base by provider, 5 model-specific Claude/Codex, 3 Codex effort variants of gpt55 | Yes: model class + (for gpt55) effort tier baked | Cannot expand cheaply (PixelLab cost); reuse via overlays/equipment is the leverage point |
| Robe color (palette swap) | Yes — `Compositor._applyPaletteSwap` with `_hashVariant() % 4` | Per-agent variant; not derived from team/repo | Could be tied to `teamName` instead of agent id hash so colleagues match |
| Hat/head accessory (overlay.accessory.*) | Partial — only `effortXhigh`/`effortMax` referenced from `ModelVisualIdentity.js:25-28`; `mageHood`, `scholarCap`, `goggles`, `toolBand`, `starCrown`, `oracleVeil` are baked PNGs but unreferenced in code | Effort only | Reserve for role / active-tool-class indicator |
| Weapon / handheld | Codex only — runeblade / greatsword / polearm / engineerWrench / multitool, picked by `(modelClass, effortTier)` in `ModelVisualIdentity.js:38-76` | Mostly effort tier, partly provider | No Claude / Gemini analogue; not driven by current tool category |
| Cape / heavy armor | Codex only — `_drawCodexCape`/`_drawCodexHeavyArmor` when effort ≥ high and sheet doesn't already bake it (`AgentSprite.js:1472-1498`) | Effort > medium | Coherent — keep |
| Aura / glow at feet | Yes — `_drawGrounding` (`AgentSprite.js:1247-1294`) pulses for WORKING (amber), steady for WAITING, dim for IDLE; tinted by `statusVisual.color` | Status only, not tool | Could attenuate by token-budget burn or aging since lastActivity |
| Particles (motes) | Yes — familiar motes for live subagents (`AgentSprite.js:2862-3001`), max 3 visible + "+N" pill | Parent→child topology | Could also surface count of active tool calls in flight |
| Walk / idle animation set | 6 walk + 4 idle frames × 8 directions, ±0.6 px sine bob while idle (`AgentSprite.js:996-998`), random fidget turn every 3-9s (`_advanceFidget` `:872-892`) | Locomotion only — no per-state idle variant | Big gap: "thinking" / "waiting on user" / "stuck" share the same idle pose |
| Name plate | Yes — `_drawNameTag` (zoom ≥ 1.5 + selected) and `_drawCompactNameStatus` (zoom < 1.5 or unslotted) `:2402-2530`; repo-tinted panel + diamond glyph | Repo identity via panel color/glyph; agent name centered | Compact band sometimes overlaps codex equipment; nameTagSlot offset table is symmetric ±34 (`:2461-2464`) and may stack above weapon glow |
| Name color | Yes — `repoProfile.labelText` | Repo (project path), not branch | `repoBranchProfile` exists in `RepoColor.js:113-135` but isn't wired into the sprite (agent has no `branch` field consumed here) |
| Model badge | Implicit through silhouette + Codex equipment + effort crest; no glyph in world view | Yes (silhouette) | A 6-px tier dot (apex/balanced/light) next to name would resolve close-up confusions |
| Provider badge | None on world sprite. `_providerTrimColor` only feeds outline/aura accent. Dashboard cards have a `PROVIDER_BADGES` chip (`AgentPresentation.js:27-33`) | Implicit via robe palette | A 6-px provider mark in the name pill would carry across zoom |
| Repo color | Name panel + glyph (`_drawNameTag`/`_drawCompactNameStatus`); not on body | Yes for name plate | Could feed a small flag / sash on the back of the sprite for outdoor team recognition |
| Team color | None on world sprite. `CouncilRing` uses `getTeamColor` for plaza rings (`CouncilRing.js:77`). Sprite floor uses provider trim, not team. | Plaza only | Team-colored cloak trim or hat band would let teams read at a glance even when scattered |
| Role label | `Agent.role` exists (`Agent.js:50`) and shows on dashboard cards (`DashboardRenderer.js:324`); not surfaced in world | No (world) / Yes (dashboard) | Add 1-char role glyph to nameplate |
| Expression / emote | None — sprite has no face state separate from idle frame; chat shows ellipsis bubble (`_drawChatEffect` `:2362-2400`), status shows label bubble | Status, chatting | Add waiting-on-user / errored / rate-limited overlay glyphs above head |
| Status icon | Bubble text only — `_drawStatus` renders the activity thread (`:2231-2239`); no compact icon | Activity tool name | A tiny 8-px icon in name pill carries when bubble is hidden |
| Death / archive | None — when WS removes an agent, sprite is destroyed instantly; only `setArrivalState('pending')` and arrival/departure helpers exist for sub-agents (`AgentSprite.js:590-604`) | None | A fade-with-puff archive animation for `COMPLETED` would feel less abrupt |

## Current State Verdict

Identity is provider-first, then per-model, with effort layered as overlay/floor-ring/weapon for Codex only. Status reads through bubbles + floor halo, but the body language stays static — same idle frame whether the agent is thinking, waiting, errored, or rate-limited. Team and role data exists on `Agent` but is invisible on the sprite (team only shows when an agent is inside a council plaza); repo identity exists on the name pill but not the body. Six accessory overlay PNGs are baked in `manifest.yaml:204-244` but **unreferenced** in code — likely the cheapest unlock in the codebase.

## Recommendations

### R1. Wire accessories to role and current-tool category — UNLOCK ALREADY-BAKED ART

- **Impact: high · Effort: S (½–1 day) · Confidence: high**
- **Problem.** `overlay.accessory.mageHood`, `scholarCap`, `goggles`, `toolBand`, `starCrown`, `oracleVeil` are generated and on disk (`manifest.yaml:204-244`), but `ModelVisualIdentity.js` only sets `effortAccessory` to `effortXhigh|effortMax` (`:25-28`). The Compositor accessory slot is exactly one entry per sprite (`Compositor.js:34-35`), so a Claude agent at low/medium effort renders with bare head. Six head shapes sit idle.
- **Proposal.** Add `runtimeRoleAccessory(agent)` in a new helper `RoleAccessory.js` next to `ModelVisualIdentity.js`. Map (a) explicit `agent.role` keywords (`research|scholar`, `engineer|build`, `coordinator|lead`, `oracle|prophet`) and (b) `agent.currentTool` category (from `domain/services/ToolIdentity.toolCategory`) to a hat ID. Pick: research → `scholarCap`, web/external → `oracleVeil`, file-edit/bash → `toolBand`, build/forge → `goggles`, team-lead → `starCrown`. Effort accessory wins when present; otherwise role hat. Cache key in `AgentSprite.draw()` already includes `accessory` (`:963`), so this is a one-string change in the profile key.
- **Touchpoints.** `claudeville/src/presentation/shared/ModelVisualIdentity.js:25-300` (export `runtimeRoleAccessory`); `claudeville/src/presentation/character-mode/AgentSprite.js:958` (`_runtimeEffortAccessory` becomes `_runtimeHeadAccessory(identity, agent)`); optional new file `claudeville/src/presentation/shared/RoleAccessory.js`.
- **Dependencies.** None — assets, compositor path, and cache slot already exist.
- **Validation.** Open `http://localhost:4000`, eyeball agents with `role: 'research'` (scholarCap) vs default (no hat). Hover/select to verify the head overlay tracks the sprite across directions (compositor stamps each cell).

### R2. Status emote glyph above head — closes the "what is this agent doing" gap

- **Impact: high · Effort: S–M (1 day) · Confidence: high**
- **Problem.** The bubble system (`_drawStatus`/`_drawBubble`/`_drawHistoryBubbles` `:2231-2360`) shows tool labels but is suppressed at zoom < 1.5 (compact mode), occluded by buildings, and silent for important non-tool states like *waiting on user*, *errored*, *rate-limited*. There is no separate state for "errored" or "rate-limited" in `AgentStatus.js:1-7` (only `working|idle|waiting|completed`).
- **Proposal.** Add (1) new status values `AgentStatus.RATE_LIMITED`, `AgentStatus.ERRORED` and (2) a `_drawStatusEmote(ctx)` that floats a 12 px overlay above the silhouette `contentTopY`. Reuse the cached emote PNGs by generating five new overlays under `accessory.statusEmote.*` (or extend `statusOverlays:`): `thinking` (animated 3-dot, exists at `overlay.status.chat` but reuses chat color), `waitingUser` (yellow ? mark), `errored` (red !), `rateLimited` (clock + hourglass), `done` (green check). Map status → emote in a small helper next to `STATUS_VISUALS` (`AgentSprite.js:19-40`). Adapters: surface `ratelimited|errored` from the tool/message stream where present (Codex emits explicit `rate_limit_reset` events; Claude shows error tool results). Default behavior: when `Agent.isToolFresh && !chatting`, show `thinking`. When `status === WAITING && !currentTool`, show `waitingUser`.
- **Touchpoints.** `claudeville/src/domain/value-objects/AgentStatus.js`, `claudeville/src/presentation/character-mode/AgentSprite.js:1426-1464` (extend `STATUS_VISUALS` and `_statusVisualFor`), new `_drawStatusEmote(ctx, contentTopY)` called in `draw()` between `_drawStatus` and `_drawNameTag`; `claudeville/assets/sprites/manifest.yaml` add five 16-px overlay entries.
- **Dependencies.** Coordinates with Council member 2 (Behavior) — they own which states map to which emote and the rate-limit/error detection in adapters.
- **Validation.** `node --check claudeville/src/presentation/character-mode/AgentSprite.js`; visually open village, force a Claude agent to `WAITING` (no current tool) and confirm a `?` hovers above the silhouette across selection/zoom.

### R3. Team-colored sash trim on body — make team membership visible without entering plaza

- **Impact: medium · Effort: M (1–2 days) · Confidence: medium**
- **Problem.** `CouncilRing.js:73-77` is the only place team color shows in the world — a ring on the plaza floor. Agents scattered across the map look identical regardless of which team they belong to. `getTeamColor(teamName)` (`TeamColor.js:27-43`) already produces a stable accent per team name.
- **Proposal.** Add a second palette swap step in `Compositor._applyPaletteSwap` for a **trim accent** color when `agent.teamName` is set. Pick one robe-trim color slot in `palettes.yaml` (e.g. `trim[1]` — the secondary trim) and remap to the team accent computed via `getTeamColor(teamName).accent`. Skip palette swap on subagents that inherit parent's team (their motes already encode parent linkage). The Compositor cache key already keys on `paletteVariant`; add `teamHash` so team-sashed sprites cache independently from solo agents (`Compositor.js:21`).
- **Touchpoints.** `claudeville/src/presentation/character-mode/Compositor.js:16-75` (extend key + add a second swap pass); `claudeville/src/presentation/character-mode/AgentSprite.js:963-967` (include team hash in profile key).
- **Dependencies.** Adapter must populate `teamName` on the session payload (Council 6 / Subagent + Code Health, since `familiars-and-council.md:73` notes the gap in `claude.js` orphan classification). Without it, this is dormant — degrades cleanly.
- **Validation.** Browser smoke: two agents in the same `teamName` should now share a trim color even when standing in opposite ends of the map. Verify the swap doesn't bleed into hands/eyes (ΔE tolerance `±12` per channel in `Compositor.js:60-73`).

### R4. Compact name pill model + role + provider glyphs — read identity at zoom 1

- **Impact: medium · Effort: S · Confidence: high**
- **Problem.** `_drawCompactNameStatus(ctx)` (`AgentSprite.js:2494-2530`) shows agent name + repo glyph at zoom < 1.5, but no model or role mark. At default zoom you get "Nova" with no hint that Nova is Opus on a research role. The compact pill width is currently `max(42, textWidth + 24)` capped at 192 (`:2702-2703`).
- **Proposal.** Stack three 6-px glyphs left-of-text inside the pill: provider mark (existing `PROVIDER_BADGES[provider].label[0]` color from `AgentPresentation.js:27`), model tier dot (apex=gold filled, balanced=silver, light=copper from `identity.modelTier`), repo glyph (already drawn). Width budget: glyphs take 12 px → cap stays 192 but add 3 px gap. Add a one-line `_compactPillGlyphs(ctx, identity, repo)` helper.
- **Touchpoints.** `claudeville/src/presentation/character-mode/AgentSprite.js:2466-2530` and `2717-2736` (`_drawRepoLabelGlyph`).
- **Dependencies.** None.
- **Validation.** `node --check`; open page and zoom out to 1 — confirm three glyphs render left-aligned, name centered, no overlap with codex weapon glow at the foot of the sprite.

### R5. Per-state idle pose / micro-animation — surface "thinking" body language

- **Impact: medium · Effort: M–L (2–4 days; pixellab-bound) · Confidence: medium**
- **Problem.** `_advanceIdleAnimation` (`AgentSprite.js:820-833`) cycles the 4 idle rows at 500 ms/frame for every state. A WORKING agent and a COMPLETED agent breathe identically. The 4 idle rows are fixed by `SpriteSheet.js:7` (`IDLE_FRAMES = 4`) — adding a "thinking" or "stuck" pose means a new row band.
- **Proposal.** Extend `SpriteSheet` layout: row 6-9 stays `idle-default`, add rows 10-13 `idle-thinking` (subtle finger-tap / staff-tip glow pulse) and rows 14-17 `idle-bored` (head tilts, glance around). Regenerate the 12 character sheets at `92 × 18 = 1656 px` height using `mcp__pixellab__animate_character`. AgentSprite picks row band by state: WORKING+!currentTool → thinking, IDLE long → bored, default → existing. Falls back gracefully if the regenerated sheets aren't present (cell row clamp). This is the only recommendation that costs PixelLab credit. Defer if the consolidated plan can't fund it.
- **Touchpoints.** `claudeville/src/presentation/character-mode/SpriteSheet.js:7-10` (introduce `IDLE_BANDS`), `AgentSprite.js:820-833` (band selection); `claudeville/assets/sprites/manifest.yaml:11-133` (`animations: [walk, breathing-idle, thinking-idle, bored-idle]`); 12 PNGs.
- **Dependencies.** Asset generation budget; Council 2 (Behavior) confirms state mapping; sprite-cell cache (`_silhouetteCellCache`, `_cellBoundsCache` at `AgentSprite.js:221-222`) clears on profile key change so it's safe.
- **Validation.** `npm run sprites:validate`, then visual diff `sprites:capture-fresh && sprites:visual-diff`.

### R6. Archive / completion animation — soft removal instead of pop-out

- **Impact: medium · Effort: S · Confidence: high**
- **Problem.** When an agent finishes / WebSocket drops, the sprite is removed instantly. Subagents have `setArrivalState('pending')` and a departure animation lives in `ArrivalDeparture.js` (482 LOC), but main-session removals don't use it. `AgentStatus.COMPLETED` (`AgentStatus.js:5`) exists but doesn't trigger anything visual.
- **Proposal.** On `agent:removed` (or on `status === COMPLETED` if reported), fade the sprite to 0 over 800 ms with a single sparkle puff and a "FINAL" history bubble pinned for 2 s. Reuse `_drawHistoryBubbles` and `bumpFlash` infrastructure. Add `this._archiveAnim = { age, total: 800 }` field updated in `update(particleSystem, dt)` (`:662`) and consumed in `draw()` before silhouette blit.
- **Touchpoints.** `claudeville/src/presentation/character-mode/AgentSprite.js:947-1035`, `2231-2360`; `claudeville/src/presentation/character-mode/IsometricRenderer.js` (the `agent:removed` handler — must defer disposal by 800 ms).
- **Dependencies.** Light coordination with Council 2 (Behavior) — they own removal lifecycle.
- **Validation.** Stop a Claude session and confirm the sprite gently fades with a sparkle, not pop-cut.

### R7. Token-budget aura intensity — high-burn agents glow brighter

- **Impact: low · Effort: S · Confidence: medium**
- **Problem.** `_drawGrounding` (`:1247-1294`) intensity is a fixed `0.30 + 0.22 * pulse` for WORKING. Two agents both WORKING look identical even if one has consumed 200 k tokens this hour and the other 5 k.
- **Proposal.** Multiply working aura alpha by `clamp(0.6 + tokenBurnFactor, 0.6, 1.4)` where `tokenBurnFactor = Math.log10(agent.tokens.total || 1) / 6`. Reuse `TokenUsage` already on `Agent`. Keep IDLE/WAITING flat to preserve hierarchy.
- **Touchpoints.** `claudeville/src/presentation/character-mode/AgentSprite.js:1270-1286`.
- **Dependencies.** None.
- **Validation.** Smoke-test agent with high token usage shows brighter ring than fresh agent.

## Quick Wins (≤1 day each)

1. **R1** — wire baked head accessories to role/tool category (no asset cost; six PNGs idle).
2. **R4** — three 6-px glyphs in compact pill (provider + tier + repo).
3. **R7** — token-burn aura modulation (one line in `_drawGrounding`).
4. **R6** — archive fade (800 ms removal animation).
5. **Cleanup spike**: delete or repurpose `Appearance.js` (`SKIN_COLORS`, `HAIR_COLORS`, etc.). Still referenced from `AgentSprite` / `AvatarCanvas` indirectly, but the per-agent procedural face is no longer drawn anywhere in world mode (`AvatarCanvas.js` legacy fallback only). Confirm with Council 6 before removing.

## Bugs / Defects Observed

- `AgentSprite.js:2417` — `rawName = String(this.agent.name || this.agent.displayName || '').trim() || this.agent.displayName` — the final `|| this.agent.displayName` is redundant after the first fallback. Severity: low (cosmetic / dead branch).
- `AgentSprite.js:2461-2464` — `_nameTagSlotYOffset()` table only supports 9 slots; for >9 overlapping agents in a tight cluster all collapse to the highest offset (`+34`). Severity: medium for dense clusters.
- `Compositor.js:60-73` — palette swap ΔE tolerance is per-channel (`±12`) on RGB, not perceptual ΔE. Painterly trims with colors near `(robe + 12, robe + 12, robe + 12)` get falsely swapped when palette variants are close. Severity: low; observable on `agent.codex.gpt55` variants where trim teal and accent teal are within tolerance.
- `Compositor.js:84-87` — overlay compositor returns silently if `cellSize` is non-integer or sheet height is shorter than `(rows * cellSize)`. There's no warning logged, so a mis-sized accessory PNG (e.g. wrong `displaySize`) silently no-ops. Severity: medium — assets exist but won't render.
- `ModelVisualIdentity.js:255-263` — `default` codex branch shares `spriteId: 'agent.codex.gpt54'` with the senior tier. A fallback codex with unknown class draws as gpt54. Severity: low (intentional fallback) but unexpected to newcomers reading the table.
- `AvatarCanvas.js:7-29` — `SPRITE_ASSET_VERSION` defaults to a hard-coded literal `'2026-04-26-visual-revamp'` (line 8). Real version in manifest is `'2026-05-01-kimi-agent-v5'` (`manifest.yaml:2`). The async load updates it but the first render after page boot uses the stale version for the cache-bust query. Severity: low (cache invalidates within 1 s).
- `manifest.yaml:204-244` — six baked head accessory PNGs (mageHood, scholarCap, goggles, toolBand, starCrown, oracleVeil) have no reference in `ModelVisualIdentity.js` or `AgentSprite.js`. They were generated but never wired. Severity: medium (sunk PixelLab credit).
- `Agent.js:64` — `Appearance.fromHash(id)` constructs SKIN/SHIRT/HAIR/EYE per agent, but world rendering doesn't use any of those fields. Only `AvatarCanvas` legacy fallback path consumes them (rarely hit because generated sprite usually loads). Severity: low — dead model in domain.

## Cross-Domain Coordination

- **Council 1 (Visual & Atmosphere):** R7 (token aura) competes with the LightSourceRegistry budget — confirm aura modulation honors `LightingState.lightBoost`. R5 idle-thinking pose interacts with weather/day-night palette swap; sheets must look right at all phases.
- **Council 2 (Behavior):** R2 (status emotes) and R6 (archive fade) need behavior state transitions cleanly emitted: `rate-limited`, `errored`, `completed`. Coordinate the new `AgentStatus` enum values. R5 idle bands need the behavior state machine to publish "thinking" vs "default-idle" so the row band lookup is deterministic.
- **Council 3 (Buildings):** R1 role hats should match building emotes — a `goggles`-wearing engineer near the Forge should trigger a forge-side interaction emote.
- **Council 6 (Portal / Subagent / Code Health):** R3 (team sash) hard-depends on populating `Agent.teamName` from the Claude adapter (gap noted in `familiars-and-council.md:73`). Familiar mote logic (`AgentSprite.js:2862-3001`) is already shipped — R3 layers on top.

## Council Debate Stance

The cheapest, most-readable wins lie inside the existing renderer: six baked head accessories are sitting idle (R1), the compact name pill has 8 unused pixels begging for a model-tier dot (R4), and the working-aura constant ignores the most useful diagnostic on `Agent` (R7). All three are zero-asset, sub-day code changes that materially raise the information density of every agent. Push for them as the table-stakes hour-one work.

The medium-term spend should go to **status emote glyphs (R2)** and **team sash trim (R3)**, in that order. R2 closes the actual user-pain gap — "is my agent thinking, waiting on me, errored, or rate-limited?" is the one question the dashboard exists to answer and the world view currently can't. R3 unlocks the team primitive that `CouncilRing` half-introduced; it makes parallel team work feel like a fleet rather than a swarm. R5 (new idle pose rows) is gorgeous but credit-heavy and slow — defer unless the consolidated plan has budget left. R6 (archive fade) is a polish must-have at any point that doesn't compete with the above. My top picks for the consolidated plan: **R1, R2, R4**, with **R3** queued behind a confirmed `teamName` plumbing fix from Council 6.
