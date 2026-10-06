import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { deleteAccountResponseSchema } from '@calendar-aggregator/shared';
import { apiSend, errorMessage } from '../api/client.ts';
import { useAuth, useSignedInUser } from '../auth/AuthContext.tsx';
import { Button } from '../components/Button.tsx';
import { Field } from '../components/Field.tsx';
import { Notice } from '../components/Notice.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { timeZoneLabel } from '../format.ts';

export function AccountPage() {
  const user = useSignedInUser();
  const { signOut, markSignedOut } = useAuth();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [confirmHandle, setConfirmHandle] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const leave = async () => {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await signOut();
      await navigate('/login');
    } catch (error) {
      setSignOutError(errorMessage(error));
      setSigningOut(false);
    }
  };

  const deleteAccount = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await apiSend('DELETE', '/api/account', { confirmHandle }, deleteAccountResponseSchema);
      // Signing out sends the host layout to /login, which shows what happened.
      markSignedOut(result);
    } catch (error) {
      setDeleteError(errorMessage(error));
      setDeleting(false);
    }
  };

  return (
    <>
      <PageHeader eyebrow="Account" title="Your account" />
      <section className="panel" aria-labelledby="profile">
        <h2 id="profile" className="panel__title">
          Profile
        </h2>
        <dl className="facts">
          <div>
            <dt>Name</dt>
            <dd>{user.name}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{user.email}</dd>
          </div>
          <div>
            <dt>Booking links start with</dt>
            <dd>
              <code>/book/{user.handle}/</code>
            </dd>
          </div>
          <div>
            <dt>Time zone</dt>
            <dd>
              {timeZoneLabel(user.timeZone)} · <Link to="/availability">Change</Link>
            </dd>
          </div>
        </dl>
        <Button busy={signingOut} onClick={leave}>
          Sign out
        </Button>
        {signOutError && <p className="field__error">{signOutError}</p>}
      </section>

      <section className="panel panel--danger" aria-labelledby="delete">
        <h2 id="delete" className="panel__title">
          Delete my account
        </h2>
        {user.isDemo ? (
          <p>The demo account is shared by every visitor, so it can't be deleted. It resets by itself.</p>
        ) : (
          <>
            <p>This can't be undone. We will:</p>
            <ul className="plain-list plain-list--bullets">
              <li>cancel your upcoming bookings, and Google will email each guest that the meeting is off;</li>
              <li>remove this app's access to your Google accounts;</li>
              <li>delete your hours, event types, bookings, calendars and everything else we hold for you;</li>
              <li>sign you out everywhere.</li>
            </ul>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void deleteAccount();
              }}
            >
              <Field label={`Type your handle, ${user.handle}, to confirm`} error={deleteError}>
                {(control) => (
                  <input {...control} className="input" autoComplete="off" spellCheck={false} value={confirmHandle} onChange={(e) => setConfirmHandle(e.target.value)} />
                )}
              </Field>
              <Button type="submit" variant="danger" busy={deleting} disabled={confirmHandle !== user.handle}>
                Delete my account
              </Button>
            </form>
          </>
        )}
      </section>
      {deleting && (
        <Notice tone="info">
          <p>Cancelling bookings and removing access at Google…</p>
        </Notice>
      )}
    </>
  );
}
