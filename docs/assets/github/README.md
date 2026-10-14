# GitHub images

These are captures of the running application, refreshed for v0.55.1.1. The
`readme-showcase` simulator supplies 31 fictional agents across seven providers
and four projects. Paths, messages, tool history, usage, and costs are sample
data. The `SIMULATED` indicator remains visible in application screenshots.

From the repository root, with the maintained server running via `npm run dev`
at `http://localhost:4000` and the existing Playwright development dependency:

```sh
node scripts/world/capture-marketing.mjs         # Preview in output/playwright/
node scripts/world/capture-marketing.mjs --write # Replace these six PNGs
```

The script uses full Chromium and the hardware WebGL renderer, checks the
renderer and fixture, and fails on browser errors or unexpected API requests.
It uses a fresh browser context, supplies synthetic session details, and never
fetches live session, provider, account, or usage data. It closes its browser
without stopping the maintained server. A software-only renderer fails the
capture; use a machine with a working hardware GPU rather than removing that
check. Install Chromium with `npx playwright install chromium` if needed.

Application images are 1920 × 1200 at DPR 1. Daylight is fixed at 10:30 and night
at 22:00 with clear weather. Camera framing is fixed; villagers, particles,
elapsed times, and the current tune remain live, so captures are not pixel
identical. The FPS indicator alone is hidden because an automated screenshot
run is not a performance benchmark. Review every resulting image for framing,
readable controls, accurate copy, and absence of personal data before publishing.

| File | Purpose |
| --- | --- |
| `world-day.png` | README hero: village, agents, and attention indicators |
| `dashboard.png` | Approval queue and agents grouped by project |
| `activity-panel.png` | Selected agent, tool history, context, cost, and plan |
| `world-night.png` | Night lighting and working buildings |
| `sound-popover.png` | Sound presets, playing tune, volume, and hush |
| `claudeville-og-card.png` | 1280 × 640 social preview, composed from the captured village |

The social card adds the project name and tagline to an actual screenshot crop.
The script checks that it stays below GitHub's 1 MB size limit. Committing it does
not update GitHub's social preview: a repository administrator must upload
`claudeville-og-card.png` in **Settings → Social preview → Edit → Upload an image**.
See [GitHub's social preview instructions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).
