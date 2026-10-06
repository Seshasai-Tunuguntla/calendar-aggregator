import { Link, isRouteErrorResponse, useRouteError } from 'react-router';

// Shown when a page crashes while rendering: a way back instead of a blank screen. The details go
// to the console for whoever is debugging; the person sees a plain message.
export function ErrorPage() {
  const error = useRouteError();
  if (!isRouteErrorResponse(error)) console.error(error);
  return (
    <main className="page" id="main">
      <p className="eyebrow">Something went wrong</p>
      <h1>This page hit a problem</h1>
      <p className="lead">
        Try reloading. If it keeps happening, <Link to="/">go to the start</Link>.
      </p>
    </main>
  );
}
