import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X } from 'lucide-react';
import { desktop } from '../lib/api';
import type { ConfirmSegments } from './segmentation';
import PausePreview from './PausePreview';
type Phase = 'pending' | 'preparing' | 'transcribing' | 'failed' | 'completed';
interface Recording { id: string; name: string; phase: Phase; error: string | null; duration: number | null }
interface Segment { start: number; end: number; text: string }
const labels: Record<Phase, string> = { pending: '待转写', preparing: '准备音频', transcribing: '正在转写', failed: '转写失败', completed: '转写完成' };
function time(seconds: number) { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toFixed(2).padStart(5, '0')}`; }
function TranscriptionDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: ConfirmSegments }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<Recording[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [sending, setSending] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<Recording | null>(null);
  const [reader, setReader] = useState<{ recording: Recording; segments: Segment[] } | null>(null);
  const requestLock = useRef(false);
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close(); }, []);
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const next = await invoke<Recording[]>('list_transcriptions'); if (active) { setRows(next); setLoaded(true); setLoadError(''); } }
      catch (reason) { if (active) setLoadError(`录音列表读取失败：${String(reason)}`); }
      if (active) timer = setTimeout(() => void refresh(), 1000);
    }
    void refresh(); return () => { active = false; clearTimeout(timer); };
  }, []);
  async function start(recording: Recording) {
    if (requestLock.current) return;
    requestLock.current = true; setSending(true); setError('');
    try {
      await invoke('start_transcription', { id: recording.id });
      setRows(await invoke<Recording[]>('list_transcriptions')); setSelected(recording.id);
    } catch (reason) { setError(String(reason)); }
    finally { requestLock.current = false; setSending(false); }
  }
  async function read(recording: Recording) {
    if (requestLock.current) return;
    requestLock.current = true; setSending(true); setError('');
    try { const segments = await invoke<Segment[]>('read_transcription', { id: recording.id }); setReader({ recording, segments }); }
    catch (reason) { setError(`全文读取失败：${String(reason)}`); }
    finally { requestLock.current = false; setSending(false); }
  }
  const current = rows.find(row => row.id === selected);
  const busy = sending || rows.some(row => row.phase === 'preparing' || row.phase === 'transcribing');
  function back() { if (reader) setReader(null); else if (selected) setSelected(null); else onClose(); }
  function action(row: Recording) {
    return row.phase === 'completed' ? <div className="v1-transcription-actions"><button disabled={sending} onClick={() => void read(row)}>查看全文</button><button disabled={sending} onClick={() => setPreview(row)}>分段预览</button></div>
      : row.phase === 'pending' || row.phase === 'failed' ? <button disabled={busy} onClick={() => void start(row)}>{row.phase === 'failed' ? '重试' : '开始转写'}</button> : null;
  }
  return <><dialog ref={dialog} className="v1-range-dialog v1-model-dialog v1-transcription-dialog" aria-labelledby="transcription-heading" onCancel={e => { e.preventDefault(); back(); }}>
    <div className="v1-source-dialog-body">
      <h2 id="transcription-heading">{reader ? '录音全文' : current ? '本地转写任务' : '选择录音'}</h2>
      <button className="v1-range-close" aria-label="关闭当前弹框" onClick={back}><X size={20} /></button>
      <p>{reader ? `${reader.recording.name} · 已保存到本机 · 简体中文` : '已扫描录音 · 每次手动开始一条，本地完整转写'}</p>
      <div className="v1-transcription-content">
        {reader ? reader.segments.length ? reader.segments.map((segment, index) => <div className="v1-transcription-sentence" key={index}><time>{time(segment.start)}–{time(segment.end)}</time><span>{segment.text}</span></div>) : <p>转写完成，未识别到文字。</p>
          : current ? <section className="v1-transcription-task"><h3 role="status">{labels[current.phase]}</h3><p>{current.name}</p><p>{current.phase === 'preparing' ? '正在准备本地转写所需音频' : current.phase === 'transcribing' ? '完整转写录音，请稍候；可关闭此窗口' : current.phase === 'completed' ? '全文和时间戳已保存，重开后仍可查看' : current.error}</p>{action(current)}</section>
          : !loaded ? <p>正在读取录音…</p> : rows.length === 0 ? <p>还没有已扫描录音，请先扫描来源文件夹。</p> : rows.map(row => <div className="v1-transcription-row" key={row.id}><div><strong>{row.name}</strong><p>{row.duration != null ? `${time(row.duration)} · ` : ''}{labels[row.phase]}</p>{row.error && <p role="alert">{row.error}</p>}</div>{action(row)}{['preparing', 'transcribing'].includes(row.phase) && <button onClick={() => setSelected(row.id)}>查看状态</button>}</div>)}
      </div>
      {loadError && <p role="alert">{loadError}</p>}
      {error && <p role="alert">{error}</p>}
      {!reader && <p>模型未就绪时先准备模型；处理中暂不可开始另一条。</p>}
      <footer><button onClick={back}>关闭</button></footer>
    </div>
  </dialog>{preview && <PausePreview onConfirm={async result => { await onConfirm(result); onClose(); }} recording={preview} onClose={() => setPreview(null)} />}</>;
}
export default function LocalTranscription({ onConfirm }: { onConfirm: ConfirmSegments }) {
  const [open, setOpen] = useState(false);
  return <><button className="v1-model-entry" disabled={!desktop} onClick={() => setOpen(true)}>选择录音转写</button>{open && <TranscriptionDialog onConfirm={onConfirm} onClose={() => setOpen(false)} />}</>;
}
