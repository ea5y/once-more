/** Presentation only: keep original backend errors in status/queue records for diagnosis. */
const space = (raw: string) => /No space left on device|database or disk is full/i.test(raw);
const permission = (raw: string) => /Permission denied|Operation not permitted/i.test(raw);
export function modelError(raw: string | null): { message: string; action: string } {
  const error = raw ?? '';
  const retry = (message: string) => ({ message, action: '重试' });
  if (space(error)) return retry('可用空间不足，请释放空间后重试。');
  if (permission(error)) return retry('无法保存模型，请检查应用数据文件夹的访问权限后重试。');
  if (error.startsWith('无法创建模型目录：') && /File exists|Not a directory/i.test(error)) return retry('模型保存位置存在同名文件，无法创建文件夹。请处理冲突后重试。');
  if (/模型文件不完整|模型校验不通过|下载内容大小不符/.test(error)) return { message: '模型文件不完整或已损坏，请重新下载。', action: '重新下载' };
  if (/下载连接失败|下载中断/.test(error)) return retry('模型下载未完成，请检查网络后重试。');
  return retry('模型未保存成功，请重试。');
}
const knownTaskMessages: Record<string, string> = {
  '原录音已移动或不可访问，请恢复后重试': '无法读取原录音，请确认文件仍在原位置且可以访问。',
  '请先准备本地转写模型': '请先准备本地转写模型。',
  '请先完成本地转写模型准备': '请先准备本地转写模型。',
  '本地转写引擎缺失，请重新安装完整应用': '本地转写引擎缺失，请重新安装完整应用。',
  '原录音或任务参数与保留结果不一致，未覆盖已有结果': '原录音或任务参数与保留结果不一致，未覆盖已有结果。',
  '转写期间原录音发生变化，请重试': '转写期间原录音发生变化，请重试。',
};
export function processingError(raw: string | null, stage: string, status: string): string {
  if (status === 'interrupted') return '上次处理已中断，请手动继续。';
  const error = raw ?? '';
  if (knownTaskMessages[error]) return knownTaskMessages[error];
  if (space(error)) return '可用空间不足，请释放空间后重试。';
  if (stage === 'cleaning') return '清理未完成，重试将继续清理剩余文件；已删除内容不会恢复。';
  if (stage === 'saving') return '片段记录未保存成功，请重试保存。';
  if (error.startsWith('分段结果写入失败：')) return '无法保存分段处理结果，请重试。';
  if (stage === 'segmenting') return '分段处理未完成，请重试。';
  if (stage === 'transcribing') return '本次转写未完成，请重试。';
  if (stage === 'preparing') return '音频准备未完成，请重试。';
  return '本次处理未完成，请重试。';
}
