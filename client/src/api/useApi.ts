import { useCallback, useEffect, useRef, useState } from 'react';

export interface ApiState<T> {
  data: T | undefined;
  error: unknown;
  /** True while a load is in flight (the first one, or a reload). */
  loading: boolean;
  /** Loads again, keeping the current data on screen meanwhile. */
  reload: () => void;
}

// Loads data for a page: the loading, error and ready states every page shows. `load` gets an
// AbortSignal, so leaving the page (or reloading) cancels a request that's still running.
export function useApi<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): ApiState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    loadRef
      .current(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught);
        setLoading(false);
      });
    return () => controller.abort();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the caller lists what `load` depends on
  }, [version, ...deps]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, loading, reload };
}
