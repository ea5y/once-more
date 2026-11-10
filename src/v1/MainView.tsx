import { useReducer, useRef, type Dispatch, type ReactNode, type RefObject, useCallback, useEffect, useState } from 'react';
import { ChevronRight, Heart, MoreHorizontal, Pause, Play, Scissors, Search, X } from 'lucide-react';
import AudioWaveform from './AudioWaveform';
import { formatDuration, timePeriod } from '../lib/memory';
import { extractionLabel, conversationTitle, mockSentenceAt, conversationsOn, datesFor, createLibrary, filteredItems, libraryReducer, type LibraryAction, type Conversation, type Filter, type Playback } from './model';
import './v1.css';
import DateRail from './DateRail';
import Transcript from './Transcript';
import RevealClip from './RevealClip';
import FolderSettings, { type FolderActions } from './FolderSettings';
import ScanControl, { type ScanActions } from './ScanControl';
import RangeDialog from './RangeDialog';
import { addFirstSegments, segmentConversations, type ConfirmSegments } from './segmentation';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { desktop } from '../lib/api';
import SourceDialog, { type TrashOutcome } from './SourceDialog';
import AudioPlayback from './AudioPlayback';
import { playbackSource } from './playbackSource';
import { saveLibrary, restoreLibrary } from './persistence';

const shortDate = (date: string) => date.slice(5).replace('-', '.');
const weekday = (date: string) => new Date(`${date || '2026-09-10'}T12:00:00`).toLocaleDateString('zh-CN', { weekday: 'short' });
let pendingSave: Promise<unknown> = Promise.resolve();
const unavailable = '后续批次开放';

function Sidebar({ items, onOpenClip, onOutput, saveStatus, onConfirm, onQueueSaved, onSource, onResult, folderRef, scanRef, preview }: { items: readonly Conversation[]; onOpenClip: (id: string) => void; onSource: (path: string | null) => void; onResult: () => void; folderRef: RefObject<FolderActions | null>; scanRef: RefObject<ScanActions | null>; preview: boolean; onQueueSaved: () => Promise<void>; onConfirm: ConfirmSegments; onOutput: (path: string | null) => void; saveStatus: string }) {
  const [scanning, setScanning] = useState(false);
  return <aside className="sidebar">
    <div className="window-drag" data-tauri-drag-region>{!desktop && <div className="traffic-lights" aria-hidden="true"><i /><i /><i /></div>}</div>
    <div className="brand"><div className="brand-name"><span className="brand-orbit" />NCE MORE</div><p>Let sounds live again.</p></div>
    <ScanControl items={items} onOpenClip={onOpenClip} ref={scanRef} onResult={onResult} onQueueSaved={onQueueSaved} onConfirm={onConfirm} onScanning={setScanning} />
    <div className="sidebar-bottom"><p className="v1-preview-note">{preview && <>V1 示例预览<br /></>}{saveStatus}</p><FolderSettings ref={folderRef} onSource={onSource} onOutput={onOutput} scanning={scanning} /></div>
  </aside>;
}

interface PlaybackProps { playback: Playback; onPlay: (id: string) => void }
function Player({ item, playback, onPlay, small = false }: PlaybackProps & { item: Conversation; small?: boolean }) {
  const active = playback.id === item.id;
  const playing = active && playback.playing;
  const position = active ? playback.position : 0;
  return <div className={small ? 'row-player' : 'detail-player'}>
    <button className={`play ${small ? 'small' : ''}`} onClick={() => onPlay(item.id)} aria-label={`${playing ? '暂停' : '播放'}：${conversationTitle(item)}`} title={item.audioUrl ? "本地音频 · 真实播放" : "模拟播放，无音频"}>{playing ? <Pause size={small ? 10 : 17} fill="currentColor" /> : <Play size={small ? 10 : 17} fill="currentColor" />}</button>
    <AudioWaveform path={playbackSource(item, true).clipPath ?? item.sourcePath} start={playbackSource(item, true).start} end={playbackSource(item, true).start + item.duration} large={!small} progress={item.duration > 0 ? position / item.duration : 0} /><span className="v1-progress">{active ? `${formatDuration(position)} / ` : ''}{formatDuration(item.duration)}</span>
  </div>;
}

function MemoryRow({ item, selected, showPeriod, onSelect, onFavorite, playback, onPlay }: PlaybackProps & { item: Conversation; selected: boolean; showPeriod: boolean; onSelect: () => void; onFavorite: () => void }) {
  const period = timePeriod(item.time);
  return <div className="memory-item">
    {showPeriod && <div className="period"><img src={`/icons/${period.icon}.svg`} alt="" />{period.label}</div>}
    <article className={`memory-row ${selected ? 'selected' : ''}`}>
      <button className="memory-select" aria-label={`查看记忆：${conversationTitle(item)}`} aria-pressed={selected} onClick={onSelect}><span className="timeline-dot" /><time>{item.time}</time><span className="memory-title" title={conversationTitle(item)}>{conversationTitle(item)}</span></button>
      <div className="v1-row-marks"><button onClick={onFavorite} aria-label={`${item.saved ? '取消收藏' : '收藏'}：${conversationTitle(item)}`} aria-pressed={item.saved}><Heart size={13} fill={item.saved ? 'currentColor' : 'none'} /></button><MoreHorizontal size={15} /></div>
      <Player item={item} playback={playback} onPlay={onPlay} small /><small className="v1-listens">{item.listens ? `听过 ${item.listens} 次` : '未听过'}</small>
    </article>
  </div>;
}

function DayList({ empty, query, onSearch, items, dates, date, selectedId, onDate, onSelect, filter, total, savedCount, onFilter, onFavorite, playback, onPlay }: PlaybackProps & { empty: ReactNode; query: string; onSearch: (query: string) => void; items: readonly Conversation[]; dates: string[]; date: string; selectedId: string; onDate: (date: string) => void; onSelect: (id: string) => void; filter: Filter; total: number; savedCount: number; onFilter: (filter: Filter) => void; onFavorite: (id: string) => void }) {
  const visible = conversationsOn(items, date);
  const [draft, setDraft] = useState(query);
  const composing = useRef(false);
  useEffect(() => { setDraft(query); }, [query]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { if (list.current) list.current.scrollTop = 0; }, [date]);
  const month = date ? new Date(`${date}T12:00:00`) : new Date();
  return <section className="timeline" aria-label="当天记忆">
    <header className="timeline-header"><div className="month"><span>{month.getFullYear()}</span><strong>{month.toLocaleDateString('en-US', { month: 'long' }).toUpperCase()}</strong></div><label className="search"><Search size={15} /><input value={draft} placeholder="搜索你的记忆…" aria-label="全局搜索" onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; onSearch(event.currentTarget.value); }} onChange={event => { setDraft(event.target.value); if (!composing.current) onSearch(event.target.value); }} onKeyDown={event => { if (event.key === 'Escape' && !composing.current) { setDraft(''); onSearch(''); } }} />{draft && <button aria-label="清除搜索" onClick={() => { setDraft(''); onSearch(''); }}><X size={13} /></button>}</label><nav className="tabs" aria-label="记忆视图"><button className={filter === 'all' ? 'active' : ''} aria-current={filter === 'all' ? 'page' : undefined} onClick={() => onFilter('all')}>全部<span>{total}</span></button><button className={filter === 'saved' ? 'active' : ''} aria-current={filter === 'saved' ? 'page' : undefined} onClick={() => onFilter('saved')}>收藏<span>{savedCount}</span></button></nav></header>
    {visible.length ? <><div className="day-heading"><span className="day-date">{shortDate(date)}</span><span aria-live="polite">{weekday(date)} · {visible.length} 条{query.trim() ? '匹配' : filter === 'saved' ? '收藏' : '记忆'}</span><span className="v1-order">{query.trim() ? `全部日期 · ${items.length} 条匹配` : '时间顺序 ↑'}</span></div>
    <div className="timeline-content"><div className="memory-list" ref={list}>{visible.map((item, index) => <MemoryRow playback={playback} onPlay={onPlay} key={item.id} item={item} selected={selectedId === item.id} showPeriod={index === 0 || timePeriod(visible[index - 1].time).label !== timePeriod(item.time).label} onSelect={() => onSelect(item.id)} onFavorite={() => onFavorite(item.id)} />)}</div><DateRail dates={dates} date={date} onDate={onDate} /></div></> : !query.trim() && filter === 'all' ? empty : <div className="empty-state">{query.trim() ? <Search size={42} /> : <Heart size={42} />}<h1>{query.trim() ? '没有找到相关记忆' : filter === 'saved' ? '还没有收藏的记忆' : '还没有记忆'}</h1><p>{query.trim() ? `没有与“${query.trim()}”匹配的内容` : '点击记忆旁的爱心，方便以后找到。'}</p>{query.trim() && <button className="secondary" onClick={() => onSearch('')}>清除搜索</button>}{!query.trim() && filter === 'saved' && <button className="secondary" onClick={() => onFilter('all')}>查看全部</button>}</div>}
  </section>;
}

function Detail({ item, onFavorite, playback, onPlay, query, onSentence, onRange, onExtract, onRetry, onSource }: PlaybackProps & { onSource: () => void; onRetry: () => void; onExtract: () => void; onRange: () => void; onSentence: (index: number) => void; query: string; item: Conversation; onFavorite: () => void }) {
  const period = timePeriod(item.time);
  const busy = item.extraction === 'extracting';
  const done = item.extraction === 'done';
  const stale = item.extraction === 'stale';
  const failed = item.extraction === 'failed';
  const status = extractionLabel(item);
  return <aside className="detail" aria-label="记忆详情" data-memory-id={item.id}>
    <div className="detail-date"><span>{shortDate(item.date)} {weekday(item.date)} · {item.time}</span><span><img src={`/icons/${period.icon}.svg`} alt="" />{period.label}</span></div>
    <div className="detail-top"><h1>{conversationTitle(item)}</h1><Player item={item} playback={playback} onPlay={onPlay} /><p className="v1-playback-note">{item.audioUrl ? (playbackSource(item, true).clipPath ? `真实播放 · 提取文件 · ${item.pauseSeconds ? "本地转写文字" : "文字/句子时间为模拟"}` : `真实播放 · 原录音 · ${item.pauseSeconds ? "本地转写文字" : "文字/句子时间为模拟"}`) : "模拟播放 · 无音频 · 句子时间为模拟"}{playback.id === item.id ? playback.playing ? ' · 正在播放' : playback.position >= item.duration ? ' · 已结束' : ' · 已暂停' : ' · 待播放'}</p><div className="detail-kind" role="status">{status}</div>{item.extraction && <p className="v1-playback-note">{busy ? item.sourcePath ? '正在生成音频文件。' : '正在模拟处理，不生成文件。' : done ? item.sourcePath ? '已生成 WAV 音频文件。' : '模拟完成，未生成真实音频文件。' : stale ? '范围已改变，请按新范围重新提取。' : item.extractionError ?? '模拟输出失败，范围已保留，可重试。'}</p>}{item.clipMissing && <p className="v1-source-missing">启动检查时未找到提取文件，记录已保留；恢复文件后可重试播放。</p>}{item.clipPath && <RevealClip key={item.clipPath} path={item.clipPath} />}{item.clipPath && <p className="v1-playback-note" style={{ overflowWrap: "anywhere" }} title={item.clipPath}>文件：{item.clipPath}</p>}<p className="listen-count">{item.listens ? `听过 ${item.listens} 次` : '还没有听过'}</p></div>
    <Transcript actualTranscript={!!item.pauseSeconds} realAudio={!!item.audioUrl} key={`${item.id}:${item.start}:${item.duration}`} lines={item.transcript} globalQuery={query} currentSentence={playback.id === item.id ? mockSentenceAt(item, playback.position) : -1} onSentence={onSentence} />
    <section className="source"><h2>来源录音</h2><p className="source-name" title={item.sourceName}>{item.sourceName}</p>{!item.sourceAvailable && <p className="v1-source-missing">{item.sourcePath ? "原录音不存在或无法访问" : "原录音已移到废纸篓（模拟）"}</p>}<div className="source-track"><i /></div><div className="source-meta"><span>{formatDuration(item.start)} — {formatDuration(item.start + item.duration)}</span><button disabled title={unavailable}>查看原录音 ↗</button></div><div className="v1-source-bottom"><button className="related" onClick={onSource}><ChevronRight size={15} />同一录音</button><button onClick={onRange} disabled={!item.sourceAvailable || busy} title={busy ? "提取中，暂不可调整" : item.sourceAvailable ? undefined : "原录音不存在，无法调整范围"}>调整范围</button></div></section>
    <footer className="detail-actions"><button onClick={onFavorite} aria-pressed={item.saved} className={`keep ${item.saved ? 'kept' : ''}`}><Heart size={17} fill={item.saved ? 'currentColor' : 'none'} />{item.saved ? '已收藏' : '收藏'}</button><button onClick={failed ? onRetry : onExtract} disabled={!item.sourceAvailable || busy || done} className="primary" title={!item.sourceAvailable ? "原录音不存在，无法提取" : undefined}><Scissors size={17} />{busy || done ? status : failed ? "重试提取" : stale ? "重新提取" : "提取片段"}</button></footer>
  </aside>;
}

/** The preview job belongs to the library, independent of the selected view. */
function MockExtraction({ id, attempt, dispatch }: { id: string; attempt: number; dispatch: Dispatch<LibraryAction> }) {
  useEffect(() => {
    const timer = window.setTimeout(() => dispatch({ type: 'extraction-result', id, attempt, outcome: id === '2026-09-10-7' && attempt % 2 === 1 ? 'failed' : 'done' }), 3000);
    return () => window.clearTimeout(timer);
  }, [id, attempt, dispatch]);
  return null;
}

function RealExtraction({ item, dispatch }: { item: Conversation; dispatch: Dispatch<LibraryAction> }) {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const attempt = item.extractionAttempt ?? 1;
    const task = desktop ? invoke<string>('export_v1_clip', { clipId: item.id, source: item.sourcePath, start: item.start, end: item.start + item.duration }) : Promise.reject('请在 macOS 桌面应用中提取真实音频。');
    void task.then(clipPath => dispatch({ type: 'extraction-result', id: item.id, attempt, outcome: 'done', clipPath }), error => dispatch({ type: 'extraction-result', id: item.id, attempt, outcome: 'failed', error: String(error) }));
  }, [item, dispatch]);
  return null;
}

export default function MainView({ items = [], persist = false, preview = false }: { items?: readonly Conversation[]; persist?: boolean; preview?: boolean }) {
  const folderRef = useRef<FolderActions>(null);
  const scanRef = useRef<ScanActions>(null);
  const [source, setSource] = useState<string | null>(null);
  const [scanCount, setScanCount] = useState<number | null>(null);
  const [scanRevision, setScanRevision] = useState(0);
  const sourceRef = useRef<string | null>(null);
  const sourceChanged = useCallback((path: string | null) => {
    if (sourceRef.current !== path) setScanCount(null);
    sourceRef.current = path;
    setSource(path);
  }, []);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void invoke<{ source: string | null; status: string; count: number | null }[]>('get_scan_history').then(records => {
      const latest = records.find(record => record.source === source);
      if (active) setScanCount(latest?.status === 'succeeded' ? latest.count : null);
    }).catch(() => { if (active) setScanCount(null); });
    return () => { active = false; };
  }, [source, scanRevision]);
  const [output, setOutput] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [rangeRequest, setRangeRequest] = useState<{ id: string; mode: "range" | "extract" } | null>(null);
  const [state, dispatch] = useReducer(libraryReducer, items, createLibrary);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [saveStatus, setSaveStatus] = useState(persist ? '正在保存…' : '浏览器预览 · 不保存');
  const [saveError, setSaveError] = useState('');
  const [saveAttempt, setSaveAttempt] = useState(0);
  useEffect(() => {
    if (!persist) return;
    let active = true;
    setSaveStatus('正在保存…');
    const task = pendingSave.catch(() => undefined).then(() => invoke('save_v1_library', { library: saveLibrary(stateRef.current.items) }));
    pendingSave = task;
    void task.then(() => { if (active) { setSaveStatus('已保存到本机'); setSaveError(''); } }, error => { if (active) { setSaveStatus('保存失败'); setSaveError(String(error)); } });
    return () => { active = false; };
  }, [state.items, persist, saveAttempt]);
  const trashRealSource = async (id: string): Promise<TrashOutcome> => {
    dispatch({ type: 'pause' });
    const task = pendingSave.catch(() => undefined).then(async () => {
      await invoke('save_v1_library', { library: saveLibrary(stateRef.current.items) });
      const result = await invoke<TrashOutcome>('trash_source', { sourceId: id });
      if (result.restored) {
        const action: LibraryAction = { type: 'source-restored', sourceId: id };
        stateRef.current = libraryReducer(stateRef.current, action); dispatch(action);
      }
      if (result.moved || result.pending) {
        const action: LibraryAction = { type: 'source-removed', sourceId: id, pending: result.pending, uncertain: result.uncertain };
        stateRef.current = libraryReducer(stateRef.current, action);
        dispatch(action);
      }
      return result;
    });
    pendingSave = task;
    return task;
  };
  const queueSaved = async () => {
    await pendingSave.catch(() => undefined);
    const data = await invoke<unknown>('load_v1_library');
    if (data === null) return;
    const retiredIds = await invoke<string[]>('retired_clip_ids');
    dispatch({ type: 'queue-items', items: restoreLibrary(data, [], convertFileSrc), retiredIds });
  };
  const [segmentMessage, setSegmentMessage] = useState('');
  const confirmSegments: ConfirmSegments = async result => {
    const incoming = segmentConversations(result, convertFileSrc);
    const task = pendingSave.catch(() => undefined).then(async () => {
      const current = stateRef.current.items;
      const next = addFirstSegments(current, incoming);
      await invoke('save_v1_library', { library: saveLibrary(next) });
      stateRef.current = libraryReducer(stateRef.current, { type: 'segments-saved', items: next, sourceId: result.source.id });
      dispatch({ type: 'segments-saved', items: next, sourceId: result.source.id });
      setSegmentMessage(next === current ? '该录音的分段已保存，已定位到首段' : `已保存 ${incoming.length} 段`);
    });
    pendingSave = task;
    await task;
  };
  const [audioError, setAudioError] = useState('');
  const activeAudio = state.items.find(item => item.id === state.playback.id && item.audioUrl);
  useEffect(() => {
    if (activeAudio || !state.playback.playing || !state.playback.id) return;
    const id = state.playback.id;
    let previous = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      dispatch({ type: 'tick', id, elapsed: (now - previous) / 1000 });
      previous = now;
    }, 200);
    return () => window.clearInterval(timer);
  }, [state.playback.id, state.playback.playing, activeAudio]);
  const rangeItem = state.items.find(item => item.id === rangeRequest?.id);
  const onPlay = (id: string) => dispatch({ type: 'play', id });
  const filtered = filteredItems(state);
  const selected = state.items.find(item => item.id === state.selectedId);
  const empty = <div className="empty-state"><h1>{source && scanCount === 0 ? '还没有录音' : '让声音，再被听见'}</h1><p>{source && scanCount === 0 ? '当前来源文件夹中没有找到可用录音。' : '选择录音来源，扫描后自动整理全部对话。'}</p><button className="secondary" disabled={!desktop} onClick={() => source ? scanRef.current?.scan() : folderRef.current?.chooseSource()}>{source ? source && scanCount === 0 ? '重新扫描' : '扫描新录音' : '选择录音文件夹'}</button>{source && scanCount === 0 && <button disabled={!desktop} onClick={() => folderRef.current?.chooseSource()}>更改录音来源</button>}</div>;
  return <main className="app v1-app"><Sidebar items={state.items} onOpenClip={id => dispatch({ type: 'open-clip', id })} preview={preview} onSource={sourceChanged} onResult={() => setScanRevision(value => value + 1)} folderRef={folderRef} scanRef={scanRef} onQueueSaved={queueSaved} onConfirm={confirmSegments} onOutput={setOutput} saveStatus={saveStatus} /><DayList empty={empty} query={state.query} onSearch={query => dispatch({ type: 'search', query })} playback={state.playback} onPlay={onPlay} items={filtered} dates={datesFor(filtered)} date={state.date} selectedId={state.selectedId} filter={state.filter} total={state.items.length} savedCount={state.items.filter(item => item.saved).length} onFilter={filter => dispatch({ type: 'filter', filter })} onFavorite={id => dispatch({ type: 'favorite', id })} onDate={date => dispatch({ type: 'date', date })} onSelect={id => dispatch({ type: 'select', id })} />{selected ? <Detail onSource={() => setSourceId(selected.sourceId)} onRetry={() => dispatch({ type: "retry-extraction", id: selected.id })} onExtract={() => { dispatch({ type: "pause" }); setRangeRequest({ id: selected.id, mode: "extract" }); }} onRange={() => { dispatch({ type: 'pause' }); setRangeRequest({ id: selected.id, mode: "range" }); }} onSentence={index => dispatch({ type: 'sentence', id: selected.id, index })} query={state.query} playback={state.playback} onPlay={onPlay} item={selected} onFavorite={() => dispatch({ type: 'favorite', id: selected.id })} /> : <aside className="detail"><div className="detail-empty"><h2>{state.items.length ? '选择一条记忆' : '暂时没有记忆'}</h2>{!state.items.length && <p>对话处理完成后，在这里查看</p>}</div></aside>}
    {activeAudio && <AudioPlayback preferExtracted key={`${activeAudio.id}:${activeAudio.start}:${activeAudio.duration}:${playbackSource(activeAudio, true).clipPath ?? "source"}`} item={activeAudio} playback={state.playback} dispatch={dispatch} onError={setAudioError} />}
    {segmentMessage && <div className="toast" role="status"><span>{segmentMessage}</span><button aria-label="关闭保存提示" onClick={() => setSegmentMessage('')}><X size={15} /></button></div>}
    {saveError && <div className="toast" role="alert"><span>记录未保存：{saveError}</span><button onClick={() => setSaveAttempt(value => value + 1)}>重试保存</button></div>}
    {audioError && <div className="toast" role="alert"><span>{audioError}</span><button aria-label="关闭播放提示" onClick={() => setAudioError('')}><X size={15} /></button></div>}
    {state.items.filter(item => item.extraction === 'extracting').map(item => item.sourcePath ? <RealExtraction key={`${item.id}:${item.extractionAttempt ?? 1}`} item={item} dispatch={dispatch} /> : <MockExtraction key={`${item.id}:${item.extractionAttempt ?? 1}`} id={item.id} attempt={item.extractionAttempt ?? 1} dispatch={dispatch} />)}
    {sourceId && <SourceDialog onRealTrash={trashRealSource} sourceId={sourceId} items={state.items} onTrash={() => dispatch({ type: "trash-source", sourceId })} onClose={() => setSourceId(null)} />}
    {rangeItem && <RangeDialog output={output} mode={rangeRequest?.mode} key={`${rangeItem.id}:${rangeRequest?.mode}`} item={rangeItem} onClose={() => setRangeRequest(null)} onSave={(start, end) => { dispatch({ type: rangeRequest?.mode === "extract" ? "extract" : "range", id: rangeItem.id, start, end }); setRangeRequest(null); }} />}
    {state.undoId && <div className="toast v1-undo" role="status"><span>已取消收藏</span><button onClick={() => dispatch({ type: 'undo' })}>撤销</button><button aria-label="关闭提示" onClick={() => dispatch({ type: 'dismiss' })}><X size={15} /></button></div>}
  </main>;
}
