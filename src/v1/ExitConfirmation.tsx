import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { desktop } from '../lib/api';
import { openSidebarDialog } from './openSidebarDialog';
export default function ExitConfirmation() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const unlisten = listen('confirm-processing-exit', () => {
      if (active && dialog.current && !dialog.current.open) { setError(''); openSidebarDialog(dialog.current); }
    });
    return () => { active = false; void unlisten.then(stop => stop()); };
  }, []);
  async function resolve(confirm: boolean) {
    if (busy) return;
    setBusy(true);
    try { await invoke('resolve_processing_exit', { confirm }); if (!confirm) dialog.current?.close(); }
    catch { setError('操作未完成，请重试。'); }
    finally { setBusy(false); }
  }
  return <div className="v1-app" style={{ display: 'contents' }}><dialog ref={dialog} className="v1-range-dialog v1-exit-dialog" aria-labelledby="exit-title" onCancel={e => { e.preventDefault(); void resolve(false); }}><h2 id="exit-title">退出应用？</h2><p>本轮处理尚未完成，退出后可在下次打开时继续。</p>{error && <p role="alert">{error}</p>}<footer><button disabled={busy} onClick={() => void resolve(false)}>取消</button><button disabled={busy} onClick={() => void resolve(true)}>退出</button></footer></dialog></div>;
}
