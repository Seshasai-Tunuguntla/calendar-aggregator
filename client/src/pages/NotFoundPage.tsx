import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <main className="page" id="main">
      <p className="eyebrow">Not found</p>
      <h1>There's nothing here</h1>
      <p className="lead">
        The link may be old or mistyped. <Link to="/">Go to the start</Link>.
      </p>
    </main>
  );
}
