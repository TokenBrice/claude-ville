## Scope

- Work from `/home/ahirice/Documents/git/claude-ville`.
- ClaudeVille is a local, zero-build dashboard for watching AI coding CLI sessions as a browser "village" plus optional macOS and KDE widgets.
- Desktop-only target: assume browser viewports ≥1280px wide. Do not add `@media` queries, mobile/narrow-viewport testing, or responsive shrinking.
- Touch only files needed for the task. Shared checkout: start with `git status --short`, preserve unrelated edits, prefer `rg`/`rg --files` for discovery.
- No install step, bundler, transpiler, lint, formatter, app test runner, or CI.

Local dev-server (maintained): http://localhost:4000

## Commands

- Start: `npm run dev` → `http://localhost:4000`
- Widget: `npm run widget:build`, then `npm run widget` (macOS only); KDE checks use `npm run widget:kde:check`
- Run `npm install` only for dev scripts (sprite validation, visual diffs, Playwright capture).

## Project Map

| Area | Path | Onboarding doc |
| --- | --- | --- |
| Server / APIs / WebSocket | `claudeville/server.js` | [`claudeville/CLAUDE.md`](claudeville/CLAUDE.md) |
| Provider adapters | `claudeville/adapters/` | [`adapters/README.md`](claudeville/adapters/README.md) |
| Usage, quota, account | `claudeville/services/` | [`docs/design-decisions.md`](docs/design-decisions.md), [`docs/troubleshooting.md`](docs/troubleshooting.md) |
| Frontend boot | `claudeville/src/presentation/App.js` | [`claudeville/CLAUDE.md`](claudeville/CLAUDE.md) |
| World mode (canvas) | `claudeville/src/presentation/character-mode/` | [`character-mode/README.md`](claudeville/src/presentation/character-mode/README.md) |
| Dashboard mode (DOM) | `claudeville/src/presentation/dashboard-mode/` | [`dashboard-mode/README.md`](claudeville/src/presentation/dashboard-mode/README.md) |
| Shared UI | `claudeville/src/presentation/shared/` | [`shared/README.md`](claudeville/src/presentation/shared/README.md) |
| Domain / application / config / infra | `claudeville/src/{domain,application,config,infrastructure}/` | [`claudeville/CLAUDE.md`](claudeville/CLAUDE.md) |
| Sprite assets | `claudeville/assets/sprites/` | [`scripts/sprites/generate.md`](scripts/sprites/generate.md), [`docs/pixellab-reference.md`](docs/pixellab-reference.md) |
| Documentation | `docs/` | [`docs/README.md`](docs/README.md) |
| macOS widget | `widget/` | `README.md` § macOS Menu Bar Widget |
| KDE Plasma widget | `widget/kde/` | [`widget/kde/README.md`](widget/kde/README.md), `README.md` § KDE Plasma Widget |

## Agent Artifacts

Committed agent outputs go under `/agents/`:

- `/agents/plans/<slug>.md` — implementation plans
- `/agents/research/<slug>/` — research notes, proofs, image dumps
- `/agents/handover/<slug>.md` — handover memos

Before using or adding a retained artifact, check [`agents/README.md`](agents/README.md) for current policy and status. Do not treat deleted historical artifacts as implementation guidance.

## Workflow

- Multi-part work: identify owned paths, record a short plan when useful, and keep validation matched to touched files.
- Explicit swarm or handoff requests: coordinate ownership in the conversation, preserve independent baselines, and create `/agents/` artifacts only when they will remain useful after the task.
- Single-file / single-owner tasks: execute directly unless coordination is requested.

## Browser Verification

The operator runs a server on http://localhost:4000/ that can be used to verify output.

## Copy And Locale Policy

Use English for all new/edited UI copy, docs, comments, and agent-facing text. Do not add non-English strings unless the task explicitly requests localization.

## Validation

Match validation to what you changed:

| Change | Smoke check |
| --- | --- |
| `server.js`, `adapters/*.js`, `services/*.js` | `node --check <file>`; multiple: `find claudeville/adapters claudeville/services -name '*.js' -print0 \| xargs -0 -n1 node --check` |
| Broad non-runtime regression pass | `npm run validate:quick` |
| Adapter discovery or relationship state | `node scripts/smoke/adapters.mjs`; `NODE_NO_WARNINGS=1 node scripts/smoke/relationship.mjs` |
| Runtime / API behavior | `npm run dev`; then `curl http://localhost:4000/api/{providers,sessions}` and confirm browser console |
| Anything under `src/` | Open `http://localhost:4000`, test World + Dashboard, resize, agent select/deselect |
| Sprite assets or `manifest.yaml` | `npm run sprites:audit-refresh`; for visuals, `sprites:capture-fresh` then `sprites:visual-diff` |
| World building or terrain config | `npm run world:validate-buildings`; `npm run world:validate-terrain` |
| `widget/` | macOS: `npm run widget:build`, then `npm run widget:check` or `npm run widget:verify-bundle`, then `npm run widget`; KDE: `npm run widget:kde:check`, then `npm run widget:kde:install` when KDE is available |
| Root agent docs | parity must hold: `diff <(tail -n +3 CLAUDE.md) <(tail -n +3 AGENTS.md)` empty |
| Docs-only | diff review + `git status --short` |

First-hour failure modes: [`docs/troubleshooting.md`](docs/troubleshooting.md). Load-bearing constraints (port 4000, hand-written WebSocket, static pricing, polling cadence): [`docs/design-decisions.md`](docs/design-decisions.md).

## GitHub And Remotes

- `origin` → `https://github.com/TokenBrice/claude-ville.git` (fetch + push, working fork).
- `upstream` → `https://github.com/honorstudio/claude-ville.git` (fetch only).
- Do not change remotes, branches, or fork workflow unless explicitly asked.

## Git Hygiene

- Re-run `git status --short` before editing, before committing, and before final response.
- Preserve unrelated local modifications and untracked files. Do not revert, stage, commit, delete, or format files outside the task scope.
- Do not run destructive commands (`git reset --hard`, `git checkout --`, `git restore`, `git clean`, `rm -rf`, `git stash drop/clear`, bulk formatters, `kill`/`pkill`/`killall`, port-killing pipelines) without explicit approval.

## Changelog

`CHANGELOG.md` (project root) is displayed in-app when the user clicks the version chip. **Before pushing**, prepend a new entry and update the version wherever it appears.

**Entry format:**

| Tier | When | Header syntax |
| --- | --- | --- |
| Named release | New feature or meaningful addition | `## v0.X.Y — *Release Name* · Mon DD, YYYY` |
| Hotfix | Bug fix or tiny patch | `## v0.X.Y.Z · Mon DD, YYYY — Hotfix` |

**Versioning rules:**
- `0.X.0` — major milestone (new provider, new rendering system, large feature set)
- `0.X.Y` — named minor release (smaller feature, meaningful UX addition)
- `0.X.Y.Z` — hotfix (bug fix, one-liner patch, no new behaviour)

**Release names** should be short, evocative, and fit the medieval/RPG village theme (examples: *The Founding*, *Harbor Lights*, *Swift Roads*). Hotfixes get no name.

**Version locations to update:**
- `claudeville/index.html` — `.topbar__version` text (`v0.X`)
- `package.json` — `"version"` field (`0.X.Y`)

**GitHub release flow** (when asked to push a version):
1. Push `main`, then tag the release commit `v0.X.Y` and push the tag (`git tag v0.X.Y <commit> && git push origin v0.X.Y`).
2. Create the GitHub release on the tag: `gh release create v0.X.Y --title "v0.X.Y - Release Name" --notes-file <notes>`, where the notes are that version's `CHANGELOG.md` section verbatim.
3. When backfilling an older version, pass `--latest=false` so the newest version stays marked Latest. `--target` does not accept a raw SHA — push the tag first.
4. Every pushed version gets a matching tag + GitHub release; no gaps (v0.20.0 was once pushed without one).
