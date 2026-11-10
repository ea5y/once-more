import { expect, it } from 'vitest';
import { conversations } from './data';
import { createLibrary, libraryReducer } from './model';

const item = { ...conversations[0], audioUrl: '/test.wav', duration: 6 };
const playing = () => libraryReducer(createLibrary([item]), { type: 'play', id: item.id });

it('real extraction requires a file result, preserves the last file on failure, and cannot trash the source', () => {
  const real = { ...item, sourcePath: '/local/source.m4a' };
  let state = libraryReducer(createLibrary([real]), { type: 'extract', id: real.id, start: real.start, end: real.start + real.duration });
  expect(libraryReducer(state, { type: 'extraction-result', id: real.id, attempt: 1, outcome: 'done' })).toBe(state);
  state = libraryReducer(state, { type: 'extraction-result', id: real.id, attempt: 1, outcome: 'done', clipPath: '/output/first.wav' });
  expect(state.items[0].clipPath).toBe('/output/first.wav');
  expect(libraryReducer(state, { type: 'trash-source', sourceId: real.sourceId })).toBe(state);
  state = libraryReducer(state, { type: 'range', id: real.id, start: real.start + 1, end: real.start + real.duration });
  state = libraryReducer(state, { type: 'extract', id: real.id, start: real.start + 1, end: real.start + real.duration });
  state = libraryReducer(state, { type: 'extraction-result', id: real.id, attempt: 2, outcome: 'failed', error: '无法写入' });
  expect(state.items[0].clipPath).toBe('/output/first.wav');
  expect(state.items[0].extractionError).toBe('无法写入');
});

it('uses absolute media time, clamps the boundary, and stops at the end', () => {
  const state = libraryReducer(playing(), { type: 'media-position', id: item.id, position: 2 });
  expect(state.playback.position).toBe(2);
  expect(libraryReducer(state, { type: 'media-position', id: item.id, position: 2 }).playback.position).toBe(2);
  const ended = libraryReducer(state, { type: 'media-position', id: item.id, position: 7 });
  expect(ended.playback).toEqual({ id: item.id, position: 6, playing: false });
});

it('ignores stale, invalid and paused media updates; early media end stops playback', () => {
  const state = playing();
  expect(libraryReducer(state, { type: 'media-position', id: 'other', position: 4 })).toBe(state);
  expect(libraryReducer(state, { type: 'media-position', id: item.id, position: NaN })).toBe(state);
  const paused = libraryReducer(state, { type: 'pause' });
  expect(libraryReducer(paused, { type: 'media-position', id: item.id, position: 4 })).toBe(paused);
  expect(libraryReducer(state, { type: 'media-position', id: item.id, position: 4, ended: true }).playback.playing).toBe(false);
});

it('confirmed source removal preserves clips and text while disabling range edits, including pending saves', () => {
  const real = { ...item, sourcePath: '/local/source.m4a', clipPath: '/output/clip.wav', extraction: 'done' as const, extractedRange: { start: item.start, end: item.start + item.duration } };
  const state = createLibrary([real, { ...real, id: 'second', saved: false }]);
  const removed = libraryReducer(state, { type: 'source-removed', sourceId: real.sourceId, pending: true, uncertain: false });
  expect(removed.items.every(i => !i.sourceAvailable && i.sourceTrashPending && i.clipPath === real.clipPath)).toBe(true);
  expect(removed.items[0].transcript).toEqual(real.transcript);
  expect(libraryReducer(removed, { type: 'range', id: real.id, start: real.start + 1, end: real.start + real.duration })).toBe(removed);
  const restored = libraryReducer(removed, { type: 'source-restored', sourceId: real.sourceId });
  expect(restored.items.every(i => i.sourceAvailable && !i.sourceTrashPending)).toBe(true);
});

it('queue arrivals keep playback, date, search and current edits and do not duplicate', () => {
  const state = { ...playing(), query: '当前搜索', filter: 'saved' as const, undoId: item.id };
  const incoming = { ...item, id: 'new-queue', sourceId: 'new-source', date: '2026-10-22' };
  const next = libraryReducer(state, { type: 'queue-items', items: [{ ...item, saved: !item.saved }, incoming] });
  expect(next.playback).toBe(state.playback);
  expect(next.date).toBe(state.date);
  expect(next.selectedId).toBe(state.selectedId);
  expect(next.query).toBe(state.query);
  expect(next.filter).toBe(state.filter);
  expect(next.items[0]).toBe(state.items[0]);
  expect(next.items.length).toBe(2);
  expect(libraryReducer(next, { type: 'queue-items', items: [incoming] })).toBe(next);
  const first = libraryReducer(createLibrary([]), { type: 'queue-items', items: [incoming] });
  expect(first.date).toBe(incoming.date);
  expect(first.selectedId).toBe(incoming.id);
});
