'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { QuickLeadDrawer } from '@/components/crm/QuickLeadDrawer';
import {
  buildLeadSelectOptions,
  createdLeadNotice,
  isNewLeadOption,
  mergeCreatedLead,
  selectCreatedLead,
} from '@/components/crm/quickLeadFlow';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { IconClose } from '@/components/ui/icons';
import { listAssignableUsers, listLeads } from '@/lib/api/resources';
import type {
  AssignableUser,
  CalendarEventItem,
  CalendarEventType,
  CreateCalendarEventInput,
  LeadItem,
  UpdateCalendarEventInput,
} from '@/lib/api/types';
import { datetimeLocalToIso, isoToDatetimeLocal } from '@/lib/datetime';
import styles from './Agenda.module.css';

export const CALENDAR_EVENT_TYPE_LABELS: Record<CalendarEventType, string> = {
  MEETING: 'Reunião',
  CALL: 'Ligação',
  TASK: 'Tarefa',
  OTHER: 'Outro',
};

const TYPE_OPTIONS: Array<{ value: CalendarEventType; label: string }> = (
  Object.keys(CALENDAR_EVENT_TYPE_LABELS) as CalendarEventType[]
).map((value) => ({ value, label: CALENDAR_EVENT_TYPE_LABELS[value] }));

interface CalendarEventDrawerProps {
  open: boolean;
  mode: 'create' | 'edit';
  /** Required when mode="edit". */
  event?: CalendarEventItem | null;
  onClose: () => void;
  onCreate: (input: CreateCalendarEventInput) => Promise<void>;
  onUpdate: (id: string, input: UpdateCalendarEventInput) => Promise<void>;
}

const EMPTY = {
  leadId: '',
  ownerUserId: '',
  title: '',
  description: '',
  type: 'MEETING' as CalendarEventType,
  startsAt: '',
  endsAt: '',
};

/**
 * Create/edit calendar event. Lead (Cliente) and Atendente responsável are
 * both optional here (an event may be purely internal) and are DISTINCT
 * concepts: leadId is the Lead/Cliente being served, ownerUserId is the
 * internal tenant user responsible. The Lead select also offers an in-flow
 * "+ Cadastrar novo cliente" so the user never has to leave to /leads.
 */
export function CalendarEventDrawer({ open, mode, event, onClose, onCreate, onUpdate }: CalendarEventDrawerProps) {
  const [form, setForm] = useState(EMPTY);
  const [leads, setLeads] = useState<LeadItem[]>([]);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [quickLeadOpen, setQuickLeadOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);
    setQuickLeadOpen(false);
    if (mode === 'edit' && event) {
      setForm({
        leadId: event.leadId ?? '',
        ownerUserId: event.ownerUserId ?? '',
        title: event.title,
        description: event.description ?? '',
        type: event.type,
        startsAt: isoToDatetimeLocal(event.startsAt),
        endsAt: event.endsAt ? isoToDatetimeLocal(event.endsAt) : '',
      });
    } else {
      setForm(EMPTY);
    }
  }, [open, mode, event]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    listLeads({ pageSize: 100 })
      .then((result) => {
        if (active) setLeads(result.items);
      })
      .catch(() => {
        if (active) setLeads([]);
      });
    listAssignableUsers()
      .then((result) => {
        if (active) setUsers(result);
      })
      .catch(() => {
        if (active) setUsers([]);
      });
    return () => {
      active = false;
    };
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

  const onLeadSelectChange = (e: { target: { value: string } }) => {
    if (isNewLeadOption(e.target.value)) {
      setQuickLeadOpen(true);
      return;
    }
    setForm((f) => ({ ...f, leadId: e.target.value }));
  };

  // A lead was just created in-flow: add it to the list, auto-select it, keep
  // THIS form open with everything already typed intact, and close only the
  // quick drawer. Success feedback is shown inline.
  const handleQuickLeadCreated = (lead: LeadItem) => {
    setLeads((prev) => mergeCreatedLead(prev, lead));
    setForm((f) => selectCreatedLead(f, lead));
    setQuickLeadOpen(false);
    setNotice(createdLeadNotice(lead));
  };

  const handleSubmit = async (event_: FormEvent<HTMLFormElement>) => {
    event_.preventDefault();
    setError(null);

    if (!form.title.trim()) {
      setError('Informe o título do compromisso.');
      return;
    }
    if (!form.startsAt) {
      setError('Informe o início do compromisso.');
      return;
    }
    // Client-side check for fast feedback; the backend is still the final
    // source of truth (it re-validates the interval on both create/update).
    if (form.endsAt && datetimeLocalToIso(form.endsAt) < datetimeLocalToIso(form.startsAt)) {
      setError('O fim não pode ser anterior ao início.');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'create') {
        await onCreate({
          leadId: form.leadId || undefined,
          ownerUserId: form.ownerUserId || undefined,
          title: form.title.trim(),
          description: form.description.trim() || undefined,
          type: form.type,
          startsAt: datetimeLocalToIso(form.startsAt),
          endsAt: form.endsAt ? datetimeLocalToIso(form.endsAt) : undefined,
        });
      } else if (event) {
        await onUpdate(event.id, {
          leadId: form.leadId || undefined,
          ownerUserId: form.ownerUserId || undefined,
          title: form.title.trim(),
          description: form.description.trim() || undefined,
          type: form.type,
          startsAt: datetimeLocalToIso(form.startsAt),
          endsAt: form.endsAt ? datetimeLocalToIso(form.endsAt) : undefined,
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar o compromisso.');
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
  };

  return (
    <div className={styles.drawerScrim} role="presentation" onClick={onClose}>
      <aside
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'create' ? 'Novo compromisso' : 'Editar compromisso'}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>{mode === 'create' ? 'Novo compromisso' : 'Editar compromisso'}</h2>
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
          {notice ? (
            <p className={styles.drawerNotice} role="status">
              {notice}
            </p>
          ) : null}

          <div className={styles.fieldGroup}>
            <label className={styles.selectLabel} htmlFor="ce-lead">
              Cliente / Lead (opcional)
            </label>
            <select
              id="ce-lead"
              className={styles.select}
              value={form.leadId}
              onChange={onLeadSelectChange}
              disabled={submitting}
            >
              <option value="">Nenhum</option>
              {buildLeadSelectOptions(leads).map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.selectLabel} htmlFor="ce-owner">
              Atendente responsável (opcional)
            </label>
            <select
              id="ce-owner"
              className={styles.select}
              value={form.ownerUserId}
              onChange={update('ownerUserId')}
              disabled={submitting}
            >
              <option value="">Nenhum</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
          </div>

          <Field label="Título" value={form.title} onChange={update('title')} required disabled={submitting} />
          <Field
            label="Descrição"
            value={form.description}
            onChange={update('description')}
            disabled={submitting}
          />

          <div className={styles.fieldGroup}>
            <label className={styles.selectLabel} htmlFor="ce-type">
              Tipo
            </label>
            <select
              id="ce-type"
              className={styles.select}
              value={form.type}
              onChange={update('type')}
              disabled={submitting}
            >
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <Field
            label="Início"
            type="datetime-local"
            value={form.startsAt}
            onChange={update('startsAt')}
            required
            disabled={submitting}
          />
          <Field
            label="Fim (opcional)"
            type="datetime-local"
            value={form.endsAt}
            onChange={update('endsAt')}
            disabled={submitting}
          />

          <div className={styles.drawerActions}>
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" loading={submitting}>
              {submitting ? 'Salvando…' : mode === 'create' ? 'Criar compromisso' : 'Salvar alterações'}
            </Button>
          </div>
        </form>
      </aside>

      <QuickLeadDrawer
        open={quickLeadOpen}
        onClose={() => setQuickLeadOpen(false)}
        onCreated={handleQuickLeadCreated}
      />
    </div>
  );
}
