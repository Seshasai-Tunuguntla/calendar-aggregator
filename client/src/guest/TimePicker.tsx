import { useMemo, useState } from 'react';
import type { Slot } from '@calendar-aggregator/shared';
import { EmptyState, ErrorState, LoadingState } from '../components/States.tsx';
import { DayPicker } from './DayPicker.tsx';
import { groupByDay } from './guestTime.ts';
import { SlotPicker } from './SlotPicker.tsx';
import type { SlotsState } from './useSlots.ts';

// Days with free times, then the times on the chosen day: shared by the booking page and the
// manage page's "Reschedule". The first day with times is chosen to start with.
export function TimePicker({
  slots,
  timeZone,
  selected,
  onSelect,
}: {
  slots: SlotsState;
  timeZone: string;
  selected: Slot | null;
  onSelect: (slot: Slot) => void;
}) {
  const days = useMemo(() => groupByDay(slots.slots, timeZone), [slots.slots, timeZone]);
  const [chosen, setChosen] = useState<string | null>(null);
  // If the chosen day has no times any more (just taken, or the zone changed), use the first.
  const date = days.some((d) => d.date === chosen) ? chosen : (days[0]?.date ?? null);
  const day = days.find((d) => d.date === date);

  if (slots.loading) return <LoadingState label="Finding free times…" />;
  if (slots.error && days.length === 0) return <ErrorState title="Can't show free times" error={slots.error} onRetry={slots.retry} />;
  if (days.length === 0) {
    return (
      <EmptyState title="No free times in the next six weeks">
        {slots.canLoadMore ? 'Try later dates, or check back soon.' : 'Please check back soon.'}
      </EmptyState>
    );
  }
  return (
    <div className="time-picker">
      <DayPicker
        key={timeZone}
        days={days}
        selected={date}
        onSelect={setChosen}
        canLoadMore={slots.canLoadMore}
        loadingMore={slots.loadingMore}
        onLoadMore={slots.loadMore}
      />
      {day && <SlotPicker slots={day.slots} timeZone={timeZone} selected={selected?.start ?? null} onSelect={onSelect} />}
    </div>
  );
}
