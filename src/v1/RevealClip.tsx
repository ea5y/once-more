import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { desktop } from '../lib/api';

export default function RevealClip({ path }: { path: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function reveal() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await invoke('reveal_v1_clip', { path });
    } catch (reason) {
      setError(`${String(reason)}。文件可能已移动、删除或无法访问；片段记录仍保留，恢复文件后可重试。`);
    } finally {
      setBusy(false);
    }
  }
  return <div className="v1-reveal-clip">
    <button className="secondary" disabled={!desktop || busy} onClick={() => void reveal()} title={desktop ? '在 Finder 中选中提取文件' : '请在 macOS 桌面应用中查看文件'}>{busy ? '正在定位…' : '查看文件'}</button>
    {error && <p className="v1-source-missing" role="alert">{error}</p>}
  </div>;
}
