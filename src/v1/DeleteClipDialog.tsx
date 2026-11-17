import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { conversationTitle, type Conversation } from './model';
import { openSidebarDialog } from './openSidebarDialog';
export default function DeleteClipDialog({ item, onDelete, onClose }: { item: Conversation; onDelete: () => Promise<void>; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  useEffect(() => { const dialog = ref.current!; openSidebarDialog(dialog); return () => dialog.close(); }, []);
  const extracted = !!item.clipPath || !!item.extractedRange || item.extraction === 'done';
  async function confirm() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await onDelete(); onClose(); }
    catch { setError('删除未完成，片段记录已保留。请检查提取文件是否可访问后重试。'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <dialog ref={ref} className="v1-range-dialog v1-delete-dialog" aria-labelledby="delete-clip-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <div className="v1-source-dialog-body">
      <h2 id="delete-clip-title">删除这个片段？</h2>
      <button className="v1-range-close" disabled={busy} onClick={onClose} aria-label="关闭删除确认"><X size={20} /></button>
      <p>片段：{conversationTitle(item)}</p>
      <p>{extracted ? '该片段已提取音频。' : '该片段尚未提取音频。'}</p>
      <p>确认删除后，该片段及收藏、回听记录将被清除。</p>
      <div className="v1-delete-warning"><p>{extracted ? '同时删除该片段已提取的音频文件。' : '只删除此片段，其他片段不受影响。'}</p><p>原始录音保留。</p></div>
      {error && <p role="alert">{error}</p>}
      <footer><button disabled={busy} onClick={onClose}>取消</button><button disabled={busy} onClick={() => void confirm()}>{busy ? '正在删除…' : '确认删除'}</button></footer>
    </div>
  </dialog>;
}
