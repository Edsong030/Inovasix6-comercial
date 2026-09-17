'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { IconClose } from '@/components/ui/icons';
import { buildQuickLeadInput } from '@/components/crm/quickLeadFlow';
import { createLead } from '@/lib/api/resources';
import type { LeadItem } from '@/lib/api/types';
import styles from './Crm.module.css';

interface QuickLeadDrawerProps {
  open: boolean;
  /** Optional stage to bind the new lead to (e.g. the flow's context). */
  stageId?: string;
  onClose: () => void;
  /**
   * Called with the freshly created lead. The PARENT flow is responsible for
   * appending it to its own list, auto-selecting it, and keeping its own form
   * open with the already-typed data intact.
   */
  onCreated: (lead: LeadItem) => void;
}

const EMPTY = { name: '', company: '', email: '', phone: '' };

/**
 * Compact, in-flow "Cadastrar novo cliente" drawer. It does NOT introduce a
 * second lead-creation rule: it calls the SAME POST /api/leads used everywhere
 * else (via createLead). Only the fields actually necessary per the backend
 * CreateLeadDto are requested — `name` is the single required field; company,
 * email and phone are optional. No invented required fields.
 *
 * The new lead always belongs to the authenticated tenant: the client never
 * sends a tenantId; the server derives it from the verified token.
 *
 * On success it hands the created lead to the parent and closes only itself.
 * On error it stays open, preserves the typed data, and shows a message — so
 * no partial relationship is ever created.
 */
export function QuickLeadDrawer({ open, stageId, onClose, onCreated }: QuickLeadDrawerProps) {
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(EMPTY);
      setError(null);
    }
  }, [open]);

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

    const input = buildQuickLeadInput(form, stageId);
    if (!input) {
      setError('Informe o nome do cliente.');
      return;
    }

    setSubmitting(true);
    try {
      const lead = await createLead(input);
      // Success: let the parent auto-select + keep its own state, then close
      // ONLY this quick drawer.
      onCreated(lead);
    } catch (cause) {
      // Keep the drawer open and preserve the typed data; no partial link.
      setError(cause instanceof Error ? cause.message : 'Não foi possível cadastrar o cliente.');
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.drawerScrim} role="presentation" onClick={onClose}>
      <aside
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-label="Cadastrar novo cliente"
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>Cadastrar novo cliente</h2>
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
          <Field label="Telefone / WhatsApp" value={form.phone} onChange={update('phone')} disabled={submitting} />
          <Field label="E-mail" type="email" value={form.email} onChange={update('email')} disabled={submitting} />

          <div className={styles.drawerActions}>
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" loading={submitting}>
              {submitting ? 'Salvando…' : 'Cadastrar cliente'}
            </Button>
          </div>
        </form>
      </aside>
    </div>
  );
}
