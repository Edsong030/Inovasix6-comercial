import type { ReactNode } from 'react';
import styles from './Card.module.css';

interface CardProps {
  children: ReactNode;
  /** Adds hover affordances. Only for cards that are actually clickable. */
  interactive?: boolean;
  className?: string;
  /** Renders as <section> with this accessible name. */
  ariaLabel?: string;
}

export function Card({ children, interactive, className, ariaLabel }: CardProps) {
  const classes = [styles.card, interactive ? styles.interactive : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <section className={classes} aria-label={ariaLabel}>
      {children}
    </section>
  );
}

interface CardHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /** Heading level, so each page keeps a sane document outline. */
  as?: 'h2' | 'h3';
}

export function CardHeader({ title, subtitle, actions, as = 'h2' }: CardHeaderProps) {
  const Heading = as;
  return (
    <header className={styles.header}>
      <div className={styles.headingGroup}>
        <Heading className={styles.title}>{title}</Heading>
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}

export function CardBody({
  children,
  flush,
  className,
}: {
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  const classes = [styles.body, flush ? styles.bodyFlush : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return <div className={classes}>{children}</div>;
}

export function CardFooter({ children }: { children: ReactNode }) {
  return <footer className={styles.footer}>{children}</footer>;
}
