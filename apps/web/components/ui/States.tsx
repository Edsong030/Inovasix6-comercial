import type { ReactNode } from 'react';
import styles from './States.module.css';

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <span
      className={styles.spinner}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

/** Full-viewport loader used while the session is being restored. */
export function FullScreenLoader({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div className={styles.fullscreen} role="status" aria-live="polite">
      <Spinner size={26} />
      <p className={styles.fullscreenLabel}>{label}</p>
    </div>
  );
}

interface StateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: StateProps) {
  return (
    <div className={styles.state}>
      {icon ? <span className={styles.stateIcon}>{icon}</span> : null}
      <p className={styles.stateTitle}>{title}</p>
      {description ? <p className={styles.stateDescription}>{description}</p> : null}
      {action ? <div className={styles.stateAction}>{action}</div> : null}
    </div>
  );
}

export function ErrorState({ icon, title, description, action }: StateProps) {
  return (
    <div className={`${styles.state} ${styles.errorState}`} role="alert">
      {icon ? <span className={styles.stateIcon}>{icon}</span> : null}
      <p className={styles.stateTitle}>{title}</p>
      {description ? <p className={styles.stateDescription}>{description}</p> : null}
      {action ? <div className={styles.stateAction}>{action}</div> : null}
    </div>
  );
}

export function Skeleton({
  width = '100%',
  height = 12,
  radius,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number;
}) {
  return (
    <span
      className={styles.skeleton}
      style={{ width, height, borderRadius: radius, display: 'block' }}
      aria-hidden="true"
    />
  );
}
