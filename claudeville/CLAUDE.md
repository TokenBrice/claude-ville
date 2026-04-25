# ClaudeVille - Project Rules

## Layout Structure (Important)

```
body (flex column, height 100vh)
  header.topbar            ← 48px fixed height, flex-shrink: 0
  div.main                 ← flex: 1, flex-direction: column
    div.main__body         ← flex: 1, display: flex (horizontal layout)
      aside.sidebar        ← width: 240px, flex-shrink: 0
      div.content          ← flex: 1 (character/dashboard modes)
      aside#activityPanel  ← width: 320px (shown when an agent is selected; hidden by default)
```

### Notes
- **Never position UI elements with `position: fixed`** (except modals and toasts)
- New panels must be placed inside the flex layout
- When activityPanel (320px) opens, the content area shrinks; account for responsive behavior
- Dashboard mode scrolls with `overflow-y: auto`; character mode has the canvas fill the remaining area

## Tech Stack
- Plain HTML/CSS/JS (no framework)
- ES Modules (import/export)
- Node.js server (server.js) - HTTP + WebSocket (RFC 6455 implemented directly)
- Canvas 2D API for isometric rendering
- Adapter pattern for multi-provider support (adapters/ directory)
- **Server port: 4000** (not 3000; do not change it)

## Data Sources (multi-provider)
- **Claude Code**: `~/.claude/` (history.jsonl, projects/, teams/, tasks/)
- **Codex CLI**: `~/.codex/sessions/` (rollout-*.jsonl)
- **Gemini CLI**: `~/.gemini/tmp/` (session-*.json)
- Each adapter is implemented in `adapters/claude.js`, `adapters/codex.js`, `adapters/gemini.js`
- `adapters/index.js` acts as the registry and auto-detects only installed CLIs

## Modes
- **WORLD**: Agents move around as characters in an isometric pixel world
- **DASHBOARD**: Real-time tool/activity monitoring with one card per agent

## Key Features
- **Camera follow**: Clicking an agent makes the camera smoothly follow with lerp (released on drag)
- **Live activity panel**: Right-side 320px panel polls tool history, messages, and token usage every 2 seconds
- **Token usage**: context progress bar + input/output/cache/turns + estimated cost
- **Chat animation**: moves a character to its partner and shows a speech bubble when SendMessage is used
- **Session detection**: history.jsonl + subagents/ + direct project directory scan (including orphan sessions)

## Event Flow
- `agent:selected` → ActivityPanel open + Camera follow start
- `agent:deselected` → ActivityPanel close + Camera follow clear
- `agent:updated` → update sprites/panels in real time
- `agent:added` / `agent:removed` → create/remove sprites
