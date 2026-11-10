import type { Memory } from '../types';

const entries: [string, string, number, Memory['kind'], number][] = [
  ['07:36', '窗外的鸟鸣和清晨的风', 36, 'Ambient', 0],
  ['09:12', '“窗外有鸟叫，阳光照进来。”', 28, 'Conversation', 1],
  ['12:04', '咖啡馆里的杯碟声和雨', 165, 'Ambient', 0],
  ['14:26', '咖啡馆里断断续续的聊天声', 56, 'Conversation', 0],
  ['15:26', '“这个你小时候也吃过吧。”', 67, 'Conversation', 2],
  ['17:08', '海浪、风、还有远处的人声', 92, 'Ambient', 0],
  ['19:42', '两个人突然笑了起来', 21, 'Laughter', 1],
  ['21:16', '“以后我们是不是可以住在海边？”', 43, 'Conversation', 3],
];

export const demoMemories: Memory[] = entries.map(([time, title, duration, kind, listens], i) => ({
  id: `demo-${i}`, recordingId: 'demo', title, date: '2026-09-10', time,
  start: i === 7 ? 9494 : 0, end: i === 7 ? 9537 : duration,
  kind, listens, saved: i === 7 || i === 4, recommended: [4, 6, 7].includes(i), demo: true,
  transcript: i === 7 ? [
    { speaker: '她', text: '我还挺想以后去海边住一阵子的。' },
    { speaker: '我', text: '我也想。' },
    { speaker: '她', text: '那我们以后真的可以试试。' },
    { speaker: '我', text: '不过得先学会开车吧。' },
    { speaker: '我', text: '坐火车去也行，反正不赶时间。' },
    { speaker: '她', text: '那就说好了。' },
  ] : [],
}));
