import type { ReactNode } from 'react';
import styles from './Badge.module.css';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  /** Leading status dot — the tone is never the only signal, the text carries it. */
  dot?: boolean;
}

export function Badge({ children, tone = 'neutral', dot }: BadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[tone]}`}>
      {dot ? <span className={styles.dot} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
