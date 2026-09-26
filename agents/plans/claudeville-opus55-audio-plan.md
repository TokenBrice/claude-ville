# ClaudeVille audio plan — *The Singing Isle*

**Status:** `in progress — decisions recorded 2026-09-26; executing by wave`

**As of:** 2026-09-26, `main` at `18bc216` (`v0.46.0` *The Painted Isle*), clean tree.

**Author:** Opus 5.5 coordinator. Consolidates twelve parallel Claude Opus 5.5 explorations (six source-level, six listening critiques on rendered audio), two audition reels, one round of corrective evidence, and three adversarial Opus 5.5 council reviews (feasibility, taste, fidelity to the evidence). Following the precedent of the [Painted Isle plan](claudeville-opus55-aesthetic-plan.md), the supporting evidence is **local-only**: it lives in the gitignored [`../../output/claudeville-opus55-audio/`](../../output/claudeville-opus55-audio/) and is not committed. Note names, render names and tool paths below resolve only on the machine that produced them. Every idea ID (`ENG-3`, `CUE-1`, …) points at a full implementation sketch in the matching note; this plan fixes *what* ships, in *which order*, under *which contracts*, and *how it is judged*.

**Scope:** audio only — music, ambience, cues and foley, mix, sonification, audio UX. Graphics were overhauled in v0.46.0 and are out of scope, except where a sound must land on a frame that is already drawn.

## Method

- **Wave A (source).** Six explorers read the audio stack (`claudeville/src/presentation/shared/audio/`, `AmbientAudioController.js`, the TopBar and SET wiring, the event producers) and wrote one note each: engine and scheduling (`eng-engine.md`), signal→sound mapping (`sig-sonification.md`), audio UX (`ux-controls.md`), an outside ear with ~45 cited references (`sota-outside-ear.md`), composition (`mus-composition.md`), and the listening harness (`har-harness.md`).
- **The listening harness.** No agent can hear, so `HarnessBuilder` built `tools/audio-capture.mjs`. It renders the shipped modules through an `OfflineAudioContext` (cues) or records them in realtime from the real controller (directors, BGM, and the real app on an isolated server with `?sim=1`), then analyses each render into BS.1770 loudness, true peak, band energy, onsets, stereo, and a labelled log-frequency spectrogram PNG. A snippet API lets any prototype render through the identical analysis. Baseline catalog: 101 renders (`renders/INDEX.md`).
- **Wave B (ears).** Six critics judged the baseline by its spectrograms and metrics, settled the Wave-A conflicts with rendered evidence, and **prototyped the leap** as before/after renders: mix and mastering (`mix-mastering.md`), cues (`cue-design.md`), environment (`amb-environment.md`), workshop foley (`fol-workshop-voices.md`), music as heard (`musl-music-listening.md`), and two 10-minute real-app sessions plus scenario moments (`scn-soundtrack.md`). A first corrective round closed the foley note's Mine and Harbor gaps (FOL-3 v2).
- **Council.** Three `council-opus` reviewers attacked the first draft: feasibility and ordering, taste and leverage, fidelity to the evidence (≈ 90 findings, 7 blockers). This version resolves every blocker and major finding. Where the evidence could not settle a question, a second evidence round rendered it (door-chime alternatives, the remaining workshop voices, three Town band voicings, the waiting cadence, the music-duty arms) and the result is recorded in the item.
- **Audition reels.** `reel/README.md` (v1) assembled four before/after pairs from the Wave-B prototypes; the council showed it was built to superseded constants and omitted the subjects of several decisions. `reel/README-v2.md` (v2) re-levels every pair to this plan's S2 constants, uses the crickets-fixed shipped sound as the night BEFORE (so Wave 0's fix is not credited to later waves), adds the missing subjects (the wait arc, the hour chime, the first enable, the music-duty arms, three Town band voicings) and prints a PASS/FAIL gate table per file. **Decisions D1, D2, D6, D7 and D9 are made by ear on reel v2.**
- **What reel v2 changed.** Its gate table confirmed the urgent floors with the new needs-you figure (needs-you +10.9…+11.3 LU over Village beds, +8.0…+8.8 over the Town band) and forced seven contract changes, each recorded where it applies: the Village session target moved to A + 4 (the busy village runs 4.5 LU over the anchor), the storm cap dropped from A + 8 to A + 6 (the error bell needed 3.8 dB of limiter at A + 7.5), the Town band's ST max applies to the band stem, the held note rose to bed − 8 LU, the ladder holds one trim per wait, minor outcomes and scenery are never lifted by the bed-aware trim, and the program stereo rule widened to S/M −12…−2 dB with ≤ 2 LU mono loss. The clear night **fails** its rules in the reel (−29.9 LUFS; 2–5 kHz 5.6 dB over noon) and stays a gate that 4.4 and 6.3 must close.
- **Fidelity limits** (`har-harness.md`, `tools/README.md`): realtime renders are seeded but not bit-identical (±0.4 LU integrated; repeat-run cue margins differed by up to 3.3 LU); the harness page has no renderer, so frame pressure is 0; CPU figures are offline proxies taken on a host loaded by concurrent critics and are **relative**, not budgets. Merge gates on cue margins therefore use virtual-clock renders (0.8b) or the median of three placements, and every item that adds audio-thread work is re-priced on a quiet host before it lands.

## Relation to prior work

- **Keeps** the frontier plan's shared cue score (§5.3, `CueScore.js`): visual accents land on heard notes, and a muted village runs the same score on the monotonic clock. Every new cue kind publishes its onsets through it.
- **Keeps** the council plan's statement of purpose — sound exists to *reach an operator who is not looking* (`claudeville-council-enchantment-plan.md:297`) — and makes it true again (Wave 0). This plan's harmonic work (3.5, Wave 6) is that plan's item 10 stage three, and it inherits that stage's gate: stages one and two verified in a real listening session first.
- **Overturns, by maintainer decision D8, two of the council plan's kills** (`claudeville-council-enchantment-plan.md:391-398`): *camera as audio listener* and *nine-workshop "work becomes texture"*, on the Wave-B evidence (workshop accents heard 86–100 % at +0.3 LU program cost; SCN's busy/idle contrast). *Per-tool sound* stays killed: workshop accents are density-limited, never one sound per call.
- **Is the audio twin of the Painted Isle's C4 effect language** (`claudeville-opus55-aesthetic-plan.md` C4): material says the family, interval says the meaning, rhythm says the urgency, timing says the weight. Gold is for verified success only; returns are stone; failure is red.
- **Keeps** the project's audio identity from `CHANGELOG.md:1018` — "fully procedural Web Audio: no samples, no assets, no build step" — and extends it with *runtime baking* (procedural DSP rendered once into buffers after unlock). No audio file is committed.
- **Keeps** the v0.37 boot win (`CHANGELOG.md:388`): the audio modules stay off the critical path and load at idle.
- **Amends** the v0.13 "no reactive pile-up" rule (`CHANGELOG.md:1314`) only as far as D8 allows: workshops sound **density** under hard budgets (new design-decision entry with 5.1).
- **Amends, by maintainer decision D4,** `docs/design-decisions.md` "BGM mode keeps event cues but drops reactive ambience": Town band gains weather/season arrangements and workshop-driven percussion as *music* (6.9); it still gets no world, work or held-note layer.
- Nothing in `agents/plans/open-followups.md` is audio; no follow-up is reopened.

## The organizing finding

**Figure and ground are inverted.** Measured over a real 10-minute busy-village session (`scn-session-ambient-10min`):

- The *ground* — what plays continuously — is a tune, **82.7 %** of the time, alternating two songs; 17 % of 10 s tonal windows are near-exact re-hearings within the session. Under it, the environment alone is a mono 4-second noise loop (autocorrelation at 4 s: rain 1.000, wind 0.93) and a 55 Hz sine that beats to silence every 3.9 s. The island has no sea.
- The *figure* — the signals — cannot stand out. The Village needs-you calls measured **−0.8…+0.8 LU** over what they played on (Town band −1.4…+1.9); errors and rate limits played the needs-you voice; a 4-minute wait was audible for ~0.4 s. The only cue that read at all was one that landed into silence (+20.4 LU).
- The whole plays **15–20 dB too quietly** (day −48.3 LUFS-I, BGM −46.3 at the default slider), behind a "limiter" that never engages and a 6.2 kHz low-pass that removes the air.
- On the lived path, **sound dies**: after a TopBar enable, a blur suspends the context for good, and blurred or hidden summons make no sound (`TopBar.js:599-600`, `AmbientAudioController.js:409,432-435`).

**The leap is to swap them.** The ground becomes the *place* — a breathing sea in one shared outdoor air — and, as far as D8 allows, the *work*: located workshop sounds for what agents are actually doing. Music becomes an event in Village and a town band that breathes and knows when someone is waiting. Signals become the only figure: three learnable families, a wait that stays present while it is true, and outcomes that finally say *done*, *shipped* and *failed*. All of it runs on **one air, one ceiling, one clock**.

### Headline numbers (baseline → prototype)

| Measure | Today | Prototype | Source and conditions |
|---|---|---|---|
| Needs-you over its bed, busy Village | −0.6 LU (error and limit used the same voice) | **+11.0 LU** (limiter GR 0.8 dB) | reel v2 `day-work`: ship's bell through the S3 chain, bed-aware trim |
| Needs-you over the Town band | −2.2 LU | **+8.0…+8.8 LU**, presence band +8.5…+14.2 dB, in all three voicings | reel v2 `town-band`, `wait-arc-band` |
| Six agents raised on one tick | +14.5 LU over one call | **±0 LU** (one cluster call) | `cue-proto` `new-cluster-six` |
| Village music-on in a working stretch | 82.7 % | set by **D1** (recommended 6–10 % while ≥ 3 agents work, ≤ 20 % otherwise) | SCN; MUSL round 2 |
| Busy vs idle village | Δ 0.4 LU | **Δ 3.3 LU, −66 % onsets** | SCN AFTER session (stand-in voices, SCN chain) |
| Resting floor | −62.3 LUFS-S (min −79) | **−45.6** pilot light | SCN AFTER session |
| Program loudness, default slider | day −48.3, BGM −46.3 | day −32.7 (with the glue compressor this plan rejects); BGM −30.7 (limiter-only) | `mix-proto` v2full / v2final |
| Limiter on a +12 dBFS burst | +4.99 dBFS out | **−1.00 dBFS**, 0.093 % of a core | `mix-v2-chain` |
| Weather bed repetition and width | r(4 s) 0.93–1.00, ICC 1.00 | **≤ 0.017, ICC 0.03–0.47** (worklet noise; the buffer-pool path was benchmarked, not rendered) | AMB |
| Thunder over its own storm | 0 / +0.1 / −0.1 LU | **+7.3 / +7.4 / +2.4 LU** | AMB |
| Workshop accents heard in context | 0 detected onsets | **86–100 %** at all eight buildings by day; 78–100 % at night (Portal 78 %) — with the −3 dB default trim, program +0.3 LU | FOL v3 |
| Music loss on a laptop speaker model | −3.9…−5.3 LU, mono | **−0.6…−0.8 LU** (Isle Band), **−0.9…−2.2** (Chip restored, bass −3.5 LU under the tune); S/M −9…−15 dB | MUSL round 2, level-matched |
| Summer night vs calm day, one slider | +21 LU (cricket click, 99.4 % of the night's loudness) | **≈ 0 LU** with the click fixed | HAR `ab-crickets-fix` |
| BGM loops per piece per hour | 30–41 | ≤ 12 target (6.7) | MUS |

## Guardrails (binding on every item)

- **Zero-build, no dependency.** No Tone.js or any audio library, no bundler, no transpiler. AudioWorklet modules are plain ES files under `claudeville/src/presentation/shared/audio/worklets/`, loaded same-origin with `audioWorklet.addModule` (memoised in `ensureContext`, awaited before the graph is built and before any enable or wake plays). Every worklet has a native-node fallback that the probe exercises with worklets disabled.
- **Sound stays opt-in and off by default.** Every explorer considered and rejected changing that. Captions and the shared cue score keep working with sound off, from boot (0.1), within the caption setting (3.8).
- **Audio assets.** Procedural first, runtime-baked second. A static asset (≤ 100 KB, original or CC0, provenance recorded, `server.js` MIME type added in the same change) may replace a voice only after it wins a blind A/B by the maintainer against the procedural version. Implementation ships procedural.
- **Zero per-frame main-thread cost.** No `requestAnimationFrame` in audio code and no per-frame analyser reads. Main-thread audio work runs on the 1 Hz director tick, one Transport, and the existing ~2 Hz `atmosphere:updated`. Scheduling bursts ≤ 2 ms p95. Idle work goes through the repo's idle helper pattern (`AssetManager.js:175-190`) with a timeout, never bare `requestIdleCallback`.
- **Cross-engine.** Chrome is the reference; Firefox and Safari must not break. `cancelAndHoldAtTime` is used only through the `holdAt` helper (S8).
- **Never replace a visible count with sound.** Sound is redundant with the chrome, never the only carrier.
- **Weather, sea and wildlife never follow agent state** (`claudeville-opus55-aesthetic-plan.md:446`).
- **Desktop only, English copy**, the existing ghost-button chrome grammar (`claudeville/css/topbar.css`).
- **Level-matched judgement.** Any timbre A/B is judged at equal LUFS-I (±0.2 LU) with the harness PNGs attached; a louder version never wins by being louder.
- **Harness numbers gate merges locally; the maintainer's ears sign off taste.** `npm run audio:probe` is a **local maintainer gate**, not part of `validate:quick` or CI (CI installs with `--ignore-scripts` and has no browser; browser verification stays manual per the council plan). Each wave ends with a probe run; Waves 3–6 also end with a listening session on reel pairs regenerated from the real code.
- **Clean cutover.** Each item deletes the code it replaces in the same change; the deletions are named under each item.
- **Do not re-open rejected or killed items** without new evidence.

## Cross-item contracts — specify before Wave 1 starts

### S1 — Strata and the sonic palette

| Stratum | Carries | Materials | Rules |
|---|---|---|---|
| **Signal** | needs-you, error, rate limit, ladder reminders, the held note | bronze handbell (needs-you only), cracked bell, steel escapement, watchtower horn (only under a carrier) | the only figure; captioned; fixed pitches, the same by day and night, never chord-relative, never quantized, never provider-tinted |
| **Outcome** | turn done, sub-agent return, commit, push, release, failed push or command | oak, stone, dead iron, gold glockenspiel, tower-bell peal (release only) | C4 colours; gold only from `outcome:verified`; aggregated with exact-count captions |
| **Routine** | arrival, departure, recovery, council | small chime in four alloys (clay for Claude, brass, glass, bell-metal — never bronze) | chord-relative with a clash guard when music plays; body-anchored timing kept |
| **Scenery** | hour chime, aurora, thunder, link cues, the return digest | tower bell (`home` phrase), glass, thunder | no urgency; thunder is weather and ducks nothing |
| **Work** | which buildings are working, and how hard; the crowd murmur | steel anvil, parchment and quill, pick on limestone, brass tack and chalk, brass ratchet, rune stone, canvas flag, rope and oak crate | density, never per call (D8 scope); no bell, no metal below A6, no music material; never captioned |
| **World** | place, time, weather | sea, wind, rain, birds, crickets, Island Air | never follows agents; draws from its own seeded random streams |
| **Music** | occasions (Village), the town band | Chip (restored console band) and the Isle Band (plucked strings, wood, steel comb, brushes) | bells are cue-only; the music box has no clapper strike |

- **Axis ownership.** Material = stratum. Interval = meaning: rise = arrive or heal; a single fall = leave; a falling fifth E4→A3 = error or failure; open fifths = gold. Rhythm = urgency family: the needs-you **ship's bell** (a quick same-pitch strike pair, repeated) is the only quick same-pitch pair, the error the only flam, the limit the only ritardando. Alloy = provider, on routine chimes only, at a fixed register.
- **The needs-you figure is reserved.** The ship's bell on E5 (659 Hz), same by day and night: strikes at 0 and 150 ms (the second ×0.85), the pair repeated every 650 ms, on a clapper-struck bronze handbell. No other cue, theme, stinger, workshop or ambience plays a quick same-pitch pair of struck strikes (single-pitch strikes elsewhere, such as the hour count, are spaced ≥ 1 s), and nothing else uses the bronze handbell. No world or work voice sustains a fundamental or ring mode in 500–700 Hz for longer than 150 ms. The contour rule compares **opening intervals**, not whole sequences (round 2 found the first door-chime figure shared its opening with the hour phrase by day and with *Lanternlight* bar 10 by night).
- **Discrimination rule.** Every signal-stratum sound differs from **every other audible voice** — cues, work takes and music voices — in ≥ 2 of contour, rhythm and timbre; register never counts alone. Measured on renders (`discrim.mjs`, CUE-9, calibrated once by the listener battery at the Wave-3 exit). No non-signal cue has the needs-you contour.
- **Speaker floor.** No signal carrier below G3 (196 Hz); low partials only under a carrier (C-CUE-7).
- **Tuning.** A = 440 Hz 12-TET. Signal, outcome, routine, scenery and work fundamentals come from A-major pentatonic by day and A-minor pentatonic at night; the held note's D is the one sanctioned exception (C-SIG-9). Music follows its songbook's own diatonic harmony through `MusicClock`. Inharmonic partials only in bells and metal.
- **Two sanctioned material overlaps.** The tower bell rings the hour (scenery) and, once per release, the peal (Major outcome): it is the civic bell, and the two differ in contour (the signature phrase vs a rising peal run). Oak appears as the outcome turn-done knock (E4, one strike) and inside the Harbor crate (work, 1.35–1.6 kHz accents): register and rhythm separate them, and both sit in the discrimination matrix.
- **Physics before mood.** No pad or reverb wash stands in for place; no sustained pure tone above 2 kHz for longer than 150 ms; drops on water glide up; far things are duller and wetter.

### S2 — Loudness and audibility

One file, `claudeville/src/presentation/shared/audio/Loudness.js` (new), holds the scene-keyed targets, `PROGRAM_TRIM_DB`, the lane windows and a **voice registry** (each cue, grain and musical voice declares its raw nominal loudness and peak-to-loudness ratio). The engine meters and the probe read this file (C-MIX-7).

**Targets at the default slider**, BS.1770 at the engine output, keyed to named probe scenes:

| Scene | Target |
|---|---|
| **Anchor A** — calm clear day, world stratum only | **−38 ±1 LUFS-I**; `PROGRAM_TRIM_DB` is whatever makes A true on the current bed (reel v2: +15.84 dB on the AMB bed) |
| Village, 10-minute busy session | **A + 4 ±2 (≈ −34)** LUFS-I; LRA ≤ 8 LU within a phase. Reel v2 measured A + 4.4 with six workers and a fragment, A + 3.5 with three workers and no music. |
| Village music (occasion or fragment) | ≤ bed + 3 LU short-term; fragments ≤ bed + 1 |
| Town band | −31 ±1 LUFS-I; the **band stem** ST max ≤ −28 (cues excluded: a needs-you at +8 over the band lifts the program ST max to −26.5…−27.4, and that is intended) |
| Night, clear, with its occasion | ≤ the Village session; 2–5 kHz ≥ 4 dB under noon. **Reel v2 fails both** (−29.9, and 2–5 kHz +5.6 dB *over* noon: the cricket chorus and the music box); 4.4 and 6.3 own closing it |
| Rain | ≤ A + 5 LU |
| Storm, thunder included | **≤ A + 6 LU**; ST max ≤ −27. At A + 7.5 (reel v2) the error bell needed 3.8 dB of limiter to reach +6.1 LU; the smaller storm buys the error its headroom |
| Resting (pilot light) | A − 10 ±3 (≈ −48); never below −55 LUFS-S |
| Ceiling | TP ≤ −1 dBTP at full slider; limiter gain reduction ≤ 3 dB on urgent-cue transients and ≤ 6 dB on thunder |

Every +1 LU of storm costs about 1 dB of limiter on a call over it; the GR limit is the arbiter. `PROGRAM_TRIM_DB` is re-measured and the probe re-baselined at the end of Waves 1, 4 and 6 (≈ +20.5 dB on today's bed, +15.8 dB on the reel's AMB bed).

**Audibility windows** — LU over the 3 s bed before the cue:

| Lane | Village bed (no music) | Over music | Over rain or storm | Ceiling |
|---|---|---|---|---|
| needs-you | ≥ +10 | ≥ +8 | ≥ +6 | +12 |
| error | ≥ +8 | ≥ +6 | ≥ +6 | +12 |
| limit | ≥ +6 | ≥ +4 | ≥ +4 | +10 |
| routine | +3…+6 | +3…+6 | +3…+6 | — |
| outcome Minor | 0…+3, and ≤ routine − 3 | same | same | — |
| outcome Medium | +3…+6 | same | same | — |
| outcome Major (release; one active) | +4…+8 | same | same | — |
| scenery (hour chime, aurora, link, digest) | 0…+5 (reel v2: 09:00 chime +2.8, 12:00 +4.5 — the bed, not the chime, differs) | same | same | — |
| thunder over its storm | near +5…+10, far +2…+6, measured from the thunder onset, not the flash | — | — | — |

- **Band rule for urgent cues.** Over music, CUE-9's presence-band margin (0.5–4 kHz, [t, t + 1.2 s] vs [t − 3, t)) ≥ +6 dB; over non-music beds, ≥ 2 third-octave bands rising ≥ 6 dB.
- **Where these came from.** Reel v2 (`reel/README-v2.md` gate table), ship's bell through the S3 chain with the bed-aware trim aiming at floor + 1: needs-you **+11.0** (busy Village), **+10.9** (D1 arms), **+11.3** (wait entry), **+8.0…+8.8** over the Town band in all three voicings (presence band +8.5…+14.2 dB), error **+6.1** over the storm; urgent GR ≤ 1.8 dB everywhere except the storm (3.8 dB at A + 7.5 — 4.2 must show ≤ 3 at A + 6) and the Village L3 reminder (3.6 dB with a re-taken trim — 3.3 holds the ladder's trim). Reel v1 (first figure, want +8) had reached only +7.4 / +7.1. If a floor proves unreachable within the GR limit in the real code, it is lowered here with the render cited, never silently.
- **Trim rules per class.** Urgent cues: bed-aware 0…+12 dB (never below 0; S3). Routine and Medium/Major outcomes: bed-aware −6…+12. **Minor outcomes and scenery are never lifted** (bed-aware −6…0; reel v2 lifted a short oak knock by 6.5 dB to +6.2, over its window). The ladder takes its trim once, at entry, and holds it (reel v2: a swelling bed left L2 only 2.9 LU under L1).
- **A cue that lands into resting** is exempt from its lane ceiling (the trim cannot pull it below 0 dB; S3), and is gated only by the GR limit.

**Slider semantics.** The volume is the last gain before the fade and changes level only. One step law everywhere: master 3.6 dB per step, trims 2.4 dB per step, 0 = off (UX-8). **Migration never makes a returning user louder and never mutes one** (D5).

### S3 — Bus map and master

```
world (sea, wind, rain, birds, crickets) ─► presence dip −3 dB @ 3.4 kHz ─► worldDuck ─┐
work (workshop grains, crowd murmur) ─► workDuck ───────────────────────────────────────┤
music (Village band, Town band) ─► low shelf −3 dB @ 160 Hz ─► attention ─► musicDuck ──┤
air return (Island Air, world/work/music sends, taken inside each layer's level) ───────┤
                                                                                       ▼
   bedSum ─► PROGRAM_TRIM ─► HPF 30 Hz ─► circadian tilt (world + music only) ─┐
   cueSum ─► PROGRAM_TRIM ─┬─────────────────────────────────────────────────┤
          cue air sends ─► cue-air return (same staging) ──────────────────┤
   signalBed (held note) ─► PROGRAM_TRIM ─ (−6 dB under urgent cues only) ──┤
                                                                            ▼
                         LP 14 kHz ─► lookahead limiter (worklet, −1 dBFS) ─► volume ─► fade ─► out
```

- **Gain staging is the one that was measured.** Every render behind this plan summed cues with the bed *before* the program trim. The cue sum therefore gets the same `PROGRAM_TRIM` gain and joins after the tilt, and cue air sends feed a separate cue-air return at the same stage, so a cue's wet path never gets a trim its dry path lacks (urgent wet ≤ −14 dB re dry, AMB-2).
- **No program glue compressor** (MIX: it held 2.8–3.4 dB of constant reduction in weather and cost cues 1.5–2.5 LU). Meters sit on side branches; the analyser moves off the series path.
- **The held note has its own path** (`signalBed`): no presence dip, no attention stage, no music duck; it ducks −6 dB only under urgent cues. It is excluded from music-duty metrics.
- **Ducks are scheduled on the note.** `engine.duck({ from, until, depths })` runs from the first heard note minus the attack to the last note + 0.35 s, per bus, deepest-wins, never deeper than −9 dB, and **cancels with its cue** (a pre-empted prepared cue leaves no dip). Depths (dB):

  | Cue class | world | work | music |
  |---|---|---|---|
  | routine, outcome, scenery — Village | −2 | −3 | — (music is off the bed during cues; S7) |
  | routine, outcome, scenery — Town band | — | — | −2 |
  | urgent | −7 | −6 | −9 |
  | thunder | none | none | none |

  Total ducked time ≤ 5 % of an hour per bus (C-MIX-5).
- **Bed-aware cue level.** At schedule time, one read of an always-on, true-stereo-power, K-weighted tap on the pre-duck bed sets the cue trim within −6…+12 dB so the cue lands inside its S2 window. **Urgent cues never trim below 0 dB.** When the bed is paused or unprimed (a hidden-tab wake), the urgent trim is the median of the last 60 s of foreground urgent trims, else +6 dB. The tap is part of the engine, not a debug meter.
- **Every voice connects through one helper**, `engine.connectVoice(node, { bus, group, pan, air })`. No ad-hoc `connect(engine.cueBus)`, no per-voice panner construction in layers.

### S4 — One clock

- Sound placement uses `AudioContext.currentTime` only. A timer may **wake a scheduler**, never place a sound (today eight `setTimeout` chains place sounds; `eng-engine.md` clock table). The 1 Hz director ticks remain as control-rate mapping.
- One `Transport` (new `audio/Transport.js`): `setInterval(250 ms)` with **per-process windows** — music and environment look 1.5 s ahead (≥ 13× the measured p99 timer lateness of 52–93 ms); work strikes look ≤ 350 ms ahead and stay cancellable. Late events are dropped and counted, never smeared onto *now*.
- One `MusicClock` (new `audio/MusicClock.js`) published by whichever band plays: key, chord timeline, tempo, bar grid, `nextGrid(t, maxWait)`. With no music it answers the phase tonic triad, reproducing today's cue pitches exactly.
- `CueScore` stays the **only** bridge between audio time and `performance.now()`. Renderer clocks (`RitualConductor.ritualDownbeat`) are read at scheduling time (≤ 4 Hz), never per frame.
- **Grid rules.** Urgent cues never wait. Routine cues wait ≤ 250 ms for the next eighth. Scenery (hour chime, release stinger) may wait up to one bar. Body-anchored cues (arrival, departure) keep the body's time unless a grid point lies within ±60 ms.

### S5 — One air, one `place()`

- **Island Air** (new `audio/IslandAir.js`, AMB-2): two stereo IRs baked after unlock — early reflections off plaza stone, a decorrelated velvet tail through a low-pass falling ~10 kHz → 1 kHz, a 140 Hz high-pass. **T60 at 1 kHz: 1.1 ± 0.15 s by day, 1.55 ± 0.2 s by night; T60 at 4 kHz ≤ 0.8 × T60 at 1 kHz.** Two convolvers with an equal-power crossfade (τ 6 s) at phase change, the idle convolver's input disconnected; rain and fog colour only the return. `ConvolverNode.buffer` is never replaced live.
- **Sends are taken inside each layer's level** (C-AMB-2): dry and wet move together.
- **One placement function** (new `audio/SpatialField.js`, SIG-5 formulas), for every located discrete sound: `dx, dy` from the viewport-normalized screen position, `d = hypot(dx, 1.3·dy)`; pan `clamp(0.85·dx, −0.75, 0.75)`; gain 1 for `d ≤ 0.6`, else `(0.6/d)^1.2` with a floor of 0.12; low-pass `9000·2^(−1.6·max(0, d − 0.5))` with a floor of 900 Hz; air send `0.12 + 0.30·clamp01((d − 0.5)/2)`. **Signal cues:** no distance gain, no distance low-pass, |pan| ≤ 0.3, air ≤ 0.12. **Dashboard:** one fixed island map of building pans (SIG-5 step 6) scaled by 0.75/0.83 so no pan exceeds 0.75.
- **Discrete sounds are placed once, at schedule time.** Continuous emitters (workshops, harbor, coast) may follow the camera (D8): their pan, low-pass and send are refreshed on `atmosphere:updated` (~2 Hz) with `setTargetAtTime(τ 0.25 s)`, never per frame (5.8).

### S6 — Honesty

- **Weather and sea never follow agents.** Each world layer draws from its own seeded random stream (SOTA-16 step 1, built in 2.1); a fixture with 0 vs 12 working agents at one seed yields a bit-identical world stem (the murmur is work, not world).
- **No sound from stale data or a lost link.** One gate, `audibleAgents(world, now)` (new `audio/AudibleWorld.js`, non-stale per `ObservationCertainty`), feeds every continuous mapping. On link loss the work stratum and the held note fade and one `linkLost` cue plays.
- **Gold only from `outcome:verified`.** Never inferred.
- **One sound per fact; a ceremony supersedes its parts.** An error is the cracked bell, not also a summons; a team gathering is the council figure, not "5 arrivals"; a release absorbs its push (C-SIG-2, C-SCN-7).
- **Captions.** Every discrete cue emits `audio:cue-played {kind, agentId, label, at}` with sound off, from boot, filtered by the caption setting (3.8): with sound off the default is *signals only*; with sound on it is *signals and events*. `kind` names the fact by bucket, not the event that happened to arrive first. Continuous textures (sea, workshops, murmur, the held note) never caption. The return digest is sound-only; the existing `attention:digest` toast stays its one caption.
- **State is audible for as long as it is true.** In Village, while any actionable agent exists, the held note sounds whenever no music plays; under music the band ends its phrases on an open cadence instead (MUS-9). In Town band the open cadence carries it. In Signals the ladder carries it. Its end is audible in every preset (the resolution, the landed cadence, or the Signals `answered` strike).

### S7 — Time budgets and fatigue

| Budget | Value |
|---|---|
| Village melodic duty | **D1**; in every arm 0 % while resting, in rain or storm, within 5 s of an urgent cue, or starting over a wait ≥ 6 min |
| Town band | a *loop* is an identical 16-bar rendition (after 6.5's variation); ≤ 12 per piece per hour; a true 1.4 s breath between pieces; ≥ 1 breath or interlude per 10 min; music duty ≥ 85 % of the hour |
| Motif statements | ≤ 6 per hour across cues, fragments and chimes |
| Welcome fragment | at most once per calendar day |
| Signal reminders | ≤ 1 per 120 s, ≤ 12 per hour, village-aggregated; after two L4 calls, one L2 every 30 min until acknowledged |
| Captioned cues | ≤ 60 per hour at ≥ +3 LU over the bed |
| L1 when the operator is looking | window focused and input ≤ 10 s ago → L1 plays the L2 voice |
| Outcomes | share the routine 6/min with 2/min reserved; Major tier one active globally |
| Work onsets | ≤ 3 in any 1 s island-wide; ≤ 0.8/s per building; liveness floor `L_b = max(2.4 s, 6·P_b)` |
| Ambient non-musical onsets | ≤ 180/min island-wide, crickets included |
| Spectral | sustained 2–5 kHz ≤ 20 % of K-weighted loudness in any 60 s scene; the > 5 kHz share is baselined in 0.8b, and a wave that raises it by > 3 dB needs a listening sign-off |
| Swings | the bed and music stems rise ≤ +4 LU within 10 s except at weather onsets; captioned cues and user-initiated transitions (enable, preset switch, resume) are exempt; resting → working ramps over ≥ 20 s |

The SCN **must-never list** (`scn-soundtrack.md` §Must never happen, 13 items) is the soak assertion set for the whole plan; each item is asserted from the wave that fixes it (verification matrix).

### S8 — Hygiene and cost

- **Declick.** No `stop()` before a voice is ≥ 60 dB below its peak; every bus or group stop is a ≥ 60 ms linear ramp; every source starts at its envelope's first event time (never an untimed `start()`); a wake holds until its last note + the longest tail T60 + 80 ms.
- **`holdAt(param, t)`**: native `cancelAndHoldAtTime` when present, else `cancelScheduledValues(t)` + `setValueAtTime(param.value, t)` (Firefox lacks the former).
- **Honest filters.** One factory `engine.filter(type, hz, { q: 'butterworth' | 'gentle' | number })` converts low/high-pass Q to Web Audio's dB semantics (today every "gentle" Q 0.3–0.6 is slightly peaked).
- **Nodes.** Zero nodes per ambient event (waves, gusts, drops and chirps are automation on persistent lanes); ≤ 2 node creations per baked strike into persistent per-lane pan/send chains; ≤ 4 per musical note; ≤ 24 concurrent music sources.
- **Memory** (new `audio/SampleBank.js`): lazy per-recipe bakes through the idle helper with a timeout, ≤ 5 ms main-thread per slice, LRU eviction, nothing ever waits on a bake (live synthesis fallback). Budget ≤ 32 MB total, measured with `performance.measureUserAgentSpecificMemory()` or a heap snapshot:

  | Client | Rate | Budget |
  |---|---|---|
  | Island Air IRs (2) | 48 kHz | 1.5 MB |
  | Noise buffer pool | 48 kHz | 8 MB |
  | Workshop takes | 32 kHz | 8 MB |
  | Rare world voices (gulls, clinks, groans, thunder takes) | 32 kHz | 5 MB |
  | Music instruments (6.1) | 32 kHz | 8 MB |
  | Cue strikes (optional; node path is the default) | 48 kHz | ≤ 2 MB |

- **Audio-thread budget** on a quiet host: calm day ≤ 2.5 %, storm ≤ 3.5 % of one core for the environment; limiter 0.1 %; air ≈ 1 %.
- **Teardown.** `destroy()` cancels the idle handle, the Transport, the ladder timer and pending bakes, and disconnects worklets; `browser-lifecycle.mjs --count=250` stays green.

## Decisions

**Recorded 2026-09-26 by the maintainer.** The table below keeps the options as they were presented; this list is binding and overrides any item text it contradicts.

- **D1 — Village music:** occasions + sparse fragments, as recommended.
- **D2 — Town band voice:** the Isle Band by default; Chip restored is a one-click Town band voicing.
- **Needs-you figure:** the ship's bell (3.2).
- **D3 — Blur:** keep playing; Village goes to the quiet mix after 5.1; Town band keeps playing at −3 dB.
- **D4 — Town band carries the village: approved (both).** Town band gets MUS-16 weather and season arrangements and SIG-16 workshop percussion (new item 6.9). The percussion is a *music* voice driven by the workshop model's densities on the song's grid; the work stratum itself (C-FOL-1) stays out of Town band. `docs/design-decisions.md` "BGM mode keeps event cues but drops reactive ambience" is amended in the same change. The held note stays out of Town band (the waiting cadence carries a wait).
- **D5 — Volume after calibration:** reset everyone once to the new standard level (1.2), with a one-time caption that sound was recalibrated. No per-user migration.
- **D6 — Reminders:** Standard, capped.
- **D7 — Hour chime:** phrase only; counting opt-in.
- **D8 — Council kills: overturned (both).** All workshop buildings ship in Wave 5 (no single-building pilot stage), and continuous camera-coupled emitters are allowed (workshops, harbor and coast: SIG-5 continuous, SOTA-15, AMB-14 join Wave 5 as item 5.8). Per-tool sound stays killed.
- **D9 — Motif:** a cell from Willowbrook's opening.
- **Assets:** procedural first; a small (≤ 100 KB) original or CC0 asset may replace a voice only if it wins a blind A/B by the maintainer, with provenance recorded. Implementation ships procedural.
- **Night:** darker and quieter than day (S2 night row stays binding).
- **Execution:** the plan is executed autonomously by Opus 5.5 agents, wave by wave, each wave gated by the local probe and repo checks. Items that name a maintainer listening sign-off record the harness evidence and leave the sign-off as a pending line in the execution record.

| ID | Decision | Recommendation | Alternative |
|---|---|---|---|
| **D1** | How much music in Village | **MUSL's revised duty:** 6–10 % of the hour while ≥ 3 agents work (a closed 2–4 bar fragment every 2–3 min), up to 20 % with fewer working, ≤ 8 % at night, ≤ 3 % in deep night; one full occasion per phase (dawn, noon, dusk, night) plus the earned ones (release, return); the S7 hard zeros apply. MUSL withdrew its round-1 20–30 %: at 9 s per fragment that is one every 46 s, i.e. continuous melody. Decided on reel v2 `d1-duty`. | SCN's 4–15 % with fragments every 6–12 min (sparser); MIX's ≤ 35 % (denser). The occasion clock ships either way; only its constants differ. Anyone who wants tunes throughout picks Town band. |
| **D2** | Town band's default voice | **The Isle Band**, with **Chip restored** as a one-click voicing of Town band. Evidence (MUSL round 2 and reel v2 `town-band`, same notes, level-matched): once the bass sits 3.5 LU under the tune, Chip restored survives a laptop almost as well (Willowbrook −0.9 vs −0.8 LU), but it is the brightest arm (2–5 kHz share 8.7 % of program loudness vs 0.8 % for the Isle Band; stem share −15.0 vs −26.0 dB — eight hours a day in the ear's most sensitive band) and fails the night rule (only 2.9 dB under its day level; the rule needs 4). The shipped console arm fails the program stereo rule (S/M −17.9 dB). All three carry the needs-you at +8.0…+8.2 LU. The counter-argument is real: the console band is the maintainer's declared homage (`BgmSongbook.js:1-8`), and this replaces its default seat. Decided by ear on the three arms. | Chip restored by default (with a darker night voicing still to be designed), the Isle Band opt-in. |
| **D3** | Window blurred but visible | Wave 0: **keep playing the full mix** unless SET *In the background* = *Signals only*. After 5.1: Village blurs to a quiet mix (music out, world ×0.5, work ×0.5 accents only, signals and held note full); Town band keeps playing at −3 dB. | Village keeps the full mix on blur too. |
| **D4** | Town band playing along with the village | **Defer.** SIG-16 (workshops as percussion) conflicts with C-FOL-1 (strikes stay on the drawn grid) and FOL rejected it; MUS-16 (weather arrangements) changes a documented decision. Town band gets no world, work or held-note layer. Revisit after Wave 6. | Amend the decision and add both to Wave 6. |
| **D5** | Returning users' stored volume after calibration | **Migrate dB-exactly, never louder, never muted** (1.2), with a one-time offer in SET (7.1 moves it to the popover): it plays the needs-you figure at the standard 6/10, then ramps the master over 3 s, and says the new level is louder. | No migration + toast (a returning user would hear +15 LU at the same OS volume). |
| **D6** | Reminder default | **Standard** with a cap: L1 entry, L2 at 2 min, L3 at 6, L4 (horn under the call) at 15 and 30, then one L2 every 30 min until acknowledged; acknowledgement by selecting the agent. Decided on reel v2 `wait-arc`. | Gentle (L2 only). |
| **D7** | Hour chime | **The tower bell's signature phrase only (≈ 2.5 s; reel v2 used MUS-4's `home`, D9 may change the notes), 07:00–20:00; one soft chime at 21:00; none at night.** Counting is an opt-in *Count the hours* switch in CUE's rendered form: one great A2 bell stands for six, single A3 strikes ≥ 1 s apart count the rest (noon = great bell + six strikes) — never a count that names the wrong hour, and never a quick same-pitch pair (that is the needs-you figure). Decided on reel v2 `hour-chime`. | Counting on by default. |
| **D8** | Overturn the council's kills? | **Stage it.** Ship the Forge as the council-permitted single building-family pilot (5.1) with a full-working-day listening gate; expand to the other buildings only on D8 approval after the pilot, citing FOL's in-context evidence (accents heard 86–100 % at all eight buildings with the −3 dB trim, work bed 13.4 LU under the program, program +0.3 LU) and SCN's busy/idle contrast. Continuous camera-coupled emitters stay off unless approved. Per-tool sound stays killed. | Approve both now; or keep the kills and drop Wave 5 beyond the pilot. |
| **D9** | The village's signature motif | **A cell from the maintainer's Willowbrook opening** (the A–C♯–E call), quoted by the arrival, aurora, hour phrase and fragments; *Hearthfire* stays in rotation. Decided on reel v2 alongside D7. | MUS-4's Isle call (5̣-1-2-3) and its `home` answer, with MUS-5's new themes built on it; or no leitmotif in cues. |

## If only ten things ship

Each entry ships with its dependency closure.

1. **Wave 0** (0.1–0.8a) — sound that works and stops lying: a signal route from boot, wakes without fade, blur that keeps playing, errors that stop wearing the needs-you voice, no clicks, no GPU-driven fades.
2. **1.0 + 1.1 + 1.2** — the tonal bed retired, then the calibrated limiter-only master and the migration: the village at a sane level with the air back, and nobody startled or muted.
3. **1.3** — the cue room: note-timed per-bus ducks and bed-aware cue level.
4. **3.1 + 3.2** — a struck, placed material palette and the three signal families.
5. **3.3 + 3.7** — waiting as a state, on an honest (non-stale) gate.
6. **3.4** — outcomes: gold for shipped, red for failed, stone and oak for done.
7. **2.1 + 2.4 + 2.5 + 2.6 + 4.1 + 4.6** — the sea, never looping, in one Island Air, yielding to cues.
8. **5.1–5.3** — the workshops, all buildings (D8).
9. **2.3 + 6.5 + 6.6 + 6.7** — one sequencer, varied renditions, music as an event in Village, and a town band that breathes (after 2.5 and 4.1).
10. **7.1 + 7.2 + 7.5** — one sound control, the *Signals* preset, and the invitation at the moment of need.

---

## Wave 0 — Make sound work, stop lying (S; no taste debate)

Defects and instruments. Wave 0 keeps today's rebuild-on-hide; pause-in-place arrives with the Transport (2.1).

### 0.1 A signal route from boot; every enable is a user activation
**Owner:** `TopBar.js:486-529,591-638`, `AmbientAudioController.js:124-129,194,202-217,371-378,380-411,424-436`, `scripts/smoke/browser-lifecycle.mjs:395-466,468-515,1216-1232`, `docs/design-decisions.md:187` · **Size:** S · **IDs:** UX-1, SCN-4 (part)
**Hear:** a returning user's first click starts the village; tab and window switches resume; a hidden-tab summons rings; captions exist before anyone touches sound; the note never lies.
**Spec:** build the controller at boot idle through the idle helper (4 s timeout; no context is created). `userActivated` becomes `_gestureSeen || navigator.userActivation?.hasBeenActive === true`. **A chip click while enabled and not running (armed) records the gesture and activates; only a click on a running chip disables.** The deferred TopBar click and the SET switch call `activateFromUser(on)` with the same rule. The chip shows *armed* until the context runs. Record the boot module count and idle cost before and after (the v0.37 deferral stays a win).
**Tests:** rewrite `runAudioLifecycleProbe` and the actual-probe expectations to the real TopBar enable path; run the journey with `--autoplay-policy=user-gesture-required`.
**Accept:** fresh profile, no interaction: `team:gather` → 1 `audio:cue-played` + caption within 1 s of boot-idle; stored-on reload, first click on the chip → `enabled` stays true and `running` within 1 s; blur→focus and hide→show → `running`; a hidden summons produces audio ≥ +10 LU over the preceding 3 s.

### 0.2 Urgent wake without fade; blur keeps playing
**Owner:** `AudioEngine.js:163-183`, `AmbientAudioController.js:21,350-369,380-416,424-488`, `TopBar.js:83-118` (`PERSISTED_SETTING_DEFAULTS`), `SettingsPanel.js` · **Size:** S · **IDs:** ENG-2 (wake), UX-4 · **Decision:** D3 (Wave 0 part)
**Hear:** the away-tab summons at full level (today its first note is −22.8 dB inside a 0.4 s fade); the village keeps playing on the second monitor while the operator types in the terminal.
**Spec:** `engine.wake()` = `holdAt` → 15 ms linear ramp to 1 on the **cue path only** (the bed and music groups stay closed) → cue at +40 ms → hold until the last note + tail + 80 ms → 80 ms ramp out → `suspend()` after the ramp. Blur keeps the full mix unless `claudeville.sound.background = signals` (new key, default `play`); `document.hidden` keeps today's signals-only behaviour and rebuild.
**Accept:** a hidden summons within ±1 dB of a foreground summons; the bed+music stem during a hidden wake < −70 LUFS-M; after blur, `contextState === 'running'` and program LUFS-S within 2 dB of before.

### 0.3 Route actionable cues by bucket, not by event order
**Owner:** `AudioDirector.js:241-256,419-444,472-489`, `BgmDirector.js:159-178,192-205`, `cues/CueKit.js:233-299`, `Toast.js` captions, `scripts/tests/r1-03.cue-dedupe.test.mjs:12,48-69`, `scripts/tests/r1-19.cue-captions.test.mjs:75-76` · **Size:** S · **IDs:** SIG-1 (routing), CUE-1 (routing)
**Hear:** an API error no longer sounds like a plan-approval request; a rate limit no longer says "come now".
**Spec:** one shared function (called by both directors) picks `summons | distress | limit` from `bucketForStatus` (`SignalLedger.js:48-62`) and owns the 2.5 s per-agent dedupe. Until 3.2 replaces the voices, `distress` plays at a fixed register (no provider ×0.5; grok/omp distress sits at 55 Hz today) and `limit` reuses it with its own caption. Captions `"<name> hit an error"`, `"<name> is rate limited"`. r1-03 asserts the bucket voice in both event orders (it pins the wrong voice today).
**Accept:** errored and rate-limited agents produce `kind: distress` / `limit` regardless of event order.

### 0.4 Ceremonies supersede their parts
**Owner:** `CueGovernor.js:129,150-151,159-222`, `cues/CueKit.js:19-44,368-378` · **Size:** S · **IDs:** SCN-6
**Hear:** a team gathering is the council figure, not "Routine activity: 5 arrivals"; a release parade's aurora is no longer dropped by the 4 s spacing rule.
**Spec:** routine arrival aggregates are held 600 ms when any arriving agent belongs to a team. A superseding ceremony (`supersedes: agentIds[]`) cancels only notes that have not yet sounded (release ramp ≥ 60 ms), bypasses `minSpacingMs` once (still inside `maxPerMinute`), and replaces the aggregate's toast through its `cueKey`; the caption keeps the count.
**Accept:** `scn-moment-team-gather` replay → exactly one `council` cue-played; a release produces its ceremony and absorbs the push.

### 0.5 Envelope hazards and the storm crickets
**Owner:** `layers/CricketsLayer.js:48-61`, `bgm/BgmPlayer.js:310-312,333-336,367-376`, `layers/MusicLayer.js:476-485`, `layers/BaseLayer.js:59-81`, `AudioDirector.js:548-552` · **Size:** S · **IDs:** ENG-4, AMB-8 (part), HAR-4
**Hear:** summer nights stop ticking (the untimed `osc.start()` blip is **+15.8 dB** over its own envelope and 99.4 % of the night's loudness); mode switches stop clicking; night pads ring out instead of stopping 12 dB up; crickets fall silent in rain.
**Spec:** `osc.start(t)` at the envelope's first event; pad stop after its tail is 60 dB down; layer and player stop = `holdAt` → 80 ms linear ramp → stop at +90 ms; `engine.releaseVoice()` helper; `crickets = clamp01(min(p, 1 − p) × 10) × season × (1 − precipitation)`.
**Accept:** the envelope lint flags nothing across the catalog; the summer night within ±2 LU of the calm day at one slider (today +21 LU); precipitation 0.5 → crickets ≤ 0.5, storm → 0; BGM→Village switch max sample step ≤ 1.5× the prior p95 (today 4.3×).

### 0.6 Music quick fixes
**Owner:** `layers/MusicLayer.js:104,128,162,380,392-394`, `bgm/BgmPlayer.js:20-28,93,228-246` · **Size:** S · **IDs:** MUSL-9, MUS-13, MUS-14, MUS-7 (breath)
**Hear:** dusk keeps its tune (the melody drops an octave *under* its own chords 97 % of the time today); no buzzy 12.5 % pulse lead at night; the Ambient bass stops pumping holes every half bar; tunes stop stepping on each other.
**Spec:** at dusk transpose the whole band or none of it; night alternate lead `flute`; Ambient bass length `beatSec·1.98`; next BGM piece at `endT + 1.4` on the audio clock (today a −0.248 s overlap); stem gains per MUSL-2 (bass −3.5 LU under the lead). Rotation, loop caps and the no-return rule move to 6.7, when there is enough material to meet them.
**Accept:** dusk melody above the comp ≥ 90 % of melody time; measured breath 1.4 ± 0.05 s; Ambient half-bar dips ≤ 5/min.

### 0.7 Frame pressure never changes loudness; trims become faders
**Owner:** `AudioDirector.js:558-564,621`, `AmbientAudioController.js:300-348`, `AudioEngine.js` (group faders), `layers/BaseLayer.js:19-26`, `scripts/tests/r2-08.audio-mixer.test.mjs` · **Size:** S · **IDs:** ENG-11, ENG-12, MUS-19
**Hear:** music and birds no longer fade when the GPU is busy (music × 0.35 at pressure 3 today: a −9 dB false world signal that saves nothing measurable); the music slider at 5 % is quiet music, not no music; the wildlife slider makes birds quieter, not fewer.
**Spec:** the stored linear trims drive group faders through the v² law until 1.2 moves them to steps; `layer.level` stays the world's intensity. Deleted: `_layerBindings`, `_bindLayerMix`, `_reapplyLayerMix`, the frame-pressure level multipliers.
**Accept:** forced pressure 3 changes program LUFS-S by ≤ 0.5 LU; music trim 0.05 → `nowPlaying` non-null within 30 s; wildlife trim 0.2 vs 1.0 → bird phrase count within ±15 % and bird group −28 ± 1 dB. r2-08 asserts fader gain, not layer level.

### 0.8a Instruments: loudness registry, meters, the Wave-0 probe
**Owner:** new `audio/Loudness.js`, new `audio/worklets/meter-processor.js`, `AudioEngine.js` (lazy meters), `AmbientAudioController.js:592-612` (debug snapshot), new `scripts/audio/` (the harness moved from `output/claudeville-opus55-audio/tools/`, HAR-16), `package.json` script `audio:probe`, `scripts/tests/README.md`, `scripts/smoke/README.md` · **Size:** M · **IDs:** ENG-10, HAR-2 (part), HAR-4, SIG-18
**Spec:** `Loudness.js` holds S2; meters (K-weighted M/S/I, peak, limiter GR, duck depth per bus) exist only while `__claudevilleAudio().meters({ enable: true })`; emitter telemetry in the debug snapshot (onsets per stratum and building, drops, ladder state, link, blur state). `audio:probe` (realtime) asserts the envelope lint and the Wave-0 must-nevers.
**Accept:** meters off → 0 extra `AudioWorkletNode`s and timers; meters within ±0.3 LU of the EBU Tech 3341 stimuli; the probe fails today's tree on must-never 2, 4, 5 and 6 and passes after Wave 0.

## Wave 1 — One ceiling (the mix foundation)

### 0.8b The deterministic probe (first item of Wave 1)
**Owner:** `scripts/audio/` · **Size:** L · **IDs:** HAR-1, HAR-2, HAR-3, HAR-5, HAR-12, MIX-6, CUE-9, FOL-9, MUSL-10, SCN-9
**Spec:** HAR-1's virtual-clock renderer (the shipped directors on an `OfflineAudioContext` with a stepped fake timer queue that also pumps the idle helper and awaits bakes and `addModule`) becomes the default probe path; the realtime app session (SCN-9) remains the soak. Port the metric scripts and fixtures that the acceptance lines use (`discrim.mjs`, `cuebands.mjs`, `levelmap.mjs`, `session-metrics.mjs`, `fol-analyze.mjs`, `metrics.mjs`, `measure.mjs`, the scenario fixtures) with committed, reviewed baseline JSON; add per-bus and per-layer stems (HAR-5) and the AV-sync probe (HAR-12: published note or strike time vs `RitualConductor`'s computed downbeat or the crown timestamp, from `CueScore` diagnostics).
**Accept:** two virtual-clock runs agree within 0.2 LU; two realtime soaks within 1 LU (integrated), ±3 % (music-on) and ±5 % (re-heard).

### 1.0 Retire the tonal bed (before calibration)
**Owner:** delete `layers/TonalBedLayer.js`; `AudioDirector.js:160-168,553-596`; `AmbientAudioController.js` mixer binding; `shared/README.md` row · **Size:** S · **IDs:** AMB-10
**Why:** it is the loudest ambient layer at dawn and dusk (−44.0 / −45.4 LUFS, louder than the music), lives at 55 Hz, and its ±4-cent pair beats to full silence every 3.9 s. Calibrating with it present would bake a defect into `PROGRAM_TRIM_DB`. Its harmonic role passes to the held note (3.3).

### 1.1 Calibrated limiter-only master; volume after the ceiling
**Owner:** `AudioEngine.js:74-125,185-194`, new `audio/worklets/limiter-processor.js` (MIX's `LIMITER_SRC`: running-min lookahead, box average, 120 ms release), `Loudness.js`, every `createBiquadFilter` call site (honest Q) · **Size:** M · **IDs:** MIX-1, ENG-1 (refined), ENG-3 (refined), ENG-16, ENG-17
**Hear:** a village present at normal system volume; birds, rain sizzle and bell shimmer above 8 kHz again; no 4 kHz honk; nothing clips at any slider.
**Spec:** the S3 chain and staging. Fallback `DynamicsCompressor` −2 dB / 20:1 / 1 ms + tanh `WaveShaper`, exercised by the probe with worklets disabled. `PROGRAM_TRIM_DB` is measured on the anchor A. `latencyHint: 'playback'` only if the maintainer's Mac shows ≥ 20 % less audio-service CPU (ENG-17), and then 0.1's and 7.4's latency budgets are re-measured. Deleted: the old tone low-pass and compressor, `computeCueMix`'s unused `ambientBusGain` and `masterCeiling`.
**Accept:** a +12 dBFS burst → ≤ −0.9 dBFS; limiter static gain 0.0 ± 0.2 dB (unity); cue-path response ±1 dB 40 Hz–8 kHz, program path ±0.5 dB 55 Hz–8 kHz (−3 dB at 30 Hz); S2 scene targets on the probe; slider steps change LUFS-I by the law and leave peak-to-loudness unchanged ±0.3 dB; limiter ≤ 0.1 % of a core.

### 1.2 Volume migration and the step law (storage only)
**Owner:** `AmbientAudioController.js:51-60,86-96,219-224`, `TopBar.js:29-48,83-125` (`PERSISTED_SETTING_DEFAULTS`, `readPersistedSettings`, `resetPersistedSettings`), `SettingsPanel.js`, `scripts/tests/r3-settings.panel.test.mjs` · **Size:** S · **IDs:** MIX-9, UX-8 · **Decision:** D5
**Spec (D5: reset, not migrate):** volumes and trims are stored as steps (0–10). On load, if `claudeville.sound.calibration` is absent, every stored volume is replaced by the standard step and every trim by its default step, `claudeville.sound.calibration = '2'` is written last, and one caption says `Sound was recalibrated to a new standard level.` `readPersistedSettings` and SET parse steps; `resetPersistedSettings` writes steps and the calibration key; both keys join `PERSISTED_SETTING_DEFAULTS`. The top-bar slider control itself is left to 7.1. Deleted: the duplicated `readStoredLayerLevels` / `AUDIO_MIXER_DEFAULTS` in `TopBar.js` (one owner).
**Accept:** a profile with any legacy volume/trims loads at the standard step once, captions once, and keeps later user changes; reset → the standard step.

### 1.3 The cue room: buses, note-timed ducks, bed-aware cue level
**Owner:** `AudioEngine.js:92-125,196-204`, `layers/BaseLayer.js:24`, `layers/MusicLayer.js`, `bgm/BgmPlayer.js`, `cues/CueKit.js:175-300,385-421`, `CueGovernor.js:85-98`, `BgmDirector.js:37-38,232-241`, `scripts/tests/w3-f.audio-priority.test.mjs:63-70` · **Size:** M · **IDs:** MIX-2, ENG-5, ENG-7, MIX-8, SCN-1
**Hear:** the bed yields a breath exactly as a bell rings and returns as it rings out; the bed never dips for a cue that did not play; calm-day thunder no longer jumps out.
**Spec:** S3 buses, duck table, bed-aware trim (aiming at floor + 1 LU) and urgent rules. Urgent voices carry partials in the 0.8–2.5 kHz valley every bed leaves nearly empty (4.8–14.6 % of bed loudness); cue peak-to-loudness ≤ 8 dB. Deleted: `BGM_DUCKED_LEVEL` (the attention stage replaces it), the schedule-time `engine.duck`.
**Accept:** **with today's cue voices** (the new ones arrive in 3.2): the S2 windows minus 2 LU for needs-you and error over the probe beds, the band rule, and urgent GR ≤ 3 dB; duck onset within ±20 ms of `from − attack` for 20 injected cues, including a body-anchored arrival 3 s out; a pre-empted prepared cue leaves the bed within 0.2 dB of flat; ducked time ≤ 5 % in a 60-minute Town band soak. The full S2 floors are gated at the Wave-3 exit with the new voices.

### 1.4 Weather and resting budgets; the pilot light
**Owner:** `AudioDirector.js:537-574` · **Size:** S · **IDs:** MIX-3, SCN-5
**Hear:** a storm swells without blasting (+10…+13 LU over the day today); resting is a quiet shore, never a void that reads as "sound broke".
**Spec:** one `WEATHER_CEILING` on the world bus from the 1 Hz tick; rain level ≤ ×0.35 of today; wind capped while raining; resting keeps the world stratum at the S2 pilot light (wind until the sea lands in 4.1); the quiet-floor multipliers doubled.
**Accept:** rain ≤ A + 5, storm ≤ A + 8, with urgent GR ≤ 3 dB over each; resting ST mean A − 10 ± 3, never below −55; an arrival into resting lands with ≥ 2 bands rising ≥ 6 dB.

### 1.5 Spectral hygiene and stereo, per stratum
**Owner:** `AudioEngine.js` (tilt, presence dip, music shelf), `AudioDirector.js:581-597` (tilt from phase), `layers/*`, `bgm/BgmPlayer.js`, `layers/MusicLayer.js` · **Size:** S–M · **IDs:** MIX-5, MIX-4, SOTA-14
**Spec:** circadian high shelf at 3 kHz on world + music only (dawn +1, day 0, dusk −1.5, night −3 dB); world presence dip −3 dB @ 3.4 kHz; music low shelf −3 dB @ 160 Hz; bass < 300 Hz mono; interim music widening until 6.1's seats land.
**Accept:** rain 2–5 kHz share ≤ 20 % (44 % today); music and cue stems S/M −20…−8 dB, correlation ≥ 0.75, mono fold loss ≤ 1 LU; program S/M −12…−2 dB and mono fold loss ≤ 2 LU (reel v2 world scenes: −2.0…−3.5 dB, 1.6–2.1 LU — the sea's width is the point; the Mono output in 7.7 compensates it); laptop-model loss ≤ 3 LU for day and Town band scenes.

### 1.6 Mode crossfade; one cue arbiter owned by the engine
**Owner:** `AmbientAudioController.js:240-260,418-422`, `AudioDirector.js:128-129,194`, `BgmDirector.js:103,125,261`, `AudioEngine.js` (`engine.cues`), `scripts/tests/{r1-03.cue-dedupe,w5-b.ui-fixes,r2-03.spatial-audio}.test.mjs` · **Size:** S–M · **IDs:** ENG-15
**Hear:** switching preset feels like walking from the square into the tavern: no hole (−66 LUFS-M and a 12 LU hole for 2.4 s today), no bump, no restart, and no second summons for the same agent right after a switch.
**Spec:** each director gets a group gain; 2.5 s equal-power `setValueCurveAtTime`; the old director stops after the fade. One `CueGovernor` + `CueKit` live on the engine, which owns their lifetime; directors call `engine.cues`. Signal routing still chooses which subscriptions are live (the BGM decision stays intact). Deleted: per-director governor and CueKit construction, `governor?.clearRoutine?.()` calls, `AudioDirector.destroy()` destroying a shared governor.
**Accept:** during a switch, momentary loudness never falls > 3 dB below min(old, new) steady state; summons → switch → the same agent's summons within 45 s is rejected; must-never 12 passes.

## Wave 2 — One clock, one air

### 2.1 Transport, pause in place, seeded streams
**Owner:** new `audio/Transport.js`, new `audio/Rng.js`, `layers/BaseLayer.js:49-57`, `layers/{Rain,Birds,Crickets}Layer.js`, `layers/MusicLayer.js:243-321,426-429`, `bgm/BgmPlayer.js:199-260`, `AudioEngine.js:20-26` (`rand`/`pick`), `AmbientAudioController.js:350-369,380-411` · **Size:** M–L · **IDs:** ENG-8, ENG-2 (pause), AMB-13, SOTA-16 (step 1)
**Hear:** storms and phase changes land within about a bar instead of a section (music commits up to ~17 s ahead today); crickets keep true rhythm under render load; alt-tab continues the same tune mid-phrase instead of starting a new piece.
**Spec:** S4. Stochastic layers become renewal processes in audio time; both sequencers emit per window. **Pause** stops the Transport, closes the world/work/music group gains (80 ms) and suspends the context; **resume** re-arms every process from `currentTime` with no catch-up and fades in over 250 ms; absences > 10 min or a phase-family change rebuild. Each world layer gets its own seeded stream from `Rng.js`. Deleted: every `setTimeout` that places a sound, the smear-to-now code, the `VillageHumLayer` knock path (`VillageHumLayer.js:31-81`; not ported — 5.1 replaces it).
**Accept:** 10-min `?sim=1` with World running: `underruns = 0`, tick p95 ≤ 0.5 ms; committed ahead ≤ 1.5 s (work ≤ 350 ms); exactly one timer places sound (probe counter); after 120 s hidden, 0 sources created while suspended and onsets in the first 1 s after resume ≤ steady rate + 1; after blur 3 s → focus the piece is unchanged and the level is within 6 dB in ≤ 0.3 s. **Conditional:** ENG-18's worklet sequencer only if underruns are observed on the maintainer's machine (MUSL rejected it otherwise).

### 2.2 MusicClock
**Owner:** new `audio/MusicClock.js`, `AudioEngine.js:48-64`, `bgm/BgmPlayer.js:152-222`, `layers/MusicLayer.js:278-306`, `MusicalScale.js` (MUS-21: delete the unread `SCALES[*].tones` claims and dead data) · **Size:** S · **IDs:** MUS-1, MUS-21
**Accept:** `__claudevilleAudio().musicClock` shows the chord matching `nowPlaying.bar` in both modes; `chordAt` agrees with the song data at 100 % of beat points; an idle clock reproduces today's `cueTones` to the cent.

### 2.3 One sequencer, one songbook (code only)
**Owner:** `layers/MusicLayer.js`, `bgm/BgmPlayer.js`, `bgm/BgmSongbook.js`, new `audio/music/Voicings.js` · **Size:** M · **IDs:** MUS-17, MUSL-6 (structure)
**Spec:** one sequencer plays one songbook in both presets on the Transport; a voicing table selects instruments per preset and phase. This item changes structure, not sound: the Chip voicing reproduces today's timbres (plus 0.6), and Village plays a sparse arrangement of the same score. Doing it here means the Transport is written once for one sequencer.
**Accept:** level-matched renders of every shipped piece before and after within 0.5 LU and identical note onsets; one scheduler owns all music.

### 2.4 Island Air and one `place()`
**Owner:** new `audio/IslandAir.js`, new `audio/SpatialField.js`, `AudioEngine.js` (send and return buses per S3), `cues/CueKit.js:76-80,316-381`, `AudioDirector.js:85-91,342-392,581-597`, `BgmDirector.js:202-205`, `layers/MusicLayer.js:212-240`, `bgm/BgmPlayer.js:100-117` · **Size:** M · **IDs:** AMB-2, ENG-6, SOTA-1, SIG-5 (placement at schedule time), FOL-6
**Hear:** bells bloom off plaza stone; a far arrival is duller and wetter than a near one; the needs-you call stays close and dry; birds sit in trees, not in your ear.
**Spec:** S5. Send levels start from the AMB-2/ENG-6 tables (summons 0.12, hour bell 0.45, birds 0.3, bass/wind/rain 0). The per-voice feedback echoes of the Village lead and BGM lead are retired into the air. Deleted: `panForScreenX`'s hard ±1 mapping.
**Accept:** T60 per S5; air adds ≤ 1 LU to the program; direct-to-reverberant ≥ +8 dB at d = 0 and ≤ +1 dB at d = 1; urgent cues wet ≤ −14 dB re dry; ≈ 1 % of a core when fed; `npm run world:benchmark-fps` with sound on vs off: `appTotalMs` p95 delta ≤ 0.1 ms.

### 2.5 Hybrid noise engine
**Owner:** `AudioEngine.js:28-46,127-133`, new `audio/worklets/noise-processor.js` (rain dust and bubbles only), `layers/{Wind,Rain,VillageHum}Layer.js`, `cues/CueKit.js:390-410` · **Size:** S–M · **IDs:** AMB-3, ENG-13, SOTA-2
**Spec:** a pool of long co-prime stereo buffers read as independent lanes (26 looping buffers bench at 0.16 % of a core against 1.90 % as worklets); a small worklet only for rain dust and bubbles; thunder takes a fresh grain per strike.
**Accept:** render the buffer-pool path (not rendered by AMB): every continuous texture has autocorrelation < 0.05 at 0.5–20 s lags and world-bed ICC 0.15–0.5 on a 60 s capture (reel v2: 0.15–0.28), with program mono fold loss ≤ 2 LU; no two lanes read the same noise within 5 s; pool within its S8 budget.

### 2.6 SampleBank: runtime-baked voices
**Owner:** new `audio/SampleBank.js` · **Size:** M · **IDs:** ENG-14, FOL-2 (bake), C-AMB-4, CUE-8 (optional)
**Spec:** S8 memory table. First clients: the Island Air IRs, the workshop takes (5.2), the rare world voices (4.1, 4.4), the music instruments (6.1). Cue strikes stay on the node path by default.
**Accept:** total resident ≤ 32 MB (measured); each bake slice ≤ 5 ms; a cue at enable + 100 ms never waits on a bake; LRU eviction exercised by a fixture.

## Wave 3 — The village's voice: signal, outcome, routine, scenery

Every item keeps the shipped `CueScore` offsets for arrival `[0,220]`, departure `[0,240]`, recovery `[0,200]` and council `i × 280` when no music plays, so every visual accent lands where it does today (C-CUE-5). Recipes: `cue-design.md`, `cue-snippets/palette.js`.

### 3.1 One struck, placed material palette
**Owner:** `cues/CueKit.js:316-381` (`_bell` → strike engine), new `cues/Materials.js`, `MusicalScale.js:24-112` · **Size:** M · **IDs:** CUE-2, SOTA-5
**Hear:** real bells instead of dry integer-partial sines: a strike transient, a decay per partial, slowly beating doublets, in the air.
**Spec:** nine material recipes as partial rows (chime, handbell, healed, cracked, tower, glock, glass, iron, oak); civic and signal bells follow campanology (a major-third bell by day, a minor-third bell at night); routine chimes use small handbell spectra (1 : 2 : 3 : 4.2).
**Accept:** the gallery +2.7 LU and S/M ≈ −12 dB against the baseline gallery through the same master (mono today); spectral peaks within ±5 cents of the recipes; maintainer pass "bell, not beep".

### 3.2 Three signal families
**Owner:** `cues/CueKit.js:19-65,233-299`, `CueScore.js:40-56,71-81,98-101`, `CueGovernor.js` lanes · **Size:** S · **IDs:** CUE-1, SIG-1
**Hear:** *needs you* is a ship's bell — a quick double strike on one bright bronze note, rung twice, dry and close; *error* a lower cracked bell that falls a fifth and resolves (flam, E4→A3, 7 Hz beating, fracture noise); *rate limit* three steel escapement ticks slowing down — plainly "wait", not "come".
**Spec:** needs-you is the **ship's bell** chosen in evidence round 2 (`cue-design.md` §Round 2, `cue-snippets/palette.js` `summonsShip`): bronze handbell on E5, strikes at 0/150 ms (second ×0.85), the pair repeated every 650 ms, gain `G.handbell × 0.85`, every strike ringing on; ladder L2 = one pair ×0.6, L1 = two pairs, L3 = three pairs, L4 = L3 + the horn. It replaced the first figure (a door chime, E5→C♯5 by day and E5→C5 by night): that was the literal household doorbell interval, and its openings collided with the hour phrase and with *Lanternlight* bar 10. Across a 27-cue matrix the ship's bell scores 18 × 3/3 and 9 × 2/3 with 0 below 2/3, and matches the door chime's presence margin (+7.0 dB over BGM in the overlay proxy); against the flat single-pitch cues it is separated by rhythm and timbre only. SIG-1's E5-A5-B5 passed the matrix but quotes the Isle call; MUS-4's 5→9 failed it (1/3). Deleted: `summonsUrgency`, `SUMMONS_BASE_GAP_MS`, `SUMMONS_URGENT_GAP_LIFT_MS`, `MAX_SUMMONS_WAIT_MS` (the ladder replaces the urgency gap).
**Accept:** needs-you, error and limit pairwise ≥ 2/3 on `discrim.mjs` (error ≡ limit today); every signal cue vs every other voice ≥ 2/3 (3/3 is the target); over the Town band with no trim, presence band ≥ +6 dB (CUE-1); with 1.3, the S2 floors per bed and urgent GR ≤ 3 dB on the reel v2 pairs regenerated from code.

### 3.3 Waiting as a state: held note, ladder, one cluster call
**Owner:** new `audio/UrgencyLadder.js` (pure), a held-note voice on `signalBed`, `AmbientAudioController.js` (a 1 Hz signal-route timer created with the controller at boot, cleared on destroy), `CueGovernor.js:5-25,159-168` (lane `reminder`, urgent micro-window), `application/AttentionService.js:292-320` (`attention:acknowledged` on selection or `A` traversal), `BgmDirector.js`, `Toast.js`, `scripts/tests/w3-f.audio-priority.test.mjs:38-49` · **Size:** M · **IDs:** SIG-2, SIG-3, SIG-10, CUE-3, SCN-2, MUS-9 (Village half) · **Decision:** D6
**Hear:** in Village, an unanswered question stays present as a faint open fourth (A3 + D4) over the island; at 2 min one soft call, at 6 min three, at 15 min three with a low watchtower horn under them — never louder, only more often; answering resolves D to C♯ (C at night) with a small exhale. Six agents erroring at once is one call with a soft flock of ticks, not a chord 14.5 LU louder.
**Spec:**
- The ladder runs on the always-on signal route, not the director tick, so reminders caption with sound off and wake a hidden tab through `_hiddenSummonsHandler`. Village-aggregated on the oldest *unacknowledged* agent; `needsYou` climbs L1→L4, `errors` holds at L3, `quota` stops at L2; the S7 caps apply; never from stale data (3.7).
- Held note: two single sines, A3 and D4, each with ≤ 1 cent slow drift (beating depth ≤ 3 dB); level **bed − 8 ± 1 LU** short-term, specified by loudness, never by gain (at bed − 10, reel v2 measured only +4.1…+5.4 dB in its band; SCN measured +9.7 at bed − 7.6). It sounds in Village only while no music plays; under music the band cadences open instead. Not in Town band or Signals.
- The ladder's cue trim is taken once at entry and held for every reminder of that wait, so L2 stays ≥ 4 LU under L1 and L3 keeps urgent GR ≤ 3 dB (reel v2: 3.6 dB with a re-taken trim).
- Cluster: the first urgent cue plays at once; same-lane urgents within 400 ms merge into ≤ 4 flock strikes; every agent keeps its caption.
**Accept:** pure unit tests on `UrgencyLadder.next` (2/6/15/30 min, the post-L4 cap, ack suppression, focus deferral, family caps); 60-minute fake clock with sound off → the expected captions; tab hidden with sound on → each reminder wakes within 60 s of its time; six same-tick raises → M-max within +1 LU of one call; 270–310 Hz ≥ +6 dB within 6 s of a wait at W = 1 and at W = 15, and back within 5 s of the answer; beating depth ≤ 3 dB.

### 3.4 The outcome stratum
**Owner:** `AudioDirector.js:212-290`, `application/` (a small outcome derivation from World-model transitions), `BgmDirector.js:145-179`, `CueGovernor.js` lane `outcome`, `cues/CueKit.js` kinds, `CueScore.js` offsets, `Toast.js` · **Size:** M · **IDs:** CUE-4, SIG-6, SOTA-8, SIG-14
**Hear:** a long turn ends with an oak knock at the agent; a sub-agent returns as a pebble on stone; a failed push or command is a dead iron double clank; a commit or push is a gold glockenspiel, and a verified release rings a tower-bell peal once, landing on the crown's cream frame.
**Spec:** C4 tiers (Minor one onset, Medium two, Major ≤ 2.5 s and one globally), S2 per-tier windows; turns ≥ 20 s only; exit 0 is silent; Minor kinds aggregate over 1.5 s with exact-count captions ("4 turns finished"); dispatch fans are one whoosh with a count; gold is built from open fifths so it is key-safe at night. **Sources:** `outcome:verified` (both modes); turn end and sub-agent return derived from World-model state transitions (`agent:updated`, `parentSessionId`) so they work in Dashboard; `tool:result` failures are World-only (AgentEventStream is gated on World mode) and are stated as such.
**Accept:** fake-event harness: `outcome:verified{push}` → one `push` cue + caption + published notes; 10 × exit 0 → silence; 10 non-zero from one agent in 60 s → ≤ 2; a Dashboard fixture produces turn-done and return cues; the crown's timestamp vs the peal's published note within ±15 ms (HAR-12); every outcome differs from needs-you 3/3.

### 3.5 Pitch roles, on-beat routine cues, provider by alloy
**Owner:** `MusicalScale.js:114-148` (`cueTones` → role resolver), `cues/CueKit.js:175-202`, `CueScore.js:91-107`, `scripts/tests/cue-score.test.mjs:23,26-30`, `scripts/tests/r2-03.spatial-audio.test.mjs:84-100,154-158,176-183` · **Size:** S–M · **IDs:** CUE-5, MUS-2, MUS-3, ENG-9, CUE-7
**Hear:** arrivals and recoveries ring as part of the band's harmony and on its beat instead of a sour bump (44–56 % of music time today a cue forms a semitone or tritone with the chord); provider identity is an alloy tint, and no provider moves an urgent cue into another cue's register.
**Spec:** routine and scenery cues take chord-relative role tokens with a clash guard and follow the S4 grid rules; with no music, pitches and offsets are exactly today's. Signal cues: fixed pitches, clash guard only, never delayed. Providers: four alloys on the routine chime (clay for Claude, brass, glass, bell-metal), register fixed; no alloy uses bronze partial ratios. The cue-score recovery pin applies with no music only; r2-03's hard-pan and nine-voicing pins are rewritten to S5 and the alloys.
**Accept:** routine m2/tritone contact 0 % across all pieces × cue kinds (score analyzer, 6.5); ≥ 90 % of non-body-anchored routine onsets within 5 ms of the grid while music plays, mean added latency ≤ 120 ms; urgent added latency 0.

### 3.6 The hour chime
**Owner:** `cues/CueKit.js:266-269`, `CueScore.js:91-107`, `AudioDirector.js:599-604`, `BgmDirector.js` hour bell · **Size:** S · **IDs:** CUE-6, SOTA-7, MUS-15 · **Decisions:** D7, D9
**Accept:** at 09:00, 12:00 and 15:00 the rendered cue is the signature phrase on the tower bell at its published offsets ±5 ms; with *Count the hours* on, 12:00 rings the great bell + six single strikes, 09:00 the great bell + three, 15:00 three single strikes, all ≥ 1 s apart; caption `Hour bell · 3 o'clock`; loudness in the scenery window (reel v2: 09:00 +2.8, 12:00 +4.5 LU).

### 3.7 Honest silence and the return digest
**Owner:** new `audio/AudibleWorld.js`, `AudioDirector.js:212-285` (subscribe `ws:state`, `ws:disconnected`, `watcher:state`, `attention:digest`), `cues/CueKit.js` kinds `linkLost`, `linkRestored`, `digest` · **Size:** S–M · **IDs:** SIG-9, SIG-15, SCN-4
**Hear:** a dropped feed is audibly different from a calm village (the work stratum and held note fade, one "lantern out"; the wind stays); coming back after at least `UNATTENDED_DIGEST_THRESHOLD_MS` (60 s, `AttentionService.js:19`), one phrase of ≤ 5 notes says "one shipped, one failed, someone still waiting" — past first, the open wait last.
**Spec:** `linkLost`/`linkRestored` on a non-scenery lane (scenery is suppressed while hidden); the digest is sound-only; the `attention:digest` toast is its caption.
**Accept:** killing the isolated server's socket → one `linkLost` within 13 s and work onsets → 0; a stale "working" fixture contributes zero onsets and zero murmur; digest {errors 1, waiting 1, pushes 2} → the ordered notes within 1.2 s; an empty digest → nothing.

### 3.8 Captions that name the fact, with a setting; alerts that do not double the bell
**Owner:** `Toast.js:5-6,93-202`, `CUE_PRESENTATION`, `AudioDirector.js:263-267,408-414`, `AttentionService.js:466-470`, `SettingsPanel.js` · **Size:** S · **IDs:** UX-12, UX-13
**Spec:** SET *Captions: Signals only / Signals and events / Everything I can hear* (defaults per S6); distress captions carry the status; council captions carry `teamName` and size; "Thunder nearby" loses its location claim; scenery captions only while sound is on; desktop notifications are `silent` when the village will ring its own bell.
**Accept:** the caption/sound parity probe (HAR-13) passes for every kind in each caption setting, in both presets and with sound off; a sound-off user with default settings sees no outcome or scenery captions.

**Wave-3 exit — listener battery.** The maintainer and ≥ 2 listeners, laptop speakers at 50 %, 2 minutes of familiarisation, SIG's tests T1 (idle / light / busy), T2 (family: needs-you / error / limit / arrival / shipped, target ≥ 90 %) and T5 ("is anyone waiting?", ≥ 8/10). `discrim.mjs` thresholds are calibrated from it once, before they gate merges; results go in the execution record.

## Wave 4 — The island: the world stratum

Recipes, budgets and renders: `amb-environment.md`, `amb-snippets/src/`.

### 4.1 The sea
**Owner:** new `audio/layers/SeaLayer.js`, `AudioDirector.js:160-168,537-556,581-595`, `AmbientAudioController.js:27-30` (mixer channel *Weather & sea*) · **Size:** M · **IDs:** AMB-1, SOTA-3
**Hear:** the island finally has a shore: a slow breathing of surf under everything, felt more than heard by day, forward at night, big in a storm; harbor lapping, far gulls, halyard clinks, hull groans. Weather and phase drive it; agents never do.
**Spec:** 3 crash + 2 wash + 2 lapping lanes shaped by per-wave automation (zero nodes per wave); two incommensurate swell cycles (97.3 s, 41.9 s); rare voices baked (2.6); hull groans moved out of 500–700 Hz (to ≥ 800 or ≤ 450 Hz) and the harbor rigging partitioned from the git-work voice (C-AMB-8).
**Accept:** by day the sea stem sits 2–6 LU under the anchor A (it is ground, not figure); ICC 0.1–0.4, r(4 s) < 0.05, ~5 breaking waves/min; the night bed gains +7…+20 dB in 250 Hz–1 kHz; the world stem is bit-identical at 0 vs 12 agents; the sea ≤ 2 % of a core on a quiet host.

### 4.2 Thunder with distance
**Owner:** `cues/CueKit.js:385-421`, `AudioDirector.js:276-284` · **Size:** S · **IDs:** AMB-6
**Hear:** a crack then a 5–8 s roll that sweeps across the stereo field, arriving `0.4 + 4.5·(1 − intensity)` s after the drawn flash, clearing its own storm — and the storm no longer goes quiet for it.
**Accept:** in the storm scene at ≤ A + 6: thunder near +5…+10 and far +2…+6 LU from the thunder onset, with the level mapped monotonically from intensity (reel v2 measured +12.4 at 0.8, +7.9 at 1.0 and +1.7 at 0.5 — non-monotonic and out of both windows); thunder ST max ≤ −27; no duck; a fresh noise grain per strike; thunder GR ≤ 6 dB; the error bell over this storm ≥ +6 LU with GR ≤ 3 dB.

### 4.3 Wind and rain with material
**Owner:** `layers/WindLayer.js`, `layers/RainLayer.js` · **Size:** M · **IDs:** AMB-4, AMB-5
**Hear:** gusts that cross the island with rigging whistles and canopy; rain on roofs, leaves and water, with drops on water gliding *up* (they glide down today).
**Accept:** C-AMB-3 (no loop; world-bed ICC 0.15–0.5; program mono fold ≤ 2 LU); the storm environment ≤ 3.5 % of a core; rain 2–5 kHz share ≤ 20 %.

### 4.4 Birds by species and hour; crickets done right
**Owner:** `layers/BirdsLayer.js`, `layers/CricketsLayer.js` · **Size:** M · **IDs:** AMB-7, AMB-8
**Hear:** a dawn chorus that thins through the day, with species grammars instead of pure 2.3–4.1 kHz sine whistles; a summer-night cricket chorus that sings in bouts, follows the season and stops in rain.
**Accept:** no pure sine above 2 kHz longer than 150 ms; birds on 3 perch lanes with 0 node creations per phrase; ambient onsets ≤ 180/min including crickets; with 6.3, the clear-night program's 2–5 kHz sits ≥ 4 dB under noon (reel v2 `dusk-occasion`: +5.6 dB *over* noon, from the cricket chorus and the music box).

### 4.5 The day arc and seasons as one table
**Owner:** `AudioDirector.js:537-556`, new `audio/DayArc.js` (pure table keyed to the grade keyframes) · **Size:** S–M · **IDs:** AMB-11, AMB-12, HAR-9
**Accept:** every world scene within its S2 row relative to A (the 72-scene map through the virtual clock); night ≤ the Village session.

### 4.6 A cue-aware environment
**Owner:** `layers/SeaLayer.js`, `AudioEngine.js` duck scheduler · **Size:** S · **IDs:** AMB-9
**Why:** in the realtime A/B a breaking wave took a council cue's margin from +4.4 to −0.1 LU.
**Spec:** when a cue is scheduled, the sea re-commits its automation within the horizon (cancel and reschedule) so no crest lands within ±1.5 s of the cue; the world duck covers the rest. Cues scheduled < 1.5 s ahead rely on the duck alone.
**Accept:** the S2 margins hold with a cue placed on a crest.

### 4.7 The village breathes: a logarithmic murmur, honest at night
**Owner:** `AudioDirector.js:553,564`, `layers/VillageHumLayer.js:14-32` (murmur only, on the work bus) · **Size:** S · **IDs:** SIG-8
**Spec:** `B = log2(1 + W) / log2(17)` over non-stale working agents; width and band centre follow `B`; night darkens (−30 % centre, low-pass 900 Hz) but **does not cut level** (≈ −12 dB at 22:00 today).
**Accept:** ≥ 2 dB monotonic steps in 150–600 Hz between W = 1, 3, 7, 15; 22:00 vs 12:00 at W = 6 within 2 dB.

## Wave 5 — The work: workshop voices (scope per D8)

Recipes and beds: `fol-workshop-voices.md` (including §Round 2), `fol-snippets/`.

### 5.1 WorkshopLayer — every building
**Owner:** new `audio/layers/WorkshopLayer.js`, new `audio/WorkshopModel.js` (pure), `AudioDirector.js:160-169,507-611`, `docs/design-decisions.md` (new entry *Workshop voices are density, not per-call*) · **Size:** L · **IDs:** FOL-1, SIG-4, SOTA-6, FOL-5 · **Decision:** D8
**Hear:** the Forge rings when agents edit, a soft page turn at the Archive when they read, a pick at the Mine, crates at the Harbor — a located, legible texture; a stalled agent is a missing strike.
**Spec:** the model reads non-stale `working` agents and `classifyTool(agent.currentTool, …)` (`ToolIdentity.js:473-590`) from the World model, so it works in Dashboard (where `tool:invoked` never fires). **Tool-start density raises the accent rate; there is never one sound per call.** Accents land on the drawn ritual downbeat in World (read at scheduling time); continuing work is carried by quieter ghost strikes on each building's gesture grid, **one pitch per building**, under a liveness floor; per-agent slot pitches sound only on accents. SOTA-6's downbeats-only rule was rendered and rejected (the Forge went quiet 6.9 s before three agents stopped editing). All buildings ship together (D8).
**Accept:** Forge longest normal gap ≤ 2.8 s; last strike ≤ 1 s before the agent's first non-working observation and none more than `P_b` after it; zero onsets from stale agents, a lost link or `working === 0`; in World, published strike times vs computed downbeats: median ≤ 15 ms, p95 ≤ 30 ms, poll-lock pulse index ≤ 1.8 (FOL-5, HAR-12); main-thread ≤ 0.1 ms per tick.

### 5.2 The material palette, baked
**Owner:** `WorkshopLayer.js`, `SampleBank.js` · **Size:** M · **IDs:** FOL-2 (v2/v3)
**Spec:** steel anvil (Forge, A6–F♯7 thick-block modes, off the gold register; ghosts on B6 only), parchment and quill (Archive), steel pick on limestone (Mine: 1.1–1.4 kHz chip modes), brass tack and a single chalk stroke on slate (Task board: tock at 1.3–1.6 kHz), brass telescope detents (Observatory: 4–5 fast detents at 2.2–2.6 kHz), rune-stone breath and glass ticks (Portal: a short 1.2 → 3.5 kHz breath), canvas flag (Command: cloth crack at 1.6–2.2 kHz), rope and oak crate (Harbor: 1.35–1.6 kHz knock); none for the Lighthouse. Air send 0.7 (at 1.8 the stratum's own tails masked its strikes: Mine 64 → 86 %, Archive 67 → 100 % when lowered). Round-robin micro-variants, 2 nodes per strike, 32 kHz takes. Recipes: `fol-workshop-voices.md` FOL-2 (v3).

### 5.3 Level, voicing and budget in context
**Owner:** `WorkshopLayer.js`, `Loudness.js` registry · **Size:** S · **IDs:** FOL-3, FOL-4, C-FOL-3/4
**Spec:** the *Workshops* trim defaults to −3 dB; per-strike ceiling −45 dBFS (early reflections included) plus an overlap guard (−6 dB on a strike that starts inside another's loud window — a chalk stroke and a rune tick from two buildings summed to −40.4 dBTP without it).
**Accept:** in the reference scene: work bed ≤ program − 8 LU (v3: −13.4) and program Δ ≤ +0.5 LU; work TP ≤ min urgent-cue TP − 2 dB against the Wave-3 voices (v3: −43.3 dBTP vs a −42.8 target set by today's summons); every building's accents heard ≥ 80 % by day (v3: 86–100 %); onset-weighted 2–5 kHz share of the program ≤ 1.5 % (v3: 1.02 %); ≤ 3 onsets in any 1 s; routine-cue margin loss ≤ 0.3 LU.

### 5.4 Slots, focus and silence as information
**Owner:** `WorkshopModel.js`, `WorkshopLayer.js`, `AudioDirector.js:212-226` · **Size:** S · **IDs:** SIG-11, SIG-12, UX-17, FOL-7
**Hear:** two smiths at one forge accent on two different anvils; following an agent brings its own work forward (+4 dB, drier) without touching the signal stratum. With ghosts on one pitch (the fatigue fix), a single agent's stall is heard only through its accents stopping — about 10–20 s after the stall rather than within a few seconds (FOL round 2); the whole Forge stopping stays immediate (last strike 0.45 s before the turn ends).
**Accept:** a 2-forge-agent fixture yields 2 distinct accent pitches; selected-agent onset gain +4 ± 0.5 dB; a needs-you from another agent is unchanged.

### 5.5 Night and Town band policy for work
**Owner:** `WorkshopLayer.js` · **Size:** S · **IDs:** FOL-8 · **Decision:** D4
**Spec:** at night the work voices pass a 3.2 kHz low-pass with the slot flips C♯7→C7 and F♯7→G7 (all slots in A-minor pentatonic), at unchanged level ("work behind shutters"; SIG-4's 1.4 kHz would cost −13 dB at F♯7); Portal ticks ×0.75. No work stratum in Town band while D4 stands.
**Accept:** accent audibility ≥ 80 % over the night environment at every building (v3: 78–100 %; the Portal, at 78 %, needs a night re-voice — both misses coincided with a Command flag).

### 5.6 The quiet mix on blur (D3, second half)
**Owner:** `AmbientAudioController.js:380-416`, `AudioDirector.js` · **Size:** S · **IDs:** SIG-7, SCN-4 · **Decision:** D3
**Accept:** after blur in Village, music 0, world and work at their D3 levels (ghosts off), signals and held note unchanged; Town band −3 dB; focus restores within 1 s.

### 5.7 Quota weather in the mine
**Owner:** `WorkshopLayer.js` mine emitter, `AudioDirector.js` (`usage:updated`) · **Size:** S · **IDs:** SIG-13
**Accept:** a ratio sweep 0.7 → 1.0 raises the mine's 80–160 Hz band ≥ 10 dB monotonically; zero `audio:cue-played` from this path; silent on stale data.

### 5.8 Continuous emitters follow the camera (D8)
**Owner:** `audio/SpatialField.js`, `WorkshopLayer.js`, `layers/SeaLayer.js`, `AudioDirector.js:292-297,342-392` · **Size:** S–M · **IDs:** SIG-5 (continuous), SOTA-15, AMB-14 · **Decision:** D8
**Hear:** pan toward the Harbor and its creaks and lapping slide to centre and brighten; zoom into the Forge and its anvil becomes present and dry while the far Archive softens.
**Spec:** each building's workshop chain and the harbor/coast lanes keep one persistent pan/low-pass/send chain; on `atmosphere:updated` (~2 Hz) the SpatialField recomputes their placement from the camera and applies it with `setTargetAtTime(τ 0.25 s)`. Signal cues are unaffected. Dashboard uses the fixed island map.
**Accept:** a scripted camera pan across the Harbor moves its emitter pan through 0 within 0.6 s of the camera crossing; no automation step larger than 0.2 pan per update (no pumping on a still scene: zero parameter changes when the camera is still); `world:benchmark-fps` sound on vs off `appTotalMs` p95 delta ≤ 0.1 ms.

## Wave 6 — The music

Direction: `musl-music-listening.md` §Musical direction statement (with the D2 change). Notated material: `mus-composition.md` MUS-5. Instrument recipes: `musl-snippets/`. The council plan's stage-three gate applies: Waves 1–3 verified in a real listening session first.

### 6.1 The Isle Band: instruments, seats, one room
**Owner:** new `audio/music/Instruments.js` (Karplus–Strong lute, harp and pizzicato upright; breathy wooden whistle; modal marimba; steel-comb music box without a clapper strike; brushes), `audio/music/Voicings.js`, `SampleBank.js` · **Size:** L · **IDs:** MUSL-1, MUSL-5, SOTA-20, SOTA-9 (a worklet only if the node path misses its budget) · **Decision:** D2
**Hear:** the same tunes played by the island's own musicians in the square — warm, articulate, decaying, in stereo, and still audible on a laptop.
**Accept:** level-matched A/B of the same notes: laptop-model loss ≤ 1.5 LU (3.9–5.3 today); S/M −9…−16 dB, mono fold loss ≤ 1 LU; night 2–5 kHz share ≤ day − 4 dB; ≤ 4 nodes per note; bakes within S8.

### 6.2 The tune on top; working bands you can hear
**Owner:** voicing tables, songbook band definitions · **Size:** S–M · **IDs:** MUSL-2, MUSL-3, MUS-8
**Hear:** the melody is the loudest voice (the bass is 4.1–5.2 LU louder today); a busier village brings in a new player — lute, then marimba, then brushes — instead of an arpeggio 19 LU under the lead.
**Accept:** stems re lead: bass −3.5 ± 1.5, counter −6 ± 2, engine −8 ± 2, percussion −14 ± 3, every admitted layer ≥ −15 LU; each working band differs from the one below by ≥ 30 % more onsets or ≥ 3 dB in some octave band (MUSL-3, HAR-11), in every piece, day and night, in both voicings.

### 6.3 Night voicing
**Owner:** voicing tables, `bgm/BgmPlayer.js:272-277,311-336` · **Size:** S · **IDs:** MUSL-4
**Hear:** a music box at speaking height and a harp that rings out, replacing hard-stopped pad chords and the buzzy pulse lead.
**Accept:** the night lead sounds ≤ A5; no pad stops above −60 dB; night 2–5 kHz share ≈ 6 dB under the shipped night band; the night occasion ≤ bed + 3 LU and, with 4.4, the clear-night program ≤ the Village session and ≥ 4 dB darker than noon in 2–5 kHz.

### 6.4 The signature motif and the new themes
**Owner:** new `audio/Motifs.js`, `bgm/BgmSongbook.js:15-26,28-245`, `bgm/BgmPlayer.js:17,152-194` · **Size:** M · **IDs:** MUS-4 (restricted), MUS-5 · **Decision:** D9
**Spec:** the motif chosen in D9 is quoted by the arrival, the aurora, the hour phrase and the fragments; it never touches the signal stratum. MUS-5's *The Painted Isle* (day) and *Lanternlight* (3/4 night waltz) join the repertoire as notated (validated in-kernel: no parallels; ranges and densities in MUS-5); *Hearthfire* stays in rotation. The rule "every theme quotes the Isle call" applies only if D9 picks the Isle call. No music voice plays a quick same-pitch strike pair on a bell (S1).

### 6.5 Phrase grammar, voice-leading and the score analyzer
**Owner:** `bgm/BgmSongbook.js`, the sequencer, new `scripts/audio/score-analyzer.mjs` (pure, unit-tested) · **Size:** M · **IDs:** MUS-6, MUS-12, MUS-18, MUS-14
**Hear:** a theme whose first pass is canonical and then varies cell by cell — no exact 16-bar repeat within an hour (every 30–60 s today); a comp that moves by nearest inversion (≈ 3 semitones per chord change instead of ≈ 10).
**Accept:** the analyzer finds 0 melody–bass parallel fifths or octaves and 0 % routine-cue clash; no identical 16-bar rendition within 60 min in a seeded 8-hour run; tonal and phrase re-hearing computed over music-on windows only ≤ 10 % over 60 min; motif statements ≤ 6 per hour.

### 6.6 The occasion clock: music as an event in Village
**Owner:** new `audio/OccasionClock.js` (pure), the sequencer's Village path, `AudioDirector.js:594-597` · **Size:** M · **IDs:** SCN-3, SOTA-4, MUSL-7, MUS-7 · **Decision:** D1 · **After:** 2.5 and 4.1 (AMB: cutting melody before the sea ships exposes the bare bed)
**Hear:** a tune means *dawn*, *noon*, *dusk*, *night*, *something shipped*, or *you're back*; between them, 2–4 bar busker phrases drawn from the maintainer's own pieces; nothing in rain, while resting, or over a long wait — so music itself becomes a peripheral all-clear.
**Spec:** occasions per SCN-3 (one full occasion per phase, deferred rather than dropped; e.g. MUSL's 68.5 s Millbrook dawn occasion that builds from whistle over harp to the full band); fragments are closed 2–4 bar cells cut from the maintainer's own pieces (MUSL round 2 rendered eight, six from Willowbrook, Millbrook and Hearthfire) on a darkened harp; D1 constants; the welcome fragment at most once per calendar day; the first-ever enable per profile gets one full occasion. Deleted: `setRestScale` and the song/9–22 s rest loop.
**Accept:** a seeded simulation of the working day (09:00–18:00, busy): music duty within D1's band, computed from the actual constants; zero music frames while resting, raining, or with a wait ≥ 6 min; every song start carries a reason in the snapshot; Village music ≤ bed + 3 LU.

### 6.7 Town band as lived: rotation, breaths, the waiting cadence
**Owner:** the sequencer's Town band path, `BgmDirector.js:26-67,145-179` · **Size:** M · **IDs:** SCN-7, MUS-7, MUS-9
**Hear:** a town band that plays throughout, rotates without déjà-vu, sometimes pauses for an interlude, "hangs" on a deceptive cadence while a question is open, and lands home when it is answered.
**Spec:** loops per visit 2; no piece restarts < 6 min after it ended once the day set has ≥ 4 pieces (< 4: 4 min); interludes are MUS-6 cell variations at 40–50 % density (Town band has no world layers to fall back on); expected interlude share stated from the constants (target ≤ 15 %); a true 1.4 s breath before the next pickup. **Waiting cadence (MUS-9):** while any actionable agent exists, each phrase end turns deceptive (V→vi, e.g. A→F♯m at Willowbrook bar 8) with only the bass and chord changing; when the wait is answered, the next cadence lands home (MUSL round 2 `v2-wait-willowbrook-isle`). Whether listeners hear the deceptive cadence as "someone is waiting" is unproven: it joins the listener battery's T5 in Town band.
**Accept:** 60-min Town band session: no early return; ≥ 1 breath or interlude per 10 min; music duty ≥ 85 %; tonal re-heard ≤ 25 % (34.5 % in 10 min today); ≤ 12 loops per piece per hour; needs-you within its S2 over-music window; LUFS-I −31 ± 1.

### 6.8 Stingers, endings and the arrangement score
**Owner:** the sequencer, `audio/DayArc.js` · **Size:** M · **IDs:** MUS-11, MUSL-8
**Spec:** proper piece exits; a night-fall tag; the release occasion follows the gold peal on the next bar. Time of day is coloured by **instrumentation and register at the eight grade keyframes** (an instrument change moves the 2–5 kHz share 5.2 dB; a key change A→F moves it 1.2 dB). MUS-10's daily key score is deferred.

### 6.9 Town band carries the village (D4)
**Owner:** the sequencer's Town band path, `audio/music/Voicings.js`, `BgmDirector.js`, `WorkshopModel.js` (read-only consumer), `docs/design-decisions.md:142-148` · **Size:** M · **IDs:** SIG-16, MUS-16 · **Decision:** D4
**Hear:** the band's percussion is the village at work — a quiet editing session is a sparse brushed backbeat, a busy one a full groove, nobody working no drums; rain and snow re-dress the same tunes (softer attacks, sleigh-bell or rain-stick colour) instead of silencing them.
**Spec:** per building, one Isle Band percussion voice (brush, shaker, low tom, rim) plays on authored 16-step weight rows per theme, admitted when `rand < density_b × pattern_b[step]` (seeded), quantized to the song grid, only in the working band the count already selects; section `rest` forces silence. Weather/season arrangements are compile-time voicing variants applied at chunk boundaries from the atmosphere snapshot. The work stratum stays off in Town band.
**Accept:** 10-minute Town band busy sim: percussion onsets per bar correlate (Spearman ≥ 0.7) with total workshop density; zero percussion when `working === 0`; percussion stem within the MUSL-2 balance (−14 ± 3 LU re lead); a rain fixture switches arrangement at the next chunk boundary; design-decisions entry updated.

## Wave 7 — The front door (UX)

Exact copy for every control: `ux-controls.md`. **Order:** 7.1, 7.5 and 7.6 can start after Wave 0; 7.2 after 3.3; 7.3 and 7.4 after 6.6 and 5.1; 7.7 after 1.3 and 4.2; 7.8 after 5.1.

### 7.1 One fixed-width sound control and a SOUND popover
**Owner:** `index.html:79-83,95-97`, `TopBar.js:643-775`, `AmbientAudioController.js:8-12,22-25,140-146,188-191,511-573`, `BgmDirector.js:46-60`, `topbar.css:172-218,289-311,597-634`, `DashboardRenderer.js:455`, `ActivityPanel.js:321`, `shared/README.md:12`, `scripts/tests/cue-score.test.mjs:155-158` · **Size:** M · **IDs:** UX-2
**Why:** turning sound on today moves the icon cluster 349 px and collapses the KPI centre from 381 to **36 px** at 1280, and duplicates the Working/Waiting counts. The note + chevron group is a constant 44 px; the popover holds the presets, volume, now-playing, the preview bell, the mix, the D5 offer and a link to SET. **The first-ever click opens the popover's presets instead of auto-picking one.** Deleted: `#topbarSoundMode`, `#topbarSoundSection`, `#topbarSoundVolume`, `workingSectionLabel`/`workingSectionCounts`, `snapshot().section.label`, the section-label code in the controller, `.topbar__sound-section`.
**Accept:** the toggle shifts 0 px across off → on → open at 1280 and 1440; `.topbar__center` never overflows in any sound state, including three attention buckets; the render smoke gains sound-state steps with screenshots.

### 7.2 Presets: Off · Signals · Village · Town band
**Owner:** `AmbientAudioController.js:15-20,69-84,163,239-260`, `TopBar.js:102-118`, `AudioDirector.js:156-174,455-470` (`profile: 'signals'`), `SettingsPanel.js:231-234` · **Size:** M · **IDs:** UX-3
**Hear:** *Signals* is silence until an agent needs you, errors or hits a limit — then a clear call, the ladder, and a soft strike when it is answered.
**Spec:** storage keeps its format; `claudeville.sound.mode ∈ signals | ambient | bgm` (internal ids never shown). The signals profile creates no layers and no held note; other kinds caption via `announceOnly`; the Signals-only `answered` strike (round 2 recipe: one hand-damped A4 strike at L2 level, valid only while Signals plays no outcomes) marks the end of a wait. One signal-route owner. The Village preset's copy follows D1 — for example `Sea, weather and the village at work, with a tune at its moments` — never promising continuous songs.
**Accept:** in Signals, RMS < −80 dBFS between cues in a busy sim (with or without an open wait); the needs-you call ≥ 20 dB above that floor; an arrival captions with no RMS rise.

### 7.3 An honest chip and a now-playing line
**Owner:** `AmbientAudioController.js:511-548`, `topbar.css:556-568`, the sequencer (`audio:now-playing` on change only) · **Size:** S · **IDs:** UX-7
**Spec:** `data-sound-state ∈ off | armed | playing | resting | hushed`, static glyph states; `Now · Willowbrook`, `Resting · sound returns when work starts`, the next occasion in Village; no DOM writes while closed and unchanged.

### 7.4 The village awakens
**Owner:** `AmbientAudioController.js:262-298`, `AudioDirector.js:156-174`, `OccasionClock.js`, `cues/CueKit.js` (`awaken`, outside the budgets) · **Size:** M · **IDs:** UX-5, SCN-8
**Hear:** within 150 ms a latch and two small bells, then the island opens in three seconds — world, then work, then the welcome — instead of a 10-second fade-up into "did it work?". The first real urgent cue after any enable carries a one-time caption line naming its family ("That call means an agent needs you").
**Accept:** first onset ≤ 150 ms after the click, including the worklet load; short-term within 3 dB of steady by 4 s (~10 s today); awakening M-max ≤ needs-you M-max − 12 LU; once per page session.

### 7.5 Invite at the moment of need
**Owner:** `Toast.js:178-202`, `TopBar.js`, key `claudeville.sound.invited` · **Size:** S–M · **IDs:** UX-6
**Spec:** the first `attention:raised` of a session with sound off (page open ≥ 2 min, visible) adds `Want a bell for moments like this?` with `TURN ON SIGNALS` · `NO THANKS`, once per profile; accepting plays the call of the bucket that triggered it.

### 7.6 Keyboard and ARIA
**Owner:** `IsometricRenderer.js:2999-3002` (Tab no longer taken from the top bar), `TopBar.js`, the popover · **Size:** S · **IDs:** UX-9
**Spec:** `M` toggles sound from anywhere; presets are a real radiogroup; sliders carry `aria-valuetext`.

### 7.7 Output, tone, hush and softer sounds
**Owner:** `AudioEngine.js` (mono downmix with measured fold compensation, pan scale, tone shelf), `CueKit.js`, `SettingsPanel.js`, `AmbientAudioController.js` · **Size:** S–M · **IDs:** UX-10, SOTA-14 (tone control), UX-11, UX-14
**Spec:** *Speakers · Headphones · Mono* (Mono downmixes with compensation; Headphones narrows the world bed to ICC ≥ 0.4); *Warm ↔ Bright* (±4 dB shelf at 3 kHz on world + music); `HUSH FOR 1 HOUR` and optional quiet hours drop to Signals; *Soften sudden sounds* follows Reduce motion by default (slower thunder attack, 25 ms bell attacks, 30 % shallower ducks; the needs-you call stays whole).

### 7.8 A SOUND section in SET, words from the island, a volume per preset
**Owner:** `SettingsPanel.js`, `TopBar.js:673-676` · **Size:** S · **IDs:** UX-15, UX-16, UX-18
**Spec:** the mix shows only the trims that affect the current preset, named for what you hear (*Weather & sea*, *Wildlife*, *Workshops*, *Band*); each preset keeps its own volume step.

---

## Verification matrix

| Wave | Automated gate (local) | Evidence for the maintainer |
|---|---|---|
| 0 | `audio:probe` (realtime): envelope lint, must-never 2, 4, 5, 6; `browser-lifecycle.mjs` on the real TopBar path with `--autoplay-policy=user-gesture-required` and `--count=250`; unit tests for bucket routing, ceremony supersession, fader law | the UX journey table re-measured |
| 1 | virtual-clock probe: S2 scene targets, lane windows (1.3's interim floors), band rule, GR limits, limiter burst and response, migration fixtures, must-never 12; `r2-08`, `r3-settings`, `w3-f` rewritten | a MIX-only pair (shipped voices through the new master) at matched and true level |
| 2 | Transport lateness/underruns and the hidden-resume burst check, air T60 and D/R, noise autocorrelation/ICC/mono, bake memory, `world:benchmark-fps` sound on vs off, `browser-lifecycle.mjs --count=250` | impulse through the air; near vs far arrival |
| 3 | discrimination matrix across all voices, ladder fake-clock sims (sound off, hidden), cluster level, outcome fixtures incl. Dashboard, caption parity per setting, must-never 3 and 13 (cluster, stale); unit tests for `UrgencyLadder`, role resolver, duck windows | reel v2 `wait-arc`, new cue gallery; the **listener battery** |
| 4 | world scene map vs A, bit-identity at 0 vs 12 agents, C-AMB-3, onset budget, CPU on a quiet host, must-never 7 and 8 | reel v2 `night-storm`, day/night environment A/Bs |
| 5 | work audibility per building, liveness, budgets, stale/link silence, AV sync (HAR-12) | Forge pilot: a **full working-day maintainer soak** (log what got turned down or off) before D8 |
| 6 | score analyzer, stem gate, OccasionClock and Town band day simulations, SCN-9 soak, must-never 9 and 10 | reel v2 `dusk-occasion`, `town-band`, `d1-duty`; a full working-day soak in each preset plus an 8-hour virtual-clock render |
| 7 | render smoke with sound-state steps at 1280/1440, keyboard walk, caption probe | chip states and popover captures |
| All | `npm run validate:quick`; `npm run verify:architecture` when docs move; `CHANGELOG.md` per release | — |

**Tests that change with their owning item** (rewrite to the new contract, or delete where they pin incidental behaviour): `r1-03.cue-dedupe` (0.3, 1.6), `r1-19.cue-captions:75-76` (0.3, 3.6, 3.8), `r2-03.spatial-audio:84-100,154-158,176-183` (2.4, 3.5, 1.6), `r2-08.audio-mixer` (0.7, 1.2), `r3-settings.panel` (1.2, 3.8, 0.2), `w3-f.audio-priority:38-49,63-70` (3.3, 1.3), `w5-b.ui-fixes:114-190` (1.6), `cue-score:23,26-30` (3.5, 3.2) and `:155-158` (7.1), `browser-lifecycle.mjs:395-466,1216-1232` (0.1, 0.2, 2.1). New unit tests only for pure modules (`UrgencyLadder`, `OccasionClock`, `SpatialField`, `MusicClock`, duck-window math, role resolver, score analyzer, migration); everything audible is gated by the probe, not by source-text tests.

**Docs that move with the code:** `claudeville/src/presentation/shared/README.md` (audio rows), `docs/design-decisions.md` (captions from boot and the caption setting; the held note and waiting cadence; workshops as density; the D3, D4 and D8 outcomes), `docs/troubleshooting.md` (sound does not come back), `scripts/tests/README.md` and `scripts/smoke/README.md` (the probe, as a local gate).

## Deferred

| Item | Why deferred |
|---|---|
| MUS-10 daily key score | Instrument and register do more of the colour (6.8); revisit after 6.1. |
| SOTA-17 seasonal instruments and a weekly band night | After 6.1 exists to vary. |
| SOTA-19 static HRTF for cue voices | Needs 7.7 and a listening pass; stereo + air carries "where" on speakers. |
| SIG-17 crossed hammers | Polish on top of 5.4. |
| ENG-18 worklet chip sequencer | Only if 2.1 shows underruns on the maintainer's machine. |
| CUE-8 baked cue strikes | The node path has no measured cost problem (ENG); optional within S8. |

## Rejected

- **Recorded or CC0 sample packs, recorded IRs.** They break the stated audio identity and add codec risk (Ogg Opus fails `decodeAudioData` in Safari) and repetition; physical models plus runtime baking reach the needed quality (SOTA samples table).
- **Tone.js or any audio library.** A runtime dependency.
- **A program glue compressor or a master AGC.** Measured to hold constant reduction in weather and to eat cue margins; pumps against the ducks.
- **Urgency by loudness beyond the ceiling.** Escalation is repetition, register (a horn under a carrier) and duck depth.
- **One sound per tool call; `tool:invoked` straight into audio.** Killed by the council plan; World-only and walking-dependent (0 events in 60 s of Dashboard).
- **Drawn-downbeats-only work foley (SOTA-6 literal).** Rendered: a false stall 6.9 s early and a 2 s poll lurch.
- **A needs-you figure built from MUS-4's 5→9, or the first door chime; a separate "answered" cue outside Signals.** 5→9 failed the discrimination matrix; the door chime was a household doorbell and shared its openings with the hour phrase and *Lanternlight*; outside Signals the end of a wait is carried by the held note's resolution or the landed cadence.
- **Live replacement of `ConvolverNode.buffer`.** It glitches; phase changes crossfade two convolvers (S5).
- **HRTF for everything, or moving 3D panners.** 6.2–6.7 % of a core for moving sources, and a headphone-only benefit.
- **Speech synthesis ("Aurora needs you").** Intrusive; it duplicates captions.
- **Pitch-mapped counts, per-agent drones, sonified cost or tokens.** Sound cannot state a count; counts have exact visual homes.
- **Agent state steering weather, sea or birds.** An art-plan rule; dishonest.
- **Sound on by default.** Opt-in is a product rule; 7.5 invites at the moment of need instead.
- **Provider signature intervals on arrival (MUS-20).** Interval is reserved for meaning; "Codex arrived" as a rising fifth would equal "recovered".
- **A legacy audio flag kept after cutover.** The Chip voicing keeps the shipped band's sound; the reel keeps the A/B; everything else is a clean cutover.
- **Brain.fm-style AM "focus" mode, a cathedral reverb for mood, quarter-hour chimes, LLM-generated music, analyser-driven visuals, per-agent reminders, voice pooling for performance, pre-rendering whole BGM pieces.** Reasons in the source notes' *Rejected ideas* sections.

## Evidence index (local-only)

All under `output/claudeville-opus55-audio/`.

| Note | Territory | Listen first |
|---|---|---|
| `reel/README-v2.md` | **the audition reel v2: pairs at this plan's constants, with a gate table** | `renders/reel/v2/reel-all-v2.wav` |
| `reel/README.md` | reel v1 (superseded constants; kept for the record) | `renders/reel/reel-all.wav` |
| `plan-constants-v2.md` | the constants the second evidence round rendered against | — |
| `har-harness.md`, `tools/README.md`, `renders/INDEX.md` | the listening harness and the 101-render baseline | `renders/baseline/cues/cue-gallery.wav` |
| `eng-engine.md` | engine, clock, master, lifecycle | — |
| `sig-sonification.md` | signal inventory (35 signals, 9 audible), ladder, workshops, spatial | — |
| `ux-controls.md` | the measured journey, controls, copy | `ux-shots/` |
| `sota-outside-ear.md` | references → technique → application; sonic palette P-1 | — |
| `mus-composition.md` | transcriptions, repetition per hour, notated new themes | — |
| `mix-mastering.md` | level map, target table, master and cue room | `renders/mix-proto/v2final/bgm/bgm-willowbrook-summons-arrival.wav` |
| `cue-design.md` (incl. §Round 2) | discrimination matrix, the palette, the needs-you figure | `renders/cue-proto/v2/` |
| `amb-environment.md` | the sea, air, noise, thunder, birds, crickets, budgets | `renders/amb-proto/snippets/amb-night-clear-new.wav` |
| `fol-workshop-voices.md` (incl. §Round 2) | workshop model, material palette, in-context beds | `renders/fol-proto/v3/` |
| `musl-music-listening.md` (incl. §Round 2) | the Isle Band, Chip restored, stem balance, the waiting cadence | `renders/musl-proto/v2/` |
| `scn-soundtrack.md` | two 10-minute sessions, the listening day, the must-never list | `renders/scn-proto/snippets/scn-storyboard-after-90s.wav` |

## Execution record

### Wave 0 — shipped

- **Items:** 0.1–0.8a, by five parallel Opus 5.5 agents (lifecycle, engine, cue routing, layers and music, probe).
- **Notable choices:** dusk keeps every voice at its written register (tempo only); the melody sits above the comp ≈ 92 % of dusk melody time across the book (Hearthfire alone ≈ 84 %: its written E4 doubles the A chord's top voice — a songbook fix for 6.5). MUSL-2 stem gains are arithmetic estimates from stored stems (bass 0.055 → 0.022, counter 0.027, arp 0.051, pad 0.007) pending 0.8b's stem gate. Night pads stop at 7τ (60.8 dB down). New module `audio/ActionableRouting.js` owns bucket routing and the per-agent dedupe for both directors.
- **Verification:** `validate:quick` (934 tests) green; `verify:render` green; `npm run audio:probe` all PASS (routing 6/6, away: hidden +31.5 LU and signals-only blur +32.1 LU, resume ≤ 123 ms, one council for team-gather, envelope lint 0 hazards incl. crickets and BGM→ambient switch; busy day −46.6 LUFS-I, gaps 0). `browser-lifecycle.mjs`: every audio check passes; the run then fails at the activity-panel teardown assertion (`destroyed: null`, the lazily created panel was never instantiated), which is unrelated to audio and reproduces on an untouched HEAD copy.
- **Pending maintainer:** none for this wave.
