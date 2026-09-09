'use client';

import { useState } from 'react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/States';
import { IconAgenda } from '@/components/ui/icons';
import tableStyles from '@/components/ui/Table.module.css';
import { AGENDA_TODAY, AGENDA_WEEK, type AgendaSlot } from '@/lib/mock/data';
import styles from './Agenda.module.css';

const STATUS_TONE: Record<AgendaSlot['status'], BadgeTone> = {
  Confirmado: 'success',
  Pendente: 'warning',
  Reagendado: 'info',
};

type View = 'hoje' | 'semana';

export function AgendaView() {
  const [view, setView] = useState<View>('hoje');

  return (
    <>
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
              <CardHeader
                title="Hoje"
                subtitle={`${AGENDA_TODAY.length} compromissos agendados`}
              />
              <CardBody flush>
                {AGENDA_TODAY.length === 0 ? (
                  <EmptyState
                    icon={<IconAgenda size={19} />}
                    title="Agenda livre"
                    description="Nenhum compromisso marcado para hoje."
                  />
                ) : (
                  <ul className={styles.slots}>
                    {AGENDA_TODAY.map((slot) => (
                      <li className={styles.slot} key={slot.id}>
                        <span className={styles.time}>
                          <span className={styles.timeValue}>{slot.time}</span>
                          <span className={styles.timeDuration}>{slot.duration}</span>
                        </span>
                        <span className={styles.slotText}>
                          <span className={styles.slotName}>{slot.name}</span>
                          <span className={styles.slotKind}>{slot.kind}</span>
                        </span>
                        <span className={styles.slotMeta}>
                          <span className={styles.owner}>{slot.owner}</span>
                          <Badge tone={STATUS_TONE[slot.status]} dot>
                            {slot.status}
                          </Badge>
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
            {AGENDA_WEEK.map((day) => (
              <section className={styles.day} key={day.id} aria-label={`${day.label}, ${day.weekday}`}>
                <header className={styles.dayHeader}>
                  <span className={styles.dayLabel}>{day.label}</span>
                  <span className={styles.dayWeekday}>{day.weekday}</span>
                </header>
                <div className={styles.dayBody}>
                  {day.slots.length === 0 ? (
                    <p className={styles.dayEmpty}>Sem compromissos</p>
                  ) : (
                    day.slots.map((slot) => (
                      <article className={styles.event} key={slot.id}>
                        <span className={styles.eventTime}>
                          {slot.time} · {slot.duration}
                        </span>
                        <span className={styles.eventName}>{slot.name}</span>
                        <span className={styles.eventKind}>{slot.kind}</span>
                      </article>
                    ))
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
