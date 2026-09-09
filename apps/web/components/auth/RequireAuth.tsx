'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { FullScreenLoader } from '@/components/ui/States';
import { useAuth } from '@/lib/auth/auth-context';

/**
 * Client-side gate for every private route.
 *
 * A Next middleware cannot do this job: the access token is memory-only and the
 * refresh cookie is `Path=/api/auth`, so no server-visible credential exists on
 * a page request. The guard therefore renders a full-screen loader — never the
 * private layout — until the session is resolved, so no private content flashes.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  if (status === 'authenticated') return <>{children}</>;

  return (
    <FullScreenLoader
      label={status === 'loading' ? 'Restaurando sessão…' : 'Redirecionando para o login…'}
    />
  );
}
