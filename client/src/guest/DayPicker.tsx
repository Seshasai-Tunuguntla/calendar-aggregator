import { useState } from 'react';
import { Button } from '../components/Button.tsx';
import { guestLongDate, guestMonth, type Day } from './guestTime.ts';

const PAGE = 7;
const atNoon = (date: string) => `${date}T12:00:00Z`;
const parts = (date: string) => {
  const d = new Date(atNoon(date));
  return {
    weekday: new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(d),
    day: new Intl.DateTimeFormat(undefined, { day: 'numeric', timeZone: 'UTC' }).format(d),
    month: new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }).format(d),
  };
};

// Only days that have free times are offered: a week's worth at a time, with Earlier and Later.
// When the loaded days run out, Later asks for the next six weeks.
export function DayPicker({
  days,
  selected,
  onSelect,
  canLoadMore,
  loadingMore,
  onLoadMore,
}: {
  days: readonly Day[];
  selected: string | null;
  onSelect: (date: string) => void;
  canLoadMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const [start, setStart] = useState(() => Math.max(0, Math.floor(days.findIndex((d) => d.date === selected) / PAGE) * PAGE));
  const visible = days.slice(start, start + PAGE);
  const atEnd = start + PAGE >= days.length;
  const first = visible[0];

  return (
    <section className="days" aria-label="Days with free times">
      <div className="days__head">
        <h2 className="days__month">{first ? guestMonth(atNoon(first.date), 'UTC') : ''}</h2>
        <div className="days__nav">
          <Button variant="quiet" disabled={start === 0} onClick={() => setStart(Math.max(0, start - PAGE))}>
            ← Earlier
          </Button>
          <Button
            variant="quiet"
            busy={loadingMore}
            disabled={atEnd && !canLoadMore}
            onClick={() => (atEnd ? onLoadMore() : setStart(start + PAGE))}
          >
            Later →
          </Button>
        </div>
      </div>
      <ul className="days__list">
        {visible.map(({ date, slots }) => {
          const { weekday, day, month } = parts(date);
          return (
            <li key={date}>
              <button
                type="button"
                className="day-button"
                aria-pressed={date === selected}
                aria-label={`${guestLongDate(atNoon(date), 'UTC')}, ${slots.length} free ${slots.length === 1 ? 'time' : 'times'}`}
                onClick={() => onSelect(date)}
              >
                <span className="day-button__weekday">{weekday}</span>
                <span className="day-button__day">{day}</span>
                <span className="day-button__month">{month}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {atEnd && !canLoadMore && days.length > 0 && <p className="fine-print">No more free times after these.</p>}
    </section>
  );
}
