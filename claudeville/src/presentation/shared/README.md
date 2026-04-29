# Shared Presentation Components

This directory contains UI components used by both World and Dashboard mode. Components communicate through the global `eventBus` and should avoid importing renderer-specific modules.

Desktop-only constraint: shared UI only needs to support browser widths of 1280px or wider. Keep validation and layout decisions scoped to desktop; do not add mobile breakpoints or responsive shrinking here.

## File Map

| File | Responsibility |
| --- | --- |
| `TopBar.js` | Global status, usage display, mode/settings affordances. |
| `Sidebar.js` | Agent list and sidebar-driven `agent:selected` events. |
| `ActivityPanel.js` | Right-side 320px detail panel for the selected agent. |
| `SessionDetailsService.js` | Shared `/api/session-detail` and `/api/session-details` fetch dedupe, cache, stale fallback, and timeout handling. |
| `ModelVisualIdentity.js` | Provider/model/effort labels, sprite IDs, palette keys, colors, and minimap accents. |
| `RepoColor.js` | Deterministic project/repository color assignment. |
| `TeamColor.js` | Deterministic team color assignment. |
| `Modal.js` | Shared modal primitive. |
| `Toast.js` | Shared toast primitive. |

## Event Ownership

- `agent:selected` can be emitted by World mode, Dashboard cards, or Sidebar rows.
- `ActivityPanel` opens on `agent:selected`, refreshes its selected agent on matching `agent:updated`, and hides when that agent is removed.
- `ActivityPanel.hide()` emits `agent:deselected`; `App.js` bridges that event back to World mode so camera follow stops.
- Empty world clicks clear renderer selection/follow but do not close the panel. The panel remains open until its close button or selected-agent removal.
- `usage:updated` feeds shared status surfaces such as `TopBar`. `ws:connected` and `ws:disconnected` are currently consumed by application services.

## Session Detail Fetching

Use `sessionDetailsService.fetchSessionDetail(agent)` for one-agent surfaces or `sessionDetailsService.fetchSessionDetailsBatch(agents)` for card grids that need tools/messages/tokens. Do not add direct `/api/session-detail` or `/api/session-details` fetches in components.

Service behavior:

- Cache key: `provider::project::sessionId`.
- Fresh cache TTL: 5000ms.
- Stale cache TTL: 15000ms while a background refresh is started.
- Max entries: 128.
- Fetch timeout: 4000ms.
- Failed fetches return stale cached data when possible, otherwise `null`.

The server adapter registry also has short detail caches. Keep client polling intervals longer than the cache windows unless there is a clear reason to increase backend load.

## Model Visual Identity

`ModelVisualIdentity.js` maps provider/model/effort to user-facing labels, colors, sprite IDs, palette keys, and effort accessories. World mode, Dashboard mode, Activity Panel, and Minimap should all use this module instead of duplicating model parsing.

When adding a new model-specific sprite in `manifest.yaml`, add or update its identity mapping here and verify:

1. Dashboard card label/color.
2. Activity panel label/color.
3. World mode sprite selection and palette/accessory composition.
4. Minimap color.

## Validation

After shared component changes, test both modes because these components sit across mode boundaries:

1. Select an agent from World mode, Dashboard mode, and Sidebar if available.
2. Close the Activity Panel and confirm World mode follow clears.
3. Switch modes while the panel is open.
4. Confirm `/api/session-detail` and `/api/session-details` requests are not duplicated aggressively in the browser network panel.
