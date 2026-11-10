import { useEffect, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { desktop } from '../lib/api';
import MainView from './MainView';
import { playbackPreviewItems } from './playbackPreview';
import { loadInitialLibrary } from './persistence';
import type { Conversation } from './model';

export default function PersistedView() {
  const preview = !desktop && new URLSearchParams(location.search).get('preview') === 'demo';
  const [items, setItems] = useState<readonly Conversation[] | null>(desktop ? null : preview ? playbackPreviewItems : []);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    setError('');
    void invoke<unknown>('load_v1_library').then(data => {
      const restored = loadInitialLibrary(data, convertFileSrc);
      if (active) setItems(restored);
    }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [attempt]);
  if (!items) return <main className="app v1-app"><div className="empty-state"><h1>{error ? '无法读取片段记录' : '正在读取片段记录…'}</h1>{error && <><p role="alert">{error}</p><button className="secondary" onClick={() => setAttempt(value => value + 1)}>重试</button></>}</div></main>;
  return <MainView items={items} persist={desktop} preview={preview} />;
}
