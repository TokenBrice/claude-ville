#!/usr/bin/env node

// Runs against an isolated server from this checkout unless CLAUDEVILLE_URL
// names one.
import assert from 'node:assert/strict';
import { launchChromium } from './support/chromium.mjs';
import { resolveServer } from './support/world-bench.mjs';

const server = await resolveServer(process.env.CLAUDEVILLE_URL || null);
const url = server.baseUrl;
let browser = null;
const pageErrors = [];

try {
    browser = await launchChromium({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(() => {
        const storageKey = 'claudeville.sidebarCollapsed';
        const originalGet = Storage.prototype.getItem;
        const originalSet = Storage.prototype.setItem;
        Storage.prototype.getItem = function getItem(key) {
            if (key === storageKey) throw new DOMException('Storage blocked', 'SecurityError');
            return originalGet.call(this, key);
        };
        Storage.prototype.setItem = function setItem(key, value) {
            if (key === storageKey) throw new DOMException('Storage blocked', 'SecurityError');
            return originalSet.call(this, key, value);
        };
    });

    await page.goto(`${url}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__claudeVilleApp?._bootState === 'ready');
    await page.waitForFunction(() => window.__claudeVilleApp?.world?.agents?.size >= 2);

    const storageAndSemantics = await page.evaluate(async () => {
        const app = window.__claudeVilleApp;
        const toggle = document.getElementById('sidebarToggle');
        const beforeCollapsed = app.sidebar.isCollapsed;
        toggle.click();
        const storageToggleWorked = app.sidebar.isCollapsed !== beforeCollapsed;

        document.getElementById('btnModeDashboard').click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const cards = [...document.querySelectorAll('.dash-card')];
        const rows = [...document.querySelectorAll('.sidebar__agent[data-agent-id]')];
        return {
            storageToggleWorked,
            cardCount: cards.length,
            rowCount: rows.length,
            cardsUseNativeSelection: cards.every(card => (
                !card.hasAttribute('role')
                && !card.hasAttribute('tabindex')
                && card.querySelector(':scope > button.dash-card__select')
            )),
            rowsUseNativeSelection: rows.every(row => (
                row.querySelector(':scope > button.sidebar__agent-select')
            )),
            nestedButtons: document.querySelectorAll('button button').length,
            toastRole: document.getElementById('toastContainer')?.getAttribute('role'),
            toastLive: document.getElementById('toastContainer')?.getAttribute('aria-live'),
        };
    });
    assert.equal(storageAndSemantics.storageToggleWorked, true);
    assert.ok(storageAndSemantics.cardCount > 0);
    assert.ok(storageAndSemantics.rowCount > 0);
    assert.equal(storageAndSemantics.cardsUseNativeSelection, true);
    assert.equal(storageAndSemantics.rowsUseNativeSelection, true);
    assert.equal(storageAndSemantics.nestedButtons, 0);
    assert.equal(storageAndSemantics.toastRole, 'status');
    assert.equal(storageAndSemantics.toastLive, 'polite');

    const firstSidebarSelect = page.locator('.sidebar__agent-select').first();
    await firstSidebarSelect.focus();
    await firstSidebarSelect.press('Enter');
    // In Dashboard mode a selection is recorded without opening the Activity
    // Panel: the Dashboard row is the detail surface there.
    await page.waitForFunction(() => Boolean(window.__claudeVilleApp?.activityPanel?.currentAgent));
    const firstDashboardSelect = page.locator('.dash-card__select').first();
    await firstDashboardSelect.focus();
    await firstDashboardSelect.press('Enter');
    assert.equal(await firstDashboardSelect.getAttribute('aria-pressed'), 'true');
    // The Activity Panel opens only in World mode; the panel probes run there.
    await page.click('#btnModeCharacter');
    await page.waitForFunction(() => window.__claudeVilleApp?.modeManager?.getCurrentMode?.() === 'character');

    const modalOpenState = await page.evaluate(() => {
        const app = window.__claudeVilleApp;
        const opener = document.getElementById('sidebarToggle');
        opener.focus();
        app.modal.open('Keyboard probe', '<button id="modalProbeAction" type="button">Action</button>');
        return {
            focus: document.activeElement?.id,
            backgroundInert: [...document.body.children]
                .filter(node => node.id !== 'modalOverlay')
                .every(node => node.inert),
        };
    });
    assert.equal(modalOpenState.focus, 'modalClose');
    assert.equal(modalOpenState.backgroundInert, true);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'modalProbeAction');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'modalClose');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'modalProbeAction');
    await page.keyboard.press('Escape');
    const modalClosedState = await page.evaluate(() => ({
        focus: document.activeElement?.id,
        backgroundActive: [...document.body.children].every(node => !node.inert),
        hidden: document.getElementById('modalOverlay')?.style.display === 'none',
    }));
    assert.equal(modalClosedState.focus, 'sidebarToggle');
    assert.equal(modalClosedState.backgroundActive, true);
    assert.equal(modalClosedState.hidden, true);

    const detailState = await page.evaluate(async () => {
        const app = window.__claudeVilleApp;
        const panel = app.activityPanel;
        const dashboard = app.dashboardRenderer;
        const { sessionDetailsService } = await import('/src/presentation/shared/SessionDetailsService.js');
        const agents = [...app.world.agents.values()].slice(0, 2);
        const [agentA, agentB] = agents;
        const originalDetail = sessionDetailsService.fetchSessionDetail;
        const originalBatch = sessionDetailsService.fetchSessionDetailsBatch;
        const originalBiography = app.biographyService.getBiography;
        let biographyReads = 0;
        app.biographyService.getBiography = (...args) => {
            biographyReads++;
            return originalBiography.apply(app.biographyService, args);
        };
        let detailMode = 'a';
        sessionDetailsService.fetchSessionDetail = async () => {
            if (detailMode === 'a') {
                return {
                    toolHistory: [{ tool: 'Bash', detail: 'SENTINEL_ACTIVITY_A' }],
                    messages: [{ role: 'assistant', text: 'SENTINEL_MESSAGE_A', ts: 1 }],
                    tokenUsage: {
                        input: 123,
                        output: 45,
                        cacheRead: 0,
                        cacheCreate: 0,
                        contextWindow: 123,
                        contextWindowMax: 1000,
                        turnCount: 2,
                    },
                };
            }
            if (detailMode === 'b-empty') return { toolHistory: [], messages: [] };
            return null;
        };

        try {
            panel.show(agentA);
            panel._stopPolling();
            await Promise.resolve();
            await Promise.resolve();
            const aText = panel.panelEl.textContent;
            const readsAfterSelection = biographyReads;
            panel._onAgentUpdated(agentA);
            await Promise.resolve();
            const genericUpdateAvoidedBiographyRead = biographyReads === readsAfterSelection;

            panel._chronicleBodyEl.textContent = 'SENTINEL_BIOGRAPHY_A';
            detailMode = 'b-failure';
            panel.show(agentB);
            panel._stopPolling();
            const pendingText = panel.panelEl.textContent;
            await Promise.resolve();
            await Promise.resolve();
            const unavailableText = panel.panelEl.textContent;

            // CU-7 — detail without usage: with no token snapshot the context
            // stat says so; with snapshot counts it renders them as a snapshot
            // and never labels a cost numeral's neighbour "No usage data".
            detailMode = 'b-empty';
            const originalTokensB = agentB.tokens;
            agentB.tokens = { availability: 'unavailable' };
            await panel._fetchDetail();
            const noUsageText = panel.dom.panelContextSize.textContent;
            agentB.tokens = { input: 1200, output: 300, contextWindow: 800, availability: 'observed' };
            await panel._fetchDetail();
            const snapshotUsage = {
                caption: panel.dom.panelContextSize.textContent,
                numeral: panel.dom.panelContextNumeral.textContent,
                contextShown: !panel.dom.panelContextNumeral.parentElement.hidden,
                costShown: !panel.dom.panelCostRow.hidden && panel.dom.panelEstCost.textContent !== '-',
                input: panel.dom.panelInputTokens.textContent,
            };
            agentB.tokens = originalTokensB;

            document.getElementById('btnModeDashboard').click();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            dashboard._stopDetailFetching();
            dashboard.active = true;
            const card = dashboard.cards.get(agentA.id);
            dashboard.usageFooters.set(agentA.id, { tokens: '999 tokens', cost: '$9.99' });
            dashboard._renderUsageFooter(card, dashboard.usageFooters.get(agentA.id));
            sessionDetailsService.fetchSessionDetailsBatch = async candidates => (
                new Map(candidates.map(agent => [agent.id, {}]))
            );
            dashboard._isFetchingDetails = false;
            // The Dashboard fetches detail for the selected row only.
            dashboard._selectedAgentId = agentA.id;
            await dashboard._fetchAllDetails();

            const baseSignature = card._avatarSignature;
            const oldTeamName = agentA.teamName;
            const oldAppearance = agentA.appearance;
            agentA.teamName = '__ui_probe_team__';
            dashboard._updateCard(card, agentA);
            const teamSignature = card._avatarSignature;
            agentA.teamName = oldTeamName;
            dashboard._updateCard(card, agentA);
            const teamRemovedSignature = card._avatarSignature;
            agentA.teamName = '__ui_probe_team__';
            agentA.appearance = { ...oldAppearance, hair: '#010203' };
            dashboard._updateCard(card, agentA);
            const appearanceSignature = card._avatarSignature;
            agentA.teamName = oldTeamName;
            agentA.appearance = oldAppearance;
            dashboard._updateCard(card, agentA);

            return {
                aRendered: aText.includes('SENTINEL_ACTIVITY_A') && aText.includes('SENTINEL_MESSAGE_A'),
                pendingCleared: !pendingText.includes('SENTINEL_ACTIVITY_A')
                    && !pendingText.includes('SENTINEL_MESSAGE_A')
                    && !pendingText.includes('SENTINEL_BIOGRAPHY_A')
                    && pendingText.includes('Loading activity'),
                failureCleared: !unavailableText.includes('SENTINEL_ACTIVITY_A')
                    && unavailableText.includes('Activity unavailable'),
                noUsageText,
                snapshotUsage,
                // The flat row has no footer to hide: an empty detail
                // recomputes the usage cells, so the stale numbers must go.
                obsoleteFooterCleared: dashboard.usageFooters.get(agentA.id)?.tokens !== '999 tokens'
                    && !card._elements.usageTokens.textContent.includes('999')
                    && !card._elements.usageCost.textContent.includes('9.99'),
                teamInvalidatesAvatar: teamSignature !== baseSignature,
                teamRemovalInvalidatesAvatar: teamRemovedSignature !== teamSignature,
                appearanceInvalidatesAvatar: appearanceSignature !== teamSignature,
                genericUpdateAvoidedBiographyRead,
            };
        } finally {
            sessionDetailsService.fetchSessionDetail = originalDetail;
            sessionDetailsService.fetchSessionDetailsBatch = originalBatch;
            app.biographyService.getBiography = originalBiography;
            panel.hide();
        }
    });

    assert.equal(detailState.aRendered, true);
    assert.equal(detailState.pendingCleared, true);
    assert.equal(detailState.failureCleared, true);
    assert.equal(detailState.noUsageText, 'No usage data');
    assert.deepEqual(detailState.snapshotUsage, {
        caption: 'context · from snapshot',
        numeral: '800',
        contextShown: true,
        costShown: true,
        input: '1.2K',
    });
    assert.equal(detailState.obsoleteFooterCleared, true);
    assert.equal(detailState.teamInvalidatesAvatar, true);
    assert.equal(detailState.teamRemovalInvalidatesAvatar, true);
    assert.equal(detailState.appearanceInvalidatesAvatar, true);
    assert.equal(detailState.genericUpdateAvoidedBiographyRead, true);
    assert.deepEqual(pageErrors, []);

    console.log(JSON.stringify({
        status: 'ok',
        storageAndSemantics,
        detailState,
    }, null, 2));
} finally {
    await browser?.close();
    await server.stop();
}
