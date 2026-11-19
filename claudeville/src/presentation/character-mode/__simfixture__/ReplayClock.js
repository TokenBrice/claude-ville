import { solarStateForDate } from '../AtmosphereState.js';

// Only a simulator owns this clock. Scene animation keeps its normal tempo.
export class ReplayClock {
    constructor(recordedDay = null, date = new Date()) {
        if (recordedDay) {
            this.start = recordedDay.lower;
            this.end = recordedDay.upper;
            this.duration = 90_000;
        } else {
            const { day } = solarStateForDate(date);
            const atMinute = minute => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, Math.round(minute)).getTime();
            this.start = atMinute(day.civilDawnMinute);
            this.end = atMinute(Math.min(1439, Math.max(22 * 60, day.civilDuskMinute + 60)));
            this.duration = 60_000;
        }
        this.reset();
    }

    reset() {
        this.elapsed = 0;
        this.playhead = 0;
        this.now = this.start;
    }

    advance(dt, reduced) {
        this.elapsed = Math.min(this.duration, this.elapsed + dt);
        const next = reduced ? Math.floor(this.elapsed / 3000) * 3000 : this.elapsed;
        this.playhead = Math.max(this.playhead, next);
        this.now = this.start + Math.round((this.end - this.start) * this.playhead / this.duration);
    }
}
