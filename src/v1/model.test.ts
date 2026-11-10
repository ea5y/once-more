import { describe, expect, it } from 'vitest';
import { conversations } from './data';
import { conversationsOn, datesFor, navigate } from './model';

describe('V1 单日浏览与独立详情选择', () => {
  const initial = { date: '2026-09-10', selectedId: '2026-09-10-7' };
  it('三天数据均为完整对话，且包含没有收藏的日期', () => {
    expect(datesFor(conversations)).toEqual(['2026-09-10', '2026-09-09', '2026-09-08']);
    expect(conversations.every(item => item.transcript.length >= 2)).toBe(true);
    expect(conversationsOn(conversations, '2026-09-08').every(item => !item.saved)).toBe(true);
  });
  it('换日期只换列表，详情保持；选择新片段后才换详情', () => {
    const day = navigate(conversations, initial, { type: 'date', date: '2026-09-09' });
    expect(day.selectedId).toBe(initial.selectedId);
    expect(conversationsOn(conversations, day.date).map(item => item.id)).toEqual(['2026-09-09-0', '2026-09-09-1']);
    const selected = navigate(conversations, day, { type: 'select', id: '2026-09-09-1' });
    expect(selected).toEqual({ date: '2026-09-09', selectedId: '2026-09-09-1' });
    expect(navigate(conversations, selected, { type: 'date', date: initial.date }).selectedId).toBe(selected.selectedId);
  });
  it('无效日期或不可见片段不会破坏当前状态', () => {
    expect(navigate(conversations, initial, { type: 'date', date: '2099-01-01' })).toEqual(initial);
    expect(navigate(conversations, initial, { type: 'select', id: '2026-09-08-0' })).toEqual(initial);
  });
});

import { createLibrary, filteredItems, libraryReducer } from './model';
describe('收藏与日期联动', () => {
  it('保留有效日期，无收藏日期回退到最近有效日期，详情不变', () => {
    const initial = createLibrary(conversations);
    const day = libraryReducer(initial, { type: 'date', date: '2026-09-08' });
    const saved = libraryReducer(day, { type: 'filter', filter: 'saved' });
    expect(saved.date).toBe('2026-09-10');
    expect(saved.selectedId).toBe(initial.selectedId);
    expect(datesFor(filteredItems(saved))).toEqual(['2026-09-10', '2026-09-09']);
    const back = libraryReducer(saved, { type: 'filter', filter: 'all' });
    expect(back.date).toBe('2026-09-10');
    expect(datesFor(filteredItems(back))).toHaveLength(3);
  });
  it('取消当天最后收藏回退日期，撤销恢复数量和日期集合，保留详情', () => {
    let state = libraryReducer(createLibrary(conversations), { type: 'filter', filter: 'saved' });
    state = libraryReducer(state, { type: 'date', date: '2026-09-09' });
    state = libraryReducer(state, { type: 'select', id: '2026-09-09-1' });
    state = libraryReducer(state, { type: 'favorite', id: state.selectedId });
    expect(state.date).toBe('2026-09-10');
    expect(state.selectedId).toBe('2026-09-09-1');
    expect(filteredItems(state)).toHaveLength(3);
    state = libraryReducer(state, { type: 'undo' });
    expect(filteredItems(state)).toHaveLength(4);
    expect(datesFor(filteredItems(state))).toHaveLength(2);
    expect(state.date).toBe('2026-09-10');
    expect(state.selectedId).toBe('2026-09-09-1');
  });
  it('收藏全部为空时移除日期，撤销恢复，全部记忆不被删除', () => {
    let state = libraryReducer(createLibrary(conversations), { type: 'filter', filter: 'saved' });
    for (const item of conversations.filter(item => item.saved)) state = libraryReducer(state, { type: 'favorite', id: item.id });
    expect(filteredItems(state)).toHaveLength(0);
    expect(state.date).toBe('');
    expect(state.items).toHaveLength(12);
    const empty = state;
    state = libraryReducer(state, { type: 'undo' });
    expect(state.date).toBe('2026-09-09');
    expect(filteredItems(state)).toHaveLength(1);
    expect(state.selectedId).toBe(empty.selectedId);
    expect(libraryReducer(empty, { type: 'filter', filter: 'all' }).date).toBe('2026-09-10');
  });
});

describe('共用模拟播放器', () => {
  const playing = () => libraryReducer(createLibrary(conversations), { type: 'play', id: '2026-09-10-7' });
  it('暂停保留进度，继续从原处播放，结束停止且重播归零', () => {
    let state = libraryReducer(playing(), { type: 'tick', id: '2026-09-10-7', elapsed: 12 });
    state = libraryReducer(state, { type: 'play', id: state.selectedId });
    expect(state.playback).toEqual({ id: state.selectedId, playing: false, position: 12 });
    expect(libraryReducer(state, { type: 'tick', id: state.selectedId, elapsed: 5 }).playback.position).toBe(12);
    state = libraryReducer(state, { type: 'play', id: state.selectedId });
    state = libraryReducer(state, { type: 'tick', id: state.selectedId, elapsed: 100 });
    expect(state.playback).toEqual({ id: state.selectedId, playing: false, position: 43 });
    expect(libraryReducer(state, { type: 'play', id: state.selectedId }).playback.position).toBe(0);
  });
  it('日期、筛选、取消收藏及撤销都保持播放器', () => {
    let state = libraryReducer(playing(), { type: 'tick', id: '2026-09-10-7', elapsed: 12 });
    const player = state.playback;
    state = libraryReducer(state, { type: 'date', date: '2026-09-09' });
    state = libraryReducer(state, { type: 'filter', filter: 'saved' });
    state = libraryReducer(state, { type: 'favorite', id: player.id! });
    expect(state.playback).toEqual(player);
    state = libraryReducer(state, { type: 'undo' });
    expect(state.playback).toEqual(player);
  });
  it('选择另一条只暂停，点击其播放才启动；旧计时事件不影响新片段', () => {
    let state = libraryReducer(playing(), { type: 'tick', id: '2026-09-10-7', elapsed: 12 });
    state = libraryReducer(state, { type: 'select', id: '2026-09-10-0' });
    expect(state.playback.playing).toBe(false);
    expect(state.selectedId).toBe('2026-09-10-0');
    state = libraryReducer(state, { type: 'play', id: state.selectedId });
    expect(state.playback).toEqual({ id: state.selectedId, playing: true, position: 0 });
    expect(libraryReducer(state, { type: 'tick', id: '2026-09-10-7', elapsed: 9 }).playback).toEqual(state.playback);
  });
});

import { searchItems, highlightedParts } from './model';
describe('全局搜索与上下文恢复', () => {
  it('从收藏搜索全部正文，包括非标题和未收藏片段，选首条且暂停旧片段', () => {
    let state = libraryReducer(createLibrary(conversations), { type: 'filter', filter: 'saved' });
    state = libraryReducer(state, { type: 'date', date: '2026-09-09' });
    state = libraryReducer(state, { type: 'play', id: state.selectedId });
    state = libraryReducer(state, { type: 'search', query: '鸡蛋' });
    expect(state.selectedId).toBe('2026-09-10-0');
    expect(filteredItems(state)).toHaveLength(1);
    expect(state.playback.playing).toBe(false);
    state = libraryReducer(state, { type: 'search', query: '  书  ' });
    expect(datesFor(filteredItems(state))).toEqual(['2026-09-10', '2026-09-09']);
    expect(state.selectedId).toBe('2026-09-10-3');
    state = libraryReducer(state, { type: 'search', query: '' });
    expect(state.filter).toBe('saved');
    expect(state.date).toBe('2026-09-09');
  });
  it('清除时原日期失效则回退；全部为空则保留空状态', () => {
    let state = libraryReducer(createLibrary(conversations), { type: 'filter', filter: 'saved' });
    state = libraryReducer(state, { type: 'date', date: '2026-09-09' });
    state = libraryReducer(state, { type: 'search', query: '书店' });
    state = libraryReducer(state, { type: 'favorite', id: '2026-09-09-1' });
    expect(filteredItems(state)).toHaveLength(1);
    state = libraryReducer(state, { type: 'search', query: '' });
    expect(state.date).toBe('2026-09-10');
    state = libraryReducer(state, { type: 'search', query: '不存在的词' });
    expect(state.date).toBe('');
    expect(state.selectedId).toBe('');
    for (const item of state.items.filter(item => item.saved)) state = libraryReducer(state, { type: 'favorite', id: item.id });
    state = libraryReducer(state, { type: 'search', query: '' });
    expect(state.filter).toBe('saved');
    expect(state.date).toBe('');
  });
  it('关键词按字面匹配，高亮所有出现位置，不将符号当正则', () => {
    expect(searchItems(conversations, '.*')).toHaveLength(0);
    expect(highlightedParts('书店里有书', '书')).toEqual([{ text: '书', match: true }, { text: '店里有', match: false }, { text: '书', match: true }]);
    expect(highlightedParts('a[A', '[').map(part => part.text).join('')).toBe('a[A');
  });
});

describe('V1 句子模拟定位', () => {
  it('点击中间句跳到模拟时间，继续计时直到片段末尾', () => {
    let state = createLibrary(conversations);
    const item = conversations.find(item => item.id === state.selectedId)!;
    state = libraryReducer(state, { type: 'sentence', id: item.id, index: 3 });
    expect(state.playback).toEqual({ id: item.id, position: item.duration / 2, playing: true, seekVersion: 1 });
    state = libraryReducer(state, { type: 'tick', id: item.id, elapsed: item.duration });
    expect(state.playback).toEqual({ id: item.id, position: item.duration, playing: false, seekVersion: 1 });
    state = libraryReducer(state, { type: 'sentence', id: item.id, index: 0 });
    expect(state.playback.position).toBe(0);
    expect(state.playback.playing).toBe(true);
  });
  it('拒绝越界句子、非整数和非当前详情请求', () => {
    const state = createLibrary(conversations);
    for (const index of [-1, 99, 1.5, NaN]) expect(libraryReducer(state, { type: 'sentence', id: state.selectedId, index })).toBe(state);
    expect(libraryReducer(state, { type: 'sentence', id: conversations[0].id, index: 0 })).toBe(state);
  });
});

import { formatRangeTime, parseRangeTime, rangeError } from './model';
describe('V1 范围保存', () => {
  it('保留毫秒精度，拒绝错误时间格式，支持超过24小时', () => {
    expect(parseRangeTime('00:16:00.125')).toBe(960.125);
    expect(formatRangeTime(960.125)).toBe('00:16:00.125');
    expect(parseRangeTime('25:00:00.001')).toBe(90000.001);
    for (const value of ['', '-00:00:01', '00:60:00', '00:00:60', '00:00:01.1234', 'abc']) expect(Number.isNaN(parseRangeTime(value))).toBe(true);
  });
  it('保存只更新目标范围和时长，保留收藏，播放归零暂停', () => {
    let state = createLibrary(conversations);
    const id = state.selectedId;
    state = libraryReducer(state, { type: 'play', id });
    state = libraryReducer(state, { type: 'tick', id, elapsed: 20 });
    const before = state.items.find(item => item.id === id)!;
    state = libraryReducer(state, { type: 'range', id, start: 959.125, end: 1000.25 });
    const after = state.items.find(item => item.id === id)!;
    expect(after).toEqual({ ...before, start: 959.125, duration: 41.125 });
    expect(state.playback).toEqual({ id, position: 0, playing: false });
    expect(state.items[0]).toBe(conversations[0]);
    expect(libraryReducer(state, { type: 'range', id, start: 959.125, end: 1000.25 })).toBe(state);
  });
  it('拦截越界、倒序、非有限值以及原录音缺失', () => {
    const state = createLibrary(conversations);
    const id = state.selectedId;
    for (const [start, end] of [[-1, 20], [10, 10], [30, 20], [0, 3601], [NaN, 20], [0, Infinity]]) expect(libraryReducer(state, { type: 'range', id, start, end })).toBe(state);
    const missing = createLibrary(conversations.map(item => ({ ...item, sourceAvailable: false })));
    expect(libraryReducer(missing, { type: 'range', id, start: 0, end: 20 })).toBe(missing);
    expect(rangeError(missing.items[0], 0, 20)).toContain('原录音不存在');
    expect(libraryReducer(state, { type: 'range', id: conversations[0].id, start: 0, end: 20 })).toBe(state);
  });
});

import { sentencesInRange, mockSentenceStart, mockSentenceAt, conversationTitle } from './model';
describe('V1 范围与固定转写时间联动', () => {
  it('缩小保存更新标题和正文，扩大保存恢复原句，收藏与源转写不变', () => {
    let state = createLibrary(conversations);
    const original = state.items.find(item => item.id === state.selectedId)!;
    state = libraryReducer(state, { type: 'range', id: original.id, start: 968, end: 1003 });
    const trimmed = state.items.find(item => item.id === original.id)!;
    expect(trimmed.transcript).toEqual(original.transcript.slice(1));
    expect(conversationTitle(trimmed)).toBe('我也想。');
    expect(trimmed.saved).toBe(original.saved);
    expect(trimmed.sourceTranscript).toBe(original.sourceTranscript);
    expect(mockSentenceStart(trimmed, 0)).toBe(0);
    expect(mockSentenceStart(trimmed, 1)).toBeCloseTo(960 + 43 / 3 - 968);
    expect(mockSentenceAt(trimmed, 0)).toBe(0);
    state = libraryReducer(state, { type: 'range', id: original.id, start: 960, end: 1003 });
    expect(state.items.find(item => item.id === original.id)!.transcript).toEqual(original.transcript);
  });
  it('精确边界排除外句，句中边界保留重叠整句；空范围不编造文字', () => {
    const item = conversations.at(-1)!;
    const boundary = item.sourceTranscript.find(sentence => sentence.text === item.transcript[1])!.start;
    expect(sentencesInRange(item, item.start, boundary).map(sentence => sentence.text)).toEqual([item.transcript[0]]);
    expect(sentencesInRange(item, boundary, item.start + item.duration).map(sentence => sentence.text)).toEqual([item.transcript[1]]);
    expect(sentencesInRange(item, boundary - 0.1, boundary + 0.1)).toHaveLength(2);
    expect(sentencesInRange(item, 3500, 3501)).toEqual([]);
    expect(conversationTitle({ ...item, transcript: [] })).toBe('此范围暂无对话文字');
  });
  it('搜索命中被裁掉后列表日期更新，详情仍保留且可扩大恢复', () => {
    let state = libraryReducer(createLibrary(conversations), { type: 'search', query: '一阵子' });
    const id = state.selectedId;
    state = libraryReducer(state, { type: 'range', id, start: 968, end: 1003 });
    expect(filteredItems(state)).toEqual([]);
    expect(state.date).toBe('');
    expect(state.selectedId).toBe(id);
    state = libraryReducer(state, { type: 'range', id, start: 960, end: 1003 });
    expect(filteredItems(state)).toHaveLength(1);
    expect(state.date).toBe('2026-09-10');
  });
});

it('打开范围弹框可显式暂停主播放，保留位置并拒绝后续计时', () => {
  let state = createLibrary(conversations);
  const id = state.selectedId;
  state = libraryReducer(state, { type: 'play', id });
  state = libraryReducer(state, { type: 'tick', id, elapsed: 12 });
  state = libraryReducer(state, { type: 'pause' });
  expect(state.playback).toEqual({ id, position: 12, playing: false });
  expect(libraryReducer(state, { type: 'tick', id, elapsed: 1 })).toBe(state);
  expect(libraryReducer(state, { type: 'pause' }).playback).toEqual(state.playback);
});

 describe('V1 提取确认', () => {
  it('确认一次性保存新范围与正文并进入模拟提取中，收藏不变', () => {
    const state = createLibrary(conversations);
    const id = state.selectedId;
    const next = libraryReducer(state, { type: 'extract', id, start: 968, end: 1003 });
    const item = next.items.find(item => item.id === id)!;
    expect(item.extraction).toBe('extracting');
    expect(item.start).toBe(968);
    expect(item.duration).toBe(35);
    expect(item.transcript[0]).toBe('我也想。');
    expect(item.saved).toBe(true);
    expect(libraryReducer(next, { type: 'extract', id, start: 970, end: 1003 })).toBe(next);
    expect(libraryReducer(next, { type: 'range', id, start: 970, end: 1003 })).toBe(next);
    const navigated = libraryReducer(next, { type: 'date', date: '2026-09-09' });
    expect(navigated.items.find(item => item.id === id)!.extraction).toBe('extracting');
  });
  it('范围未改变也能开始提取；无效范围与原录音缺失不能提交', () => {
    const state = createLibrary(conversations);
    const item = state.items.find(item => item.id === state.selectedId)!;
    const action = { type: 'extract' as const, id: item.id, start: item.start, end: item.start + item.duration };
    expect(libraryReducer(state, action).items.find(value => value.id === item.id)!.extraction).toBe('extracting');
    expect(libraryReducer(state, { ...action, end: action.start })).toBe(state);
    const missing = createLibrary(conversations.map(item => ({ ...item, sourceAvailable: false })));
    expect(libraryReducer(missing, action)).toBe(missing);
  });
});

describe('V1 模拟提取结果与重试', () => {
  it('失败保留范围、正文、收藏；重试不改范围且拒绝重复和过期结果', () => {
    let state = createLibrary(conversations);
    const id = state.selectedId;
    state = libraryReducer(state, { type: 'extract', id, start: 968, end: 1003 });
    const confirmed = state.items.find(item => item.id === id)!;
    state = libraryReducer(state, { type: 'extraction-result', id, attempt: 1, outcome: 'failed' });
    expect(state.items.find(item => item.id === id)).toEqual({ ...confirmed, extraction: 'failed' });
    state = libraryReducer(state, { type: 'retry-extraction', id });
    expect(state.items.find(item => item.id === id)).toEqual({ ...confirmed, extractionAttempt: 2 });
    expect(libraryReducer(state, { type: 'retry-extraction', id })).toBe(state);
    expect(libraryReducer(state, { type: 'extraction-result', id, attempt: 1, outcome: 'done' })).toBe(state);
    state = libraryReducer(state, { type: 'extraction-result', id, attempt: 2, outcome: 'done' });
    expect(state.items.find(item => item.id === id)?.extraction).toBe('done');
    expect(libraryReducer(state, { type: 'extraction-result', id, attempt: 2, outcome: 'failed' })).toBe(state);
    expect(libraryReducer(state, { type: 'retry-extraction', id })).toBe(state);
  });
  it('切换日期、筛选和详情后，完成结果仍只更新原片段', () => {
    let state = createLibrary(conversations);
    const id = state.selectedId;
    state = libraryReducer(state, { type: 'extract', id, start: 960, end: 1003 });
    state = libraryReducer(state, { type: 'filter', filter: 'saved' });
    state = libraryReducer(state, { type: 'date', date: '2026-09-09' });
    state = libraryReducer(state, { type: 'select', id: '2026-09-09-1' });
    state = libraryReducer(state, { type: 'extraction-result', id, attempt: 1, outcome: 'done' });
    expect(state.selectedId).toBe('2026-09-09-1');
    expect(state.date).toBe('2026-09-09');
    expect(state.items.find(item => item.id === id)?.extraction).toBe('done');
    expect(state.items.find(item => item.id === state.selectedId)?.extraction).toBeUndefined();
  });
  it('原录音缺失禁止重试；失败后另存新范围清除旧失败标记', () => {
    let state = createLibrary(conversations);
    const id = state.selectedId;
    state = libraryReducer(state, { type: 'extract', id, start: 960, end: 1003 });
    state = libraryReducer(state, { type: 'extraction-result', id, attempt: 1, outcome: 'failed' });
    const missing = { ...state, items: state.items.map(item => ({ ...item, sourceAvailable: false })) };
    expect(libraryReducer(missing, { type: 'retry-extraction', id })).toBe(missing);
    const changed = libraryReducer(state, { type: 'range', id, start: 968, end: 1003 });
    expect(changed.items.find(item => item.id === id)?.extraction).toBeUndefined();
  });
});

describe('V1 已提取后修改范围', () => {
  function completed() {
    let state = createLibrary(conversations);
    const id = state.selectedId;
    state = libraryReducer(state, { type: 'extract', id, start: 960, end: 1003 });
    return libraryReducer(state, { type: 'extraction-result', id, attempt: 1, outcome: 'done' });
  }
  it('原范围保存保持成功，改变范围才标记需要重新提取，保留旧记录', () => {
    const state = completed();
    const id = state.selectedId;
    expect(libraryReducer(state, { type: 'range', id, start: 960, end: 1003 })).toBe(state);
    const changed = libraryReducer(state, { type: 'range', id, start: 968, end: 1003 });
    const item = changed.items.find(item => item.id === id)!;
    expect(item.extraction).toBe('stale');
    expect(item.extractedRange).toEqual({ start: 960, end: 1003 });
    expect(item.transcript[0]).toBe('我也想。');
    expect(item.saved).toBe(true);
    const twice = libraryReducer(changed, { type: 'range', id, start: 969, end: 1002 });
    expect(twice.items.find(item => item.id === id)?.extraction).toBe('stale');
  });
  it('重新提取失败和重试保留新范围，只有成功才更新已提取范围', () => {
    let state = completed();
    const id = state.selectedId;
    state = libraryReducer(state, { type: 'range', id, start: 968, end: 1003 });
    state = libraryReducer(state, { type: 'extract', id, start: 968, end: 1003 });
    state = libraryReducer(state, { type: 'extraction-result', id, attempt: 2, outcome: 'failed' });
    let item = state.items.find(item => item.id === id)!;
    expect(item.extractedRange).toEqual({ start: 960, end: 1003 });
    expect(item.start).toBe(968);
    expect(item.duration).toBe(35);
    state = libraryReducer(state, { type: 'retry-extraction', id });
    expect(libraryReducer(state, { type: 'retry-extraction', id })).toBe(state);
    state = libraryReducer(state, { type: 'extraction-result', id, attempt: 3, outcome: 'done' });
    item = state.items.find(item => item.id === id)!;
    expect(item.extraction).toBe('done');
    expect(item.extractedRange).toEqual({ start: 968, end: 1003 });
  });
  it('原录音不存在时已提取片段不能修改边界', () => {
    const done = completed();
    const state = { ...done, items: done.items.map(item => ({ ...item, sourceAvailable: false })) };
    expect(libraryReducer(state, { type: 'range', id: state.selectedId, start: 968, end: 1003 })).toBe(state);
  });
});

import { sourceSummary } from './model';
describe('同一录音的提取汇总', () => {
  it('包含未收藏片段，按来源标识隔离同名录音', () => {
    const source = conversations[0];
    const duplicateName = { ...conversations.at(-1)!, sourceName: source.sourceName, sourceId: 'different-recording' };
    const summary = sourceSummary([...conversations, duplicateName], source.sourceId);
    expect(summary.related).toHaveLength(7);
    expect(summary.related.some(item => !item.saved)).toBe(true);
    expect(summary.related.some(item => item.id === duplicateName.id)).toBe(false);
    expect(summary.pending).toHaveLength(7);
    expect(summary.allComplete).toBe(false);
  });
  it('只把成功且范围匹配的片段计入完成；失败、处理中和过期范围均待处理', () => {
    const base = conversations[0];
    const items = [
      { ...base, id: 'done', extraction: 'done' as const, extractedRange: { start: base.start, end: base.start + base.duration } },
      { ...base, id: 'old', extraction: 'done' as const, extractedRange: { start: base.start, end: base.start + base.duration + 1 } },
      { ...base, id: 'failed', extraction: 'failed' as const },
      { ...base, id: 'busy', extraction: 'extracting' as const },
      { ...base, id: 'stale', extraction: 'stale' as const },
    ];
    const summary = sourceSummary(items, base.sourceId);
    expect(summary.completed).toBe(1);
    expect(summary.pending.map(item => item.id).sort()).toEqual(['busy', 'failed', 'old', 'stale']);
    expect(sourceSummary([items[0]], base.sourceId).allComplete).toBe(true);
    expect(sourceSummary([], base.sourceId).allComplete).toBe(false);
  });
});

describe('模拟移走原录音', () => {
  it('必须全部完成且匹配最新范围；空、失败、过期和未收藏未提取均阻止操作', () => {
    const state = createLibrary(conversations);
    const sourceId = conversations[0].sourceId;
    expect(libraryReducer(state, { type: 'trash-source', sourceId })).toBe(state);
    expect(libraryReducer(state, { type: 'trash-source', sourceId: 'missing' })).toBe(state);
    const complete = conversations.map(item => ({ ...item, extraction: 'done' as const, extractedRange: { start: item.start, end: item.start + item.duration } }));
    for (const change of [{ extraction: 'failed' as const }, { extraction: undefined }, { extractedRange: { start: 0, end: 1 } }]) {
      const invalid = createLibrary(complete.map((item, index) => index === 0 ? { ...item, ...change, saved: false } : item));
      expect(libraryReducer(invalid, { type: 'trash-source', sourceId })).toBe(invalid);
    }
  });
  it('统一标记同源片段，保留提取与收藏、模拟播放；拦截再次移动和边界调整', () => {
    const items = conversations.map(item => ({ ...item, extraction: 'done' as const, extractedRange: { start: item.start, end: item.start + item.duration } }));
    let state = createLibrary(items);
    const sourceId = items[0].sourceId;
    state = libraryReducer(state, { type: 'select', id: items[0].id });
    state = libraryReducer(state, { type: 'play', id: items[0].id });
    const next = libraryReducer(state, { type: 'trash-source', sourceId });
    expect(next.playback).toEqual(state.playback);
    expect(next.items).toEqual(items.map(item => item.sourceId === sourceId ? { ...item, sourceAvailable: false } : item));
    expect(libraryReducer(next, { type: 'trash-source', sourceId })).toBe(next);
    expect(libraryReducer(next, { type: 'range', id: items[0].id, start: 1, end: 20 })).toBe(next);
    expect(libraryReducer(next, { type: 'tick', id: items[0].id, elapsed: 1 }).playback.position).toBe(1);
  });
});
