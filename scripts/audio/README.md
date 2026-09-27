# ClaudeVille listening harness and audio probe

Renders the shipped ClaudeVille soundscape to WAV and turns each render into numbers (JSON) and a
picture (PNG) that someone who cannot listen can still read: a log-frequency spectrogram, L/R peak
envelopes, momentary and short-term loudness, onset ticks, and labelled event/section markers.
Nothing in the repository is edited or written: the shipped modules are served read-only from
`claudeville/` and driven through their public surfaces, and renders go to
`$CLAUDEVILLE_TEST_TMPDIR/claudeville-audio-renders/` (the OS temp dir when the variable is unset).

All commands run from the repo root. They need only Node, `playwright` and its Chromium (the repo's
dev dependencies). No ffmpeg, sox, scipy, or extra install. Dev-only: nothing here ships.

## The probe (`npm run audio:probe`)

A **local maintainer gate**, not part of `validate:quick` or CI (CI installs with `--ignore-scripts`
and has no browser). Run it at the end of every audio wave; it exits non-zero on any FAIL and writes
nothing unless `--out` or `--update` is given. **Status:** the Wave 7 gate (`PLAN_STAGE` 7); the default
run takes about 19–20 minutes with `--jobs 2` (1115 s at the Wave-7 exit on a loaded host: the
virtual-clock checks ≈ 15.5 min — the 72-scene world map alone ≈ 3.5 min —, then the live app, the
frame-cost run, the awakening, the caption probe and the lint ≈ 4.5 min); `fps` judges only on a quiet
host and `bank` slices are real time, so a loaded host can fail either.

```sh
npm run audio:probe                                   # every check (virtual clock + the live-app checks)
node scripts/audio/probe.mjs --only scenes            # a subset (names below), e.g. to calibrate PROGRAM_TRIM_DB
node scripts/audio/probe.mjs --only scenes,margins --no-worklets   # the native limiter/meter fallbacks
node scripts/audio/probe.mjs --update                 # re-measure and rewrite baselines/scenes.json (review the diff)
node scripts/audio/probe.mjs --jobs 3 --seed 7        # parallel virtual renders, another seed
node scripts/audio/probe.mjs --out /tmp/probe         # also keep probe-report.json and every scene's WAV
node scripts/audio/probe.mjs --soak                   # the 20-minute realtime soak instead (below)
```

Each line prints `PASS`/`FAIL`/`INFO`/`DEFER`/`WARN`, the check, and its numbers; `WARN` flags a finding that is not a verdict on the gate (today: renderer nondeterminism found by `worldstem`, with the bakes that landed at different audio times).

### Plan stage and deferred checks

`PLAN_STAGE` in `lib/checks.mjs` is the wave the probe gates (now **7**); bump it at each wave's exit.
A criterion whose owner lands in a later wave is listed in `GATED_FROM` with that wave: it is measured
and printed as `DEFER` with the same numbers and the wave that gates it, counted in the summary line,
and never fails the run. Once `PLAN_STAGE` reaches its wave it gates like everything else. At stage 7
`GATED_FROM` is empty: every criterion gates. Targets come from `Loudness.js` and the plan's
acceptance lines only; the committed baselines detect drift and can never turn a failed target into a
pass.

Wave 4 made the busy village (A + 4 ± 2, LRA ≤ 8), the storm (≤ A + 6, ST max ≤ −27) and the error
over the storm (floor +6, band rule, GR ≤ 3 dB) live. Every lane gates at its full S2 window, the
error and limit band rule and ceilings with the Wave-3 signal voices; urgent GR ≤ 3 dB, rain ≤ A + 5
and every other scene target gate too. Wave 6 re-checks the busy village with music as the occasion
clock plays it and gates S2's night row with its occasion (`nightProgram` at 22:30 with the night
waltz vs `noonProgram` at 12:30 with the noon occasion: ≤ the Village session target, 2–5 kHz ≥ 4 dB
under noon).

Wave 5 added the workshop checks (`workshops`, `worklevel`, `workslots`, `worknight`, `quietmix`,
`quota`, `camera`); every one gates now. The workshop stratum is isolated as the difference of two
renders of one seed — the scene, and the same scene with the *Workshops* fader at 0 (`env`) — on the
work stem and the air's wet return: the two share every draw, so the difference is the stratum alone,
sample for sample. The quiet mix and the quota lane are judged the same way against a twin render
without the blur or without `usage:updated`.

Wave 6 added the music checks (`musicstems`, `isleband`, `nightmusic`, `score`, `occasions`,
`townband`, `percussion`); every one gates now. Levels, stems, nodes and the stop lint are measured on
the virtual clock; the score (8 hours of the Town band, the Village's 09:00–18:00 working day) is the
shipped `Sequencer` and `OccasionClock` compiled headless in Node (`lib/music-sim.mjs`, well under a
second per simulated day), so every acceptance line runs in the default probe — there is no opt-in
long mode.

Wave 7 added the front-door checks: `signals` (7.2), `awaken` (7.4) and `listening` (7.7) on the
virtual clock, and `awakening` (7.4's first onset after a real click) and `captionprobe` (captions on a
fresh profile that never turns sound on) in the live app. The live-app enable is the real UI: a
profile's first-ever click on the note opens the SOUND panel's presets (7.1), so the probe picks the
preset there (`#soundPresets [role=radio][data-preset]`) and closes the panel. The render smoke
(`npm run verify:render`, `scripts/smoke/README.md`) carries 7.1's and 7.6's UI acceptance: the sound
states at 1280 and 1440 with screenshots, the 0 px toggle shift and the keyboard walk.

### The virtual clock (HAR-1)

The level, margin, switch, duck and sync checks render the **shipped** controller and directors on an
`OfflineAudioContext` (`page/virtual.html`, `page/virtual.js`, `lib/virtual.mjs`). `page/virtual-clock.js`,
injected before any app module, replaces `setTimeout`/`setInterval`/`requestIdleCallback` (and their
clears), `Date.now`, `new Date()` and `performance.now` with one virtual millisecond clock; `Math.random` is seeded
by `page/init.js`. `window.AudioContext` becomes a factory that hands the engine one prepared offline
context (its `state`/`resume`/`suspend`/`close` shimmed, since an offline context cannot resume before
it renders), so the real `AmbientAudioController` enables as a click would: `ensureContext` loads the
limiter worklet and builds the graph. The render then suspends every 512 frames (10.7 ms); each step
moves the clock to that audio time, fires every timer due by then (each as its own task, so promise
chains settle between them) and waits for tracked async work — `audioWorklet.addModule`, a second
offline render (a bake), `decodeAudioData` — before resuming. Timers therefore run up to one step late
and read the audio clock when they run, as in a realtime page. Two renders with one seed agree to
within the renderer's noise, not bit for bit (the `determinism` check: Δ LUFS-I 0.000 LU; two renders
of one scene differ by max |Δ| ≈ 1e-9…1e-8 — so S6's "bit-identical" is judged within renderer
noise), and a minute of
village renders in about a second. A hidden tab is modelled on request (`freezeOnSuspend`, the
`pause` scenes): while the app holds the context suspended the render holds at its step, so the
audio clock stops as a real suspended context's does while the virtual clock (timers, the hidden
page) runs on. Stems (HAR-5) ride extra destination channels through a channel
merger, sample-aligned with the program: `world`/`work`/`music` post-duck (`engine._busOut`), `cue`
(`engine.busInput('cue')`, before its trim), `limiterIn`/`limiterOut` (`engine._limiterIn`/`_limiterOut`),
`airWet` (`engine.airReturns.wet`, Island Air's return before its trim) and `signalBed` (the held
note's own path post-duck, `engine._busOut('signalBed')`, before its trim).
Stem levels are reported "at the output": plus `PROGRAM_TRIM_DB` and the volume step's gain.

**Sound off and captions (Wave 3).** `runSilent` (`lib/virtual.mjs` `renderSilent`) builds the
controller as TopBar does at boot and never enables it — no `AudioContext` — then steps the virtual
clock to the end: what remains is the signal route (the ladder's 1 Hz timer, captions, published
scores), so an hour of ladder runs in about a second. A scene's `captions: ['auto', 'signals', …]`
installs one real `Toast` per caption setting, each reading its own storage (that setting, and sound
on or off) through Toast's `storage` option, and records every caption it renders; each scripted
action starts from empty caption stacks so every cue is judged alone. Every `audio:cue-played` is
logged with its Wave-3 fields (`level`, `family`, `count`, `soundOnly`) and every published score with
each note's pitch (`hz`), plus the page-clock time (`wall`) beside the audio time; `wallToAudio`
(`lib/probe-wave3.mjs`) maps a page time into a frozen render through the context's state changes.

Scene vocabulary added for Wave 3 (`page/scene.js`, `page/virtual.js`): `world.agents` (explicit
agents with fields such as `signalStale` or `lastTurnDurationMs`; an actionable agent starts its wait
at creation), `status.fields`, `addAgent.parentIndex` (a sub-agent), `remove`, `ack`
(`attention:acknowledged`), `emit` with `raw` (payloads that are not objects), `input` (a document
event), `play` (a governor-free cue through `CueKit._playAccepted`, the capture tool's path), `force`
(layer levels pinned for the scene; `{ music: 0 }` is "no music": since Wave 6 the Village sequencer also
refuses every occasion and fragment, as with `isolate` of any other layer — at level 0 the occasion clock's
first-ever-enable occasion would still play silently, run the MusicClock, hold the held note back and put
cues on its grid), and
`storage` (Wave-3 settings). A scripted `cue` goes to the director that owns the signal route: the
active one while it plays, else the ambient director. Wave 7: `mode` (a stored preset id: `signals`,
`ambient`, `bgm`) and `preset` (`off`, `signals`, `village`, `townBand`) go through the controller's
`setPreset`; the listening options (7.7) are stored settings the controller applies at the enable
(`lib/scenes.mjs` `listeningStorage`: `claudeville.sound.output`, `.tone`, `.soften`); every
`audio:awakened` is logged in audio time (`meta.awakens`), every `audio:cue-played` with `announceOnly`
and the one-time `familyLine`, and `meta.output` is the engine's `outputSnapshot()` at the end.

Wave 4 (`page/scene.js`, `page/virtual.js`): `sea` joins `LAYERS` (so `isolate` and `force` reach
it; `isolate: 'none'` silences every layer), and every render's meta carries `sea`, the SeaLayer's
`snapshot()` at the end (committed crests with `moved`, `yields`, `nodeCreations`, the rare voices
with their resonances). `storm-flash <intensity>` markers pair with the thunder scores
(`audio:cue-scheduled` kind `thunder`, first note = the onset) in flash order.

Wave 5 (`page/workshop.js`, `page/scene.js`, `page/virtual.js`): every render's meta carries `work`
(each `audio:work-scheduled` row: building, agent, `kind` accent/ghost, `flam`, audio `at`, `wallMs`,
`downbeatMs`, slot `pitchIndex`, `hz`, `gainDb`, `variant`), `workCancelled` (`audio:work-cancelled`)
and `workshops`, the layer's `snapshot()` (node creations, guard hits, drops, `placementLog`, the
quota lane). Agents work through `currentTool`/`currentToolInput` (the fixture's one tool per
building, varied per call) and each tool start is a `status` action on the 2 s poll grid (phase
0.4 s) that also burns tokens (the Mine). `rituals: true` installs a stand-in ritual conductor at
`window.__claudeVilleApp.renderer.ritualConductor` — a ritual per observed tool start with
`RitualConductor`'s durations, pending step and beat origin — so the director's own World path reads
it; `meta.rituals` lists the downbeats it drew (Date.now ms). `camera: { viewportW, viewportH, zoom,
path: [{ at, cx, cy }] }` scripts the view centre through `director.setCameraSource`. Actions
`{ select: { index } }` / `{ deselect: true }` emit `agent:selected` / `agent:deselected`, and every
state-log row carries `__claudevilleAudio().quietMix`.

Wave 6 (`page/music.js`, `page/virtual.js`): a scene's `musicProbe: { seatStems, countNodes,
stopLint }` patches the one `Sequencer` (the harness's prototype pattern: the Town band starts its
first piece in the window that opens at its start) and returns `meta.music`: every `observe()` mark
of both presets (`note` and `perc` per placed note, `start`/`end`/`cancel` per visit with its reason,
`loop`/`chunk`/`interlude` with band, arrangement and voice, `rendition` keys, `breath`, `cadence`,
`arrangement`, `stinger`, `nightfall`), the director's calls into it (`call:setWorkshopDensity`,
`call:setArrangement`, `call:setBand`, `call:setWaiting`, `call:setVoice`, stamped in audio time),
every `MusicClock` frame, and the sequencer snapshots. `bgm: { piece, band, voice }` pins through
`Sequencer.pin` (the band held against the director). `seatStems` adds one stem pair per seat
(`seat:<name>`, `seatOutputs()`: post-pan, before the music group and the air); `countNodes` counts
node constructions (every `create*` factory and every AudioNode constructor) inside the sequencer's
`schedule()` between one note's mark and the next — a player's first note, which builds the player,
is reported apart; `stopLint` records every AudioParam's automation, and the Node side rebuilds each
stopped music voice's envelope (`checks.mjs` `automationCurve`, Web Audio semantics) times, for a
buffer source, the buffer's own level at the stop offset, and reads the level at the stop re the
voice's peak (S8: ≤ −60 dB). Every state-log row carries the Village director's `music` snapshot
(what plays, the last start and its reason, the occasion clock). `lib/music-sim.mjs` runs the same
`Sequencer` (and, for the Village, the real `OccasionClock` through the director's `_syncMusic` glue:
decide → release or play → refused or started) on a node-less fake graph and a stepped Transport
(0.25 s ticks, 1.5 s horizon): the score, with no audio.

**Seeded streams and accounting (Wave 2).** Every virtual page calls `Rng.js` `setRngSeed(seed)`
before the app starts, so each world, work, music and cue stream is deterministic per probe seed; a
scene's `rng: { constant }` instead pins every draw (`setRngOverride`, and `Math.random` for older
trees). `page/virtual-clock.js` also keys every timer by its call site (the first app frame of
the `setTimeout`/`setInterval`/`requestIdleCallback` call), times each callback's synchronous part on
the real clock, and logs every source `start()` on the scene context with the timer site that was
running (its callback and the promise chains it started), the context state, and for buffer sources
the buffer identity, offset and rate. Sources on other contexts (bakes) are not counted. It also
records node→node connections, so the page can trace which sources reach the cue or music bus.

Scenes (`lib/scenes.mjs`) start from stored settings the controller loads as a calibrated profile
(standard volume step, trims at their `SoundSettings.js` default step unless the scene says otherwise, `claudeville.sound.calibration = 2`);
`warmup` seconds settle the enable fade and the level slews and are discarded. The harness page has no
AttentionService, VillageDirector or AgentEventStream, so scenes emit their events (`attention:raised`,
`attention:acknowledged`, `distress:watchtower`, `village:scene`, `chronicle:aurora`, `team:gather`,
`weather:storm-flash`, `outcome:verified`, `tool:result`, `agent:added`/`agent:updated`/`agent:removed`,
`mode:changed`) after setting the agent's status, which is what bucket routing and the ladder read. Cue placements respect CueKit's per-kind
cooldowns and the governor's spacing and rate (the routine lane is 4/min since outcomes reserve
2 of its 6), so every placement is admitted.

| check | what it asserts |
|---|---|
| `scenes` | S2 targets from `Loudness.js` at the standard step, relative ones against the anchor measured in the same run: **anchor** (calm clear July day, 4 working, work and music trims off) −38 ± 1 LUFS-I; **village busy** (6 working, 3 minutes of arrivals, a needs-you, an error, a recovery, a rate limit; the first-ever enable's occasion plays) A + 4 ± 2 and LRA ≤ 8; **Town band** −31 ± 1 with the band stem's ST max ≤ −28; **rain** ≤ A + 5; **storm** (three flashes) ≤ A + 6 and ST max ≤ −27; **resting** ST mean A − 10 ± 3, never below −55 LUFS-S; **night program** at 22:30 with its occasion (a settled profile: the night waltz) ≤ the Village session target (A + 4) and its 2–5 kHz band ≥ 4 dB under **noon** (12:30, the noon occasion), 3 working. INFO rows: TP, LRA, limiter GR (storm), HAR-5 stem levels and shares, and the village level map (2–5 kHz share, S/M, correlation, mono fold, laptop loss) |
| `margins` | HAR-3: every lane (needs-you, error, limit, routine arrival, scenery aurora, outcome Minor turn done, Medium push, Major release) over four beds (Village with its music held at 0 — S2's "Village bed (no music)" —, Town band, rain, storm), 3 placements each (the aurora and the release once: a 120 s cooldown, one Major active). **Each lane renders alone** (`margin:<bed>:<lane>`, 32 renders): its placements keep their slots on a 7 s grid shared by all lanes (so every placement sits at the same bed moment whatever the other lanes do, and a lane's own placements are 42–56 s apart), but no other lane's cue plays. The bed under a placement depends on every cue before it — ducks, and the music (and the world's picks), which take different turns for good after the first cue — so over one shared render a lane moved when another lane's voice changed: limit over music read presence rise 6.8, then 6.0 dB with its voice untouched; on one seed, the three limit placements over music read 6.6 / 8.8 / 6.9 dB interleaved and 6.1 / 4.8 / 9.3 dB alone, and the music alone rises −3.8…+3.4 dB at those onsets. A clean-bed gap before each placement would not fix it (the music never re-converges). Margin = max momentary in [t, t + 2.5 s] over the energy mean of the 3 s before, t = the cue's first published note. The median must sit in the lane's full S2 window, urgent lanes (needs-you, error, limit) must also pass the band rule (over music: 0.5–4 kHz energy of [t, t + 1.2 s) ≥ 6 dB over [t − 3, t); elsewhere: ≥ 2 third-octave bands rising ≥ 6 dB) and limiter GR ≤ 3 dB within 2.5 s of the onset, and the Minor outcome's median sits ≥ 3 LU under routine's on the same bed. **Minor outcomes (Wave-4 ruling)** are judged on the cue's own level over the bed — the cue stem's max momentary in [t, t + 2.5 s] over the energy mean of the summed bed stems (world + work + music, same bus staging) in the 3 s before — so a sea swell under a quiet knock cannot lift or sink it; the Minor-under-routine comparison uses that measure for both. The same measure for every other lane prints as INFO with the verdicts it would flip (Wave 4: needs-you over the village +11.7 → +12.5, over its +12 ceiling), so the other lanes keep the program margin. `masking` (urgent lanes over rain), `worklevel` (urgent true peaks, Village) and `townband` (needs-you over music) read the same per-lane renders |
| `limiter` | 1.1: at full slider, a +12 dBFS burst at the limiter input (1 kHz sine, then noise) leaves the worklet at `Loudness.js` `LIMITER_CEILING_DBFS` (+0.1 dB) and ≤ −1 dBTP, and the native fallback (`__claudevilleAudioNoWorklets`: `DynamicsCompressor` + tanh, an emergency path) at ≤ −0.9 dBFS sample peak; a −20 dBFS sine passes both at 0 ± 0.2 dB |
| `switch` | must-never 12: AMBIENT → BGM and back; the momentary loudness of the 4 s after each switch never falls more than 3 dB under the quieter steady side's p10 (before: [t − 8, t); after: [t + 6, t + 14]) nor rises 3 dB over the louder side's p90 |
| `ducks` | 1.3: every `engine.duck` window (recorded with its cancellation), attack and release included, unioned per bus: ≤ 5 % of the village busy and Town band scenes on every bus, with at least one window |
| `avsync` | HAR-12: every published note of every sounding cue score vs the first onset heard on the cue stem near it (a 1 ms frame ≥ 6 dB over the 10 ms before it; a pair's second note struck over the first's ring reads ≈ 8–17 ms late), and four arrivals whose accent is declared 450–800 ms ahead, as the renderer does, vs their heard carrying note: median \|error\| ≤ 20 ms, p95 ≤ 40 ms (no music plays: C-CUE-5's shipped offsets). The release crown (3.4): the peal's published carrying note (`CUE_ACCENT_NOTE.release`) within ±15 ms of the accent the renderer declared 900 ms ahead (the `outcomes` fixture) |
| `determinism` | the anchor and the village busy scene rendered twice agree within 0.2 LU |
| `baseline` | every scene LUFS-I and ST max and every lane's median margin within ±1.5 of the committed `baselines/scenes.json`; `--update` rewrites the numbers it measured (merged with the rest) and prints the deltas. Drift only: every target above is judged on its own, so a baseline never passes a failed target. Re-baseline, reviewed, when `PROGRAM_TRIM_DB` is re-measured (end of Waves 1, 4 and 6) or a reviewed change moves a scene |
| `transport` | 2.1 (S4, ENG-8), a 10-minute village on the virtual clock (three busy stretches, rain at 5:00, the Town band 7:00–9:00; the lint's stack capture off so timer costs are the app's): `engine.transport.diagnostics()` shows 0 underruns and every process's furthest committed window ≤ 1.5 s ahead (work processes ≤ 0.35 s); among the app's timer call sites exactly one started continuous or stochastic sources (layers, the sequencer, bank playback), and it is `Transport.js`'s — discrete cue voices (sources reaching the cue bus, traced through the node graph), control-rate decisions placed on the audio clock with a lead, are listed apart and exempt; its tick costs ≤ 0.5 ms p95 and ≤ 2 ms max of real main-thread time (the page clock resolves 0.1 ms). INFO: starts from the harness's own actions and the 2 Hz atmosphere pump (event-driven), lateness on the virtual clock (bounded by its 10.7 ms steps), other timers over 2 ms |
| `pause` | 2.1 pause in place, village and Town band: 120 s hidden 30 s in (frozen audio clock, above) → the context is suspended, 0 sources start while suspended, none is placed in the past after resume (catch-up smear), the first second after resume holds ≤ the steady onset rate of the 30 s before + 1 (onsets = distinct start times), and the Town band plays the same piece after as before |
| `air` | 2.4 (S5): the two baked IRs' T60 (Schroeder T20, octave bands) — day 1.1 ± 0.15 s and night 1.55 ± 0.2 s at 1 kHz, 4 kHz ≤ 0.8 × 1 kHz; through the real cue path over a dry bed (bed air sends cut), an arrival placed at d = 0 has direct-to-reverberant ≥ +8 dB and one at d = 1 ≤ +1 dB (cue sum vs the air's wet return over 4.4 s), and every needs-you's wet ≤ −14 dB re its dry (2.5 s); the village busy scene with the air vs every send cut: ≤ +1 LU. INFO: the same D/R with raw `place()` sends on the world bus |
| `noise` | 2.5 / 4.3 (AMB-3, C-AMB-3): each continuous texture alone (wind, rain, the hum, the sea by day and in a storm; 60 s) has its autocorrelation peak over 0.5–20 s lags < 0.05; the world bed's ICC (anchor, the clear night, rain, storm) is 0.15–0.5; program mono fold loss (anchor, night, rain, storm, village busy) ≤ 2 LU; no two lanes reading one pool buffer (≥ 10 s long) come within 5 s of buffer time while both play (read heads advanced at each lane's start rate, across the anchor, night, rain, storm and texture scenes); the pool's resident bytes ≤ `MEMORY_BUDGET.noise` |
| `bank` | 2.6 (S8): `engine.bank.stats()` after the air bake and after the village busy scene — every client within its `MEMORY_BUDGET` row, the total within `totalBytes` — and every SampleBank idle slice ≤ 5 ms of real main-thread time (the idle callback's synchronous part — plan, offline graph, render start — timed by the virtual clock; the bank's own `sliceMsMax` reads the frozen virtual clock there and is only meaningful live) |
| `discrim` | 3.1–3.5, S1 (CUE-9): 27 voices — every signal family, the L4 reminder, `answered`, every outcome, four routine alloys, departure, recovery, council, the hour phrase and the counted noon, aurora, the link cues, the digest and thunder — each played governor-free over a silent island (every layer at 0) on the cue stem. Contour and rhythm come from the published score (onsets and each note's resolved `hz`; unpitched notes take the last pitch, a tree without `hz` falls back to the pitch measured at the onset), timbre from the render (`metrics/discrim.mjs`). Gates: every signal voice vs every other voice ≥ 2 of contour, rhythm, timbre (a reminder is not judged against its own family's entry; `answered` plays only in Signals and is judged against signal voices); needs-you, error, limit pairwise ≥ 2/3; every outcome vs needs-you ≥ 2/3 with its 3/3 count reported (3.4 asks 3/3, written for the door chime; a single strike cannot differ in contour from the ship's bell's flat opening under S1's opening-interval rule); no non-signal cue opens with a quick (< 1 s) same-pitch pair. INFO: every voice's notes, brightness, strike, ring and output M-max; openings that quote a call |
| `ladder` | 3.3 (D6, S7): sound off (`runSilent`, no `AudioContext`), one wait per family opened 5 s in and never answered, 61 min: the calls (entry + reminders, from `audio:cue-played`) match the schedule — needs-you L1 → L2 at 2 min → L3 at 6 → L4 at 15 and 30 → L2 at 60; errors the same capped at L3; quota L1 and one L2 — within one late tick, none unexpected; reminders ≥ 120 s apart and ≤ 12 in any hour; each captioned by a real Toast at the default setting. Acknowledged at 3.4 min: no call for 10 min. Sound on (Village, no music): L1, L2, L3 keep the entry trim, L2 ≥ 4 LU under L1, L3 GR ≤ 3 dB. Hidden tab with sound on (frozen clock) from 25 s: the reminders due at 2, 6 and 15 min each render on the cue stem within 60 s of their time |
| `cluster` | SIG-10: six needs-you raised on one tick vs one: program M-max over the 4 s after within +1 LU of the single call, all six agents captioned, urgent GR ≤ 3 dB; INFO: sounding scores (the lead and its flock strikes) |
| `heldnote` | 3.3 (SIG-3): a wait opened by status alone (no entry call) in Village with no music at W = 1 and W = 15 working, answered 45 s later: the program's 270–310 Hz band rises ≥ 6 dB within 6 s and is back within 3 dB within 5 s of the answer (1 s windows, 0.1 s hop); the held stem's 270–310 Hz envelope swings ≤ 3 dB (beating); its short-term level is bed − 8 ± 1 LU (world + work + music stems, same staging). Absent (held stem ST max ≤ −80 LUFS at the output): under Village music (while `nowPlaying`), in the Town band, and with the window blurred on *Signals only* (the signal route alone) |
| `outcomes` | 3.4 through the producers: `outcome:verified {push}` → one push cue with published notes; ten exit-0 `tool:result`s → silence; ten failures from one agent in 60 s → 1–2 cues; a ≥ 20 s turn ending, a sub-agent dispatched and returning (`parentSessionId`, `agent:removed`) and a verified release each → one sounding cue; a Dashboard fixture (`mode:changed` → dashboard, `agent:*` transitions only) still yields turn done and the return |
| `captions` | 3.8 (HAR-13): 21 kinds through the director's cue path, 12 s apart, in Village and the Town band, sound on (rendered) and off (`runSilent`), four Toasts (auto, signals, events, all): a caption shows exactly when S6/3.8 says — signals always; outcome and routine with *events* or *all*, and by default only while sound is on; scenery only with *all* and sound on; the digest never (sound-only) — never without a played cue, and with sound on every captioned cue had a sounding score. Sound off at the default setting shows no outcome or scenery caption |
| `honesty` | must-never 3: a 6-min wait in Village with no music keeps the held note's band ≥ 6 dB over the level before the wait in every 10 s window until the answer. Must-never 13: no two urgent scores for different agents share two note times within 5 ms (the six-raise cluster render), and stale agents (`signalStale`, `freshness.state: 'stale'`, `resident`) raising a needs-you and an error produce no sounding signal score and no held note |
| `worldmap` | 4.5 (AMB-12, HAR-9), S2, S7: 72 world scenes — dawn, day, dusk, night (mid-phase) × clear, partly-cloudy, overcast, rain, fog, storm (one 0.9 flash) × resting (3 idle; 40 s warmup) / 3 / 12 working, 30 s each, work and music faders at 0 so the program is the world stratum (the anchor's staging). Each cell against its `Loudness.js` row relative to A: resting (any weather) ST mean A − 10 ± 3 and ≥ −55 LUFS-S; rain ≤ A + 5; storm ≤ A + 6 with ST max ≤ −27; every other cell is the day arc, A + `dayArc.overA` ± `toleranceLu` with ≥ `withinShare` of those cells inside, and night never over A + `night.maxOverA`. Must-never 7: no cell over the clear day at its load by more than 6 LU. The S2 night row's world half: night clear 2–5 kHz ≥ 4 dB under day clear (program band level, 3 and 12 working). S7: ambient onsets (analyze.mjs's band-rise detector on the program) ≤ 180/min in every cell. INFO: S6 across the map, each 12-working cell's world stem vs the 3-working render (max |Δ|; the gate is `worldstem`). INFO: one line per phase × weather (levels, 2–5 kHz, onsets/min, CPU proxy, the director's grade pair) and the CPU offline proxy (render wall ÷ audio time, the harness included: relative only) |
| `worldstem` | S6 / C-AMB-1: dawn clear and a night storm (one flash) at 0 vs 12 working, one seed, 28 s from the enable (the empty village would rest at 30 s — the pilot light is the designed response to nobody working): no cue is scheduled; the world stems identical within renderer noise: max |Δ| ≤ 1e-6 (−120 dBFS) or ≤ the max |Δ| of the 12-working render repeated (the renderer's own noise, printed beside it). A repeat over 1e-6 prints a `WARN` with where the two renders first part, which bakes (`meta.bakes`: SampleBank `_store`, noise pool `_complete`, in audio time) landed at different times and which `AudioWorkletNode`s were built mid-render (`meta.workletNodes`). Wave 4 found and removed one such source: `new Date()` read the real wall clock (the wind's canopy moved by 5e-4 between renders); two renders now differ by ≤ 1e-8. The sea's yield to scheduled cues (4.6, AMB-9) is the sanctioned cue coupling, not agent state |
| `sea` | 4.1 (AMB-1), from `layers.sea.snapshot()` and the sea alone on the world stem (60 s by day, at night, in the storm; 4 min by day for rare voices): the day sea 2–6 LU under A (at the output); ICC 0.1–0.4 and r(4 s) < 0.05 day, night and storm; 4–7 breaking waves/min by day (committed crests); the clear night's world bed +7…+20 dB in 250 Hz–1 kHz with the sea against the same render with the sea forced to 0; no gull at night or in the storm; every hull-groan resonance ≤ 450 or ≥ 800 Hz (INFO when none sounded); node creations after start ≤ 2 per rare take (none per wave). INFO: night and storm breaks/min, the CPU proxy of the sea alone against an island with every layer at 0 |
| `thunder` | 4.2 (AMB-6): six flashes (0.9, 0.3, 0.7, 0.5, 1.0, 0.6; 18 s apart) over the world-only storm. Each strike, from its onset (the thunder score's first note, paired with the flashes in order): LU over the 3 s before (max momentary over the 8 s roll) in `AUDIBILITY_WINDOWS.lanes.thunder` near (intensity ≥ `storm.thunderNearFrom`) or far; onset `0.4 + 4.5·(1 − i)` s after the flash ± 0.25 s; limiter GR ≤ 6 dB. Across strikes: level monotonic in intensity (a louder-for-less step > 0.5 LU fails); a fresh grain (each strike's reads of a pool buffer — spans of buffer time — ≥ 5 s from the previous two strikes' reads; the brown pool holds ≈ 68 s, so freshness is judged against the last strikes); no duck window; the scene's ST max ≤ −27 |
| `masking` | must-never 8: in the Village storm a needs-you and an error each placed ≈ 1 s into a full-intensity thunder roll keep the S2 weather window (floor, band rule, GR ≤ 3 dB; INFO: the cue stem over the world stem while both sound); every urgent lane over rain (the `margins` rain renders, one per lane) keeps its floor |
| `crest` | 4.6 (AMB-9): the loudest crest in 20–60 s of a cue-free render (the night Village bed with no music; the storm); each lane's lead from action to first note from a calibration render (its off-crest margin); then one render per lane with the cue moved so its first note lands on that crest: routine and needs-you at night, the error in the storm, each within its S2 window. INFO: the nearest crest in the placed render (moved or not), the sea's yields, the cue lead (cues < 1.5 s ahead rely on the duck) |
| `workshops` | 5.1 (FOL-1, FOL-5, FOL-7): the FOL reference scene by day (3 Forge — one goes stale at 34 s, two end their turn at 46 s —, 2 Archive, 1 Harbor with a push and a status, the Mine from everyone's token burn; Village, no music, 60 s): the Forge's longest gap between strikes while it works ≤ 2.8 s; its last strike ≤ 1 s before the smiths' first non-working observation and none later than P_b after it; no accent from the stale smith; node creations ≤ 2 per published take. Honesty (S6): 0 strikes while only stale agents work, 0 from one gesture period after the only worker goes idle until it resumes, 0 later than 0.35 s after the `linkLost` cue (the feed made live, then dropped). World (the stand-in conductor): every accent claiming a downbeat vs the nearest drawn one, median ≤ 15 ms, p95 ≤ 30 ms, none off every drawn beat; the poll-lock pulse index (onsets folded onto the 2 s poll in 8 bins, fullest over mean; flam followers are one onset) ≤ 1.8. INFO: the same village in Dashboard (pulse index, onset parity, no downbeat claimed), strikes on their gesture grid, main-thread cost per tick (the layer's own `scheduleMs`, the director tick and the Transport tick) |
| `worklevel` | 5.3 (C-FOL-3) over the reference scene and the other four buildings (2 agents each at the Task board, Observatory, Portal, Command, and the Mine), by day, each against its `env` twin: the stratum (work stem + air return, ctx − env, at the output) ≤ program − 8 LU; program Δ ≤ +0.5 LU; its true peak ≥ 2 dB under the quietest urgent cue's (median per lane of the cue stem's TP over [t, t + 2.5 s] in the `margins` Village renders, one per lane — the Wave-3 voices at their in-context trims); onset-weighted 2–5 kHz share of the program (2–5 kHz ÷ full-band energy of the mid over every onset's [t, t + 150 ms]) ≤ 1.5 % in the reference scene (the plan's figure), and elsewhere the stratum's increment over the environment alone at the same instants ≤ +0.3 points (the absolute share printed); ≤ 3 onsets in any 1 s; two routine arrivals lose ≤ 0.3 LU of margin to the stratum. Accents heard ≥ 80 % at every staffed building on ≥ 20 accents each (a 3/4 share is no evidence), judged on 180 s audibility cells of both patterns (every agent working throughout, a tool start every poll or two, two agents git-calling at the Harbor, no cue) against their `env` twins: FOL's band rise ≥ 6 dB in FOL round 2's bands, 40 ms — 200 ms for page, rope, rune, chalk and quill — over the median of [t − 300, t − 30) ms; INFO: the same instants in `env`, the false-positive control |
| `workslots` | 5.4 (SIG-11, SIG-12): two smiths starting a tool every poll or two: 2 agents, one accent slot each, 2 distinct; the first selected at 45 s — the same accents in a twin without the selection differ by +4 ± 0.5 dB for it and ≤ 0.5 dB for the other; a needs-you from a bystander 17 s later within ±0.5 LU of the twin's (cue stem M max less its bed-aware trim) |
| `worknight` | 5.5 (FOL-8): the two audibility cells at night against their `env` twins: every staffed building's accents heard ≥ 80 % in 1.2–3 kHz on ≥ 20 accents each. INFO: the program with and without the stratum, the layer's night flag, the Forge's accent slots |
| `quietmix` | 5.6 (D3, D4): blur 20 s, focus 40 s, each scene against a twin that never blurs, levels in 0.1 s blocks. Village with music playing (the first-ever enable's occasion): world −6 ± 1 dB and back within 1 dB ≤ 1 s after focus; music ≤ −40 dB (Wave 6, D1: the quiet mix releases the tune, which does not resume at focus — the occasion clock starts the next); work accents −6 ± 1 dB (each accent's work-stem peak less its published gain, per-building medians, blurred vs the unblurred reference — before the blur and from 1 s after focus, ≥ 8 accents: a single strike's noisy peak per building moved the step by ~2 dB); 0 ghosts while blurred. Village with a wait and no music: the held note (signalBed) 0 ± 0.5 dB; a needs-you at 30 s within ±0.5 LU of the twin's before its bed-aware trim. Town band: music −3 ± 1 dB, restored ≤ 1 s, and 0 workshop strikes (no work stratum in Town band) |
| `quota` | 5.7 (SIG-13): `usage:updated` with the 5-hour ratio 0.7, 0.8, 0.9, 1.0 every 8 s, then `quotaAvailable: false`, one reader keeping the village awake; the quota lane = the work stem minus a twin without usage, 80–160 Hz over each step's last 4 s: monotonic (±0.2 dB; a silent step is a measured silence) and ≥ 10 dB from 0.7 to 1.0; 0 `audio:cue-played`; 3–7 s after the quota goes unavailable ≥ 40 dB under its 1.0 level |
| `camera` | 5.8 (D8): a harbor worker; the camera still, then its centre panning 1000 px across the Harbor in 6 s (zoom 1, 1280 × 720), then still. The camera's crossing is where `SpatialField.placeFromCamera` (unstepped) puts the Harbor's pan through 0 on the scripted path; the heard crossing is the pan rebuilt from the `placementLog` writes (`setTargetAtTime`, τ from the log) — for the Harbor workshop chain and the sea's harbor lane, each ≤ 0.6 s after the camera's, no written step > 0.2, 0 writes while the camera is still |
| `musicstems` | 6.2 (MUSL-10, MUSL-2, MUSL-3, HAR-11): every piece × day (12:00 arrangement) and night (22:30) × Isle and Chip, the Town band pinned to its full band over a busy island (every building working, so percussion plays), each seat on its own stem, measured over the first 16-bar rendition (output-referred LUFS-I). Stems re lead: bass −3.5 ± 1.5, counter −6 ± 2, engine −8 ± 2, percussion −14 ± 3 LU; every admitted seat (the descant too) ≥ −15 LU and under the lead; the voice the band played is the pinned one. Bands: band k is the sum of the seats `Voicings.voicingFor` admits at the arrangement the band played (seat content never depends on the band), its onsets the admitted seats' notes; each band vs the one below ≥ +30 % onsets or ≥ 3 dB in some octave band (63 Hz–8 kHz). Both gate on the combinations the Town band plays (`PLAYLISTS`: day pieces by day, night pieces at night); a piece in the other phase's voicing prints as INFO. INFO: every seat's LU re lead (the Voicings calibration) |
| `isleband` | 6.1 (MUSL-1, D2), from the same renders: the music bus plus the air's wet return (the Town band's only send), level-independent measures of the same notes — Isle laptop-model loss (4th-order 200 Hz high-pass) ≤ 1.5 LU, S/M −16…−9 dB, mono fold loss ≤ 1 LU, day and night (Chip printed beside it); Isle's 2–5 kHz share at night ≥ 4 dB under the same piece by day; ≤ 4 node constructions per note (every note after its player's first); the music client's resident bytes (`engine.bank.stats().byClient.music`, the Town band busy scene) ≤ `MEMORY_BUDGET.music` (bake slices: `bank`) |
| `nightmusic` | 6.3 (MUSL-4): every night render — the lead sounds ≤ A5 (night pieces; day pieces at night INFO), and no stopped music voice is above −60 dB re its peak at its stop (the stop lint); the `nightProgram` render — the night occasion starts, its music stem's ST max ≤ the bed (world + work, LUFS-I over the occasion) + 3 LU, its lead ≤ A5, no stop above −60 dB. INFO: the night 2–5 kHz share Isle vs Chip (≈ the shipped band's timbres; 6.3 asks ≈ 6 dB) |
| `score` | 6.5 (MUS-18, `score-analyzer.mjs` on rendered notes and `MusicClock` frames): melody–bass parallel fifths/octaves 0 in every stem render; routine cue notes (published `hz`) over the sounding chord in the Town band and village busy scenes: 0 % clash; 8 hours of the Town band (headless, seeded; the working count, densities and waits move every 2–6 min): no two identical 16-bar renditions of a piece < 60 min apart, by the sequencer's rendition keys and by the analyzer's (notes on the sixteenth grid); the Village day (below): tonal and phrase re-hearing over music-on windows ≤ 10 % in every hour; motif statements (fragments, occasions and the hour phrase at every hour) ≤ 6 per clock hour |
| `occasions` | 6.6 (D1, S7, must-never 9 and 10): the Village's 09:00–18:00 working day headless (busy, a light hour, rain 13:00–13:40, resting 14:30–15:10, a wait 15:20–15:40, urgent cues) through the real `OccasionClock`: fragment duty (heard, incl. the ring-out) 6–10 % of busy time and ≤ 20 % of light time outside the hard zeros, printed beside the duty the constants predict; no start inside rain, resting, a wait ≥ 6 min or 5 s after an urgent cue, and no music past 1.5 s into one; every start carries a reason; music on ≤ 15 % of every working hour. Virtual-clock fixtures (heard music on the music stem ≥ −70 LUFS-M at the output): the first-ever enable plays an occasion with its reason in the snapshot and its ST max ≤ bed + 3 LU; a fragment ≤ bed + 1 LU; rain, a 7-min wait, rain with a needs-you 1 s before it clears, and a resting village (the director's own `resting` state) — no heard music inside (3 s allowed for a release when a zero begins mid-music), and the due occasion plays once the zero clears (the control) |
| `townband` | 6.7 (SCN-7, MUS-7, MUS-9, S7, must-never 10): a 60-min Town band session (12 kHz, the busy island, a needs-you at 20:00 answered at 26:00): no piece back within 6 min of its visit's end (4 with < 4 pieces in the day set); ≥ 1 breath or interlude in every 10 min and each breath 1.4 ± 0.05 s; music duty ≥ 85 % and interludes ≤ 15 %; tonal re-heard (`session-metrics` `dejaHeardPct`) ≤ 25 % in each of the session's six consecutive 10-min windows, each measured on its own history (the basis of SCN's 34.5 % baseline; the whole hour's figure prints as INFO); ≤ 12 loops (identical renditions) per piece in the hour; session LUFS-I −31 ± 1; the needs-you over the band in its S2 window (judged on the `margins` needs-you render over music at 48 kHz — the 12 kHz session cuts the bell's upper partials, so its figure is INFO). 8 hours headless: the same loops and returns. The waiting cadence: a needs-you open 10–70 s — every phrase end while it waits is deceptive, the first after the answer lands home |
| `percussion` | 6.9 (SIG-16, MUS-16, D4): ten Town band minutes while the island's workshop density climbs and falls (two-minute segments, then nobody working): Spearman ≥ 0.7 between percussion hits per bar (the song grid from the chunk marks) and the total density the director fed; no hit once the director's densities empty at working 0 (+1.5 s horizon); the percussion stem −14 ± 3 LU re the lead in the busy segment. Rain at 30 s over the busy band: the arrangement switch lands on a chunk boundary — the first one not yet committed when the rain came (1 s tick + 1.5 s horizon) — and every chunk after it plays the rain arrangement |
| `signals` | 7.2 (UX-3): the busy stretch (arrivals, a needs-you, an error that recovers, a limit, a departure) in the Signals preset, captions at the default setting, once with the needs-you answered at 70 s and once left open (the ladder's L2 at 2 min): every 400 ms program window after the warmup outside a sounding cue (first published note − 50 ms to its last note + 6 s) < −80 dBFS; the needs-you call's loudest window ≥ 20 dB over the loudest floor window (a silent floor counts at −80 dBFS); every arrival captioned, not sounded, and its 3 s after < −80 dBFS. INFO: the Signals-only `answered` strike |
| `awaken` | 7.4 (UX-5, SCN-8), virtual clock: the first enable of a page session in Village (no ledger: the welcome follows), a needs-you at 26 s, Off at 33 s and Village at 35 s: exactly one `audio:awakened`; the awakening's cue-stem M max (2 s) ≥ 12 LU under the needs-you call's (2.5 s); the program's short-term 4 s after the enable within ±3 dB of steady (the energy mean of the short-term values over 10–25 s) |
| `listening` | 7.7 (UX-10, UX-14, SOTA-14), stored settings applied at the enable: Mono vs Speakers on the Village with an arrival and a needs-you — LUFS-I within ±0.5 LU and L = R; Headphones' world bed (Village, no music or work stratum, cue-free) ICC ≥ 0.4; tone ±1 on the Village world bed and on the Town band: 5–10 kHz ±4 ± 1 dB vs tone 0 and 100–1000 Hz within ±0.5 dB; Soften on vs off on a storm Village: the arrival bell's attack (5 ms RMS windows, −40 dB → −1 dB re peak) ≥ 22 ms, the thunder's ≥ 200 ms and slower than off, every non-needs-you duck depth 0.7 ± 0.05 × off, the needs-you call's M max within ±0.2 LU |
| `lint` | HAR-4 envelope lint (below) finds no hazard, and each unit started at least one source: every cue kind (`cue-gallery` and the `*-night` cues, offline), `layer-crickets-night`, and `bgm-night-to-ambient` (a BGM night piece, then a switch to the ambient preset); INFO: the app session's hazards |
| `routing` | must-never 2: an errored agent's `audio:cue-played` kinds are all `distress`, a rate-limited agent's all `limit`, never `summons` — with `attention:raised` first, with `distress:watchtower` first, and through the live producers (a sim status step) |
| `away` | must-never 4: after a real TopBar click (`--autoplay-policy=user-gesture-required`), a needs-you raised 5 s into an absence sounds. Hidden tab and blur with `claudeville.sound.background = signals` close the bed, so the call must stand the `Loudness.js` needs-you minimum (+10 LU) over the preceding `bedWindowSec` (3 s) of what the listener heard — a suspended context counts as silence, scored at −80 LUFS. A plain blur keeps the full mix (decision D3), so there the call must reach the cue bus (≥ −60 dBFS) with the context running; its margin over the bed is must-never 1, gated on the virtual clock by `margins` |
| `resume` | must-never 5 (runs with `away`): after each blur→focus and hide→show, `contextState` is `running` within 1 s |
| `ceremony` | must-never 6: the `team-gather` sim fixture, started over an empty island with sound on, yields exactly one `council` cue-played within 15 s |
| `continuity` | 2.1, realtime app: in the Town band, blur 3 s → focus keeps the same piece (`nowPlaying`), and the momentary level 0.3 s after focus is within 6 dB of the 3 s before the blur |
| `fps` | 2.4, realtime app (`perf-12-agents`): `world:benchmark-fps`'s frame total (`__claudeVillePerf` frame profile, update + render) in alternating 15 s segments, sound off / on / off / on; p95 with sound on − off ≤ 0.1 ms. When the two sound-off segments already differ by the limit (the page clock resolves 0.1 ms; a busy host) the delta prints as INFO, not a verdict — re-run on a quiet host |
| `awakening` | 7.4, realtime app on a fresh profile: the first click on the note opens the presets and the press on Village enables; the tapped program's first sample over −70 dBFS ≤ 150 ms after that press (the worklet load included); the note off and on again in the same page session emits no second `audio:awakened`. INFO: the realtime short-term 4 s after the press vs steady (judged by `awaken`) |
| `captionprobe` | C-UX3 / S3, realtime app on a fresh profile that never turns sound on: a needs-you and an error raised through the live producers each show a caption toast naming the agent within 4 s |

The app checks run the full app on `startIsolatedServer()` (ephemeral port) at `/?sim=1`, renderer on,
with `Math.random` seeded before any app module loads (`page/init.js`) and `page/probe-app.js` driving
the sim fixture, real `blur`/`focus` window events and a `document.hidden` override with a real
`visibilitychange`. Captions are recorded from `audio:cue-played` on the event bus, so routing and
ceremony results hold with any output device. Loudness is measured on the wall clock: every tap chunk
carries its arrival time, and `lib/timeline.mjs` lays the capture on it (see "The tap"). They run after
the virtual renders, one at a time, so render CPU never competes with a live audio thread.

### The soak (`--soak`, SCN-9)

```sh
node scripts/audio/probe.mjs --soak                    # ≈ 21 min: both presets, 10 min each, realtime
node scripts/audio/probe.mjs --soak --soak-seconds 60  # a short smoke of the same path (reported, not gated or compared)
node scripts/audio/probe.mjs --soak --update           # record baselines/soak.json from this soak
```

The full app on an isolated server records ten real-time minutes of the SCN busy-session fixture
(`fixtures/scn-plans.mjs`: arrivals, departures, a question left open for four minutes, an error that
recovers, a push, a failed push, a lull, a rate limit) in AMBIENT and in BGM, sound enabled by a real
TopBar click, the fixture played through the sim driver. It reports the session metrics
(`metrics/session-metrics.mjs`: LUFS-I, LRA, silence share, music on-time, tonal re-hearing, cue
density), gates ducked time ≤ 5 % per bus, and reports HAR-12's renderer lag (drawn accent frame −
published note, from `cueScoreDiagnostics()`). Against `baselines/soak.json`, two soaks must agree
within 1 LU (integrated), ±3 points (music on) and ±5 points (re-heard) — 0.8b's acceptance; a soak of
another length is reported, not compared.

### Metric libraries and fixtures

Ported from the explorers' notes (`output/claudeville-opus55-audio/`) as pure Node libraries that take
channels, not files, so the probe and later waves' acceptance lines call them directly:

| module | from | functions |
|---|---|---|
| `metrics/discrim.mjs` | `cue-snippets/discrim.mjs`, `discrim2.mjs` | `cueFeatures`, `differs` (S1's opening-interval contour rule), `differsRound1`, `discriminationMatrix`, `semitonesFromA4` |
| `metrics/cuebands.mjs` | `mix-snippets/cuebands.mjs` | `cueBandRise` (⅓-octave rise and duck hole), `presenceRise` (the band rule over music), `thirdOctavePower` |
| `metrics/levelmap.mjs` | `mix-snippets/levelmap.mjs` | `levelMap`: K-weighted band shares, 2–5 kHz share, S/M, correlation, mono fold, laptop loss, quiet share |
| `metrics/session-metrics.mjs` | `scn-snippets/session-metrics.mjs` | `sessionMetrics` (silence, tonal and n-gram re-hearing, music on-time, cue density), `writeSsmPng` |
| `metrics/fol-analyze.mjs` | `fol-snippets/fol-analyze.mjs` | `scheduleStats` (S7 work budgets), `strikeAudibility`, `bandEnvelope`, `riseAt`, `riseCount`, `lineLevelDb`, `WORKSHOP_BANDS` |
| `metrics/amb-metrics.mjs` | `amb-snippets/metrics.mjs` | `repetition` (autocorrelation lags, ICC), `rt60` (Schroeder T20 per octave, C80), `eventDecay`, `wetDry`, `autocorrelation`, `icc` |
| `metrics/musl-measure.mjs` | `musl-snippets/measure.mjs` | `musicMeasure`: LUFS, laptop Δ, 2–5 kHz share, holes per minute, momentary spread |
| `metrics/dsp.mjs` | — | the FFT, RBJ biquads, Welch PSD and helpers the libraries share |
| `fixtures/scn-plans.mjs` | `scn-snippets/plans.mjs` | SCN's session and moment plans (`busySessionActions`, `PLANS`) |
| `fixtures/cue-scores.mjs` | the discrim tables | the evidence round's designed Wave-3 figures (reference; `discrim` reads the shipped voices' published scores) |

## Listening harness

```sh
T=scripts/audio/audio-capture.mjs

node $T list                                   # every target: category, method, name
node $T all --jobs 4                           # full baseline → <renders>/baseline/<category>/ + <renders>/INDEX.md
node $T cue-summons-urgent                     # one target → <renders>/scratch/<category>/
node $T bgm                                    # a whole category (cues, cues-providers, cues-pan, layers, music-layer, bgm, mix, fidelity)
node $T 'mix-night*' --jobs 4                  # name prefix glob
node $T mix-dusk --seconds 20 --out /tmp/x     # override the recorded length (warmup unchanged) and the output root
node $T analyze some.wav [--markers m.json] [--out dir]   # metrics + PNG for any WAV (PCM 8/16/24/32, float 32/64)
node $T index                                  # rebuild <renders>/INDEX.md from <renders>/baseline/**/*.json
node $T replot [--out dir]                     # re-analyse every WAV under a root and redraw PNG/JSON (after a metric/plot upgrade)

# prototype a new recipe and render it through the identical analysis (one command):
node $T snippet --snippet scripts/audio/snippets/example-glass-bell.js --seconds 5 --offline
# A/B a code change against a catalog target: patch prototypes in the snippet, render the same target
node $T layer-crickets-night --snippet scripts/audio/snippets/example-crickets-softer.js \
    --name layer-crickets-night-softer
```

`<renders>` is `$CLAUDEVILLE_TEST_TMPDIR/claudeville-audio-renders` (or the OS temp dir). Flags:
`--seconds N` (recorded seconds after warmup; for song/loop targets the song/loop decides),
`--out dir` (default `<renders>/baseline` for `all`, else `<renders>/scratch`), `--jobs N` (parallel
realtime pages, default 6), `--seed N` (Math.random seed, default `0x5eed`), `--name id` (rename a
single target or a snippet render), `--offline` (snippet on an OfflineAudioContext),
`--volume-step 0-10` (snippet master volume step, default the standard step 6).

Every render writes `<name>.wav` (32-bit float stereo, context rate — 48 kHz in headless Chromium; float
because the village plays at -45…-70 LUFS where 16-bit quantisation noise would bias spectral metrics),
`<name>.png`, and `<name>.json`.

## Snippet API

A snippet is an ES module served to the harness page. Two modes:

**Standalone (`snippet` command).** `export default async function (api)` receives

| field | meaning |
|---|---|
| `context` | an `AudioContext` (realtime, default) or `OfflineAudioContext` (`--offline`) at 48 kHz |
| `destination` | `context.destination` — tapped in realtime, rendered offline. Connect here to bypass the shipped master chain |
| `engine` | a real `AudioEngine` attached to `context` (`engine.attachContext`, limiter worklet loaded), fade pinned open: `engine.busInput('cue' \| 'world' \| 'work' \| 'music')` → program trim → … → limiter → volume step → destination (see the chain in `AudioEngine.js`). Connect there to hear your recipe exactly as a shipped cue/layer would sound |
| `modules` | the shipped classes: `AmbientAudioController, eventBus, createAtmosphereSnapshot, AudioEngine, AudioDirector, CueKit, CueGovernor, cueNoteOffsetsMs, PIECES` |
| `mark(label, { t, kind })` | add a marker (default time = `context.currentTime`; `kind: 'event'` gets a cue-margin row in the JSON) |
| `seconds`, `offline` | render length and mode |

Anything else is one `await import('/src/…')` away (same URLs as the app). Offline snippets must
schedule everything before returning (timers do not advance an offline render); realtime snippets
may use `setTimeout`/`setInterval` like the shipped layers do. Realtime renders record exactly
`seconds` from the moment the snippet is called.

**Inside a catalog target (`<target> --snippet file.js`).** Optional `export async function before(api)`
runs before the `AmbientAudioController` is constructed — patch prototypes here; the module instances
are the ones the controller uses. The default export runs right after audio starts and receives
`{ context, destination, engine, controller, world, eventBus, modules, mark, seconds }`. The target's
scenario (world, atmosphere, actions, warmup, windowing) is unchanged, so the result is an A/B against
the baseline render of the same name.

## Capture methods

| method | used for | why |
|---|---|---|
| `offline` | every `cues*` target | CueKit schedules every note on `ctx.currentTime`, so an `OfflineAudioContext` gives a sample-accurate, jitter-free render. A real `AudioEngine` is attached to the offline context (`engine.attachContext`: limiter worklet and full master chain), then each cue goes through `CueKit._playAccepted` with the lane from `laneForCueKind` — the exact path the governor calls once a cue is admitted (score anchoring, lane mix, `_voice`). Cues are armed at their time with `suspend()/resume()`. The governor itself (cooldowns, budget, aggregation) is bypassed: the render is "what this cue sounds like once admitted". |
| `realtime` | layers, ambient music, BGM, director mixes | The directors, layers and composers are driven by `setInterval`/`setTimeout` and read `ctx.currentTime` at call time, so only real time reproduces them. Headless Chromium runs with `--autoplay-policy=no-user-gesture-required`; the page is `page/harness.html`, which imports the shipped modules and constructs the real `AmbientAudioController` with a synthetic world. The CLI clicks the page first (a real user activation), then the page calls `setPreset(<stored preset>, { fromUser: true })`, the enable path a TopBar pick takes. |
| `app-realtime` | `fidelity/app-live-sim-day` | The full app from `startIsolatedServer()` (ephemeral port) at `/?sim=1`, renderer running, sound enabled by clicking the real `#topbarSoundToggle`, hour/weather set through `window.__claudeVilleAtmosphere()`. Cross-checks that the renderer-free harness is representative. |

**The tap** (`page/init.js`, injected before any page script): `AudioNode.prototype.connect` is wrapped so
anything connected to a realtime `ctx.destination` is *also* connected to a hidden gain → AudioWorklet
recorder → zero-gain → destination. The recorder checks every render quantum's `currentFrame`, so
markers taken from `ctx.currentTime` map to exact sample indices. When headless Chromium's timer-driven
audio sink falls behind under CPU load it *skips* render quanta (the audio clock jumps, typically by 64
frames); the recorder reports each skip, the PCM is spliced across it (no zero-filled holes), and
markers are mapped through the splice. `capture.gaps` / `droppedFrames` / `gapTimes` in the JSON list
the skips inside the kept window. Each chunk also carries its main-thread arrival time
(`collect().chunkTimes`); the probe lays the capture on the wall clock from it (each chunk takes the
smallest arrival lag of the next 2 s, so a late message does not move audio and a suspension leaves
silence), because a suspended context renders nothing and the listener hears that as silence. The
same init script records every scheduled source's `[start, stop]` window for the voice-count metrics,
and swallows only browser-originated (`isTrusted`) window blurs, so parallel pages never trip the
controller's blur path while the probe's dispatched blur still reaches it.

**The envelope lint (HAR-4, runtime half)**, also in `page/init.js`: every `setValueAtTime` records the
earliest event on its `AudioParam`, and every source `start()` checks the GainNodes it feeds; a source
that starts while such a gain still sits at its default 1 and whose envelope's first (near-silent)
event comes later sounds at full level until then — a click. Each site is reported once with its count
and lead (`capture.hazards` in the JSON, `ENVELOPE HAZARD` in INDEX notes, `lint` in the probe).

Realtime captures only write their WAV while pages are running; all analysis and plotting happen after
the last page closes, and offline cues and the app render run after that, so measurement CPU never
competes with the audio threads.

**Scenario driving** (all through public surfaces): world = `{ agents: Map }` of synthetic agents
with real statuses (`working`, `waiting`, `waiting_on_user`, `idle`, …); atmosphere = a real
`createAtmosphereSnapshot()` for a fixed mid-July (summer) date at an hour chosen by scanning for the
requested phase/progress (minute 0 is skipped so the hour bell never fires), re-emitted as
`atmosphere:updated` every 400 ms; events via the real `eventBus` (`village:scene`, `attention:raised`,
`distress:watchtower`, `team:gather`, `weather:storm-flash`, `agent:updated`).

## Fidelity notes (read before trusting a number)

- **Seeded randomness.** `Math.random` is replaced by mulberry32 (seed `0x5eed`) in harness pages;
  the audio code itself draws from `Rng.js` streams, which the virtual pages seed with the probe seed
  (`setRngSeed`), so bird phrases, tune/form picks, noise offsets and humanisation are reproducible.
  Realtime timer interleaving still jitters by milliseconds, so two realtime runs are close, not
  identical — see `fidelity/repeat-mix-day-clear-busy` vs `mix/mix-day-clear-busy`. The app-live
  render is *not* seeded.
- **Selection pins (not synthesis edits).** Tunes and pieces are pinned on the one music sequencer
  as it starts (`page/scene.js` `pinSequencer`: `Sequencer.pin({ piece })`, set in a patched
  `_start` because the Town band picks its first piece in the window that opens at its start);
  Village's first song slot is held 9 s so the layer's level slew has settled, and the sequencer's
  `observe()` marks give the section, loop and chunk markers. BGM renders are loop 2 of the piece (loop
  1 contains the start-up level slew), except `bgm-willowbrook-summons-arrival`, which is loop 1 so
  the events land inside it.
- **Layer isolation** uses the director's own QA hook `forceLayer(name, 0, ∞)` on every other layer;
  their outputs sit at `MIN_GAIN × trim` (≤ -80 dB re full level), visible as a faint floor below -100 dB.
- **Frame pressure.** The harness page has no renderer, so `__claudeVillePerf.frameHealth` is absent
  and the director's frame-pressure level reads 0. The level is diagnostic only (it no longer changes
  any layer level); the app-live render records it in `capture.finalState`.
- **Warmup.** Layer and mix renders start after `warmup` seconds so the director's 3–6 s level slews
  have settled; bed renders start at audio start (swells begin 3–9 s in). Warmup audio is discarded.
- **Offline cues bypass the governor** (see above) and always play; `markerMetrics` margins are only
  meaningful for realtime renders, where the cue sits over a bed.
- **Levels are absolute at the engine output** at the standard volume step 6 (−14.4 dB after the
  limiter) unless the target name contains `vol100` (step 10, unity). OS/device gain is not modelled.
- **Headless audio.** Chromium's headless audio sink runs at 48 kHz and follows the wall clock
  (measured: 2.98 s of audio clock per 3.00 s wall). Output latency reported by the context is 16 ms.
  Under load it skips quanta (see the tap above); check `capture.gaps` before trusting a fine timing
  detail, and re-render a target alone (`--jobs 1`) if a gap sits on the event you care about.

## Metrics (per render JSON → `metrics`)

| key | definition |
|---|---|
| `loudness.integratedLUFS` | ITU-R BS.1770-4: K-weighting (any sample rate), 400 ms blocks / 100 ms hop, -70 LUFS absolute + -10 LU relative gate. Calibrated: 997 Hz sine at -20 dBFS on both channels → -20.0 |
| `loudness.shortTermMaxLUFS`, `momentaryMaxLUFS` | max of 3 s / 400 ms windows (100 ms hop), ungated |
| `loudness.loudnessRangeLU` | EBU Tech 3342 LRA from short-term values |
| `peak.samplePeakDBFS`, `truePeakDBTP`, `clippedSamples` | true peak = 4x windowed-sinc interpolation around every sample above half the sample peak (fs/4 sine at 45° → -9.0 sample / -5.9 true, theory -6.0); clipped = \|x\| ≥ 0.999 |
| `rmsDBFS`, `crestFactorDB` | whole-render RMS (both channels); crest = sample peak / RMS |
| `octaveBandRmsDBFS` | Welch PSD (8192 Hann, 50 %), mid channel, octave bands 63 Hz…16 kHz; a full-scale sine reads -3 dB |
| `spectralCentroidHz` | mean/sd of per-frame centroid (2048/1024) over frames above -70 dBFS; `activeSeconds` = time above that floor |
| `stereo` | L/R correlation, side/mid energy ratio (dB, -120 = mono), L-R balance |
| `onsets` | band-rise detector (7 broad bands, 2048/256, rise > 7 dB over the band level one window earlier, 60 ms min gap); `times`, `perMinute`, and `pitches` = strongest 60–5000 Hz peak in the 85 ms after each onset, as Hz + note name + cents (read melodies and cue contours from here) |
| `chroma` | pitch-class energy 80–4200 Hz, normalised; `top` = five strongest classes |
| `markerMetrics` | per `event` marker: max momentary loudness in [t, t+2.5 s] vs the energy mean of [t-3 s, t) → `marginLU` (how far a cue rises above what was playing) |
| `voices` | from the source log: `maxConcurrentSources`, `sourceStartsPerMinute`, `startsByKind` (O = oscillator, A = buffer source), `continuousSources` (never stopped: loops) |

JSON also carries `target` (the scenario), `capture` (seed, sample rate, gap count, atmosphere summary
with phase/progress/season/weather, world counts, a once-per-second `stateLog` of director levels /
now-playing / BGM section, final debug snapshot, page errors) and `markers` (times relative to the
start of the WAV).

## Reading the PNG

Top: title, then two lines of headline metrics. Marker labels (pink = events, cyan = ambient-song
sections, violet = BGM loops/4-bar chunks, orange = world actions) with dashed lines through every
panel. Spectrogram: mid channel, log frequency 30 Hz–20 kHz, gridlines 50/100/200/500/1k/2k/5k/10k
(100 Hz, 1 kHz, 10 kHz bold), A-note ticks A1…A8 on the right for pitch reading, a fixed colour scale
of -120…-30 dB per bin (same across the whole catalog, so brightness compares between renders),
yellow onset ticks along the bottom. Middle: peak envelope in dBFS per pixel column (L up, R down,
-72…0). Bottom: momentary (green) and short-term (yellow) loudness, -70…-10 LUFS, integrated as a
dashed white line. Time axis in seconds.

## Files

- `probe.mjs` — the probe (`npm run audio:probe`): CLI, pool, verdicts, baseline
- `lib/probe-virtual.mjs` — virtual-clock scene, margin, limiter, switch, duck and sync measurements
- `lib/probe-app.mjs` — the live-app checks (routing, away, ceremony, continuity, frame cost) and the lint units
- `lib/probe-wave2.mjs` — Wave-2 measurements (transport, pause, air, noise, bank, sequencer) and the reference-tree export
- `lib/soak.mjs` — the realtime soak (`--soak`)
- `lib/checks.mjs` — pure judges: S2 scene targets, lane windows, limiter GR, switch hole/bump, ducked time, onsets and AV sync, baseline comparison, Wave 2's transport, resume burst, noise lanes, air T60, bank, sequencer and frame-cost judges, Wave 5's workshop timing, level, focus, quiet-mix, quota and camera judges, and Wave 6's music judges (stem balance, band steps, the Isle arm, the envelope rebuild, rank correlation, rotation, breaths, loops, duty) (unit-tested in `scripts/tests/audio-probe-*.test.mjs`)
- `lib/probe-wave5.mjs` — Wave-5 measurements: published strikes, the stratum as ctx − env, audibility and the onset-weighted share, slots and focus, quiet-mix curves, the quota lane, camera crossings
- `lib/probe-wave6.mjs` — Wave-6 measurements: seat stems and bands, the Isle/Chip arm (music + air), nodes per note, the stop lint, visits, breaths and renditions from the sequencer's marks, percussion per bar and the density track
- `lib/music-sim.mjs` — the shipped Sequencer and OccasionClock headless in Node (a fake node-less graph, a stepped Transport): hours of score in seconds
- `score-analyzer.mjs` — the score analyzer (MUS-18): parallels, cue clash, ranges, renditions, re-hearing and motif statements on rendered notes, and `node scripts/audio/score-analyzer.mjs` — the songbook's composition gate (exits 1 on a failure; `scripts/tests/audio-score-analyzer.test.mjs`)
- `lib/scenes.mjs` — the probe's named scenes and cue placements
- `lib/virtual.mjs` — Node side of the virtual clock (one page per scene, stems out)
- `lib/format.mjs` — number formatting for reports
- `metrics/`, `fixtures/` — the ported metric libraries and scenario fixtures (table above)
- `baselines/scenes.json`, `baselines/soak.json` — the reviewed baselines (`--update`, `--soak --update`)
- `audio-capture.mjs` — harness CLI, pool, capture orchestration, INDEX writer
- `lib/targets.mjs` — the catalog (edit here to add a target; every cue kind, layer, tune and piece has one)
- `lib/capture.mjs` — page setup, PCM transfer, underrun-splice mapping, renders root
- `lib/timeline.mjs` — wall-clock alignment and the silence-aware cue margin (pure Node)
- `lib/analyze.mjs` — WAV I/O and every metric (pure Node)
- `lib/plot.mjs` — PNG drawing on a Chromium canvas
- `lib/server.mjs` — read-only static server (127.0.0.1, ephemeral port)
- `page/init.js` — seed, focus guard, destination tap, envelope lint (`__harNoLint` skips its stack capture), voice log
- `page/runtime.js` — in-page scenario runner (realtime, offline cues, snippets)
- `page/scene.js` — the scenario vocabulary both runners share (worlds, atmosphere, stored settings, actions)
- `page/virtual-clock.js`, `page/virtual.html`, `page/virtual.js` — the virtual clock (timer attribution, source accounting) and its renderer (scenes, engine and Island Air units)
- `page/workshop.js` — Wave 5's renderer stand-ins: a ritual conductor that draws downbeats for observed tool starts, a scripted camera
- `page/music.js` — Wave 6's music probe: sequencer marks and pins, seat stem taps, node constructions per note, automation recording for the stop lint, MusicClock frames
- `page/probe-app.js` — in-app driver for the probe (sim fixture, away/return, cue-bus watch, blur/focus, frame profile)
- `snippets/` — example snippets (`example-glass-bell.js` standalone, `example-crickets-softer.js` A/B)
