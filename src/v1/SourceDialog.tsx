import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X } from 'lucide-react';
import { conversationTitle, extractionLabel, hasLatestExtraction, sourceSummary, type Conversation } from './model';

export interface TrashOutcome { restored: boolean; moved: boolean; pending: boolean; uncertain: boolean; error: string | null }

export default function SourceDialog({ sourceId, items, onClose, onTrash, onRealTrash }: { sourceId: string; items: readonly Conversation[]; onClose: () => void; onTrash: () => void; onRealTrash: (id: string) => Promise<TrashOutcome> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState('');
  const [outcome, setOutcome] = useState<TrashOutcome | null>(null);
  const summary = sourceSummary(items, sourceId);
  const removed = summary.related.length > 0 && summary.related.every(item => !item.sourceAvailable);
  const realSource = summary.related.some(item => item.sourcePath);

  const [check, setCheck] = useState<{ ready: boolean; checked: number; total: number; errors: string[] } | null>(null);
  const [checking, setChecking] = useState(true);
  const [revision, setRevision] = useState(0);
  const checkKey = JSON.stringify(summary.related.map(item => [item.id, item.start, item.duration, item.extraction, item.clipPath, item.sourceAvailable]));
  useEffect(() => {
    if (!realSource || removed) { setChecking(false); return; }
    let active = true;
    setChecking(true); setCheck(null);
    void invoke<{ ready: boolean; checked: number; total: number; errors: string[] }>('check_source_clips', { sourceId }).then(
      result => { if (active) { setCheck(result); setChecking(false); } },
      error => { if (active) { setCheck({ ready: false, checked: 0, total: 0, errors: [`检查失败：${String(error)}`] }); setChecking(false); } },
    );
    return () => { active = false; };
  }, [sourceId, realSource, removed, checkKey, revision]);
  const uncertain = outcome?.uncertain || summary.related.some(item => item.sourceTrashUncertain);
  const trashed = outcome?.moved || summary.related.some(item => item.sourceTrashed);
  const pending = outcome?.pending || summary.related.some(item => item.sourceTrashPending);
  const canTrash = !moving && !checking && !removed && summary.allComplete && (!realSource || !!check?.ready);
  async function move() {
    if (moving) return;
    setMoving(true); setMoveError('');
    try { const result = await onRealTrash(sourceId); setOutcome(result.restored ? null : result); setConfirming(false); if (result.restored) setRevision(value => value + 1); }
    catch (error) { setMoveError(String(error)); }
    finally { setMoving(false); }
  }
  function cancel() { if (moving) return; if (confirming) setConfirming(false); else onClose(); }
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className={`v1-range-dialog v1-source-dialog ${confirming && !removed && !moving && !moveError ? "v1-source-confirming" : ""} ${moving || moveError || removed ? "v1-source-operation" : ""}`} aria-labelledby="source-heading" onCancel={event => { event.preventDefault(); cancel(); }}>
    <div className="v1-source-dialog-body">
      <h2 id="source-heading">{removed ? realSource ? uncertain ? "原录音状态待确认" : trashed ? "原录音已移到废纸篓" : "原录音不可用" : "已移到废纸篓（模拟）" : moveError ? "未能移到废纸篓" : moving ? "正在移到废纸篓…" : confirming ? "将原录音移到废纸篓？" : "来源录音"}</h2><button className="v1-range-close" aria-label="关闭来源录音" disabled={moving} onClick={cancel}><X size={20} /></button>
      <p className="v1-source-filename">{summary.related[0]?.sourceName ?? '录音不存在'}</p>
      {moving ? <section className="v1-trash-confirm" role="status"><p>正在处理，请稍候…</p><p>{pending ? '正在重试保存记录。' : '正在再次检查片段文件并移动原录音。'}</p></section> : realSource && removed ? <section className="v1-trash-confirm" role="status">
        <p>{uncertain ? '上次操作被中断，原录音已不在原位置。' : pending ? '片段仍保留，记录暂未保存成功。' : `${summary.related.length} 段音频与转写仍保留在记忆库中。`}</p>
        <p>{uncertain ? '请先在系统废纸篓确认并恢复原文件，再重新检查。' : pending ? '请重试保存，无需再次移动原录音。' : '以后可以照常回听、搜索和收藏。'}</p>
        <p>原录音不存在时，起点和终点不可调整。</p>
        {outcome?.error && <p role="alert">{outcome.error}</p>}
      </section> : moveError ? <section className="v1-trash-confirm"><p>操作未完成，片段不受影响。</p><p role="alert">{moveError}</p></section> : confirming && !removed ? <section className="v1-trash-confirm" aria-label="删除原录音确认">
        <p className="v1-trash-ready">全部 {summary.related.length} 段对话已按最新边界{realSource ? "" : "模拟"}提取完成。</p>
        <p className="v1-trash-keeps-label">移走后仍可</p>
        <p className="v1-trash-keeps">回听片段、搜索转写、点击句子播放、收藏。</p>
        <div className="v1-trash-warning"><p>原录音离开后，不能继续调整片段起点和终点。</p><p>未进入片段的声音不会保存在提取文件中。</p></div>
        <p className="v1-trash-simulation">{realSource ? "文件将移到系统废纸篓，由你决定何时清空。" : "当前为模拟操作，不会移动或删除真实文件。"}</p>
        {!canTrash && <p role="alert">当前条件已变化，暂不能移走原录音。</p>}
      </section> : <>
      <p role="status">{realSource ? checking ? "检查中 · 正在检查提取文件…" : check?.ready ? `检查通过 · ${check.checked} / ${check.total} 段文件完整` : "检查未通过 · 暂不可删除原录音" : null}</p>
      <p>{summary.completed} / {summary.related.length} 段已按最新范围提取{realSource ? "" : "（模拟）"}</p>
      <ul className="v1-source-segments" aria-label="同一录音的全部片段" tabIndex={0}>{summary.related.map(item => <li key={item.id} data-pending={!hasLatestExtraction(item)}><span title={conversationTitle(item)}>{conversationTitle(item)}<small>{item.saved ? '已收藏' : '未收藏'}</small></span><span>{extractionLabel(item)}</span></li>)}</ul>
      <p className="v1-source-summary">{realSource ? checking ? "正在逐段检查文件，请稍候。" : check?.ready ? "全部片段文件已检查。" : "请处理下列问题后重新检查。" : summary.allComplete ? '全部片段均已按最新范围模拟提取完成。' : summary.related.length ? `还有 ${summary.pending.length} 段未按最新范围提取，请逐段完成（列表中已标出）。` : '没有关联片段，暂不能确认提取完成。'}</p>
      {realSource && !checking && check && check.errors.length > 0 && <ul className="v1-source-check-errors" aria-label="文件检查问题">{check.errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}
      <small>{removed ? "已提取片段保留；原录音已标记为不存在，无法再调整范围。未操作真实文件。" : realSource ? "文件将移到系统废纸篓，由你决定何时清空。" : "仅模拟状态汇总，未检查真实音频文件。"}</small></>}
      {moveError && removed && <p role="alert" className="v1-source-check-errors">{moveError}</p>}
      <footer>
        <button disabled={moving} onClick={cancel}>{pending ? "稍后处理" : confirming && !removed && !moveError ? "保留原录音" : removed ? "完成" : "关闭"}</button>
        {moving ? <button disabled>处理中…</button> : realSource && pending ? <button onClick={() => void move()}>{uncertain ? "重新检查" : "重试保存"}</button> : <>
          {realSource && !removed && !confirming && <button disabled={checking} onClick={() => { setMoveError(''); setRevision(value => value + 1); }}>{checking ? "检查中…" : "重新检查"}</button>}
          {!removed && <button disabled={!canTrash} onClick={() => { if (confirming) { if (realSource) void move(); else { onTrash(); setConfirming(false); } } else setConfirming(true); }}>{moveError ? "重试" : "移到废纸篓"}</button>}
        </>}
      </footer>
    </div>
  </dialog>;
}
