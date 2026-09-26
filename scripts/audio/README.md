# ClaudeVille listening harness and audio probe

Renders the shipped ClaudeVille soundscape to WAV and turns each render into numbers (JSON) and a
picture (PNG) that someone who cannot listen can still read: a log-frequency spectrogram, L/R peak
envelopes, momentary and short-term loudness, onset ticks, and labelled event/section markers.
Nothing in the repository is edited or written: the shipped modules are served read-only from
`claudeville/` and driven through their public surfaces, and renders go to
`$CLAUDEVILLE_TEST_TMPDIR/claudeville-audio-renders/` (the OS temp dir when the variable is unset).

All commands run from the repo root. They need only Node, `playwright` and its Chromium (the repo's
dev dependencies). No ffmpeg, sox, scipy, or extra install. Dev-only: nothing here ships.

## The Wave-0 probe (`npm run audio:probe`)

A **local maintainer gate**, not part of `validate:quick` or CI (CI installs with `--ignore-scripts`
and has no browser). Run it at the end of every audio wave; it exits non-zero on any FAIL and writes
nothing unless `--out` is given.

```sh
npm run audio:probe                                  # every check, one page at a time (≈ 4–5 min)
node scripts/audio/probe.mjs --only routing,ceremony # a subset: lint, routing, away, ceremony, report
node scripts/audio/probe.mjs --jobs 2 --seed 7       # parallel pages (more audio-thread skips), another seed
node scripts/audio/probe.mjs --out /tmp/probe        # also keep probe-report.json and the app-session WAVs
```

Each line prints `PASS`/`FAIL`/`INFO`, the check, and its numbers:

| check | what it asserts |
|---|---|
| `lint` | HAR-4 envelope lint (below) finds no hazard, and each unit started at least one source: every cue kind (`cue-gallery` and the `*-night` cues, offline), `layer-crickets-night`, and `bgm-night-to-ambient` (a BGM night piece, then a switch to the ambient preset) |
| `routing` | must-never 2: an errored agent's `audio:cue-played` kinds are all `distress`, a rate-limited agent's all `limit`, never `summons` — with `attention:raised` first, with `distress:watchtower` first, and through the live producers (a sim status step) |
| `away` | must-never 4: after a real TopBar click (`--autoplay-policy=user-gesture-required`), a needs-you raised 5 s into an absence sounds. Hidden tab and blur with `claudeville.sound.background = signals` close the bed, so the call must stand the `Loudness.js` needs-you minimum (+10 LU) over the preceding `bedWindowSec` (3 s) of what the listener heard — a suspended context counts as silence, scored at −80 LUFS. A plain blur keeps the full mix (decision D3), so there the call must reach the cue bus (≥ −60 dBFS) with the context running; its margin over the bed is printed and is must-never 1, gated from Wave 1 (1.3) |
| `resume` | must-never 5: after each blur→focus and hide→show, `contextState` is `running` within 1 s |
| `ceremony` | must-never 6: the `team-gather` sim fixture, started over an empty island with sound on, yields exactly one `council` cue-played within 15 s |
| `report` | not gated: program LUFS-I, true peak and ST max of 30 s of a busy clear day (`mixed-tools`, 10:24), the tap's audio-thread skips (`capture.gaps`) in that window and the session, envelope hazards and page errors seen in the app |

The app checks run the full app on `startIsolatedServer()` (ephemeral port) at `/?sim=1`, renderer on,
with `Math.random` seeded before any app module loads (`page/init.js`) and `page/probe-app.js` driving
the sim fixture, real `blur`/`focus` window events and a `document.hidden` override with a real
`visibilitychange`. Captions are recorded from `audio:cue-played` on the event bus, so routing and
ceremony results hold with any output device. Loudness is measured on the wall clock: every tap chunk
carries its arrival time, and `lib/timeline.mjs` lays the capture on it (see "The tap").

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
`--volume v` (snippet master volume, default 0.5 = shipped default).

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
| `engine` | a real `AudioEngine` built on `context`: `engine.cueBus` / `engine.ambienceBus` → duck → fade (pinned open) → master (volume² × 0.9) → 6.2 kHz low-pass → limiter → destination. Connect here to hear your recipe exactly as a shipped cue/layer would sound |
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
| `offline` | every `cues*` target | CueKit schedules every note on `ctx.currentTime`, so an `OfflineAudioContext` gives a sample-accurate, jitter-free render. A real `AudioEngine` is built on the offline context (full master chain), then each cue goes through `CueKit._playAccepted` with the lane from `laneForCueKind` — the exact path the governor calls once a cue is admitted (score anchoring, lane mix, `_voice`). Cues are armed at their time with `suspend()/resume()`. The governor itself (cooldowns, budget, aggregation) is bypassed: the render is "what this cue sounds like once admitted". |
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

- **Seeded randomness.** `Math.random` is replaced by mulberry32 (seed `0x5eed`) in harness pages, so
  noise buffers, bird phrases, tune/form picks and humanisation are reproducible. Realtime timer
  interleaving still jitters by milliseconds, so two realtime runs are close, not identical — see
  `fidelity/repeat-mix-day-clear-busy` vs `mix/mix-day-clear-busy`. The app-live render is *not* seeded.
- **Selection pins (not synthesis edits).** Ambient tunes are pinned by setting the MusicLayer's
  `_lastSongName` to the sibling tune (each family has two songs); the first song is held for 9 s so the
  layer's 3 s level slew has settled. BGM pieces are pinned by overriding the player instance's
  `_playlist()`; BGM renders are loop 2 of the piece (loop 1 contains the start-up level slew), except
  `bgm-willowbrook-summons-arrival`, which is loop 1 so the events land inside it.
- **Layer isolation** uses the director's own QA hook `forceLayer(name, 0, ∞)` on every other layer;
  their outputs sit at `MIN_GAIN × trim` (≤ -80 dB re full level), visible as a faint floor below -100 dB.
- **Frame pressure.** The harness page has no renderer, so `__claudeVillePerf.frameHealth` is absent
  and the director's frame-pressure level reads 0. The level is diagnostic only (it no longer changes
  any layer level); the app-live render records it in `capture.finalState`.
- **Warmup.** Layer and mix renders start after `warmup` seconds so the director's 3–6 s level slews
  have settled; bed renders start at audio start (swells begin 3–9 s in). Warmup audio is discarded.
- **Offline cues bypass the governor** (see above) and always play; `markerMetrics` margins are only
  meaningful for realtime renders, where the cue sits over a bed.
- **Levels are absolute at the engine output** at the shipped default volume 0.5 (master gain 0.225)
  unless the target name contains `vol100` (volume 1.0, master 0.9). OS/device gain is not modelled.
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

- `probe.mjs` — the Wave-0 probe (`npm run audio:probe`)
- `audio-capture.mjs` — harness CLI, pool, capture orchestration, INDEX writer
- `lib/targets.mjs` — the catalog (edit here to add a target; every cue kind, layer, tune and piece has one)
- `lib/capture.mjs` — page setup, PCM transfer, underrun-splice mapping, renders root
- `lib/timeline.mjs` — wall-clock alignment and the silence-aware cue margin (pure Node)
- `lib/analyze.mjs` — WAV I/O and every metric (pure Node)
- `lib/plot.mjs` — PNG drawing on a Chromium canvas
- `lib/server.mjs` — read-only static server (127.0.0.1, ephemeral port)
- `page/init.js` — seed, focus guard, destination tap, envelope lint, voice log
- `page/runtime.js` — in-page scenario runner (realtime, offline cues, snippets)
- `page/probe-app.js` — in-app driver for the probe (sim fixture, away/return, cue-bus watch)
- `snippets/` — example snippets (`example-glass-bell.js` standalone, `example-crickets-softer.js` A/B)
