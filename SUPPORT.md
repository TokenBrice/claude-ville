# Support

ClaudeVille is a local desktop dashboard. Start with the matching runbook before opening an issue.

| Need | Start here |
| --- | --- |
| First-hour setup, provider, API, or graphics issue | [Troubleshooting](docs/troubleshooting.md) |
| Provider paths and supported session stores | [Supported providers](README.md#supported-providers) and [adapter reference](claudeville/adapters/README.md) |
| Add or change a provider/model identity | [Provider and model guide](docs/agent-provider-addition.md) |
| World mode visual QA | [Visual QA checklist](docs/world-visual-qa-checklist.md) |

Use [GitHub Issues](https://github.com/TokenBrice/claude-ville/issues/new/choose) for reproducible bugs, provider parsing problems, docs problems, and focused feature requests. Use [GitHub Discussions](https://github.com/TokenBrice/claude-ville/discussions) for broad ideas, roadmap questions, and new provider proposals.

Include the ClaudeVille version from the top bar (or your commit), operating system, Node version, and steps to reproduce. For provider problems, include the CLI version; for visual problems, include the browser version, viewport, and whether you used `/` or `/m/`. Mention whether the issue also occurs with the built-in simulator at `http://localhost:4000/?sim=1`.

Do not post full provider logs, private prompts, tokens, API keys, private file paths, or screenshots with secrets in public issues. Report vulnerabilities through the [security policy](SECURITY.md).
