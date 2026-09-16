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
  CreateFollowUpInput,
  FollowUpItem,
  FollowUpPriority,
  FollowUpType,
  LeadItem,
  UpdateFollowUpInput,
} from '@/lib/api/types';
import { datetimeLocalToIso } from '@/lib/datetime';
import styles from './Followups.module.css';

export const FOLLOWUP_TYPE_LABELS: Record<FollowUpType, string> = {
  CALL: 'Ligação',
  EMAIL: 'E-mail',
  WHATSAPP: 'WhatsApp',
  MEETING: 'Reunião',
  OTHER: 'Outro',
};

export const FOLLOWUP_PRIORITY_LABELS: Record<FollowUpPriority, string> = {
  LOW: 'Baixa',
  MEDIUM: 'Média',
  HIGH: 'Alta',
};

const TYPE_OPTIONS: Array<{ value: FollowUpType; label: string }> = (
  Object.keys(FOLLOWUP_TYPE_LABELS) as FollowUpType[]
).map((value) => ({ value, label: FOLLOWUP_TYPE_LABELS[value] }));

const PRIORITY_OPTIONS: Array<{ value: FollowUpPriority; label: string }> = (
  Object.keys(FOLLOWUP_PRIORITY_LABELS) as FollowUpPriority[]
).map((value) => ({ value, label: FOLLOWUP_PRIORITY_LABELS[value] }));

interface FollowUpDrawerProps {
  open: boolean;
  mode: 'create' | 'edit';
  /** Required when mode="edit". */
  followUp?: FollowUpItem | null;
  onClose: () => void;
  onCreate: (input: CreateFollowUpInput) => Promise<void>;
  onUpdate: (id: string, input: UpdateFollowUpInput) => Promise<void>;
}

const EMPTY = {
  leadId: '',
  ownerUserId: '',
  title: '',
  description: '',
  type: 'OTHER' as FollowUpType,
  priority: 'MEDIUM' as FollowUpPriority,
  scheduledAt: '',
};

/**
 * Create/edit follow-up. The Lead (Cliente) select offers an in-flow
 * "+ Cadastrar novo cliente" so the user never has to leave to /leads. The
 * "Atendente responsável" (ownerUserId) is a DISTINCT field listing internal
 * tenant users — never Leads.
 *
 * scheduledAt is only editable at creation — changing it afterwards goes
 * through the dedicated reschedule action, matching the backend's rule that
 * a generic update never touches scheduledAt.
 */
export function FollowUpDrawer({ open, mode, followUp, onClose, onCreate, onUpdate }: FollowUpDrawerProps) {
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
    if (mode === 'edit' && followUp) {
      setForm({
        leadId: followUp.leadId,
        ownerUserId: followUp.ownerUserId ?? '',
        title: followUp.title,
        description: followUp.description ?? '',
        type: followUp.type,
        priority: followUp.priority,
        scheduledAt: '',
      });
    } else {
      setForm(EMPTY);
    }
  }, [open, mode, followUp]);

  useEffect(() => {
    if (!open || mode !== 'create') return;
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
  }, [open, mode]);

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

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!form.title.trim()) {
      setError('Informe o título do follow-up.');
      return;
    }
    if (mode === 'create' && !form.leadId) {
      setError('Selecione o lead.');
      return;
    }
    if (mode === 'create' && !form.scheduledAt) {
      setError('Informe a data/hora do follow-up.');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'create') {
        await onCreate({
          leadId: form.leadId,
          ownerUserId: form.ownerUserId || undefined,
          title: form.title.trim(),
          description: form.description.trim() || undefined,
          type: form.type,
          priority: form.priority,
          scheduledAt: datetimeLocalToIso(form.scheduledAt),
        });
      } else if (followUp) {
        await onUpdate(followUp.id, {
          title: form.title.trim(),
          description: form.description.trim() || undefined,
          type: form.type,
          priority: form.priority,
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar o follow-up.');
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
        aria-label={mode === 'create' ? 'Novo follow-up' : 'Editar follow-up'}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>{mode === 'create' ? 'Novo follow-up' : 'Editar follow-up'}</h2>
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

          {mode === 'create' ? (
            <>
              <div className={styles.fieldGroup}>
                <label className={styles.selectLabel} htmlFor="fu-lead">
                  Cliente / Lead
                </label>
                <select
                  id="fu-lead"
                  className={styles.select}
                  value={form.leadId}
                  onChange={onLeadSelectChange}
                  disabled={submitting}
                  required
                >
                  <option value="">Selecione…</option>
                  {buildLeadSelectOptions(leads).map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.selectLabel} htmlFor="fu-owner">
                  Atendente responsável (opcional)
                </label>
                <select
                  id="fu-owner"
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
            </>
          ) : null}

          <Field label="Título" value={form.title} onChange={update('title')} required disabled={submitting} />
          <Field
            label="Descrição"
            value={form.description}
            onChange={update('description')}
            disabled={submitting}
          />

          <div className={styles.fieldGroup}>
            <label className={styles.selectLabel} htmlFor="fu-type">
              Tipo
            </label>
            <select
              id="fu-type"
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

          <div className={styles.fieldGroup}>
            <label className={styles.selectLabel} htmlFor="fu-priority">
              Prioridade
            </label>
            <select
              id="fu-priority"
              className={styles.select}
              value={form.priority}
              onChange={update('priority')}
              disabled={submitting}
            >
              {PRIORITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {mode === 'create' ? (
            <Field
              label="Data/hora"
              type="datetime-local"
              value={form.scheduledAt}
              onChange={update('scheduledAt')}
              required
              disabled={submitting}
            />
          ) : null}

          <div className={styles.drawerActions}>
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" loading={submitting}>
              {submitting ? 'Salvando…' : mode === 'create' ? 'Criar follow-up' : 'Salvar alterações'}
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
