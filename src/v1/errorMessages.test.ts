import { expect, it } from 'vitest';
import { modelError, processingError } from './errorMessages';
it('uses specific model advice only for recognized causes', () => {
  expect(modelError('无法创建模型目录：File exists (os error 17)').message).toContain('同名文件');
  expect(modelError('模型保存失败：No space left on device (os error 28)').message).toContain('可用空间不足');
  expect(modelError('模型保存失败：Permission denied (os error 13)').message).toContain('访问权限');
  expect(modelError('模型检查失败：模型校验不通过，请重新下载。').action).toBe('重新下载');
  expect(modelError('下载连接失败，请检查网络后重试。').message).toContain('检查网络');
  for (const raw of ['unknown error', '模型检查失败：unexpected failure', null]) {
    expect(modelError(raw)).toEqual({ message: '模型未保存成功，请重试。', action: '重试' });
  }
});
it('keeps failure stages distinct and never guesses source loss or reusable results', () => {
  expect(processingError('Permission denied', 'preparing', 'failed')).toBe('音频准备未完成，请重试。');
  expect(processingError('原录音已移动或不可访问，请恢复后重试', 'saving', 'failed')).toContain('原录音');
  expect(processingError('Is a directory (os error 21)', 'segmenting', 'failed')).toBe('分段处理未完成，请重试。');
  expect(processingError('分段结果写入失败：Is a directory (os error 21)', 'segmenting', 'failed')).toBe('无法保存分段处理结果，请重试。');
  expect(processingError('SQLITE failure', 'saving', 'failed')).toBe('片段记录未保存成功，请重试保存。');
  expect(processingError('engine failed', 'transcribing', 'failed')).toBe('本次转写未完成，请重试。');
  expect(processingError(null, 'transcribing', 'interrupted')).toContain('手动继续');
  expect(processingError('请先准备本地转写模型', 'preparing', 'waiting')).toBe('请先准备本地转写模型。');
});
