import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { meResponseSchema, type DeleteAccountResponse, type SessionUser } from '@calendar-aggregator/shared';
import { ApiRequestError, SESSION_ENDED_EVENT, apiGet, apiSend } from '../api/client.ts';

// accountDeleted rides along with "signed out" (rather than in the navigation), because the host
// layout's own redirect to /login would otherwise drop it.
type AuthState =
  | { status: 'loading' }
  | { status: 'signed-in'; user: SessionUser }
  | { status: 'signed-out'; accountDeleted?: DeleteAccountResponse }
  | { status: 'error' };

interface Auth {
  state: AuthState;
  /** Asks the API who is signed in (after demo login, for example). */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  /** The session ended on the server (account deleted, or expired). */
  markSignedOut: (accountDeleted?: DeleteAccountResponse) => void;
}

const AuthContext = createContext<Auth | null>(null);

async function loadSession(): Promise<AuthState> {
  try {
    const { user } = await apiGet('/api/auth/me', meResponseSchema);
    return { status: 'signed-in', user };
  } catch (error) {
    return error instanceof ApiRequestError && error.status === 401 ? { status: 'signed-out' } : { status: 'error' };
  }
}

// Who is signed in, from GET /api/auth/me. The session itself is an httpOnly cookie the page can't
// read, so asking the API is the only way to know.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const refresh = useCallback(async () => setState(await loadSession()), []);

  const signOut = useCallback(async () => {
    await apiSend('POST', '/api/auth/logout');
    setState({ status: 'signed-out' });
  }, []);

  const markSignedOut = useCallback(
    (accountDeleted?: DeleteAccountResponse) => setState(accountDeleted ? { status: 'signed-out', accountDeleted } : { status: 'signed-out' }),
    [],
  );

  useEffect(() => {
    let current = true;
    void loadSession().then((next) => {
      if (current) setState(next);
    });
    const ended = () => markSignedOut();
    window.addEventListener(SESSION_ENDED_EVENT, ended);
    return () => {
      current = false;
      window.removeEventListener(SESSION_ENDED_EVENT, ended);
    };
  }, [markSignedOut]);

  const value = useMemo(() => ({ state, refresh, signOut, markSignedOut }), [state, refresh, signOut, markSignedOut]);
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth must be used inside <AuthProvider>');
  return auth;
}

// For pages inside the host layout, which only renders them once someone is signed in.
export function useSignedInUser(): SessionUser {
  const { state } = useAuth();
  if (state.status !== 'signed-in') throw new Error('useSignedInUser needs a signed-in host');
  return state.user;
}
