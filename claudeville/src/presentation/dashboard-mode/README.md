# Dashboard Mode

Dashboard mode is the compact DOM row view for scanning active sessions without the Canvas world. It is owned by `DashboardRenderer.js` and uses the same domain `World` data as World mode.

Desktop-only constraint: validate at browser widths of 1280px or wider. Do not add narrow-viewport behavior, mobile breakpoints, or responsive shrinking in this area. The one width query is the ultrawide layout at 2400px and above, which only widens.

## Responsibilities

| File | Responsibility |
| --- | --- |
| `DashboardRenderer.js` | Project grouping, the bell lane, row creation/reuse, active-mode detail polling, row click selection, child strips, and tool-history rendering. |
| `AvatarCanvas.js` | Static per-agent canvas portraits: `niche` (44×40 Dashboard row, the default: a 22×20 face window of the authored crop at exactly 2×), `nicheRoomy` (64×64 roomy Dashboard row: a 32×32 face window at 2×), `chip` (26×26 child strip, 1×), `hero` (96×96 call card and selected detail), and `sheet` (64×64 Activity Panel character sheet: a 32×32 top-anchored window of the authored crop at exactly 2×). The niche window sits three quarters of the way down the crop's spare height, so a tall hat gives way to eyes and hair; a character that crops badly carries an optional manifest `portraitFace: { x, y }` (the face centre, cell-local pixels of the composed south idle frame) and the window centres on it instead (today Astra and the DeepSeek hoods). `crisp` sizes blit the authored `portraitCrop` or generated `portrait` bust at an integer scale; a crop larger than its box draws at 1× and is clipped, never downscaled. Characters without portrait metadata keep the full-body avatar. Avatars can request the exact composited bitmap the World draws from `character-mode/Compositor.shared()` (un-rimmed) instead of re-loading raw sheet frames. |
| `ObservedCallTape.js` | The `LAST 10 MIN` tape: a browser-local ring of 40 × 15 s buckets per agent, fed by what this tab observed on `agent:added`/`agent:updated` in every mode, never backfilled. Each bucket counts calls that change things (`act`: write/run/task) and calls that look (`look`: read/search/other) and paints up to three stacked 3×3 blocks, act first (`#d9c9a3`) then look (`#8c7c64`), on a 160×16 canvas at a 4 px pitch: ink, never hue. An exception status the tab saw (needs you, error, quota) paints a 4×2 band under the baseline in its status token over exactly the buckets in which the status held (a span opens at the first observation and closes at the first observation of another status). Buckets that ended before observation began are one 1 px dot on the baseline, so a fresh tab reads as a dotted rule plus the calls it has seen. The class comes from `domain/services/ToolIdentity.toolCategory`, whose alias table (lower-cased, `functions.` prefix stripped) also covers the Codex, Gemini, Kimi and other providers' tool names (`apply_patch`, `exec_command`, `shell`, `ReadFile`, `web_search`, `update_plan`, the agent tools, …), so those paint as their real class instead of `other`. `paintSessionStrip` draws the same cells at exactly 3× (480×48) with fetched transcript calls as 1 px ticks (see Expanded detail). |
| `DashboardKeyboardNavigation.js` | Pure keyboard helpers: wrapping card traversal (`nextCardId`), focus recovery when a card disappears (`recoveryCardId`), the longest-waiting attention order (`attentionAgentIds`), and edit-target detection. |

## Lifecycle

- `App.js` loads `DashboardRenderer.js` and its stylesheet during boot, concurrently with the World renderer module, and constructs the renderer before boot reports ready, so a mode switch right after boot paints on the next frame.
- `ModeManager` emits `mode:changed`.
- `DashboardRenderer` sets `active = true` only for `dashboard`.
- Detail polling starts when Dashboard mode becomes active and stops when leaving Dashboard mode.
- `agent:added`, `agent:updated`, and `agent:removed` trigger re-render only while Dashboard mode is active. `ObservedCallTape` records calls and exception spans in every mode; row tapes (and the selected row's session strip) repaint on a 15 s bucket boundary, a tape change or a transcript fetch, only while Dashboard mode is active.

## Rendering Contract

The renderer groups agents by `agent.projectPath || '_unknown'`, creates one section per project, and reuses existing section/row DOM nodes across updates; a section node moves only when the project order changed (re-appending a node would cancel the transitions running inside it). After each render it removes rows and sections no longer represented in `world.agents`.

**Ultrawide columns.** At `min-width: 2400px` `#dashboardGrid` is a multicol block (`column-width: 1100px`, `column-gap: 16px`): project panels flow top-to-bottom, then left-to-right in `_sortProjectGroups` order, so the most urgent project stays top-left; each panel is `break-inside: avoid` and its header is static (sticky does not work inside multicol and nothing scrolls). The bell lane spans every column and lays its call cards two to a project column (`--dash-lane-cols`, set by `_syncUltrawide` from multicol's own count, `floor((W + 16) / 1116)`), so the lane's card edges meet the panels below. When the compact content fills < 60 % of the view, rows take the roomy tier (`dashboard__grid--roomy`: a 66 px row with a 64×64 `nicheRoomy` face) and leave it only past 88 %; the tier grows a row at most 1.43×, so it can never itself cause a scroll. `display: grid-lanes` is not used (unsupported in Chrome 153). Below 2400 px nothing changes: the grid stays one flex column, pixel-identical.

**Lane moves.** When bell-lane membership changes, the card that crosses between its row and the lane, the cards around it, and the sections below travel from their old places to their new ones (FLIP): translate only, never scaled, 240 ms `cubic-bezier(0.2, 0, 0, 1)`, with the crossing card above the section headers while it flies (`dash-card--flying`). A row nested in a moving section is offset by the difference, so the two translations compose to its true path; an interrupted flight restarts from where it was drawn. Within-section reorders use the same curve. Reduced motion (`_motionQuery`) or an inactive Dashboard cuts.

**Bell lane.** Waiting-on-user, errored, and rate-limited agents leave their project lists and become call cards in a lane at the top of `#dashboardGrid`: hero portrait, name, provider/model/role/project line, a shape glyph and the blocker in the status hue, the redacted `safePromptDetail` quote, a live elapsed clock, and provenance. The clock's plate carries the wait's age (`data-age` on the card, from the same elapsed time the numeral prints, updated on its 1 Hz tick): `1` (≥ 1 min) a 2 px rim in the spine colour, `2` (≥ 5 min) a filled spine-colour plate with `--bg-0` numerals; no animation. While the lane holds more than one card, an 8 px PS2P `ANSWER FIRST` sits under the clock of the card `A` focuses first (the longest-waiting by `SignalLedger.compareByWaitAge`, the order `AttentionService` uses). Quota cards add a 12-segment context gauge only when `contextWindowMax > 0`. The project header states `+N in Need Action ↑`, matching the lane heading `N NEED ACTION`; a project with no rows left is not rendered. Provenance reads in one order everywhere, `SOURCE · CERTAINTY[ · STALE]` (for example `HOOK · OBSERVED · STALE`). When a lane card is selected, its inline detail does not repeat the status and provenance lines the card already shows, and the request disclosure (`Full request`) appears only when the card's quote is truncated. Lane cards reuse the `.dash-card` element, so keyboard navigation runs from the lane into the rows. A failed push shows its `Push rejected` fact without promoting the status.

**Rows.** Each section has one column-header row (`AGENT / NOW / LAST 10 MIN / FOR / TOKENS / COST`); WORKING SET and CHILDREN columns appear only when a row in that section has data. `NOW` merges phase, blocker, and last message: an exception shows its blocker, a running tool shows the tool and its detail, otherwise the status word plus `· last: <message>` (or `· no tool running` for waiting). Rows sit flat on one section panel with hairlines, a static 44×40 portrait niche (a face at exactly 2×), a 160×16 observed-call tape, and a 5 px shape-coded status spine (solid working, dashed waiting, long-dash waiting-on-user, double rule rate-limited, notched errored); idle and aged rows dim only the portrait niche (62 %) and the name (`--ink-2`), so role, `FOR`, tokens, cost and badges stay at full strength. Estimates read `≈$…`, unavailable values `—`, partial token counts `±`, with one legend in the summary bar; the selected row has a static gold rim. Zero-count chips recede to `--ink-4`, and the heading reads `N NEED ACTION` or `ALL QUIET`. A child strip under a parent row lists its children with `↳`, portrait chip, role, `NOW`, project, and status; clicking selects the child.

Repo colour comes from `shared/RepoColor.js` (FNV-1a + fmix32 onto the C1 `PENNANT_PALETTE`, status-free, with the shared visible-repo registry resolving collisions); section headers carry a stepped pixel pennant on a flat tint, re-read on every header update because a repo can move to another pennant slot when sibling repos go live. The Dashboard ground is flat `--bg-0` at every hour: there is no time-of-day ambience tint or hearth glow. There are no walking avatars, per-row gradients, shadows, hover lift, or infinite halos.

Expanded detail shows:

- Agent avatar, name, role, provider badge, and model label.
- Normalized status (`active` becomes `working`).
- Current tool name/input, recent message, and fetched tool history (the newest 12 as a list).
- A session strip beside the hero (built when the row is first selected): the row's tape at exactly 3× (480×48) with every fetched `toolHistory` entry as a 1 px tick at its own timestamp on the same 10-minute axis (act ticks 8 px, look 5 px), hanging from a rail along the top that spans only what the fetched transcript covers (it is a contiguous tail, so nothing before its oldest call is claimed). A key labels the ticks `TRANSCRIPT` and the blocks `OBSERVED · this tab`; the count reads `N in 10 min` only when the fetched tail reaches past the window, else `last N fetched`. Only the selected agent is fetched.
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
