// World-x phase repeats on every 32 px half-tile, including the sluice cheeks.
export function wallCourseStop(x, row, height, east) {
    if (row === height - 1) return 1;
    if (row === 0) return 6;
    const joint = (x + (row >> 2) * 4) & 7;
    if ((row & 3) === 3) return 2;
    if (joint === 0) return 1;
    if ((row & 3) === 0 || (joint === 1 && east)) return 5;
    return east ? 3 : 4;
}

export const TERRACE_ANCHORS = Object.freeze({
    stair: Object.freeze([32, 24]), corner: Object.freeze([16, 16]), spill: Object.freeze([32, 82]),
});
