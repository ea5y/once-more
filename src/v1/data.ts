import type { Conversation } from './model';

type Entry = [time: string, text: string[], duration: number, saved?: boolean, listens?: number];
const days: [string, Entry[]][] = [
  ['2026-09-10', [
    ['07:36', ['今天早饭想吃点什么？', '煮一碗面吧，再加个鸡蛋。'], 36],
    ['09:12', ['窗外有鸟叫，阳光照进来。', '把窗户打开一点吧。'], 28, false, 1],
    ['12:04', ['我们坐窗边那张桌子吧。', '好，那里能看到街上的树。', '这条街比上次来的时候安静多了。', '可能大家都还在吃午饭。', '你看，对面那家小店还开着。', '以前放学以后，我们经常在那里等车。', '那时候总觉得回家的路特别长。', '现在再走一遍，几分钟就到路口了。', '要不吃完饭我们也走走？', '可以，今天下午没有别的安排。', '先沿着街道走到桥边。', '桥旁边是不是还有一棵很大的树？', '还在，前几天我路过的时候看到了。', '我们以前会在树下躲雨。', '有一次雨太大，等了好久才回家。', '你还把外套借给了我。', '那件外套后来穿了很多年。', '这些小事，聊起来就又想起来了。', '下次也叫上以前的朋友一起吧。', '好，我回去问问大家什么时候有空。', '菜来了，我们先吃饭。', '吃完再慢慢走，不着急。'], 165],
    ['14:26', ['上次你说的那本书，我看完了。', '你最喜欢哪一段？', '最后那一段，我又读了一遍。'], 56],
    ['15:26', ['这个你小时候也吃过吧。', '吃过，放学回家的路上就有卖的。'], 67, true, 2],
    ['17:08', ['沿着这条路走就能到海边。', '那我们慢慢走过去。'], 92],
    ['19:42', ['你还记得上次迷路的事吗？', '记得，最后倒是找到一家很好吃的小店。'], 21, true, 1],
    ['21:16', ['我还挺想以后去海边住一阵子的。', '我也想。', '那我们以后真的可以试试。', '不过得先学会开车吧。', '坐火车去也行，反正不赶时间。', '那就说好了。'], 43, true, 3],
  ]],
  ['2026-09-09', [
    ['08:20', ['今天带伞了吗？', '带了，下午好像会下雨。'], 32],
    ['18:40', ['周末一起去逛书店吧。', '好啊，我想找一本讲植物的书。'], 58, true, 1],
  ]],
  ['2026-09-08', [
    ['10:15', ['阳台上的薄荷又长高了。', '晚上可以摘一点泡水。'], 25],
    ['20:05', ['明天早点出门散步吧。', '好，我们去河边走走。'], 47],
  ]],
];

const initialConversations = days.flatMap(([date, entries]) => entries.map(([time, transcript, duration, saved = false, listens = 0], index) => ({
  id: `${date}-${index}`, date, time, transcript, duration, saved, listens,
  sourceId: date === '2026-09-10' && index === 7 ? 'recording-seaside' : `recording-${date}`,
  sourceName: date === '2026-09-10' && index === 7 ? '2026.09.10 21:00 - 海边的计划.wav' : `${date.replaceAll('-', '.')} - 日常对话.wav`,
  sourceAvailable: true, sourceDuration: 3600,
  start: index === 7 ? 960 : index * 180,
})));

// Immutable source transcript, shared by selections from the same recording.
export const conversations: readonly Conversation[] = initialConversations.map(item => ({
  ...item,
  sourceTranscript: initialConversations.filter(other => other.sourceId === item.sourceId).flatMap(other => other.transcript.map((text, index) => ({
    text, start: other.start + other.duration * index / other.transcript.length,
    end: other.start + other.duration * (index + 1) / other.transcript.length,
  }))).sort((a, b) => a.start - b.start),
}));
