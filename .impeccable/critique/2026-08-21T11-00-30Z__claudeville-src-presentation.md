---
target: ClaudeVille presentation (World and Dashboard rendering)
total_score: 27
p0_count: 0
p1_count: 2
timestamp: 2026-08-21T11-00-30Z
slug: claudeville-src-presentation
---
# ClaudeVille Presentation Critique

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 4 | Excellent multi-channel state, especially waiting-on-user |
| 2 | Match system / real world | 4 | Buildings, agents, harbor, tools, and journeys form a memorable operational metaphor |
| 3 | User control and freedom | 3 | Pan, zoom, frame, follow, close, filter, and modes exist; several are undiscoverable and selection loses the prior camera context |
| 4 | Consistency and standards | 3 | Strong cross-mode identity; IDLE versus “Working at COMMAND” and WAITING versus ATTN weaken the grammar |
| 5 | Error prevention | 3 | The read-only product is inherently safe and stale/unavailable states are explicit |
| 6 | Recognition rather than recall | 3 | Projects, agents, statuses, and parent links are visible; icon controls and World shortcuts require recall |
| 7 | Flexibility and efficiency | 2 | Filtering and two modes help, but there is no visible attention-only workflow or compact/expanded Dashboard control |
| 8 | Aesthetic and minimalist design | 2 | Art direction is excellent; routine overlays and always-open histories exceed the attention budget |
| 9 | Error recovery | 2 | Errors and staleness are named, but recovery guidance is sparse |
| 10 | Help and documentation | 1 | Tooltips, empty-state legend, and changelog exist; no discoverable World grammar or controls guide |
| **Total** |  | **27/40** | **Acceptable: exceptional identity with significant glanceability work remaining** |

## Anti-patterns verdict

### LLM assessment

ClaudeVille emphatically does not look AI-generated. World mode is unusually authored: specific silhouettes, terrain, lighting, character identities, movement, props, and a coherent “torchlit keep around a living village” frame. Dashboard is a familiar card grid, but it is an earned precision view with enough bespoke language to avoid SaaS-template territory.

The risk is not AI slop. It is authored abundance outrunning hierarchy. In busy states, too many lovingly made signals compete at once.

### Deterministic scan

The CLI detector returned 63 advisory `design-system-color` findings. Eight are plausible token drift: seven status literals in `CrowdClusterOverlay.js` bypass the canonical `STATUS_VISUALS` colors, and the Activity Panel carries a non-canonical error fallback. The other 55 are specialized canvas-art, foliage, light, monument, effort-aura, and seasonal colors. They are mostly false positives because `DESIGN.md` explicitly documents DOM chrome, not the canvas palette.

Browser injection reported 39 World findings and 190 Dashboard findings. The credible root issues are one active mode-button hover contrast conflict, a width transition on the context bar, and structurally real project → dossier → tool-history nesting. Most side-tab, tiny-type, glow, tracked-label, palette, and shadow findings are intentional parts of the committed pixel/torchlight system; 24 of 25 contrast warnings also treated translucent gradient stops as opaque surfaces.

### Visual overlays

The detector successfully injected into representative World and Dashboard views. A headed `[Human] ClaudeVille — Detector B` browser tab remains open with 115 overlays visible. The temporary detector server was stopped and its temp directory removed.

## Overall impression

ClaudeVille is already visually remarkable. It has the hard parts—identity, metaphor, atmosphere, semantic state, strong assets, and a real visual QA culture. Its single biggest opportunity is to stop treating the village as a flattened painting plus independent annotation layers. A semantic render graph should give each drawable both a salience role (what may speak now) and material/elevation data (how it receives light, weather, and occlusion). The first slice quiets routine overlays; the strategic slice renders the diorama GPU-resident so light and atmosphere become spatially truthful rather than more effects over a flat frame.

## What is working

1. The art direction is genuinely ownable. The live village delivers the “calm delight” and place-worth-leaving-open ambition.
2. Attention escalation is excellent. Waiting-on-user remains readable through words, shape, camera framing, sidebar state, topbar count, and the Activity Panel—not color alone.
3. Cross-mode identity is unusually coherent. Projects, provider/model identity, status, selection, parent relationships, and exact detail carry across World, sidebar, Dashboard, and modal surfaces.

## Cognitive load

Dense/live World fails five of eight checks: single focus, chunking, visual hierarchy, minimal choices, and progressive disclosure. Grouping, one-at-a-time inspection, and working-memory support pass. Empty state is low-load.

Decision points exceeding four visible choices include six topbar controls, 17–24 sidebar agent targets, six cards per dense project group, and the Activity Panel’s Pin/Close plus multiple disclosure controls.

## Emotional journey

- Arrival produces immediate delight; the village feels made, not themed.
- Empty state is calm and reassuring, although the four-building legend is duplicated in the sidebar and central overlay.
- Normal live state shifts from curiosity to fatigue as routine tool bubbles accumulate.
- Waiting-on-user is the experience peak: the exception becomes unmistakable without becoming alarming.
- Inspection rewards curiosity with a hero portrait and exact data, then loses orientation when follow zoom and the right panel remove most map context.
- Closing inspection is clear, but does not restore the prior overview pose.

## Priority issues

### [P1] Routine overlays overwhelm the village’s semantic hierarchy

**Why it matters:** The core second-monitor promise is peripheral comprehension. At 17 and 24 agents, routine tool bubbles, landmark plaques, routes, sprites, and relationship marks obscure one another and the village art beneath them. World remains in full mode below 50 agents, while separate label systems make independent admission decisions.

**Fix:** Extend `MarkGovernor` into one screen-space salience/LOD budget covering speech, tool labels, building plaques, route text, relationship marks, particles, and local light emphasis. Rank selected, needs-you, and errored above recent, working, and ambient. Trigger compact mode from occupied screen area and collision pressure, not a population threshold. Show routine tool text on hover/selection; exceptions always survive.

**Suggested command:** `$impeccable distill`

### [P1] Dashboard prioritizes transcript detail before operator triage

**Why it matters:** The real 1440px view shows only four agents before long per-card histories dominate the screen. Nested card scrollers make the precision mode slower to scan than its purpose implies.

**Fix:** Default to compact dossiers: identity, actionable reason, current task, elapsed time, and burn. Expand history only for the selected card. Add one attention queue above projects ordered Needs you → errored/rate-limited → high burn → working → quiet.

**Suggested command:** `$impeccable distill`

### [P2] The GPU receives a flattened final frame, capping beauty and wasting headroom

**Why it matters:** The WebGL2 stage can tint, blur, distort, bloom, and place radial lights, but it cannot distinguish roof, foliage, water, skin, rune, emissive window, height, or occluder. It also uploads the entire Canvas-2D frame every render. Local profiling saw this force the post-effects ladder to disabled even in a one-agent case and become dramatically worse in dense-100. More post-effects would add spectacle while making neither materials nor depth more coherent.

**Fix:** Incrementally move asset-backed drawables into a GPU-resident WebGL2 diorama behind a flag. Preserve domain state, camera, hit testing, `DrawablePass`, Canvas fallback, and the ungraded overlay. Add optional packed material/emissive/height sidecars only for landmarks and hero props first; run existing grade/bloom/water work in the same context with no full-frame Canvas upload.

**Suggested command:** `$impeccable overdrive`

### [P2] Selection and operator language sacrifice orientation and consistency

**Why it matters:** Selection zoom plus the 320px detail panel creates a dramatic close-up but removes surrounding landmarks, and closing it does not return to the prior overview. Separately, IDLE can coexist with journey copy saying “Working,” while `0 WAITING` and `1 ATTN` look contradictory.

**Fix:** Add a panel-safe inspection composition, save/restore the prior camera pose, and let background plaques yield around the selected agent. Define one operator vocabulary: idle movement is Visiting/Roaming/At Command; rename ATTN to NEEDS YOU and reserve WAITING for non-human waits.

**Suggested command:** `$impeccable clarify`

### [P2] Power controls and the World grammar are largely invisible

**Why it matters:** Pan, zoom, frame, replay, attention cycling, and Escape exist but are not taught. The primary canvas has no accessible summary, while the smallest text is difficult for low-vision use.

**Fix:** Add a compact controls/legend popover and first-run hint, expose the World’s current semantic summary in DOM, and announce action-needed selection changes. Preserve Dashboard as the full semantic alternative.

**Suggested command:** `$impeccable onboard`

## Persona red flags

### Alex — power user

- Useful accelerators exist, but `A`, `F`, arrows, `+/-`, `R`, and Escape are undiscoverable.
- Text filtering is good; attention/status/burn filters are absent.
- Inspecting several agents incurs repeated large camera moves.
- Long, separately scrolling Dashboard histories turn triage into repeated scrolling.

### Sam — keyboard, screen reader, or low-vision user

- The primary canvas lacks an accessible name, description, or live semantic representation of buildings and agents.
- Dashboard/sidebar semantics and modal focus behavior are strong; World state changes are not exposed through an obvious live region.
- The 5–7px dense text is difficult for low vision.
- Global keyboard controls are undocumented.

### Solo multi-agent developer — project-specific

- Completed and routine working agents consume much of the same visual budget as agents needing intervention.
- “Is anything stuck, waiting on me, or burning tokens?” is split across topbar, sidebar, World, and dossier.
- Raw commands and histories are useful on inspection but counterproductive in ambient mode.
- Waiting-on-user is exactly the right escalation model; routine working state should be much quieter by comparison.

## Minor observations

- Empty World and sidebar duplicate the same four-building legend.
- “No usage data” still leaves six empty token cells.
- Dashboard nested scroll areas weaken otherwise excellent project grouping.
- Browser-title attention count is a particularly smart second-screen cue.
- One mode-button active-hover contrast state needs correction.
- The context usage bar animates width rather than a compositor-friendly transform.
- Eight semantic color literals should join the canonical token authority; the remaining detector color findings are mostly intentional canvas palette details.

## Questions to consider

- Should World narrate every working agent, or only exceptions, recent change, and the selected character?
- What would happen if Needs you were the only loud global state?
- Would losing always-visible tool history be worth showing two or three times more agents above the Dashboard fold?
- Is selection meant to be a cinematic close-up, or unit inspection without losing the map?
- Can a light, fog bank, or reflection exist if the renderer cannot say which surface receives or blocks it?
