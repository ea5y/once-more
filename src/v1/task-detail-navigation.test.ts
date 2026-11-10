import { expect, it } from 'vitest';
import { conversations } from './data';
import { createLibrary, libraryReducer } from './model';

it('任务详情定位跨日期未收藏片段，清除筛选且不自动播放', () => {
  const target = conversations.find(item => item.date === '2026-09-08')!;
  const state = { ...createLibrary(conversations), filter: 'saved' as const, query: '不存在的文字', playback: { id: conversations[0].id, position: 2, playing: true } };
  const next = libraryReducer(state, { type: 'open-clip', id: target.id });
  expect(next.selectedId).toBe(target.id);
  expect(next.date).toBe(target.date);
  expect(next.filter).toBe('all');
  expect(next.query).toBe('');
  expect(next.playback.playing).toBe(false);
  expect(next.items).toBe(state.items);
  expect(libraryReducer(state, { type: 'open-clip', id: 'missing' })).toBe(state);
});
