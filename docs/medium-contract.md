# The Medium Contract

ClaudeVille is pixel art from one hand. Every layer — terrain, water, cliffs,
walls, props, foliage, weather, light and chrome — obeys these nine rules.
`npm run art:gate` checks the starred (★) ones; review checks the rest.

1. **One grid.** ★ Every authored edge sits on the 1×1 world-pixel lattice.
   Iso edges are 2:1 runs (two across, one down). No 2×1 texels, no resampled
   sprites, no anti-aliased strokes, no `createLinearGradient` /
   `createRadialGradient` / `arc` / `ellipse` in world or sky rendering.
2. **Stepped colour.** ★ Every texel is a stop of `ART_RAMPS` (artPalette.js),
   including generated ground, water, weather courses and cached grade stamps.
   Ramps run cool shadow → warm light. Ordered (Bayer) dither appears only at a
   seam between two courses, never as fill.
3. **The brightest-thing rule.** ★ Tier A (linear Y > 0.70, or S > 0.65 at
   high value) belongs to status marks, the selection ring and authored
   emitters at dusk/night — plus `snow` (M9). Status hues live in theme.js
   only. Grade-time warmth (golden faces, rim, alpenglow, window glint) stays
   under the receiver ceiling (encoded luma 0.74) and, in the warm hue band
   15°–60°, at S ≤ 0.50.
4. **Ink.** Objects ≥ 12 px tall carry the selective warm-black outline;
   smaller props get a 1-px dark contact. Nothing ≥ 24 px is un-inked.
5. **Mass.** No vertical stroke a villager could touch (post, lamp, pole) is
   thinner than 3 px; rigging and rope excepted.
6. **Units, not noise.** ★ Paving is stones (NW lit lip, SE shade lip, 1-px
   mortar, ≥ 3 sizes); grass is tufts on calm macro sweeps; edges are authored
   stamps along a distance contour. Grain density stays within ±30 % of the
   Tavern's (edge texels per 32×32 sample).
7. **Ground contact.** Every landmark stands on a bake-owned footing (dais,
   terrace, quay or rock); sprites never bake a generic slab. Every prop has a
   1-texel contact plus AO.
8. **Water contact.** ★ Water lies below the land: every non-beach bank shows
   a 4–10 px face. Every object in water has a 1–2 px foam collar, a wet-dark
   lower course and a reflection attached at its own waterline (contact gap ≤
   10 px) — or no reflection at all.
9. **Light by face, time by palette.** Daylight colours by surface facing
   (up, SW, SE, roof), never by albedo brightness alone. Extreme hours and
   seasons swap ramps (dormant turf, marcescent leaves, snow) rather than
   filtering. Night (22:00–04:30) belongs to the moonlit indigo key; nothing
   new may brighten or recolour it except authored light.

Irregularity: every procedural generator (walls, paving, cliffs, banks) adds
at least two kinds of local irregularity (size choice, patching, weathering by
face). A metronome is a defect.

## `art:gate` Checks for Starred (★) Rules

`art:gate` checks for the ★ rules:
- (1) grid: an off-lattice edge detector on sprite alpha, plus a source grep for gradient/arc calls;
- (2) every terrain-bake texel within ΔE_OK 0.02 of a ramp stop;
- (3) the analyzer's Tier-A share per asset;
- (6) a paving stone-id coverage ≥ 85 % from the bake's debug export;
- (8) bank-face coverage ≥ 90 % of non-beach contacts and zero detached mirror runs (a run whose top row is > 10 px from its source's contact).
