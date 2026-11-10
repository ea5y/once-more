import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X } from 'lucide-react';
interface ScanRecord { id: string; source: string | null; started: number; status: 'running' | 'succeeded' | 'failed'; count: number | null; error: string | null }
export default function ScanHistoryDialog({ busy, revision, onRetry, onClose }: { busy: boolean; revision: number; onRetry: (id: string) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [records, setRecords] = useState<ScanRecord[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close(); }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void invoke<ScanRecord[]>('get_scan_history').then(value => { if (active) setRecords(value); }, reason => { if (active) setError(String(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision, reload]);
  return <dialog ref={dialog} className="v1-range-dialog v1-history-dialog" aria-labelledby="history-heading" onCancel={e => { e.preventDefault(); onClose(); }}>
    <div className="v1-source-dialog-body">
      <h2 id="history-heading">历史任务</h2><button className="v1-range-close" aria-label="关闭历史任务" onClick={onClose}><X size={20} /></button>
      <p>最近 50 次扫描 · 记录保存在本机</p>
      {busy && <p role="status">正在扫描录音，完成后更新记录。</p>}
      {error ? <p role="alert">读取失败：{error}<button onClick={() => setReload(value => value + 1)}>重新读取</button></p> : loading ? <p role="status">正在读取…</p> : !records.length ? <p>还没有扫描记录。首次扫描后显示。</p> : null}
      <ul className="v1-history-list" aria-label="扫描历史" tabIndex={0}>{records.map(record => <li key={record.id}>
        <time>{new Date(record.started * 1000).toLocaleString('zh-CN')}</time>
        <p className="v1-history-path" title={record.source ?? ''}>{record.source ?? '未配置录音来源'}</p>
        <p>{record.status === 'succeeded' ? `扫描完成 · 找到 ${record.count} 份录音` : record.status === 'running' ? '正在扫描' : `扫描失败 · ${record.error}`}</p>
        {record.status === 'failed' && record.source && <button disabled={busy || loading} onClick={() => onRetry(record.id)} title="重新扫描这条记录的来源目录">重新扫描</button>}
        {record.status === 'failed' && !record.source && <small>请先在侧栏选择录音来源，再扫描。</small>}
      </li>)}</ul>
      <footer><button onClick={onClose}>关闭</button></footer>
    </div>
  </dialog>;
}
