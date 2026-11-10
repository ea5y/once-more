interface Props { peaks?: readonly number[]; progress?: number; demo?: boolean; large?: boolean; onSeek?: (ratio: number) => void }

export default function Waveform({ progress = 0, demo = false, large = false, onSeek, peaks }: Props) {
  const bars = peaks ? peaks.map(value => 1 + Math.max(0, Math.min(1, value)) * 29) : Array.from({ length: large ? 48 : 32 }, (_, i) => demo ? 3 + Math.abs(Math.sin(i * 2.31) * Math.cos(i * 0.61)) * (large ? 25 : 15) : 3);
  return <div className={`waveform ${large ? 'large' : ''}`}>
    <svg viewBox={`0 0 ${bars.length * 5} 32`} preserveAspectRatio="none" aria-hidden="true">
      {bars.map((height, i) => <line key={i} x1={i * 5 + 2} x2={i * 5 + 2} y1={16 - height / 2} y2={16 + height / 2} className={i / bars.length < progress ? 'played' : ''} />)}
    </svg>
    {onSeek && <input aria-label="播放进度" type="range" min="0" max="1000" value={Math.round(progress * 1000)} onChange={e => onSeek(Number(e.target.value) / 1000)} />}
  </div>;
}
