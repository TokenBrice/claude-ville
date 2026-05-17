# Git/Harbor Flow — Council Research

Date: 2026-05-17
Status: reference
Baseline HEAD: e919f845c5074487c694d6aa163968df48728de1
Initial git status: ` M AGENTS.md\n M CLAUDE.md`

## Method

Direct read of the parsing layer (`claudeville/adapters/gitEvents.js`, plus `claude.js`, `codex.js`, `gemini.js`) and the visual layer (`HarborTraffic.js`, `ArrivalDeparture.js`, `Chronicler.js`, `ChronicleMonuments.js`, `MonumentRules.js`, `AuroraGate.js`, `ChronicleStore.js`, `GitEventIdentity.js`, `RepoColor.js`). Cross-referenced building definitions (`buildings.js:226–283`), scenery harbor anchors (`scenery.js:30–110, 207–384`), and the asset manifest. Cross-referenced active and deferred plans (`harbor-capacity-phase-b.md`, `harbor-capacity-expansion.md`, `chronicle.md`, `north-lagoon-sprint.md`, `world-enhancement-plan.md`).

## Git-Event Coverage Matrix

| Git operation | Parsed? (gitEvents.js evidence) | Visualised? | Fidelity 1–5 | Notes |
| --- | --- | --- | --- | --- |
| `commit` | yes — `GIT_EVENT_TYPES` set (gitEvents.js:4) | yes — ship spawns at berth (HarborTraffic.js:1268–1297) | 4 | Commit message → ship `label`, SHA fallback to short hex; multi-line heredoc subjects are cleaned (GitEventIdentity.js:25–48). |
| `push` (success) | yes — exit-code or `success`/`succeeded` normalised (GitEventIdentity.js:78–96) | yes — ships flip to `departing`, sail along lane bands, finale ring effect, screen summary (HarborTraffic.js:1300–1458, 2760–2825) | 4 | Lifecycle is rich: stagger, fade, exit-hold. |
| `push` (failed) | yes — non-zero exit / fail keywords | yes — docked ships keep red X, finale draws an X-in-circle, summary banner red (HarborTraffic.js:2669–2691, 2777–2787) | 3 | Failure marker has no time-cap (deferred per Phase A reviewer note). |
| `push --force` / `push +<ref>` | partial — `normalizeRefName` strips the leading `+` (gitEvents.js:324–333) so the *event* records but no `force` flag is set | no — no force-specific visual | 1 | Force-push collapses into a normal push; the destructive intent vanishes. |
| `push --dry-run` / `-n` | parsed and **omitted** (gitEvents.js:296–303, 431–433) | n/a | n/a | Correct. |
| `pull` | **no** — type not in `GIT_EVENT_TYPES` (gitEvents.js:4) | no | 1 | Incoming integration is invisible. |
| `fetch` | no | no | 1 | Same as pull. |
| `merge` | no | no | 1 | Merge commit shows as a commit; the merge act itself does not surface. |
| `rebase` | no | no | 1 | Rewritten history is silent. |
| `stash` (push/pop/drop) | no | no | 1 | No representation. |
| `branch checkout` / `switch` | no | no | 1 | Branch context comes only via `currentBranch()` cache (gitEvents.js:619–630). |
| `tag` | parsed only in `MonumentRules._releaseStone` filter (MonumentRules.js:111–125) and `ChronicleMonuments._collectPushEvents` (ChronicleMonuments.js:199–212) | indirectly — release monument planted in harbor district | 2 | Tag push that matches `v?\d+\.\d+` plants a release stone, but tagless tagging is uncovered. |
| `gh pr create` / `gh pr merge` / `gh pr close` | no — only `git` binary tokens parsed (`findGitCommand`, gitEvents.js:259–294) | no | 1 | PRs are invisible; merging via GitHub UI is also invisible. |
| `revert` | no (creates a commit but its semantic is lost) | partial (renders as another commit ship) | 2 | The "unwind" narrative is absent. |
| `cherry-pick` | no | partial (renders as commit) | 2 | Same. |
| `reset` / `reset --hard` | no | no | 1 | Destructive rewriting goes unseen. |
| `bisect` | no | no | 1 | — |
| `init` / `clone` | no | no | 1 | No "new repo arrives" beat. |
| `submodule update` | no | no | 1 | — |
| Inferred unpushed commit (rev-list ahead) | yes — `readUnpushedCommitEvents` (gitEvents.js:786–839) | yes — flows through normal commit path | 4 | Smart — picks up commits made outside an agent session. |
| Inferred "already pushed" (rev-list ahead=0) | yes — `syntheticPushForProject` (gitEvents.js:730–769) | yes — synthetic push event drives departure | 4 | Catches pushes that happened off-camera. |
| `git status` / `git diff` / `git show` (read-only) | not a git *event*, but adapter detects via `isHarborCrateTool` (HarborTraffic.js:259–262) | yes — harbor crate appears next to active dock when agent is at Harbor Master | 3 | Tied to building-presence; misses agents that diff without traveling to the Harbor. |

## Current State Verdict

The harbor metaphor for commits-as-ships and push-as-sailing-away is one of the strongest narratives in ClaudeVille: the asset library (`prop.harborShip.skiff` through `prop.harborShip.flagship`) maps cleanly onto pack size, the squad/anchorage layout disambiguates repos, and the Commit Lagoon vs. Harbor split gives the metaphor a "staging before the open sea" reading. The finale, screen summary, departure stagger, and per-repo accent flag (`_drawRepoFlag`, HarborTraffic.js:2693–2713) genuinely sell that "commits leave on a push." Where it breaks is breadth and gravity: the parser only knows two verbs (commit, push). Force pushes, PR merges, pulls, fetches, rebases, tags-without-pushes, and explicit branching are all either silent or quietly degraded into "another commit ship." The lighthouse is decorative (drawn by `_drawLighthouseBeam` but not tied to push state), and the celebratory beat at 1st-commit vs. 100th-commit is identical.

## Recommendations

### R1 — Force-push as a sinking with cannon-fire
- **Impact: High · Effort: M · Confidence: High**
- **Problem:** `git push --force` and `git push +refs/heads/main` collapse into a regular push. The "force" token is stripped by `normalizeRefName` (gitEvents.js:324–333) and never re-attached. A destructive overwrite reads the same as a polite push.
- **Proposal:** Detect force flags during `pushPositionals` (gitEvents.js:335–363). Add `--force`, `--force-with-lease`, `--force-if-includes`, and refspec leading `+` to a `force: true | 'lease' | 'safe'` property on the push event. In `HarborTraffic.reduceHarborTrafficState` push branch (HarborTraffic.js:1300–1458), when `event.force === true`, change finale path: instead of the success expanding rings (`_drawFinaleEffect`, HarborTraffic.js:2789–2814), shorten `DEPARTURE_MS` to ~12s and render the ship listing+sinking into a small whirlpool over the last 4s, with red-tinted spray particles. `--force-with-lease` should keep the normal departure but add a yellow heraldic banner on the flagship mast. Reuse `PUSH_STATUS_STYLE.failed` palette for `--force` but with `'source-over'` composition.
- **Touchpoints:** `gitEvents.js:335–378` (parser), `gitEvents.js:380–417` (`createGitEvent` to thread `force` through), `HarborTraffic.js:1300–1458` (status branching), `HarborTraffic.js:2760–2825` (`_drawFinaleEffect`), `GitEventIdentity.js:78–96` (push status normalization).
- **New assets:** Optional `atmosphere.water.whirlpool` particle preset (can reuse `ParticleSystem` defaults initially).
- **Dependencies:** None.
- **Validation hook:** Inject `{type:'push', force:true, ...}` via `window.__harbor.state = reduceHarborTrafficState(...)`. Confirm whirlpool finale.

### R2 — Pull/fetch as incoming ships from the open sea
- **Impact: High · Effort: M · Confidence: High**
- **Problem:** Pull and fetch are completely invisible. Yet they are the *symmetric* operation to push: cargo arrives instead of leaving. The empty east edge (the `DEPARTURE_EDGE_Y = 2.8` exit line in HarborTraffic.js:232) is the natural inbound lane.
- **Proposal:** Extend `GIT_EVENT_TYPES` (gitEvents.js:4) to `['commit', 'push', 'pull', 'fetch']`. Add `pull`/`fetch` events that animate an inbound ship that enters from the same north edge that pushes exit through, sails down through the existing `LOCAL_WATER_ROUTE_BANDS` in reverse, and unloads at an empty berth. The ship can carry crates emblazoned with the count of incoming commits (parsed from `rev-list HEAD..@{u}` in a follow-up enrichment, mirroring `readUnpushedCommitEvents` at gitEvents.js:786–839 but counting incoming). A `fetch` without merge shows the ship arriving at the *outer roadstead* (HARBOR_SQUAD_ANCHORAGES `outer-roadstead` entries, HarborTraffic.js:79–82) and waiting; `pull` continues all the way to a quay.
- **Touchpoints:** `gitEvents.js:4, 365–378` (parser), `HarborTraffic.js:113–146` (sea lanes — reverse), `HarborTraffic.js:1248–1300` (reducer add inbound branch), new helper `composeInboundRouteTiles`. Add `'arriving'` to the ship status enum.
- **New assets:** None.
- **Dependencies:** R5 (multi-repo flags) so the inbound ship's heraldry matches.
- **Validation hook:** Run `git fetch origin` while an agent watches the project; expect a ship to enter from the north and dock.

### R3 — Push lifecycle audit: clearer prep → load → cast off → sail → fade
- **Impact: Medium · Effort: S · Confidence: Medium**
- **Problem:** Today's lifecycle: ship spawns docked, sits, eventually `pushStatus` flips, ship is reassigned `departing`, `departStartedAt` is set, sprite walks the route via `pointAlongPath`, then fades over `EXIT_FADE_MS = 4200`. There is no "loading" beat — the cargo crates are static, identical at all times. The "cast off" moment is invisible (no rope snap, no mast-rotation). The fade is uniform on every push regardless of how dramatic the push is.
- **Proposal:** Stage the first ~1500 ms of departure as a "casting off" phase: hold the ship at berth, animate the `_drawMooringTick` (HarborTraffic.js:2658–2667) snapping (vertical bar shrinks to 0 with a small puff particle), and stutter-step the ship 8 px east before `departStartedAt`. For the actual sail, scale `DEPARTURE_MS` with commit pack size: `48000 + Math.min(20000, packSize * 1200)` so a 10-commit push has a longer "weight" to its departure. Add a brief upward flag-flutter at the moment the ship leaves the berth — flagship/dreadnought get a second pennon raised. Fade-out: instead of straight alpha, fade through a sea-mist sprite the last 800 ms.
- **Touchpoints:** `HarborTraffic.js:1454–1457` (departStartedAt math), `HarborTraffic.js:2600–2605` (`_departureAlpha`), `HarborTraffic.js:2658–2667` (mooring tick).
- **New assets:** Optional `atmosphere.water.seamist`.
- **Dependencies:** None.
- **Validation hook:** Visually compare 1-commit vs. 10-commit push; the latter should read heavier.

### R4 — Push rejected / non-fast-forward distinguished from generic failure
- **Impact: Medium · Effort: S · Confidence: High**
- **Problem:** A network-down push and a server-side rejected push (non-fast-forward) both fall into `pushStatus === 'failed'` (GitEventIdentity.js:78–96). They have very different remediation paths: network fail = retry; rejected = pull + reconcile.
- **Proposal:** Pass exit code 1 with stderr clue into the push event by extending the adapters (claude.js, codex.js, gemini.js) to thread the tool result's stderr/text into `context.stderr`; in `GitEventIdentity.normalizePushStatus`, distinguish `'rejected'` (stderr contains "rejected"|"non-fast-forward"|"failed to push some refs") from `'failed'`. In `PUSH_STATUS_STYLE` (HarborTraffic.js:235–257), add `rejected` with a distinct visual: ship boomerangs out to the harbor mouth then turns around and re-docks at its original berth, leaves a red collision flare at the mouth, gets a yellow caution flag (use `prop.harborBeaconBuoy` pulse).
- **Touchpoints:** `GitEventIdentity.js:78–96` (status), `claude.js:520–525`, `codex.js:597–605`, `gemini.js:286–303` (thread stderr), `HarborTraffic.js:235–257` (style), `HarborTraffic.js:1444–1457` (status branch).
- **Dependencies:** Adapter-level changes; minor.
- **Validation hook:** Force a non-FF state (`git push` after upstream advanced), confirm the boomerang.

### R5 — Multi-repo / multi-branch disambiguation via heraldry
- **Impact: Medium · Effort: M · Confidence: Medium**
- **Problem:** `RepoColor` already provides stable hashed accents per project and per branch (RepoColor.js:32–66, 113–135), and `_drawRepoFlag` (HarborTraffic.js:2693–2713) renders a small triangle pennant with branch variant stripe. But when 4 repos × 2 branches each are docked, all 8 flags look like tiny coloured triangles — readable up close but not glance-friendly.
- **Proposal:** Replace the triangle with a *heraldic shield* sprite per repo, generated once via pixellab using `RepoColor.repoProfile(project).hue` as the base hue. Cache in `AssetManager` keyed by `profile.hash`. The shield carries a 2–3 char repo initials (already derived as `profile.shortName`). Branch variant = add a sash band at the bottom. Render the shield on the flagship of each squad (`squad.ships[0]`) instead of, or in addition to, the pennant. Also add a small *bunting line* between adjacent docked ships of the same repo — visually unifies a squad without changing layout.
- **Touchpoints:** `HarborTraffic.js:2693–2713` (flag), new helper `_drawRepoShield`, `RepoColor.js` (expose hue for sprite tinting), `AssetManager` (dynamic tint cache — reuse `Compositor` palette swap path).
- **New assets:** `prop.repoShield` (single base sprite, hue-shifted at render).
- **Dependencies:** Compositor palette-swap is already in use for character accessories.
- **Validation hook:** Pipe in 4 repos × 2 branches via the debug harness; ensure shields are distinct at zoom 1.

### R6 — PR open / merge / close (requires adapter changes)
- **Impact: High · Effort: L · Confidence: Medium**
- **Problem:** `gh pr create`/`gh pr merge` are completely invisible because the parser only listens for the `git` binary token (gitEvents.js:262). Yet PRs are arguably more important to a workflow than raw pushes — they are the *acceptance* beat.
- **Proposal:** Add a sibling parser for `gh pr` in `gitEvents.js`. New event types: `'pr-open'`, `'pr-merge'`, `'pr-close'`. `MonumentRules.classify` already accepts `pr-merge` (MonumentRules.js:111) but never receives it. Visual: a PR open animates a *signal flare* shot from the agent's current position toward the lighthouse; the lighthouse beam holds steady on the originating squad. A PR merge animates the *Harbor Master door* opening (sprite frame swap) and the agent's flagship hoisting a green "MERGED" banner before its scheduled departure. A PR close (without merge) animates the ship sailing back out to the *outer roadstead* and dropping anchor.
- **Touchpoints:** `gitEvents.js:259–294` (new `findGhCommand`), all three adapters (already pass `command` strings — no change needed if the parser picks up `gh`), `MonumentRules.js:111` (already handles `pr-merge`), `HarborTraffic.js` (new visual handlers), `buildings.js:253` (Harbor Master door state).
- **New assets:** `prop.harborMaster.doorOpen` frame.
- **Dependencies:** Depends on lighthouse (R8) being signal-capable.
- **Validation hook:** `gh pr merge --squash` while watching the dashboard; expect the merge ceremony.

### R7 — Tag / release celebrated with proper firework
- **Impact: Medium · Effort: S · Confidence: High**
- **Problem:** `MonumentRules._releaseStone` (MonumentRules.js:125–135) plants a "release" monument in the harbor district when a push has a `targetRef` matching `v?\d+\.\d+`. That stone is silent — no event marks the planting moment. `AuroraGate.recordMilestone` (AuroraGate.js:44–52) is wired for release/verified weights but only fires the aurora once per local day.
- **Proposal:** On every release stone plant (the `ChronicleMonuments.planter.processEvents` return value, ChronicleMonuments.js:53–65), emit a `harbor:release-burst` event that triggers a *fireworks ring* finale over the harbor for 6s — three concentric expanding rings tinted in the release color (`KIND_COLORS.release = '#80e8ff'`, ChronicleMonuments.js:9). Independent of the daily aurora, so consecutive releases each get their own burst. Also play it during the *first commit in a brand-new repo* (detect via `repoQuays` having no prior entry for the project).
- **Touchpoints:** `ChronicleMonuments.js:53–65`, `MonumentRules.js:125–135`, `HarborTraffic.js:2760–2825` (finale palette), new constant `RELEASE_FINALE_MS`.
- **Dependencies:** None.
- **Validation hook:** `git tag v1.0.0 && git push --tags`; expect fireworks.

### R8 — Lighthouse signalling: functional, not decorative
- **Impact: Medium · Effort: M · Confidence: Medium**
- **Problem:** The Pharos Lighthouse exists (buildings.js:226–252, `_drawLighthouseBeam` IsometricRenderer.js:6210). Its beam rotates per atmosphere but ignores git state. It is a beautiful prop that does no work.
- **Proposal:** Couple the beam to push lifecycle:
  - Idle: slow rotation, default warm hue.
  - Active push in progress (any ship departing): beam *locks* on the departing squad until it crosses `DEPARTURE_EDGE_Y` (HarborTraffic.js:232). Hue shifts to `PUSH_STATUS_STYLE.success.accent`.
  - Push failed/rejected: beam strobes red (`PUSH_STATUS_STYLE.failed.accent`) for 8s.
  - No remote configured (detected via `branchUpstream` empty in `gitEvents.js:636–640`): beam dims and fog (use existing weather fog path) drifts in. Visualises "this repo is shouting into the void."
  - Repo has unpushed commits (Commit Lagoon non-empty for >5 min): beam slowly pulses to draw the eye.
- **Touchpoints:** `IsometricRenderer.js:6210` (`_drawLighthouseBeam`), `HarborTraffic.js` (new public `getActivePushSignal()`), `gitEvents.js:660–684` (`branchComparison.hasUpstream`).
- **Dependencies:** R4 (rejected status) for the strobe path.
- **Validation hook:** Push a non-FF, watch the beam strobe red.

### R9 — Chronicle stone aesthetics & info density
- **Impact: Low · Effort: S · Confidence: High**
- **Problem:** `ChronicleMonuments.tooltipFor` returns a flat `kind stone - repo - label - days old` string (ChronicleMonuments.js:149–156). The visual is a single procedural sprite (ChronicleMonuments.js:99–136) regardless of how significant the milestone is. The MonumentRules `weight: 'major'|'medium'|'minor'` (MonumentRules.js:130–148) isn't honored visually.
- **Proposal:** Use sprite variants per `weight`: `monument.stone.major` (waist-high obelisk, glowing inset), `monument.stone.medium` (knee-high), `monument.stone.minor` (small cairn). On hover, replace the flat string with a small popover styled like the harbor screen summary — repo flag, label, age, kind icon. On click, scroll a side-panel with the commit message in full and a link to the SHA in GitHub (open `origin` URL with the SHA appended; fall back to local copy if no remote).
- **Touchpoints:** `ChronicleMonuments.js:99–155` (draw, tooltip), `manifest.yaml` (3 new sprite IDs), new `ChronicleMonumentPanel.js` modal.
- **New assets:** `monument.stone.major/medium/minor`.
- **Dependencies:** None.
- **Validation hook:** Generate 7 commits with `feat:` prefix → all plant in forge district → click each to see a unique panel.

### R10 — Lagoon vs Harbor — legibility of the staging metaphor
- **Impact: Medium · Effort: S · Confidence: Medium**
- **Problem:** The Commit Lagoon (HarborTraffic.js:62–73) collects pending commits before they head to the Harbor; `_drawCommitLagoonSign` (HarborTraffic.js:2848–2879) places a "COMMIT LAGOON" sign with the repo name and count. But the *flow* between the two basins is implicit — `_observeStorageTransfers` (HarborTraffic.js:1744–1809) animates the lateral move with a small wake but no tooltip or signage marks the journey. To a new user it looks like ships just teleport.
- **Proposal:** Add a single visible *channel marker* (use `prop.harborBeaconBuoy` instances) at the lagoon→harbor seam (~tile 26, 6) pulsing in the repo accent of whichever ship is currently in transit (read from `this.storageTransfers`). When the channel is dry, the buoy is muted. On hover, "X commits from <repo> flowing to harbor — push to release."
- **Touchpoints:** `HarborTraffic.js:1744–1809` (transfer observation already exists), `scenery.js:367–372` (add buoy or instantiate from HarborTraffic), new draw helper.
- **Dependencies:** None.
- **Validation hook:** Cause a transfer (commits accumulating beyond a threshold pushes into lagoon), confirm the buoy pulses.

### R11 — Edge cases: empty repo, no remote, detached HEAD, amended commit
- **Impact: Medium · Effort: S · Confidence: High**
- **Problem:**
  - *Empty repo*: no commits, nothing renders, fine.
  - *No remote* (`branchUpstream` returns empty, gitEvents.js:636–640): commit ships pile up forever in the harbor with no push ever happening. The user gets no hint of the cause.
  - *Detached HEAD*: `currentBranch()` returns empty (gitEvents.js:619–630); commits made in detached state are linked to `branch: ''` which `eventBranch` returns `''` for — they bucket into the project-level traffic identity (`trafficIdentity(project, '')`) but `RepoColor.repoBranchProfile` falls back to base profile. Result: ships render but are indistinguishable from main-branch ships.
  - *Amended commit*: a new commit event with the *same* commitTextsEquivalent label and a close timestamp is merged into the existing ship via `findExistingCommitShip` (HarborTraffic.js:1025–1030). But the user sees no acknowledgement of the amend.
- **Proposal:**
  - No remote: when `hasUpstream === false` for >2 docked commits, render a small "untethered" pennant (broken rope sprite) on the squad flagship, hover: "No remote — `git remote add origin <url>` to enable push." Also tie into lighthouse fog from R8.
  - Detached HEAD: tag the ship's flag with a black-and-white checkered band; tooltip: "detached HEAD — commit will be lost without a branch." Already detectable by checking that `currentBranch()` returns empty *and* commits exist.
  - Amended commit: when `mergeCommitIntoShip` (HarborTraffic.js:1032–1046) updates an existing ship, briefly flash the ship hull in the repo accent for 400 ms and increment an `amendCount` counter rendered as a small superscript on the flag.
- **Touchpoints:** `gitEvents.js:619–684` (detection), `HarborTraffic.js:1025–1046, 2693–2713` (visualisation), new `prop.brokenRope` and `prop.checkeredBand` sprites or simple proceduralised marks.
- **Dependencies:** R8 (fog).
- **Validation hook:** `git init && touch f && git add . && git commit -m "x"` (no remote) → broken rope visible.

### R12 — Emotional beat: first commit vs. 100th commit
- **Impact: Low · Effort: S · Confidence: Medium**
- **Problem:** Every commit looks the same. Every push fades the same way. A user's *first* commit to a new repo and their *100th* push of a long-running feature land identically. The reducer only differentiates by ship class (HARBOR_SHIP_CLASSES tiers, HarborTraffic.js:41–49) which keys on commit count *in the push*, not in the repo's history.
- **Proposal:** Maintain a `lifetimeCommitCountByProject` map in `ChronicleStore` (similar to monuments, already persisted). Milestones:
  - 1st commit in repo: ship anchored in the *Inner Quay Basin* (HarborTraffic.js:76) gets a brief "Maiden Voyage" banner.
  - 10th: small ribbon.
  - 100th: a flagship-sized commemorative banner with the repo name; lighthouse beam holds on it for 4s.
  - 1000th: trigger the daily aurora (force `AuroraGate.evaluate` with `signals.majorVerified = true`).
- **Touchpoints:** `ChronicleStore.js:5–13` (new `lifetimeCounts` store), `MonumentRules.js` (new tier), `HarborTraffic.js` (banner draw), `AuroraGate.js:64–78` (trigger pathway already exists).
- **Dependencies:** None.
- **Validation hook:** Stub `lifetimeCommitCountByProject` via `window.__chronicle.put`; confirm flagship banner.

## Quick Wins (≤1 day each)

- **QW1.** Strip the leading `+` *and* set `event.force = true` in `normalizeRefName` (gitEvents.js:324–333). Even without a visual yet, this unlocks every downstream consumer.
- **QW2.** Add `pull`/`fetch` to `GIT_EVENT_TYPES` and parse without yet rendering — just observe via `console.info` how often they fire to size the inbound-ship effort.
- **QW3.** In `_drawCommitPennant` (HarborTraffic.js:2715–2758), increase the contrast of `profile.labelText` against the panel background for repos whose hue lands at low contrast (use `profile.labelLightness` already computed in RepoColor.js).
- **QW4.** In `tooltipFor` (ChronicleMonuments.js:149–156), include the SHA short-hex and project name; today it shows only kind + label + days.
- **QW5.** In `screenSummary` title (HarborTraffic.js:2300–2305), surface the *branch* and the *target ref* when they differ from the branch — already partially handled but truncated at 56 chars (`shortGitLabel(title, 56)`) which clips long branch names.
- **QW6.** Replace `RECENT_PUSH_REPLAY_MS = 2 * 60 * 1000` (HarborTraffic.js:26) with a longer window for releases — e.g., 24h — so a tag push that happened during a brief tab-close still gets a finale on reload.

## Bugs / Defects Observed

- **HarborTraffic.js:1497** — `if (typeof window !== 'undefined') window.__harbor = this;` runs inside the `HarborTraffic` constructor unconditionally. Each `new HarborTraffic({sprites})` overwrites the prior global. Severity: **low** in production (only one instance), but it makes hot-reload during dev brittle. Per Phase B plan the hook was meant to be debug-only; ship a `localStorage.getItem('claudeVilleDebug')` gate.
- **HarborTraffic.js:730–769 (`syntheticPushForProject`)** — the inferred push's `sourceId` is `'git-upstream-status'` for every project. If a renderer keys per source it collapses across repos; today this is fine because `id` is project+upstream-hashed, but any future log/audit that groups by `sourceId` will under-count.
- **HarborTraffic.js:1300–1320 (push reducer)** — `previousStatus && incomingStatus === 'unknown'` keeps the previous status, which is correct, *but* `statusChanged = previousStatus && previousStatus !== status` is then compared after that swap. Logic is fine; document with a comment to prevent regression.
- **HarborTraffic.js:1448 (`ship.departStartedAt`)** — when status flips success after a prior unknown, the `ship.departStartedAt || startedAt + departSquadIndex * DEPARTURE_STAGGER_MS` keeps an old `departStartedAt` if it was set during the unknown phase. If unknown ever started a fake departure, the success departure replays the same start, possibly far in the past, instantly fading. Severity: **medium**; mitigated today because `status !== 'success' && status !== 'failed'` returns before assigning `ship.status='departing'`, but the contract is fragile. Recommend: clear `ship.departStartedAt = null` when entering the success branch the *first* time only.
- **HarborTraffic.js:1462–1468 (departing cleanup)** — `now - startedAt > DEPARTURE_MS + FADE_DELAY_MS + EXIT_FADE_MS + EXIT_HOLD_MS` deletes the ship, but the corresponding `state.batches.delete(id)` only runs if `age > SCREEN_SUMMARY_MS + FINALE_EFFECT_MS + DEPARTURE_MS`. Constants differ (`DEPARTURE_MS + FADE_DELAY_MS + EXIT_FADE_MS + EXIT_HOLD_MS = 48 + 3.2 + 4.2 + 1.8 = 57.2s` vs `SCREEN_SUMMARY_MS + FINALE_EFFECT_MS + DEPARTURE_MS = 16 + 9 + 48 = 73s`). Result: a ship is deleted *while its batch still exists*; `_batchOrigin` then has fewer `shipIds` to average across, drifting the finale anchor toward the HARBOR_FINALE_TILE fallback. Severity: **low**, mostly visual. Consider unifying constants or sealing batch.origin at delete time.
- **HarborTraffic.js:1731–1742 (`_observePeakDensity`)** — leaks `console.info` to production. Phase B intended this for a one-week observation. Add a `localStorage` gate or guard with `if (window.__claudeVilleDebug)`.
- **gitEvents.js:419–440 (`parseGitEventsFromCommand`)** — multi-line heredoc commit messages with `&&`/`;` inside the body get split by `splitShellCommands` (gitEvents.js:158–204). The current heuristic respects shell quotes but not `<<EOF` heredocs. A commit like `git commit -m "$(cat <<EOF\nfeat: x\n\nBody with && in it\nEOF\n)"` *may* split mid-message. The `cleanCommitSubject` regex (GitEventIdentity.js:25–48) does scrub the heredoc envelope, but the *upstream* tokenizer may have already cut the command. Severity: **low** in practice — verify via debug hook.
- **HarborTraffic.js:1497, 1731** — the `window.__harbor` exposure and the `_observePeakDensity` log are both Phase B instrumentation that were not gated by the planned debug flag. Either ship the gate or close the loop and remove instrumentation once Phase A decision is made.
- **ChronicleMonuments.js:204** — push events tagged with `type: 'tag'` are forwarded but `event.targetRef` may not satisfy `targetReleaseRef` (MonumentRules.js:43–46) for non-semver tags like `'2024-Q3'`. Tags like that produce no monument. Severity: **low**, document the regex contract.
- **GitEventIdentity.js:78–96 (`normalizePushStatus`)** — the keyword lists ("cancelled", "canceled", "timed_out", "timeout") map to `'failed'`. A cancelled push is conceptually different from a failed push; consider a `'cancelled'` status with its own (greyed-out) ship return-to-berth animation.

## Cross-Domain Coordination

- **Buildings (Council #3):** Harbor Master (`buildings.js:253–283`) and Pharos Lighthouse (`buildings.js:226–252`) both have entrance + visitTiles but the *interior* is never shown. Council #3 should consider:
  - A pop-up "Harbor Master ledger" panel on building click that lists all pending commits across repos with click-to-jump.
  - A lighthouse interior modal with the current upstream-tracking state per project: which branches have upstreams, ahead/behind counts, and which repos have no remote.
  - The Harbor Master door should swap to an `open` frame when an agent is *inside* (R6 PR-merge ceremony).

- **Behavior (Council #2):** Agents that commit/push should have a visible lead-up. Today the ship spawns when the git event fires, but the *agent* may have been at the Code Forge or the Task Board moments before. A tiny "marching to the harbor" path overlay (reusing the existing `TrailRenderer` planned in `chronicle.md` Sprint D) between the agent's current tile and the Harbor Master entrance would seal the "this agent just committed" loop. Coordinate with Council #2 on whether the agent visibly *carries* a small box to the harbor before the ship appears.

- **Visual (Council #1):** Several effects need atmosphere support:
  - Fog when no remote (R8/R11) — already exists in WeatherRenderer; need a per-region trigger.
  - Whirlpool particles (R1) — extend `ParticleSystem` with a new emitter.
  - Mist for fade-out (R3) — new sprite or particle preset.
  - Fireworks for tags (R7) — new emitter, reuse finale palette.

- **Portal/Subagent + Code Health (Council #6):** Replay impact at load. The HarborTraffic reducer already filters `isHistoricalCommittedBeforePush` (HarborTraffic.js:933–941) with a 2-minute window. But when many sessions are loaded fresh after a tab restart, every project's commit+push history gets pumped through `reduceHarborTrafficState` in a tight loop on first `update`. Each call walks all ships and runs a full `buildDockSquadLayout` (`dockLayout.byShipId` is recomputed and `relaxDockShipLayout` does up to 14 iterations across all docked ships). For a user with 200 unpushed commits across 8 repos, the first paint includes a heavy O(n²) relax pass. Council #6 should audit:
  - Memoise `buildDockSquadLayout` keyed on (ship ids set hash, ship statuses); only rebuild on change.
  - Skip `_observePeakDensity` console.info in production (see bug above).
  - The `assignedQuayIndex` quay-balancing loop (HarborTraffic.js:364–389) is also O(repos × ships) per repo lookup; cache the result more aggressively.
  - The unpushed-commit enrichment in adapters spawns `execFileSync` per project per refresh (gitEvents.js:585–604, called from `inferUnpushedGitEventsForSessions`); already has a 5s TTL cache but a 30-second cache or watch-mode would be cheaper for repos that aren't actively committing.

## Council Debate Stance

Top 3 picks, prioritised for impact-per-effort and metaphor coherence:

1. **R1 (Force-push as sinking)** + **R4 (Rejected vs. failed)**. Together these fix the most jarring metaphor breakdowns: today a force-push reads as a normal push, and a rejected push reads as a generic crash. Both are addressable with a one-line parser addition (force flag + stderr threading) and a few new visual branches in `_drawFinaleEffect`. They surface destructive intent and reconciliation work — the two outcomes a developer most needs to *see* at a glance. The whirlpool/boomerang visuals also unlock an immediately legible story for the user. Combined effort: ~2 days; impact: completes the push-lifecycle vocabulary.

2. **R2 (Pull/fetch as incoming ships)**. The harbor's metaphorical symmetry is incomplete without inbound traffic. Pull is currently the dashboard's biggest blind spot — a user who runs `git pull` sees absolutely nothing. Adding inbound ships using the existing `LOCAL_WATER_ROUTE_BANDS` in reverse and an `'arriving'` ship status closes the metaphor's biggest gap. It also creates the natural pairing for R6 (PRs) and seeds the inbound-merge ceremony for later. Effort: ~3 days end-to-end (parser + reducer + reverse-route helper); impact: complete metaphor.

3. **R8 (Functional lighthouse)**. The Pharos exists; today it spins a beam and looks pretty. Coupling it to push state — lock on departing squads, strobe on failures, fog when remoteless — turns a decorative landmark into a meaningful HUD. This is the single highest *narrative coherence* return on the council: an actual sea watch. Effort: ~2 days; impact: turns a dormant asset into a primary signal.

The remaining picks (R3, R5, R6, R7, R9, R10, R11, R12) are sequenced behind these three because each either depends on the lifecycle vocabulary being complete (R3, R7, R12), the multi-repo signaling being unified (R5, R10), or builds on the lighthouse becoming a signal device (R6 PR ceremony). The two structural bugs (`departStartedAt` reset on success after unknown; batch vs. ship cleanup TTL mismatch) should be folded into whichever PR lands first — they cost nothing and reduce future debugging.
