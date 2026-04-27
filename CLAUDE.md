# Claude Code Notes

`AGENTS.md` is the canonical agent-context file for this repo, mirrored byte-for-byte (after the heading) by `CLAUDE.md` so Claude Code's auto-loader sees the same content. When the two diverge, `AGENTS.md` wins; edit both together.

## Agent Harness Map

| Harness | Auto-loads | Notes |
| --- | --- | --- |
| Codex CLI | `AGENTS.md` (root) | Canonical. Also read `claudeville/CLAUDE.md` for in-app work. |
| Claude Code | `CLAUDE.md` (root) + nested `claudeville/CLAUDE.md` | Auto-walks the parent CLAUDE.md chain. |
| Other agents | Start at `AGENTS.md`, then `claudeville/CLAUDE.md`. | |

Treat `AGENTS.md`, `claudeville/CLAUDE.md`, and the per-area READMEs as ground truth before reading code.

## Scope

- Work from `/home/ahirice/Documents/git/claude-ville`.
- ClaudeVille is a local, zero-build dashboard for watching AI coding CLI sessions as a browser "village" plus an optional macOS menu bar widget.
- Touch only files needed for the task. Shared checkout: start with `git status --short`, preserve unrelated edits, prefer `rg`/`rg --files` for discovery.
- No install step, bundler, transpiler, lint, formatter, app test runner, or CI.

## Commands

- Start: `npm run dev` → `http://localhost:4000`
- Widget: `npm run widget:build`, then `npm run widget` (macOS only)
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
| macOS widget | `widget/` | `README.md` § macOS Menu Bar Widget |

## Agent Artifacts

Committed agent outputs go under `/agents/`:

- `/agents/plans/<slug>.md` — implementation plans
- `/agents/research/<slug>/` — research notes, proofs, image dumps
- `/agents/handover/<slug>.md` — handover memos

`docs/plans/` is gitignored personal scratch. `docs/superpowers/` holds artifacts emitted by the superpowers workflow plugin; treat as read-only history. `.claude/skills/` ships repo-specific skills (`verify-server`, `verify-architecture`, `verify-widget-build`, `troubleshooting`) usable from Claude Code.

## Workflow

- Multi-part work or explicit swarm requests → follow [`docs/swarm-orchestration-procedure.md`](docs/swarm-orchestration-procedure.md) (ownership, baselines, destructive-command and commit/push gates).
- Single-file / single-owner tasks → direct execution unless swarm is requested.

## Browser Automation

- **`playwright` MCP** — isolated Chromium with proper wait primitives. Use for design loops, screenshots, page-load reliability.
- **`claude-in-chrome`** — bridges to the user's real Chrome. Use for authenticated sessions or pages already open.

## Copy And Locale Policy

Use English for all new/edited UI copy, docs, comments, and agent-facing text. Do not add non-English strings unless the task explicitly requests localization.

## Validation

Match validation to what you changed:

| Change | Smoke check |
| --- | --- |
| `server.js`, `adapters/*.js`, `services/*.js` | `node --check <file>`; multiple: `find claudeville/adapters claudeville/services -name '*.js' -print0 \| xargs -0 -n1 node --check` |
| Runtime / API behavior | `npm run dev`; then `curl http://localhost:4000/api/{providers,sessions}` and confirm browser console |
| Anything under `src/` | Open `http://localhost:4000`, test World + Dashboard, resize, agent select/deselect |
| Sprite assets or `manifest.yaml` | `npm run sprites:validate`; for visuals, `sprites:capture-fresh` then `sprites:visual-diff` |
| `widget/` | `npm run widget:build`, then `npm run widget` (macOS only) |
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
