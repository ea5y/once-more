import { describe, expect, it } from 'vitest';
import { downloadPercent, installationGate, initialUpdate, updateTitle } from './updateState';
describe('signed update installation gates', () => {
  it('waits for unsaved edits, tasks, and persistence before allowing install', () => {
    for (const edit of [false,true]) for (const task of [false,true]) for (const saving of [false,true]) {
      expect(installationGate(edit,task,saving)).toBe(edit ? 'edit' : task || saving ? 'task' : null);
    }
  });
  it('does not claim completion before package verification or invent a percentage without total size', () => {
    expect(downloadPercent(500,1000)).toBe(50);
    expect(downloadPercent(1000,1000)).toBe(99);
    expect(downloadPercent(1200,1000)).toBe(99);
    expect(downloadPercent(500,null)).toBe(null);
    expect(downloadPercent(500,0)).toBe(null);
  });
  it('distinguishes both waiting reasons and exposes failure for retry', () => {
    expect(updateTitle({...initialUpdate,phase:'ready',waiting:'edit'})).toContain('保存或取消');
    expect(updateTitle({...initialUpdate,phase:'ready',waiting:'task'})).toContain('任务完成');
    expect(updateTitle({...initialUpdate,phase:'failed',error:'签名校验失败'})).toBe('签名校验失败，点击重试');
    expect(updateTitle(initialUpdate)).toBe('');
  });
});
