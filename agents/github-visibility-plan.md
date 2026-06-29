# ClaudeVille GitHub Visibility Plan

- **Status:** active
- **Prepared:** 2026-06-29
- **Scope:** GitHub discovery, repository trust signals, README conversion, contribution intake, release surface, and public media for `claude-ville`.
- **Primary repo observed:** `TokenBrice/claude-ville`
- **Upstream observed:** `honorstudio/claude-ville`
- **Safe to execute:** yes, phase by phase, after the canonical-repo and license decisions in Phase 0.

## Executive Summary

ClaudeVille has a strong product and a strong local documentation base, but GitHub currently cannot see that strength. The public surface reads like a maintainer-oriented local project, not a discoverable developer tool.

The highest-leverage work is not code. It is:

1. Pick and tune the canonical public repository.
2. Add missing trust files: `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, GitHub templates.
3. Rewrite the README top fold around the product promise: local, read-only, multi-provider AI coding CLI observability in an isometric pixel village.
4. Replace the fragile GitHub attachment screenshot with committed, optimized screenshots and a social preview asset.
5. Add GitHub topics, package metadata, releases/tags, and issue/PR intake.
6. Avoid CI/status-badge theater unless the current no-CI repo policy changes.

ClaudeVille's differentiator is unusually clear: most public projects in this niche sell "Claude Code dashboard/monitor"; ClaudeVille can own "watch all your local AI coding agents work in a living village" while still indexing for `Claude Code dashboard`, `Codex CLI monitor`, `AI coding agents dashboard`, and `local-first agent observability`.

## Current Baseline

### GitHub Repository State

Observed with `gh repo view` on 2026-06-29.

| Surface | `TokenBrice/claude-ville` | `honorstudio/claude-ville` | Visibility impact |
| --- | --- | --- | --- |
| Public visibility | public | public | Good. |
| Fork status | fork | canonical upstream | Fork banner can dilute trust and search/discovery. Decide which repo is canonical. |
| Stars / forks | 1 star / 0 forks | 13 stars / 7 forks | Upstream has more social proof but stale code. |
| Issues | disabled | enabled | Origin currently has no public intake path. |
| Discussions | disabled | disabled | No place for roadmap/support questions. |
| Topics | none | 16 topics | Origin is invisible to topic browsing. |
| License detected | none | none | GitHub cannot display an open-source license. |
| Latest release | none | none | No "Latest release" trust signal. |
| Security policy | none | none | Security tab is incomplete. |
| Custom social preview | none | none | Link previews are generic GitHub cards. |
| Community profile | not available via API for fork | 28%, README only | Missing standard community-health files. |

### Local Repository State

Observed locally on 2026-06-29.

- `README.md` is detailed and useful for maintainers, but the first screen is not optimized for conversion.
- `README.md` uses a GitHub user-attachment image with `alt="image"`, which is fragile and weak as product proof.
- `CHANGELOG.md` is unusually strong and should be used as a public trust signal.
- `PRODUCT.md` has the best positioning language, but the README does not fully use it.
- `package.json` has only `name`, `version`, `private`, `engines`, scripts, and dev dependencies. It lacks `description`, `license`, `repository`, `bugs`, `homepage`, `keywords`, and `author`.
- There is no root `LICENSE`, although `README.md` says `MIT`.
- There is no `.github/` directory.
- There are no tags.
- Existing visual assets are good but buried under `agents/research/claudeville-visual-upgrade/screenshots/`.
- Repo size is not catastrophic, but public media should be curated: `.git` is about 127 MB, `agents/research` about 29 MB, and runtime sprite assets about 4.7 MB.

### Pharos Watch Pattern

`../pharos-watch` does not contain a separate GitHub visibility plan. Its useful pattern is the public surface itself:

- README top fold has badges, crisp positioning, trust boundary, quick links, preview image, feature sections, docs map, setup, contributing, security, license.
- Media is checked into the repo, including an OG card.
- Community files exist: `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`.
- `.github/ISSUE_TEMPLATE/` has structured forms.
- `.github/pull_request_template.md` is short and practical.
- CI/security badges are present only because real workflows exist.

Do not copy Pharos's finance-specific trust language, heavy CI/deploy workflows, API/status/methodology links, or large docs-corpus model. ClaudeVille should borrow the shape, not the weight.

### Competitive Search Surface

Observed with GitHub search on 2026-06-29.

- `chiphuyen/sniffly`: "Claude Code dashboard" positioning, MIT license, homepage, 1,242 stars.
- `anthropics/claude-code-monitoring-guide`: 337 stars, guide rather than app.
- `onikan27/claude-code-monitor`: "Real-time dashboard for monitoring multiple Claude Code sessions", MIT, 237 stars.
- Many smaller repos use exact phrases like `claude-code-dashboard`, `claude-code-monitor`, `usage`, `costs`, `tokens`, and `sessions`.

ClaudeVille should index for the crowded exact phrases, but differentiate with:

- multi-provider support: Claude Code, Codex CLI, Gemini CLI, Kimi, OpenCode
- local-first and read-only provider log access
- zero-build Node server
- isometric pixel-art World mode plus dense Dashboard mode
- optional macOS and KDE widgets

## Phase 0 - Canonical Repo And License Decisions

These decisions should happen before cosmetic work because they affect every link, badge, and GitHub setting.

### 0.1 Choose The Canonical Public Repo

Recommended decision: make `TokenBrice/claude-ville` the canonical repo for current development unless upstream will be actively transferred or updated.

Rationale:

- `TokenBrice/claude-ville` has the current code and current release history.
- `honorstudio/claude-ville` has more stars, forks, and topics, but appears stale relative to the current checkout.
- Keeping the active public repo as a fork may reduce perceived authority. If GitHub visibility is a serious goal, consider one of:
  - transfer/rename the active repo into the desired canonical owner and make it non-fork if appropriate;
  - ask GitHub Support to detach the fork, if policy and ownership allow;
  - create a fresh canonical repo and push the full active history.

If the active repo remains a fork, be explicit in the README: "Active development lives here."

### 0.2 Resolve The License

Current README says MIT, but neither origin nor upstream has a detected license file.

Before adding a root `LICENSE`, confirm that the current maintainer has the right to license the current code under MIT, especially because the active repo is a fork. Once confirmed:

- add root `LICENSE` with MIT text;
- add `"license": "MIT"` to `package.json`;
- keep the README License section linked to `./LICENSE`;
- verify GitHub detects the license after push.

This is a P0 trust signal. Many developers will not use or contribute to an unlicensed public repository.

## Phase 1 - Repository Settings

These are GitHub settings, not file edits, but they directly affect discovery.

### 1.1 About Description

Replace the current description with a sharper, search-friendly version:

> Local-first dashboard for watching Claude Code, Codex CLI, Gemini, Kimi, and OpenCode sessions as an isometric pixel village plus monitoring dashboard.

Shorter alternative if GitHub truncates too aggressively:

> Local-first AI coding CLI dashboard: Claude Code, Codex, Gemini, Kimi, and OpenCode in an isometric pixel village.

### 1.2 Topics

GitHub supports repository topics for classification and discovery. Use the full 20-topic budget intentionally.

Recommended topics:

```text
ai-agents
ai-coding
agent-monitoring
coding-agents
claude-code
codex-cli
gemini-cli
kimi
opencode
local-first
developer-tools
dashboard
observability
websocket
canvas
pixel-art
vanilla-js
nodejs
macos
kde
```

If a topic does not normalize well on GitHub, replace it with `multi-agent`, `claude`, `anthropic`, or `visualization`.

### 1.3 Feature Toggles

Recommended settings for the canonical repo:

- Enable Issues.
- Enable Discussions after issue templates are in place.
- Disable Wiki unless someone commits to maintaining it. The repo already has docs and a docs index.
- Keep Projects only if there is an active project board.
- Enable private vulnerability reporting from the Security tab.
- Enable Dependabot alerts and secret scanning/push protection where available.
- Keep blank issues disabled once structured issue forms exist.

### 1.4 Social Preview

Upload a custom social preview in repository settings after creating the asset in Phase 3.

Target source file:

```text
docs/assets/github/claudeville-og-card.png
```

The card should show the product, not an abstract logo: World mode with a small overlay line such as "Watch your local AI coding agents work in a living village."

## Phase 2 - README Conversion Rewrite

The README should keep its useful maintainer detail, but the first screen should answer:

- What is this?
- Why should I care?
- Is it safe/local?
- What does it support?
- How do I run it?
- What does it look like?

### 2.1 Proposed README Top Fold

Recommended structure:

```markdown
# ClaudeVille

[badges]

Watch your local AI coding CLIs work in a living pixel village.

ClaudeVille is a local-first dashboard for Claude Code, Codex CLI, Gemini CLI,
Kimi, and OpenCode sessions. It reads provider logs read-only, runs on
localhost, and renders your active agents as either an isometric RPG village
or a dense monitoring dashboard.

[primary screenshot or 2-image gallery]

- Local and read-only: no hosted service, no telemetry, no provider-file writes.
- Multi-provider: Claude Code, Codex, Gemini, Kimi, OpenCode.
- Glanceable: World mode for second-monitor awareness; Dashboard mode for exact state.
- Zero-build runtime: Node HTTP/WebSocket server plus static browser assets.
- Desktop companion: optional macOS menu bar and KDE Plasma widgets.

Quick start...
```

### 2.2 Badges

Use badges only when they are true. Static badges are fine; workflow badges are not until workflows exist.

Recommended initial badges:

- `version-v0.18.1`
- `license-MIT` after root `LICENSE` is added
- `node-%3E%3D18`
- `runtime-zero--build`
- `local-first`
- `providers-5`

Avoid:

- CI badges until there is CI.
- "production ready" language.
- "mobile" language. The product is desktop-only by policy.

### 2.3 Product Language To Pull From `PRODUCT.md`

Use this positioning throughout the README:

- "local, read-only, second-monitor dashboard"
- "watch agents work"
- "a village worth leaving open"
- "glanceable ambient awareness"
- "World mode is the brand; Dashboard mode is the precise scanning view"

Keep the copy concrete. Avoid over-indexing on fantasy language before explaining the utility.

### 2.4 Search Terms To Include Naturally

Include these phrases in the README, package description, and section headings where they are truthful:

- Claude Code dashboard
- Claude Code monitor
- Codex CLI dashboard
- AI coding agents dashboard
- local AI agent observability
- multi-agent session monitor
- token usage and cost dashboard
- local-first developer tool

Do not keyword-stuff. One clear mention in the top third of the README is enough for most terms.

### 2.5 Trust Section

Add a short section near Quick Start:

```markdown
## Local And Read-Only

ClaudeVille runs on `localhost:4000` and reads supported CLI session stores
from your machine. It does not write provider session files, does not proxy
requests to a hosted service, and does not need a build step to run.
```

Mention limitations honestly:

- desktop browser target, 1280px and wider
- local provider data required
- optional widgets need macOS or KDE dependencies

### 2.6 Changelog And Version Signal

Move a `Current version: v0.18.1` line and `CHANGELOG.md` link near the top. The changelog is one of the repo's strongest trust signals.

## Phase 3 - Public Media And Social Preview

### 3.1 Create A Curated Media Folder

Recommended path:

```text
docs/assets/github/
```

Initial files:

```text
docs/assets/github/world-day.png
docs/assets/github/world-night.png
docs/assets/github/dashboard.png
docs/assets/github/activity-panel.png
docs/assets/github/claudeville-og-card.png
```

Use existing screenshots under `agents/research/claudeville-visual-upgrade/screenshots/` as source candidates, but recapture if they do not match current `main`.

### 3.2 README Gallery

Replace the GitHub attachment with repo-local media and meaningful alt text.

Example:

```markdown
![ClaudeVille World mode showing active AI coding agents moving through an isometric pixel village](./docs/assets/github/world-day.png)
```

Then add a compact gallery:

```markdown
| World mode | Dashboard mode |
| --- | --- |
| ![Night view of ClaudeVille with lit buildings and active agent status cues](./docs/assets/github/world-night.png) | ![ClaudeVille Dashboard mode grouping active sessions by project with provider badges and tool history](./docs/assets/github/dashboard.png) |
```

### 3.3 OG Card

Make one committed source image for GitHub's social preview. Requirements:

- show real World mode, not an abstract illustration;
- include the product name visibly;
- include one short promise line;
- keep text legible at small preview sizes;
- avoid private project names, paths, tokens, or usernames in screenshots.

### 3.4 Optional Short Demo

Only after the still images are done, capture a short GIF or video for a release/discussion post:

- 8-12 seconds;
- World mode movement, agent selection, Dashboard switch;
- no private session text;
- keep file size modest.

Do not make a heavy GIF a README blocker.

## Phase 4 - Metadata And Community Health Files

### 4.1 `package.json`

Add metadata even though `"private": true` remains appropriate.

Recommended fields:

```json
{
  "description": "Local-first dashboard for watching Claude Code, Codex CLI, Gemini, Kimi, and OpenCode sessions as an isometric pixel village and monitoring dashboard.",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/TokenBrice/claude-ville.git"
  },
  "bugs": {
    "url": "https://github.com/TokenBrice/claude-ville/issues"
  },
  "homepage": "https://github.com/TokenBrice/claude-ville#readme",
  "keywords": [
    "ai-agents",
    "claude-code",
    "codex-cli",
    "gemini-cli",
    "opencode",
    "local-first",
    "dashboard",
    "observability",
    "pixel-art",
    "websocket",
    "vanilla-js"
  ]
}
```

If the canonical repo changes, update URLs accordingly.

### 4.2 `CONTRIBUTING.md`

Keep it short. Good contribution lanes:

- provider adapter fixes and fixtures;
- documentation fixes;
- widget fixes;
- sprite/visual bug reports with screenshots;
- focused UI quality fixes;
- new provider proposals after discussion.

Important rules to include:

- read `AGENTS.md` first;
- preserve local-first/read-only behavior;
- no broad formatting sweeps;
- validation should match touched files;
- screenshots required for World/Dashboard UI changes.

### 4.3 `SECURITY.md`

Scope should fit ClaudeVille:

- local HTTP/WebSocket server;
- provider log parsing and path traversal risks;
- local file disclosure risks;
- widget bundle behavior;
- no public issues for vulnerabilities;
- use GitHub private vulnerability reporting when enabled.

Also state out of scope:

- upstream CLI behavior;
- fake provider logs requiring local machine access unless they expose a real parser bug;
- denial-of-service testing without coordination.

### 4.4 `SUPPORT.md`

Add if issues will be enabled. It should route users before they open issues:

- first-hour setup: `docs/troubleshooting.md`;
- supported provider paths: README provider section;
- macOS widget: `widget/README.md`;
- KDE widget: `widget/kde/README.md`;
- feature ideas: Discussions.

### 4.5 `CODE_OF_CONDUCT.md`

Optional but recommended if the repo will actively invite public contributors. This improves community profile completeness, but it is less urgent than license, security, contributing, and issue templates.

## Phase 5 - GitHub Intake

Create `.github/` with structured templates. This makes Issues useful instead of noisy.

### 5.1 Issue Forms

Recommended files:

```text
.github/ISSUE_TEMPLATE/config.yml
.github/ISSUE_TEMPLATE/bug_report.yml
.github/ISSUE_TEMPLATE/provider_support.yml
.github/ISSUE_TEMPLATE/widget_issue.yml
.github/ISSUE_TEMPLATE/world_visual_issue.yml
.github/ISSUE_TEMPLATE/docs_issue.yml
.github/ISSUE_TEMPLATE/feature_request.yml
```

Form intent:

- `bug_report.yml`: affected mode, expected/actual, reproduction, browser, console output.
- `provider_support.yml`: provider, OS, session path presence, redacted fixture sample if possible.
- `widget_issue.yml`: macOS or KDE, widget version, server URL, check command output.
- `world_visual_issue.yml`: screenshot, mode/scenario, browser zoom, motion/reduced-motion state.
- `docs_issue.yml`: stale or unclear docs.
- `feature_request.yml`: workflow, value, affected provider/mode, maintenance cost.

Set `blank_issues_enabled: false` once forms are in place.

### 5.2 Contact Links

After Discussions are enabled:

- "Feature ideas and roadmap" -> Discussions
- "Setup troubleshooting" -> `docs/troubleshooting.md`
- "Security reports" -> Security tab / private vulnerability reporting

### 5.3 PR Template

Create `.github/pull_request_template.md` with:

```markdown
## Summary

-

## Why

-

## Validation

- [ ] Focused checks run
- [ ] Docs updated or not needed
- [ ] Screenshots included for UI changes
- [ ] Changelog/version updated if this is release-bound

## Notes

Do not include provider logs, tokens, private paths, or screenshots with secrets.
```

### 5.4 Labels

Add labels that match issue forms and ownership:

- `area:server`
- `area:provider`
- `area:world`
- `area:dashboard`
- `area:widget-macos`
- `area:widget-kde`
- `area:sprites`
- `area:docs`
- `provider:claude`
- `provider:codex`
- `provider:gemini`
- `provider:kimi`
- `provider:opencode`
- `status:needs-repro`
- `status:needs-fixture`
- `good first issue`

Use labels sparingly. Labels help discovery only when issues are actually triaged.

## Phase 6 - Releases And Changelog Surface

The changelog is already good, but GitHub cannot see it as releases.

### 6.1 First Release

Create the first GitHub release from the current version after confirming `package.json`, `package-lock.json`, and `claudeville/index.html` are intentionally aligned:

- tag: `v0.18.1`
- title: `v0.18.1 - Steady Gaze`
- notes: the matching top entry from `CHANGELOG.md`

Commands after review:

```bash
git tag -a v0.18.1 -m "v0.18.1 - Steady Gaze"
git push origin v0.18.1
gh release create v0.18.1 --title "v0.18.1 - Steady Gaze" --notes-file /tmp/claudeville-v0.18.1-notes.md
```

Do not backfill every historical release immediately. Start with the latest, then optionally backfill major visual milestones like `v0.17.0`.

### 6.2 Release Template

Optional `.github/release.yml` or a docs snippet can standardize:

- user-facing summary;
- screenshots if UI changed;
- validation performed;
- known limitations;
- upgrade notes if provider paths or widget behavior changed.

### 6.3 Version Policy

Keep the current project policy:

- `package.json`: full semver
- `claudeville/index.html`: abbreviated topbar version
- `CHANGELOG.md`: full user-facing release entry

Add README "Current version" manually when release-bound changes ship.

## Phase 7 - Lightweight Trust Automation

Current repo instructions say no CI. Respect that.

### 7.1 Do Now

- Use static badges only.
- Enable GitHub-native security settings that do not require repo workflows.
- Keep `npm run validate:quick` documented for local validation.

### 7.2 Defer Unless Policy Changes

If maintainers decide GitHub Actions are acceptable later, start with one minimal workflow:

- checkout
- setup Node 20 or 22
- no install unless dev checks require it
- run syntax checks that do not require dependencies
- optionally run `npm install` only for dependency-backed validation in a separate job

Only after that workflow is real should README show a status badge.

Do not copy Pharos's CodeQL, deployment, OG-refresh, and security workflow set wholesale. ClaudeVille is local, no-build, and intentionally lighter.

## Phase 8 - Public Positioning And Outreach

Once Phases 0-6 are done, visibility can move outside the repo.

Recommended sequence:

1. Pin the canonical repo on the maintainer's GitHub profile.
2. Open a GitHub Discussion announcement with screenshots and the local/read-only trust boundary.
3. Share a concise release post in relevant communities for Claude Code, Codex CLI, and local-first developer tools.
4. Submit to relevant "awesome" lists only after the README and license are complete.
5. Consider a minimal static GitHub Pages landing page only if GitHub README conversion is already strong.

Outreach message should lead with the differentiator:

> I built a local-first dashboard that turns Claude Code, Codex, Gemini, Kimi, and OpenCode sessions into a live pixel village, with a dense dashboard when you need exact state.

Do not overpromise orchestration. ClaudeVille watches sessions; it is not an agent runner.

## Implementation Checklist

### P0 - Trust And Discoverability

- [ ] Decide canonical repo and update all URLs accordingly.
- [ ] Confirm license rights.
- [ ] Add root `LICENSE`.
- [ ] Add `license`, `description`, `repository`, `bugs`, `homepage`, and `keywords` to `package.json`.
- [ ] Enable Issues on canonical repo.
- [ ] Add topics to canonical repo.
- [ ] Disable Wiki unless maintained.
- [ ] Add `CONTRIBUTING.md`.
- [ ] Add `SECURITY.md`.
- [ ] Rewrite README top fold.
- [ ] Replace user-attachment hero image with repo-local screenshot.
- [ ] Link `CHANGELOG.md` near top of README.

### P1 - Intake And Media

- [ ] Add `.github/ISSUE_TEMPLATE/` forms.
- [ ] Add `.github/pull_request_template.md`.
- [ ] Add `SUPPORT.md`.
- [ ] Add curated screenshots under `docs/assets/github/`.
- [ ] Add `docs/assets/github/claudeville-og-card.png`.
- [ ] Upload custom social preview in GitHub settings.
- [ ] Add labels matching issue forms.
- [ ] Create first GitHub release for current version.

### P2 - Community And Maintenance

- [ ] Enable Discussions.
- [ ] Add `CODE_OF_CONDUCT.md` if inviting public contribution.
- [ ] Pin repo on GitHub profile.
- [ ] Consider a lightweight release process doc.
- [ ] Consider minimal CI only if the no-CI policy changes.
- [ ] Submit to relevant awesome lists after the trust surface is complete.

## Suggested README Outline

```markdown
# ClaudeVille

[badges]

Watch your local AI coding CLIs work in a living pixel village.

[short product paragraph]
[hero screenshot]

## Why ClaudeVille
## Local And Read-Only
## Supported Providers
## Quick Start
## Screenshots
## Features
## Requirements
## Project Layout
## API And Runtime Architecture
## Desktop Widgets
## Documentation
## Contributing
## Security
## Changelog
## License
```

Move the existing deep architecture/API content lower, not out. It is good; it just should not be the first conversion screen.

## Success Metrics

These are practical checks after the work lands:

- GitHub detects the license.
- Community profile reaches at least 70%.
- Canonical repo has 20 relevant topics.
- Issues and Discussions are enabled with structured intake.
- README first screen includes a clear pitch, badges, local/read-only trust copy, and a product screenshot.
- Social preview is custom and shows the product.
- GitHub "Latest release" is populated.
- `gh repo view` shows description, topics, license, and release.
- Searching GitHub for `Claude Code dashboard`, `AI coding agents dashboard`, and `Codex CLI dashboard` has a plausible chance of surfacing ClaudeVille by title/description/topic relevance.

Social metrics like stars and forks are lagging indicators. Do not optimize by adding noise. Optimize for a developer landing on the repo and understanding in 30 seconds why it is useful, safe, and active.

## Risks And Non-Goals

- Do not advertise mobile support. Desktop-only is a project constraint.
- Do not imply hosted telemetry or cloud sync. Local-first is core trust.
- Do not add unsupported CI badges.
- Do not expose private provider logs in screenshots, fixtures, issues, or demos.
- Do not split docs into a wiki unless the wiki has an owner.
- Do not make the README pure marketing. The current technical depth is valuable; it just belongs below the conversion layer.
- Do not copy Pharos's heavy workflow footprint unless ClaudeVille's workflow policy changes.

## Validation For This Plan's Execution

Docs/metadata phases:

```bash
git status --short
git diff -- README.md package.json agents/README.md agents/github-visibility-plan.md .github LICENSE CONTRIBUTING.md SECURITY.md SUPPORT.md
```

GitHub settings phases:

```bash
gh repo view TokenBrice/claude-ville --json description,repositoryTopics,hasIssuesEnabled,hasDiscussionsEnabled,licenseInfo,latestRelease,usesCustomOpenGraphImage
gh api repos/TokenBrice/claude-ville/community/profile
```

README media phases:

```bash
find docs/assets/github -maxdepth 1 -type f -print
```

Runtime validation is not required for pure docs/settings work, but if screenshots are recaptured from the app, use the maintained local server at `http://localhost:4000` and verify World plus Dashboard visually.

## References

- GitHub Docs: repository topics - https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics
- GitHub Docs: community profiles - https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories
- GitHub Docs: issue forms - https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-forms
- GitHub Docs: social preview - https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview
- GitHub Docs: releases - https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases
- Local comparison: `/home/ahirice/Documents/git/pharos-watch`
