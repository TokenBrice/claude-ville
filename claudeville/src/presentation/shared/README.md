# Shared Presentation Components

This directory contains UI components used by both World and Dashboard mode. Components communicate through the global `eventBus` and should avoid importing renderer-specific modules.

Desktop-only constraint: shared UI only needs to support browser widths of 1280px or wider. Keep validation and layout decisions scoped to desktop; do not add mobile breakpoints or responsive shrinking here.

## File Map

| File | Responsibility |
| --- | --- |
| `TopBar.js` | The 48px top bar: KPI stacks (a 22px numeral over an 8px caption, zeros dimmed to `--ink-4`), the attention slot (`#badgeAttention`, the only framed, lit KPI: one exact numeral and word per non-zero bucket — `NEEDS YOU`, `ERROR`, `LIMIT` — each in its status colour, framed in the colour of the first lit bucket, hidden at zero and while counts are pending), `TOKENS SEEN TODAY` as a separate KPI (new tokens this page observed today; lifetime totals stay on each row), a static fault rail whose length is the errored share of the fleet, the permanent FPS counter, and agent/usage event summaries. Counts read `–` while the `village:state` phase is STARTING or SYNCING, or DEGRADED with no agents, instead of a fabricated `0`. The connection chip (`connectionChip`) says `SYNCING` (never `LIVE` or green) while starting or syncing and `DEGRADED` when a source is unreadable. Owns the witness clock (`22:14 NIGHT` from the atmosphere snapshot with a stepped weather glyph, and a `SIM`/`FIXED` tag when the timeline is overridden), so the light outside the window has a stated cause. Mode button lookup and clicks belong to `application/ModeManager.js`. |
| `AmbientAudioController.js` | Opt-in sound facade: toggle button, AMBIENT/BGM mode button, volume slider, user-gesture unlock, tab-hidden suspend, localStorage persistence. Routes to the ambient `AudioDirector` or the continuous-music `BgmDirector` per the persisted mode. Owns the `Working N · Waiting M` working-section label beside the music control (`#topbarSoundSection`), written only when its counts change. Debug helper: `window.__claudevilleAudio()`. |
| `audio/` | Two sound systems over one `AudioEngine` (context + mix chain + duck). Ambient: `AudioDirector` (1 Hz world→layer mapping, cue routing; listens to `atmosphere:updated`, `village:scene`, `distress:watchtower`, `team:gather`, `chronicle:aurora`, `weather:storm-flash`) driving `layers/` (wind, rain, birds, crickets, village hum, tonal bed, songbook music composer). BGM: `BgmDirector` + `bgm/BgmPlayer` playing `bgm/BgmSongbook` — five original town themes in seamless gap-free loops with a time-of-day playlist, no ambience layers; `SignalLedger` working/actionable counts pick one of four arrangement sections (`rest`/`light`/`steady`/`full`), applied at the player's next four-bar boundary with the shipped 30s-quiet/4s-change hysteresis, and any actionable agent ducks the music at once. Shared: `cues/CueKit` + `CueGovernor` (rate-limited one-shots), `CueScore` (the admitted cues' real note times — `audio:cue-scheduled`, `cueNoteDue`, `scheduleAccent`; visual accents land on the notes, and a muted village gets the same score at the monotonic now), `MusicalScale` (tonal center). Deliberate exception to the no-renderer-imports rule: both directors import the pure, dependency-free `character-mode/AtmosphereState` (and ambient also `SeasonalAmbience`) so sound keeps tracking time/weather while the World loop is stopped. |
| `Sidebar.js` | Project-grouped agent list on a 16px rhythm (44px rows: status square, name over `state · Model` so the model is what clips, right-aligned short age; provider, model, team, and workflow in the row `title`), group headers as 8px eyebrows with a repo swatch and team swatches, selection mirror/toggle, persisted collapsed state, and the Harbor pending-commit ledger from `harbor:updated`. Names never take the repo accent; repo identity stays on the 3px rail and swatch. Only waiting-on-you and errored dots blink (stepped, static under reduced motion). Rate-limited rows also colour the sub-line. The empty list follows the village phase (`LISTENING…`, `SOURCES UNREADABLE`, `NOT OPENED`, `NO PROVIDERS FOUND`, `THE VILLAGE AWAITS`). Owns the exception shelf (`#attentionShelf`): only non-zero buckets, in the attention-plate words (`9 NEEDS YOU · 1 ERROR · 1 LIMIT`), with the two oldest names and ages, the rail and heading in the lead bucket's colour, click-to-select, hidden at zero. |
| `ActivityPanel.js` | Right-side 320px detail panel with selected-agent and selected-building modes. Agent mode is a character sheet: a static 64px integer-scaled portrait (`AvatarCanvas` `sheet`), a 16px name, a status line (`■ Waiting for you · 13s`), and a provenance line (`Sonnet · claude · general`); the Session block hides empty rows; Cost & Tokens lead with two 22px numerals and keep `estimate`/`provider`/`partial`/`default rate` and `INFERRED` labels verbatim; with no usage the cost reads `-` (`cost unavailable`) and the context-bar track is hidden — a numeral appears only for a provider-reported cost, a non-zero supplied estimate, or an estimate from tokens actually reported; LIVE, SCORE, and PLAY share one segmented well. Building mode renders the presence/signal/queue/purpose split once through `BuildingInstrumentModel.js`; agent mode adds the working-set bench (four file tiles with READ/WRITE and named overlaps, exact `+N files` overflow) and the SCORE control that publishes the spatial work score. |
| `BuildingInstrumentModel.js` | Pure building-instrument model: presence (domain visit test), work signal (assigned WORKING sessions), a deduplicated queue with states, and purpose — one field per fact, unknown denominators stay text-only. |
| `WorkWaterfallModel.js` | Pure causal-waterfall builder shared by the panel's Journey section and the World spatial work score: a row is `exact` only when the provider reported a duration or end timestamp, and silence after an event becomes a `stall` row instead of a longer bar. |
| `AgentSelection.js` | Shared selection event helpers and local selected-agent mirrors for presentation components. |
| `AgentPresentation.js` | Shared identity/status presentation, pixel SVG emblems, freshness/provenance labels, and reusable native text disclosures. |
| `EventShapes.js` | Authored event/district silhouettes (8×8 motifs padded onto the 16×16 grid) shared by Canvas stamps (`drawEventShape`), World label beacons and tool glyphs, and DOM icons (`eventShapeSvgPath`). One silhouette per event family; no family shares a shape. |
| `DomSafe.js` | DOM construction/replacement helpers used by App, Dashboard, Sidebar, Activity Panel, and presentation helpers. |
| `Formatters.js` | Status, path, number, cost, hash, and truncation formatting helpers. |
| `GitEventIdentity.js` | Shared git event labeling and identity helpers for harbor/git flows. |
| `SessionDetailsService.js` | Shared `/api/session-detail` and `/api/session-details` fetch dedupe, cache, stale fallback, and timeout handling. |
| `ModelVisualIdentity.js` | Provider/model/effort labels, sprite IDs, palette keys, colors, and effort accessories. Also resolves the stable per-agent signature (`agentSignature`, a pure function of agent id + sprite family) that survives hero body, compact body, and impostor diamond so one individual stays followable through zoom. |
| `RepoColor.js` | Project/repository colour on the status-free C1 `PENNANT_PALETTE` (`config/artPalette.js`; eight hues at HSL 340/18/62/100/155/192/227/265, at least 35° apart, OKLab ΔE ≥ 0.10 from every status hue). One shared visible-repo registry, fed by `agent:added`/`agent:updated`/`agent:removed`, gives each visible repo its FNV-1a + fmix32 hash slot and linear-probes to a free pennant on a collision; a repo keeps its slot while it stays visible, and a branch variant always gets a different pennant from its base repo. Consumers call `repoProfile()`/`repoBranchProfile()` directly and keep no private caches. One profile shape (`hue/saturation/lightness/accent/labelText/glow/panel/panelBorder/pennantIndex`) feeds the Sidebar, Dashboard, and Harbor ships. |
| `TeamColor.js` | Deterministic team color assignment. |
| `Modal.js` | Shared modal primitive. |
| `Toast.js` | Shared toast primitive. The stack sits bottom-right in both modes and moves left of the Activity Panel while it is open, leaving bottom-left to the World's lower-third caption. `application/NotificationService.js` keeps `joined` toasts silent until the first `village:state` snapshot has been applied (so boot does not announce every existing session), sends departures on the info rail, and shows no mode-switch toasts. In Dashboard mode attention and summons toasts are hidden visually because the bell lane already shows those agents; they stay in the live region for screen readers. |

## Event Ownership

- Emit `agent:selected` and `agent:deselected` through `AgentSelection.js` helpers so future event-shape changes stay centralized.
- `agent:selected` can be emitted by World mode, Dashboard cards, or Sidebar rows.
- In World mode, `ActivityPanel` opens on `agent:selected`, refreshes its selected agent on matching `agent:updated`, and hides when that agent is removed. Dashboard keeps this panel hidden and expands selected detail inline.
- `BUILDING_EVENTS.SELECTED` opens Activity Panel building mode, shows building purpose/status/occupants, polls occupants every 5 seconds, and emits `agent:deselected` when building selection overrides an agent selection.
- `BUILDING_EVENTS.DESELECTED` clears building mode when the currently shown building is deselected.
- `ActivityPanel.hide()` emits `agent:deselected`; `App.js` bridges that event back to World mode so camera follow stops.
- Empty world clicks clear renderer selection/follow but do not close the panel. The panel remains open until its close button or selected-agent removal.
- `usage:updated` feeds shared status surfaces such as `TopBar`. `TopBar` consumes App’s canonical `village:state`; it does not separately reduce WebSocket/watcher events. Simulator state reads `SIMULATED`. The FPS counter is a permanent header instrument beside the witness clock; do not remove it or hide it behind settings. It consumes the World render-loop sample (completed frame intervals over at least 500 ms, including reused idle frames), also shared with Settings > Health. Suspension, Dashboard mode, and unavailable samples read `FPS idle`; a genuine numeric zero reads `0 FPS`. Resume starts a fresh sampling window. Render smoke checks visibility and mode-switch recovery to protect this contract.

## Session Detail Fetching

Use `sessionDetailsService.fetchSessionDetail(agent)` for one-agent surfaces or `sessionDetailsService.fetchSessionDetailsBatch(agents)` for card grids that need tools/messages/tokens. Do not add direct `/api/session-detail` or `/api/session-details` fetches in components.

Activity Panel and Dashboard expose complete available message/tool text through native disclosures, preserve unchanged DOM across refresh, and show cache/server observation age when stale. Provider truncation flags remain visible. Empty successful activity sections collapse; loading and unavailable states remain explicit. Usage and cost distinguish unavailable, partial, and observed zero, and the spend headline discloses incomplete active-session coverage.

Service behavior:

- Cache key: `provider::project::sessionId`.
- Fresh cache TTL: 5000ms.
- Stale cache TTL: 15000ms while a background refresh is started.
- Max entries: 128.
- Fetch timeout: 4000ms.
- Failed fetches return stale cached data when possible, otherwise `null`.

The server adapter registry also has short detail caches. Keep client polling intervals longer than the cache windows unless there is a clear reason to increase backend load.

## Model Visual Identity

`ModelVisualIdentity.js` combines canonical registry identity with rendering policy to produce user-facing labels, colors, sprite IDs, palette keys, and effort accessories. World mode, Dashboard mode, and Activity Panel should all use this module instead of duplicating model parsing.

Model identity, pricing, context window, and mood live in `../../config/models.json`; run `npm run models:generate` and never edit `models.generated.js` or `models.generated.cjs`. Effort equipment and accessories remain here, keyed by `modelClass`. When adding a model-specific sprite, update the registry and sprite manifest, then verify:

1. Dashboard card label/color.
2. Activity panel label/color.
3. World mode sprite selection and palette/accessory composition.

## Validation

After shared component changes, run `npm run verify:render` for screenshot and console evidence, then judge both modes on the operator-maintained server because these components sit across mode boundaries:

1. Select an agent from World mode, Dashboard mode, and Sidebar if available.
2. Close the Activity Panel and confirm World mode follow clears.
3. Select a building in World mode and confirm the panel switches to building purpose/status/occupants, then returns cleanly to agent detail.
4. Switch modes while the panel is open.
5. Confirm `/api/session-detail` and `/api/session-details` requests are not duplicated aggressively in the browser network panel.
