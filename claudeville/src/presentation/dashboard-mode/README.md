# Dashboard Mode

Dashboard mode is the DOM/card view for scanning active sessions without the Canvas world. It is owned by `DashboardRenderer.js` and uses the same domain `World` data as World mode.

## Responsibilities

| File | Responsibility |
| --- | --- |
| `DashboardRenderer.js` | Project grouping, card creation/reuse, active-mode detail polling, card click selection, and tool-history rendering. |
| `AvatarCanvas.js` | Small per-agent canvas avatar used inside dashboard cards. |

## Lifecycle

- `App.js` constructs `DashboardRenderer` after World mode is initialized.
- `ModeManager` emits `mode:changed`.
- `DashboardRenderer` sets `active = true` only for `dashboard`.
- Detail polling starts when Dashboard mode becomes active and stops when leaving Dashboard mode.
- `agent:added`, `agent:updated`, and `agent:removed` trigger re-render only while Dashboard mode is active.

## Rendering Contract

The renderer groups agents by `agent.projectPath || '_unknown'`, creates one section per project, and reuses existing section/card DOM nodes across updates. After each render it removes cards and sections no longer represented in `world.agents`.

Cards show:

- Agent avatar, name, role, provider badge, and model label.
- Normalized status (`active` becomes `working`).
- Current tool name/input, recent message, and fetched tool history.
- Model visual identity from `shared/ModelVisualIdentity.js`.

Clicking a card emits `agent:selected`, the same event used by the sidebar and World mode. The right activity panel owns deselection/close behavior.

## Session Details

Dashboard detail fetches flow through `shared/SessionDetailsService.js`, not direct `fetch()` calls. That service dedupes in-flight requests, caches fresh responses briefly, serves stale data while a background refresh is running, and times out slow fetches.

Use `SESSION_DETAIL_REFRESH_INTERVAL` from `src/config/constants.js` for Dashboard polling cadence. Do not add another independent timer without considering the Activity Panel and adapter-registry caches.

## Validation

After Dashboard changes:

1. Start `npm run dev`.
2. Open `http://localhost:4000` and switch to Dashboard mode.
3. Confirm project sections, card click selection, and tool history render correctly.
4. Switch back to World mode and confirm detail polling stops causing visible updates or console noise.
