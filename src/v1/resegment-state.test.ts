import { expect, it } from 'vitest';
import { conversations } from './data';
import { createLibrary, libraryReducer } from './model';

it('清空播放中的旧片段，迟到的读取和提取结果不能恢复它', () => {
  const old = conversations[0];
  const state = { ...createLibrary([old]), selectedId: old.id, undoId: old.id, playback: { id: old.id, position: 3, playing: true } };
  const next = libraryReducer(state, { type: 'queue-items', items: [old], retiredIds: [old.id] });
  expect(next.items).toEqual([]);
  expect(next.selectedId).toBe('');
  expect(next.undoId).toBeNull();
  expect(next.playback).toEqual({ id: null, position: 0, playing: false });
  expect(libraryReducer(next, { type: 'extraction-result', id: old.id, attempt: 1, outcome: 'done', clipPath: '/late.wav' })).toBe(next);
});
it('重新分段只移除指定旧片段，保留其他录音的收藏和播放', () => {
  const [old, keep] = conversations;
  const state = { ...createLibrary([old, { ...keep, saved: true }]), selectedId: keep.id, playback: { id: keep.id, position: 3, playing: true } };
  const fresh = { ...old, id: 'new-generation', saved: false, listens: 0 };
  const next = libraryReducer(state, { type: 'queue-items', items: [fresh, keep], retiredIds: [old.id] });
  expect(next.items.map(i => i.id)).toEqual([keep.id, fresh.id]);
  expect(next.items[0].saved).toBe(true);
  expect(next.playback).toEqual(state.playback);
});
