'use client';

import { useCallback, useMemo, useState } from 'react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState, Spinner } from '@/components/ui/States';
import { IconAgenda, IconPlus } from '@/components/ui/icons';
import tableStyles from '@/components/ui/Table.module.css';
import {
  cancelCalendarEvent,
  completeCalendarEvent,
  createCalendarEvent,
  listCalendarEvents,
  updateCalendarEvent,
} from '@/lib/api/resources';
import type { CalendarEventItem } from '@/lib/api/types';
import { useApiResource } from '@/lib/api/useApiResource';
import { formatTime } from '@/lib/datetime';
import { CALENDAR_EVENT_TYPE_LABELS, CalendarEventDrawer } from './CalendarEventDrawer';
import styles from './Agenda.module.css';

type View = 'hoje' | 'semana';

const STATUS_TONE: Record<CalendarEventItem['status'], BadgeTone> = {
  SCHEDULED: 'info',
  COMPLETED: 'success',
  CANCELED: 'danger',
};

const STATUS_LABEL: Record<CalendarEventItem['status'], string> = {
  SCHEDULED: 'Agendado',
  COMPLETED: 'Concluído',
  CANCELED: 'Cancelado',
};

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

/** Monday of the week containing `d` (local time). */
export function startOfWeek(d: Date): Date {
  const day = d.getDay(); // 0 = Sunday .. 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  return addDays(startOfDay(d), diffToMonday);
}

export function dayKey(d: Date): string {
  return startOfDay(d).toISOString();
}

export function dayLabel(d: Date, today: Date): string {
  const diffDays = Math.round((startOfDay(d).getTime() - startOfDay(today).getTime()) / 86400000);
  if (diffDays === 0) return 'Hoje';
  if (diffDays === 1) return 'Amanhã';
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(d);
}

export function weekdayLabel(d: Date): string {
  const s = new Intl.DateTimeFormat('pt-BR', { weekday: 'long' }).format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface WeekDay {
  date: Date;
  events: CalendarEventItem[];
}

interface AgendaData {
  today: CalendarEventItem[];
  week: WeekDay[];
}

/**
 * Real data via GET /api/calendar/events. A single request bounded to the
 * CURRENT calendar week (Monday-Sunday, from/to) covers both tabs — "Hoje"
 * is just that week's bucket for today's date, so there is no second
 * request and no client-side scan of an unbounded event list.
 */
export function AgendaView() {
  const [view, setView] = useState<View>('hoje');
  const [drawerMode, setDrawerMode] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<CalendarEventItem | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetcher = useCallback(async (signal: AbortSignal): Promise<AgendaData> => {
    const now = new Date();
    const weekStart = startOfWeek(now);
    const weekEnd = addDays(weekStart, 7);

    const result = await listCalendarEvents(
      { from: weekStart.toISOString(), to: weekEnd.toISOString(), pageSize: 100 },
      signal,
    );

    const byDay = new Map<string, CalendarEventItem[]>();
    for (const ev of result.items) {
      const key = dayKey(new Date(ev.startsAt));
      const list = byDay.get(key) ?? [];
      list.push(ev);
      byDay.set(key, list);
    }

    const week: WeekDay[] = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(weekStart, i);
      return { date, events: byDay.get(dayKey(date)) ?? [] };
    });

    const today = week.find((d) => dayKey(d.date) === dayKey(now))?.events ?? [];

    return { today, week };
  }, []);

  const { data, state, error, reload } = useApiResource<AgendaData>(fetcher);

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

  const now = useMemo(() => new Date(), []);

  if (state === 'loading') {
    return (
      <div className={styles.loading} role="status">
        <Spinner size={22} />
        <span>Carregando agenda…</span>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <ErrorState
        title="Não foi possível carregar a agenda"
        description={error ?? undefined}
        action={
          <Button variant="secondary" size="sm" onClick={reload}>
            Tentar novamente
          </Button>
        }
      />
    );
  }

  const todayEvents = data?.today ?? [];
  const week = data?.week ?? [];

  return (
    <>
      <div className={styles.toolbar}>
        <Button variant="primary" onClick={() => setDrawerMode('create')}>
          <IconPlus size={16} />
          Novo compromisso
        </Button>
      </div>

      {actionError ? (
        <p role="alert" style={{ color: '#ffb9b4', marginBottom: 10, fontSize: 12.5 }}>
          {actionError}
        </p>
      ) : null}

      <div className={tableStyles.tabs} role="tablist" aria-label="Período da agenda">
        {(['hoje', 'semana'] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            id={`agenda-tab-${option}`}
            aria-selected={view === option}
            aria-controls={`agenda-panel-${option}`}
            className={`${tableStyles.tab} ${view === option ? tableStyles.tabActive : ''}`}
            onClick={() => setView(option)}
          >
            {option === 'hoje' ? 'Hoje' : 'Semana'}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 16 }}>
        {view === 'hoje' ? (
          <div role="tabpanel" id="agenda-panel-hoje" aria-labelledby="agenda-tab-hoje">
            <Card ariaLabel="Compromissos de hoje">
              <CardHeader title="Hoje" subtitle={`${todayEvents.length} compromissos agendados`} />
              <CardBody flush>
                {todayEvents.length === 0 ? (
                  <EmptyState
                    icon={<IconAgenda size={19} />}
                    title="Agenda livre"
                    description="Nenhum compromisso marcado para hoje."
                  />
                ) : (
                  <ul className={styles.slots}>
                    {todayEvents.map((ev) => (
                      <li className={styles.slot} key={ev.id}>
                        <span className={styles.time}>
                          <span className={styles.timeValue}>{formatTime(ev.startsAt)}</span>
                          {ev.endsAt ? <span className={styles.timeDuration}>até {formatTime(ev.endsAt)}</span> : null}
                        </span>
                        <span className={styles.slotText}>
                          <span className={styles.slotName}>{ev.title}</span>
                          <span className={styles.slotKind}>
                            {CALENDAR_EVENT_TYPE_LABELS[ev.type]}
                            {ev.leadName ? ` · ${ev.leadName}` : ''}
                          </span>
                        </span>
                        <span className={styles.slotMeta}>
                          <Badge tone={STATUS_TONE[ev.status]} dot>
                            {STATUS_LABEL[ev.status]}
                          </Badge>
                          {ev.status === 'SCHEDULED' ? (
                            <span className={styles.slotActions}>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={busyId === ev.id}
                                onClick={() => {
                                  setEditing(ev);
                                  setDrawerMode('edit');
                                }}
                              >
                                Editar
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={busyId === ev.id}
                                onClick={() => runAction(ev.id, () => completeCalendarEvent(ev.id))}
                              >
                                Concluir
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busyId === ev.id}
                                onClick={() => runAction(ev.id, () => cancelCalendarEvent(ev.id))}
                              >
                                Cancelar
                              </Button>
                            </span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          </div>
        ) : (
          <div
            role="tabpanel"
            id="agenda-panel-semana"
            aria-labelledby="agenda-tab-semana"
            className={styles.week}
          >
            {week.map((day) => (
              <section
                className={styles.day}
                key={dayKey(day.date)}
                aria-label={`${dayLabel(day.date, now)}, ${weekdayLabel(day.date)}`}
              >
                <header className={styles.dayHeader}>
                  <span className={styles.dayLabel}>{dayLabel(day.date, now)}</span>
                  <span className={styles.dayWeekday}>{weekdayLabel(day.date)}</span>
                </header>
                <div className={styles.dayBody}>
                  {day.events.length === 0 ? (
                    <p className={styles.dayEmpty}>Sem compromissos</p>
                  ) : (
                    day.events.map((ev) => (
                      <article className={styles.event} key={ev.id}>
                        <span className={styles.eventTime}>
                          {formatTime(ev.startsAt)}
                          {ev.endsAt ? ` · até ${formatTime(ev.endsAt)}` : ''}
                        </span>
                        <span className={styles.eventName}>{ev.title}</span>
                        <span className={styles.eventKind}>{CALENDAR_EVENT_TYPE_LABELS[ev.type]}</span>
                      </article>
                    ))
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      <CalendarEventDrawer
        open={drawerMode !== null}
        mode={drawerMode ?? 'create'}
        event={editing}
        onClose={() => {
          setDrawerMode(null);
          setEditing(null);
        }}
        onCreate={async (input) => {
          await createCalendarEvent(input);
          setDrawerMode(null);
          reload();
        }}
        onUpdate={async (id, input) => {
          await updateCalendarEvent(id, input);
          setDrawerMode(null);
          setEditing(null);
          reload();
        }}
      />
    </>
  );
}
