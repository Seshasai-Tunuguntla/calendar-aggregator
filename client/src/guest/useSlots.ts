import { useCallback, useEffect, useState } from 'react';
import { MAX_SLOT_QUERY_DAYS, slotsResponseSchema, type Slot } from '@calendar-aggregator/shared';
import { apiGet } from '../api/client.ts';
import { addDays, todayIn } from './guestTime.ts';

interface Window {
  from: string;
  to: string;
  slots: Slot[];
}

export interface SlotsState {
  slots: Slot[];
  loading: boolean;
  error: unknown;
  /** Another window can be loaded (the last one wasn't empty). */
  canLoadMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  /** Loads every window again (after "that time was just taken"). */
  refresh: () => Promise<void>;
  retry: () => void;
}

const fetchWindow = async (bookingPath: string, from: string, timeZone: string): Promise<Window> => {
  const to = addDays(from, MAX_SLOT_QUERY_DAYS);
  const { slots } = await apiGet(`/api/public${bookingPath}/slots?${new URLSearchParams({ from, to, tz: timeZone })}`, slotsResponseSchema);
  return { from, to, slots };
};

// Free times for an event type, in the guest's time zone, six weeks (the API's limit per request)
// at a time from today. Changing the time zone starts again, because the guest's days move.
export function useSlots(bookingPath: string, timeZone: string): SlotsState {
  const [windows, setWindows] = useState<Window[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let current = true;
    void fetchWindow(bookingPath, todayIn(timeZone), timeZone).then(
      (first) => {
        if (!current) return;
        setWindows([first]);
        setError(null);
        setLoading(false);
      },
      (caught: unknown) => {
        if (!current) return;
        setError(caught);
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [bookingPath, timeZone]);

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchWindow(bookingPath, todayIn(timeZone), timeZone)
      .then((first) => setWindows([first]))
      .catch((caught: unknown) => setError(caught))
      .finally(() => setLoading(false));
  }, [bookingPath, timeZone]);

  const loadMore = useCallback(() => {
    const last = windows.at(-1);
    if (!last) return;
    setLoadingMore(true);
    fetchWindow(bookingPath, last.to, timeZone)
      .then((next) => setWindows((current) => [...current, next]))
      .catch((caught: unknown) => setError(caught))
      .finally(() => setLoadingMore(false));
  }, [windows, bookingPath, timeZone]);

  const refresh = useCallback(async () => {
    const fresh = await Promise.all(windows.map((w) => fetchWindow(bookingPath, w.from, timeZone)));
    setWindows(fresh);
  }, [windows, bookingPath, timeZone]);

  const last = windows.at(-1);
  return {
    slots: windows.flatMap((w) => w.slots),
    loading,
    error,
    canLoadMore: last !== undefined && last.slots.length > 0,
    loadingMore,
    loadMore,
    refresh,
    retry,
  };
}
