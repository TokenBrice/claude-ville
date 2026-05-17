# Reviewer 6 - Reduced-Motion and Motion-Budget Compliance

**HEAD:** 7b5a452
**Scope:** Every animated effect introduced or kept through Phase 0-5 must check `motionScale`, ship a deterministic static fallback, and declare a pulse band.
**Policy reference:** [`docs/motion-budget.md`](../../../docs/motion-budget.md)

## Verdict

**Conditional pass with 4 blocking compliance gaps + 3 medium-risk fallback gaps.**

The repo has a mature motion-scale story: `IsometricRenderer.motionScale` is the master, propagation runs through `_setMotionScale` (`IsometricRenderer.js:1505-1518`), and every major harbor/atmosphere/agent path consults it. Most new Phase 0-5 effects (godrays, aurora, shooting stars, force-push whirlpool, family tether, team gather, foliage sway, channel buoy, lighthouse beam, fireworks rings, milestone banners, repo bunting/shields, observatory clock spin, retry/plan-mode glyphs, archive fade, sea mist fade, cast-off stutter, rejected boomerang, seasonal particles, watchtower gull, sprite rain stamps, smoke plumes) implement working motion-scale gates. Where Phase 0-5 falls short: (1) seasonal-particle static fallback is dead code (spawn rejected by `ParticleSystem.setMotionEnabled(false)`), (2) the chat ellipsis animates regardless of motion scale, (3) several `BuildingSprite` motion checks use a *separate, second* matchMedia source that drifts from `IsometricRenderer`, and (4) `Camera` queries the media query a *third* time, eliminating any single canonical source for the runtime motion-scale signal.

## Coverage Table

| Effect | File:line | Motion check? | Static fallback? | Pulse band (declared / inferred) | Compliance | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Godrays | `SkyRenderer.js:444-495` | No direct check | Atmosphere snapshot freezes time-drift via `preferredMotionScale` | static (sun position drifts with logical clock only) | PASS | Plan note acknowledged at `agents/plans/living-twilight-sky.md:520`. Camera-pan parallax intentionally still active. |
| Aurora | `SkyRenderer.js:731-777` | yes | yes - `motionScale === 0` returns `alpha=1`, `time=0.75` (frozen ribbons) | slow | PASS | Snapshot-frozen ribbon shape |
| Shooting stars | `SkyRenderer.js:779-834` | yes | yes - drains the queue when reduced motion fires mid-trail | fast | PASS | Drops state cleanly |
| Family tether | `CouncilRing.js:204-255` | yes - `motionScale === 0` flickers/dashOffset are pinned | yes - constant alpha, no dash drift | slow | PASS | Quadratic curve stays visible |
| Team gather / council ring | `CouncilRing.js:148-201` | yes - `shimmer = 1` when `motionScale === 0` | yes - ring still drawn | slow | PASS | |
| Talk arcs (chat curve) | `CouncilRing.js:273-313` | yes - `shimmer = 1`, line dash applied for static cue | yes - dashed quad arc remains | medium | PASS | |
| Chat speech bubble + ellipsis | `AgentSprite.js:2658-2696` | NO - `chatBubbleAnim += 0.06` at line 735 never gated by motionScale | NO - dots cycle `phase = Math.floor(t * 1.5) % 3` regardless of reduced-motion | medium | **FAIL (blocking)** | Dot ellipsis animates under reduced motion. Need to either freeze `chatBubbleAnim` increment or skip `phase` calc and render three solid dots when `motionScale <= 0`. |
| Phase-coupled water (current bands, foam, glint) | `IsometricRenderer.js:3851`, `4400-4470`, `4508`, `4571`, `5333`, `5480` | yes - top-level `if (!this.motionScale) return;` for animated band; per-tile checks for shimmer | partial - tile shimmer collapses to `STATIC_WATER_SHIMMER`; animated bands skipped entirely with no static replacement | medium / static | PASS (acceptable) | Static fallback for tile shimmer is deterministic. Current bands have no static stand-in but they are decorative; documented intent. |
| Stamp ripples (sprite rain stamps) | `IsometricRenderer.js:3994-4012`, `WeatherRenderer.js:306` | yes - upstream gate `stampRipples = (this.motionScale ?? 1) > 0` | none (silent skip) | fast | PASS (acceptable) | Effect ornamental; reduced motion cleanly removes per policy |
| Foliage sway `_withTreeSway` | `IsometricRenderer.js:3789-3825` | yes - `motionScale <= 0 \|\| windX === 0` early returns drawFn at base pose | yes - tree draws at canonical anchor | medium / static | PASS | Comments declare band |
| Forge/Mine smoke plumes (animated) | `IsometricRenderer.js:2412-2448` (emitters), `BuildingSprite.js:2856` | yes - `if (!this.motionScale) return;` blocks both emitter loops | yes - `_drawStaticBuildingSmoke` (`IsometricRenderer.js:2710-2735`) renders one deterministic puff per occupied/busy building | medium | PASS | Best example of policy-compliant authoring |
| Watchtower gull orbit | `IsometricRenderer.js:6216-6259` | yes - dedicated `motionScale <= 0` branch | yes - pinned to `WATCHTOWER_GULL_FALLBACK_TILE` with level wing frame | medium | PASS | Code comment explicitly cites policy |
| Open-sea flock gull positions | `IsometricRenderer.js:6042-6096` | yes - `time` snapped to 0 and per-gull modulation skipped; cycle filter still runs | partial - positions freeze at journey start; not all gulls produce a visible static silhouette | medium | NEEDS WORK (medium) | Returns null when `journeyT > activeSpan`; under reduced motion `cyclePhase` is constant. Could result in zero on-screen gulls. Add explicit static-fallback positions identical to `_watchtowerGullPosition`. |
| Sea-mist push fade (force push wake) | `HarborTraffic.js:3826-3830` | yes - `alpha = 0.78`, `wave = 0.55` when `motionScale === 0` | yes - constant values | medium | PASS | |
| Force-push whirlpool | `HarborTraffic.js:3865-3890` | yes - `spirals = 1` when `motionScale === 0` | yes - single ellipse + 1 ring | medium | PASS | |
| Rejected boomerang | `HarborTraffic.js:1697-1716`, `2806-2848` | yes - `motionScale === 0` skips the lifecycle, snaps to redocked state | yes - redocked with caution flag immediately | medium | PASS | |
| Cast-off stutter | `HarborTraffic.js:2785-2803`, `3025-3030` | yes - `motionScale > 0 && elapsed < CAST_OFF_MS` guards stutter | yes - departure progresses normally; no stutter painted | fast | PASS | |
| Cancelled push expanding ring | `HarborTraffic.js:3856-3864` | yes - `staticMotion = motionScale === 0`, radius pinned at 22 | yes - single ring | medium | PASS | |
| Failed-push x-flash | `HarborTraffic.js:3845-3855` | partial - `wave` from `_drawFinaleEffect` zeros radius oscillation via `wave === 0.55` | yes - constant radius | fast | PASS | |
| Lagoon channel buoy pulse | `HarborTraffic.js:3524-3562` | yes - `(!muted && motionScale > 0)` gates pulse | yes - constant `pulse = 0.65` | medium | PASS | |
| Lighthouse beam strobe/sweep/pulse | `IsometricRenderer.js:6661-6800+` | yes - dedicated `reducedMotion = motionScale <= 0` branches for each state (idle/failed/rejected/pulsing/departing) | yes - constant alpha multipliers per state | slow / fast | PASS | Particularly thorough; weatherRenderer fog nudge is gated separately |
| Ship bob (docked / departing / arrival) | `HarborTraffic.js:3105`, `3203`, `3225` | yes - `motionScale > 0 ? ... : 0` | yes - bob = 0 | medium | PASS | |
| Repo bunting (static arc) | `HarborTraffic.js:3746-3779` | n/a - no animated path | n/a - drawn identically regardless of motion | static | PASS | Comment confirms intent at line 3747 |
| Repo shields / commit pennant | `HarborTraffic.js:3781-3823` | n/a - static labels and frames | n/a - identical at all motion scales | static | PASS | |
| Status emote: rate_limited (hourglass) | `AgentSprite.js:3282-3306` | n/a - pure static shapes | static glyph | static | PASS | |
| Status emote: errored / waiting_on_user / completed | `AgentSprite.js:3308-3330` | n/a - static | static | static | PASS | |
| Status emote: thinking dots | `AgentSprite.js:3332-3346` | yes - `animated = motionScale > 0`; sets `phase = -1` when off | yes - all three dots full-alpha (constant) | fast | PASS | |
| Plan-mode glyph | `AgentSprite.js:3222-3250` | n/a - static draftsman triangle | static | static | PASS | |
| Retry glyph | `AgentSprite.js:3252-3280` | n/a - static arrow arc | static | static | PASS | |
| Stance overlay (working, waiting, chatting wave) | `AgentSprite.js:3348-3397` | partial - `phase = motionScale > 0 ? ... : 0`, `wavePhase = motionScale > 0 ? ... : 0` | yes - alpha and side-position pinned | fast | PASS | |
| Idle bob (subtle sin-wave) | `AgentSprite.js:1202-1208` | indirect - `this.frame` stays at 0 when motionScale=0 (see `_advanceWalkAnimation:863`, `_advanceIdleAnimation:903`) | yes - `Math.sin(0)*0.6 = 0` flattens bob | medium | PASS (implicit) | Worth a comment near line 1202 to make the dependency explicit; future refactor could break this by advancing `this.frame` from time instead of step distance. |
| Long-wait clock | not implemented as a distinct effect | n/a | n/a | n/a | N/A | The hourglass emote covers wait state; no separate clock cue exists. |
| Observatory clock spin | `BuildingSprite.js:1617-1640`, integrator at `2856-` and `337+` | yes - `spin = motionScale ? (_observatoryClockSpin) : 0` | yes - hands pinned to current hour | slow | PASS | |
| Portal preview overlay (scanline) | `BuildingSprite.js:2562-2587` | yes - `drift = motionScale ? Math.floor(...) : 5` | yes - scanline pinned at row 5 with comment | medium | PASS | |
| Portal active screen ritual | `BuildingSprite.js:2458-2525` | inherited via `_ritualFade` and `motionScale` checks in ritual flutter (line 2618-2622) | yes - flutter = 0 | medium | PASS | |
| Archive fade | `AgentSprite.js:1131-1140`, `1182`, `2937-2960`, `IsometricRenderer.js:1980-2000` | yes - reduced motion does hard cut (`fadeAlpha = 0`) at line 1137; `IsometricRenderer.js:1981` only sets `_archiveAnim` when `motionScale > 0`, otherwise sprite is removed immediately | yes - snap to invisibility | n/a | PASS | Comment at line 1136 documents reduced-motion hard cut |
| Archive sparkle flash | `AgentSprite.js:1257-1258`, `2906-2929` | yes - `archiveProgress > 0 && motionScale > 0` | yes - sparkle entirely omitted | fast | PASS | |
| Archive shelf-fill door particles | `BuildingSprite.js:2856-2876` | yes - top-level `if (!this.motionScale) return;` for emitter pass | NO - no static fallback shelves or motes | medium | NEEDS WORK (medium) | Ornamental, but unlike forge/mine smoke (which has `_drawStaticBuildingSmoke`), the archive "read intensity" cue is invisible under reduced motion. Either rely on the shelf-fill texture itself or paint a deterministic mote cluster when `motionScale === 0`. |
| Seasonal particles (cherry petals / leaves / fireflies) | `SeasonalAmbience.js:78-132`, wired at `IsometricRenderer.js` particle system | yes - explicit static fallback branch | **NO (dead code)** - calls `this.particleSystem.spawn(season.type, px, py, 1)` which short-circuits because `IsometricRenderer.js:563` sets `particleSystem.setMotionEnabled(motionScale > 0)` and `ParticleSystem.spawn:187` rejects when motion is off | medium | **FAIL (blocking)** | The "deterministic static placeholder particles" never materialise. Either (a) call a dedicated `particleSystem.spawnStatic()` path that bypasses the motion guard, (b) paint the placeholder dots directly in a draw callback in `IsometricRenderer`, or (c) remove the fallback claim and document seasonal particles as motion-only. |
| Fireworks rings (release event) | `ChronicleMonuments.js:470-503` | yes - `reducedMotion = reducedMotionPreferred()` (recomputed via matchMedia) | yes - three concentric outline circles | medium | PASS (with caveat) | The motion source is `window.matchMedia('(prefers-reduced-motion: reduce)').matches` (`ChronicleMonuments.js:51`), not the central `IsometricRenderer.motionScale`. Behaviour matches today but introduces a *second canonical source*. |
| Milestone banner (`maiden`, `ribbon`, `flagship`, `aurora`) | `ChronicleMonuments.js:505-556` | yes - `reducedMotion = reducedMotionPreferred()`; fade pinned to 1 | yes - banner stays visible for the full lifetime; ribbon flourish omitted | medium | PASS (same caveat as fireworks) | Uses ChronicleMonuments' independent matchMedia query |
| Chronicler walker | `Chronicler.js:36-54`, `78-100`, fallback scaffold `IsometricRenderer.js:6473-6493` | yes - `if (motionScale === 0) return;` for update; `Math.sin(this.frame)*1.2` resolves to 0 when frame stays at 0 | yes - chronicler stays at first waypoint with no bob | slow | PASS | |
| TrailRenderer | `TrailRenderer.js:41-63`, `:210` | yes - early-out `if (motionScale === 0) return this._needsRepaint;` | partial - trail render still happens once on transition into reduced motion; subsequent ticks idle | static | PASS | |
| Selection halo + selection ring | `AgentSprite.js:1226-1235`, `1671-1696` | indirect - `this.frame` frozen at 0 means `Math.sin(0)*0.3 = 0`, pulseAlpha = 0.7 constant | yes - constant alpha | slow | PASS (implicit) | |
| Familiar motes orbit | `AgentSprite.js:3523-3588` | yes - `motion = motionScale === 0 ? 0 : 1`; positions pinned to deterministic ring | yes - static angle ring around parent | medium | PASS | |
| Wisp dispatch/merge/orphan return | `ArrivalDeparture.js:111-261`, `353-372` | yes - `motionScale === 0` jumps progress to 1 and clears state | yes - end position rendered briefly | medium | PASS | |
| Subagent completion cue | `ArrivalDeparture.js:393-434` | yes - pinned alpha 0.74 / fixed position | yes - constant glyph | fast | PASS | |
| Departure sigil | `ArrivalDeparture.js:436-473` | yes - alpha gated by `age <= REDUCED_SIGIL_MS` | yes - flash holds for 250 ms then snaps off | fast | PASS | |

## Compliance Gaps

### Blocking

1. **Seasonal particles static fallback is dead code.**
   `SeasonalAmbience._seedStaticFallback` spawns into the same particle system that `IsometricRenderer` has muted (`particleSystem.setMotionEnabled(false)` at `IsometricRenderer.js:1515`). Result: under reduced motion the screen shows neither drift nor placeholder dots, contradicting the file-level docstring at `SeasonalAmbience.js:5-6`. Fix: paint placeholder dots in a dedicated draw method (mirror `_drawStaticBuildingSmoke`) or expose `particleSystem.spawnStatic()` that bypasses the motion gate.

2. **Chat ellipsis animates regardless of motion scale.**
   `AgentSprite.update()` advances `chatBubbleAnim += 0.06 * frameScale` on every tick during chat (`AgentSprite.js:735`) with no motion-scale multiplier. `_drawChatEffect` derives `phase = Math.floor(t * 1.5) % 3` so the ellipsis dots keep cycling. Fix: either gate the increment (`this.chatBubbleAnim += 0.06 * this.motionScale * frameScale`) or, in `_drawChatEffect`, render the three-dot ellipsis at full alpha when `this.motionScale === 0`.

3. **Inconsistent reduced-motion source (matchMedia called from 5 modules).**
   Canonical owner is `IsometricRenderer.motionScale`, but `BuildingSprite.js:276-279`, `Camera.js:15-19`, `AtmosphereState.js:478`, `ChronicleMonuments.js:48-55`, and `AgentSprite.js:182` each call `matchMedia('(prefers-reduced-motion: reduce)')` independently. Worse, `BuildingSprite` ignores `IsometricRenderer._setMotionScale(0)` in favour of its own `_motionMq` change listener: the renderer's `setMotionScale(0)` does call `this.buildingRenderer?.setMotionScale(scale)` (line 1507), so the two paths agree in practice, but the building's local `_motionMq` listener can fire first and create transient mismatch during preference toggles. Fix: have `BuildingSprite`, `Camera`, `AtmosphereState`, and `ChronicleMonuments` accept a motion-scale getter from `IsometricRenderer` (`motionScaleGetter` already pattern used in `SeasonalAmbience.js:50` and `IsometricRenderer.js:507`) instead of reading the media query directly.

4. **Open-sea flock under reduced motion can leave the screen empty.**
   `_openSeaGullPositions` (`IsometricRenderer.js:6042-6096`) only positions a gull when `cyclePhase <= gull.activeSpan`. Under reduced motion `time = 0`, so `cyclePhase = (gull.cycleOffset) - floor(gull.cycleOffset)` — which depends on each gull's authoring constants. Several gulls are filtered out, so the static fallback may not show a single bird in the open sea. Fix: when `motionScale <= 0`, return one representative gull per flock at a deterministic position (mirror the `_watchtowerGullPosition` fallback pattern). This is medium-priority but still a fallback gap.

### Medium

5. **Archive shelf-fill door particles have no static stand-in.**
   `BuildingSprite._spawnBuildingEntryParticles` (around `BuildingSprite.js:2856`) early-returns on `!this.motionScale` but the archive door region's "read intensity" cue is only ever visible through these particles. Mirror `_drawStaticBuildingSmoke` (`IsometricRenderer.js:2710`) and paint a single deterministic mote cluster when read intensity > 0.6 and motionScale = 0.

6. **`SkyRenderer._drawGodrays` does not consult motionScale at all.**
   It relies entirely on the atmosphere snapshot freezing its `motion.driftEnabled`. Under that policy this is fine, but the plan document does not say so at the call site. Add a one-line comment near `SkyRenderer.js:444` recording that the static ray shape is invariant because sun position drifts only with logical clock advancement — this matches the policy note at `agents/plans/living-twilight-sky.md:520`. Same observation for `_drawShootingStars` (cleared on transition), which is fine.

7. **Idle bob and selection-ring pulse rely on implicit `this.frame` freeze.**
   `AgentSprite.js:1202-1208` (idle bob) and `:1674` (selection-ring pulse) both look like unguarded `Math.sin` reads but only stay static because `_advanceWalkAnimation` (`:863`) and `_advanceIdleAnimation` (`:903`) hard-pin `this.frame = 0` under reduced motion. A future refactor that ties `this.frame` to `performance.now()` instead of step distance would silently regress both effects. Add an explicit `this.motionScale > 0 ? ... : 0` guard at both sites or a `// reduced-motion: implicit via this.frame freeze` comment.

## Inconsistent Motion-Scale Source

| Module | Motion source | Owner? |
| --- | --- | --- |
| `IsometricRenderer.motionScale` | constructor's own matchMedia + `_setMotionScale` fan-out | **canonical** |
| `BuildingSprite._motionMq` | its own matchMedia listener (and `setMotionScale` call from `_setMotionScale`) | duplicate |
| `AgentSprite.motionScale` | constructor's own matchMedia, overwritten by `_setMotionScale` | mostly OK |
| `Camera._reducedMotion` | its own matchMedia + `setReducedMotion(scale <= 0)` from renderer | duplicate |
| `AtmosphereState.preferredMotionScale` | falls back to matchMedia when no override | duplicate |
| `ChronicleMonuments.reducedMotionPreferred` | per-draw matchMedia call | duplicate |
| `SeasonalAmbience.motionScaleGetter` | dependency-injected (good pattern) | uses canonical |
| `RitualConductor.motionScale` | passed in by renderer | uses canonical |

This violates the "single canonical source" principle the policy implies by not naming. There is no `_currentMotionScale` *per se* — most code reads `this.motionScale` directly, but the **value** is sourced six different ways. Recommendation: keep `IsometricRenderer.motionScale` as the canonical writer, and refactor `BuildingSprite`, `Camera`, `AtmosphereState`, and `ChronicleMonuments` to accept a getter from the renderer instead of running their own media-query listeners.

`SkyRenderer._currentMotionScale` is a third name pattern (`SkyRenderer.js:72`, `98`, `153`). It's owned by `SkyRenderer` itself but written from the latest `drawCanopy`/`draw` call, which is fine — the field is internal and only consulted by `_isAuroraSchedulable` (line 130).

## Optional Improvements

- **Adopt the shared pulse-clock helper** suggested in `motion-budget.md:14-22`. Today every module reinventes `Math.sin(this.waterFrame * k + seed)` or `Math.sin(now * k)`. A `pulse(motionScale, band, seed)` helper would (a) collapse 60+ ad-hoc cadences, (b) make pulse bands grep-able, and (c) give one canonical place to handle reduced-motion.
- **Document pulse bands at call sites.** Today only some functions cite a band (e.g. lighthouse beam comments mention "phase"). Most do not. A `// pulse: medium` shebang above each animated draw would unblock future band conflict audits.
- **Inline the policy reference.** Modules with multiple animated effects (HarborTraffic, IsometricRenderer) could ship a header comment pointing to `docs/motion-budget.md` so onboarders don't have to discover it.
- **Surface a debug overlay** that visualises `motionScale` and the active pulse claimants. The infra is already there via `DebugOverlay.js`.

## File / Line Reference Index

- Motion-scale plumbing: `IsometricRenderer.js:548-563`, `1495-1518`, `_setMotionScale`.
- Atmosphere reduced-motion: `AtmosphereState.js:474-482`, `:809-810`, `:836`.
- Sky effects: `SkyRenderer.js:444-495` (godrays), `:731-777` (aurora), `:779-834` (shooting stars).
- Harbor effects: `HarborTraffic.js:1697-1716` (boomerang lifecycle), `2785-2803` (cast-off), `3105` (ship bob), `3524-3562` (lagoon buoy), `3746-3779` (bunting), `3826-3918` (finale: x-flash, cancelled, whirlpool, fireworks).
- Lighthouse beam: `IsometricRenderer.js:6661+`.
- Buildings: `BuildingSprite.js:276-292` (motion-scale plumbing), `1617-1640` (observatory clock), `2562-2587` (portal scanline), `2618-2622` (taskboard flutter), `2856` (entry-particle gate).
- Static building smoke fallback: `IsometricRenderer.js:2708-2735`.
- Foliage sway: `IsometricRenderer.js:3789-3825`.
- Sprite rain stamps: `IsometricRenderer.js:3994-4012`.
- Marine fish schools (silent skip): `IsometricRenderer.js:5818-5840`.
- Gull orbit (watchtower): `IsometricRenderer.js:6216-6259`.
- Open-sea flock: `IsometricRenderer.js:6042-6096`.
- Family tether / talk arcs / council ring: `CouncilRing.js:148-313`.
- Agent emotes, stance, retry, plan-mode glyphs, archive fade+sparkle, idle bob: `AgentSprite.js:1131-1260`, `1671-1696`, `2658-2696`, `2906-2929`, `3184-3397`, `3332-3346`.
- Familiar motes: `AgentSprite.js:3523-3588`.
- Wisp / completion cue / departure sigil: `ArrivalDeparture.js:111-473`.
- Seasonal particles: `SeasonalAmbience.js:78-132`.
- Chronicle fireworks + banner + monuments: `ChronicleMonuments.js:48-55`, `:470-556`.
- Chronicler: `Chronicler.js:36-100`; fallback scaffold `IsometricRenderer.js:6473-6493`.
- Particle system gate (relevant to gap #1): `ParticleSystem.js:178-188`.
- Camera reduced-motion: `Camera.js:14-19`, `:75-77`, `:151`.

## Risk Severity

| Gap | Severity |
| --- | --- |
| Chat ellipsis animates under reduced motion (#2) | **High** — visible, fully repeating motion bypassing the budget. |
| Seasonal-particle fallback is dead code (#1) | **High** — documented behaviour does not match runtime; ornamental but the file's own contract is broken. |
| Open-sea gulls may disappear entirely (#4) | **Medium** — loss of identity for an authored ambient cue. |
| Inconsistent motion source (#3) | **Medium** — works today but creates a real trap on the next refactor. |
| Archive shelf-fill door particles absence (#5) | **Medium** — read intensity cue becomes invisible. |
| Godrays missing inline comment (#6) | **Low** — documentation only. |
| Idle bob / selection-ring rely on implicit `frame` freeze (#7) | **Low** — works today, easy regression vector. |
