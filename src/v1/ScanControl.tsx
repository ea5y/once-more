import { elapsedText } from './ProcessingHistory';
import TaskProgress from './TaskProgress';
import type { Conversation } from './model';
import { forwardRef, useImperativeHandle, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { desktop } from '../lib/api';
import ModelPreparation, { type ModelActions, type ModelStatus } from './ModelPreparation';
import type { ConfirmSegments } from './segmentation';
import ProcessingHistory, { type ProcessingSnapshot } from './ProcessingHistory';
import { cycleView } from './scanCycle';

export interface ScanActions { scan: () => void }
export default forwardRef<ScanActions, { items: readonly Conversation[]; onOpenClip: (id: string) => void; onResult: () => void; onQueueSaved: () => Promise<void>; onConfirm: ConfirmSegments; onScanning: (value: boolean) => void }>(function ScanControl({ items, onOpenClip, onResult, onScanning, onQueueSaved }, ref) {
  const [history, setHistory] = useState(false);
  const [queue, setQueue] = useState<ProcessingSnapshot>({ jobs: [], active: false, seconds: 6 });
  const [queueError, setQueueError] = useState(false);
  const [loaded, setLoaded] = useState(!desktop);
  const [scanning, setScanning] = useState(false);
  const [sending, setSending] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [message, setMessage] = useState('');
  const model = useRef<ModelActions>(null);
  const lock = useRef(false);
  const completed = useRef('');
  const onSaved = useRef(onQueueSaved); onSaved.current = onQueueSaved;
  async function refreshQueue() {
    const next = await invoke<ProcessingSnapshot>('processing_status');
    setQueue(next); setLoaded(true); setQueueError(false);
    const key = next.jobs.filter(j => j.status === 'completed').map(j => j.id).sort().join('|');
    if (key !== completed.current) { await onSaved.current(); completed.current = key; }
    return next;
  }
  const refreshRef = useRef(refreshQueue); refreshRef.current = refreshQueue;
  useEffect(() => {
    if (!desktop) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { if (active) await refreshRef.current(); } catch (e) { console.error(e); if (active) setQueueError(true); }
      if (active) timer = setTimeout(() => void refresh(), 1500);
    }
    void invoke<string | null>('get_v1_scan_time').then(t => { if (active) setScanned(!!t); }).catch(console.error);
    void refresh(); return () => { active = false; clearTimeout(timer); };
  }, []);
  async function scan() {
    if (lock.current || !desktop || !loaded) return;
    lock.current = true; setSending(true); setMessage('');
    try {
      // Read authoritative status again, including work started from the task dialog.
      const next = await refreshQueue();
      const state = cycleView(next);
      if (state.disabled) return;
      const modelStatus = await invoke<ModelStatus>('get_model_status');
      if (modelStatus.phase !== 'ready') { model.current?.open(); return; }
      if (state.resume) {
        for (const job of next.jobs.filter(j => j.status === 'interrupted')) await invoke('retry_processing', { id: job.id });
        await invoke('run_processing');
      } else {
        setScanning(true); onScanning(true);
        await invoke<number>('scan_recordings', { retryId: null });
        await invoke<number>('enqueue_processing', { retryId: null });
        setScanned(true);
        await invoke('run_processing');
        onResult();
      }
      await refreshQueue();
    } catch (reason) { console.error('Scan cycle failed', reason); setMessage('处理未能启动，请检查录音来源和处理任务后重试。'); }
    finally { lock.current = false; setSending(false); setScanning(false); onScanning(false); }
  }
  useImperativeHandle(ref, () => ({ scan: () => { void scan(); } }));
  const view = cycleView(queue, scanning);
  return <section className="jobs" aria-label="录音处理">
    <div className="section-heading"><span>JOBS</span><button disabled={!desktop} onClick={() => setHistory(true)}>处理任务</button></div>
    <button className="scan-button" disabled={!desktop || sending || !loaded || queueError || view.disabled} onClick={() => void scan()}>{view.label}</button>
    <p role="status">{!desktop ? '请在桌面应用中扫描' : !loaded ? '正在读取任务…' : view.summary || (scanned ? '没有新录音' : '尚未扫描')}</p>
    {view.disabled && <><TaskProgress job={scanning ? undefined : queue.jobs.find(j => j.status === 'running')} />{elapsedText(queue.jobs.find(j => j.status === 'running')) && <p>{elapsedText(queue.jobs.find(j => j.status === 'running'))}</p>}<p>仍可浏览和回听已有记忆</p></>}
    {message && <p className="v1-scan-message" role="alert">{message}</p>}
    {queueError && <p role="alert">任务状态读取失败，正在重试。</p>}
    <ModelPreparation ref={model} />
    {history && <ProcessingHistory items={items} onOpenClip={onOpenClip} snapshot={queue} onRefresh={async () => { await refreshQueue(); await onSaved.current(); }} onClose={() => setHistory(false)} />}
  </section>;
});
