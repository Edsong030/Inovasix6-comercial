import type { ReactNode } from 'react';
import styles from './PageHeader.module.css';

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
}

/**
 * Page title block. The <h1> lives in the topbar (route name), so this is an
 * <h2> and every card heading below it is an <h2>/<h3> — a flat, valid outline.
 */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className={styles.header}>
      <div className={styles.titleGroup}>
        <h2 className={styles.title}>{title}</h2>
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
