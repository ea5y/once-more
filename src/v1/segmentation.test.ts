import { describe, expect, it } from 'vitest';
import { segmentConversations, addFirstSegments, type PausePreviewResult } from './segmentation';
import { saveLibrary, restoreLibrary } from './persistence';
import { createLibrary, libraryReducer, sentencesInRange } from './model';
const crossing = { start: 8, end: 11, text: '跨界句' };
const next = { start: 12, end: 19, text: '第二句' };
const result: PausePreviewResult = { seconds: 6, duration: 20, source: { id: 'recording', path: '/audio.m4a', name: '录音', modified: 999999, recordedAt: 100000 }, transcript: [crossing, next], parts: [
  { start: 0, end: 10, title: crossing.text, text: [crossing.text], sentences: [crossing] },
  { start: 10, end: 20, title: next.text, text: [next.text], sentences: [next] },
] };
describe('首次分段保存', () => {
  it('重开保留参数、真实来源和跨界文字唯一归属', () => {
    const items = segmentConversations(result, path => path);
    const restored = restoreLibrary(JSON.parse(JSON.stringify(saveLibrary(items))), [], path => path);
    expect(restored.map(i => i.pauseSeconds)).toEqual([6,6]);
    expect(restored.flatMap(i => i.transcript)).toEqual(['跨界句','第二句']);
    expect(sentencesInRange(restored[1])).toEqual([next]);
    expect(restored[1].audioUrl).toBe('/audio.m4a');
    expect(restored[0].start + restored[0].duration).toBe(restored[1].start);
  });
  it('重复提交包括不同参数不会覆盖收藏、范围或添加重复条目', () => {
    const items = segmentConversations(result, path => path);
    items[0] = { ...items[0], saved: true, start: 1, duration: 9 };
    const incoming = segmentConversations({ ...result, seconds: 5 }, path => path);
    expect(addFirstSegments(items, incoming)).toBe(items);
    const state = libraryReducer({ ...createLibrary(items), query:'找不到',filter:'saved' }, { type:'segments-saved', items, sourceId:'recording' });
    expect(state.selectedId).toBe(items[0].id);
    expect(state.query).toBe(''); expect(state.filter).toBe('all');
    expect(state.items[0].saved).toBe(true);
  });
});

it('媒体进度不会触发定位请求，同一句重复点击仍可重新定位', () => {
  const items = segmentConversations(result, path => path);
  let state = createLibrary(items);
  state = libraryReducer(state, { type: 'sentence', id: items[1].id, index: 0 });
  const version = state.playback.seekVersion;
  state = libraryReducer(state, { type: 'media-position', id: items[1].id, position: 3 });
  expect(state.playback.seekVersion).toBe(version);
  state = libraryReducer(state, { type: 'sentence', id: items[1].id, index: 0 });
  expect(state.playback.seekVersion).toBe((version ?? 0) + 1);
});

it('片段使用录音开始时间，正确跨日，不使用文件修改时间', () => {
  const start = new Date(2026, 10, 6, 23, 59, 55).getTime() / 1000;
  const items = segmentConversations({ ...result, source: { ...result.source, recordedAt: start } }, p => p);
  expect(items[0].date).toBe('2026-11-06');
  expect(items[0].time).toBe('23:59:55');
  expect(items[1].date).toBe('2026-11-07');
  expect(items[1].time).toBe('00:00:05');
  expect(() => segmentConversations({ ...result, source: { ...result.source, recordedAt: NaN } }, p => p)).toThrow('缺少可靠');
});
