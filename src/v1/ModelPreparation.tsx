import { forwardRef, useImperativeHandle, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X } from 'lucide-react';
import { modelError } from './errorMessages';
import { desktop } from '../lib/api';
import { openSidebarDialog } from './openSidebarDialog';
export interface ModelStatus { phase: 'missing' | 'downloading' | 'checking' | 'failed' | 'ready'; downloaded: number; total: number; error: string | null }
interface ModelInfo { directory: string; fileName: string; size: number }
export function ModelDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [infoError, setInfoError] = useState('');
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    let active = true;
    void invoke<ModelInfo>('get_model_info').then(value => { if (active) setInfo(value); })
      .catch(() => { if (active) setInfoError('无法读取模型位置，请关闭后重试。'); });
    return () => { active = false; };
  }, []);
  async function openDirectory() {
    setOpening(true); setInfoError('');
    try { await invoke('open_model_directory'); }
    catch { setInfoError('无法打开模型文件夹，请重试。'); }
    finally { setOpening(false); }
  }
  const [revision, setRevision] = useState(0);
  useEffect(() => { const node = dialog.current!; openSidebarDialog(node); return () => node.close(); }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await invoke<ModelStatus>('get_model_status');
        if (active) { setStatus(next); setError(''); }
      } catch (reason) { console.error('Model status read failed', reason); if (active) setError('无法读取模型状态，请重新读取。'); }
      if (active) timer = setTimeout(() => void refresh(), 1000);
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [revision]);
  async function download() {
    setSending(true); setError('');
    try { await invoke('download_model'); setRevision(value => value + 1); }
    catch (reason) { console.error('Model download start failed', reason); setError('无法开始下载，请重新读取状态后重试。'); }
    finally { setSending(false); }
  }
  const failure = modelError(status?.error ?? null);
  const busy = sending || status?.phase === 'checking' || status?.phase === 'downloading';
  const progress = status && status.total > 0 ? Math.min(100, Math.floor(status.downloaded / status.total * 100)) : 0;
  const heading = !status ? '正在读取模型状态…' : {
    missing: '未下载', downloading: `下载中 · ${progress}%`, checking: '校验中', failed: failure.action === '重新下载' ? '需重新下载' : '下载失败', ready: '已就绪',
  }[status.phase];
  return <dialog ref={dialog} className="v1-range-dialog v1-model-dialog" aria-labelledby="model-heading" onCancel={e => { e.preventDefault(); onClose(); }}>
    <div className="v1-source-dialog-body">
      <header className="v1-model-header">
      <h2 id="model-heading">转写模型</h2>
      <button className="v1-range-close" aria-label="关闭转写模型" onClick={onClose}><X size={20} /></button>
      </header>
      <div className="v1-model-scroll" role="region" aria-label="模型信息" tabIndex={0}>
      <div className="v1-model-identity">
        <h3>Whisper Large V3 Turbo</h3>
        <span role="status" className={status?.phase === 'ready' ? 'v1-model-ready' : ''}>{status?.phase === 'ready' ? '● ' : ''}{heading}</span>
      </div>
      <p className="v1-model-purpose">将录音转换为带时间信息的对话文字</p>
      <dl className="v1-model-facts">
        <div><dt>运行方式</dt><dd>本机离线</dd></div>
        <div><dt>模型大小</dt><dd>约 {Math.round((info?.size ?? status?.total ?? 574041195) / 1e6)} MB（磁盘占用）</dd></div>
        <div><dt>中文输出</dt><dd>简体中文</dd></div>
      </dl>
      <p className="v1-model-note">首次下载需要联网，之后可离线使用，录音无需上传。<br />转写速度取决于电脑性能和录音内容。</p>
      {(status?.phase !== 'ready' || error) && <section className="v1-model-state" aria-label="模型状态">
        {status?.phase === 'missing' && <p>下载模型后即可开始转写。</p>}
        {status?.phase === 'downloading' && <><p>{(status.downloaded / 1e6).toFixed(1)} MB / {Math.round(status.total / 1e6)} MB</p><progress max={status.total} value={status.downloaded} aria-label="模型下载进度" /></>}
        {status?.phase === 'checking' && <p>正在检查模型文件，请稍候。</p>}
        {status?.phase === 'failed' && <p role="alert">{failure.message}</p>}
        {status && ['missing', 'failed'].includes(status.phase) && <button disabled={busy || !!error} className="v1-model-download" onClick={() => void download()}>{sending ? '正在连接…' : status.phase === 'failed' ? failure.action : '下载模型'}</button>}
        {error && <p role="alert">{error}<button onClick={() => setRevision(value => value + 1)}>重新读取</button></p>}
      </section>}
      <details className="v1-model-more">
        <summary>更多信息</summary>
        <dl className="v1-model-facts">
          <div><dt>转写规格</dt><dd>Q5_0</dd></div>
          <div><dt>人声检测</dt><dd>Silero VAD · 约 0.9 MB · 已内置</dd></div>
        </dl>
        <div className="v1-model-location"><span>模型位置</span><span className="v1-model-path" title={info?.directory} tabIndex={0}>{info?.directory ?? '正在读取…'}</span>
          <button disabled={!info || opening} onClick={() => void openDirectory()}>{opening ? '正在打开…' : '打开所在文件夹'}</button>
        </div>
        <p className="v1-model-filename">{info?.fileName}</p>
        {infoError && <p role="alert">{infoError}</p>}
      </details>
      </div>
      <footer><button onClick={onClose}>关闭</button></footer>
    </div>
  </dialog>;
}
export interface ModelActions { open: () => void }
export default forwardRef<ModelActions>(function ModelPreparation(_, ref) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [error, setError] = useState(false);
  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }));
  useEffect(() => {
    if (!desktop) return;
    let live = true; let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const next = await invoke<ModelStatus>('get_model_status'); if (live) { setStatus(next); setError(false); } }
      catch { if (live) setError(true); }
      if (live) timer = setTimeout(() => void refresh(), 1500);
    }
    void refresh(); return () => { live = false; clearTimeout(timer); };
  }, []);
  const progress = status && status.total > 0 ? Math.min(100, Math.floor(status.downloaded / status.total * 100)) : 0;
  const label = !desktop ? '桌面应用可用' : error ? '读取失败' : !status ? '读取中…' : {
    missing: '未下载', downloading: `下载中 · ${progress}%`, checking: '校验中',
    failed: modelError(status.error).action === '重新下载' ? '需重新下载' : '下载失败', ready: '已就绪',
  }[status.phase];
  return <><button className="v1-model-entry" disabled={!desktop} onClick={() => setOpen(true)}>转写模型 · {label}</button>{open && <ModelDialog onClose={() => setOpen(false)} />}</>;
});
