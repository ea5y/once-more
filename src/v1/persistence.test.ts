import { expect, it } from 'vitest';
import { conversations } from './data';
import { saveLibrary, restoreLibrary, loadInitialLibrary } from './persistence';
import type { Conversation } from './model';

it('round trips range, favorite, clip and source independently from dev URLs', () => {
  const item: Conversation = { ...conversations[0], sourcePath: '/source.m4a', audioUrl: 'http://dev/source', start: 2, duration: 3, saved: true, extraction: 'done', clipPath: '/clip.wav', extractedRange: { start: 2, end: 5 }, clipMissing: true };
  const saved = saveLibrary([item]);
  expect(JSON.stringify(saved)).not.toContain('http://dev');
  const restored = restoreLibrary(JSON.parse(JSON.stringify(saved)), conversations, path => `asset:${path}`)[0];
  expect(restored).toEqual({ ...item, audioUrl: 'asset:/source.m4a' });
});
it('does not restart unfinished jobs or lose their previous file', () => {
  const saved = saveLibrary([{ ...conversations[0], extraction: 'extracting', clipPath: '/old.wav' }]);
  expect(saved.items[0].extraction).toBe('failed');
  expect(saved.items[0].clipPath).toBe('/old.wav');
});
it('rejects bad versions, invalid ranges and duplicate identities without silently resetting', () => {
  expect(() => restoreLibrary({ version: 2, items: [] }, [], String)).toThrow();
  expect(() => restoreLibrary(saveLibrary([{ ...conversations[0], start: -1 }]), [], String)).toThrow();
  expect(() => restoreLibrary(saveLibrary([conversations[0], conversations[0]]), [], String)).toThrow();
});

it('starts empty, stays empty after saving/reopening, and retains the first real result', () => {
  const initial = loadInitialLibrary(null, String);
  expect(initial).toEqual([]);
  expect(loadInitialLibrary(saveLibrary(initial), String)).toEqual([]);
  const real = { ...conversations[0], sourcePath: '/real.m4a' };
  expect(loadInitialLibrary(saveLibrary([real]), path => `asset:${path}`)).toEqual([{ ...real, audioUrl: 'asset:/real.m4a' }]);
  expect(() => loadInitialLibrary({ version: 9, items: [] }, String)).toThrow();
});
