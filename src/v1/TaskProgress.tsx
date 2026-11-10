import type { ProcessingJob } from './ProcessingHistory';
export default function TaskProgress({ job }: { job?: ProcessingJob }) {
  const percent = job?.stage === 'transcribing' && Number.isFinite(job.progress) ? Math.max(0, Math.min(100, job.progress!)) : null;
  return percent === null ? <div className="indeterminate" aria-label="正在处理"><span /></div> : <progress className="v1-task-progress" aria-label="转写进度" max={100} value={percent} />;
}
