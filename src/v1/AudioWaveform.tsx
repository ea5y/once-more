import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import Waveform from '../components/Waveform';
import { desktop } from '../lib/api';
import { peaksInRange, type AudioPeaks } from './waveform';

// Share concurrent requests; persistent cache and file fingerprints live in SQLite.
const pending = new Map<string, Promise<AudioPeaks>>();
function request(path: string) {
  let task = pending.get(path);
  if (!task) {
    task = invoke<AudioPeaks>('get_v1_waveform', { path });
    pending.set(path, task);
    void task.finally(() => pending.delete(path)).catch(() => {});
  }
  return task;
}
export default function AudioWaveform({ path, start, end, progress = 0, large = false, onSeek }: { path?: string; start: number; end: number; progress?: number; large?: boolean; onSeek?: (ratio: number) => void }) {
  const [result, setResult] = useState<{ path: string; data?: AudioPeaks; error?: string }>();
  useEffect(() => {
    if (!path || !desktop) return;
    let active = true;
    void request(path).then(data => { if (active) setResult({ path, data }); }, error => { if (active) setResult({ path, error: String(error) }); });
    return () => { active = false; };
  }, [path]);
  const current = result?.path === path ? result : undefined;
  const peaks = useMemo(() => current?.data ? peaksInRange(current.data, start, end, large ? 48 : 32) : undefined, [current?.data, start, end, large]);
  const note = !path ? '' : !desktop ? '真实波形请在桌面查看' : current?.error ? '波形读取失败' : !peaks ? '正在读取波形…' : '';
  return <div className="v1-audio-wave" title={current?.error ?? (peaks ? '真实音频波形' : note)}>
    <div role={onSeek ? 'slider' : undefined} tabIndex={onSeek ? 0 : undefined} aria-label={onSeek ? '点击波形定位播放' : undefined} aria-valuemin={onSeek ? 0 : undefined} aria-valuemax={onSeek ? 100 : undefined} aria-valuenow={onSeek ? Math.round(progress * 100) : undefined} style={onSeek ? { cursor: 'pointer' } : undefined} onClick={onSeek ? event => { const rect = event.currentTarget.getBoundingClientRect(); if (rect.width > 0) onSeek(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))); } : undefined} onKeyDown={onSeek ? event => { const ratio = event.key === 'ArrowRight' ? progress + 0.05 : event.key === 'ArrowLeft' ? progress - 0.05 : event.key === 'Home' ? 0 : event.key === 'End' ? 1 : null; if (ratio !== null) { event.preventDefault(); onSeek(Math.max(0, Math.min(1, ratio))); } } : undefined}>
      <Waveform peaks={peaks} demo={!path} large={large} progress={progress} />
    </div>
    {note && <small role="status">{note}</small>}
  </div>;
}
