export const VILLAGE_WEATHER_KEY = 'claudeville.villageWeather';
export const OPEN_METEO_URL = 'https://open-meteo.com/';
export const WEATHER_LICENCE_URL = 'https://creativecommons.org/licenses/by/4.0/';
const HOUR_MS = 60 * 60_000;

let villageForecast = null;

export function readVillageForecast() {
    return villageForecast;
}

export function setVillageForecast(forecast) {
    villageForecast = forecast;
}

export function weatherMode(value) {
    return value === 'real-sky' ? 'real-sky' : 'modeled';
}

export function readVillageWeather(storage) {
    try { return weatherMode((storage ?? globalThis.window?.localStorage)?.getItem(VILLAGE_WEATHER_KEY)); }
    catch { return 'modeled'; }
}

export function watchVillageWeather({ simulation = false, onChange, root = window } = {}) {
    let enabled = false;
    let controller = null;
    let timer = null;
    let forecast = null;

    function publish(next) {
        forecast = next;
        setVillageForecast(forecast);
        onChange?.();
    }

    async function refresh() {
        controller = new AbortController();
        const { signal } = controller;
        let delay = HOUR_MS;
        try {
            const response = await root.fetch('/api/weather', {
                headers: { 'X-ClaudeVille-Weather': 'real-sky' },
                signal: AbortSignal.any([signal, AbortSignal.timeout(7000)]),
            });
            if (response.ok) {
                const result = await response.json();
                if (signal.aborted) return;
                const fetchedAt = Number.isFinite(result.fetchedAt) && result.fetchedAt > 0 ? result.fetchedAt : null;
                let days = null;
                if (fetchedAt && result.hourly) {
                    days = forecast.fetchedAt === fetchedAt ? forecast.days : null;
                    if (!days) {
                        const { forecastKnotsByDate } = await import('../character-mode/VillageWeather.js');
                        if (signal.aborted) return;
                        days = forecastKnotsByDate(result.hourly);
                    }
                }
                publish({ fetchedAt, days });
                if (Number.isFinite(result.refreshAt)) {
                    delay = Math.max(10_000, Math.min(HOUR_MS, result.refreshAt - Date.now()));
                }
            }
        } catch {
            // The atmosphere expires a retained forecast even while offline.
        } finally {
            if (!signal.aborted) timer = root.setTimeout(refresh, delay);
        }
    }

    function setMode(mode) {
        const wanted = !simulation && mode === 'real-sky';
        if (enabled === wanted) return;
        enabled = wanted;
        root.clearTimeout(timer);
        controller?.abort();
        publish(enabled ? { fetchedAt: null, days: null } : null);
        if (enabled) void refresh();
    }

    const sync = () => {
        try { setMode(readVillageWeather(root.localStorage)); } catch { setMode('modeled'); }
    };
    const onStorage = event => {
        if (event.key === VILLAGE_WEATHER_KEY || event.key === null) sync();
    };
    root.addEventListener('storage', onStorage);
    sync();
    return {
        setMode,
        destroy() {
            root.removeEventListener('storage', onStorage);
            setMode('modeled');
        },
    };
}
