# Contributing To ClaudeVille

ClaudeVille is a local-first dashboard for watching AI coding CLI sessions. Small, focused changes are easiest to review and keep the village stable.

## Good Contribution Lanes

- Provider adapter fixes with redacted fixtures or clear reproduction notes.
- Documentation fixes, setup notes, and API examples.
- macOS or KDE widget fixes.
- World, Dashboard, and sprite visual fixes with screenshots.
- Focused UI quality improvements that preserve the current design language.
- New provider proposals after the data source, privacy boundary, and maintenance cost are clear.

Feature ideas usually work best in GitHub Discussions before implementation.

## Before Editing

1. Read `AGENTS.md` for repo workflow, validation, git hygiene, and desktop-only constraints.
2. Read the nearest area README for the files you plan to touch.
3. Keep provider session files read-only. ClaudeVille observes local CLI logs; it must not mutate them.
4. Keep changes narrow. Avoid unrelated refactors, generated churn, and formatting sweeps.
5. Include screenshots for World, Dashboard, widget, or visual asset changes.

## Local Setup

```bash
npm run dev
```

Open `http://localhost:4000`.

The runtime does not need installed packages. Run `npm install` only when you intentionally need development scripts that import packages, such as sprite validation, visual diffs, or Playwright capture.

## Validation

Match validation to what changed. Common checks:

```bash
npm run validate:quick
npm run check:server
npm run check:adapters
npm run check:services
npm run check:frontend-syntax
npm run check:scripts
```

For UI or canvas changes, also open the app, test World and Dashboard modes, and verify agent selection opens and closes the activity panel.

## Pull Requests

- Explain the user-visible change and why it is needed.
- Link related issues or discussions.
- List focused validation commands and any checks you skipped.
- Include screenshots for visual changes.
- Do not include provider logs, API keys, tokens, private paths, or screenshots with secrets.
