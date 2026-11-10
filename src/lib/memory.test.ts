import { describe, expect, it } from 'vitest';
import { filterMemories, formatDuration, timePeriod, validRange } from './memory';
import { demoMemories } from './sample';

describe('memory navigation and audio ranges', () => {
  it('searches the original transcript and applies the saved filter together', () => {
    expect(filterMemories(demoMemories, 'saved', '坐火车')).toHaveLength(1);
    expect(filterMemories(demoMemories, 'all', '不存在的词')).toHaveLength(0);
  });
  it('formats long recordings without wrapping the hour', () => {
    expect(formatDuration(14443)).toBe('04:00:43');
    expect(formatDuration(NaN)).toBe('00:00');
  });
  it('rejects reversed, nonfinite, negative and out-of-source ranges', () => {
    expect(validRange(10, 20, 30)).toBe(true);
    for (const [start, end] of [[-1, 20], [20, 10], [0, 31], [0, Infinity], [10, 10]]) {
      expect(validRange(start, end, 30)).toBe(false);
    }
  });
  it('handles the overnight period and boundary hours', () => {
    expect(timePeriod('04:59').label).toBe('夜晚');
    expect(timePeriod('05:00').label).toBe('清晨');
    expect(timePeriod('17:08').label).toBe('傍晚');
  });
});
