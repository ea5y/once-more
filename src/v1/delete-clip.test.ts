import { expect, it } from 'vitest';
import { conversations } from './data';
import { createLibrary, libraryReducer, conversationsOn } from './model';

it('deletes the selected clip, stops its playback, and selects the next visible clip', () => {
  const initial=createLibrary(conversations);
  const day=conversationsOn(initial.items,initial.date);
  const first=day[0];
  const state={...initial,selectedId:first.id,undoId:first.id,playback:{id:first.id,position:5,playing:true}};
  const result=libraryReducer(state,{type:'delete-clip',id:first.id});
  expect(result.items.some(i=>i.id===first.id)).toBe(false);
  expect(result.selectedId).toBe(day[1].id);
  expect(result.playback).toEqual({id:null,position:0,playing:false});
  expect(result.undoId).toBeNull();
});
it('handles the last clip and preserves unrelated selected clips', () => {
  const single=createLibrary([conversations[0]]);
  const empty=libraryReducer(single,{type:'delete-clip',id:conversations[0].id});
  expect(empty.items).toEqual([]);expect(empty.date).toBe('');expect(empty.selectedId).toBe('');
  const full=createLibrary(conversations);
  const other=full.items.find(i=>i.id!==full.selectedId)!;
  expect(libraryReducer(full,{type:'delete-clip',id:other.id}).selectedId).toBe(full.selectedId);
});

it('seeks within the clip and starts playback without adding a listen', () => {
  const state=createLibrary(conversations);const item=state.items[0];
  const next=libraryReducer(state,{type:'seek',id:item.id,ratio:0.5});
  expect(next.playback.position).toBe(item.duration/2);expect(next.playback.playing).toBe(true);
  expect(next.items).toBe(state.items);
  expect(libraryReducer(next,{type:'seek',id:item.id,ratio:2}).playback.position).toBeLessThan(item.duration);
});
