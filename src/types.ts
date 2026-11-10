export interface Recording {
  id: string;
  path: string;
  name: string;
  modified: number;
  size: number;
}

export interface Memory {
  id: string;
  recordingId: string;
  title: string;
  date: string;
  time: string;
  start: number;
  end: number;
  kind: 'Conversation' | 'Laughter' | 'Ambient' | 'Recording';
  saved: boolean;
  recommended: boolean;
  listens: number;
  transcript: { speaker: string; text: string }[];
  demo?: boolean;
}

export interface Snapshot {
  source: string | null;
  output: string | null;
  lastScan: string | null;
  recordings: Recording[];
  memories: Memory[];
}

export type View = 'all' | 'saved';
