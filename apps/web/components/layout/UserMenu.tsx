'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Avatar } from '@/components/ui/Avatar';
import { IconChevronDown, IconLogout, IconSettings, IconUser } from '@/components/ui/icons';
import { useAuth } from '@/lib/auth/auth-context';
import styles from './UserMenu.module.css';

/**
 * Avatar dropdown with the sign-out action. Behaves like a menu button:
 * Escape closes, outside click closes, focus returns to the trigger.
 */
export function UserMenu() {
  const { user, signOut } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setOpen(false);
      router.replace('/login');
    }
  };

  const name = user?.displayName ?? 'Usuário';

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Menu do usuário — ${name}`}
        onClick={() => setOpen((value) => !value)}
      >
        <Avatar initials={user?.initials ?? '··'} size="sm" />
        <span className={styles.triggerName}>{name}</span>
        <span className={styles.chevron} aria-hidden="true">
          <IconChevronDown size={15} />
        </span>
      </button>

      {open ? (
        <div className={styles.menu} role="menu" aria-label="Opções da conta">
          <div className={styles.identity}>
            <span className={styles.identityName}>{name}</span>
            <span className={styles.identityMeta}>{user?.email ?? '—'}</span>
            <span className={styles.identityMeta}>
              {user?.companyName} · {user?.roleLabel}
            </span>
          </div>

          <button type="button" className={styles.item} role="menuitem" disabled>
            <IconUser size={16} />
            Meu perfil
          </button>
          <button
            type="button"
            className={styles.item}
            role="menuitem"
            onClick={() => {
              setOpen(false);
              router.push('/settings');
            }}
          >
            <IconSettings size={16} />
            Configurações
          </button>
          <button
            type="button"
            className={`${styles.item} ${styles.danger}`}
            role="menuitem"
            onClick={handleSignOut}
            disabled={signingOut}
          >
            <IconLogout size={16} />
            {signingOut ? 'Saindo…' : 'Sair'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
