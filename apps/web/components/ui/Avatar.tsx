import styles from './Avatar.module.css';

interface AvatarProps {
  initials: string;
  size?: 'sm' | 'md' | 'lg';
  /** Full name, exposed to assistive tech since the initials are decorative. */
  name?: string;
}

export function Avatar({ initials, size = 'md', name }: AvatarProps) {
  return (
    <span
      className={`${styles.avatar} ${styles[size]}`}
      role="img"
      aria-label={name ? `Avatar de ${name}` : undefined}
      aria-hidden={name ? undefined : true}
    >
      {initials}
    </span>
  );
}
