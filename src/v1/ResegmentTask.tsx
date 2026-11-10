import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PausePreviewResult } from './segmentation';
import type { ProcessingJob } from './ProcessingHistory';

export default function ResegmentTask({ job, onClose, onRefresh, onBusy }: { job: ProcessingJob; onClose: () => void; onRefresh: () => Promise<void>; onBusy: (busy: boolean) => void }) {
  const [seconds, setSeconds] = useState(String(job.seconds ?? 6));
  const [preview, setPreview] = useState<PausePreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const value = Number(seconds);
  const valid = seconds.trim() !== '' && Number.isFinite(value) && value > 0;
  async function calculate() {
    if (lock.current || !valid) return;
    lock.current = true; setBusy(true); onBusy(true); setError(''); setPreview(null);
    try { setPreview(await invoke<PausePreviewResult>('preview_pause_segments', { id: job.id, seconds: value })); }
    catch { setError('预览未完成，请确认原录音可访问后重试。'); }
    finally { lock.current = false; setBusy(false); onBusy(false); }
  }
  async function confirm() {
    if (lock.current || !preview || preview.seconds !== value) return;
    lock.current = true; setBusy(true); onBusy(true); setError('');
    try {
      await invoke('resegment_recording', { id: job.id, seconds: value });
      await onRefresh(); await invoke('run_processing'); onClose();
    } catch {
      await onRefresh().catch(() => undefined);
      setError('操作未完成，请关闭此页查看任务状态；若显示清理未完成，可重试继续清理。');
      setPreview(null);
    } finally { lock.current = false; setBusy(false); onBusy(false); }
  }
  return <section className="v1-trash-confirm v1-resegment" aria-label="重新分段">
    <h3>重新分段 · {job.name}</h3>
    <label>连续停顿达到 <input aria-label="本次停顿秒数" type="number" min="0" step="any" value={seconds} disabled={busy} onChange={e => { setSeconds(e.target.value); setPreview(null); }}/> 秒</label>
    <p>仅用于这份录音。复用转写全文，按新的停顿时长重新划分。</p>
    <button disabled={busy || !valid} onClick={() => void calculate()}>{busy ? '正在处理…' : '重新预览'}</button>
    {preview && <div className="v1-task-transcript"><p>预览共 {preview.parts.length} 段</p>{preview.parts.map((part, index) => <p key={index}>{index + 1}. {part.start.toFixed(1)}–{part.end.toFixed(1)} 秒 · {part.text.join('')}</p>)}</div>}
    <h3>旧片段将全部清空</h3>
    <p>重新分段将删除这份录音的全部旧片段及已提取音频，收藏、边界调整和收听记录也将清空。</p>
    <p>此操作不可撤销。原录音和转写全文保留。</p>
    <p>确认后立即清空旧内容，成功后加入队尾。</p>
    {error && <p role="alert">{error}</p>}
    <footer><button disabled={busy} onClick={onClose}>取消</button><button disabled={busy || !preview || preview.seconds !== value} onClick={() => void confirm()}>删除旧片段并重新分段</button></footer>
  </section>;
}
