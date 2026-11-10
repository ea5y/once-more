export interface AudioPeaks { duration: number; secondsPerPeak: number; peaks: number[] }

/** Aggregate overlapping time buckets, retaining short transients and silent gaps. */
export function peaksInRange(data: AudioPeaks, start: number, end: number, count: number): number[] {
  if (!(data.secondsPerPeak > 0) || !Number.isFinite(start + end) || end <= start || count <= 0) return [];
  return Array.from({ length: count }, (_, index) => {
    const from = Math.max(0, Math.floor((start + (end - start) * index / count) / data.secondsPerPeak));
    const to = Math.min(data.peaks.length, Math.ceil(Math.min(data.duration, start + (end - start) * (index + 1) / count) / data.secondsPerPeak));
    let peak = 0;
    for (let i = from; i < to; i++) if (Number.isFinite(data.peaks[i])) peak = Math.max(peak, data.peaks[i]);
    return Math.min(1, peak);
  });
}
