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
nothing unless `--out` or `--update` is given. **Status:** the Wave 7 gate (`PLAN_STAGE` 7) over the two
sound presets, Signals and the Town band (v0.47.1 removed the Village preset and every check that only
it had: the world map, the sea, thunder, the workshops, the held note, the occasion clock). The default
run is estimated at 12–15 minutes with `--jobs 2` (the virtual-clock checks ≈ 8–10 min — the per-piece
stem matrix is four renders per piece of `PIECES`, so it grows with the songbook —, then the live app,
the frame-cost run, the awakening, the caption probe and the lint ≈ 4.5 min); `fps` judges only on a
quiet host and `bank` slices are real time, so a loaded host can fail either.

```sh
npm run audio:probe                                   # every check (virtual clock + the live-app checks)
node scripts/audio/probe.mjs --only scenes            # a subset (names below), e.g. to calibrate PROGRAM_TRIM_DB
node scripts/audio/probe.mjs --only scenes,margins --no-worklets   # the native limiter/meter fallbacks
node scripts/audio/probe.mjs --update                 # re-measure and rewrite baselines/scenes.json (review the diff)
node scripts/audio/probe.mjs --jobs 3 --seed 7        # parallel virtual renders, another seed
node scripts/audio/probe.mjs --out /tmp/probe         # also keep probe-report.json and every scene's WAV
node scripts/audio/probe.mjs --soak                   # the 20-minute realtime soak instead (below)
```

Each line prints `PASS`/`FAIL`/`INFO`/`DEFER`/`WARN`, the check, and its numbers; `WARN` flags a finding that is not a verdict on the gate.

### Plan stage and deferred checks

`PLAN_STAGE` in `lib/checks.mjs` is the wave the probe gates (now **7**); bump it at each wave's exit.
A criterion whose owner lands in a later wave is listed in `GATED_FROM` with that wave: it is measured
and printed as `DEFER` with the same numbers and the wave that gates it, counted in the summary line,
and never fails the run. Once `PLAN_STAGE` reaches its wave it gates like everything else. At stage 7
`GATED_FROM` is empty: every criterion gates. Targets come from `Loudness.js` and the plan's
acceptance lines only; the committed baselines detect drift and can never turn a failed target into a
pass.

Every lane gates at its full S2 window, the error and limit band rule and ceilings with the Wave-3
signal voices, and urgent GR ≤ 3 dB. Over the Signals preset nothing sounds between the cues, so a
call's margin reads its level over the −80 LUFS silence floor: that bed is quieter than any S2 row, the
lane's ceiling is exempt there (S2's rule for a cue that lands into a bed that quiet) and the floor, the
band rule and the GR limit still gate.

The quiet mix (5.6, D3: the Town band −3 dB while the window is blurred) is judged against a twin
render of one seed that never blurs: the two share every draw, so their difference is the fader alone,
sample for sample.

Wave 6 added the music checks (`musicstems`, `isleband`, `nightmusic`, `score`, `townband`,
`percussion`); every one gates now, and every per-piece check iterates `PIECES` and `PLAYLISTS`
(`bgm/BgmSongbook.js`), so a new piece is covered without a probe change. Levels, stems, nodes and the
stop lint are measured on the virtual clock; the score (8 hours of the Town band) is the shipped
`Sequencer` compiled headless in Node (`lib/music-sim.mjs`: the 8 hours in about a second), so
every acceptance line runs in the default probe — there is no opt-in long mode.

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
of one scene differ by max |Δ| ≈ 1e-9…1e-8), and a minute of the Town band renders in about a
second. A hidden tab is modelled on request (`freezeOnSuspend`, the
`pause` scenes): while the app holds the context suspended the render holds at its step, so the
audio clock stops as a real suspended context's does while the virtual clock (timers, the hidden
page) runs on. Stems (HAR-5) ride extra destination channels through a channel
merger, sample-aligned with the program: `music` post-duck (`engine._busOut('music')`, the one bus
beside the cues), `cue` (`engine.busInput('cue')`, before its trim), `limiterIn`/`limiterOut`
(`engine._limiterIn`/`_limiterOut`) and `airWet` (`engine.airReturns.wet`, Island Air's return before
its trim).
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
event), `play` (a governor-free cue through `CueKit._playAccepted`, the capture tool's path) and
`storage` (Wave-3 settings). A scripted `cue` goes to the director that owns the signal route: the
active one while it plays, else the signals director. Wave 7: `mode` (a stored preset id: `signals`,
`bgm`) and `preset` (`off`, `signals`, `townBand`) go through the controller's `setPreset`; the
listening options (7.7) are stored settings the controller applies at the enable (`lib/scenes.mjs`
`listeningStorage`: `claudeville.sound.output`, `.tone`, `.soften`); every `audio:awakened` is logged
in audio time (`meta.awakens`), every `audio:cue-played` with `announceOnly` and the one-time
`familyLine`, and `meta.output` is the engine's `outputSnapshot()` at the end. Agents work through
`currentTool`/`currentToolInput` (`lib/scenes.mjs` `workFixture`: one tool per building, varied per
call), each tool start a `status` action on the 2 s poll grid (phase 0.4 s) that also burns tokens (the
Mine): the Town band's percussion densities follow them. Every state-log row carries
`__claudevilleAudio().quietMix`.
state-log row carries `__claudevilleAudio().quietMix`.

Wave 6 (`page/music.js`, `page/virtual.js`): a scene's `musicProbe: { seatStems, countNodes,
stopLint }` patches the one `Sequencer` (the harness's prototype pattern: the Town band starts its
first piece in the window that opens at its start) and returns `meta.music`: every `observe()` mark
(`note` and `perc` per placed note, `start`/`end` per visit with its reason,
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
voice's peak (S8: ≤ −60 dB). Every state-log row carries the Town band director's `music` snapshot
(what plays, the last start and its reason). `lib/music-sim.mjs` runs the same `Sequencer` on a
node-less fake graph and a stepped Transport (0.25 s ticks, 1.5 s horizon): the score, with no audio.

**Seeded streams and accounting (Wave 2).** Every virtual page calls `Rng.js` `setRngSeed(seed)`
before the app starts, so each music and cue stream is deterministic per probe seed; a
scene's `rng: { constant }` instead pins every draw (`setRngOverride`, and `Math.random` for older
trees). `page/virtual-clock.js` also keys every timer by its call site (the first app frame of
the `setTimeout`/`setInterval`/`requestIdleCallback` call), times each callback's synchronous part on
the real clock, and logs every source `start()` on the scene context with the timer site that was
running (its callback and the promise chains it started), the context state, and for buffer sources
the buffer identity, offset and rate. Sources on other contexts (bakes) are not counted. It also
records node→node connections, so the page can trace which sources reach the cue or music bus.

Scenes (`lib/scenes.mjs`) start from stored settings the controller loads as a calibrated profile
(the stored preset — `bgm` unless the scene says `signals` —, the standard volume step, `claudeville.sound.calibration = 2`);
`warmup` seconds settle the enable fade and the level slews and are discarded. The harness page has no
AttentionService, VillageDirector or AgentEventStream, so scenes emit their events (`attention:raised`,
`attention:acknowledged`, `distress:watchtower`, `village:scene`, `chronicle:aurora`, `team:gather`,
`outcome:verified`, `tool:result`, `agent:added`/`agent:updated`/`agent:removed`,
`mode:changed`) after setting the agent's status, which is what bucket routing and the ladder read. Cue placements respect CueKit's per-kind
cooldowns and the governor's spacing and rate (the routine lane is 4/min since outcomes reserve
2 of its 6), so every placement is admitted.

| check | what it asserts |
|---|---|
| `scenes` | S2's Town band row from `Loudness.js` at the standard step: the Town band busy (6 working, 3 minutes of arrivals, a needs-you, an error, a recovery, a rate limit) −31 ± 1 LUFS-I with the band stem's ST max ≤ −28. INFO rows: TP, LRA, limiter GR, HAR-5 stem levels and shares, and the level map (2–5 kHz share, S/M, correlation, mono fold, laptop loss) |
| `margins` | HAR-3: every lane (needs-you, error, limit, routine, scenery, outcome Minor turn done, Medium push, Major release) and every voice S2's row names for it (`MARGIN_VOICES`: routine = arrival, council, departure; scenery = the aurora and the hour bell, D7's phrase on the director's own tick at 13:00) over four beds: the Town band (the probe's counted crowd), the busy Town band over the busy island's tool fixture (every building working: arrangement and percussion play) in Isle and in Chip for the urgent lanes, and S2's no-music bed as the Signals preset plays it (CueLevel's `village` context: silence between the attention voices) for the urgent lanes, the only ones it sounds; 3 placements each (the aurora and the release once: a 120 s cooldown, one Major active; the council's three 63 s apart, its 60 s cooldown). Each voice is judged on its own placements. **Each lane renders alone** (`margin:<bed>:<lane>`, a lane's other voices `margin:<bed>:<lane>:<voice>`, the hour bell one chime per render, `…:hourBell#<p>`, for its 55-min cooldown; a render per lane, voice and bed): its placements keep their slots on a 7 s grid shared by all lanes (so every placement sits at the same bed moment whatever the other lanes do, and a lane's own placements are 42–56 s apart), but no other lane's cue plays. The bed under a placement depends on every cue before it — ducks, and the music, which takes different turns for good after the first cue — so over one shared render a lane moved when another lane's voice changed: limit over music read presence rise 6.8, then 6.0 dB with its voice untouched; on one seed, the three limit placements over music read 6.6 / 8.8 / 6.9 dB interleaved and 6.1 / 4.8 / 9.3 dB alone, and the music alone rises −3.8…+3.4 dB at those onsets. A clean-bed gap before each placement would not fix it (the music never re-converges). Margin = max momentary in [t, t + 2.5 s] over the energy mean of the 3 s before, t = the cue's first published note. The median must sit in the lane's full S2 window, urgent lanes (needs-you, error, limit) must also pass the band rule (over music: 0.5–4 kHz energy of [t, t + 1.2 s) ≥ 6 dB over [t − 3, t), ≥ 5 dB for the error over the busy Town band beds — S2's closure ruling, `checks.mjs` `BUSY_BAND_ERROR_BAND_RULE`; elsewhere: ≥ 2 third-octave bands rising ≥ 6 dB) and limiter GR ≤ 3 dB within 2.5 s of the onset (over the Signals silence a call reads its level over the −80 LUFS floor, so its ceiling is exempt: S2's rule for a bed that quiet), and the Minor outcome's median sits ≥ 3 LU under routine's on the same bed. **Minor outcomes (Wave-4 ruling)** are judged on the cue's own level over the bed — the cue stem's max momentary in [t, t + 2.5 s] over the energy mean of the music stem (same bus staging) in the 3 s before — so a swell of the band under a quiet knock cannot lift or sink it; the Minor-under-routine comparison uses that measure for both. The same measure for every other lane prints as INFO with the verdicts it would flip so the other lanes keep the program margin. `townband` (needs-you over music) reads the same per-lane renders |
| `limiter` | 1.1: at full slider, a +12 dBFS burst at the limiter input (1 kHz sine, then noise) leaves the worklet at `Loudness.js` `LIMITER_CEILING_DBFS` (+0.1 dB) and ≤ −1 dBTP, and the native fallback (`__claudevilleAudioNoWorklets`: `DynamicsCompressor` + tanh, an emergency path) at ≤ −0.9 dBFS sample peak; a −20 dBFS sine passes both at 0 ± 0.2 dB |
| `switch` | must-never 12: Signals → Town band 15 s in and back 30 s later, over the controller's 0.8 s signals fade (`SIGNALS_FADE_SEC`). Signals has no bed, so each direction is judged for what it is (`presetSwitch`): out of the band, the momentary loudness of the 4 s after the switch never rises 3 dB over the band's p90 (before: [t − 8, t)), the program's peak in the 100 ms after the fade's end is ≥ 20 dB under the 2 s before the switch (what remains is the room's tail), it falls silent (< −80 dBFS) within the 4 s, and after the fade no 10 ms block over −90 dBFS rises more than 6 dB over the three before it (no click); into the band, no rise 3 dB over the band's settled p90 ([t + 6, t + 14]) and the band heard (a 10 ms block over −60 dBFS) by the fade's end |
| `ducks` | 1.3: every `engine.duck` window (recorded with its cancellation), attack and release included, unioned on the music bus (the one bus a cue ducks): ≤ 5 % of the Town band busy scene, with at least one window |
| `avsync` | HAR-12: every published note of every sounding cue score vs the first onset heard on the cue stem near it (a 1 ms frame ≥ 6 dB over the 10 ms before it; a pair's second note struck over the first's ring reads ≈ 8–17 ms late): median \|error\| ≤ 20 ms, p95 ≤ 40 ms. Four arrivals whose accent is declared 450–800 ms ahead, as the renderer does, over the Town band (Signals sounds no arrival): each carrying note sounds at its accent (C-CUE-5) or S4's grid moved it onto the band's grid (a sixteenth of a published MusicClock frame) within ±`BODY_SNAP_SEC` (60 ms) of it, and is heard within 40 ms of where it was published. The release crown (3.4): the peal's published carrying note (`CUE_ACCENT_NOTE.release`) within ±15 ms of the accent the renderer declared 900 ms ahead (the `outcomes` fixture) |
| `determinism` | the Town band busy scene and the same busy stretch in Signals rendered twice agree within 0.2 LU |
| `baseline` | every scene LUFS-I and ST max and every lane's median margin within ±1.5 of the committed `baselines/scenes.json`; `--update` rewrites the numbers it measured (merged with the rest) and prints the deltas. Drift only: every target above is judged on its own, so a baseline never passes a failed target. Re-baseline, reviewed, when `PROGRAM_TRIM_DB` is re-measured (end of Waves 1, 4 and 6) or a reviewed change moves a scene |
| `transport` | 2.1 (S4, ENG-8), 10 minutes of a busy island on the virtual clock (three busy stretches in the Town band, rain at 5:00, Signals 7:00–9:00; the lint's stack capture off so timer costs are the app's): `engine.transport.diagnostics()` shows 0 underruns and every process's furthest committed window ≤ 1.5 s ahead; among the app's timer call sites exactly one started continuous sources (the sequencer, bank playback), and it is `Transport.js`'s — discrete cue voices (sources reaching the cue bus, traced through the node graph), control-rate decisions placed on the audio clock with a lead, are listed apart and exempt; its tick costs ≤ 0.5 ms p95 and ≤ 2 ms max of real main-thread time (the page clock resolves 0.1 ms). INFO: starts from the harness's own actions and the 2 Hz atmosphere pump (event-driven), lateness on the virtual clock (bounded by its 10.7 ms steps), other timers over 2 ms |
| `pause` | 2.1 pause in place, Signals and the Town band: 120 s hidden 30 s in (frozen audio clock, above) → the context is suspended, 0 sources start while suspended, none is placed in the past after resume (catch-up smear), the first second after resume holds ≤ the steady onset rate of the 30 s before + 1 (onsets = distinct start times), and the Town band plays the same piece after as before |
| `air` | 2.4 (S5): the two baked IRs' T60 (Schroeder T20, octave bands) — day 1.1 ± 0.15 s and night 1.55 ± 0.2 s at 1 kHz, 4 kHz ≤ 0.8 × 1 kHz; through the real cue path over the Town band with its air sends cut, an arrival placed at d = 0 has direct-to-reverberant ≥ +8 dB and one at d = 1 ≤ +1 dB (cue sum vs the air's wet return over 4.4 s), and every needs-you's wet ≤ −14 dB re its dry (2.5 s); the Town band busy scene with the air vs every send cut: ≤ +1 LU. INFO: the same D/R with raw `place()` sends on the music bus |
| `bank` | 2.6 (S8): `engine.bank.stats()` after the air bake and after the Town band busy scene — every client within its `MEMORY_BUDGET` row, the total within `totalBytes` — and every SampleBank idle slice ≤ 5 ms of real main-thread time (the idle callback's synchronous part — plan, offline graph, render start — timed by the virtual clock; the bank's own `sliceMsMax` reads the frozen virtual clock there and is only meaningful live) |
| `discrim` | 3.1–3.5, S1 (CUE-9): 26 voices — every signal family, the L4 reminder, `answered`, every outcome, four routine alloys, departure, recovery, council, the hour phrase and the counted noon, aurora, the link cues and the digest — each played governor-free in Signals (nothing sounds between the cues) on the cue stem. Contour and rhythm come from the published score (onsets and each note's resolved `hz`; unpitched notes take the last pitch, a tree without `hz` falls back to the pitch measured at the onset), timbre from the render (`metrics/discrim.mjs`). Gates: every signal voice vs every other voice ≥ 2 of contour, rhythm, timbre (a reminder is not judged against its own family's entry; `answered` plays only in Signals and is judged against signal voices); needs-you, error, limit pairwise ≥ 2/3; every outcome vs needs-you ≥ 2/3 with its 3/3 count reported (3.4 asks 3/3, written for the door chime; a single strike cannot differ in contour from the ship's bell's flat opening under S1's opening-interval rule); no non-signal cue opens with a quick (< 1 s) same-pitch pair. INFO: every voice's notes, brightness, strike, ring and output M-max; openings that quote a call |
| `ladder` | 3.3 (D6, S7): sound off (`runSilent`, no `AudioContext`), one wait per family opened 5 s in and never answered, 61 min: the calls (entry + reminders, from `audio:cue-played`) match the schedule — needs-you L1 → L2 at 2 min → L3 at 6 → L4 at 15 and 30 → L2 at 60; errors the same capped at L3; quota L1 and one L2 — within one late tick, none unexpected; reminders ≥ 120 s apart and ≤ 12 in any hour; each captioned by a real Toast at the default setting. Acknowledged at 3.4 min: no call for 10 min. Sound on in Signals (the no-music bed): L1, L2, L3 keep the entry trim, L2 ≥ 4 LU under L1, L3 GR ≤ 3 dB; the same wait over the Town band holds the entry call's trim too, with L2 ≥ 4 LU under L1 judged on the calls' own levels (the cue stem's M max: over music a quiet reminder's program margin reads the band). Hidden tab with sound on (frozen clock) from 25 s: the reminders due at 2, 6 and 15 min each render on the cue stem within 60 s of their time |
| `cluster` | SIG-10: six needs-you (and six errors) raised on one tick in Signals vs one: program M-max over the 4 s after within +1 LU of the single call, all six agents captioned, urgent GR ≤ 3 dB; INFO: sounding scores (the lead and its flock strikes) |
| `outcomes` | 3.4 through the producers: `outcome:verified {push}` → one push cue with published notes; ten exit-0 `tool:result`s → silence; ten failures from one agent in 60 s → 1–2 cues; a ≥ 20 s turn ending, a sub-agent dispatched and returning (`parentSessionId`, `agent:removed`) and a verified release each → one sounding cue; a Dashboard fixture (`mode:changed` → dashboard, `agent:*` transitions only) still yields turn done and the return |
| `captions` | 3.8 (HAR-13): 21 kinds through the director's cue path, 12 s apart, in Signals and the Town band, sound on (rendered) and off (`runSilent`), four Toasts (auto, signals, events, all): a caption shows exactly when S6/3.8 says — signals always; outcome and routine with *events* or *all*, and by default only while sound is on; scenery only with *all* and sound on; the digest never (sound-only) — never without a played cue, and with sound on every captioned cue had a sounding score unless it was announced only (Signals captions every kind but the attention voices without sounding it: the director submits them `announceOnly`; the played event carries only the fact, so the page reads the mark off `CueKit.play`). Sound off at the default setting shows no outcome or scenery caption |
| `honesty` | must-never 13: no two urgent scores for different agents share two note times within 5 ms (the six-raise cluster renders), and stale agents (`signalStale`, `freshness.state: 'stale'`, `resident`) raising a needs-you and an error in Signals produce no sounding signal score |
| `quietmix` | 5.6 (D3): the Town band (Willowbrook pinned) over four workers, blurred 20–40 s, against a twin that never blurs, levels on the music stem in 0.1 s blocks: −3 ± 1 dB while blurred and back within 1 dB ≤ 1 s after focus. INFO: the controller's `quietMix` state |
| `musicstems` | 6.2 (MUSL-10, MUSL-2, MUSL-3, HAR-11): every piece of `PIECES` × day (12:00 arrangement) and night (22:30) × Isle and Chip, the Town band pinned to its full band over a busy island (every building working, so percussion plays), each seat on its own stem, measured over the first 16-bar rendition (output-referred LUFS-I). Stems re lead: bass −3.5 ± 1.5, counter −6 ± 2, engine −8 ± 2, percussion −14 ± 3 LU; every admitted seat (the descant too) ≥ −15 LU and under the lead; the voice the band played is the pinned one; each of the arrangement's seats (lead, counter, engine, descant — C4: in the Isle voice the piece's own players, in Chip the keyframe row) is played by the instrument `Voicings.voicingFor({ piece, … })` seats there, and by it alone (the note marks' `instrument`). Bands: band k is the sum of the seats `Voicings.voicingFor` admits at the arrangement the band played (the piece's own) (seat content never depends on the band), its onsets the admitted seats' notes; each band vs the one below ≥ +30 % onsets or ≥ 3 dB in some octave band (63 Hz–8 kHz). Both gate on the combinations the Town band plays (`PLAYLISTS`: day pieces by day, night pieces at night); a piece in the other phase's voicing prints as INFO. INFO: every seat's LU re lead (the Voicings calibration) |
| `isleband` | 6.1 (MUSL-1, D2), from the same renders: the music bus plus the air's wet return (the Town band's only send), level-independent measures of the same notes — Isle laptop-model loss (4th-order 200 Hz high-pass) ≤ 1.5 LU, S/M −16…−9 dB, mono fold loss ≤ 1 LU, day and night (Chip printed beside it); Isle's 2–5 kHz share at night ≥ 4 dB under the same piece by day; ≤ 4 node constructions per note (every note after its player's first); the music client's resident bytes (`engine.bank.stats().byClient.music`, the Town band busy scene) ≤ `MEMORY_BUDGET.music` (bake slices: `bank`) |
| `nightmusic` | 6.3 (MUSL-4): every night render — the lead sounds ≤ A5 (night pieces; day pieces at night INFO), and no stopped music voice is above −60 dB re its peak at its stop (the stop lint). INFO: the night 2–5 kHz share Isle vs Chip (≈ the shipped band's timbres; 6.3 asks ≈ 6 dB) |
| `score` | 6.5 (MUS-18, `score-analyzer.mjs` on rendered notes and `MusicClock` frames): melody–bass parallel fifths/octaves 0 in every stem render; routine cue notes (published `hz`) over the sounding chord in the Town band busy scene: 0 % clash; 8 hours of the Town band (headless, seeded; the working count, densities and waits move every 2–6 min): no two identical 16-bar renditions of a piece < 60 min apart, by the sequencer's rendition keys and by the analyzer's (notes on the sixteenth grid); INFO: the first hour's tonal and phrase re-hearing and its motif statements |
| `townband` | 6.7 (SCN-7, MUS-7, MUS-9, S7, must-never 10): a 60-min Town band session (12 kHz, the busy island, a needs-you at 20:00 answered at 26:00): no piece back within 6 min of its visit's end (4 with < 4 pieces in the day set); ≥ 1 breath or interlude in every 10 min and each breath 1.4 ± 0.05 s; music duty ≥ 85 % and interludes ≤ 15 %; tonal re-heard (`session-metrics` `dejaHeardPct`) ≤ 25 % in each of the session's six consecutive 10-min windows, each measured on its own history (the basis of SCN's 34.5 % baseline; the whole hour's figure prints as INFO); ≤ 12 loops (identical renditions) per piece in the hour; session LUFS-I −31 ± 1; the needs-you over the band in its S2 window (judged on the `margins` needs-you render over music at 48 kHz — the 12 kHz session cuts the bell's upper partials, so its figure is INFO). 8 hours headless: the same loops and returns. The waiting cadence: a needs-you open 10–70 s — the director tells the band within its 1 s tick; the band decides a phrase end's cadence when it compiles the phrase end's 4-bar chunk (1.5 s ahead), so the sequencer's marks, in the order it made them, split the phrase ends: every one compiled while it waits is deceptive (one compiled before the wait came prints as such), the first compiled after the answer lands home |
| `percussion` | 6.9 (SIG-16, MUS-16, D4): ten Town band minutes while the island's workshop density climbs and falls (two-minute segments, then nobody working): Spearman ≥ 0.7, over the bars that drum (piece passes; tags and interludes play no workshop kit), between the kit's level per bar — each hit in units of its building's row in the piece (Σ min(1, weight) over the row: the hits it plays per bar at density 1), so a lullaby's near-silent rows and a march's dense ones read on one scale — and the total density the band read when it compiled the bar's chunk (the last `setWorkshopDensity` before the chunk's mark); no hit once the director's densities empty at working 0 (+1.5 s horizon); the percussion stem −14 ± 3 LU re the lead in the busy segment. Rain at 30 s over the busy band: the arrangement switch lands on a chunk boundary — the first one not yet committed when the rain came (1 s tick + 1.5 s horizon) — and every chunk after it plays the rain arrangement |
| `signals` | 7.2 (UX-3): the busy stretch (arrivals, a needs-you, an error that recovers, a limit, a departure) in the Signals preset, captions at the default setting, once with the needs-you answered at 70 s and once left open (the ladder's L2 at 2 min): every 400 ms program window after the warmup outside a sounding cue (first published note − 50 ms to its last note + 6 s) < −80 dBFS; the needs-you call's loudest window ≥ 20 dB over the loudest floor window (a silent floor counts at −80 dBFS); every arrival captioned, not sounded, and its 3 s after < −80 dBFS. INFO: the Signals-only `answered` strike |
| `awaken` | 7.4 (UX-5, SCN-8), virtual clock: the first enable of a page session in the Town band (the default preset), a needs-you at 26 s, Off at 33 s and the Town band again at 35 s: exactly one `audio:awakened`; the awakening's cue-stem M max (2 s) ≥ 12 LU under the needs-you call's (2.5 s); the program's short-term 4 s after the enable within ±3 dB of steady (the energy mean of the short-term values over 10–25 s) |
| `listening` | 7.7 (UX-10, UX-14, SOTA-14), stored settings applied at the enable: Mono vs Speakers on the Town band with an arrival and a needs-you — LUFS-I within ±0.5 LU and L = R; tone ±1 on the Town band (Willowbrook, cue-free): 5–10 kHz ±4 ± 1 dB vs tone 0 and 100–1000 Hz within ±0.5 dB; Soften on vs off over the Town band: the arrival bell's attack (5 ms RMS windows, −40 dB → −1 dB re peak) ≥ 22 ms, every non-needs-you duck depth 0.7 ± 0.05 × off, the needs-you call's M max within ±0.2 LU |
| `lint` | HAR-4 envelope lint (below) finds no hazard, and each unit started at least one source: every cue kind (`cue-gallery` and the `*-night` cues, offline) and `bgm-night-to-signals` (a Town band night piece, then a switch to Signals: exercised only if the final mode is Signals); INFO: the app session's hazards |
| `routing` | must-never 2: an errored agent's `audio:cue-played` kinds are all `distress`, a rate-limited agent's all `limit`, never `summons` — with `attention:raised` first, with `distress:watchtower` first, and through the live producers (a sim status step) |
| `away` | must-never 4: after a real TopBar click (`--autoplay-policy=user-gesture-required`), a needs-you raised 5 s into an absence sounds. Hidden tab and blur with `claudeville.sound.background = signals` close the bed, so the call must stand the `Loudness.js` needs-you minimum (+10 LU) over the preceding `bedWindowSec` (3 s) of what the listener heard — a suspended context counts as silence, scored at −80 LUFS. A plain blur keeps the full mix (decision D3), so there the call must reach the cue bus (≥ −60 dBFS) with the context running; its margin over the bed is must-never 1, gated on the virtual clock by `margins` |
| `resume` | must-never 5 (runs with `away`): after each blur→focus and hide→show, `contextState` is `running` within 1 s |
| `ceremony` | must-never 6: the `team-gather` sim fixture, started over an empty island with sound on, yields exactly one `council` cue-played within 15 s |
| `continuity` | 2.1, realtime app: in the Town band, blur 3 s → focus keeps the same piece (`nowPlaying`), and the momentary level 0.3 s after focus is within 6 dB of the 3 s before the blur |
| `fps` | 2.4, realtime app (`perf-12-agents`): `world:benchmark-fps`'s frame total (`__claudeVillePerf` frame profile, update + render) in alternating 15 s segments, sound off / on / off / on; p95 with sound on − off ≤ 0.1 ms. When the two sound-off segments already differ by the limit (the page clock resolves 0.1 ms; a busy host) the delta prints as INFO, not a verdict — re-run on a quiet host |
| `awakening` | 7.4, realtime app on a fresh profile: the first click on the note opens the presets and the press on the Town band (the default radio) enables; the tapped program's first sample over −70 dBFS ≤ 150 ms after that press (the worklet load included); the note off and on again in the same page session emits no second `audio:awakened`. INFO: the realtime short-term 4 s after the press vs steady (judged by `awaken`) |
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
recovers, a push, a failed push, a lull, a rate limit) in Signals and in the Town band, sound enabled by a real
TopBar click, the fixture played through the sim driver. It reports the session metrics
(`metrics/session-metrics.mjs`: LUFS-I, LRA, silence share, music on-time, tonal re-hearing, cue
density), gates ducked time ≤ 5 % of the music bus, and reports HAR-12's renderer lag (drawn accent frame −
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
| `metrics/amb-metrics.mjs` | `amb-snippets/metrics.mjs` | `repetition` (autocorrelation lags, ICC), `rt60` (Schroeder T20 per octave, C80), `wetDry`, `autocorrelation`, `icc` |
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
node $T bgm                                    # a whole category (cues, cues-providers, cues-pan, bgm, signals, fidelity)
node $T 'bgm-*' --jobs 4                       # name prefix glob
node $T signals-day-urgent --seconds 20 --out /tmp/x   # override the recorded length (warmup unchanged) and the output root
node $T analyze some.wav [--markers m.json] [--out dir]   # metrics + PNG for any WAV (PCM 8/16/24/32, float 32/64)
node $T index                                  # rebuild <renders>/INDEX.md from <renders>/baseline/**/*.json
node $T replot [--out dir]                     # re-analyse every WAV under a root and redraw PNG/JSON (after a metric/plot upgrade)

# prototype a new recipe and render it through the identical analysis (one command):
node $T snippet --snippet scripts/audio/snippets/example-glass-bell.js --seconds 5 --offline
# A/B a code change against a catalog target: patch prototypes in a snippet's `before(api)`, render the same target
node $T bgm-willowbrook-steady --snippet my-change.js --name bgm-willowbrook-steady-changed
```

`<renders>` is `$CLAUDEVILLE_TEST_TMPDIR/claudeville-audio-renders` (or the OS temp dir). Flags:
`--seconds N` (recorded seconds after warmup; for song/loop targets the song/loop decides),
`--out dir` (default `<renders>/baseline` for `all`, else `<renders>/scratch`), `--jobs N` (parallel
realtime pages, default 6), `--seed N` (Math.random seed, default `0x5eed`), `--name id` (rename a
single target or a snippet render), `--offline` (snippet on an OfflineAudioContext),
`--volume-step 0-10` (snippet master volume step, default the standard step 6).

Every render writes `<name>.wav` (32-bit float stereo, context rate — 48 kHz in headless Chromium; float
because the quiet passages sit at -45…-70 LUFS where 16-bit quantisation noise would bias spectral metrics),
`<name>.png`, and `<name>.json`.

## Snippet API

A snippet is an ES module served to the harness page. Two modes:

**Standalone (`snippet` command).** `export default async function (api)` receives

| field | meaning |
|---|---|
| `context` | an `AudioContext` (realtime, default) or `OfflineAudioContext` (`--offline`) at 48 kHz |
| `destination` | `context.destination` — tapped in realtime, rendered offline. Connect here to bypass the shipped master chain |
| `engine` | a real `AudioEngine` attached to `context` (`engine.attachContext`, limiter worklet loaded), fade pinned open: `engine.busInput('cue' \| 'music')` → program trim → … → limiter → volume step → destination (see the chain in `AudioEngine.js`). Connect there to hear your recipe exactly as a shipped cue or band player would sound |
| `modules` | the shipped classes: `AmbientAudioController, eventBus, createAtmosphereSnapshot, AudioEngine, SignalDirector, CueKit, CueGovernor, cueNoteOffsetsMs, PIECES` |
| `mark(label, { t, kind })` | add a marker (default time = `context.currentTime`; `kind: 'event'` gets a cue-margin row in the JSON) |
| `seconds`, `offline` | render length and mode |

Anything else is one `await import('/src/…')` away (same URLs as the app). Offline snippets must
schedule everything before returning (timers do not advance an offline render); realtime snippets
may use `setTimeout`/`setInterval` like the shipped directors do. Realtime renders record exactly
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
| `realtime` | the Town band, Signals, preset switches | The directors and the sequencer are driven by `setInterval`/`setTimeout` and read `ctx.currentTime` at call time, so only real time reproduces them. Headless Chromium runs with `--autoplay-policy=no-user-gesture-required`; the page is `page/harness.html`, which imports the shipped modules and constructs the real `AmbientAudioController` with a synthetic world. The CLI clicks the page first (a real user activation), then the page calls `setPreset(<stored preset>, { fromUser: true })`, the enable path a TopBar pick takes. |
| `app-realtime` | `fidelity/app-live-sim-day` | The full app from `startIsolatedServer()` (ephemeral port) at `/?sim=1`, renderer running, sound enabled through the real UI (the first click on `#topbarSoundToggle` opens the SOUND panel's presets; the Town band radio is pressed), hour/weather set through `window.__claudeVilleAtmosphere()`. Cross-checks that the renderer-free harness is representative. |

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
`distress:watchtower`, `team:gather`, `agent:updated`).

## Fidelity notes (read before trusting a number)

- **Seeded randomness.** `Math.random` is replaced by mulberry32 (seed `0x5eed`) in harness pages;
  the audio code itself draws from `Rng.js` streams, which the virtual pages seed with the probe seed
  (`setRngSeed`), so piece picks, noise offsets and humanisation are reproducible.
  Realtime timer interleaving still jitters by milliseconds, so two realtime runs are close, not
  identical — see `fidelity/repeat-bgm-willowbrook-steady` vs `bgm/bgm-willowbrook-steady`. The app-live
  render is *not* seeded.
- **Selection pins (not synthesis edits).** Pieces are pinned on the one music sequencer as it starts
  (`page/scene.js` `pinSequencer`: `Sequencer.pin({ piece })`, set in a patched `_start` because the
  Town band picks its first piece in the window that opens at its start), and the sequencer's
  `observe()` marks give the loop and chunk markers (labelled `band<N>`). BGM renders are loop 2 of
  the piece (loop 1 contains the start-up level slew), except `bgm-willowbrook-summons-arrival`, which
  is loop 1 so the events land inside it.
- **Frame pressure.** The harness page has no renderer, so `__claudeVillePerf.frameHealth` is absent
  and the director's frame-pressure level reads 0. The level is diagnostic only; the app-live render
  records it in `capture.finalState`.
- **Warmup.** Band renders start after `warmup` seconds so the director's level slews have settled.
  Warmup audio is discarded.
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
with phase/progress/season/weather, the band's section counts, a once-per-second `stateLog` of director levels /
now-playing / BGM section, final debug snapshot, page errors) and `markers` (times relative to the
start of the WAV).

## Reading the PNG

Top: title, then two lines of headline metrics. Marker labels (pink = events, violet = BGM loops/4-bar chunks, orange = world
actions) with dashed lines through every panel. Spectrogram: mid channel, log frequency 30 Hz–20 kHz, gridlines 50/100/200/500/1k/2k/5k/10k
(100 Hz, 1 kHz, 10 kHz bold), A-note ticks A1…A8 on the right for pitch reading, a fixed colour scale
of -120…-30 dB per bin (same across the whole catalog, so brightness compares between renders),
yellow onset ticks along the bottom. Middle: peak envelope in dBFS per pixel column (L up, R down,
-72…0). Bottom: momentary (green) and short-term (yellow) loudness, -70…-10 LUFS, integrated as a
dashed white line. Time axis in seconds.

## Files

- `probe.mjs` — the probe (`npm run audio:probe`): CLI, pool, verdicts, baseline
- `lib/probe-virtual.mjs` — virtual-clock scene, margin, limiter, switch, duck and sync measurements, the band level and the twin-render level difference
- `lib/probe-app.mjs` — the live-app checks (routing, away, ceremony, continuity, frame cost) and the lint units
- `lib/probe-wave2.mjs` — Wave-2 measurement rows (transport, pause, air T60 with the bank diagnostics, arrival D/R, urgent wet)
- `lib/probe-wave3.mjs` — Wave-3 rows (the gallery's features, ladder calls and wakes, cluster, outcomes, the crown, caption parity)
- `lib/probe-wave7.mjs` — Wave-7 rows (the Signals floor, the awakening, output, tone and soften)
- `lib/soak.mjs` — the realtime soak (`--soak`)
- `lib/checks.mjs` — pure judges: the S2 Town band target, lane windows (the Signals bed's ceiling exemption), limiter GR, the preset switch (fade out, entry), ducked time, onsets and AV sync (accents on the band's grid), baseline comparison, Wave 2's transport, resume burst, air T60, bank and frame-cost judges, Wave 3's ladder, cluster, discrimination and caption judges, 5.6's quiet mix, and Wave 6's music judges (stem balance, band steps, the Isle arm, the envelope rebuild, rank correlation, rotation, breaths, loops) (unit-tested in `scripts/tests/audio-probe-*.test.mjs`)
- `lib/probe-wave6.mjs` — Wave-6 measurements: seat stems and bands, the Isle/Chip arm (music + air), nodes per note, the stop lint, visits, breaths and renditions from the sequencer's marks, the workshop kit per bar against the density the band read
- `lib/music-sim.mjs` — the shipped Sequencer headless in Node (a fake node-less graph, a stepped Transport): hours of score in seconds
- `score-analyzer.mjs` — the score analyzer (MUS-18): parallels, cue clash, ranges, renditions, re-hearing and motif statements on rendered notes, and `node scripts/audio/score-analyzer.mjs` — the songbook's composition gate (exits 1 on a failure; `scripts/tests/audio-score-analyzer.test.mjs`)
- `lib/scenes.mjs` — the probe's named scenes and cue placements
- `lib/virtual.mjs` — Node side of the virtual clock (one page per scene, stems out)
- `lib/format.mjs` — number formatting for reports
- `metrics/`, `fixtures/` — the ported metric libraries and scenario fixtures (table above)
- `baselines/scenes.json` — the reviewed scene and margin baseline (`--update`); `baselines/soak.json`, the soak baseline, exists once a soak is recorded with `--soak --update` (until then the soak reports that it has nothing to agree with)
- `audio-capture.mjs` — harness CLI, pool, capture orchestration, INDEX writer
- `lib/targets.mjs` — the catalog (edit here to add a target; every cue kind has one)
- `lib/capture.mjs` — page setup, PCM transfer, underrun-splice mapping, renders root
- `lib/timeline.mjs` — wall-clock alignment and the silence-aware cue margin (pure Node)
- `lib/analyze.mjs` — WAV I/O and every metric (pure Node)
- `lib/plot.mjs` — PNG drawing on a Chromium canvas
- `lib/server.mjs` — read-only static server (127.0.0.1, ephemeral port)
- `page/init.js` — seed, focus guard, destination tap, envelope lint (`__harNoLint` skips its stack capture), voice log
- `page/runtime.js` — in-page scenario runner (realtime, offline cues, snippets)
- `page/scene.js` — the scenario vocabulary both runners share (worlds, atmosphere, stored settings, actions)
- `page/virtual-clock.js`, `page/virtual.html`, `page/virtual.js` — the virtual clock (timer attribution, source accounting) and its renderer (scenes, engine and Island Air units)
- `page/music.js` — Wave 6's music probe: sequencer marks and pins, seat stem taps, node constructions per note, automation recording for the stop lint, MusicClock frames
- `page/probe-app.js` — in-app driver for the probe (sim fixture, away/return, cue-bus watch, blur/focus, frame profile)
- `snippets/` — example snippets (`example-glass-bell.js` standalone)
