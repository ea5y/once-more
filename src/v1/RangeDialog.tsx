import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, X } from 'lucide-react';
import AudioPlayback from './AudioPlayback';
import AudioWaveform from './AudioWaveform';
import { conversationTitle, sentencesInRange, formatRangeTime, parseRangeTime, rangeError, type Conversation, type LibraryAction } from './model';

export default function RangeDialog({ item, output = null, mode = 'range', onClose, onSave }: { output?: string | null; mode?: 'range' | 'extract'; item: Conversation; onClose: () => void; onSave: (start: number, end: number) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [startText, setStartText] = useState(formatRangeTime(item.start));
  const [endText, setEndText] = useState(formatRangeTime(item.start + item.duration));
  const [audition, setAudition] = useState({ position: 0, playing: false });
  const [audioError, setAudioError] = useState('');
  const start = parseRangeTime(startText);
  const end = parseRangeTime(endText);
  const error = rangeError(item, start, end);
  const duration = error ? 0 : Math.round((end - start) * 1000) / 1000;
  function editBoundary(value: string, boundary: 'start' | 'end') {
    setAudition({ position: 0, playing: false });
    setAudioError('');
    if (boundary === 'start') setStartText(value); else setEndText(value);
  }
  const updateAudio = useCallback((action: LibraryAction) => {
    if (action.type === 'pause') setAudition(current => ({ ...current, playing: false }));
    if (action.type === 'media-position' && action.id === item.id && Number.isFinite(action.position)) {
      setAudition(current => current.playing ? { position: Math.max(0, Math.min(duration, action.position)), playing: !action.ended && action.position < duration } : current);
    }
  }, [item.id, duration]);
  useEffect(() => {
    if (item.audioUrl || !audition.playing || error) return;
    let previous = performance.now();
    let active = true;
    const timer = window.setInterval(() => {
      if (!active) return;
      const now = performance.now();
      const elapsed = (now - previous) / 1000;
      previous = now;
      setAudition(current => {
        if (!current.playing) return current;
        const position = Math.min(duration, current.position + elapsed);
        return { position, playing: position < duration };
      });
    }, 100);
    return () => { active = false; window.clearInterval(timer); };
  }, [audition.playing, startText, endText, duration, error, item.audioUrl]);
  const preview = error ? [] : sentencesInRange(item, start, end);
  const previewTitle = error ? conversationTitle(item) : preview[0]?.text ?? "此范围暂无对话文字";
  const from = Math.max(0, Math.min(item.start, Number.isFinite(start) ? start : item.start) - 8);
  const to = Math.min(item.sourceDuration, Math.max(item.start + item.duration, Number.isFinite(end) ? end : item.start + item.duration) + 7);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className="v1-range-dialog" aria-labelledby="range-heading" aria-describedby="range-note" onCancel={event => { event.preventDefault(); onClose(); }}>
    {item.audioUrl && !error && <AudioPlayback key={`${startText}:${endText}`} item={{ ...item, start, duration }} playback={{ id: item.id, ...audition }} dispatch={updateAudio} onError={setAudioError} />}
    <form onSubmit={event => { event.preventDefault(); if (!error) onSave(start, end); }}>
      <h2 id="range-heading">{mode === "extract" ? "提取片段" : "调整片段范围"}</h2><button className="v1-range-close" type="button" aria-label="关闭范围调整" onClick={onClose}><X size={20} /></button>
      <p className="v1-range-title">{previewTitle}</p>
      <div className="v1-range-wave"><AudioWaveform path={item.sourcePath} start={from} end={to} large progress={!error && audition.position > 0 ? (start + audition.position - from) / (to - from) : 0} />{!error && <div className="v1-range-selection" style={{ left: `${(start - from) / (to - from) * 100}%`, width: `${(end - start) / (to - from) * 100}%` }} />}{!error && audition.position > 0 && <i className="v1-audition-cursor" style={{ left: `${(start + audition.position - from) / (to - from) * 100}%` }} />}</div>
      <div className="v1-range-scale"><span>{formatRangeTime(from)}</span><span>{formatRangeTime(to)}</span></div>
      <div className="v1-range-inputs"><label>起点<input autoFocus value={startText} onChange={event => editBoundary(event.target.value, 'start')} aria-describedby="range-validation" aria-invalid={!!error} spellCheck={false} /></label><label>终点<input value={endText} onChange={event => editBoundary(event.target.value, 'end')} aria-describedby="range-validation" aria-invalid={!!error} spellCheck={false} /></label></div>
      <div className="v1-range-audition"><button type="button" disabled={!!error} title={item.audioUrl ? "真实试听本地录音" : "模拟试听，无真实声音"} onClick={() => setAudition(current => ({ position: current.position >= duration ? 0 : current.position, playing: !current.playing }))}>{audition.playing ? <Pause size={14} /> : <Play size={14} />}{audition.playing ? '暂停试听' : '试听选中范围'}</button><span aria-label={item.audioUrl ? "真实试听进度" : "模拟试听进度"}>试听 {formatRangeTime(audition.position)} / {error ? '—' : formatRangeTime(duration)}</span></div>
      <p id="range-validation" className="v1-range-validation" aria-live="polite">{error || audioError || `原录音时长 ${formatRangeTime(item.sourceDuration)}`}</p>
      <section id="range-note" className="v1-range-note" aria-label="范围正文预览"><p>新标题：{previewTitle}</p><div className="v1-range-transcript" tabIndex={0} aria-label="调整后的正文">{error ? <p>时间有效后显示正文预览。</p> : preview.length ? preview.map((sentence, index) => <p key={index}>{sentence.text}</p>) : <p>当前范围内没有转写文字。</p>}</div><small>{mode === "extract" ? item.sourcePath ? `输出位置：${output ?? "未配置，请先配置输出文件夹"} · WAV真实提取` : "模拟提取，不生成文件" : item.audioUrl ? item.pauseSeconds ? "真实试听本地录音 · 本地转写文字与句子时间" : "真实试听本地录音 · 文字、句子时间仍为模拟" : "模拟时间 · 重叠部分暂保留整句 · 模拟试听无声音"}</small></section>
      <footer><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={!!error}>{mode === "extract" ? "确认提取" : "保存范围"}</button></footer>
    </form>
  </dialog>;
}
