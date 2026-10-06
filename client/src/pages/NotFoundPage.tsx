import { Link } from 'react-router';

export function NotFoundPage({ title = "There's nothing here" }: { title?: string }) {
  return (
    <main className="page" id="main">
      <p className="eyebrow">Not found</p>
      <h1>{title}</h1>
      <p className="lead">
        The link may be old or mistyped. <Link to="/">Go to the start</Link>.
      </p>
    </main>
  );
}
