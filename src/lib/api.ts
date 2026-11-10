import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { Memory, Snapshot } from '../types';

export const desktop = isTauri();
const empty: Snapshot = { source: null, output: null, lastScan: null, recordings: [], memories: [] };

export const api = {
  snapshot: () => desktop ? invoke<Snapshot>('load_snapshot') : Promise.resolve(empty),
  async folder(kind: 'source' | 'output') {
    if (!desktop) throw new Error('请在 Once More 桌面应用中选择本地文件夹。');
    const path = await open({ directory: true, multiple: false, title: kind === 'source' ? '选择录音来源' : '选择片段输出位置' });
    if (typeof path !== 'string') return false;
    await invoke('set_folder', { kind, path });
    return true;
  },
  scan: () => invoke<number>('scan_recordings'),
  save: (memory: Memory) => invoke('save_memory', { memory }),
  export: (id: string) => invoke<string>('export_clip', { id }),
  audio: (path: string) => convertFileSrc(path),
};
