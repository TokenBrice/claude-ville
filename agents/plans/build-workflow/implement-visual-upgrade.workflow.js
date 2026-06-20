/**
 * ClaudeVille Visual Upgrade — parallel implementation workflow (PREPARED, not auto-run).
 *
 * Model: SHARED working tree on branch `visual-upgrade-build`. Safety = FILE-DISJOINT WAVES,
 * not git isolation. Within a wave, every item edits a provably disjoint set of files, so the
 * N implementers run concurrently with zero edit collision. After each wave a single verifier
 * runs node --check + a stray-file scope check, then commits the wave (one rollback point per wave).
 * Foundation (#1 palette, #2 mark-governor, #3 grade) is serial; everything builds on it.
 *
 * Schedule + ownership are authoritative — derived & verified by prep run wf_d59b5cba-a6b
 * (10 source auditors + architect). See agents/plans/claudeville-visual-upgrade-implementation-orchestration.md.
 *
 * HOW TO LAUNCH (the actual build mutates the repo — only run on explicit approval):
 *   Workflow({ scriptPath: "<this file>" })                              // full run, all 23 waves
 *   Workflow({ scriptPath: "<this file>", args: { stopAfterTier: "0" }}) // foundation + Tier 0 only, then stop
 *   Workflow({ scriptPath: "<this file>", args: { fromWave: 5 }})        // resume at wave index 5 (T1.1)
 *   Workflow({ scriptPath: "<this file>", args: { commit: false }})      // implement+verify but DO NOT commit (preview)
 *   Workflow({ scriptPath: "<this file>", args: { items: [4,6,8] }})     // restrict to a subset of item ids
 * Wave index map: Foundation 0-2 | Tier0 3-4 | Tier1 5-10 | Tier2 11-14 | Tier3 15-22.
 */

export const meta = {
  name: 'implement-visual-upgrade',
  description: 'Implement all 50 ClaudeVille visual-upgrade items in dependency-ordered, file-disjoint parallel waves on branch visual-upgrade-build, with verify+commit per wave',
  phases: [
    { title: 'Setup', detail: 'create/checkout build branch, confirm clean tree' },
    { title: 'Foundation', detail: '#1 palette -> #2 mark-governor -> #3 grade (serial contracts)' },
    { title: 'Tier 0', detail: 'foundations & quick wins' },
    { title: 'Tier 1', detail: 'high-impact core / legibility' },
    { title: 'Tier 2', detail: 'epic centerpieces' },
    { title: 'Tier 3', detail: 'polish, charm & cohesion' },
  ],
}

const ROOT = '/home/ahirice/Documents/git/claude-ville'
const PLAN = ROOT + '/agents/claudeville-visual-upgrade-top-50.md'
const DOC = ROOT + '/agents/plans/claudeville-visual-upgrade-implementation-orchestration.md'

// ---- authoritative wave schedule (23 waves; intra-wave file sets proven disjoint) ----
const WAVES = [
  { label: 'F1', items: [1] },
  { label: 'F2', items: [2] },
  { label: 'F3', items: [3] },
  { label: 'T0.1', items: [4, 6, 7, 8] },
  { label: 'T0.2', items: [5] },
  { label: 'T1.1', items: [14, 18, 20] },
  { label: 'T1.2', items: [10, 15, 17] },
  { label: 'T1.3', items: [11, 13] },
  { label: 'T1.4', items: [9, 12] },
  { label: 'T1.5', items: [19] },
  { label: 'T1.6', items: [16] },
  { label: 'T2.1', items: [21, 22, 27] },
  { label: 'T2.2', items: [23, 24, 28] },
  { label: 'T2.3', items: [25] },
  { label: 'T2.4', items: [26] },
  { label: 'T3.1', items: [29, 31, 39, 40, 49] },
  { label: 'T3.2', items: [30, 33, 41, 43, 46] },
  { label: 'T3.3', items: [32, 45, 47, 48] },
  { label: 'T3.4', items: [34, 44, 50] },
  { label: 'T3.5', items: [35, 38] },
  { label: 'T3.6', items: [42] },
  { label: 'T3.7', items: [36] },
  { label: 'T3.8', items: [37] },
]

// ---- per-item owned files (basenames). Each item may EDIT/CREATE only these. ----
const OWNED = {
  1: ['AgentPresentation.js', 'AgentSprite.js', 'AvatarCanvas.js', 'CouncilRing.js', 'HarborTraffic.js', 'VillageDirectorOverlay.js', 'theme.js'],
  2: ['AgentSprite.js', 'CouncilRing.js', 'IsometricRenderer.js', 'MarkGovernor.js', 'VillageDirectorOverlay.js'],
  3: ['AtmosphereState.js', 'CouncilRing.js', 'HarborTraffic.js', 'VillageDirectorOverlay.js', 'WorldFrameRenderer.js'],
  4: ['AgentSprite.js'],
  5: ['BuildingSprite.js', 'BuildingVisualRegistry.js'],
  6: ['SkyRenderer.js'],
  7: ['BuildingSprite.js', 'IsometricRenderer.js', 'SceneryEngine.js'],
  8: ['VillageDirector.js'],
  9: ['AgentSprite.js', 'ToolGlyphBadge.js'],
  10: ['IsometricRenderer.js'],
  11: ['BuildingSprite.js', 'WorldFrameRenderer.js'],
  12: ['BuildingSprite.js', 'WorldFrameRenderer.js'],
  13: ['AgentSprite.js', 'ParticleSystem.js'],
  14: ['AgentSprite.js', 'BuildingSprite.js', 'IsometricRenderer.js'],
  15: ['AgentSprite.js', 'ParticleSystem.js', 'RitualConductor.js'],
  16: ['IsometricRenderer.js'],
  17: ['BuildingSprite.js', 'BuildingVisualRegistry.js', 'WorldFrameRenderer.js'],
  18: ['ChronicleMonuments.js', 'HarborTraffic.js', 'ParticleSystem.js'],
  19: ['CrowdClusterOverlay.js', 'IsometricRenderer.js'],
  20: ['AvatarCanvas.js', 'DashboardRenderer.js', 'dashboard.css'],
  21: ['Camera.js', 'CameraDirector.js', 'IsometricRenderer.js', 'VillageDirector.js', 'WorldFrameRenderer.js'],
  22: ['SkyRenderer.js', 'WeatherRenderer.js'],
  23: ['IsometricRenderer.js'],
  24: ['WorldFrameRenderer.js'],
  25: ['IsometricRenderer.js'],
  26: ['IsometricRenderer.js'],
  27: ['AgentSprite.js', 'CouncilRing.js'],
  28: ['AgentSprite.js', 'VillageDirectorOverlay.js'],
  29: ['AtmosphereState.js'],
  30: ['AgentPresentation.js', 'DashboardRenderer.js', 'dashboard.css'],
  31: ['AgentSelection.js', 'activity-panel.css', 'dashboard.css', 'sidebar.css'],
  32: ['AgentSprite.js', 'ArrivalDeparture.js', 'ParticleSystem.js'],
  33: ['AtmosphereState.js', 'BuildingSprite.js', 'ParticleSystem.js'],
  34: ['AgentSprite.js', 'LandmarkActivity.js', 'ParticleSystem.js'],
  35: ['HarborTraffic.js', 'IsometricRenderer.js', 'ParticleSystem.js'],
  36: ['AgentSprite.js', 'ParticleSystem.js'],
  37: ['AgentSprite.js'],
  38: ['AgentSprite.js', 'CouncilRing.js', 'RelationshipState.js'],
  39: ['IsometricRenderer.js', 'SeasonalAmbience.js'],
  40: ['AgentSprite.js', 'BuildingSprite.js', 'ParticleSystem.js', 'VillageDirector.js', 'VillageDirectorOverlay.js'],
  41: ['AgentSprite.js', 'IsometricRenderer.js', 'RitualConductor.js', 'manifest.yaml', 'scenery.js'],
  42: ['AgentSprite.js', 'IsometricRenderer.js', 'ParticleSystem.js'],
  43: ['Sidebar.js', 'sidebar.css'],
  44: ['DashboardRenderer.js', 'dashboard.css'],
  45: ['Camera.js', 'IsometricRenderer.js'],
  46: ['ActivityPanel.js', 'AvatarCanvas.js', 'activity-panel.css'],
  47: ['ActivityPanel.js', 'VillageDirector.js', 'activity-panel.css'],
  48: ['TopBar.js', 'dashboard.css', 'topbar.css'],
  49: ['TopBar.js', 'topbar.css'],
  50: ['Camera.js', 'IsometricRenderer.js'],
}

// new files (no conflict — created fresh): MarkGovernor.js (#2), ToolGlyphBadge.js (#9), CameraDirector.js (#21)
const NEW_FILES = new Set(['MarkGovernor.js', 'ToolGlyphBadge.js', 'CameraDirector.js'])

// ---- args / run controls ----
const A = (typeof args === 'object' && args) ? args : {}
const BRANCH = A.branch || 'visual-upgrade-build'
const FROM = Number.isInteger(A.fromWave) ? A.fromWave : 0
const TO = Number.isInteger(A.toWave) ? A.toWave : WAVES.length - 1
const COMMIT = A.commit !== false // default true
const STOP_AFTER_TIER = (A.stopAfterTier != null) ? String(A.stopAfterTier) : null
const ITEM_FILTER = Array.isArray(A.items) ? new Set(A.items.map(Number)) : null

const tierOf = label => label[0] === 'F' ? 'F' : label.slice(1).split('.')[0] // 'F','0','1','2','3'
const phaseFor = label => label[0] === 'F' ? 'Foundation' : 'Tier ' + tierOf(label)

const CONSTRAINTS = `HARD CONSTRAINTS — no build step / bundler / framework; vanilla ES modules; Canvas-2D only (no WebGL/shaders). SpriteRenderer.js is the sole sprite-blit path (integer-snapped, smoothing off); zoom is clamped to integer {1,2,3}. Motion budget: check motionScale, use PulsePolicy.js helpers (pulseValue/pulseAlpha), declare a pulse band, and SHIP A STATIC prefers-reduced-motion FALLBACK for every motion feature (this is part of "done"). Terrain is baked into a cache canvas — push static detail into the bake, never add per-frame work that could be cached. Sprites are manifest.yaml-driven (bump style.assetVersion when PNGs change). Desktop-only >=1280px (no media queries), English-only copy, port 4000. World-mode code is under claudeville/src/presentation/character-mode/, shared UI under shared/, dashboard under dashboard-mode/, config under claudeville/src/config/, CSS under claudeville/css/.`

// ===================== SETUP =====================
phase('Setup')
const setup = await agent(
  `You are preparing a shared working tree for a parallel build. Working dir: ${ROOT}.\n` +
  `1. Run \`git -C ${ROOT} status --short\` and report the result verbatim. Untracked files under agents/ are expected and fine.\n` +
  `2. Create (if absent) and check out a branch named \`${BRANCH}\` off the current HEAD: \`git -C ${ROOT} rev-parse --verify ${BRANCH}\` then \`git -C ${ROOT} checkout -b ${BRANCH}\` or \`git -C ${ROOT} checkout ${BRANCH}\`.\n` +
  `3. Report the current commit sha and confirm the branch is checked out.\n` +
  `Do NOT modify, stage, commit, reset, or stash any files. Only branch + report.`,
  {
    label: 'setup-branch', phase: 'Setup', effort: 'low',
    schema: {
      type: 'object', additionalProperties: false,
      properties: { branch: { type: 'string' }, baseSha: { type: 'string' }, checkedOut: { type: 'boolean' }, dirtyTrackedFiles: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } },
      required: ['branch', 'checkedOut'],
    },
  }
)
log(`Setup: branch=${setup && setup.branch} sha=${setup && setup.baseSha} dirtyTracked=${(setup && setup.dirtyTrackedFiles || []).length}`)
if (!setup || !setup.checkedOut) { return { aborted: true, reason: 'setup failed — branch not checked out', setup } }
if (setup.dirtyTrackedFiles && setup.dirtyTrackedFiles.length) {
  return { aborted: true, reason: 'tracked working-tree changes present before build — resolve them first', dirty: setup.dirtyTrackedFiles }
}

// ===================== SCHEMAS =====================
const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    item: { type: 'integer' },
    implemented: { type: 'boolean' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    newFiles: { type: 'array', items: { type: 'string' } },
    nodeCheckPass: { type: 'boolean', description: 'node --check passed on every changed/created .js' },
    reducedMotionFallback: { type: 'string', description: 'the static fallback shipped for any motion (or "n/a — no motion")' },
    outOfScopeNeeded: { type: 'array', items: { type: 'string' }, description: 'files OUTSIDE your owned set you found you needed (you must NOT have edited them)' },
    summary: { type: 'string' },
  },
  required: ['item', 'implemented', 'filesChanged', 'nodeCheckPass', 'summary'],
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    pass: { type: 'boolean' },
    nodeCheckPass: { type: 'boolean' },
    strayFiles: { type: 'array', items: { type: 'string' }, description: 'changed files whose basename is NOT in the wave allow-list' },
    committed: { type: 'boolean' },
    commitSha: { type: 'string' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['pass', 'nodeCheckPass', 'committed', 'summary'],
}

function implPrompt(id) {
  const owned = OWNED[id] || []
  const created = owned.filter(f => NEW_FILES.has(f))
  return `You implement ONE item of the ClaudeVille visual-upgrade plan on the shared \`${BRANCH}\` branch. Other agents are concurrently implementing sibling items in DISJOINT files — your isolation depends on you touching ONLY your files.\n\n` +
    `ITEM #${id}.\n` +
    `Read, in order: (a) the "### #${id}" block in ${PLAN}; (b) the "#${id}" per-item brief in ${DOC} (its owned files, approach, prereqs); (c) the actual source of each owned file.\n\n` +
    `YOU MAY EDIT ONLY THESE FILES (locate exact paths with \`rg --files | rg <name>\`):\n  ${owned.join(', ')}\n` +
    (created.length ? `Of these, CREATE NEW: ${created.join(', ')} (put new modules beside their peers, e.g. character-mode/).\n` : '') +
    `\nHARD RULES:\n` +
    `- Edit ONLY the files listed above. If you discover you must change ANY other file, STOP, do NOT edit it, set outOfScopeNeeded to that file (and why) and implemented=false. A stray edit corrupts a sibling agent's work.\n` +
    `- Do NOT run git (no add/commit/checkout/stash). Do NOT start the dev server or run npm. The wave verifier commits.\n` +
    `- ${CONSTRAINTS}\n` +
    `- Implement the item's REAL behavior (wire it into the actual draw/update path), not a stub. Match surrounding code style. Keep the change surgical.\n` +
    `- After editing, run \`node --check <file>\` on every changed/created .js (CSS needs no check) and report whether all passed.\n\n` +
    `Return the structured report. summary <= 60 words.`
}

function verifyPrompt(wave) {
  const allow = [...new Set(wave.items.flatMap(i => OWNED[i] || []))]
  return `You are the wave verifier+committer for wave ${wave.label} (items ${wave.items.map(i => '#' + i).join(', ')}) on branch ${BRANCH}. Working dir ${ROOT}.\n\n` +
    `1. \`git -C ${ROOT} diff --name-only HEAD\` (and include untracked: \`git -C ${ROOT} status --porcelain\`) -> the full changed/created file set. Report basenames in changedFiles.\n` +
    `2. SCOPE CHECK: every changed file's basename MUST be in this allow-list: [${allow.join(', ')}]. Any basename NOT in it is a STRAY edit -> list in strayFiles and set pass=false.\n` +
    `3. SYNTAX: run \`node --check\` on every changed/created .js. Any failure -> nodeCheckPass=false, pass=false. Report the first error in summary.\n` +
    (COMMIT
      ? `4. IF pass (no stray files AND node --check clean): stage and commit ONLY with \`git -C ${ROOT} add -A && git -C ${ROOT} commit -m "visual-upgrade ${wave.label}: ${wave.items.map(i => '#' + i).join(' ')}"\`; report committed=true and the new sha. IF NOT pass: do NOT commit (committed=false) and report what failed.\n`
      : `4. DO NOT COMMIT (preview mode). Report committed=false and the diff summary so a human can inspect.\n`) +
    `Do NOT fix the code yourself and do NOT reset/checkout/revert anything. Just verify, (maybe) commit, and report. summary <= 60 words.`
}

// ===================== WAVES =====================
const results = []
let halted = null
for (let wi = FROM; wi <= TO && wi < WAVES.length; wi++) {
  const wave = WAVES[wi]
  let items = wave.items
  if (ITEM_FILTER) items = items.filter(i => ITEM_FILTER.has(i))
  if (!items.length) continue

  phase(phaseFor(wave.label))
  log(`Wave ${wave.label} (idx ${wi}/${WAVES.length - 1}) — implementing ${items.map(i => '#' + i).join(' ')}`)

  const reports = await parallel(items.map(id => () => agent(
    implPrompt(id), { label: `build:#${id}`, phase: phaseFor(wave.label), effort: 'high', schema: IMPL_SCHEMA }
  )))

  const stray = reports.filter(Boolean).flatMap(r => r.outOfScopeNeeded || [])
  const implFail = reports.filter(Boolean).filter(r => !r.implemented).map(r => '#' + r.item)
  const checkFail = reports.filter(Boolean).filter(r => r.implemented && !r.nodeCheckPass).map(r => '#' + r.item)

  const verdict = await agent(
    verifyPrompt(wave), { label: `verify:${wave.label}`, phase: phaseFor(wave.label), effort: 'low', schema: VERIFY_SCHEMA }
  )

  results.push({
    wave: wave.label, idx: wi, items,
    implemented: reports.filter(Boolean).filter(r => r.implemented).map(r => r.item),
    implFail, checkFail, strayReported: stray,
    verdict: verdict || { pass: false, summary: 'verifier returned null' },
  })

  if (!verdict || !verdict.pass) {
    halted = { wave: wave.label, idx: wi, reason: (verdict && verdict.summary) || 'verifier failed', strayFiles: (verdict && verdict.strayFiles) || stray, implFail, checkFail }
    log(`HALT at ${wave.label}: ${halted.reason}`)
    break
  }
  log(`Wave ${wave.label} committed: ${verdict.commitSha || '(no commit / preview)'}`)

  // tier checkpoint: when the NEXT wave is a different tier (or this is the last wave), run a broad regression
  const nextTier = (wi + 1 < WAVES.length) ? tierOf(WAVES[wi + 1].label) : null
  const tierEnds = nextTier !== tierOf(wave.label)
  if (tierEnds && COMMIT) {
    const check = await agent(
      `Tier checkpoint after wave ${wave.label} on branch ${BRANCH} (working dir ${ROOT}). Run \`npm run --prefix ${ROOT} validate:quick\` (or \`cd ${ROOT} && npm run validate:quick\`). Report pass/fail and, on failure, the first failing check. Do NOT modify or revert anything.`,
      { label: `checkpoint:${tierOf(wave.label)}`, phase: phaseFor(wave.label), effort: 'low',
        schema: { type: 'object', additionalProperties: false, properties: { pass: { type: 'boolean' }, summary: { type: 'string' } }, required: ['pass', 'summary'] } }
    )
    results[results.length - 1].tierCheckpoint = check || { pass: false, summary: 'checkpoint null' }
    log(`Tier ${tierOf(wave.label)} checkpoint: ${check && check.pass ? 'PASS' : 'FAIL — ' + (check && check.summary)}`)
    if (check && !check.pass) { halted = { wave: wave.label, idx: wi, reason: 'tier checkpoint failed: ' + check.summary }; break }
    if (STOP_AFTER_TIER && tierOf(wave.label) === STOP_AFTER_TIER) { log(`Stopping after tier ${STOP_AFTER_TIER} as requested.`); break }
  }
}

return {
  branch: BRANCH,
  committed: COMMIT,
  wavesRun: results.length,
  itemsImplemented: results.flatMap(r => r.implemented),
  halted,
  waves: results.map(r => ({ wave: r.wave, items: r.items, committed: r.verdict.committed, sha: r.verdict.commitSha, pass: r.verdict.pass, stray: r.strayReported, summary: r.verdict.summary })),
  resumeHint: halted ? `Fix the issue, then resume: Workflow({ scriptPath: "${ROOT}/agents/plans/build-workflow/implement-visual-upgrade.workflow.js", args: { fromWave: ${halted.idx} } })` : 'all requested waves complete',
}
