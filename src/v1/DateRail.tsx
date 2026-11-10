import { useLayoutEffect, useRef } from 'react';

interface DateRailProps {
  dates: readonly string[];
  date: string;
  onDate: (date: string) => void;
}

/** The line belongs to the viewport; only the date nodes scroll. */
export default function DateRail({ dates, date, onDate }: DateRailProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const selected = useRef<HTMLButtonElement>(null);
  const dateKey = dates.join(',');

  useLayoutEffect(() => {
    const container = viewport.current;
    const button = selected.current;
    if (!container || !button) return;
    // Reveal a selection changed by filtering/search, without scrolling the page.
    const top = button.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    const bottom = top + button.offsetHeight;
    if (top < container.scrollTop) container.scrollTop = Math.max(0, top - 8);
    else if (bottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = bottom - container.clientHeight + 8;
    }
  }, [date, dateKey]);

  if (!dates.length) return null;
  return <nav className="v1-date-rail" aria-label="日期导航">
    <div className="v1-date-rail-scroll" ref={viewport}>
      {dates.map((value, index) => <div className="v1-date-entry" key={value}>
        {index > 0 && value.slice(0, 4) !== dates[index - 1].slice(0, 4) &&
          <span className="v1-date-year">{value.slice(0, 4)}</span>}
        <button ref={value === date ? selected : undefined}
          aria-label={`查看 ${value} 的记忆`} title={value}
          aria-current={value === date ? 'date' : undefined}
          onClick={() => onDate(value)}>
          <span className="v1-date-dot" aria-hidden="true" />
          <time dateTime={value}>{value.slice(5).replace('-', '.')}</time>
        </button>
      </div>)}
    </div>
  </nav>;
}
