'use client';

import { useCallback, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody } from '@/components/ui/Card';
import { EmptyState, ErrorState, Spinner } from '@/components/ui/States';
import { IconCheck, IconPlus } from '@/components/ui/icons';
import tableStyles from '@/components/ui/Table.module.css';
import {
  cancelFollowUp,
  completeFollowUp,
  createFollowUp,
  listFollowUps,
  rescheduleFollowUp,
  updateFollowUp,
} from '@/lib/api/resources';
import type { FollowUpItem } from '@/lib/api/types';
import { useApiResource } from '@/lib/api/useApiResource';
import { datetimeLocalToIso, formatDateTime, isoToDatetimeLocal } from '@/lib/datetime';
import { FOLLOWUP_TYPE_LABELS, FollowUpDrawer } from './FollowUpDrawer';
import styles from './Followups.module.css';

export type FollowupTab = 'ativos' | 'agendados' | 'concluidos';

const TABS: Array<{ id: FollowupTab; label: string }> = [
  { id: 'ativos', label: 'Ativos' },
  { id: 'agendados', label: 'Agendados' },
  { id: 'concluidos', label: 'Concluídos' },
];

interface FollowupsData {
  ativos: FollowUpItem[];
  agendados: FollowUpItem[];
  concluidos: FollowUpItem[];
}

const initials = (name: string) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

export function statusBadge(row: FollowUpItem): { tone: BadgeTone; label: string } {
  if (row.status === 'COMPLETED') return { tone: 'success', label: 'Concluído' };
  if (row.status === 'CANCELED') return { tone: 'danger', label: 'Cancelado' };
  if (row.overdue) return { tone: 'warning', label: 'Atrasado' };
  return { tone: 'neutral', label: 'Agendado' };
}

/**
 * Tab -> API filter mapping, extracted so it's testable without rendering
 * the component. "Ativos" = overdue shortcut; "Agendados" = PENDING from
 * now onward (server-filtered, not a client-side scan); "Concluídos" =
 * COMPLETED. Kept in sync with the fetcher below.
 */
export function followupTabParams(tab: FollowupTab, nowIso: string) {
  if (tab === 'ativos') return { overdue: true, pageSize: 50 } as const;
  if (tab === 'agendados') return { status: 'PENDING' as const, from: nowIso, pageSize: 50 };
  return { status: 'COMPLETED' as const, pageSize: 50 };
}

/**
 * Real data via GET /api/follow-ups. "Ativos" = PENDING + overdue (uses the
 * API's overdue=true shortcut); "Agendados" = PENDING scheduled in the
 * future (from=now, so the API filters, not a client-side scan of every
 * row); "Concluídos" = COMPLETED. CANCELED follow-ups are not listed in any
 * tab — the current layout only has these three tabs and adding a fourth
 * would be a redesign, so this is a documented limitation, not a bug.
 */
export function FollowupsView() {
  const [tab, setTab] = useState<FollowupTab>('ativos');
  const [drawerMode, setDrawerMode] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<FollowUpItem | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  const [rescheduleValue, setRescheduleValue] = useState('');

  const fetcher = useCallback(async (signal: AbortSignal): Promise<FollowupsData> => {
    const nowIso = new Date().toISOString();
    const [ativos, agendados, concluidos] = await Promise.all([
      listFollowUps(followupTabParams('ativos', nowIso), signal),
      listFollowUps(followupTabParams('agendados', nowIso), signal),
      listFollowUps(followupTabParams('concluidos', nowIso), signal),
    ]);
    return { ativos: ativos.items, agendados: agendados.items, concluidos: concluidos.items };
  }, []);

  const { data, state, error, reload } = useApiResource<FollowupsData>(fetcher);
  const rows = data ? data[tab] : [];

  const runAction = useCallback(
    async (id: string, action: () => Promise<unknown>) => {
      setBusyId(id);
      setActionError(null);
      try {
        await action();
        reload();
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : 'Não foi possível concluir a ação.');
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  const confirmReschedule = useCallback(
    (id: string) => {
      if (!rescheduleValue) return;
      runAction(id, () => rescheduleFollowUp(id, datetimeLocalToIso(rescheduleValue))).then(() => {
        setReschedulingId(null);
      });
    },
    [rescheduleValue, runAction],
  );

  if (state === 'loading') {
    return (
      <div className={styles.loading} role="status">
        <Spinner size={22} />
        <span>Carregando follow-ups…</span>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <ErrorState
        title="Não foi possível carregar os follow-ups"
        description={error ?? undefined}
        action={
          <Button variant="secondary" size="sm" onClick={reload}>
            Tentar novamente
          </Button>
        }
      />
    );
  }

  return (
    <>
      <div className={styles.toolbar}>
        <Button variant="primary" onClick={() => setDrawerMode('create')}>
          <IconPlus size={16} />
          Novo follow-up
        </Button>
      </div>

      {actionError ? (
        <p className={tableStyles.tab} role="alert" style={{ color: '#ffb9b4', marginBottom: 10 }}>
          {actionError}
        </p>
      ) : null}

      <div className={tableStyles.tabs} role="tablist" aria-label="Situação dos follow-ups">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`followups-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls="followups-panel"
            className={`${tableStyles.tab} ${tab === item.id ? tableStyles.tabActive : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label} ({data ? data[item.id].length : 0})
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id="followups-panel"
        aria-labelledby={`followups-tab-${tab}`}
        style={{ marginTop: 16 }}
      >
        <Card ariaLabel="Follow-ups">
          {rows.length === 0 ? (
            <CardBody>
              <EmptyState
                icon={<IconCheck size={19} />}
                title="Nenhum follow-up nesta lista"
                description="Quando houver follow-ups nesta situação, eles aparecem aqui."
              />
            </CardBody>
          ) : (
            <div className={tableStyles.scroll}>
              <table className={tableStyles.table}>
                <caption className="srOnly">
                  Follow-ups com lead, título, tipo, prazo, situação e ações
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Lead</th>
                    <th scope="col">Título</th>
                    <th scope="col">Tipo</th>
                    <th scope="col">Prazo</th>
                    <th scope="col">Status</th>
                    <th scope="col">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const badge = statusBadge(row);
                    const isBusy = busyId === row.id;
                    return (
                      <tr key={row.id}>
                        <td>
                          <span className={tableStyles.identity}>
                            <Avatar initials={initials(row.leadName)} size="sm" />
                            <span className={tableStyles.identityName}>{row.leadName}</span>
                          </span>
                        </td>
                        <td>{row.title}</td>
                        <td className={tableStyles.nowrap}>{FOLLOWUP_TYPE_LABELS[row.type]}</td>
                        <td className={tableStyles.nowrap}>
                          {reschedulingId === row.id ? (
                            <span className={styles.rescheduleInline}>
                              <input
                                type="datetime-local"
                                className={styles.rescheduleInput}
                                value={rescheduleValue}
                                onChange={(e) => setRescheduleValue(e.target.value)}
                              />
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={isBusy}
                                onClick={() => confirmReschedule(row.id)}
                              >
                                OK
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={isBusy}
                                onClick={() => setReschedulingId(null)}
                              >
                                ×
                              </Button>
                            </span>
                          ) : (
                            formatDateTime(row.scheduledAt)
                          )}
                        </td>
                        <td>
                          <Badge tone={badge.tone} dot>
                            {badge.label}
                          </Badge>
                        </td>
                        <td>
                          {row.status === 'PENDING' ? (
                            <span className={styles.actions}>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={isBusy}
                                onClick={() => {
                                  setEditing(row);
                                  setDrawerMode('edit');
                                }}
                              >
                                Editar
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={isBusy}
                                onClick={() => runAction(row.id, () => completeFollowUp(row.id))}
                              >
                                Concluir
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={isBusy}
                                onClick={() => runAction(row.id, () => cancelFollowUp(row.id))}
                              >
                                Cancelar
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={isBusy}
                                onClick={() => {
                                  setReschedulingId(row.id);
                                  setRescheduleValue(isoToDatetimeLocal(row.scheduledAt));
                                }}
                              >
                                Reagendar
                              </Button>
                            </span>
                          ) : (
                            <span className={tableStyles.nowrap}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className={tableStyles.footer}>
            <span>{rows.length} follow-ups</span>
          </div>
        </Card>
      </div>

      <FollowUpDrawer
        open={drawerMode !== null}
        mode={drawerMode ?? 'create'}
        followUp={editing}
        onClose={() => {
          setDrawerMode(null);
          setEditing(null);
        }}
        onCreate={async (input) => {
          await createFollowUp(input);
          setDrawerMode(null);
          reload();
        }}
        onUpdate={async (id, input) => {
          await updateFollowUp(id, input);
          setDrawerMode(null);
          setEditing(null);
          reload();
        }}
      />
    </>
  );
}
