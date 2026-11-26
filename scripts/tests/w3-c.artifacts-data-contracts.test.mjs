// Wave 3 Lane W3-C — Carried Artifacts, Claude compactions[], gh checks,
// Workflow Ribbons, Compaction Rite, Harbor Checks & Chronicle Loom Meta Prep.
// Authoritative contracts: Spec 04 §2.2, §2.4, §3.2, §3.3, §3.5, §5.4.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { makeTempDir } from './support/tmp.cjs';
import { ART_RAMPS, EFFECT_COLORS } from '../../claudeville/src/config/artPalette.js';
import {
    ARTIFACT_KINDS,
    ARTIFACT_SIZE,
    CAIRN_BUNDLE_HEIGHT,
    CAIRN_BUNDLE_WIDTH,
    CAIRN_MAX_EXACT_HEIGHT,
    CAIRN_WIDTH,
    admitReportCairn,
    artifactPaletteColor,
    artifactSetDownRect,
    artifactStampRows,
    artifactWalkingAnchor,
    assignWorkflowRibbons,
    formatCairnLabel,
    reportCairnSpec,
    resolveCarriedArtifact,
    sanitizeWorkflowLabel,
    selectCarriedArtifacts,
    shouldSuppressToolGlyphForArtifact,
    workflowGroupKey,
} from '../../claudeville/src/presentation/character-mode/CarriedArtifact.js';
import {
    EFFECT_BUDGET,
    effectBudgetMode,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { MarkGovernor, MarkTier } from '../../claudeville/src/presentation/character-mode/MarkGovernor.js';
import { MendLedger } from '../../claudeville/src/presentation/character-mode/OutcomeMends.js';
import {
    ArrivalDepartureController,
    COMPACTION_RITE_WINDOW_MS,
    formatCompactionChit,
} from '../../claudeville/src/presentation/character-mode/ArrivalDeparture.js';
import {
    CHECKS_PENNANT_HOLD_MS,
    HarborTraffic,
} from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';
import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { AgentManager, digestAgentPayload } from '../../claudeville/src/application/AgentManager.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { VERIFIED_OUTCOME_EVENT } from '../../claudeville/src/domain/services/VerifiedOutcome.js';
import {
    ChronicleEventKind,
    ChronicleLog,
    chronicleDateKey,
    summarizeDay,
} from '../../claudeville/src/application/ChronicleLog.js';
import {
    COVERAGE_QUARTERS,
    DB_VERSION,
    EMPTY_COVERAGE_MASK,
    SKY_HOURS,
    coverageMetaKey,
    hasCoverageQuarter,
    mergeCoverageMasks,
    normalizeDaySky,
    quarterIndexForTime,
    setCoverageQuarter,
    skyMetaKey,
} from '../../claudeville/src/infrastructure/ChronicleStore.js';

const require = createRequire(import.meta.url);
const { _test: claudeTest } = require('../../claudeville/adapters/claude.js');
const { normalizeSession } = require('../../claudeville/adapters/index.js');
const {
    MAX_CHECKS_EVENTS_PER_PROJECT,
    _test: gitTest,
    dedupeGitEvents,
    parseGitEventsFromCommand,
} = require('../../claudeville/adapters/gitEvents.js');

const T0 = 1_764_121_000_000;

// ---------------------------------------------------------------------------
// 1. CarriedArtifact 6x6 stamps, palette purity, OutcomeMends notches, slots
// ---------------------------------------------------------------------------

test('all 7 carried artifact stamps are pure 6x6 grids on ART_RAMPS / EFFECT_COLORS', () => {
    const allowedColors = new Set([
        ...Object.values(ART_RAMPS).flat(),
        ...Object.values(EFFECT_COLORS).flat(),
    ]);

    for (const kind of ARTIFACT_KINDS) {
        const variants = kind === 'brokenProof' ? [1, 2, 3] : [1];
        for (const notches of variants) {
            const rows = artifactStampRows(kind, { notches });
            assert.ok(Array.isArray(rows), `${kind} (${notches}) has rows`);
            assert.equal(rows.length, ARTIFACT_SIZE, `${kind} height is 6`);
            let inkCount = 0;
            for (const row of rows) {
                assert.equal(row.length, ARTIFACT_SIZE, `${kind} row width is 6`);
                for (const ch of row) {
                    if (ch === '.') continue;
                    inkCount++;
                    const color = artifactPaletteColor(ch);
                    assert.ok(color, `palette color exists for ${ch} in ${kind}`);
                    assert.ok(allowedColors.has(color), `color ${color} in ${kind} comes from ART_RAMPS / EFFECT_COLORS`);
                }
            }
            assert.ok(inkCount >= 10, `${kind} (${notches}) draws visible ink`);
        }
    }

    // Broken proof chit has 3 distinct notch silhouettes scaling 1..3.
    const b1 = artifactStampRows('brokenProof', { notches: 1 }).join('\n');
    const b2 = artifactStampRows('brokenProof', { notches: 2 }).join('\n');
    const b3 = artifactStampRows('brokenProof', { notches: 3 }).join('\n');
    assert.notEqual(b1, b2);
    assert.notEqual(b2, b3);
    assert.notEqual(b1, b3);
});

test('OutcomeMends failureStreakFor scales 1..3 and feeds brokenProof notches', () => {
    const ledger = new MendLedger();
    assert.equal(ledger.failureStreakFor('a1'), 0);

    const fail = (id, offset) => ({
        id,
        agentId: 'a1',
        project: '/repo/alpha',
        tool: 'Bash',
        detail: 'npm test',
        exitCode: 1,
        exitCodeSource: 'exit',
        completedAt: T0 + offset,
    });

    ledger.observe(fail('f1', 0));
    assert.equal(ledger.failureStreakFor('a1'), 1);
    assert.equal(ledger.failureStreakForProject('/repo/alpha'), 1);

    ledger.observe(fail('f2', 1000));
    assert.equal(ledger.failureStreakFor('a1'), 2);

    ledger.observe(fail('f3', 2000));
    assert.equal(ledger.failureStreakFor('a1'), 3);

    ledger.observe(fail('f4', 3000));
    assert.equal(ledger.failureStreakFor('a1'), 3, 'streak caps at 3');

    const artifact = resolveCarriedArtifact({
        id: 'a1',
        status: 'working',
        provider: 'claude',
        lastResults: [{ exitCode: 1, exitCodeSource: 'exit', completedAt: T0 + 3000 }],
    }, { mendLedger: ledger, now: T0 + 4000 });
    assert.deepEqual(artifact, { kind: 'brokenProof', notches: 3 });

    // Passing clears the open failure and drops streak back to 0.
    const mend = ledger.observe({ ...fail('p1', 4000), exitCode: 0 });
    assert.ok(mend);
    assert.equal(ledger.failureStreakFor('a1'), 0);
});

test('resolveCarriedArtifact maps tool legs truthfully and never draws on idle/casual/stale states', () => {
    assert.equal(resolveCarriedArtifact({ status: 'working', currentTool: 'Edit' })?.kind, 'billet');
    assert.equal(resolveCarriedArtifact({ status: 'working', currentTool: 'Write' })?.kind, 'billet');
    assert.equal(resolveCarriedArtifact({ status: 'working', currentTool: 'Read' })?.kind, 'scroll');
    assert.equal(resolveCarriedArtifact({ status: 'working', currentTool: 'Grep' })?.kind, 'scroll');
    assert.equal(resolveCarriedArtifact({ status: 'working', currentTool: 'Glob' })?.kind, 'scroll');
    assert.equal(resolveCarriedArtifact({ status: 'working', currentTool: 'WebFetch' })?.kind, 'letter');
    assert.equal(resolveCarriedArtifact({ status: 'working', currentTool: 'mcp__github__list' })?.kind, 'letter');
    assert.equal(resolveCarriedArtifact({ status: 'working', currentTool: 'Agent' })?.kind, 'orders');
    assert.equal(resolveCarriedArtifact({ status: 'working', permissionMode: 'plan' })?.kind, 'plan');
    assert.equal(resolveCarriedArtifact({
        status: 'working',
        lastResults: [{ exitCode: 0, exitCodeSource: 'exit', completedAt: T0 }],
    }, { now: T0 + 1000 })?.kind, 'proof');

    // Never draw on casual strolls, idle walks, departed, or stale states.
    assert.equal(resolveCarriedArtifact({ status: 'working', currentTool: 'Edit' }, { casualStroll: true }), null);
    assert.equal(resolveCarriedArtifact({ status: 'working', currentTool: 'Edit' }, { idleWalk: true }), null);
    assert.equal(resolveCarriedArtifact({ status: 'idle', currentTool: 'Edit' }), null);
    assert.equal(resolveCarriedArtifact({ status: 'completed', currentTool: 'Edit' }), null);
    assert.equal(resolveCarriedArtifact({ status: 'working', currentTool: 'Edit', signalStale: true }), null);
    assert.equal(resolveCarriedArtifact({ status: 'working', currentTool: 'Edit', freshness: { state: 'stale' } }), null);
    assert.equal(resolveCarriedArtifact({ status: 'working', currentTool: 'Edit', isDeparted: true }), null);
});

test('body-column slots, one-of rule, and EFFECT_BUDGET carried-artifacts shed before carried-lanterns', () => {
    // Walking trailing hand (opposite facing lantern hand).
    const bounds = { minX: 10, minY: 20, width: 100, height: 100 };
    assert.deepEqual(artifactWalkingAnchor({ bounds, west: false }), { x: 38, y: 82 });
    assert.deepEqual(artifactWalkingAnchor({ bounds, west: true }), { x: 82, y: 82 });
    assert.deepEqual(artifactWalkingAnchor({ bounds, west: false, anchors: { trailingWrist: { x: 44, y: 77 } } }), { x: 44, y: 77 });

    // Set down mirror of LANTERN_SET_DOWN: east -> x [-15..-9], west -> x [+9..+15], bottom y = +2.
    const eastRect = artifactSetDownRect({ footX: 100, footY: 200, west: false });
    assert.deepEqual(eastRect, { x: 85, y: 196, w: 6, h: 6 });
    assert.equal(eastRect.y + eastRect.h, 202);
    const westRect = artifactSetDownRect({ footX: 100, footY: 200, west: true });
    assert.deepEqual(westRect, { x: 109, y: 196, w: 6, h: 6 });
    assert.equal(westRect.y + westRect.h, 202);

    // One-of rule (§2.4): walking && zoom >= 2 && hasArtifact suppresses tool glyph.
    assert.equal(shouldSuppressToolGlyphForArtifact({ walking: true, zoom: 2, hasArtifact: true }), true);
    assert.equal(shouldSuppressToolGlyphForArtifact({ walking: true, zoom: 3, hasArtifact: true }), true);
    assert.equal(shouldSuppressToolGlyphForArtifact({ walking: true, zoom: 1.5, hasArtifact: true }), false);
    assert.equal(shouldSuppressToolGlyphForArtifact({ walking: false, zoom: 2, hasArtifact: true }), false);
    assert.equal(shouldSuppressToolGlyphForArtifact({ walking: true, zoom: 2, hasArtifact: false }), false);

    // EFFECT_BUDGET['carried-artifacts'] is 48/24/0 and sheds BEFORE carried-lanterns.
    assert.deepEqual([0, 1, 2].map(lvl => effectBudgetMode('carried-artifacts', lvl)), [48, 24, 0]);
    const keys = Object.keys(EFFECT_BUDGET);
    const artifactsIdx = keys.indexOf('carried-artifacts');
    const lanternsIdx = keys.indexOf('carried-lanterns');
    assert.ok(artifactsIdx >= 0 && lanternsIdx > artifactsIdx, 'carried-artifacts sheds before carried-lanterns');

    // Zoom gate & nearest-centre selection cap.
    const candidates = [
        { id: 'far', x: 500, y: 0, artifact: { kind: 'billet' } },
        { id: 'near', x: 10, y: 0, artifact: { kind: 'scroll' } },
        { id: 'mid', x: 100, y: 0, artifact: { kind: 'letter' } },
    ];
    assert.equal(selectCarriedArtifacts(candidates, { budget: 48, zoom: 1.5 }).length, 0);
    assert.deepEqual(
        selectCarriedArtifacts(candidates, { budget: 2, zoom: 2, centre: { x: 0, y: 0 } }).map(c => c.id),
        ['near', 'mid'],
    );
});

// ---------------------------------------------------------------------------
// 2. Report Cairn exactness & MarkGovernor admission (§2.2)
// ---------------------------------------------------------------------------

test('report cairn draws exact units <= 5 (max 5x14) and a single 5x6 bundle > 5', () => {
    assert.equal(reportCairnSpec({ returned: 0, outstanding: 0 }), null);

    const exact5 = reportCairnSpec({
        returned: 3,
        outstanding: 2,
        returnedTrims: ['#a78bfa', '#4ade80', '#60a5fa'],
    });
    assert.equal(exact5.mode, 'exact');
    assert.equal(exact5.width, CAIRN_WIDTH);
    assert.equal(exact5.height, CAIRN_MAX_EXACT_HEIGHT); // 5x14
    assert.equal(exact5.units.length, 5);
    assert.deepEqual(exact5.units.map(u => u.state), ['returned', 'returned', 'returned', 'outstanding', 'outstanding']);
    assert.equal(exact5.units[1].trim, '#4ade80');
    assert.equal(exact5.label, '3 back · 2 out');

    // > 5 becomes ONE 5x6 bound bundle (never 5 units standing for "many").
    const bundle = reportCairnSpec({ returned: 7, outstanding: 3 });
    assert.equal(bundle.mode, 'bundle');
    assert.equal(bundle.width, CAIRN_BUNDLE_WIDTH);
    assert.equal(bundle.height, CAIRN_BUNDLE_HEIGHT); // 5x6
    assert.equal(bundle.units.length, 0);
    assert.equal(bundle.label, '7 back · 3 out');
    assert.equal(formatCairnLabel(4, 0), '4 back');
    assert.equal(formatCairnLabel(0, 2), '2 out');
});

test('report cairn MarkGovernor admission tries trailing (-s*22..-s*17), falls back to facing (+s*17..+s*22), else skips', () => {
    const gov = new MarkGovernor();
    gov.beginFrame();

    // Unobstructed -> trailing side at x = footX - 22 .. footX - 17 (east-facing).
    const first = admitReportCairn({ id: 'lead-1', footX: 100, footY: 200, west: false, returned: 2, outstanding: 1, governor: gov });
    assert.equal(first.side, 'trailing');
    assert.equal(first.rect.x, 78);
    assert.equal(first.rect.x + first.rect.w, 83);
    assert.equal(first.rect.y + first.rect.h, 202);

    // Block trailing side with a PRIMARY rect -> falls back to facing side (+17..+22).
    gov.beginFrame();
    gov.reserve({ x: 75, y: 185, w: 12, h: 20 }, MarkTier.PRIMARY, 'body-left');
    const second = admitReportCairn({ id: 'lead-2', footX: 100, footY: 200, west: false, returned: 2, outstanding: 1, governor: gov });
    assert.equal(second.side, 'facing');
    assert.equal(second.rect.x, 117);
    assert.equal(second.rect.x + second.rect.w, 122);

    // Block BOTH sides -> skipped cleanly (null).
    gov.beginFrame();
    gov.reserve({ x: 75, y: 185, w: 12, h: 20 }, MarkTier.PRIMARY, 'body-left');
    gov.reserve({ x: 115, y: 185, w: 12, h: 20 }, MarkTier.PRIMARY, 'body-right');
    const skipped = admitReportCairn({ id: 'lead-3', footX: 100, footY: 200, west: false, returned: 2, outstanding: 1, governor: gov });
    assert.equal(skipped, null);
});

// ---------------------------------------------------------------------------
// 3. Workflow Ribbon Key & Assignment (§3.5)
// ---------------------------------------------------------------------------

test('workflowGroupKey uses workflowId or provider:parentSessionId:workflowName, never bare workflowName', () => {
    assert.equal(workflowGroupKey({ workflowId: 'wf_123', workflowName: 'sweep', parentSessionId: 'p1', provider: 'claude' }), 'wf_123');
    assert.equal(
        workflowGroupKey({ workflowId: null, workflowName: 'audit-lane', parentSessionId: 'parent-9', provider: 'antigravity' }),
        'antigravity:parent-9:audit-lane',
    );
    // NEVER bare workflowName alone!
    assert.equal(workflowGroupKey({ workflowId: null, workflowName: 'audit-lane', parentSessionId: null, provider: 'antigravity' }), null);
    assert.equal(workflowGroupKey({ workflowId: '', workflowName: 'audit-lane', provider: 'claude' }), null);
    assert.equal(workflowGroupKey({ workflowId: null, workflowName: null, parentSessionId: 'p1' }), null);

    // Sanitization strips control chars and truncates at 32 chars + ellipsis.
    assert.equal(sanitizeWorkflowLabel('hello\u0000\u0007\nworld'), 'helloworld');
    const longName = 'a'.repeat(40);
    assert.equal(sanitizeWorkflowLabel(longName), `${'a'.repeat(32)}…`);
});

test('assignWorkflowRibbons caps at 2 concurrent ribbons per parent and reports exact run count', () => {
    const agents = [
        { id: 'c1', parentSessionId: 'lead', provider: 'claude', workflowId: 'wf_1', workflowName: 'Run One', turnStartedAt: 1000 },
        { id: 'c2', parentSessionId: 'lead', provider: 'claude', workflowId: 'wf_1', workflowName: 'Run One', turnStartedAt: 1005 },
        { id: 'c3', parentSessionId: 'lead', provider: 'claude', workflowId: 'wf_2', workflowName: 'Run Two', turnStartedAt: 2000 },
        { id: 'c4', parentSessionId: 'lead', provider: 'antigravity', workflowId: null, workflowName: 'Run Three', turnStartedAt: 3000 },
    ];
    const { byAgentId, byParentId } = assignWorkflowRibbons(agents);
    assert.equal(byAgentId.get('c1').slot, 0);
    assert.equal(byAgentId.get('c2').slot, 0);
    assert.equal(byAgentId.get('c3').slot, 1);
    assert.equal(byAgentId.get('c4').slot, null, '3rd concurrent run gets no ribbon');
    assert.equal(byAgentId.get('c4').runCount, 3);
    assert.equal(byAgentId.get('c4').runCountLabel, '3 runs');
    assert.equal(byParentId.get('lead').runCountLabel, '3 runs');
});

// ---------------------------------------------------------------------------
// 4. Claude compact_boundary -> compactions[] + compactionCount (§3.2)
// ---------------------------------------------------------------------------

test('Claude compact_boundary extracts, validates, redacts, deduplicates, handles sidechains, and distinguishes [] vs null', () => {
    const tmp = makeTempDir('w3c-claude-compactions');
    const mainFile = path.join(tmp, 'main-session.jsonl');
    const subDir = path.join(tmp, 'main-session', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    const subFile = path.join(subDir, 'agent-child1.jsonl');
    const emptyFile = path.join(tmp, 'empty-session.jsonl');

    const lines = [
        // 1. Valid manual boundary with secret/extra metadata that MUST be redacted
        {
            type: 'system',
            subtype: 'compact_boundary',
            isSidechain: false,
            timestamp: '2026-11-26T10:00:00.000Z',
            uuid: 'u-1',
            content: 'SECRET PROMPT TEXT',
            compactMetadata: {
                trigger: 'manual',
                preTokens: 412300,
                postTokens: 38100,
                durationMs: 91000,
                cumulativeDroppedTokens: 999999,
                preservedSegment: 'secret-segment',
                preservedMessages: ['secret-msg'],
                preCompactDiscoveredTools: ['SecretTool'],
            },
        },
        // 2. Duplicate uuid -> MUST be deduplicated
        {
            type: 'system',
            subtype: 'compact_boundary',
            isSidechain: false,
            timestamp: '2026-11-26T10:00:00.000Z',
            uuid: 'u-1',
            compactMetadata: { trigger: 'manual', preTokens: 412300, postTokens: 38100, durationMs: 91000 },
        },
        // 3. Malformed: bad timestamp -> dropped
        {
            type: 'system',
            subtype: 'compact_boundary',
            timestamp: 'not-a-timestamp',
            uuid: 'u-bad-ts',
            compactMetadata: { trigger: 'auto', preTokens: 50000, postTokens: 10000 },
        },
        // 4. Malformed: preTokens out of range (0 / >10M / non-integer) -> dropped
        {
            type: 'system',
            subtype: 'compact_boundary',
            timestamp: '2026-11-26T10:01:00.000Z',
            uuid: 'u-bad-pre-0',
            compactMetadata: { trigger: 'auto', preTokens: 0 },
        },
        {
            type: 'system',
            subtype: 'compact_boundary',
            timestamp: '2026-11-26T10:01:05.000Z',
            uuid: 'u-bad-pre-big',
            compactMetadata: { trigger: 'auto', preTokens: 10_000_001 },
        },
        // 5. Valid with bad postTokens (> preTokens), bad durationMs (> 3.6M), unknown trigger -> field-nulled & whitelisted
        {
            type: 'system',
            subtype: 'compact_boundary',
            timestamp: '2026-11-26T10:02:00.000Z',
            uuid: 'u-2',
            compactMetadata: { trigger: 'cron-hack', preTokens: 100000, postTokens: 120000, durationMs: 4_000_000 },
        },
        // 6. Sidechain boundary inside main transcript -> MUST NOT count on main session
        {
            type: 'system',
            subtype: 'compact_boundary',
            isSidechain: true,
            timestamp: '2026-11-26T10:03:00.000Z',
            uuid: 'u-sidechain',
            compactMetadata: { trigger: 'auto', preTokens: 200000, postTokens: 20000, durationMs: 5000 },
        },
        // 7-9. Three more valid main boundaries -> total 5, compactions[] keeps oldest-first last 4
        {
            type: 'system',
            subtype: 'compact_boundary',
            timestamp: '2026-11-26T10:04:00.000Z',
            uuid: 'u-3',
            compactMetadata: { trigger: 'auto', preTokens: 250000, postTokens: 25000, durationMs: 12000 },
        },
        {
            type: 'system',
            subtype: 'compact_boundary',
            timestamp: '2026-11-26T10:05:00.000Z',
            uuid: 'u-4',
            compactMetadata: { trigger: 'manual', preTokens: 300000, postTokens: 30000, durationMs: 15000 },
        },
        {
            type: 'system',
            subtype: 'compact_boundary',
            timestamp: '2026-11-26T10:06:00.000Z',
            uuid: 'u-5',
            compactMetadata: { trigger: 'auto', preTokens: 350000, postTokens: 35000, durationMs: 18000 },
        },
    ];
    fs.writeFileSync(mainFile, `${lines.map(r => JSON.stringify(r)).join('\n')}\n`);
    fs.writeFileSync(subFile, `${JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        isSidechain: true,
        timestamp: '2026-11-26T10:03:00.000Z',
        uuid: 'u-sub-1',
        compactMetadata: { trigger: 'auto', preTokens: 200000, postTokens: 20000, durationMs: 5000 },
    })}\n`);
    fs.writeFileSync(emptyFile, `${JSON.stringify({ type: 'user', timestamp: '2026-11-26T10:00:00.000Z', message: { role: 'user', content: 'hi' } })}\n`);

    const mainProj = claudeTest.getTranscriptProjection(mainFile, '/tmp/demo', 'claude-opus-4-6');
    assert.equal(mainProj.compactionCount, 5);
    assert.equal(mainProj.compactions.length, 4, 'keeps last 4 oldest-first');
    assert.deepEqual(mainProj.compactions.map(c => c.preTokens), [100000, 250000, 300000, 350000]);
    assert.equal(mainProj.compactions[0].trigger, 'unknown');
    assert.equal(mainProj.compactions[0].postTokens, null);
    assert.equal(mainProj.compactions[0].durationMs, null);
    // Strict 5-field redaction check
    for (const c of mainProj.compactions) {
        assert.deepEqual(Object.keys(c).sort(), ['at', 'durationMs', 'postTokens', 'preTokens', 'trigger']);
    }

    // Subagent file owns its own sidechain boundary
    const subProj = claudeTest.getTranscriptProjection(subFile, '/tmp/demo', 'claude-opus-4-6', 'claude', { isSubagent: true });
    assert.equal(subProj.compactionCount, 1);
    assert.equal(subProj.compactions.length, 1);
    assert.equal(subProj.compactions[0].preTokens, 200000);

    // Scanned Claude session with zero boundaries -> [] and 0
    const emptyProj = claudeTest.getTranscriptProjection(emptyFile, '/tmp/demo', 'claude-opus-4-6');
    assert.deepEqual(emptyProj.compactions, []);
    assert.equal(emptyProj.compactionCount, 0);

    // Unscanned / missing file -> null and null
    const unscannedProj = claudeTest.getTranscriptProjection(null, '/tmp/demo', 'claude-opus-4-6');
    assert.equal(unscannedProj.compactions, null);
    assert.equal(unscannedProj.compactionCount, null);

    // Normalization gate in adapters/index.js: null on non-Claude, validated array on Claude
    const normCodex = normalizeSession({ sessionId: 'c1', provider: 'codex', compactions: mainProj.compactions, compactionCount: 5 });
    assert.equal(normCodex.compactions, null);
    assert.equal(normCodex.compactionCount, null);

    const normClaude = normalizeSession({ sessionId: 's1', provider: 'claude', compactions: mainProj.compactions, compactionCount: 5 });
    assert.equal(normClaude.compactions.length, 4);
    assert.equal(normClaude.compactionCount, 5);

    const normClaudeEmpty = normalizeSession({ sessionId: 's2', provider: 'claude', compactions: [], compactionCount: 0 });
    assert.deepEqual(normClaudeEmpty.compactions, []);
    assert.equal(normClaudeEmpty.compactionCount, 0);

    // Domain Agent + AgentManager signature tracking
    const basePayload = { id: 's1', provider: 'claude', compactions: [], compactionCount: 0 };
    const nextPayload = { id: 's1', provider: 'claude', compactions: mainProj.compactions, compactionCount: 5 };
    assert.notEqual(digestAgentPayload(basePayload), digestAgentPayload(nextPayload));

    const world = new World();
    const manager = new AgentManager(world, { getSessions: async () => [], getTeams: async () => [] });
    manager.handleWebSocketMessage({ sessions: [normClaude] });
    const entity = world.agents.get('s1');
    assert.ok(entity instanceof Agent);
    assert.equal(entity.compactionCount, 5);
    assert.equal(entity.compactions.length, 4);
    manager.stop();

    // adapters/README.md updated for compactions & Antigravity workflowName
    const readme = fs.readFileSync(path.resolve('claudeville/adapters/README.md'), 'utf8');
    assert.match(readme, /`compactions`/);
    assert.match(readme, /`compactionCount`/);
    assert.doesNotMatch(readme, /\| `workflowName` \| string \\\| null \| Claude-only\./);

    fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 5. adapters/gitEvents.js · GH_CHECK_COMMANDS full truth table (§3.3)
// ---------------------------------------------------------------------------

test('GH_EVENT_TYPES stays strictly { pr, issue, release } and findGhCheckCommand skips global flags', () => {
    assert.deepEqual([...gitTest.GH_EVENT_TYPES].sort(), ['issue', 'pr', 'release']);
    assert.deepEqual(
        gitTest.findGhCheckCommand(['gh', '-R', 'org/repo', '--hostname=github.com', 'pr', 'checks', '12']),
        { source: 'pr', action: 'checks', actionIndex: 5 },
    );
    assert.deepEqual(
        gitTest.findGhCheckCommand(['gh', '--repo=org/repo', 'run', 'watch', '--exit-status']),
        { source: 'run', action: 'watch', actionIndex: 3 },
    );
    assert.equal(gitTest.findGhCheckCommand(['gh', 'pr', 'create']), null);
});

test('gh pr checks & gh run watch follow exact §3.3 outcome table, redaction, chains, and 8-per-project cap', () => {
    const baseCtx = {
        project: '/tmp/demo-checks',
        provider: 'claude',
        sessionId: 'sess-1',
        sourceId: 'call-1',
        ts: T0,
        completedAt: T0 + 2000,
    };

    // gh pr checks: exit 0 (any source) -> pass, bare numeric PR selector
    const [prPass] = parseGitEventsFromCommand('gh pr checks 12 --watch', {
        ...baseCtx,
        exitCode: 0,
        exitCodeSource: 'flag',
        output: 'All checks were successful',
    });
    assert.equal(prPass.type, 'checks');
    assert.match(prPass.id, /^git-checks-[0-9a-f]{16}$/);
    assert.equal(prPass.command, 'gh pr checks');
    assert.equal(prPass.source, 'pr');
    assert.equal(prPass.watch, true);
    assert.equal(prPass.outcome, 'pass');
    assert.equal(prPass.exitCode, 0);
    assert.equal(prPass.exitCodeSource, 'flag');
    assert.equal(prPass.pr, 12);
    assert.equal(prPass.inferred, false);
    assert.equal(prPass.observed, true);
    assert.equal(prPass.confidence, 0.9);
    assert.equal(prPass.url, undefined);
    assert.equal(prPass.branch, undefined);

    // gh pr checks: --watch=false -> watch: false; URL selector extracts pr number without storing URL
    const [prUrl] = parseGitEventsFromCommand('gh pr checks https://github.com/acme/demo/pull/42 --watch=false', {
        ...baseCtx,
        exitCode: 0,
        exitCodeSource: 'exit',
    });
    assert.equal(prUrl.watch, false);
    assert.equal(prUrl.pr, 42);
    assert.equal(prUrl.url, undefined);
    assert.equal(prUrl.command, 'gh pr checks');

    // gh pr checks: branch selector -> pr: null, branch never stored
    const [prBranch] = parseGitEventsFromCommand('gh pr checks feat/secret-branch', {
        ...baseCtx,
        exitCode: 8,
        exitCodeSource: 'exit',
    });
    assert.equal(prBranch.pr, null);
    assert.equal(prBranch.outcome, 'pending');
    assert.equal(prBranch.branch, undefined);

    // gh pr checks: exit 8 with source flag -> unknown (only source exit yields pending)
    const [prPendingFlag] = parseGitEventsFromCommand('gh pr checks 12', {
        ...baseCtx,
        exitCode: 8,
        exitCodeSource: 'flag',
    });
    assert.equal(prPendingFlag.outcome, 'unknown');

    // gh pr checks: exit 1 + source exit + fail evidence -> fail
    const [prFailLine] = parseGitEventsFromCommand('gh pr checks 12', {
        ...baseCtx,
        exitCode: 1,
        exitCodeSource: 'exit',
        output: 'build\tfail\t32s\thttps://github.com/acme/demo/actions/runs/1',
    });
    assert.equal(prFailLine.outcome, 'fail');

    const [prFailCount] = parseGitEventsFromCommand('gh pr checks 12', {
        ...baseCtx,
        exitCode: 1,
        exitCodeSource: 'exit',
        output: 'Some checks were not successful: 2 failing, 3 successful',
    });
    assert.equal(prFailCount.outcome, 'fail');

    // gh pr checks: exit 1 without fail evidence -> unknown
    const [prNoPr] = parseGitEventsFromCommand('gh pr checks 12', {
        ...baseCtx,
        exitCode: 1,
        exitCodeSource: 'exit',
        output: 'no pull requests found for branch "main"',
    });
    assert.equal(prNoPr.outcome, 'unknown');

    // gh pr checks: is_error with no exit code (source flag) -> unknown
    const [prFlagErr] = parseGitEventsFromCommand('gh pr checks 12', {
        ...baseCtx,
        success: false,
        exitCodeSource: 'flag',
        output: 'build fail',
    });
    assert.equal(prFlagErr.outcome, 'unknown');

    // gh run watch --exit-status: exit 0 -> pass; non-zero source exit -> fail
    const [runPass] = parseGitEventsFromCommand('gh run watch 999 --exit-status', {
        ...baseCtx,
        exitCode: 0,
        exitCodeSource: 'exit',
    });
    assert.equal(runPass.command, 'gh run watch');
    assert.equal(runPass.source, 'run');
    assert.equal(runPass.watch, true);
    assert.equal(runPass.outcome, 'pass');
    assert.equal(runPass.pr, null);

    const [runFail] = parseGitEventsFromCommand('gh run watch 999 --exit-status', {
        ...baseCtx,
        exitCode: 1,
        exitCodeSource: 'exit',
    });
    assert.equal(runFail.outcome, 'fail');

    // gh run watch WITHOUT --exit-status -> always unknown
    const [runNoFlag] = parseGitEventsFromCommand('gh run watch 999', {
        ...baseCtx,
        exitCode: 0,
        exitCodeSource: 'exit',
    });
    assert.equal(runNoFlag.watch, true);
    assert.equal(runNoFlag.outcome, 'unknown');

    // Interrupted / rejected / --help / incomplete -> NO event
    assert.deepEqual(parseGitEventsFromCommand('gh pr checks 12', { ...baseCtx, interrupted: true }), []);
    assert.deepEqual(parseGitEventsFromCommand('gh pr checks 12', { ...baseCtx, status: 'cancelled' }), []);
    assert.deepEqual(parseGitEventsFromCommand('gh pr checks 12', { ...baseCtx, rejected: true }), []);
    assert.deepEqual(parseGitEventsFromCommand('gh pr checks --help', { ...baseCtx, exitCode: 0 }), []);
    assert.deepEqual(parseGitEventsFromCommand('gh pr checks 12', { project: '/tmp/demo', ts: T0 }), []);

    // Chains follow outcomeFromExit rule
    const [chainAndPass] = parseGitEventsFromCommand('gh pr checks 12 && echo ok', {
        ...baseCtx,
        exitCode: 0,
        exitCodeSource: 'exit',
    });
    assert.equal(chainAndPass.outcome, 'pass');

    const [chainAndFailNotLast] = parseGitEventsFromCommand('gh pr checks 12 && npm test', {
        ...baseCtx,
        exitCode: 1,
        exitCodeSource: 'exit',
        output: 'build fail',
    });
    assert.equal(chainAndFailNotLast.outcome, 'unknown', 'not last segment & non-zero -> unknown');

    const [chainSemi] = parseGitEventsFromCommand('gh pr checks 12; echo ok', {
        ...baseCtx,
        exitCode: 0,
        exitCodeSource: 'exit',
    });
    assert.equal(chainSemi.outcome, 'unknown');

    // Bound to max 8 checks events per project (newest kept)
    const manyChecks = Array.from({ length: 12 }, (_, i) => ({
        id: `git-checks-${String(i).padStart(16, '0')}`,
        type: 'checks',
        project: '/tmp/demo-checks',
        outcome: 'pass',
        ts: T0 + i * 1000,
    }));
    const capped = dedupeGitEvents(manyChecks, { scrubbed: true });
    assert.equal(MAX_CHECKS_EVENTS_PER_PROJECT, 8);
    assert.equal(capped.length, 8);
    assert.equal(capped[0].id, 'git-checks-0000000000000004');
    assert.equal(capped[7].id, 'git-checks-0000000000000011');
});

// ---------------------------------------------------------------------------
// 6. Compaction Rite (ArrivalDeparture.js) & Harbor Checks (HarborTraffic.js)
// ---------------------------------------------------------------------------

test('formatCompactionChit and compaction rite live-only / 120s gating', () => {
    assert.equal(formatCompactionChit({ preTokens: 412300, postTokens: 38100 }), '412K → 38K');
    assert.equal(formatCompactionChit({ preTokens: 412300, postTokens: null }), '412K');
    assert.equal(formatCompactionChit({ preTokens: 1_200_000, postTokens: 38100 }), '1.2M → 38K');
    assert.equal(formatCompactionChit({ preTokens: 1_240_000, postTokens: null }), '1.2M');
    assert.equal(formatCompactionChit(null), null);

    const ctrl = new ArrivalDepartureController();
    const sprite = { x: 100, y: 200 };
    const agent = {
        id: 'a1',
        compactions: [{ at: T0 - 5000, trigger: 'manual', preTokens: 412300, postTokens: 38100, durationMs: 9000 }],
    };

    // Page load / initial sighting never plays!
    assert.deepEqual(ctrl.observeAgentCompactions(agent, sprite, { wallNow: T0, now: 1000, initialLoad: true }), []);
    assert.equal(ctrl.compactions.size, 0);

    // Backfill older than 120s never plays!
    const oldAgent = {
        id: 'a1',
        compactions: [
            ...agent.compactions,
            { at: T0 - COMPACTION_RITE_WINDOW_MS - 1000, trigger: 'auto', preTokens: 200000, postTokens: 20000, durationMs: 4000 },
        ],
    };
    assert.deepEqual(ctrl.observeAgentCompactions(oldAgent, sprite, { wallNow: T0, now: 1200 }), []);
    assert.equal(ctrl.compactions.size, 0);

    // Unseen compaction within 120s plays ONCE!
    const liveAgent = {
        id: 'a1',
        compactions: [
            ...oldAgent.compactions,
            { at: T0 - 2000, trigger: 'auto', preTokens: 500000, postTokens: 40000, durationMs: 6000 },
        ],
    };
    const started = ctrl.observeAgentCompactions(liveAgent, sprite, { wallNow: T0, now: 2000 });
    assert.equal(started.length, 1);
    assert.equal(started[0].chit, '500K → 40K');
    assert.equal(ctrl.compactions.size, 1);

    // Same compaction on next poll never replays!
    assert.deepEqual(ctrl.observeAgentCompactions(liveAgent, sprite, { wallNow: T0 + 1000, now: 3000 }), []);
});

test('HarborTraffic hoists checks pass pennant, fires Lighthouse flash once, brackets fail, and clears on merge/expiry/pending', () => {
    const harbor = new HarborTraffic();
    const project = '/tmp/harbor-checks';

    // 1. Pass with NO cutter still triggers one-shot Lighthouse lamp flash.
    harbor.observeChecksEvents([{
        id: 'git-checks-nocutter00000001',
        type: 'checks',
        project,
        pr: 99,
        outcome: 'pass',
        ts: T0,
        completedAt: T0,
    }], T0);
    assert.equal(harbor.consumeChecksPassFlash(), true);
    assert.equal(harbor.consumeChecksPassFlash(), false, 'flash is one-shot');

    // 2. Moor two PR cutters (#10 older, #12 newer).
    const pr10 = { id: 'pr:c10', prShip: true, project, prUrl: 'https://github.com/a/b/pull/10', label: 'PR #10', status: 'anchored', arrivingKind: 'pr', prCreatedAt: T0 - 10_000, berthIndex: 0 };
    const pr12 = { id: 'pr:c12', prShip: true, project, prUrl: 'https://github.com/a/b/pull/12', label: 'PR #12', status: 'anchored', arrivingKind: 'pr', prCreatedAt: T0 - 5_000, berthIndex: 1 };
    harbor.state.ships.set(pr10.id, pr10);
    harbor.state.ships.set(pr12.id, pr12);

    // Pass matching PR #10 explicitly
    harbor.observeChecksEvents([{
        id: 'git-checks-pr10pass00000001',
        type: 'checks',
        project,
        pr: 10,
        outcome: 'pass',
        ts: T0 + 1000,
        completedAt: T0 + 1000,
    }], T0 + 1000);
    assert.equal(harbor.checksStateForShip(pr10, T0 + 1000)?.outcome, 'pass');
    assert.equal(harbor.checksStateForShip(pr12, T0 + 1000), null);
    assert.equal(harbor.consumeChecksPassFlash(), true);

    // Fail with pr: null matches newest PR cutter (#12) and creates a failure bracket mark
    harbor.observeChecksEvents([{
        id: 'git-checks-pr12fail00000001',
        type: 'checks',
        project,
        pr: null,
        outcome: 'fail',
        ts: T0 + 2000,
        completedAt: T0 + 2000,
    }], T0 + 2000);
    assert.equal(harbor.checksStateForShip(pr12, T0 + 2000)?.outcome, 'fail');
    const marks = harbor._failureBracketMarks(T0 + 2000);
    assert.ok(marks.some(m => m.key === `checks:${pr12.id}` && m.status === 'failed'));

    // Next checks event (`pending` / `unknown`) clears the previous pass pennant and draws nothing
    harbor.observeChecksEvents([{
        id: 'git-checks-pr10pend00000001',
        type: 'checks',
        project,
        pr: 10,
        outcome: 'pending',
        ts: T0 + 3000,
        completedAt: T0 + 3000,
    }], T0 + 3000);
    assert.equal(harbor.checksStateForShip(pr10, T0 + 3000), null);

    // Expiry after 60 min clears active checks state
    assert.equal(harbor.checksStateForShip(pr12, T0 + 2000 + CHECKS_PENNANT_HOLD_MS + 1), null);

    // Re-pass #10 then merge #10 -> merge clears pennant
    harbor.observeChecksEvents([{
        id: 'git-checks-pr10pass00000002',
        type: 'checks',
        project,
        pr: 10,
        outcome: 'pass',
        ts: T0 + 4000,
        completedAt: T0 + 4000,
    }], T0 + 4000);
    assert.equal(harbor.checksStateForShip(pr10, T0 + 4000)?.outcome, 'pass');
    pr10.arrivingKind = 'pr-merge';
    pr10.prMergedAt = T0 + 5000;
    assert.equal(harbor.checksStateForShip(pr10, T0 + 5000), null);
});

// ---------------------------------------------------------------------------
// 7. Chronicle Loom Meta Prep: DB_VERSION = 7, COMPACTED, RELEASE, coverage/sky (§5.4)
// ---------------------------------------------------------------------------

test('ChronicleStore keeps DB_VERSION = 7 and provides 96-bit coverage + 24-hour sky meta helpers', async () => {
    assert.equal(DB_VERSION, 7);
    assert.equal(COVERAGE_QUARTERS, 96);
    assert.equal(EMPTY_COVERAGE_MASK.length, 24);
    assert.equal(SKY_HOURS, 24);
    assert.equal(coverageMetaKey('2026-11-26'), 'coverage:2026-11-26');
    assert.equal(skyMetaKey('2026-11-26'), 'sky:2026-11-26');

    // Pure 96-bit quarter-hour bitmask operations across low, mid, and top (95) bits.
    let mask = EMPTY_COVERAGE_MASK;
    mask = setCoverageQuarter(mask, 0);
    mask = setCoverageQuarter(mask, 47);
    mask = setCoverageQuarter(mask, 95);
    assert.equal(mask.length, 24);
    assert.equal(hasCoverageQuarter(mask, 0), true);
    assert.equal(hasCoverageQuarter(mask, 47), true);
    assert.equal(hasCoverageQuarter(mask, 95), true);
    assert.equal(hasCoverageQuarter(mask, 1), false);
    assert.equal(hasCoverageQuarter(mask, 96), false);
    assert.equal(hasCoverageQuarter(mergeCoverageMasks(setCoverageQuarter(EMPTY_COVERAGE_MASK, 10), mask), 10), true);

    const sampleTime = new Date(2026, 10, 26, 14, 32, 0, 0).getTime();
    assert.equal(quarterIndexForTime(sampleTime), 14 * 4 + 2);

    // Fake meta-capable store tests ChronicleLog coverage:<dateKey> & sky:<dateKey>
    const meta = new Map();
    const rows = [];
    const store = {
        async put(name, record) {
            if (name === 'meta') meta.set(record.key, record.value);
            else rows.push(record);
            return record;
        },
        async getMeta(key, fallback = null) { return meta.has(key) ? meta.get(key) : fallback; },
        async setMeta(key, value) { meta.set(key, value); return { key, value }; },
        async queryRange() { return [...rows].sort((a, b) => a.ts - b.ts); },
    };

    const log = new ChronicleLog({ store }).start();
    await log.flush();

    const writtenMask = await log.recordCoverageQuarter(sampleTime);
    assert.equal(hasCoverageQuarter(writtenMask, 58), true);
    assert.equal(meta.get('coverage:2026-11-26'), writtenMask);
    assert.equal(await log.readDayCoverage('2026-11-26'), writtenMask);

    const skySlots = await log.recordSkyHour({ cloud: 2, rain: 1, snow: 0, moon: 4, extra: 'ignored' }, sampleTime);
    assert.equal(skySlots.length, 24);
    assert.deepEqual(skySlots[14], { cloud: 2, rain: 1, snow: 0, moon: 4 });
    assert.equal(skySlots[13], null);
    assert.deepEqual(await log.readDaySky('2026-11-26'), normalizeDaySky(meta.get('sky:2026-11-26')));

    // COMPACTED logged only for live-watched boundaries, with { pre, post }
    const now = Date.now();
    const liveAgent = {
        id: 'claude-1',
        name: 'Ada',
        provider: 'claude',
        projectPath: '/tmp/demo',
        gitEvents: [],
        compactions: [
            { at: now - 3 * 3600_000, trigger: 'manual', preTokens: 100000, postTokens: 10000, durationMs: 5000 }, // stale backfill -> ignored
            { at: now - 5_000, trigger: 'auto', preTokens: 412300, postTokens: 38100, durationMs: 9000 },
        ],
    };
    log._onUpdated(liveAgent);
    log._onUpdated(liveAgent); // deduped

    // RELEASE logged when verified outcome is a release
    eventBus.emit(VERIFIED_OUTCOME_EVENT, {
        kind: 'release',
        project: '/tmp/demo',
        agentId: 'claude-1',
        at: now - 2_000,
    });
    await log.flush();
    log.stop();

    const compacted = rows.filter(r => r.kind === ChronicleEventKind.COMPACTED);
    assert.equal(compacted.length, 1);
    assert.equal(compacted[0].pre, 412300);
    assert.equal(compacted[0].post, 38100);

    const releases = rows.filter(r => r.kind === ChronicleEventKind.RELEASE);
    assert.equal(releases.length, 1);

    const summary = summarizeDay(rows);
    assert.equal(summary.compactions, 1);
    assert.equal(summary.releases, 1);
});
