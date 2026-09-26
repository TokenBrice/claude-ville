// Number formatting shared by the probe's reports.
export const fmt = (v, digits = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits));
export const signed = (v, digits = 1) => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`);
export const shortSite = site => site.replace(/^at\s+/, '').replace(/https?:\/\/[^/]+/g, '').slice(0, 110);
