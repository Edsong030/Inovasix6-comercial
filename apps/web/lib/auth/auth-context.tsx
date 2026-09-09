'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as authApi from './api';
import {
  companyNameFromSlug,
  displayNameFromEmail,
  initialsFrom,
  roleLabel,
} from './identity';
import { clearEmailHint, readSessionHints, writeSessionHints } from './session-hints';
import { clearAccessToken } from './token-store';
import { AuthError, type AuthStatus, type MeResponse, type SessionUser } from './types';

interface AuthContextValue {
  status: AuthStatus;
  user: SessionUser | null;
  /** Slug remembered from the last sign-in, for pre-filling the login form. */
  rememberedSlug: string;
  rememberedEmail: string;
  signIn: (slug: string, email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function toSessionUser(me: MeResponse, slug: string, email: string | null): SessionUser {
  const displayName = displayNameFromEmail(email, 'Usuário');
  return {
    ...me,
    slug,
    email,
    companyName: companyNameFromSlug(slug),
    displayName,
    roleLabel: roleLabel(me.roles),
    initials: initialsFrom(displayName),
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [hints, setHints] = useState({ slug: '', email: '' });
  // Survives re-renders; used to ignore a bootstrap that finished after unmount.
  const mounted = useRef(true);

  /** Drops every trace of the session from this tab. */
  const resetSession = useCallback(() => {
    clearAccessToken();
    clearEmailHint();
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  // A refresh that fails mid-flight (revoked/rotated/expired) ends the session.
  useEffect(() => {
    authApi.setSessionExpiredHandler(() => {
      if (mounted.current) resetSession();
    });
    return () => authApi.setSessionExpiredHandler(null);
  }, [resetSession]);

  // Bootstrap: the access token is gone after a reload, but the HttpOnly
  // refresh cookie may still be valid — try exactly once to restore the session.
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const stored = readSessionHints();
    setHints({ slug: stored.slug ?? '', email: stored.email ?? '' });

    void (async () => {
      const token = await authApi.refreshAccessToken();
      if (!token) {
        if (mounted.current) setStatus('unauthenticated');
        return;
      }
      try {
        const me = await authApi.fetchMe(controller.signal);
        if (!mounted.current) return;
        setUser(toSessionUser(me, stored.slug ?? '', stored.email));
        setStatus('authenticated');
      } catch {
        if (!mounted.current) return;
        clearAccessToken();
        setStatus('unauthenticated');
      }
    })();

    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, []);

  const signIn = useCallback(async (slug: string, email: string, password: string) => {
    await authApi.login(slug, email, password);
    let me: MeResponse;
    try {
      me = await authApi.fetchMe();
    } catch {
      // Token issued but the profile call failed — do not half-authenticate.
      clearAccessToken();
      throw new AuthError(authApi.GENERIC_CREDENTIALS_ERROR, 401);
    }
    writeSessionHints({ slug, email });
    setHints({ slug, email });
    setUser(toSessionUser(me, slug, email));
    setStatus('authenticated');
  }, []);

  const signOut = useCallback(async () => {
    await authApi.logout();
    resetSession();
  }, [resetSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      rememberedSlug: hints.slug,
      rememberedEmail: hints.email,
      signIn,
      signOut,
    }),
    [status, user, hints.slug, hints.email, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth precisa estar dentro de <AuthProvider>.');
  return context;
}
