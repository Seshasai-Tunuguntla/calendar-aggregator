import { useId } from 'react';
import type { Slot } from '@calendar-aggregator/shared';
import { guestLongDate, guestTime } from './guestTime.ts';

// The free times on one day, as real buttons: picked is aria-pressed (and styled solid).
export function SlotPicker({
  slots,
  timeZone,
  selected,
  onSelect,
}: {
  slots: readonly Slot[];
  timeZone: string;
  selected: string | null;
  onSelect: (slot: Slot) => void;
}) {
  const headingId = useId();
  const first = slots[0];
  if (!first) return null;
  return (
    <section className="slots" aria-labelledby={headingId}>
      <h2 className="slots__title" id={headingId}>
        {guestLongDate(first.start, timeZone)}
      </h2>
      <ul className="slots__list" role="list">
        {slots.map((slot) => (
          <li key={slot.start}>
            <button type="button" className="slot" aria-pressed={slot.start === selected} onClick={() => onSelect(slot)}>
              {guestTime(slot.start, timeZone)}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
