# <Plan Title>

Date: YYYY-MM-DD
Status: active | ready | historical | superseded | deferred | reference
Baseline HEAD: `<sha>`
Initial `git status --short`: `<output>`
Final expected `git status --short`: `<output>`

## Scope

Owned paths:

- `<path>`

Read-only paths:

- `<path>`

Source docs:

- `<path>`

## Goal

State the outcome in one short paragraph.

## Non-Goals

- `<explicit cut>`

## Findings By Priority

Critical:

- None.

High:

- `<finding>`

Medium:

- `<finding>`

Low:

- `<finding>`

## Plan

1. `<step>`
2. `<step>`
3. `<step>`

## Execution Readiness

Safe to execute: yes | partial | no

Required preflight:

- Re-run `git status --short`.
- Re-check owned paths for unrelated edits.
- Reconfirm code or docs referenced by this plan still match current `HEAD`.

## Validation

Validation required:

- `<command or manual check>`

Validation run:

- Not run; planning artifact only.

## Residual Risks

- `<risk or unknown>`

## Supersession Policy

If this plan becomes stale, update `agents/README.md` with the replacement source of truth and mark this artifact `historical` or `superseded`.
