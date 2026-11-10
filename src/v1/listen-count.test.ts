import { expect, it } from 'vitest';
import { conversations } from './data';
import { createLibrary, libraryReducer, type LibraryState } from './model';
import { saveLibrary, restoreLibrary } from './persistence';
const item = { ...conversations[0], audioUrl: '/test.wav', duration: 6, listens: 0 };
const play = (s: LibraryState) => libraryReducer(s, { type: 'play', id: item.id });
const progress = (s: LibraryState, position: number, ended = false) => libraryReducer(s, { type: 'media-position', id: item.id, position, ended });
it('full play counts once, duplicate end does not, full replay counts again and persists', () => {
  let s = play(createLibrary([item]));
  s = progress(s, 3); expect(s.items[0].listens).toBe(0);
  s = progress(s, 6, true); expect(s.items[0].listens).toBe(1);
  s = progress(s, 6, true); expect(s.items[0].listens).toBe(1);
  s = progress(play(s), 6, true); expect(s.items[0].listens).toBe(2);
  expect(restoreLibrary(saveLibrary(s.items), [], p => p)[0].listens).toBe(2);
});
it('pause and resume preserve eligibility without incrementing until completion', () => {
  let s = progress(play(createLibrary([item])), 2);
  s = play(s); expect(s.playback.playing).toBe(false);
  s = progress(s, 6, true); expect(s.items[0].listens).toBe(0);
  s = play(s); expect(s.playback.position).toBe(2);
  s = progress(s, 6, true); expect(s.items[0].listens).toBe(1);
});
it('sentence jump including first sentence disqualifies the pass, next full replay counts', () => {
  let s = progress(play(createLibrary([item])), 2);
  s = libraryReducer(s, { type: 'sentence', id: item.id, index: 0 });
  s = progress(s, 6, true); expect(s.items[0].listens).toBe(0);
  s = progress(play(s), 6, true); expect(s.items[0].listens).toBe(1);
});
it('early end, wrong clip and errors before playback do not increment', () => {
  let s = play(createLibrary([item]));
  s = libraryReducer(s, { type: 'media-position', id: 'other', position: 6, ended: true });
  s = progress(s, 2, true); expect(s.items[0].listens).toBe(0);
  s = progress(play(s), 6, true); expect(s.items[0].listens).toBe(0);
});
it('range edit resets the pass and a full play of the new range counts once', () => {
  let s = progress(play(createLibrary([item])), 2);
  s = libraryReducer(s, { type: 'range', id: item.id, start: item.start, end: item.start + 5 });
  s = progress(play(s), 5, true); expect(s.items[0].listens).toBe(1);
});
it('pausing a jump to the first sentence does not turn it into a full-play attempt', () => {
  let s = libraryReducer(createLibrary([item]), { type: 'sentence', id: item.id, index: 0 });
  s = play(play(s));
  s = progress(s, 6, true);
  expect(s.items[0].listens).toBe(0);
});
