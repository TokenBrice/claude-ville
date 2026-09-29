// Wave 10 (10.1 Stage A) — the WGSL twin of MaterialRegistry
// glslMaterialWeatherFunctions(): materialWetness / materialReflection
// generated from the same MATERIAL_WEATHER_RESPONSE table with the same
// formatting, so an authored wetness or reflection change moves both
// dialects. Scene module only; calls scene.js's `materialNear`.
import { MATERIAL_WEATHER_RESPONSE } from '../../MaterialRegistry.js';

function materialMixes(channel) {
    return Object.values(MATERIAL_WEATHER_RESPONSE)
        .filter(row => row[channel] > 0)
        .map(row => `    value = mix(value, ${row[channel].toFixed(4)}, materialNear(material, ${row.id}.0));`)
        .join('\n');
}

export const MATERIAL_WGSL = /* wgsl */ `
fn materialWetness(material: f32) -> f32 {
    var value = 0.0;
${materialMixes('wetness')}
    return value;
}
fn materialReflection(material: f32) -> f32 {
    var value = 0.0;
${materialMixes('reflection')}
    return value;
}
`;
