import type { Conversation, TimedSentence } from './model';
export interface PausePreviewResult {
  seconds: number; duration: number;
  parts: { start: number; end: number; title: string; text: string[]; sentences: TimedSentence[] }[];
  source: { id: string; path: string; name: string; modified: number; recordedAt: number };
  transcript: TimedSentence[];
}
export type ConfirmSegments = (result: PausePreviewResult) => Promise<void>;
export function segmentConversations(result: PausePreviewResult, audioUrl: (path: string) => string): Conversation[] {
  if (!Number.isFinite(result.source.recordedAt)) throw new Error('缺少可靠的录音开始时间');
  return result.parts.map((part, index) => {
    // Use embedded recording time, never the filesystem modification time.
    const date = new Date(result.source.recordedAt * 1000 + part.start * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return { id: `pause:${result.source.id}:${index}`, sourceId: result.source.id,
      sourcePath: result.source.path, sourceName: result.source.name, sourceAvailable: true,
      sourceDuration: result.duration, start: part.start, duration: part.end - part.start,
      date: `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`,
      time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
      transcript: part.text, sourceTranscript: result.transcript, segmentTranscript: part.sentences,
      pauseSeconds: result.seconds, saved: false, listens: 0, audioUrl: audioUrl(result.source.path),
    };
  });
}
export function addFirstSegments(items: readonly Conversation[], incoming: readonly Conversation[]): readonly Conversation[] {
  if (!incoming.length || items.some(item => item.sourceId === incoming[0].sourceId)) return items;
  return [...items, ...incoming];
}
