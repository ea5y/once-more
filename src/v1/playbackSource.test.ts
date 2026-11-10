import { expect, it } from 'vitest';
import { conversations } from './data';
import { mockSentenceStart, type Conversation } from './model';
import { playbackSource } from './playbackSource';

const base = conversations.find(item => item.id === '2026-09-10-7')!;
const item: Conversation = { ...base, clipPath: '/clips/one.wav', extraction: 'done', extractedRange: { start: base.start, end: base.start + base.duration } };
it('plays latest clip from zero while sentence positions stay relative to the conversation', () => {
  expect(playbackSource(item, true)).toEqual({ clipPath: item.clipPath, start: 0 });
  expect(mockSentenceStart(item, 0)).toBe(0);
  expect(playbackSource(item, false)).toEqual({ clipPath: undefined, start: item.start });
});
it('uses source for changed ranges, failed re-extraction, and missing clip records', () => {
  for (const changed of [{ ...item, start: item.start + 1 }, { ...item, extraction: 'stale' as const }, { ...item, extraction: 'failed' as const }, { ...item, clipPath: undefined }]) {
    expect(playbackSource(changed, true)).toEqual({ clipPath: undefined, start: changed.start });
  }
  expect(playbackSource({ ...item, clipPath: '/clips/new.wav' }, true).clipPath).toBe('/clips/new.wav');
});
