# ClaudeVille KDE Plasma Widget

This is a Plasma 6 panel widget for EndeavourOS/KDE. It polls the local ClaudeVille server and shows working, waiting, idle, token, cost, and session summaries in a panel popup.

## Requirements

- KDE Plasma 6.
- `kpackagetool6` available on `PATH`.
- ClaudeVille running on `http://localhost:4000` with `npm run dev`.

## Check

```bash
npm run widget:kde:check
```

The check is non-mutating: it validates package files, metadata, QML config files, and referenced sprite images without installing or uninstalling the widget.

## Install

```bash
npm run widget:kde:install
```

Then add the widget from Plasma's **Add Widgets** panel and search for **ClaudeVille**.

The widget settings let you change the server URL and refresh interval.

## Uninstall

```bash
npm run widget:kde:uninstall
```
