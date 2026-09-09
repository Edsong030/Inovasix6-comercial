import type { ReactNode } from 'react';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { AppShell } from '@/components/layout/AppShell';

/**
 * Layout for every private route. `RequireAuth` resolves the session before the
 * shell renders, so private content is never painted for a signed-out visitor.
 */
export default function PrivateLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <AppShell>{children}</AppShell>
    </RequireAuth>
  );
}
