import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { highlightedParts } from './model';

/** Local search owns no library or playback state. Remount for a different conversation. */
export default function Transcript({ lines, globalQuery, currentSentence, onSentence, realAudio = false, actualTranscript = false }: { actualTranscript?: boolean; realAudio?: boolean; lines: readonly string[]; globalQuery: string; currentSentence: number; onSentence: (index: number) => void }) {
  const [following, setFollowing] = useState(true);
  const animation = useRef<number | null>(null);
  function stopAnimation() {
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
  }
  function pauseFollowing() { stopAnimation(); setFollowing(false); }
  function scrollToElement(element: Element, smooth = false) {
    const area = body.current;
    if (!area) return;
    stopAnimation();
    const target = Math.max(0, Math.min(area.scrollHeight - area.clientHeight,
      area.scrollTop + element.getBoundingClientRect().top - area.getBoundingClientRect().top - 2));
    if (!smooth || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      area.scrollTop = target;
      return;
    }
    const start = area.scrollTop;
    const began = performance.now();
    function tick(now: number) {
      const progress = Math.min(1, (now - began) / 240);
      area!.scrollTop = start + (target - start) * (1 - Math.pow(1 - progress, 3));
      animation.current = progress < 1 ? requestAnimationFrame(tick) : null;
    }
    animation.current = requestAnimationFrame(tick);
  }
  function followSentence(index: number) {
    // Anchor two complete sentences above the current one, including wrapped lines.
    const anchor = body.current?.querySelector(`[data-sentence="${Math.max(0, index - 2)}"]`);
    if (anchor) scrollToElement(anchor, true);
  }
  function followCurrent() { followSentence(currentSentence); }
  useEffect(() => stopAnimation, []);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const composing = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const term = open ? query : globalQuery;
  let count = 0;
  const paragraphs = lines.map(text => highlightedParts(text, term).map(part => ({ ...part, index: part.match ? count++ : -1 })));
  const active = count ? Math.min(current, count - 1) : -1;
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => {
    const area = body.current;
    if (!area) return;
    const match = area.querySelectorAll('mark')[open ? Math.max(0, active) : 0];
    if (match) { scrollToElement(match); setFollowing(false); }
    else if (following && currentSentence >= 0) followCurrent();
    else if (currentSentence < 0) { stopAnimation(); area.scrollTop = 0; }
  }, [term, active, open]);
  useEffect(() => {
    if (following && currentSentence >= 0) followCurrent();
    // Scroll only when the current sentence or follow preference changes.
  }, [currentSentence, following]);
  function update(value: string) { setQuery(value); setCurrent(0); }
  function move(step: number) { if (count) setCurrent((active + step + count) % count); }
  function close() { setOpen(false); setDraft(''); update(''); trigger.current?.focus(); }
  return <section className="transcript v1-transcript" aria-label="对话原文">
    <header><h2>原文</h2>{!following && currentSentence >= 0 && <button onClick={() => { setFollowing(true); followCurrent(); }}>回到当前句</button>}<button ref={trigger} aria-expanded={open} onClick={() => open ? close() : setOpen(true)}>片段内搜索</button></header>
    {open && <div className="v1-local-search">
      <div className="search"><input ref={input} aria-label="搜索当前片段" placeholder="搜索当前片段…" value={draft}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; update(event.currentTarget.value); }}
        onChange={event => { setDraft(event.target.value); if (!composing.current) update(event.target.value); }}
        onKeyDown={event => { if (composing.current || event.nativeEvent.isComposing) return; if (event.key === 'Escape') close(); if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1); } }} />
        {draft && <button aria-label="清除片段内搜索" onClick={() => { setDraft(''); update(''); input.current?.focus(); }}><X size={13} /></button>}
      </div>
      <div className="v1-match-controls"><span role="status">{query.trim() ? count ? `${active + 1} / ${count}` : '无匹配' : '输入关键词'}</span><button aria-label="上一处匹配" disabled={!count} onClick={() => move(-1)}><ChevronUp size={16} /></button><button aria-label="下一处匹配" disabled={!count} onClick={() => move(1)}><ChevronDown size={16} /></button><button aria-label="关闭片段内搜索" onClick={close}><X size={15} /></button></div>
    </div>}
    <div className="v1-transcript-body" ref={body} tabIndex={0} aria-label="可滚动的对话文字" onWheel={pauseFollowing} onTouchMove={pauseFollowing} onPointerDown={pauseFollowing} onKeyDown={event => { if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) pauseFollowing(); }}>{paragraphs.map((parts, line) => <p key={line}><button className="v1-sentence" data-history={currentSentence > line ? currentSentence - line === 1 ? "previous" : "earlier" : undefined} data-sentence={line} aria-current={line === currentSentence ? "true" : undefined} aria-label={`从第${line + 1}句${realAudio ? actualTranscript ? "播放" : "播放（模拟时间）" : "模拟播放"}：${lines[line]}`} onClick={() => { onSentence(line); setFollowing(true); followSentence(line); }}>{parts.map((part, index) => part.match ? <mark key={index} className={open && part.index === active ? 'current-match' : undefined} aria-current={open && part.index === active ? 'true' : undefined}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</button></p>)}</div>
  </section>;
}
