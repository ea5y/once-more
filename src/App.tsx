import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, ChevronRight, Folder, FolderPlus, Heart, Library, Mic, Pause, Play, Search, Scissors, X } from 'lucide-react';
import Waveform from './components/Waveform';
import RecordingDialog from './components/RecordingDialog';
import { api, desktop } from './lib/api';
import { filterMemories, formatDuration, timePeriod } from './lib/memory';
import { demoMemories } from './lib/sample';
import type { Memory, Snapshot, View } from './types';

type Modal = 'library' | 'history' | 'export' | null;
const initial: Snapshot = { source: null, output: null, lastScan: null, recordings: [], memories: [] };
const labels = { Conversation: '对话', Ambient: '环境声', Laughter: '笑声', Recording: '手动片段' };

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(initial);
  const [demo, setDemo] = useState(new URLSearchParams(location.search).has('demo'));
  const [samples, setSamples] = useState(demoMemories);
  const [selectedId, setSelectedId] = useState<string | null>('demo-7');
  const [view, setView] = useState<View>('all');
  const [query, setQuery] = useState('');
  const [ascending, setAscending] = useState(true);
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [libraryInitialId, setLibraryInitialId] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [exportPath, setExportPath] = useState('');
  const [exportError, setExportError] = useState('');
  const audio = useRef<HTMLAudioElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const playAfterSelect = useRef(false);
  const memories = demo ? samples : snapshot.memories;
  const filtered = useMemo(() => filterMemories(memories, view, query), [memories, view, query]);
  const dates = useMemo(() => [...new Set(filtered.map(m => m.date))].sort().reverse(), [filtered]);
  const date = activeDate && dates.includes(activeDate) ? activeDate : dates[0];
  const visible = useMemo(() => filtered.filter(m => m.date === date).sort((a, b) => ascending ? a.time.localeCompare(b.time) : b.time.localeCompare(a.time)), [filtered, date, ascending]);
  const selected = visible.find(m => m.id === selectedId);
  const recording = snapshot.recordings.find(r => r.id === selected?.recordingId);
  const monthDate = new Date(`${date ?? new Date().toLocaleDateString('sv-SE')}T12:00:00`);
  const progress = selected ? Math.max(0, Math.min(1, (position - selected.start) / (selected.end - selected.start))) : 0;

  async function refresh() { const next = await api.snapshot(); setSnapshot(next); return next; }
  useEffect(() => { refresh().catch(e => setToast(`无法读取记忆库：${e}`)).finally(() => setLoading(false)); }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 6500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (modal) { audio.current?.pause(); dialog.current?.showModal(); }
    else dialog.current?.close();
  }, [modal]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); search.current?.focus(); } };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    const player = audio.current;
    if (!player) return;
    player.pause(); setPosition(selected?.start ?? 0);
    if (recording && selected) { player.src = api.audio(recording.path); player.load(); }
    else { player.removeAttribute('src'); player.load(); playAfterSelect.current = false; }
  }, [selected?.id, recording?.path]);

  async function chooseFolder(kind: 'source' | 'output') {
    try {
      if (await api.folder(kind)) { await refresh(); if (kind === 'source') { setDemo(false); setSelectedId(null); await scan(); } }
    } catch (e) { setToast(String(e)); }
  }
  async function scan() {
    setScanning(true);
    try { const count = await api.scan(); await refresh(); setToast(`扫描完成，找到 ${count} 份录音。`); if (count) { setLibraryInitialId(undefined); setModal('library'); } }
    catch (e) { setToast(`扫描未完成：${e}`); }
    finally { setScanning(false); }
  }
  function openLibrary(id?: string) { setLibraryInitialId(id); setModal('library'); }
  function toggleDemo() { setDemo(v => !v); setQuery(''); setView('all'); setActiveDate(null); setSelectedId(demo ? null : 'demo-7'); }
  async function updateMemory(memory: Memory) {
    if (memory.demo) setSamples(list => list.map(m => m.id === memory.id ? memory : m));
    else { await api.save(memory); setSnapshot(s => ({ ...s, memories: s.memories.map(m => m.id === memory.id ? memory : m) })); }
  }
  async function toggleSaved(memory: Memory) {
    try { await updateMemory({ ...memory, saved: !memory.saved }); }
    catch (e) { setToast(`未能保存：${e}`); }
  }
  async function play(memory: Memory) {
    if (memory.demo) { setSelectedId(memory.id); setToast('这是设计示例，没有附带录音。选择自己的录音文件夹后即可回听。'); return; }
    if (selectedId !== memory.id) { playAfterSelect.current = true; setSelectedId(memory.id); return; }
    const player = audio.current;
    if (!player) return;
    if (!player.paused) { player.pause(); return; }
    if (player.currentTime < memory.start || player.currentTime >= memory.end) player.currentTime = memory.start;
    try { await player.play(); await updateMemory({ ...memory, listens: memory.listens + 1 }); }
    catch { setToast('无法播放这份录音，请检查文件位置与音频格式。'); }
  }
  function seek(ratio: number) { if (selected && audio.current && !selected.demo) { const time = selected.start + ratio * (selected.end - selected.start); audio.current.currentTime = time; setPosition(time); } }
  async function saveNew(memory: Memory) {
    await api.save(memory); await refresh(); setDemo(false); setQuery(''); setView('all'); setActiveDate(memory.date); setSelectedId(memory.id); setModal(null); setToast('记忆已创建并收藏。原始录音保持不变。');
  }
  async function extract() {
    if (!selected) return;
    setExporting(true); setExportError('');
    try { setExportPath(await api.export(selected.id)); }
    catch (e) { setExportError(String(e)); }
    finally { setExporting(false); }
  }
  function exportDialog() {
    if (selected?.demo) { setToast('示例记忆没有音频文件。请先从自己的录音中创建一条记忆。'); return; }
    setExportPath(''); setExportError(''); setModal('export');
  }

  return <main className={`app ${desktop ? 'desktop' : 'browser'}`}>
    <aside className="sidebar">
      <div className="window-drag" data-tauri-drag-region>{!desktop && <div className="traffic-lights"><i /><i /><i /></div>}</div>
      <div className="brand"><div className="brand-name"><span className="brand-orbit" />NCE MORE</div><p>Let sounds live again.</p></div>
      <section className="jobs">
        <div className="section-heading"><span>JOBS</span><button onClick={() => setModal('history')}>历史任务</button></div>
        <button className="scan-button" disabled={loading || scanning} onClick={() => snapshot.source ? scan() : chooseFolder('source')}>{scanning ? '正在扫描录音…' : snapshot.source ? '扫描新录音' : '选择录音来源'}</button>
        {scanning ? <><div className="indeterminate"><span /></div><p>扫描时仍可浏览和收听</p></> : <p>{snapshot.lastScan ? `最近扫描：${new Date(Number(snapshot.lastScan) * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '尚未扫描'}</p>}
        {!!snapshot.recordings.length && <button className="library-button" onClick={() => openLibrary()}><Library size={15} />浏览录音 <span>{snapshot.recordings.length}</span></button>}
      </section>
      <div className="sidebar-bottom">
        <button className={`demo-button ${demo ? 'active' : ''}`} onClick={toggleDemo}>{demo ? '设计示例 · 返回我的记忆' : '查看设计示例'}</button>
        <section className="config"><div className="section-heading">CONFIG</div>
          <button className="folder-setting" disabled={scanning} onClick={() => chooseFolder('source')}><Mic size={23} /><span>录音来源<small title={snapshot.source ?? ''}>{snapshot.source ?? '未选择文件夹'}</small></span></button>
          <button className="folder-setting" onClick={() => chooseFolder('output')}><Folder size={23} /><span>输出位置<small title={snapshot.output ?? ''}>{snapshot.output ?? '未设置'}</small></span></button>
        </section>
      </div>
    </aside>

    <section className="timeline">
      <header className="timeline-header">
        <div className="month" data-tauri-drag-region><span>{monthDate.getFullYear()}</span><strong>{monthDate.toLocaleDateString('en-US', { month: 'long' }).toUpperCase()}</strong></div>
        <label className="search"><Search size={15} /><input ref={search} value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索你的记忆…" aria-label="搜索你的记忆" />{query && <button aria-label="清除搜索" onClick={() => setQuery('')}><X size={13} /></button>}</label>
        <nav className="tabs" aria-label="记忆视图">{([['all', '全部'], ['saved', '收藏']] as [View, string][]).map(([key, label]) => <button key={key} aria-current={view === key ? 'page' : undefined} className={view === key ? 'active' : ''} onClick={() => setView(key)}>{label}<span>{filterMemories(memories, key, '').length}</span></button>)}</nav>
      </header>

      {visible.length ? <>
        <div className="day-heading"><span className="day-date">{date.slice(5).replace('-', '.')}</span><span>{new Date(`${date}T12:00:00`).toLocaleDateString('zh-CN', { weekday: 'short' })} · {visible.length} 条记忆</span><button onClick={() => setAscending(v => !v)}>时间顺序 {ascending ? '↑' : '↓'}</button></div>
        <div className="timeline-content">
          <div className="memory-list">
            {visible.map((memory, index) => {
              const period = timePeriod(memory.time);
              const showPeriod = index === 0 || timePeriod(visible[index - 1].time).label !== period.label;
              const active = selected?.id === memory.id;
              return <div className="memory-item" key={memory.id}>
                {showPeriod && <div className="period"><img src={`/icons/${period.icon}.svg`} alt="" />{period.label}</div>}
                <article className={`memory-row ${active ? 'selected' : ''}`}>
                  <button className="memory-select" aria-label={`查看记忆：${memory.title}`} aria-pressed={active} onClick={() => { playAfterSelect.current = false; setSelectedId(memory.id); }}><span className="timeline-dot" /><time>{memory.time}</time><span className="memory-title">{memory.title}</span></button>
                  <button className={`row-save ${memory.saved ? 'saved' : ''}`} aria-label={memory.saved ? `取消收藏：${memory.title}` : `收藏：${memory.title}`} onClick={() => toggleSaved(memory)}><Heart size={13} fill={memory.saved ? 'currentColor' : 'none'} /></button>
                  <div className="row-player"><button className="play small" aria-label={`${active && playing ? '暂停' : '播放'}：${memory.title}`} onClick={() => play(memory)}>{active && playing ? <Pause size={10} fill="currentColor" /> : <Play size={10} fill="currentColor" />}</button><Waveform demo={memory.demo} progress={active ? progress : 0} /><span>{formatDuration(memory.end - memory.start)}</span><small>{memory.listens ? `听过 ${memory.listens} 次` : '未听过'}</small></div>
                </article>
              </div>;
            })}
          </div>
          <nav className="date-rail" aria-label="日期导航">{dates.map(d => <button key={d} className={d === date ? 'active' : ''} onClick={() => { setActiveDate(d); setSelectedId(null); }}>{d.slice(5).replace('-', '.')}</button>)}</nav>
        </div>
      </> : <div className="empty-state">
        {loading ? <><AudioLines size={48} /><h1>正在打开记忆库…</h1></> : query ? <><Search size={48} /><h1>没有找到相关记忆</h1><p>没有与“{query}”匹配的内容</p><small>试试更短的关键词，或换一种说法。</small><button className="secondary" onClick={() => setQuery('')}>清除搜索</button></> : !snapshot.source && !demo ? <><FolderPlus size={48} /><h1>让声音，再被听见</h1><p>选择存放录音的文件夹，开始整理你的声音记忆。</p><button className="primary" onClick={() => chooseFolder('source')}>选择录音文件夹</button><small>之后可以在左栏更改录音来源</small></> : view !== 'all' ? <><Heart size={42} /><h1>还没有收藏的记忆</h1><p>点击记忆旁的爱心，方便以后找到。</p><button className="secondary" onClick={() => setView('all')}>查看全部</button></> : snapshot.recordings.length ? <><AudioLines size={48} /><h1>声音已经在这里</h1><p>找到 {snapshot.recordings.length} 份录音，听一听，创建一条记忆。</p><button className="primary" onClick={() => openLibrary()}>浏览录音</button><small>当前版本支持手动选取片段</small></> : <><AudioLines size={48} /><h1>还没有录音</h1><p>当前来源文件夹中没有找到可用录音。</p><small className="empty-path">{snapshot.source}</small><div className="empty-actions"><button className="primary" disabled={scanning} onClick={scan}>重新扫描</button><button className="secondary" onClick={() => chooseFolder('source')}>更改录音来源</button></div></>}
      </div>}
    </section>

    <aside className="detail">
      {selected ? <>
        <div className="detail-date" data-tauri-drag-region><span>{selected.date.slice(5).replace('-', '.')} {new Date(`${selected.date}T12:00:00`).toLocaleDateString('zh-CN', { weekday: 'short' })} · {selected.time}</span><span><img src={`/icons/${timePeriod(selected.time).icon}.svg`} alt="" />{timePeriod(selected.time).label}</span></div>
        <div className="detail-top"><h1>{selected.title}</h1>
          <div className="detail-player"><button className="play" aria-label={playing ? '暂停选中记忆' : '播放选中记忆'} onClick={() => play(selected)}>{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button><Waveform demo={selected.demo} large progress={progress} onSeek={selected.demo ? undefined : seek} /><span>{formatDuration(selected.end - selected.start)}</span></div>
          <div className="detail-kind"><span>{labels[selected.kind]}{selected.demo && selected.kind === 'Conversation' ? ' · 2 人' : ''}</span>{selected.demo && <span className="sample-label">设计示例</span>}</div>
          <p className="listen-count">{selected.listens ? `听过 ${selected.listens} 次` : '还没有听过'}{selected.demo ? ' · 示例内容' : ' · 声音保留在原始录音中'}</p>
        </div>
        <section className="transcript"><h2>原文</h2>{selected.transcript.length ? selected.transcript.map((line, i) => <p className={line.speaker === '她' ? 'warm' : ''} key={i}><span>{line.speaker}</span>{line.text}</p>) : <p className="no-transcript">{selected.demo && selected.kind !== 'Conversation' ? '这一刻，让声音自己说话。' : '尚无转写内容，可以先回听这段声音。'}</p>}</section>
        <section className="source"><h2>来源录音</h2><p className="source-name" title={recording?.path}>{selected.demo ? '2026.09.10 21:00 - 海边的计划.wav' : recording?.name ?? '原录音不可用'}</p><div className="source-track"><i /></div><div className="source-meta"><span>{formatDuration(selected.start)} — {formatDuration(selected.end)}</span><button disabled={!!selected.demo} onClick={() => openLibrary(selected.recordingId)}>查看原录音 ↗</button></div><button className="related" disabled={!!selected.demo} onClick={() => openLibrary(selected.recordingId)}><ChevronRight size={15} />{selected.demo ? '同一录音 · 其他 4 个片段' : '打开原始录音，创建更多记忆'}</button></section>
        <footer className="detail-actions"><button className={`keep ${selected.saved ? 'kept' : ''}`} onClick={() => toggleSaved(selected)}><Heart size={17} fill={selected.saved ? 'currentColor' : 'none'} />{selected.saved ? '已收藏' : '收藏'}</button><button className="primary" onClick={exportDialog}><Scissors size={17} />提取片段</button></footer>
      </> : <><div className="detail-placeholder-label" data-tauri-drag-region>记忆详情</div><div className="detail-empty"><h2>选择一条记忆</h2><p>在这里查看原文与来源录音</p></div></>}
    </aside>

    <audio ref={audio} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onLoadedMetadata={e => {
      if (!selected) return;
      e.currentTarget.currentTime = selected.start;
      if (playAfterSelect.current) { playAfterSelect.current = false; play(selected); }
    }} onTimeUpdate={e => { setPosition(e.currentTarget.currentTime); if (selected && e.currentTarget.currentTime >= selected.end) { e.currentTarget.pause(); e.currentTarget.currentTime = selected.start; } }} onError={() => { if (audio.current?.getAttribute('src')) setToast('无法播放：原录音可能已移动，或该格式暂不受系统支持。'); }} />

    {toast && <div className="toast" role="status">{toast}<button aria-label="关闭提示" onClick={() => setToast('')}><X size={15} /></button></div>}
    <dialog ref={dialog} onCancel={e => { if (exporting) e.preventDefault(); else setModal(null); }} onClick={e => { if (e.target === dialog.current && !exporting) setModal(null); }}>
      <div className="dialog-inner"><header className="dialog-heading"><h2>{modal === 'library' ? '录音里的声音' : modal === 'export' ? '提取片段' : '最近任务'}</h2><button aria-label="关闭窗口" disabled={exporting} onClick={() => setModal(null)}><X size={19} /></button></header>
        {modal === 'library' && <RecordingDialog recordings={snapshot.recordings} initialId={libraryInitialId} onSave={saveNew} />}
        {modal === 'history' && <div className="history"><AudioLines size={28} /><h3>{scanning ? '正在扫描录音' : snapshot.lastScan ? '最近一次扫描已完成' : '还没有扫描任务'}</h3><p>{snapshot.lastScan ? new Date(Number(snapshot.lastScan) * 1000).toLocaleString('zh-CN') : '选择录音来源后即可开始。'}</p><p>记忆库中有 {snapshot.recordings.length} 份录音、{snapshot.memories.length} 条记忆。</p><small>当前版本显示最近一次扫描记录。</small></div>}
        {modal === 'export' && selected && <div className="export-dialog"><p>{selected.title}</p><small>{formatDuration(selected.start)} — {formatDuration(selected.end)} · WAV 音频</small><label>保存到<span className="path-value">{snapshot.output ? `${snapshot.output}/clips` : '尚未选择输出位置'}</span></label><button className="secondary" disabled={exporting} onClick={() => chooseFolder('output')}>选择输出文件夹</button>{exportError && <p className="error" role="alert">{exportError}</p>}{exportPath ? <p className="success" role="status">已提取为独立音频：<br />{exportPath}</p> : <button className="primary wide" disabled={!snapshot.output || exporting} onClick={extract}>{exporting ? '正在提取…' : '提取为独立音频'}</button>}<small>原始录音不会被修改。</small></div>}
      </div>
    </dialog>
  </main>;
}
