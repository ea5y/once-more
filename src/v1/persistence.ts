import type { Conversation } from './model';

export interface SavedLibrary { version: 1; items: Omit<Conversation, 'audioUrl'>[] }
export function saveLibrary(items: readonly Conversation[]): SavedLibrary {
  return { version: 1, items: items.map(({ audioUrl: _audioUrl, ...item }) => ({
    ...item,
    // Interrupted jobs must never restart merely because the app was opened.
    ...(item.extraction === 'extracting' ? { extraction: 'failed' as const, extractionError: '上次提取未确认完成，请检查文件后重试。' } : {}),
  })) };
}

export function restoreLibrary(data: unknown, defaults: readonly Conversation[], audioUrl: (path: string) => string): Conversation[] {
  const saved = data as SavedLibrary;
  if (!saved || saved.version !== 1 || !Array.isArray(saved.items)) throw new Error('保存记录的版本或格式不受支持，未覆盖原记录。');
  const ids = new Set<string>();
  return saved.items.map(item => {
    if (!item || typeof item.id !== 'string' || ids.has(item.id) || typeof item.sourceId !== 'string' || typeof item.date !== 'string' || typeof item.time !== 'string' || typeof item.sourceName !== 'string' || typeof item.saved !== 'boolean' || typeof item.sourceAvailable !== 'boolean'
      || !Number.isFinite(item.start) || !Number.isFinite(item.duration) || !Number.isFinite(item.sourceDuration) || item.start < 0 || item.duration <= 0 || item.start + item.duration > item.sourceDuration + 0.001
      || !Array.isArray(item.transcript) || !item.transcript.every(text => typeof text === 'string') || !Array.isArray(item.sourceTranscript) || !item.sourceTranscript.every(sentence => typeof sentence.text === 'string' && Number.isFinite(sentence.start) && Number.isFinite(sentence.end))
      || (item.sourcePath !== undefined && typeof item.sourcePath !== 'string') || (item.clipPath !== undefined && typeof item.clipPath !== 'string')) throw new Error('保存记录损坏，未覆盖原记录。');
    ids.add(item.id);
    const fallback = defaults.find(value => value.id === item.id && value.sourceId === item.sourceId);
    return { ...item, audioUrl: item.sourcePath ? audioUrl(item.sourcePath) : fallback?.audioUrl,
      ...(item.extraction === 'extracting' ? { extraction: 'failed', extractionError: '上次提取未确认完成，请检查文件后重试。' } : {}),
    };
  });
}

/** A missing library is a new installation, never permission to seed demo records. */
export function loadInitialLibrary(data: unknown, audioUrl: (path: string) => string): Conversation[] {
  return data === null ? [] : restoreLibrary(data, [], audioUrl);
}
