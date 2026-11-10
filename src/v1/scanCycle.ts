import { statusText } from './ProcessingHistory';
import type { ProcessingSnapshot } from './ProcessingHistory';
export function cycleView(snapshot: ProcessingSnapshot, scanning = false) {
  const jobs = snapshot.jobs.filter(j => snapshot.cycleIds?.includes(j.id));
  const pending = snapshot.jobs.filter(j => ['waiting', 'running', 'interrupted'].includes(j.status));
  const done = jobs.filter(j => j.status === 'completed').length;
  const failed = jobs.filter(j => j.status === 'failed').length;
  const waiting = pending.filter(j => j.status === 'waiting').length;
  const running = snapshot.jobs.find(j => j.status === 'running');
  if (scanning) return { label: '正在扫描…', summary: '正在查找录音', disabled: true, resume: false };
  if (snapshot.active || pending.some(j => j.status === 'running')) return {
    label: `${running ? statusText(running) : '正在处理'} · ${Math.min(done + failed + 1, Math.max(jobs.length, pending.length))}/${Math.max(jobs.length, pending.length)}`,
    summary: `已完成 ${done} 份 · 等待 ${waiting} 份`, disabled: true, resume: false,
  };
  if (pending.length) return { label: '继续处理', summary: `上次处理未完成 · 剩余 ${pending.length} 份`, disabled: false, resume: true };
  return { label: '扫描录音', summary: jobs.length ? `本次完成 ${done} 份${failed ? ` · 失败 ${failed} 份` : ''}` : '', disabled: false, resume: false };
}
