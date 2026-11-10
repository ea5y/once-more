import { describe, expect, it } from 'vitest';
import { peaksInRange } from './waveform';
const data = { duration: 8, secondsPerPeak: 1, peaks: [0, 0, .2, .8, 0, .4, 0, 0] };
describe('waveform time windows', () => {
  it('crops non-zero source times while exported files start at zero', () => {
    expect(peaksInRange(data, 2, 6, 4)).toEqual([.2, .8, 0, .4]);
    expect(peaksInRange({ duration: 4, secondsPerPeak: 1, peaks: [.2, .8, 0, .4] }, 0, 4, 4)).toEqual([.2, .8, 0, .4]);
  });
  it('keeps short peaks when reducing resolution and silent ranges flat', () => {
    expect(peaksInRange(data, 0, 8, 4)).toEqual([0, .8, .4, 0]);
    expect(peaksInRange(data, 6, 8, 2)).toEqual([0, 0]);
    expect(peaksInRange(data, NaN, 8, 4)).toEqual([]);
  });
});
