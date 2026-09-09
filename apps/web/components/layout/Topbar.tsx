'use client';

import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { IconBell, IconMenu, IconSearch } from '@/components/ui/icons';
import { titleForPath } from './nav-config';
import styles from './Topbar.module.css';
import { UserMenu } from './UserMenu';

interface TopbarProps {
  onOpenMenu: () => void;
  sidebarOpen: boolean;
}

export function Topbar({ onOpenMenu, sidebarOpen }: TopbarProps) {
  const pathname = usePathname();

  return (
    <header className={styles.topbar}>
      <Button
        className={styles.menuButton}
        variant="ghost"
        iconOnly
        aria-label="Abrir menu de navegação"
        aria-controls="app-sidebar"
        aria-expanded={sidebarOpen}
        onClick={onOpenMenu}
      >
        <IconMenu size={19} />
      </Button>

      <h1 className={styles.title}>{titleForPath(pathname)}</h1>

      {/* Visual only for now — no search backend exists yet. */}
      <div className={styles.search}>
        <span className={styles.searchIcon}>
          <IconSearch size={15} />
        </span>
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Buscar contatos, leads, empresas, conversas…"
          aria-label="Buscar no Inovasix6 Comercial IA"
        />
        <span className={styles.kbd} aria-hidden="true">
          Ctrl K
        </span>
      </div>

      <div className={`${styles.actions} ${styles.spacer}`}>
        <span className={styles.bellWrap}>
          <Button variant="ghost" iconOnly aria-label="Notificações (3 não lidas)">
            <IconBell size={18} />
          </Button>
          <span className={styles.bellDot} aria-hidden="true" />
        </span>
        <span className={styles.divider} aria-hidden="true" />
        <UserMenu />
      </div>
    </header>
  );
}
