// 9.4 — the one chrome tooltip. Every `[data-tip]` control inside the top
// bar, the World dock, the sidebar and the Activity Panel shares a single
// `#cvTip` manual popover instead of the OS `title` bubble: 400 ms after the
// pointer settles or keyboard focus lands (0 ms while another tip closed
// less than 300 ms ago), no animation, Escape hides. Position is CSS anchor
// positioning (`.cv-tip` in topbar.css); this module only names the anchor.
// `data-tip-key="B"` appends the shortcut as a <kbd>.

const SHOW_DELAY_MS = 400;
const WARM_WINDOW_MS = 300;
const SCOPE = '#topbar, .world-dock, #sidebar, #activityPanel';
const ANCHOR = '--cv-tip';

export function installChromeTooltip(doc = document) {
    const tip = doc.getElementById('cvTip');
    if (!tip?.showPopover) return () => {};
    let anchor = null;
    let pending = null;
    let timer = 0;
    let closedAt = -Infinity;

    const targetOf = node => {
        const target = node?.closest?.('[data-tip]');
        return target?.dataset.tip && target.closest(SCOPE) ? target : null;
    };
    const hide = () => {
        clearTimeout(timer);
        pending = null;
        if (!anchor) return;
        anchor.style.removeProperty('anchor-name');
        anchor = null;
        if (tip.matches(':popover-open')) tip.hidePopover();
        closedAt = performance.now();
    };
    const show = target => {
        pending = null;
        if (!target.isConnected) return;
        if (anchor) hide();
        const names = getComputedStyle(target).anchorName;
        target.style.setProperty('anchor-name', names && names !== 'none' ? `${names}, ${ANCHOR}` : ANCHOR);
        tip.replaceChildren(target.dataset.tip);
        if (target.dataset.tipKey) {
            const key = doc.createElement('kbd');
            key.textContent = target.dataset.tipKey;
            tip.append(key);
        }
        anchor = target;
        tip.showPopover();
    };
    const request = target => {
        if (!target || target === anchor || target === pending) return;
        const warm = Boolean(anchor) || performance.now() - closedAt < WARM_WINDOW_MS;
        hide();
        pending = target;
        if (warm) show(target);
        else timer = setTimeout(() => show(target), SHOW_DELAY_MS);
    };
    const leave = (event, target) => {
        if (target && (target === anchor || target === pending) && !target.contains(event.relatedTarget)) hide();
    };

    const handlers = {
        pointerover: event => { if (event.pointerType !== 'touch') request(targetOf(event.target)); },
        pointerout: event => leave(event, targetOf(event.target)),
        focusin: event => { const target = targetOf(event.target); if (target?.matches(':focus-visible')) request(target); },
        focusout: event => leave(event, targetOf(event.target)),
        pointerdown: hide,
        keydown: event => { if (event.key === 'Escape') hide(); },
    };
    for (const [type, handler] of Object.entries(handlers)) doc.addEventListener(type, handler, true);
    return () => {
        hide();
        for (const [type, handler] of Object.entries(handlers)) doc.removeEventListener(type, handler, true);
    };
}
