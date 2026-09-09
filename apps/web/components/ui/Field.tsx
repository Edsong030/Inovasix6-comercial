'use client';

import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import styles from './Field.module.css';

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  /** Always required: every input in the product has a visible <label>. */
  label: string;
  hint?: string;
  error?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  compact?: boolean;
}

/**
 * Labelled text input. The label is programmatically associated via `htmlFor`,
 * hints/errors via `aria-describedby`, and errors set `aria-invalid` so screen
 * readers announce the state, not just the colour.
 */
export function Field({
  label,
  hint,
  error,
  leading,
  trailing,
  compact,
  className,
  ...rest
}: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  const inputClasses = [
    styles.input,
    leading ? styles.withLeading : '',
    trailing ? styles.withTrailing : '',
    error ? styles.invalid : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={[styles.field, compact ? styles.search : ''].filter(Boolean).join(' ')}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={styles.inputWrap}>
        {leading ? <span className={styles.leading}>{leading}</span> : null}
        <input
          id={id}
          className={inputClasses}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          {...rest}
        />
        {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
      </div>
      {hint && !error ? (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
