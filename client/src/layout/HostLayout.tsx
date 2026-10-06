import { useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthContext.tsx';
import { Button } from '../components/Button.tsx';
import { ErrorState, LoadingState } from '../components/States.tsx';

const NAV = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/calendars', label: 'Calendars' },
  { to: '/availability', label: 'Availability' },
  { to: '/event-types', label: 'Event types' },
  { to: '/account', label: 'Account' },
] as const;

// The frame around every host page. Signed-out visitors go to the sign-in page; on a phone the
// navigation folds behind a Menu button.
export function HostLayout() {
  const { state, refresh } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  if (state.status === 'loading') {
    return (
      <main className="page">
        <LoadingState label="Checking who's signed in…" />
      </main>
    );
  }
  if (state.status === 'error') {
    return (
      <main className="page">
        <ErrorState title="We couldn't check who's signed in" error={null} onRetry={() => void refresh()} />
      </main>
    );
  }
  if (state.status === 'signed-out') return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  const { user } = state;
  return (
    <div className="host">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="host-header">
        <div className="host-header__inner">
          <NavLink to="/dashboard" className="brand">
            Calendar Aggregator
          </NavLink>
          <Button variant="quiet" className="host-header__menu" aria-expanded={menuOpen} aria-controls="host-nav" onClick={() => setMenuOpen((open) => !open)}>
            Menu
          </Button>
          <nav id="host-nav" className={`host-nav${menuOpen ? ' host-nav--open' : ''}`} aria-label="Main">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) => `host-nav__link${isActive ? ' host-nav__link--active' : ''}`}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <p className="host-header__user">
            {user.name}
            {user.isDemo && <span className="tag">Demo</span>}
          </p>
        </div>
      </header>
      <main className="page" id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
