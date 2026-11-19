import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { Clock3, Download, RotateCw } from 'lucide-react';
import { desktop } from '../lib/api';
import { downloadPercent, initialUpdate, installationGate, updateTitle } from './updateState';

export default function AppUpdate({ editing, saving, busy, beforeInstall, onInstalling }: {
  editing: boolean; saving: boolean; busy: boolean;
  beforeInstall: () => Promise<void>; onInstalling: (value: boolean) => void;
}) {
  const [state, setState] = useState(initialUpdate);
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void getVersion().then(version => { if (active) setInstalledVersion(version); })
      .catch(error => console.warn('读取应用版本失败', error));
    return () => { active = false; };
  }, []);
  const current = useRef({ editing, saving, busy, beforeInstall, onInstalling });
  current.current = { editing, saving, busy, beforeInstall, onInstalling };
  const operation = useRef(false);
  const downloaded = useRef(false);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const check = async () => {
      if (operation.current) return;
      operation.current = true;
      try {
        const version = await invoke<string | null>('check_app_update');
        if (active && version) setState(previous => previous.phase === 'hidden' ? { ...previous, phase: 'available', version } : previous);
      } catch (error) { console.warn('后台更新检查未完成', error); }
      finally { operation.current = false; }
    };
    void check();
    const timer = window.setInterval(() => void check(), 60 * 60 * 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const stop = listen<{ downloaded: number; total: number | null }>('app-update-progress', ({ payload }) => {
      if (active) setState(previous => previous.phase === 'downloading' ? { ...previous, percent: downloadPercent(payload.downloaded, payload.total) } : previous);
    });
    return () => { active = false; void stop.then(unlisten => unlisten()); };
  }, []);
  useEffect(() => {
    if (state.phase !== 'ready') return;
    let active = true;
    async function installWhenReady() {
      if (operation.current) return;
      operation.current = true;
      try {
        const backendBusy = await invoke<boolean>('app_update_busy');
        if (!active) return;
        const latest = current.current;
        // Other open dialogs may contain pending changes or destructive actions too.
        const dialogOpen = !!document.querySelector('dialog[open]');
        const reason = installationGate(latest.editing || dialogOpen, latest.busy || backendBusy, latest.saving);
        if (reason) { setState(previous => ({ ...previous, waiting: reason })); return; }
        latest.onInstalling(true);
        setState(previous => ({ ...previous, phase: 'installing' }));
        await latest.beforeInstall();
        const installed = await invoke<boolean>('install_app_update');
        if (!installed) { latest.onInstalling(false); setState(previous => ({ ...previous, phase: 'ready', waiting: 'task' })); }
      } catch (error) {
        current.current.onInstalling(false);
        setState(previous => ({ ...previous, phase: 'failed', error: `安装未完成：${String(error)}` }));
      } finally { operation.current = false; }
    }
    void installWhenReady();
    const timer = window.setInterval(() => void installWhenReady(), 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [state.phase]);
  async function start() {
    if (operation.current || !['available', 'failed'].includes(state.phase)) return;
    if (downloaded.current) { setState(previous => ({ ...previous, phase: 'ready', error: '' })); return; }
    operation.current = true;
    setState(previous => ({ ...previous, phase: 'downloading', percent: null, error: '' }));
    try {
      await invoke('download_app_update');
      downloaded.current = true;
      setState(previous => ({ ...previous, phase: 'ready', percent: 100 }));
    } catch (error) { setState(previous => ({ ...previous, phase: 'failed', error: `下载未完成：${String(error)}` })); }
    finally { operation.current = false; }
  }
  if (state.phase === 'hidden') return installedVersion
    ? <span className="v1-app-version" aria-label={`当前版本 v${installedVersion}`}>v{installedVersion}</span>
    : null;
  const title = updateTitle(state);
  const clickable = state.phase === 'available' || state.phase === 'failed';
  return <button type="button" className="v1-app-update" aria-label={title} title={title} aria-disabled={!clickable} onClick={() => void start()}>
    {state.phase === 'downloading' ? <span>{state.percent === null ? '…' : `${state.percent}%`}</span>
      : state.phase === 'installing' ? <span className="v1-update-restarting">正在重启</span>
      : <><span className="v1-update-glyph">{state.phase === 'ready' ? <Clock3 size={21} /> : state.phase === 'failed' ? <RotateCw size={21} /> : <Download size={21} />}<i /></span></>}
  </button>;
}
