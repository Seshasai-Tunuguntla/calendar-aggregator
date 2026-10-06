import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../components/Button.tsx';
import { zoneLabel, zoneName } from './guestTime.ts';

// "Times are in your time zone, Dubai (GMT+4). Change": detected from the browser, changeable.
export function TimeZonePicker({ timeZone, onChange }: { timeZone: string; onChange: (zone: string) => void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="tz-picker">
      <p>
        Times are in <strong>{zoneLabel(timeZone)}</strong>.{' '}
        {!open && (
          <Button variant="quiet" className="tz-picker__change" onClick={() => setOpen(true)} aria-expanded={false} aria-controls={id}>
            Change time zone
          </Button>
        )}
      </p>
      {open && (
        <div className="field">
          <label className="field__label" htmlFor={id}>
            Your time zone
          </label>
          <ZoneSelect
            id={id}
            timeZone={timeZone}
            onChange={(zone) => {
              onChange(zone);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

// Every zone the browser knows, in order of the names people look for (Kolkata, not Calcutta).
function ZoneSelect({ id, timeZone, onChange }: { id: string; timeZone: string; onChange: (zone: string) => void }) {
  const select = useRef<HTMLSelectElement>(null);
  // The "Change time zone" button goes away when this opens: keep the guest's place by focusing the list.
  useEffect(() => select.current?.focus(), []);
  const zones = Intl.supportedValuesOf('timeZone');
  // The browser may list the guest's zone under another of its names (Asia/Calcutta for Asia/Kolkata).
  const listed = zones.includes(timeZone) ? timeZone : new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone;
  const options = (zones.includes(listed) ? zones : [listed, ...zones])
    .map((zone) => ({ zone, name: zoneName(zone) }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  return (
    <select ref={select} id={id} className="select" value={listed} onChange={(e) => onChange(e.target.value)}>
      {options.map(({ zone, name }) => (
        <option key={zone} value={zone}>
          {name}
        </option>
      ))}
    </select>
  );
}
