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
nothing unless `--out` or `--update` is given. **Status:** the Wave 3 gate; the default run takes
about 6–7 minutes (the virtual-clock checks ≈ 1.5 min with `--jobs 2`, the rest is the live app, the
frame-cost run and the lint).

```sh
npm run audio:probe                                   # every check (virtual clock + the live-app checks)
node scripts/audio/probe.mjs --only scenes            # a subset (names below), e.g. to calibrate PROGRAM_TRIM_DB
node scripts/audio/probe.mjs --only scenes,margins --no-worklets   # the native limiter/meter fallbacks
node scripts/audio/probe.mjs --update                 # re-measure and rewrite baselines/scenes.json (review the diff)
node scripts/audio/probe.mjs --only sequencer --update --ref-rev f4a71e3   # re-render the sequencer's Wave-1 reference
node scripts/audio/probe.mjs --jobs 3 --seed 7        # parallel virtual renders, another seed
node scripts/audio/probe.mjs --out /tmp/probe         # also keep probe-report.json and every scene's WAV
node scripts/audio/probe.mjs --soak                   # the 20-minute realtime soak instead (below)
```

Each line prints `PASS`/`FAIL`/`INFO`/`DEFER`, the check, and its numbers.

### Plan stage and deferred checks

`PLAN_STAGE` in `lib/checks.mjs` is the wave the probe gates (now **3**); bump it at each wave's exit.
A criterion whose owner lands in a later wave is listed in `GATED_FROM` with that wave: it is measured
and printed as `DEFER` with the same numbers and the wave that gates it, counted in the summary line,
and never fails the run. Once `PLAN_STAGE` reaches its wave it gates like everything else. Every
criterion not listed below is gated now. Targets come from `Loudness.js` and the plan's acceptance
lines only; the committed baselines detect drift and can never turn a failed target into a pass.

| deferred criterion | gated from | why |
|---|---|---|
| **village busy** at A + 4 ± 2, LRA ≤ 8 (`scenes`) | Wave 4, re-checked at Wave 6 | the bed is wind + birds until the sea (4.1); Village music becomes the occasion clock (6.6); `PROGRAM_TRIM_DB` is re-measured at both |
| **storm** at S2's ≤ A + 6 with ST max ≤ −27 (`scenes`) | Wave 4 | thunder with distance and the sea (4.1, 4.2) reshape the storm; until then its numbers print as DEFER |
| **error over the storm** (`margins`: floor +6, band rule, GR ≤ 3 dB) | Wave 4 | S2 buys the error its headroom from the smaller storm of 4.1/4.2; Wave 3 measured +5.7 LU with the urgent trim at its limiter cap (+2.1 dB), GR 2.5 dB. Error over rain, and every other storm lane, gate now |

Since Wave 3 every lane gates at its full S2 window (Wave 1's interim floors for needs-you and error
are retired), and the error and limit band rule and ceilings gate with the Wave-3 signal voices;
urgent GR ≤ 3 dB, rain ≤ A + 5 and every other scene target gate too.

### The virtual clock (HAR-1)

The level, margin, switch, duck and sync checks render the **shipped** controller and directors on an
`OfflineAudioContext` (`page/virtual.html`, `page/virtual.js`, `lib/virtual.mjs`). `page/virtual-clock.js`,
injected before any app module, replaces `setTimeout`/`setInterval`/`requestIdleCallback` (and their
clears), `Date.now` and `performance.now` with one virtual millisecond clock; `Math.random` is seeded
by `page/init.js`. `window.AudioContext` becomes a factory that hands the engine one prepared offline
context (its `state`/`resume`/`suspend`/`close` shimmed, since an offline context cannot resume before
it renders), so the real `AmbientAudioController` enables as a click would: `ensureContext` loads the
limiter worklet and builds the graph. The render then suspends every 512 frames (10.7 ms); each step
moves the clock to that audio time, fires every timer due by then (each as its own task, so promise
chains settle between them) and waits for tracked async work — `audioWorklet.addModule`, a second
offline render (a bake), `decodeAudioData` — before resuming. Timers therefore run up to one step late
and read the audio clock when they run, as in a realtime page. Two renders with one seed are
sample-identical (the `determinism` check: Δ LUFS-I 0.000 LU, max sample Δ ≈ 1e-6), and a minute of
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
(layer levels pinned for the scene; `{ music: 0 }` is "no music": the sequencer starts no song), and
`storage` (Wave-3 settings). A scripted `cue` goes to the director that owns the signal route: the
active one while it plays, else the ambient director.

**Seeded streams and accounting (Wave 2).** Every virtual page calls `Rng.js` `setRngSeed(seed)`
before the app starts, so each world, work, music and cue stream is deterministic per probe seed; a
scene's `rng: { constant }` instead pins every draw (`setRngOverride`, and `Math.random` for older
trees) — how the sequencer check makes two implementations with different stream layouts make the
same choices. `page/virtual-clock.js` also keys every timer by its call site (the first app frame of
the `setTimeout`/`setInterval`/`requestIdleCallback` call), times each callback's synchronous part on
the real clock, and logs every source `start()` on the scene context with the timer site that was
running (its callback and the promise chains it started), the context state, and for buffer sources
the buffer identity, offset and rate. Sources on other contexts (bakes) are not counted. With
`trace: 'music'` it also records node→node connections, so the page can list the onsets of every
source that reaches the music bus.

Scenes (`lib/scenes.mjs`) start from stored settings the controller loads as a calibrated profile
(standard volume step, trims at 10 unless the scene says otherwise, `claudeville.sound.calibration = 2`);
`warmup` seconds settle the enable fade and the level slews and are discarded. The harness page has no
AttentionService, VillageDirector or AgentEventStream, so scenes emit their events (`attention:raised`,
`attention:acknowledged`, `distress:watchtower`, `village:scene`, `chronicle:aurora`, `team:gather`,
`weather:storm-flash`, `outcome:verified`, `tool:result`, `agent:added`/`agent:updated`/`agent:removed`,
`mode:changed`) after setting the agent's status, which is what bucket routing and the ladder read. Cue placements respect CueKit's per-kind
cooldowns and the governor's spacing and rate (the routine lane is 4/min since outcomes reserve
2 of its 6), so every placement is admitted.

| check | what it asserts |
|---|---|
| `scenes` | S2 targets from `Loudness.js` at the standard step (village busy and storm deferred to Wave 4, above), relative ones against the anchor measured in the same run: **anchor** (calm clear July day, 4 working, work and music trims off) −38 ± 1 LUFS-I; **village busy** (6 working, 3 minutes of arrivals, a needs-you, an error, a recovery, a rate limit) A + 4 ± 2 and LRA ≤ 8; **Town band** −31 ± 1 with the band stem's ST max ≤ −28; **rain** ≤ A + 5; **storm** (three flashes) ≤ A + 6 and ST max ≤ −27; **resting** ST mean A − 10 ± 3, never below −55 LUFS-S. INFO rows: TP, LRA, limiter GR (storm), HAR-5 stem levels and shares, and the village level map (2–5 kHz share, S/M, correlation, mono fold, laptop loss) |
| `margins` | HAR-3: every lane (needs-you, error, limit, routine arrival, scenery aurora, outcome Minor turn done, Medium push, Major release) over four beds (Village with its music held at 0 — S2's "Village bed (no music)" —, Town band, rain, storm), 3 placements each (the aurora and the release once: a 120 s cooldown, one Major active). Margin = max momentary in [t, t + 2.5 s] over the energy mean of the 3 s before, t = the cue's first published note. The median must sit in the lane's full S2 window, urgent lanes (needs-you, error, limit) must also pass the band rule (over music: 0.5–4 kHz energy of [t, t + 1.2 s) ≥ 6 dB over [t − 3, t); elsewhere: ≥ 2 third-octave bands rising ≥ 6 dB) and limiter GR ≤ 3 dB within 2.5 s of the onset, and the Minor outcome's median sits ≥ 3 LU under routine's on the same bed |
| `limiter` | 1.1: at full slider, a +12 dBFS burst at the limiter input (1 kHz sine, then noise) leaves the worklet at `Loudness.js` `LIMITER_CEILING_DBFS` (+0.1 dB) and ≤ −1 dBTP, and the native fallback (`__claudevilleAudioNoWorklets`: `DynamicsCompressor` + tanh, an emergency path) at ≤ −0.9 dBFS sample peak; a −20 dBFS sine passes both at 0 ± 0.2 dB |
| `switch` | must-never 12: AMBIENT → BGM and back; the momentary loudness of the 4 s after each switch never falls more than 3 dB under the quieter steady side's p10 (before: [t − 8, t); after: [t + 6, t + 14]) nor rises 3 dB over the louder side's p90 |
| `ducks` | 1.3: every `engine.duck` window (recorded with its cancellation), attack and release included, unioned per bus: ≤ 5 % of the village busy and Town band scenes on every bus, with at least one window |
| `avsync` | HAR-12: every published note of every sounding cue score vs the first onset heard on the cue stem near it (a 1 ms frame ≥ 6 dB over the 10 ms before it; a pair's second note struck over the first's ring reads ≈ 8–17 ms late), and four arrivals whose accent is declared 450–800 ms ahead, as the renderer does, vs their heard carrying note: median \|error\| ≤ 20 ms, p95 ≤ 40 ms (no music plays: C-CUE-5's shipped offsets). The release crown (3.4): the peal's published carrying note (`CUE_ACCENT_NOTE.release`) within ±15 ms of the accent the renderer declared 900 ms ahead (the `outcomes` fixture) |
| `determinism` | the anchor and the village busy scene rendered twice agree within 0.2 LU |
| `baseline` | every scene LUFS-I and ST max and every lane's median margin within ±1.5 of the committed `baselines/scenes.json`; `--update` rewrites the numbers it measured (merged with the rest) and prints the deltas. Drift only: every target above is judged on its own, so a baseline never passes a failed target. Re-baseline, reviewed, when `PROGRAM_TRIM_DB` is re-measured (end of Waves 1, 4 and 6) or a reviewed change moves a scene |
| `transport` | 2.1 (S4, ENG-8), a 10-minute village on the virtual clock (three busy stretches, rain at 5:00, the Town band 7:00–9:00; the lint's stack capture off so timer costs are the app's): `engine.transport.diagnostics()` shows 0 underruns and every process's furthest committed window ≤ 1.5 s ahead (work processes ≤ 0.35 s); among the app's timer call sites exactly one started continuous or stochastic sources (layers, the sequencer, bank playback), and it is `Transport.js`'s — discrete cue voices (sources reaching the cue bus, traced through the node graph), control-rate decisions placed on the audio clock with a lead, are listed apart and exempt; its tick costs ≤ 0.5 ms p95 and ≤ 2 ms max of real main-thread time (the page clock resolves 0.1 ms). INFO: starts from the harness's own actions and the 2 Hz atmosphere pump (event-driven), lateness on the virtual clock (bounded by its 10.7 ms steps), other timers over 2 ms |
| `pause` | 2.1 pause in place, village and Town band: 120 s hidden 30 s in (frozen audio clock, above) → the context is suspended, 0 sources start while suspended, none is placed in the past after resume (catch-up smear), the first second after resume holds ≤ the steady onset rate of the 30 s before + 1 (onsets = distinct start times), and the Town band plays the same piece after as before |
| `air` | 2.4 (S5): the two baked IRs' T60 (Schroeder T20, octave bands) — day 1.1 ± 0.15 s and night 1.55 ± 0.2 s at 1 kHz, 4 kHz ≤ 0.8 × 1 kHz; through the real cue path over a dry bed (bed air sends cut), an arrival placed at d = 0 has direct-to-reverberant ≥ +8 dB and one at d = 1 ≤ +1 dB (cue sum vs the air's wet return over 4.4 s), and every needs-you's wet ≤ −14 dB re its dry (2.5 s); the village busy scene with the air vs every send cut: ≤ +1 LU. INFO: the same D/R with raw `place()` sends on the world bus |
| `noise` | 2.5 (AMB-3): each continuous texture alone (wind, rain, the hum; 60 s) has its autocorrelation peak over 0.5–20 s lags < 0.05; the world bed's ICC (anchor, rain) is 0.15–0.5; program mono fold loss (anchor, rain, village busy) ≤ 2 LU; no two lanes reading one pool buffer (≥ 10 s long) come within 5 s of buffer time while both play (read heads advanced at each lane's start rate, across the anchor, rain, storm and texture scenes); the pool's resident bytes ≤ `MEMORY_BUDGET.noise` |
| `bank` | 2.6 (S8): `engine.bank.stats()` after the air bake and after the village busy scene — every client within its `MEMORY_BUDGET` row, the total within `totalBytes` — and every SampleBank idle slice ≤ 5 ms of real main-thread time (the idle callback's synchronous part — plan, offline graph, render start — timed by the virtual clock; the bank's own `sliceMsMax` reads the frozen virtual clock there and is only meaningful live) |
| `sequencer` | 2.3: every shipped piece (five Town band pieces, one loop each; four Village tunes, one song each at a held level) rendered with every random draw pinned to 0.5 and the music bus traced, against `baselines/sequencer-wave1.json` — the same renders of the Wave-1 tree (`f4a71e3`, exported read-only with `git archive`): identical onsets (every distinct source start reaching the music bus, relative to the piece's first, 0.1 ms grid) and program LUFS-I within 0.5 LU. Hats are noise from a pinned stream in both trees, hence silent: their onsets compare, the level compares the pitched voices |
| `discrim` | 3.1–3.5, S1 (CUE-9): 27 voices — every signal family, the L4 reminder, `answered`, every outcome, four routine alloys, departure, recovery, council, the hour phrase and the counted noon, aurora, the link cues, the digest and thunder — each played governor-free over a silent island (every layer at 0) on the cue stem. Contour and rhythm come from the published score (onsets and each note's resolved `hz`; unpitched notes take the last pitch, a tree without `hz` falls back to the pitch measured at the onset), timbre from the render (`metrics/discrim.mjs`). Gates: every signal voice vs every other voice ≥ 2 of contour, rhythm, timbre (a reminder is not judged against its own family's entry; `answered` plays only in Signals and is judged against signal voices); needs-you, error, limit pairwise ≥ 2/3; every outcome vs needs-you ≥ 2/3 with its 3/3 count reported (3.4 asks 3/3, written for the door chime; a single strike cannot differ in contour from the ship's bell's flat opening under S1's opening-interval rule); no non-signal cue opens with a quick (< 1 s) same-pitch pair. INFO: every voice's notes, brightness, strike, ring and output M-max; openings that quote a call |
| `ladder` | 3.3 (D6, S7): sound off (`runSilent`, no `AudioContext`), one wait per family opened 5 s in and never answered, 61 min: the calls (entry + reminders, from `audio:cue-played`) match the schedule — needs-you L1 → L2 at 2 min → L3 at 6 → L4 at 15 and 30 → L2 at 60; errors the same capped at L3; quota L1 and one L2 — within one late tick, none unexpected; reminders ≥ 120 s apart and ≤ 12 in any hour; each captioned by a real Toast at the default setting. Acknowledged at 3.4 min: no call for 10 min. Sound on (Village, no music): L1, L2, L3 keep the entry trim, L2 ≥ 4 LU under L1, L3 GR ≤ 3 dB. Hidden tab with sound on (frozen clock) from 25 s: the reminders due at 2, 6 and 15 min each render on the cue stem within 60 s of their time |
| `cluster` | SIG-10: six needs-you raised on one tick vs one: program M-max over the 4 s after within +1 LU of the single call, all six agents captioned, urgent GR ≤ 3 dB; INFO: sounding scores (the lead and its flock strikes) |
| `heldnote` | 3.3 (SIG-3): a wait opened by status alone (no entry call) in Village with no music at W = 1 and W = 15 working, answered 45 s later: the program's 270–310 Hz band rises ≥ 6 dB within 6 s and is back within 3 dB within 5 s of the answer (1 s windows, 0.1 s hop); the held stem's 270–310 Hz envelope swings ≤ 3 dB (beating); its short-term level is bed − 8 ± 1 LU (world + work + music stems, same staging). Absent (held stem ST max ≤ −80 LUFS at the output): under Village music (while `nowPlaying`), in the Town band, and with the window blurred on *Signals only* (the signal route alone) |
| `outcomes` | 3.4 through the producers: `outcome:verified {push}` → one push cue with published notes; ten exit-0 `tool:result`s → silence; ten failures from one agent in 60 s → 1–2 cues; a ≥ 20 s turn ending, a sub-agent dispatched and returning (`parentSessionId`, `agent:removed`) and a verified release each → one sounding cue; a Dashboard fixture (`mode:changed` → dashboard, `agent:*` transitions only) still yields turn done and the return |
| `captions` | 3.8 (HAR-13): 21 kinds through the director's cue path, 12 s apart, in Village and the Town band, sound on (rendered) and off (`runSilent`), four Toasts (auto, signals, events, all): a caption shows exactly when S6/3.8 says — signals always; outcome and routine with *events* or *all*, and by default only while sound is on; scenery only with *all* and sound on; the digest never (sound-only) — never without a played cue, and with sound on every captioned cue had a sounding score. Sound off at the default setting shows no outcome or scenery caption |
| `honesty` | must-never 3: a 6-min wait in Village with no music keeps the held note's band ≥ 6 dB over the level before the wait in every 10 s window until the answer. Must-never 13: no two urgent scores for different agents share two note times within 5 ms (the six-raise cluster render), and stale agents (`signalStale`, `freshness.state: 'stale'`, `resident`) raising a needs-you and an error produce no sounding signal score and no held note |
| `lint` | HAR-4 envelope lint (below) finds no hazard, and each unit started at least one source: every cue kind (`cue-gallery` and the `*-night` cues, offline), `layer-crickets-night`, and `bgm-night-to-ambient` (a BGM night piece, then a switch to the ambient preset); INFO: the app session's hazards |
| `routing` | must-never 2: an errored agent's `audio:cue-played` kinds are all `distress`, a rate-limited agent's all `limit`, never `summons` — with `attention:raised` first, with `distress:watchtower` first, and through the live producers (a sim status step) |
| `away` | must-never 4: after a real TopBar click (`--autoplay-policy=user-gesture-required`), a needs-you raised 5 s into an absence sounds. Hidden tab and blur with `claudeville.sound.background = signals` close the bed, so the call must stand the `Loudness.js` needs-you minimum (+10 LU) over the preceding `bedWindowSec` (3 s) of what the listener heard — a suspended context counts as silence, scored at −80 LUFS. A plain blur keeps the full mix (decision D3), so there the call must reach the cue bus (≥ −60 dBFS) with the context running; its margin over the bed is must-never 1, gated on the virtual clock by `margins` |
| `resume` | must-never 5 (runs with `away`): after each blur→focus and hide→show, `contextState` is `running` within 1 s |
| `ceremony` | must-never 6: the `team-gather` sim fixture, started over an empty island with sound on, yields exactly one `council` cue-played within 15 s |
| `continuity` | 2.1, realtime app: in the Town band, blur 3 s → focus keeps the same piece (`nowPlaying`), and the momentary level 0.3 s after focus is within 6 dB of the 3 s before the blur |
| `fps` | 2.4, realtime app (`perf-12-agents`): `world:benchmark-fps`'s frame total (`__claudeVillePerf` frame profile, update + render) in alternating 15 s segments, sound off / on / off / on; p95 with sound on − off ≤ 0.1 ms. When the two sound-off segments already differ by the limit (the page clock resolves 0.1 ms; a busy host) the delta prints as INFO, not a verdict — re-run on a quiet host |

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
| `realtime` | layers, ambient music, BGM, director mixes | The directors, layers and composers are driven by `setInterval`/`setTimeout` and read `ctx.currentTime` at call time, so only real time reproduces them. Headless Chromium runs with `--autoplay-policy=no-user-gesture-required`; the page is `page/harness.html`, which imports the shipped modules and constructs the real `AmbientAudioController` with a synthetic world. The CLI clicks the page first (a real user activation), then the page calls `activateFromUser(true)`, the enable path a TopBar click takes. |
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
  the events land inside it. The virtual page keeps the Wave-1 hooks (`_playlist`, `_lastSongName`)
  only for rendering the sequencer check's reference from the Wave-1 tree.
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
- `lib/checks.mjs` — pure judges: S2 scene targets, lane windows, limiter GR, switch hole/bump, ducked time, onsets and AV sync, baseline comparison, and Wave 2's transport, resume burst, noise lanes, air T60, bank, sequencer and frame-cost judges (unit-tested in `scripts/tests/audio-probe-checks.test.mjs`)
- `lib/scenes.mjs` — the probe's named scenes and cue placements
- `lib/virtual.mjs` — Node side of the virtual clock (one page per scene, stems out)
- `lib/format.mjs` — number formatting for reports
- `metrics/`, `fixtures/` — the ported metric libraries and scenario fixtures (table above)
- `baselines/scenes.json`, `baselines/soak.json` — the reviewed baselines (`--update`, `--soak --update`); `baselines/sequencer-wave1.json` — the sequencer check's Wave-1 reference (`--only sequencer --update --ref-rev f4a71e3`)
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
- `page/probe-app.js` — in-app driver for the probe (sim fixture, away/return, cue-bus watch, blur/focus, frame profile)
- `snippets/` — example snippets (`example-glass-bell.js` standalone, `example-crickets-softer.js` A/B)
