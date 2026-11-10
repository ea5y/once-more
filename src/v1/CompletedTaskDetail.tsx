import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { conversationTitle, type Conversation, type TimedSentence } from './model';
import type { ProcessingJob } from './ProcessingHistory';

export default function CompletedTaskDetail({ job, items, onOpenClip }: { job: ProcessingJob; items: readonly Conversation[]; onOpenClip: (id: string) => void }) {
  const [rows, setRows] = useState<TimedSentence[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setRows(null); setError(false);
    void invoke<TimedSentence[]>('read_transcription', { id: job.id }).then(value => {
      if (active) setRows(value);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [job.id, attempt]);
  const clips = items.filter(item => item.sourceId === job.id).sort((a, b) => a.start - b.start);
  return <>
    <h3>转写全文</h3>
    {error ? <div role="alert"><p>全文读取失败，请重试。</p><button onClick={() => setAttempt(value => value + 1)}>重新读取</button></div> : rows === null ? <p role="status">正在读取全文…</p> : rows.length === 0 ? <p>暂无转写文字</p> : <div className="v1-task-transcript">{rows.map((row, index) => <div key={index}><time>{taskTime(row.start)}–{taskTime(row.end)}</time><span>{row.text}</span></div>)}</div>}
    <h3>分段结果 · {job.seconds == null ? '停顿参数未记录' : `停顿 ${job.seconds} 秒`} · 共 {clips.length} 段</h3>
    {clips.length === 0 ? <p>当前没有已保存的片段。</p> : <ul className="v1-task-clips">{clips.map(item => <li key={item.id}><p>{conversationTitle(item)}</p><button onClick={() => onOpenClip(item.id)}>{taskTime(item.start)}–{taskTime(item.start + item.duration)} · 查看片段 →</button></li>)}</ul>}
  </>;
}

function taskTime(value: number) { const n = Math.round(value * 100) / 100; return `${String(Math.floor(n / 60)).padStart(2, '0')}:${(n % 60).toFixed(2).padStart(5, '0').replace(/\.00$/, '')}`; }
