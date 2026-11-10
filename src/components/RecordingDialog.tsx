import { useEffect, useRef, useState } from 'react';
import { AudioLines, Scissors } from 'lucide-react';
import { api } from '../lib/api';
import { formatDuration, validRange } from '../lib/memory';
import type { Memory, Recording } from '../types';

interface Props { recordings: Recording[]; initialId?: string; onSave: (memory: Memory) => Promise<void> }

export default function RecordingDialog({ recordings, initialId, onSave }: Props) {
  const [id, setId] = useState(initialId ?? recordings[0]?.id);
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const recording = recordings.find(r => r.id === id);

  useEffect(() => { setDuration(0); setStart(0); setEnd(0); setTitle(recording?.name.replace(/\.[^.]+$/, '') ?? ''); setError(''); }, [recording]);

  async function save() {
    if (!recording || !validRange(start, end, duration) || !title.trim()) return;
    setSaving(true);
    const date = new Date(recording.modified * 1000);
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    try {
      await onSave({ id: crypto.randomUUID(), recordingId: recording.id, title: title.trim(), date: dateKey, time: date.toTimeString().slice(0, 5), start, end, kind: 'Recording', saved: true, recommended: false, listens: 0, transcript: [] });
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  }

  return <div className="recording-dialog">
    <p className="dialog-description">选取一段对话，创建记忆。自动转写与对话分段将在后续版本接入。</p>
    {!recordings.length ? <p>还没有找到录音，请先扫描录音来源。</p> : <>
      <div className="recordings-list">{recordings.map(r => <button key={r.id} className={`recording-choice ${id === r.id ? 'active' : ''}`} onClick={() => setId(r.id)}>
        <AudioLines size={17} /><span><strong>{r.name}</strong><small>{(r.size / 1024 / 1024).toFixed(1)} MB · {new Date(r.modified * 1000).toLocaleDateString('zh-CN')}</small></span>
      </button>)}</div>
      {recording && <div className="recording-editor">
        <audio key={recording.id} ref={audio} controls preload="metadata" src={api.audio(recording.path)} onLoadedMetadata={e => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) { setDuration(d); setEnd(Math.min(d, 30)); }
          else setError('无法读取这份音频的时长。');
        }} onError={() => setError('无法播放此录音。请确认文件仍在原位置，且系统支持该音频格式。')} />
        <label>记忆标题<input value={title} maxLength={300} onChange={e => setTitle(e.target.value)} /></label>
        <div className="range-fields">
          <label>开始（秒）<input type="number" min={0} max={duration} step="0.1" value={start} onChange={e => setStart(Number(e.target.value))} /><button className="text-button" onClick={() => setStart(Math.floor((audio.current?.currentTime ?? 0) * 10) / 10)}>使用当前播放位置</button></label>
          <label>结束（秒）<input type="number" min={0} max={duration} step="0.1" value={end} onChange={e => setEnd(Number(e.target.value))} /><button className="text-button" onClick={() => setEnd(Math.floor((audio.current?.currentTime ?? 0) * 10) / 10)}>使用当前播放位置</button></label>
        </div>
        <small>原录音 {formatDuration(duration)} · 片段 {formatDuration(Math.max(0, end - start))} · 日期暂采用文件修改时间</small>
        {!!duration && !validRange(start, end, duration) && <p className="error">结束时间必须晚于开始时间，且不能超过原录音。</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary wide" disabled={saving || !validRange(start, end, duration) || !title.trim()} onClick={save}><Scissors size={16} />{saving ? '正在保存…' : '创建并收藏'}</button>
      </div>}
    </>}
  </div>;
}
