'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { IconClose, IconLogo } from '@/components/ui/icons';
import type { SessionUser } from '@/lib/auth/types';
import { isActivePath, NAV_SECTIONS } from './nav-config';
import styles from './Sidebar.module.css';

interface SidebarProps {
  user: SessionUser | null;
  /** Drawer state — only meaningful on mobile. */
  open: boolean;
  onClose: () => void;
}

export function Sidebar({ user, open, onClose }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside
      id="app-sidebar"
      className={`${styles.sidebar} ${open ? styles.sidebarOpen : ''}`}
      aria-label="Navegação principal"
    >
      <div className={styles.brand}>
        <span className={styles.mark} aria-hidden="true">
          <IconLogo size={20} />
        </span>
        <span className={styles.brandText}>
          <span className={styles.brandName}>
            Inovasix<span className={styles.brandSix}>6</span>
          </span>
          <span className={styles.brandSuffix}>Comercial IA</span>
        </span>
        <Button
          className={styles.closeButton}
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Fechar menu"
          onClick={onClose}
        >
          <IconClose size={17} />
        </Button>
      </div>

      <nav className={styles.nav}>
        {NAV_SECTIONS.map((section) => (
          <div className={styles.section} key={section.id}>
            {/* A <span>, not a heading: the sidebar precedes the topbar <h1> in
                the DOM, and section labels are group names, not outline nodes. */}
            <span className={styles.sectionLabel} id={`nav-${section.id}`}>
              {section.label}
            </span>
            <ul className={styles.items} aria-labelledby={`nav-${section.id}`}>
              {section.items.map((item) => {
                const active = isActivePath(pathname, item.href);
                const ItemIcon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`${styles.item} ${active ? styles.itemActive : ''}`}
                      aria-current={active ? 'page' : undefined}
                      onClick={onClose}
                      // Tablet collapses labels to icons; keep the name available.
                      title={item.label}
                    >
                      <span className={styles.itemIcon}>
                        <ItemIcon size={17} />
                      </span>
                      <span className={styles.itemLabel}>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className={styles.footer}>
        <div className={styles.planCard}>
          <span className={styles.planLabel}>Plano atual</span>
          <span className={styles.planRow}>
            <span className={styles.planName}>Profissional</span>
            <span className={styles.planStatus}>
              <span className={styles.planDot} aria-hidden="true" />
              Ativo
            </span>
          </span>
        </div>

        <div className={styles.promoCard} aria-hidden="true">
          <p className={styles.promoText}>Inteligência que gera mais negócios.</p>
          <span className={styles.promoBrand}>
            <IconLogo size={14} />
            Inovasix<span className={styles.brandSix}>6</span> Comercial IA
          </span>
        </div>

        <div className={styles.tenantCard}>
          <Avatar initials={user?.initials ?? '··'} size="md" />
          <span className={styles.tenantText}>
            <span className={styles.tenantCompany}>{user?.companyName ?? 'Empresa'}</span>
            <span className={styles.tenantUser}>{user?.displayName ?? '—'}</span>
            <span className={styles.tenantRole}>{user?.roleLabel ?? '—'}</span>
          </span>
        </div>
      </div>
    </aside>
  );
}
