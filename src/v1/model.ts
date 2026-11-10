export interface TimedSentence { text: string; start: number; end: number }
export interface Conversation {
  pauseSeconds?: number;
  segmentTranscript?: readonly TimedSentence[];
  id: string;
  date: string;
  time: string;
  transcript: readonly string[];
  sourceTranscript: readonly TimedSentence[];
  duration: number;
  saved: boolean;
  listens: number;
  audioUrl?: string;
  sourcePath?: string;
  clipPath?: string;
  clipMissing?: boolean;
  extractionError?: string;
  sourceName: string;
  sourceId: string;
  sourceAvailable: boolean;
  sourceTrashPending?: boolean;
  sourceTrashed?: boolean;
  sourceTrashUncertain?: boolean;
  sourceDuration: number;
  start: number;
  extraction?: 'extracting' | 'failed' | 'done' | 'stale';
  extractionAttempt?: number;
  extractedRange?: { start: number; end: number };
}

export interface NavigationState { date: string; selectedId: string }
export type NavigationAction = { type: 'date'; date: string } | { type: 'select'; id: string };

export function datesFor(items: readonly Conversation[]) {
  return [...new Set(items.map(item => item.date))].sort().reverse();
}
export function conversationsOn(items: readonly Conversation[], date: string) {
  return items.filter(item => item.date === date).sort((a, b) => a.time.localeCompare(b.time));
}
export function navigate(items: readonly Conversation[], state: NavigationState, action: NavigationAction): NavigationState {
  if (action.type === 'date') {
    return datesFor(items).includes(action.date) ? { ...state, date: action.date } : state;
  }
  return conversationsOn(items, state.date).some(item => item.id === action.id)
    ? { ...state, selectedId: action.id } : state;
}

export type Filter = 'all' | 'saved';
export interface Playback { seekVersion?: number; id: string | null; position: number; playing: boolean }
export interface LibraryState extends NavigationState {
  listenPass?: { id: string; start: number; duration: number };
  query: string;
  searchOrigin: { filter: Filter; date: string } | null;
  playback: Playback;
  items: readonly Conversation[];
  filter: Filter;
  undoId: string | null;
}
export type LibraryAction = { type: 'open-clip'; id: string } | { type: 'queue-items'; items: readonly Conversation[]; retiredIds?: readonly string[] } | { type: 'source-restored'; sourceId: string } | { type: 'source-removed'; sourceId: string; pending: boolean; uncertain: boolean } | { type: 'segments-saved'; items: readonly Conversation[]; sourceId: string } | { type: 'media-position'; id: string; position: number; ended?: boolean } | { type: 'trash-source'; sourceId: string } | { type: 'extraction-result'; id: string; attempt: number; outcome: 'failed' | 'done'; clipPath?: string; error?: string } | { type: 'retry-extraction'; id: string } | { type: 'pause' } | { type: 'range'; id: string; start: number; end: number } | { type: 'extract'; id: string; start: number; end: number } | { type: 'sentence'; id: string; index: number } | { type: 'search'; query: string } | { type: 'play'; id: string } | { type: 'tick'; id: string; elapsed: number } | NavigationAction | { type: 'filter'; filter: Filter } | { type: 'favorite'; id: string } | { type: 'undo' } | { type: 'dismiss' };
export function filteredItems(state: LibraryState) {
  if (state.query.trim()) return searchItems(state.items, state.query);
  return state.filter === 'saved' ? state.items.filter(item => item.saved) : state.items;
}
function reconcile(state: LibraryState): LibraryState {
  const dates = datesFor(filteredItems(state));
  return { ...state, date: dates.includes(state.date) ? state.date : dates[0] ?? '' };
}
export function createLibrary(items: readonly Conversation[]): LibraryState {
  const date = datesFor(items)[0] ?? '';
  return { items, query: '', searchOrigin: null, date, selectedId: conversationsOn(items, date).at(-1)?.id ?? '', filter: 'all', undoId: null, playback: { id: null, position: 0, playing: false } };
}
export function libraryReducer(state: LibraryState, action: LibraryAction): LibraryState {
  if (action.type === 'open-clip') {
    const item = state.items.find(item => item.id === action.id);
    return item ? { ...state, query: '', searchOrigin: null, filter: 'all', date: item.date, selectedId: item.id, playback: { ...state.playback, playing: false } } : state;
  }
  if (action.type === 'queue-items') {
    const retired = new Set(action.retiredIds ?? []);
    if (state.items.some(item => retired.has(item.id))) {
      state = { ...state, items: state.items.filter(item => !retired.has(item.id)), undoId: state.undoId && retired.has(state.undoId) ? null : state.undoId, selectedId: state.selectedId && retired.has(state.selectedId) ? '' : state.selectedId, playback: state.playback.id && retired.has(state.playback.id) ? { id: null, position: 0, playing: false } : state.playback };
    }
    const ids = new Set(state.items.map(item => item.id));
    const added = action.items.filter(item => !ids.has(item.id) && !retired.has(item.id));
    if (!added.length) return retired.size ? reconcile(state) : state;
    const items = [...state.items, ...added];
    if (!state.items.length && !state.query && state.filter === 'all') return createLibrary(items);
    // Keep the current filter, date, selection, search and audio position untouched.
    return { ...state, items };
  }
  if (action.type === 'segments-saved') {
    const first = action.items.find(item => item.sourceId === action.sourceId);
    return { ...state, items: action.items, filter: 'all', query: '', searchOrigin: null,
      date: first?.date ?? state.date, selectedId: first?.id ?? state.selectedId,
      playback: { id: null, position: 0, playing: false } };
  }
  if (action.type === 'media-position') {
    const item = state.items.find(value => value.id === action.id);
    if (!item?.audioUrl || state.playback.id !== action.id || !state.playback.playing || !Number.isFinite(action.position)) return state;
    const position = Math.max(0, Math.min(item.duration, action.position));
    const finished = position >= item.duration;
    const pass = state.listenPass;
    const counted = finished && pass?.id === item.id && pass.start === item.start && pass.duration === item.duration;
    return { ...state,
      items: counted ? state.items.map(value => value.id === item.id ? { ...value, listens: value.listens + 1 } : value) : state.items,
      listenPass: action.ended || finished ? undefined : pass,
      playback: { ...state.playback, position, playing: !action.ended && !finished } };

  }
  if (action.type === 'source-restored') {
    return { ...state, items: state.items.map(item => item.sourceId === action.sourceId ? { ...item, sourceAvailable: true, sourceTrashPending: false, sourceTrashed: false, sourceTrashUncertain: false } : item) };
  }
  if (action.type === 'source-removed') {
    return { ...state, items: state.items.map(item => item.sourceId === action.sourceId ? { ...item, sourceAvailable: false, sourceTrashPending: action.pending, sourceTrashed: !action.uncertain, sourceTrashUncertain: action.uncertain } : item) };
  }
  if (action.type === 'trash-source') {
    const summary = sourceSummary(state.items, action.sourceId);
    if (summary.related.some(item => item.sourcePath) || !summary.allComplete || !summary.related.every(item => item.sourceAvailable)) return state;
    return { ...state, items: state.items.map(item => item.sourceId === action.sourceId ? { ...item, sourceAvailable: false } : item) };
  }
  if (action.type === 'extraction-result') {
    const item = state.items.find(item => item.id === action.id);
    if (!item || item.extraction !== 'extracting' || item.extractionAttempt !== action.attempt || (item.sourcePath && action.outcome === 'done' && !action.clipPath)) return state;
    return { ...state, items: state.items.map(value => value.id === item.id ? { ...value, extraction: action.outcome, extractionError: action.error, clipPath: action.clipPath ?? value.clipPath, clipMissing: action.clipPath ? false : value.clipMissing, ...(action.outcome === 'done' ? { extractedRange: { start: value.start, end: value.start + value.duration } } : {}) } : value) };
  }
  if (action.type === 'retry-extraction') {
    const item = state.items.find(item => item.id === action.id);
    if (!item || item.extraction !== 'failed' || rangeError(item, item.start, item.start + item.duration)) return state;
    return { ...state, items: state.items.map(value => value.id === item.id ? { ...value, extraction: 'extracting', extractionAttempt: (value.extractionAttempt ?? 0) + 1 } : value) };
  }
  if (action.type === 'pause') return { ...state, playback: { ...state.playback, playing: false } };
  if (action.type === 'range' || action.type === 'extract') {
    const item = state.items.find(item => item.id === action.id);
    if (!item || (item.extraction === 'extracting' || (action.type === 'extract' && item.extraction === 'done')) || item.id !== state.selectedId || rangeError(item, action.start, action.end)) return state;
    if (action.type === 'range' && item.start === action.start && Math.abs(item.start + item.duration - action.end) < 0.000001) return state;
    return reconcile({ ...state, listenPass: state.listenPass?.id === item.id ? undefined : state.listenPass, items: state.items.map(value => value.id === item.id ? { ...value, ...(action.type === 'extract' ? { extraction: 'extracting' as const, extractionAttempt: (value.extractionAttempt ?? 0) + 1 } : { extraction: value.extractedRange || value.extraction === 'done' ? 'stale' as const : undefined, extractedRange: value.extractedRange ?? (value.extraction === 'done' ? { start: value.start, end: value.start + value.duration } : undefined) }), segmentTranscript: action.start === value.start && action.end === value.start + value.duration ? value.segmentTranscript : undefined, start: action.start, duration: Math.round((action.end - action.start) * 1000) / 1000, transcript: sentencesInRange(value, action.start, action.end).map(sentence => sentence.text) } : value), playback: state.playback.id === item.id ? { id: item.id, position: 0, playing: false } : state.playback });
  }
  if (action.type === 'search') {
    const query = action.query;
    if (!query.trim()) {
      return reconcile({ ...state, query, ...(state.searchOrigin ?? {}), searchOrigin: null });
    }
    const first = searchItems(state.items, query)[0];
    const selectedId = first?.id ?? '';
    return { ...state, query, searchOrigin: state.searchOrigin ?? { filter: state.filter, date: state.date }, filter: 'all', date: first?.date ?? '', selectedId,
      playback: selectedId !== state.selectedId ? { ...state.playback, playing: false } : state.playback };
  }
  if (action.type === 'sentence') {
    const item = state.items.find(item => item.id === action.id);
    if (!item || item.id !== state.selectedId || !Number.isInteger(action.index) || action.index < 0 || action.index >= item.transcript.length) return state;
    return { ...state, listenPass: undefined, playback: { id: item.id, position: mockSentenceStart(item, action.index), playing: true, seekVersion: (state.playback.seekVersion ?? 0) + 1 } };
  }
  if (action.type === 'play') {
    const item = state.items.find(item => item.id === action.id);
    if (!item || (state.selectedId !== item.id && !conversationsOn(filteredItems(state), state.date).some(value => value.id === item.id))) return state;
    const current = state.playback;
    const same = current.id === item.id;
    const fresh = !same || current.position >= item.duration || (current.position === 0 && current.seekVersion == null);
    return { ...state, selectedId: item.id,
      listenPass: fresh ? (item.audioUrl ? { id: item.id, start: item.start, duration: item.duration } : undefined) : state.listenPass,
      playback: { ...(same ? current : {}), id: item.id, position: same && current.position < item.duration ? current.position : 0, playing: same ? !current.playing : true } };
  }
  if (action.type === 'tick') {
    const current = state.playback;
    if (!current.playing || current.id !== action.id || !Number.isFinite(action.elapsed) || action.elapsed <= 0) return state;
    const item = state.items.find(item => item.id === current.id);
    if (!item) return state;
    const position = Math.min(item.duration, current.position + action.elapsed);
    return { ...state, playback: { ...current, position, playing: position < item.duration } };
  }
  if (action.type === 'filter') return reconcile({ ...state, query: '', searchOrigin: null, date: state.searchOrigin?.date ?? state.date, filter: action.filter });
  if (action.type === 'dismiss') return { ...state, undoId: null };
  if (action.type === 'favorite') {
    const item = state.items.find(item => item.id === action.id);
    if (!item) return state;
    return reconcile({ ...state, items: state.items.map(value => value.id === item.id ? { ...value, saved: !value.saved } : value), undoId: item.saved ? item.id : state.undoId === item.id ? null : state.undoId });
  }
  if (action.type === 'undo') {
    if (!state.undoId) return state;
    return reconcile({ ...state, items: state.items.map(item => item.id === state.undoId ? { ...item, saved: true } : item), undoId: null });
  }
  const next = navigate(filteredItems(state), state, action);
  return { ...state, ...next, playback: next.selectedId !== state.selectedId ? { ...state.playback, playing: false } : state.playback };
}


/** Match literal text across all conversations, newest day first, then time ascending. */
export function searchItems(items: readonly Conversation[], query: string) {
  const term = query.trim().toLocaleLowerCase();
  return items.filter(item => item.transcript.some(line => line.toLocaleLowerCase().includes(term)))
    .sort((a, b) => b.date.localeCompare(a.date) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
}
export function highlightedParts(text: string, query: string): { text: string; match: boolean }[] {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return [{ text, match: false }];
  const lower = text.toLocaleLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let offset = 0;
  let index = lower.indexOf(term);
  while (index !== -1) {
    if (index > offset) parts.push({ text: text.slice(offset, index), match: false });
    parts.push({ text: text.slice(index, index + term.length), match: true });
    offset = index + term.length;
    index = lower.indexOf(term, offset);
  }
  if (offset < text.length) parts.push({ text: text.slice(offset), match: false });
  return parts;
}

/** Source-relative mock intervals stay fixed when the selection changes. */
export function sentencesInRange(item: Conversation, start = item.start, end = item.start + item.duration) {
  if (item.segmentTranscript && start === item.start && end === item.start + item.duration) return item.segmentTranscript;
  return item.sourceTranscript.filter(sentence => sentence.end > start && sentence.start < end);
}
export function mockSentenceStart(item: Conversation, index: number) {
  const sentence = sentencesInRange(item)[index];
  return sentence ? Math.max(0, sentence.start - item.start) : 0;
}
export function mockSentenceAt(item: Conversation, position: number) {
  const time = item.start + Math.min(position, Math.max(0, item.duration - 0.000001));
  return sentencesInRange(item).findIndex(sentence => sentence.start <= time && sentence.end > time);
}
export function conversationTitle(item: Conversation) { return item.transcript[0] ?? '此范围暂无对话文字'; }

/** Millisecond precision, hours may exceed 24 for long recordings. */
export function formatRangeTime(seconds: number) {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
export function parseRangeTime(value: string) {
  const match = /^(\d{2,}):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number((match[4] ?? '').padEnd(3, '0')) / 1000;
}
export function rangeError(item: Conversation, start: number, end: number) {
  if (!item.sourceAvailable) return '原录音不存在，无法调整范围。';
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '请输入有效时间，例如 00:16:00.000。';
  if (start < 0 || end < 0 || start > item.sourceDuration || end > item.sourceDuration) return '起点和终点不能超出原录音范围。';
  if (end - start < 0.000999) return '终点必须晚于起点。';
  return '';
}

/** Group by recording identity, never by filename or the visible filter. */
export function sourceSummary(items: readonly Conversation[], sourceId: string) {
  const related = items.filter(item => item.sourceId === sourceId).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const pending = related.filter(item => !hasLatestExtraction(item));
  return { related, pending, completed: related.length - pending.length, allComplete: related.length > 0 && pending.length === 0 };
}
export function hasLatestExtraction(item: Conversation) {
  return item.extraction === 'done' && !!item.extractedRange && Math.abs(item.extractedRange.start - item.start) < 0.000001 && Math.abs(item.extractedRange.end - item.start - item.duration) < 0.000001;
}
export function extractionLabel(item: Conversation) {
  if (item.extraction === 'extracting') return item.sourcePath ? '正在提取' : '模拟提取中';
  if (item.extraction === 'failed') return item.sourcePath ? '提取失败' : '模拟提取失败';
  if (hasLatestExtraction(item)) return item.sourcePath ? '已提取' : '已提取（模拟）';
  if (item.extraction === 'stale' || item.extraction === 'done') return '需要重新提取';
  return '未提取';
}
