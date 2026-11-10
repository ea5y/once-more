import { conversations } from './data';
const testAudio = new URL('./assets/playback-test.wav', import.meta.url).href;
const localAudio = import.meta.env.DEV ? import.meta.env.VITE_V1_AUDIO_URL : undefined;
const localDuration = Number(import.meta.env.VITE_V1_AUDIO_DURATION);
const useLocal = !!localAudio && Number.isFinite(localDuration) && localDuration >= 8;

// Existing local verification sound, not a recording of these mock conversations.
export const playbackPreviewItems = conversations.map(item => item.id === '2026-09-10-7' ? {
  ...item,
  audioUrl: useLocal ? localAudio : testAudio,
  sourcePath: useLocal ? import.meta.env.VITE_V1_AUDIO_PATH : undefined,
  sourceId: useLocal ? 'local-recording-preview' : 'local-playback-test',
  sourceName: useLocal ? '用户提供的本地录音（文字为模拟）' : '本地测试音频.wav（非对话录音）',
  sourceDuration: useLocal ? localDuration : 12,
  start: 2,
  duration: 6,
  sourceTranscript: item.transcript.map((text, index) => ({ text, start: 2 + index, end: 3 + index })),
} : item);
