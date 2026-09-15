'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { IconClose } from '@/components/ui/icons';
import type { CreateLeadInput, PipelineStageView } from '@/lib/api/types';
import styles from './Crm.module.css';

interface NewLeadDrawerProps {
  open: boolean;
  stages: PipelineStageView[];
  onClose: () => void;
  onCreate: (input: CreateLeadInput) => Promise<void>;
}

const EMPTY = { name: '', company: '', email: '', phone: '', amount: '', source: '', stageId: '' };

/** Slide-over form to create a lead. Persists via the real API (onCreate). */
export function NewLeadDrawer({ open, stages, onClose, onCreate }: NewLeadDrawerProps) {
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset when opened; default the stage to the first column.
  useEffect(() => {
    if (open) {
      setForm({ ...EMPTY, stageId: stages[0]?.id ?? '' });
      setError(null);
    }
  }, [open, stages]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const update = (key: keyof typeof EMPTY) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!form.name.trim()) {
      setError('Informe o nome do lead.');
      return;
    }

    const input: CreateLeadInput = {
      name: form.name.trim(),
      company: form.company.trim() || undefined,
      email: form.email.trim() || undefined,
      phone: form.phone.trim() || undefined,
      source: form.source.trim() || undefined,
      stageId: form.stageId || undefined,
      amountCents: form.amount ? Math.round(Number(form.amount.replace(',', '.')) * 100) : undefined,
    };

    setSubmitting(true);
    try {
      await onCreate(input);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível criar o lead.');
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.drawerScrim} role="presentation" onClick={onClose}>
      <aside
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-label="Novo lead"
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>Novo lead</h2>
          <Button variant="ghost" size="sm" iconOnly aria-label="Fechar" onClick={onClose}>
            <IconClose size={17} />
          </Button>
        </header>

        <form className={styles.drawerForm} onSubmit={handleSubmit} noValidate>
          {error ? (
            <p className={styles.drawerError} role="alert">
              {error}
            </p>
          ) : null}

          <Field label="Nome" value={form.name} onChange={update('name')} required disabled={submitting} />
          <Field label="Empresa" value={form.company} onChange={update('company')} disabled={submitting} />
          <Field label="Email" type="email" value={form.email} onChange={update('email')} disabled={submitting} />
          <Field label="Telefone" value={form.phone} onChange={update('phone')} disabled={submitting} />
          <Field
            label="Valor (R$)"
            inputMode="decimal"
            placeholder="0,00"
            value={form.amount}
            onChange={update('amount')}
            disabled={submitting}
          />

          <div className={styles.fieldGroup}>
            <label className={styles.selectLabel} htmlFor="new-lead-stage">
              Etapa
            </label>
            <select
              id="new-lead-stage"
              className={styles.select}
              value={form.stageId}
              onChange={update('stageId')}
              disabled={submitting}
            >
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <Field label="Origem" value={form.source} onChange={update('source')} disabled={submitting} placeholder="WhatsApp, Site…" />

          <div className={styles.drawerActions}>
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" loading={submitting}>
              {submitting ? 'Salvando…' : 'Criar lead'}
            </Button>
          </div>
        </form>
      </aside>
    </div>
  );
}
