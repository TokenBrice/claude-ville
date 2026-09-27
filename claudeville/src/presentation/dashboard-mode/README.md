# Dashboard Mode

Dashboard mode is the compact DOM row view for scanning active sessions without the Canvas world. It is owned by `DashboardRenderer.js` and uses the same domain `World` data as World mode.

Desktop-only constraint: validate at browser widths of 1280px or wider. Do not add narrow-viewport behavior, mobile breakpoints, or responsive shrinking in this area.

## Responsibilities

| File | Responsibility |
| --- | --- |
| `DashboardRenderer.js` | Project grouping, the bell lane, row creation/reuse, active-mode detail polling, row click selection, child strips, and tool-history rendering. |
| `AvatarCanvas.js` | Static per-agent canvas portraits: `niche` (44×40 Dashboard row, the default), `chip` (26×26 child strip), `hero` (96×96 call card and selected detail), and `sheet` (64×64 Activity Panel character sheet: a 32×32 top-anchored window of the authored crop at exactly 2×). `crisp` sizes blit the authored `portraitCrop` or generated `portrait` bust at an integer scale; a crop larger than its box draws at 1× and is clipped, never downscaled. Characters without portrait metadata keep the full-body avatar. Avatars can request the exact composited bitmap the World draws from `character-mode/Compositor.shared()` (un-rimmed) instead of re-loading raw sheet frames. |
| `ObservedCallTape.js` | The `LAST 10 MIN` tape: a browser-local ring of 40 × 15 s buckets per agent, fed by tool-call transitions this tab observed on `agent:added`/`agent:updated` in every mode. Height encodes call class (tall for write/run/task, short for read/search/other) in the ink ramp, never hue. The class comes from `domain/services/ToolIdentity.toolCategory`, whose alias table (lower-cased, `functions.` prefix stripped) also covers the Codex, Gemini, Kimi and other providers' tool names (`apply_patch`, `exec_command`, `shell`, `ReadFile`, `web_search`, `update_plan`, the agent tools, …), so those paint as their real class instead of `other`; buckets that ended before observation began are hatched ("not observed"), never backfilled. |
| `DashboardKeyboardNavigation.js` | Pure keyboard helpers: wrapping card traversal (`nextCardId`), focus recovery when a card disappears (`recoveryCardId`), the longest-waiting attention order (`attentionAgentIds`), and edit-target detection. |

## Lifecycle

- `App.js` loads `DashboardRenderer.js` and its stylesheet during boot, concurrently with the World renderer module, and constructs the renderer before boot reports ready, so a mode switch right after boot paints on the next frame.
- `ModeManager` emits `mode:changed`.
- `DashboardRenderer` sets `active = true` only for `dashboard`.
- Detail polling starts when Dashboard mode becomes active and stops when leaving Dashboard mode.
- `agent:added`, `agent:updated`, and `agent:removed` trigger re-render only while Dashboard mode is active. `ObservedCallTape` records calls in every mode, and row tapes repaint on a 15 s bucket boundary only while Dashboard mode is active.

## Rendering Contract

The renderer groups agents by `agent.projectPath || '_unknown'`, creates one section per project, and reuses existing section/row DOM nodes across updates. After each render it removes rows and sections no longer represented in `world.agents`.

**Bell lane.** Waiting-on-user, errored, and rate-limited agents leave their project lists and become call cards in a lane at the top of `#dashboardGrid`: hero portrait, name, provider/model/role/project line, a shape glyph and the blocker in the status hue, the redacted `safePromptDetail` quote, a live elapsed clock, and provenance. Quota cards add a 12-segment context gauge only when `contextWindowMax > 0`. The project header states `+N in Need Action ↑`, matching the lane heading `N NEED ACTION`; a project with no rows left is not rendered. Provenance reads in one order everywhere, `SOURCE · CERTAINTY[ · STALE]` (for example `HOOK · OBSERVED · STALE`). When a lane card is selected, its inline detail does not repeat the status and provenance lines the card already shows, and the request disclosure (`Full request`) appears only when the card's quote is truncated. Lane cards reuse the `.dash-card` element, so keyboard navigation runs from the lane into the rows. A failed push shows its `Push rejected` fact without promoting the status.

**Rows.** Each section has one column-header row (`AGENT / NOW / LAST 10 MIN / FOR / TOKENS / COST`); WORKING SET and CHILDREN columns appear only when a row in that section has data. `NOW` merges phase, blocker, and last message: an exception shows its blocker, a running tool shows the tool and its detail, otherwise the status word plus `· last: <message>` (or `· no tool running` for waiting). Rows sit flat on one section panel with hairlines, a static 44×40 portrait niche, and a 5 px shape-coded status spine (solid working, dashed waiting, long-dash waiting-on-user, double rule rate-limited, notched errored); idle and aged rows dim only the portrait niche (62 %) and the name (`--ink-2`), so role, `FOR`, tokens, cost and badges stay at full strength. Estimates read `≈$…`, unavailable values `—`, partial token counts `±`, with one legend in the summary bar; the selected row has a static gold rim. Zero-count chips recede to `--ink-4`, and the heading reads `N NEED ACTION` or `ALL QUIET`. A child strip under a parent row lists its children with `↳`, portrait chip, role, `NOW`, project, and status; clicking selects the child.

Repo colour comes from `shared/RepoColor.js` (FNV-1a + fmix32 onto the C1 `PENNANT_PALETTE`, status-free, with the shared visible-repo registry resolving collisions); section headers carry a stepped pixel pennant on a flat tint, re-read on every header update because a repo can move to another pennant slot when sibling repos go live. The Dashboard ground is flat `--bg-0` at every hour: there is no time-of-day ambience tint or hearth glow. There are no walking avatars, per-row gradients, shadows, hover lift, or infinite halos.

Expanded detail shows:

- Agent avatar, name, role, provider badge, and model label.
- Normalized status (`active` becomes `working`).
- Current tool name/input, recent message, and fetched tool history.
- Model visual identity from `shared/ModelVisualIdentity.js`.
- Detail-fetch lifecycle states: a `data-loading` skeleton until the first detail result, an explicit "Session details unavailable" error when a fetch pass returns nothing and no history is cached, and a STALE badge when rendered detail data is older than the `SessionDetailsService` cache TTL.
- A hover-revealed copy button in the header copies the agent/session id to the clipboard and confirms via the shared `Toast` service (passed in by `App.js`).

Clicking a row emits `agent:selected`, the same event used by the sidebar and World mode. Dashboard expands detail inline and keeps the right Activity Panel hidden. Escape deselects the row.

## Keyboard Navigation

- Dashboard cards use roving focus: `Tab` enters the card collection once, and arrow keys move through cards in their current visual order.
- `Enter` or `Space` activates the focused card through its native button behavior. `Escape` emits `agent:deselected`, matching World mode.
- `A` uses the application-wide attention command and moves focus to the selected card. A standalone renderer falls back to the same longest-waiting, rotating order.
- Card focus and agent selection are separate. Cross-mode `agent:selected` events update the next Tab target without stealing focus; only an explicit Dashboard keyboard command moves focus.
- DOM card reuse preserves focus across status reordering. If the focused agent disappears, focus moves to the next card at that position, or the previous final card.
- The primary card button's gold `:focus-visible` outline in `dashboard.css` is the visible pixel/RPG focus treatment.

## Session Details

Dashboard detail fetches flow through `shared/SessionDetailsService.js`, not direct `fetch()` calls. Dashboard uses `fetchSessionDetailsBatch()` and the server's `POST /api/session-details` route for its active-card refresh path; singular detail fetches remain available for one-agent surfaces such as the Activity Panel. The service dedupes in-flight requests, caches fresh responses briefly, serves stale data while a background refresh is running, and times out slow fetches.

Tool inputs and messages use native keyboard-accessible disclosures. Unchanged disclosure nodes are reused across refreshes to preserve expansion, focus, and text selection. Cached detail displays its observation age; unavailable and partial usage stay distinct from observed zero. The DOM tool and district emblems use shared pixel SVGs, and avatar fitting preserves aspect ratio.

Use `SESSION_DETAIL_REFRESH_INTERVAL` from `src/config/constants.js` for Dashboard polling cadence. The candidate policy fetches only the selected agent; unselected rows use the live session payload. There is no card-visibility observer or layout scan. Do not add another independent timer without considering the Activity Panel and adapter-registry caches.

## Validation

After Dashboard changes:

1. Run `npm run verify:render` and retain its screenshots and console diagnostics.
2. On the operator-maintained `http://localhost:4000`, switch to Dashboard mode.
3. Confirm project sections, card click selection, and tool history render correctly.
4. Switch back to World mode and confirm detail polling stops causing visible updates or console noise.
