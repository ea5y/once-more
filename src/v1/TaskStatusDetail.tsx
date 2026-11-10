import TaskProgress from './TaskProgress';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { processingError } from './errorMessages';
import { statusText, type ProcessingJob } from './ProcessingHistory';
export interface TaskAssets { transcriptReady: boolean; sourceExists: boolean | null }
export default function TaskStatusDetail({ job, busy, onRetry, onRead, onResegment, children }: { job: ProcessingJob; busy: boolean; onRetry: () => void; onRead: () => void; onResegment?: () => void; children?: React.ReactNode }) {
  const [assets, setAssets] = useState<TaskAssets | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      try { const next = await invoke<TaskAssets>('task_assets', { id: job.id }); if (active) { setAssets(next); setFailed(false); } }
      catch { if (active) { setAssets(null); setFailed(true); } }
      if (active) timer = setTimeout(check, 1500);
    }
    void check();
    return () => { active = false; clearTimeout(timer); };
  }, [job.id, attempt]);
  return <>
    <TaskState job={job} busy={busy} onRetry={onRetry}/>
    {failed ? <div role="alert"><p>录音状态读取失败，请重试。</p><button onClick={() => setAttempt(n => n + 1)}>重新检查</button></div> : !assets ? <p role="status">正在检查录音状态…</p> : assets.sourceExists === false ? <div className="v1-task-missing"><p>原录音不存在 · 已有全文与片段仍可查看，无法重新分段。</p><button disabled>重新分段</button></div> : assets.sourceExists === null ? <p>暂时无法确认原录音是否可访问。</p> : null}
    {job.status === 'completed' && assets?.sourceExists && assets.transcriptReady && onResegment && <button disabled={busy} onClick={onResegment}>重新分段</button>}
    {children ?? <><h3>转写全文</h3>{assets?.transcriptReady ? <button disabled={busy} onClick={onRead}>查看全文</button> : assets && <p>全文尚未就绪</p>}</>}
  </>;
}
export function TaskState({job,busy,onRetry}: {job:ProcessingJob;busy:boolean;onRetry:()=>void}) {
  return <section className="v1-task-state" aria-label="任务状态">
    {job.status === 'waiting' && <p>已加入队尾，等待处理。</p>}
    {job.status === 'running' && <><p>{statusText(job)} · 可继续浏览已有片段。</p><TaskProgress job={job} /></>}
    {job.status === 'interrupted' && <p>上次处理未完成，沿用原设置继续。</p>}
    {job.status === 'failed' && <p role="alert">{processingError(job.error,job.stage,job.status)}</p>}
    {['failed','interrupted'].includes(job.status) && <><button disabled={busy} onClick={onRetry}>{job.status === 'failed' ? '重试' : '继续'}</button><p>加入队尾，沿用原任务设置。</p></>}
  </section>;
}
