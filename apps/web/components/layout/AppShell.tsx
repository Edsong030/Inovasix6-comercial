'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import styles from './AppShell.module.css';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

/**
 * Grid shell: fixed sidebar on desktop, icon rail on tablet, off-canvas drawer
 * on mobile. The drawer closes on route change and on Escape.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  return (
    <div className={styles.shell}>
      <Sidebar user={user} open={menuOpen} onClose={() => setMenuOpen(false)} />
      <Topbar onOpenMenu={() => setMenuOpen(true)} sidebarOpen={menuOpen} />
      {menuOpen ? (
        <button
          type="button"
          className={styles.overlay}
          aria-label="Fechar menu de navegação"
          onClick={() => setMenuOpen(false)}
        />
      ) : null}
      <main className={styles.main} id="conteudo-principal" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
