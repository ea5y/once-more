import TaskProgress from './TaskProgress';
import ResegmentTask from './ResegmentTask';
import TaskStatusDetail from './TaskStatusDetail';
import CompletedTaskDetail from './CompletedTaskDetail';
import type { Conversation } from './model';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { processingError } from './errorMessages';
import { X } from 'lucide-react';
import { openSidebarDialog } from './openSidebarDialog';
export interface ProcessingJob { elapsedSeconds?: number | null; progress?: number | null; id: string; name: string; status: string; stage: string; seconds: number | null; error: string | null; batchId?: string | null; batchStarted?: number | null; duration?: number | null; clipCount?: number; sourcePath?: string }
export interface ProcessingSnapshot { jobs: ProcessingJob[]; active: boolean; seconds: number; cycleIds?: string[] }
export const stageLabels: Record<string, string> = { verifying: '正在校验转写结果…', cleaning: '正在清理旧片段', preparing: '准备音频', transcribing: '正在转写', segmenting: '正在分段', saving: '正在保存', completed: '已完成' };
export default function ProcessingHistory({ snapshot, onRefresh, onClose, items = [], onOpenClip = () => {} }: { items?: readonly Conversation[]; onOpenClip?: (id: string) => void; snapshot: ProcessingSnapshot; onRefresh: () => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [resegment, setResegment] = useState(false);
  const [settings, setSettings] = useState(false);
  const [reader, setReader] = useState<{ name: string; rows: { start: number; text: string }[] } | null>(null);
  const [seconds, setSeconds] = useState(String(snapshot.seconds));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  useEffect(() => { const node = dialog.current!; openSidebarDialog(node); return () => node.close(); }, []);
  async function act(task: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await task(); await onRefresh(); } catch (reason) { console.error('Processing operation failed', reason); setError('操作未完成，请重试。'); }
    finally { lock.current = false; setBusy(false); }
  }
  const valid = seconds.trim() !== '' && Number.isFinite(Number(seconds)) && Number(seconds) > 0;
  const detail = snapshot.jobs.find(job => job.id === detailId);
  const groups = groupJobs(snapshot.jobs);
  function close() { if (busy) return; if (clearing) setClearing(false); else if (resegment) setResegment(false); else if (reader) setReader(null); else if (detailId) setDetailId(null); else if (settings) setSettings(false); else onClose(); }
  return <dialog ref={dialog} className="v1-range-dialog v1-history-dialog" aria-labelledby="processing-heading" onCancel={e => { e.preventDefault(); close(); }}><div className="v1-source-dialog-body">
    <h2 id="processing-heading">{clearing ? '清除处理结果？' : resegment ? '重新分段' : reader ? '录音全文' : detail ? '录音任务详情' : settings ? '停顿分段设置' : '处理任务'}</h2><button className="v1-range-close" aria-label="关闭任务窗口" onClick={close}><X size={20}/></button>
    {clearing && detail ? <section className="v1-trash-confirm v1-clear-results"><p>{detail.name}</p><p>将清除这份录音的全部处理结果，包括转写结果与缓存、全部片段及已提取音频，以及收藏、边界调整和收听记录。</p><p>原始录音保留。</p><p>下次点击「扫描录音」时重新处理，不会立即开始。</p><p>此操作不可撤销。</p><footer><button disabled={busy} onClick={() => setClearing(false)}>取消</button><button disabled={busy || snapshot.active} onClick={() => void act(async () => { try { await invoke('clear_processing_results', { id: detail.id }); setClearing(false); setDetailId(null); } finally { await onRefresh(); } })}>{busy ? '正在清除…' : '清除处理结果'}</button></footer></section> : resegment && detail ? <ResegmentTask onBusy={setBusy} job={detail} onClose={() => setResegment(false)} onRefresh={onRefresh}/> : reader ? <div className="v1-transcription-content"><p>{reader.name} · 简体中文</p>{reader.rows.map((row, i) => <p key={i}><small>{Math.floor(row.start / 60)}:{String(Math.floor(row.start % 60)).padStart(2, '0')}</small> {row.text}</p>)}</div> : detail ? <div className="v1-task-detail"><h3>{detail.name} · {durationText(detail.duration)} · {statusText(detail)}{elapsedText(detail) && ` · ${elapsedText(detail)}`}</h3>{detail.sourcePath && <p className="v1-task-source">来源：{detail.sourcePath}</p>}{detail.status !== 'completed' && detail.seconds != null && <p>停顿 {detail.seconds} 秒</p>}<TaskStatusDetail key={detail.id} job={detail} busy={busy} onResegment={() => setResegment(true)} onRetry={() => void act(async () => { await invoke('retry_processing', { id:detail.id }); await onRefresh(); await invoke('run_processing'); })} onRead={() => void act(async () => setReader({ name: detail.name, rows: await invoke('read_transcription', { id: detail.id }) }))}>{detail.status === 'completed' ? <CompletedTaskDetail key={detail.id} job={detail} items={items} onOpenClip={id => { onOpenClip(id); onClose(); }} /> : undefined}</TaskStatusDetail></div> : settings ? <div className="v1-trash-confirm"><label>停顿达到以下时长时划分片段<input aria-label="停顿秒数" type="number" min="0" step="any" value={seconds} onChange={e => setSeconds(e.target.value)}/> 秒</label>
      <p>记住本次设置，用于之后开始处理的录音。</p><p>当前任务、失败重试沿用各自原参数。</p><p>已保存片段不会自动重新划分。</p>{!valid && <p role="alert">请输入大于 0 的停顿秒数。</p>}</div> : <>
      <div className="v1-task-groups">{!snapshot.jobs.length && <p>暂无处理任务，扫描录音后会自动加入。</p>}{groups.map((group, index) => <section key={group.id} aria-label={group.id === 'legacy' ? '历史任务' : '扫描批次'}>
        <p className="v1-task-batch">{group.id === 'legacy' ? '历史任务 · 批次未记录' : `${index === 0 ? '最近扫描' : '历史扫描'} · ${new Date(group.started! * 1000).toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })}`} · {group.jobs.length} 份录音</p>
        <ul className="v1-task-rows">{group.jobs.map(job => <li key={job.id} className={`v1-task-row is-${job.status}`}>
          <div className="v1-task-info"><strong title={job.name}>{statusText(job)} · {job.name}</strong><p>{durationText(job.duration)} · {job.status === 'completed' ? `已生成 ${job.clipCount ?? 0} 个片段` : job.status === 'failed' ? processingError(job.error, job.stage, job.status) : job.status === 'interrupted' ? '上次处理未完成' : job.status === 'waiting' ? '等待处理' : `停顿 ${job.seconds ?? snapshot.seconds} 秒`}{elapsedText(job) && ` · ${elapsedText(job)}`}</p>{job.status === 'running' && <TaskProgress job={job} />}</div>
          <div className="v1-task-actions"><button onClick={() => setDetailId(job.id)}>查看详情</button>{['failed','interrupted'].includes(job.status) && <button disabled={busy} className={job.status === 'failed' ? 'v1-task-retry' : ''} onClick={() => void act(async () => { await invoke('retry_processing', { id:job.id }); await invoke('run_processing'); })}>{job.status === 'failed' ? '重试' : '继续'}</button>}</div>
        </li>)}</ul>
      </section>)}</div>
      <p className="v1-task-note">重试加入队尾 · 可连续添加</p>
      {!snapshot.active && snapshot.jobs.some(j => j.status === 'waiting') && <button disabled={busy} onClick={() => void act(() => invoke('run_processing'))}>继续待处理任务</button>}
    </>}
    {error && <p role="alert">{error}</p>}
    {!resegment && !clearing && <footer>{detail && <button disabled={busy || snapshot.active || ['running','waiting'].includes(detail.status)} onClick={() => setClearing(true)}>清除处理结果</button>}{!settings && !reader && !detail && <button onClick={() => { setSeconds(String(snapshot.seconds)); setSettings(true); }}>停顿分段：{snapshot.seconds} 秒 · 设置</button>}<button onClick={close}>关闭</button>{settings && <button disabled={!valid || busy} onClick={() => void act(async () => { await invoke('set_processing_seconds', { seconds: Number(seconds) }); setSettings(false); })}>保存</button>}</footer>}
  </div></dialog>;
}

export function durationText(value?: number | null) { if (value == null || !Number.isFinite(value)) return '时长待读取'; const n=Math.floor(value); return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`; }
export function statusText(job: ProcessingJob) { return job.status === 'running' ? ((stageLabels[job.stage] ?? '处理中') + (job.stage === 'transcribing' && Number.isFinite(job.progress) ? ` ${Math.floor(job.progress!)}%` : '')) : ({waiting:'等待中',interrupted:'已中断',failed:job.stage === 'cleaning' ? '清理未完成' : job.stage === 'saving' ? '保存失败' : '处理失败',completed:'已完成'}[job.status] ?? job.status); }
export function groupJobs(jobs: ProcessingJob[]) {
  const groups = new Map<string,{id:string;started:number | null;jobs:ProcessingJob[]}>();
  for (const job of jobs) { const id=job.batchId ?? 'legacy'; if (!groups.has(id)) groups.set(id,{id,started:job.batchStarted ?? null,jobs:[]}); groups.get(id)!.jobs.push(job); }
  return [...groups.values()].sort((a,b)=>(b.started ?? -1)-(a.started ?? -1));
}

export function elapsedText(job?: ProcessingJob) {
 if (!job || job.status === 'waiting' || job.elapsedSeconds == null || !Number.isFinite(job.elapsedSeconds)) return '';
 return `${job.status === 'completed' ? '耗时' : '已耗时'} ${durationText(Math.max(0, job.elapsedSeconds))}`;
}
