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

## Harbor And Git

- `git-harbor`: commit, push, fetch, and pull fixture events are available for harbor reducer and ship checks.
- `failed-push`: failed/rejected push state is visible at the harbor/watchtower and does not look like a successful departure.
- Harbor labels, dock tiles, ships, wakes, and building labels remain readable at desktop viewport widths.

## Occlusion And Selection

- `selected-behind-building`: selected agent remains discoverable when partially hidden by a split building sprite.
- Selection ring, label, route/trail, and detail panel state agree after select/deselect.
- World to Dashboard toggle preserves agent identity and does not leave stale selected-agent visuals.

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
