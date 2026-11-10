import { forwardRef, useImperativeHandle, useCallback, useEffect, useState } from 'react';
import { Folder, Mic } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { api, desktop } from '../lib/api';
interface FolderStatus { path: string | null; error: string | null }
interface Config { source: FolderStatus; output: FolderStatus }
export interface FolderActions { chooseSource: () => void }
export default forwardRef<FolderActions, { scanning?: boolean; onSource: (path: string | null) => void; onOutput: (path: string | null) => void }>(function FolderSettings({ onOutput, onSource }, ref) {
  const [config, setConfig] = useState<Config>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const next = await invoke<Config>('get_v1_folders');
    setConfig(next);
    onOutput(next.output.path);
    onSource(next.source.path);
  }, [onOutput, onSource]);
  useEffect(() => {
    if (desktop) void refresh().catch(reason => setError(`读取配置失败：${String(reason)}`));
  }, [refresh]);
  async function choose(kind: 'source' | 'output') {
    if (busy || !desktop) return;
    setBusy(true); setError('');
    try { await api.folder(kind); await refresh(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  useImperativeHandle(ref, () => ({ chooseSource: () => { void choose('source'); } }));
  return <section className="config" aria-label="文件夹配置">
    <div className="section-heading">CONFIG</div>
    {(['source', 'output'] as const).map(kind => {
      const value = config?.[kind];
      const label = kind === 'source' ? '录音来源' : '输出位置';
      return <div key={kind}>
        <button className="folder-setting" disabled={!desktop || busy} onClick={() => void choose(kind)} title={!desktop ? '请在桌面应用中配置文件夹' : `更换${label}`}>
          {kind === 'source' ? <Mic size={23} /> : <Folder size={23} />}<span>{label}<small title={value?.path ?? undefined}>{value?.path ?? (config ? '未选择' : desktop ? '正在读取…' : '请在桌面应用中配置')}</small></span>
        </button>
        {value?.error && <p className="v1-folder-error" role="alert">{label}：{value.error}</p>}
      </div>;
    })}
    <p className="v1-settings-hint">修改将在下次任务中生效。</p>
    {error && <p className="v1-folder-error" role="alert">{error}<button onClick={() => { setError(''); void refresh().catch(reason => setError(String(reason))); }}>重新读取</button></p>}
  </section>;
});
