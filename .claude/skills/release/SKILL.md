---
name: release
description: Prepare and publish a ClaudeVille release from CHANGELOG.md. Trigger for version checks, release preparation, tagging, or GitHub releases, including when the operator asks to release, ship, push, or take a change to production. Publishes only on such a request.
---

# Release

## When to use

Use for a named release or hotfix after its changes are ready. `AGENTS.md` Changelog
rules and `CHANGELOG.md` are authoritative. The script owns grammar and version edits;
run `node scripts/release/prepare.mjs --help` for its current contract.

Mutation boundary: edit only the new `CHANGELOG.md` section by hand. The prepare
script may update `package.json`, `claudeville/index.html`, a temp notes file, and,
with `--tag`, a local Git tag.

## Inputs

- Full version (`0.X.Y` named release or `0.X.Y.Z` hotfix).
- A short medieval/RPG name for a named release; hotfixes have no name.
- Operator intent to publish. A request to release, ship, push, deploy, or take a
  change to production is that intent for the whole flow: the agent then pushes
  and creates the GitHub release on its own without asking again. Preparation
  alone (check, version edits, tag) needs no such request.

## Steps

1. Inspect the shared tree: `git status --short`.
2. Choose the tier and prepend the matching `CHANGELOG.md` entry.
3. Validate and preview: `npm run release:check -- <version>`.
4. Apply both version edits and write release notes: `npm run release:prepare -- <version> --write`.
5. Run the release gate: `npm run gate:release`.
6. Review status and commit only the intended release files.
7. If publication was requested, push the release commit to `main`.
8. From the clean committed tree, create the local tag: `npm run release:prepare -- <version> --tag`.
9. If publication was requested, push `v<version>`, then run the exact `gh release create` command printed by the script, adding `-R <owner>/<repo>` for the `origin` remote when `gh` resolves a different default repo (this checkout also has an `upstream` remote). Add `--latest=false` when backfilling an older release.
10. Verify the GitHub tag/release and finish with `git status --short`.

## Verification

- `npm run release:verify` confirms the top changelog, package version, and UI version agree.
- The printed notes must equal that changelog section verbatim.
- The UI version is always `v<major>.<minor>`.

## Never

- Never hand-edit `package.json` or the `.topbar__version` for a release.
- Never start or stop the maintained server or touch port 4000.
- Never push, invoke `gh`, or create a release unless the operator asked to publish (see Inputs); once they have, do not stop to ask again.
- Never rewrite an existing tag; the script creates only a local annotated tag at HEAD.
