import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X } from 'lucide-react';
import type { SavedLibrary } from './persistence';
import type { PausePreviewResult as Preview, ConfirmSegments } from './segmentation';
const pending = new Map<string, Promise<Preview>>();
function calculate(id: string, seconds: number) {
  const key = `${id}:${seconds}`;
  let request = pending.get(key);
  if (!request) {
    request = invoke<Preview>('preview_pause_segments', { id, seconds }).finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return request;
}
function time(value: number) {
  const millis = Math.round(value * 1000);
  return `${Math.floor(millis / 60000).toString().padStart(2, '0')}:${(Math.floor(millis / 1000) % 60).toString().padStart(2, '0')}${millis % 1000 ? `.${(millis % 1000).toString().padStart(3, '0').replace(/0+$/, '')}` : ''}`;
}
export default function PausePreview({ recording, onClose, onConfirm }: { onConfirm: ConfirmSegments; recording: { id: string; name: string }; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const lock = useRef(true);
  const [input, setInput] = useState('6');
  const [result, setResult] = useState<Preview | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const seconds = Number(input);
  const valid = input.trim() !== '' && Number.isFinite(seconds) && seconds > 0;
  const changed = result && valid && seconds !== result.seconds;
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close(); }, []);
  useEffect(() => {
    let active = true;
    lock.current = true; setBusy(true);
    void invoke<SavedLibrary | null>('load_v1_library').then(library => {
      const saved = library?.items.find(item => item.sourceId === recording.id);
      const seconds = saved?.pauseSeconds ?? 6;
      if (active) setInput(String(seconds));
      return calculate(recording.id, seconds);
    }).then(value => { if (active) { setResult(value); setError(''); } }, reason => { if (active) setError(String(reason)); })
      .finally(() => { if (active) { lock.current = false; setBusy(false); } });
    return () => { active = false; };
  }, [recording.id]);
  async function preview() {
    if (lock.current || !valid) return;
    lock.current = true; setBusy(true); setError('');
    try { setResult(await calculate(recording.id, seconds)); }
    catch (reason) { setError(String(reason)); }
    finally { lock.current = false; setBusy(false); }
  }
  async function confirm() {
    if (lock.current || !result || !valid || changed) return;
    lock.current = true; setSaving(true); setError('');
    try { await onConfirm(result); }
    catch (reason) { setError(`保存失败：${String(reason)}`); }
    finally { lock.current = false; setSaving(false); }
  }
  return <dialog ref={dialog} className="v1-range-dialog v1-model-dialog v1-pause-dialog" aria-labelledby="pause-heading" onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <div className="v1-source-dialog-body">
      <h2 id="pause-heading">按停顿分段</h2>
      <button className="v1-range-close" aria-label="关闭分段预览" disabled={saving} onClick={onClose}><X size={20} /></button>
      <p>{recording.name} · 已转写</p>
      <form className="v1-pause-controls" onSubmit={event => { event.preventDefault(); void preview(); }}>
        <label htmlFor="pause-seconds">连续停顿达到</label>
        <input id="pause-seconds" type="number" inputMode="decimal" step="any" value={input} disabled={busy || saving} onChange={event => setInput(event.target.value)} aria-invalid={!valid} aria-describedby={!valid ? 'pause-invalid' : 'pause-help'} />
        <span>秒</span><small>默认 6 秒，可修改</small>
        <button type="submit" disabled={busy || saving || !valid}>{busy ? '正在预览…' : error ? '重试预览' : '重新预览'}</button>
      </form>
      <p id="pause-help">只按停顿切分；修改秒数后，点击重新预览。</p>
      {!valid && <p id="pause-invalid" role="alert">请输入大于 0 的停顿秒数。</p>}
      {error && <p role="alert">{error}{result ? '；保留上次预览结果。' : ''}</p>}
      <div className="v1-pause-results" aria-busy={busy}>
        {result && <><h3 role="status">当前预览 · 按 {result.seconds} 秒切分 · 共 {result.parts.length} 段</h3>
          {changed && <p>参数已修改，以下仍为上次预览结果。</p>}
          {result.parts.map((part, index) => <section className="v1-pause-part" key={`${result.seconds}:${index}`}>
            <h4>{String(index + 1).padStart(2, '0')}　{part.title}</h4>
            <p>{time(part.start)}—{time(part.end)} · {time(part.end - part.start)}</p>
          </section>)}</>}
        {!result && busy && <p role="status">正在读取原录音并计算停顿…</p>}
      </div>
      <p>确认后保存这些分段，在主界面查看文字与回听。</p>
      <footer><button disabled={saving} onClick={onClose}>关闭</button><button className="primary" disabled={busy || saving || !result || !valid || !!changed} onClick={() => void confirm()}>{saving ? '正在保存…' : '确认分段'}</button></footer>
    </div>
  </dialog>;
}
