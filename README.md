<div align="center">

```
 ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝
       ██╗   ██╗██╗██╗     ██╗     ███████╗
       ██║   ██║██║██║     ██║     ██╔════╝
       ╚██╗ ██╔╝██║██║     ██║     █████╗
        ╚████╔╝ ██║██║     ██║     ██╔══╝
         ╚██╔╝  ██║███████╗███████╗███████╗
          ╚═╝   ╚═╝╚══════╝╚══════╝╚══════╝
```

**Real-time visualization dashboard for Claude Code agents, teams & swarms**

Watch your AI agent teams come alive in an isometric pixel world

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Claude Code](https://img.shields.io/badge/Claude_Code-CLI-blueviolet?logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/claude-code)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-brightgreen)]()

<!-- 스크린샷이 준비되면 아래 주석 해제 -->
<!-- <img src="assets/demo.gif" alt="ClaudeVille Demo" width="800" /> -->

</div>

---

## What is ClaudeVille?

ClaudeVille turns your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agent sessions into a live, visual dashboard. Whether you're running a single agent or orchestrating multi-agent teams and swarms, ClaudeVille reads `~/.claude/` session logs in real-time and renders agents as pixel characters in an isometric world — or as monitoring cards in dashboard mode.

> **Claude Code CLI only** — reads directly from `~/.claude/` directory

## Features

- **World Mode** — Isometric pixel village where agents roam as characters with unique appearances
- **Dashboard Mode** — Real-time agent cards showing tool usage, messages, and activity
- **Live Detection** — WebSocket + file watcher for instant session updates
- **Agent Team & Swarm** — Auto-detects Claude Code teams, swarms, and sub-agents
- **Multilingual** — Korean / English
- **Zero Dependencies** — Pure Node.js, no npm install needed

## Quick Start

```bash
git clone https://github.com/honorstudio/claude-ville.git
cd claude-ville
npm run dev
```

Open http://localhost:3000 in your browser. That's it.

## Requirements

- [Node.js](https://nodejs.org/) v18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed with session history

## How It Works

When you use Claude Code CLI, session logs are written to `~/.claude/`.
ClaudeVille watches these files and streams updates to your browser via WebSocket.

```
~/.claude/
├── history.jsonl            # Session history
├── projects/{path}/         # Per-project session logs (.jsonl)
│   └── {sessionId}/
│       └── subagents/       # Sub-agent logs
├── teams/                   # Team configs
└── tasks/                   # Task lists
```

## Project Structure

```
claude-ville/
├── claudeville/
│   ├── index.html
│   ├── server.js                # Node.js server (HTTP + WebSocket)
│   ├── css/                     # Stylesheets
│   └── src/
│       ├── config/              # Theme, buildings, i18n, constants
│       ├── domain/              # Entities, value objects, events
│       ├── infrastructure/      # Data source, WebSocket client
│       ├── application/         # Managers, session watcher, notifications
│       └── presentation/        # UI renderers (character / dashboard)
└── package.json
```

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML / CSS / JavaScript (ES Modules) |
| Rendering | Canvas 2D API (isometric pixel art) |
| Server | Node.js built-in modules only |
| Real-time | WebSocket (RFC 6455, hand-rolled) |
| Data | `~/.claude/` file system (read-only) |

## API

| Endpoint | Description |
|---|---|
| `GET /api/sessions` | Active session list |
| `GET /api/session-detail?sessionId=&project=` | Tool history + messages |
| `GET /api/teams` | Team list |
| `GET /api/tasks` | Task list |
| `GET /api/history?lines=100` | Last N lines of history.jsonl |
| `ws://localhost:3000` | Real-time updates (WebSocket) |

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

## License

[MIT](LICENSE)

---

<div align="center">

Made by **[honorstudio](https://github.com/honorstudio)**

</div>
