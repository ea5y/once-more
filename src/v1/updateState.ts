export type UpdatePhase = 'hidden' | 'available' | 'downloading' | 'ready' | 'installing' | 'failed';
export interface UpdateState { phase: UpdatePhase; percent: number | null; version: string; error: string; waiting: 'task' | 'edit'; }
export const initialUpdate: UpdateState = { phase: 'hidden', percent: null, version: '', error: '', waiting: 'task' };
export function downloadPercent(downloaded: number, total?: number | null): number | null {
  if (!total || !Number.isFinite(total) || total <= 0 || !Number.isFinite(downloaded)) return null;
  // Download completion still needs signature verification.
  return Math.min(99, Math.max(0, Math.floor(downloaded / total * 100)));
}
export function updateTitle(state: UpdateState): string {
  switch (state.phase) {
    case 'available': return `发现新版本 ${state.version}，点击更新`;
    case 'downloading': return state.percent === null ? '正在下载更新' : `正在下载更新 · ${state.percent}%`;
    case 'ready': return state.waiting === 'edit' ? '保存或取消修改后更新' : '等待任务完成后更新';
    case 'installing': return '正在重启';
    case 'failed': return `${state.error || '更新失败'}，点击重试`;
    default: return '';
  }
}
/** All gates must be known clear; a failed check must never imply permission to restart. */
export function installationGate(editing: boolean, busy: boolean, saving: boolean): 'edit' | 'task' | null {
  return editing ? 'edit' : busy || saving ? 'task' : null;
}
