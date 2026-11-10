import { useEffect, useRef, type Dispatch } from 'react';
import type { Conversation, LibraryAction, Playback } from './model';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { playbackSource } from './playbackSource';

/** One media element owns the actual clock; navigation never mounts another player. */
export default function AudioPlayback({ item, playback, dispatch, onError, preferExtracted = false }: {
  item: Conversation; playback: Playback; dispatch: Dispatch<LibraryAction>; onError: (message: string) => void; preferExtracted?: boolean;
}) {
  const { clipPath, start: mediaStart } = playbackSource(item, preferExtracted);
  const path = clipPath ?? item.sourcePath;
  const mediaUrl = path && /\.m4a$/i.test(path) ? convertFileSrc(path, "media") : clipPath ? convertFileSrc(clipPath) : item.audioUrl;
  const audio = useRef<HTMLAudioElement>(null);
  const latest = useRef(playback);
  latest.current = playback;
  useEffect(() => {
    const player = audio.current!;
    let disposed = false;
    const fail = () => {
      if (disposed) return;
      void invoke('report_playback_error', { detail: { id: item.id, code: player.error?.code,
        message: player.error?.message, readyState: player.readyState, networkState: player.networkState,
        mediaDuration: Number.isFinite(player.duration) ? player.duration : null,
        mediaStart, clipDuration: item.duration, currentTime: player.currentTime } }).catch(() => undefined);
      player.pause();
      dispatch({ type: 'pause' });
      onError(clipPath ? '无法播放提取文件，文件可能已移动、删除或无法读取。请恢复文件或调整范围后重新提取。' : '无法播放本地音频，请检查文件或重新点击播放。');
    };
    const start = async () => {
      if (disposed || !latest.current.playing) return;
      try {
        if (clipPath) await invoke('check_v1_clip', { path: clipPath });
        if (disposed || !latest.current.playing) return;
        // AAC decoder padding can differ from WebKit container duration by ~100ms.
        if (!Number.isFinite(player.duration) || mediaStart >= player.duration || mediaStart + item.duration > player.duration + 0.25) { fail(); return; }
        player.currentTime = mediaStart + latest.current.position;
        await player.play();
      } catch { fail(); }
    };
    const update = () => {
      if (disposed || !latest.current.playing || player.seeking || player.readyState < 2 || (player.paused && !player.ended)) return;
      const position = player.ended ? item.duration : Math.max(0, Math.min(item.duration, player.currentTime - mediaStart));
      const ended = player.ended || position >= item.duration;
      if (ended) { player.pause(); player.currentTime = Math.min(player.duration, mediaStart + item.duration); }
      dispatch({ type: 'media-position', id: item.id, position, ended });
    };
    player.addEventListener('loadedmetadata', start);
    player.addEventListener('error', fail);
    player.addEventListener('timeupdate', update);
    player.addEventListener('ended', update);
    const timer = window.setInterval(update, 100);
    if (playback.playing) {
      onError('');
      if (player.error) player.load();
      else if (player.readyState >= 1) void start();
    } else player.pause();
    return () => {
      disposed = true;
      window.clearInterval(timer);
      player.removeEventListener('loadedmetadata', start);
      player.removeEventListener('error', fail);
      player.removeEventListener('timeupdate', update);
      player.removeEventListener('ended', update);
      player.pause();
    };
  }, [mediaUrl, clipPath, mediaStart, item.id, item.duration, playback.playing, dispatch, onError]);
  useEffect(() => {
    const player = audio.current!;
    // Seek only on an explicit sentence request. Media clock updates can be batched
    // by React; comparing them to a newer reported position caused repeated seeks.
    if (player.readyState >= 1 && latest.current.seekVersion != null) player.currentTime = mediaStart + latest.current.position;
  }, [playback.seekVersion, mediaStart]);
  return <audio ref={audio} src={mediaUrl} preload="metadata" aria-label="本地音频播放器" />;
}
