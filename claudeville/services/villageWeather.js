const HOUR_MS = 60 * 60_000;
const MAX_STALE_MS = 3 * HOUR_MS;
const MAX_BYTES = 64 * 1024;
const HOURLY_FIELDS = ['weather_code', 'cloud_cover', 'precipitation', 'snowfall', 'wind_speed_10m', 'wind_direction_10m', 'visibility'];
const OPTIONAL_FIELDS = ['temperature_2m'];
const FREEZING_C = 0.0;
const FREEZING_EXIT_C = 1.0;
const PAST_HOURS = 72;
const FORECAST_HOURS = 48;

function isFreezingBreathTemp({
  temperatureC, wasFreezing = false, stale = false, modelledSky = false,
  frostQuarters = 0, snowBucket = 0, isNightOrDawn = false,
} = {}) {
  if (stale || modelledSky || !Number.isFinite(temperatureC)) {
    return frostQuarters > 0 || (snowBucket >= 1 && isNightOrDawn);
  }
  return wasFreezing ? temperatureC < FREEZING_EXIT_C : temperatureC <= FREEZING_C;
}

function readHourly(hourly) {
  const time = hourly?.time;
  if (!Array.isArray(time) || time.length !== PAST_HOURS + FORECAST_HOURS
      || !time.every((at, i) => Number.isSafeInteger(at) && at > 0 && at < 8.64e12
        && (i === 0 || at === time[i - 1] + 3600))) return null;

  const result = { time };
  for (const field of HOURLY_FIELDS) {
    const values = hourly[field];
    if (!Array.isArray(values) || values.length !== time.length
        || !values.every(value => value === null || Number.isFinite(value))) return null;
    result[field] = values;
  }
  const temps = hourly.temperature_2m;
  result.temperature_2m = Array.isArray(temps) && temps.length === time.length
    && Array.from(temps).every(value => value === null || (Number.isFinite(value) && value >= -90 && value <= 60))
    ? temps : null;
  return result.weather_code.some(Number.isFinite) ? result : null;
}

async function downloadForecast(site, fetchImpl) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: site.lat,
    longitude: site.lon,
    hourly: [...HOURLY_FIELDS, ...OPTIONAL_FIELDS].join(','),
    timeformat: 'unixtime',
    past_hours: PAST_HOURS,
    forecast_hours: FORECAST_HOURS,
  });
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) return null;
    chunks.push(chunk);
  }
  return readHourly(JSON.parse(Buffer.concat(chunks, bytes)).hourly);
}

function createVillageWeather({
  now = Date.now,
  getZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  fetchImpl = globalThis.fetch,
} = {}) {
  let cached = null;
  let refreshAt = 0;
  let pending = null;

  async function refresh(zone) {
    try {
      const { zoneCoordinates } = await import('../src/config/zoneCoordinates.js');
      const site = zoneCoordinates(zone);
      if (!site) return;
      const hourly = await downloadForecast(site, fetchImpl);
      if (hourly) cached = { zone, fetchedAt: now(), hourly };
    } catch {
      // The modeled sky covers outages and malformed responses.
    } finally {
      pending = null;
    }
  }

  return async function getForecast() {
    const zone = getZone();
    const requestAt = now();
    if (!pending && requestAt >= refreshAt) {
      refreshAt = requestAt + HOUR_MS;
      pending = refresh(zone);
    }
    await pending;
    const current = cached?.zone === zone ? cached : null;
    return {
      fetchedAt: current?.fetchedAt ?? null,
      hourly: current && now() - current.fetchedAt <= MAX_STALE_MS ? current.hourly : null,
      refreshAt,
    };
  };
}

module.exports = { FREEZING_C, FREEZING_EXIT_C, isFreezingBreathTemp, readHourly, createVillageWeather, getForecast: createVillageWeather() };
