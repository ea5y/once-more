import type { Memory, View } from '../types';

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const whole = Math.floor(seconds);
  const parts = [Math.floor(whole / 60) % 60, whole % 60];
  if (whole >= 3600) parts.unshift(Math.floor(whole / 3600));
  return parts.map(n => String(n).padStart(2, '0')).join(':');
}

export function timePeriod(time: string) {
  const hour = Number(time.split(':')[0]);
  if (hour >= 5 && hour < 8) return { label: '清晨', icon: 'dawn' };
  if (hour >= 8 && hour < 11) return { label: '上午', icon: 'morning' };
  if (hour >= 11 && hour < 14) return { label: '中午', icon: 'noon' };
  if (hour >= 14 && hour < 17) return { label: '午后', icon: 'afternoon' };
  if (hour >= 17 && hour < 19) return { label: '傍晚', icon: 'dusk' };
  return { label: '夜晚', icon: 'night' };
}

export function filterMemories(memories: Memory[], view: View, query: string) {
  const term = query.trim().toLocaleLowerCase();
  return memories.filter(memory => {
    if (view === 'saved' && !memory.saved) return false;
    return !term || `${memory.title} ${memory.transcript.map(t => t.text).join(' ')}`.toLocaleLowerCase().includes(term);
  });
}

export function validRange(start: number, end: number, duration: number) {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= duration;
}
