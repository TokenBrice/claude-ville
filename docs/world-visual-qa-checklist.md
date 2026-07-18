# World Visual QA Checklist

Use the maintained local server at `http://localhost:4000`.
World scenarios are deterministic fixtures for `?sim=1&scenario=<id>`.

## Baseline

- `no-agents`: map loads with stable building labels, idle harbor, no empty-state errors, and no console errors.
- `one-working-agent`: selected worker has readable name, current tool, route/trail, and completion state.
- `mixed-tools`: read, edit, bash, web, plan-mode, chat, retry, and subagent cues remain distinct without visual noise.

## Crowd And Relationships

- `dense-24-agents`: at least 20 agents remain selectable; dense labels do not cover building labels or each other excessively.
- `dense-100-agents`: stress scenario for label, trail, drawable-culling, and terrain-cache readability at high agent counts.
- `team-gather`: team members cluster around intended Command/Task Board areas with readable chat pairing.
- `parent-subagents`: parent/child agents are visually distinguishable; completed child cleanup leaves no stale label or marker.
- `building-inspection-replay`: Command building opens selected, replay is active, and selected-building route lines are more prominent than hover previews.

## Harbor And Git

- `git-harbor`: commit, push, fetch, and pull fixture events are available for harbor reducer and ship checks.
- `failed-push`: failed/rejected push state is visible at the harbor/watchtower and does not look like a successful departure.
- `release-parade`: harbor release ribbons and parade label appear from scenario metadata without requiring a real tag push.
- Harbor labels, dock tiles, ships, wakes, and building labels remain readable at desktop viewport widths.

## Director Incidents And Signals

- `waiting-on-user`: Command-side amber wait state appears as an input/attention scene and remains inspectable in the Activity Panel.
- `quota-rate-limit`: mine-side quota/rate-limit pressure creates a Director incident, building Signal rows, and a subtle work-weather nudge.
- Building hover should show a light signal/route preview; clicking the building should promote that to the full selected-building route treatment and Signal panel.
- Press `R` in any World scenario to toggle the last-minute replay badge and trails; `building-inspection-replay` starts with replay already enabled.

## Occlusion And Selection

- `selected-behind-building`: selected agent remains discoverable when partially hidden by a split building sprite.
- Selection ring, label, route/trail, and detail panel state agree after select/deselect.
- World to Dashboard toggle preserves agent identity and does not leave stale selected-agent visuals.

## Building Ground Integration

- Run `npm run world:validate-buildings` and confirm all nine types have valid grounding profiles.
- Run `npm run sprites:capture-baseline` and `npm run sprites:capture-fresh`; every named day/night closeup must assert its target near frame center before `npm run sprites:visual-diff`.
- Press `Shift+D`: cyan is the logical footprint, white is the sprite anchor/world center, magenta is the sprite canvas, yellow is `horizonY`, red is structural contact/shadow extent, and green is the entrance-to-contact line.
- At zoom 1 and 2, no land building shows a continuous raised lawn/stone perimeter or a renderer pad outside its site.
- Roads meet the physical threshold, stairs, rails, or posts. Terrain texture remains visible between sparse apron marks and reaches structure footings.
- Shadows begin under structural mass, not at the footprint edge. Harbor uses piling/water contacts; Lighthouse keeps a supported quay; Portal keeps a stair-connected dais.
- Hover and active-state marks communicate state without creating a platform at rest. Check idle and `mixed-tools`/active scenarios.
- Verify a selected agent both behind and in front of each split sprite after any `structureMask`, anchor, or `horizonY` change.
- Review clear day, fixed night, and reduced motion at integer zoom 1, 2, and 3 on a desktop viewport at least 1280px wide.

## Atmosphere And Motion

- Clear day: landmarks, terrain, roads, water edges, bridges, and docks have clear contrast.
- Night: building lights, lighthouse, water reflections, and labels stay legible without washing out agents.
- Fog/rain/storm: weather communicates state while preserving selected-agent, harbor, and building readability.
- `storm-night-reduced-motion`: reduced-motion metadata disables or freezes nonessential motion while keeping semantic state visible.

## Terrain Cache Scalability

- Run `npm run world:validate-terrain` and confirm the terrain cache plan reports chunk coverage for the current `MAP_SIZE`.
- Run `npm run world:validate-buildings` after building layout or visit-tile changes.
- In the debug overlay or console diagnostics, confirm terrain cache strategy is `single-surface` for the current 40x40 map. Console diagnostics are exposed at `window.__claudeVillePerf.canvasBudget().terrainCache`.
- Before increasing `MAP_SIZE`, confirm the single-surface estimate remains under the world cache budget or implement chunked terrain caches first.

## Sprite Refresh Audit

- Run `npm run sprites:audit-refresh` before any provider, building, ship, terrain, or atmosphere sprite refresh.
- Do not regenerate or replace sprite image assets until manifest ID audit and manifest validation are clean.
- Record contact-sheet or visual-diff evidence for any broad sprite refresh before merging asset changes.

## Regression Notes

- Check browser console after each scene.
- Keep viewport desktop-only, at least 1280px wide.
- Record any scene ID, viewport size, and observed failure with enough detail to reproduce.
