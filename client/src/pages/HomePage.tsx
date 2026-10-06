import { useEffect, useState } from 'react';
import { healthResponseSchema } from '@calendar-aggregator/shared';
import { apiGet } from '../api/client.ts';

type ApiState = 'checking' | 'ok' | 'unreachable';

// Placeholder until the real pages arrive (phases 8-9). It proves the client -> shared <- server
// wiring: the response is parsed with the same schema the server's tests check.
export function HomePage() {
  const [api, setApi] = useState<ApiState>('checking');

  useEffect(() => {
    const controller = new AbortController();
    apiGet('/api/health', healthResponseSchema, { signal: controller.signal })
      .then(() => setApi('ok'))
      .catch(() => {
        if (!controller.signal.aborted) setApi('unreachable');
      });
    return () => controller.abort();
  }, []);

  return (
    <main>
      <h1>Calendar Aggregator</h1>
      <p>Combine your Google Calendars into real free time, and share a booking link.</p>
      <p role="status">
        {api === 'checking' && 'Checking the API…'}
        {api === 'ok' && 'API is up.'}
        {api === 'unreachable' && 'The API is unreachable.'}
      </p>
    </main>
  );
}
