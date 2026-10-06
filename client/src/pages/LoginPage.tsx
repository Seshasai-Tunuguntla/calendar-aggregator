import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { DEMO_BOOKING_PATH } from '@calendar-aggregator/shared';
import { apiSend, errorMessage } from '../api/client.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { Button, ButtonLink } from '../components/Button.tsx';
import { Notice } from '../components/Notice.tsx';
import { LoadingState } from '../components/States.tsx';
import { browserTimeZone, googleStartUrl, signInErrorMessage } from '../signInErrors.ts';

// "Sign in with Google" leaves for Google's page (a full navigation, not a fetch: the OAuth flow
// needs the browser itself to go there). "Try as host" signs into the demo host with one click.
export function LoginPage() {
  const { state, refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);

  const deleted = state.status === 'signed-out' ? state.accountDeleted : undefined;
  const signInError = signInErrorMessage(params.get('error'));

  if (state.status === 'loading') {
    return (
      <main className="page">
        <LoadingState label="Loading…" />
      </main>
    );
  }
  if (state.status === 'signed-in') return <Navigate to="/dashboard" replace />;

  const tryAsHost = async () => {
    setDemoBusy(true);
    setDemoError(null);
    try {
      await apiSend('POST', '/api/auth/demo');
      await refresh();
      await navigate('/dashboard');
    } catch (error) {
      setDemoError(errorMessage(error));
      setDemoBusy(false);
    }
  };

  return (
    <main className="page login" id="main">
      <section className="login__intro">
        <p className="eyebrow">Calendar Aggregator</p>
        <h1>
          Your Google Calendars, turned into <em>real free time</em>.
        </h1>
        <p className="lead">
          It reads only when you're busy across your calendars, applies your working hours, and gives guests a link to book what's free. The
          event lands on your Google Calendar, and Google sends the invitation.
        </p>
      </section>
      <section className="login__actions" aria-label="Sign in">
        {deleted && (
          <Notice tone="success" title="Your account was deleted">
            {!deleted.revokedAtGoogle && (
              <p>We couldn't reach Google to remove this app's access. You can remove it at myaccount.google.com/permissions.</p>
            )}
            {deleted.eventsNotDeleted > 0 && (
              <p>
                {deleted.eventsNotDeleted} upcoming {deleted.eventsNotDeleted === 1 ? 'event' : 'events'} couldn't be removed from your calendar,
                so those guests weren't told. Please let them know.
              </p>
            )}
          </Notice>
        )}
        {signInError && (
          <Notice tone="danger" title="Sign-in didn't finish">
            <p>{signInError}</p>
          </Notice>
        )}
        <ButtonLink variant="primary" className="button--wide" href={googleStartUrl({ tz: browserTimeZone() })}>
          Sign in with Google
        </ButtonLink>
        <p className="fine-print">
          While the app is in Google's testing mode, only invited test users can sign in with Google. Anyone can try the demo.
        </p>
        <div className="rule-or">
          <span>or</span>
        </div>
        <Button variant="secondary" className="button--wide" busy={demoBusy} onClick={tryAsHost}>
          Try as host
        </Button>
        <p className="fine-print">Signs you in as Priya, a demo host with a busy week. Nothing is sent to anyone.</p>
        <Link className="button button--secondary button--wide" to={DEMO_BOOKING_PATH}>
          Try booking
        </Link>
        <p className="fine-print">Book a time with Priya, as a guest would.</p>
        {demoError && (
          <Notice tone="danger">
            <p>{demoError}</p>
          </Notice>
        )}
      </section>
    </main>
  );
}
