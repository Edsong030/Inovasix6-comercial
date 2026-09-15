'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { IconClose } from '@/components/ui/icons';
import { listLeads } from '@/lib/api/resources';
import type {
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
  title: '',
  description: '',
  type: 'MEETING' as CalendarEventType,
  startsAt: '',
  endsAt: '',
};

/**
 * Create/edit calendar event. Lead and Responsável are both optional here
 * (an event may be purely internal). Responsável is intentionally NOT
 * offered as a real select: there is no endpoint to list tenant users yet
 * (débito, see report) — the field is simply omitted rather than faked.
 */
export function CalendarEventDrawer({ open, mode, event, onClose, onCreate, onUpdate }: CalendarEventDrawerProps) {
  const [form, setForm] = useState(EMPTY);
  const [leads, setLeads] = useState<LeadItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (mode === 'edit' && event) {
      setForm({
        leadId: event.leadId ?? '',
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
          title: form.title.trim(),
          description: form.description.trim() || undefined,
          type: form.type,
          startsAt: datetimeLocalToIso(form.startsAt),
          endsAt: form.endsAt ? datetimeLocalToIso(form.endsAt) : undefined,
        });
      } else if (event) {
        await onUpdate(event.id, {
          leadId: form.leadId || undefined,
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

          <div className={styles.fieldGroup}>
            <label className={styles.selectLabel} htmlFor="ce-lead">
              Lead (opcional)
            </label>
            <select
              id="ce-lead"
              className={styles.select}
              value={form.leadId}
              onChange={update('leadId')}
              disabled={submitting}
            >
              <option value="">Nenhum</option>
              {leads.map((lead) => (
                <option key={lead.id} value={lead.id}>
                  {lead.name}
                  {lead.company ? ` — ${lead.company}` : lead.interest ? ` — ${lead.interest}` : ''}
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
    </div>
  );
}
