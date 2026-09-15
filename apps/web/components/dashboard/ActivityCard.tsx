import Link from 'next/link';
import type { ComponentType } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/States';
import {
  IconAgenda,
  IconDocument,
  IconLeads,
  IconMessage,
  IconSparkles,
  IconTrend,
  type IconProps,
} from '@/components/ui/icons';
import type { ActivityVM, ActivityType } from './view-models';
import styles from './Dashboard.module.css';

/** Icon + colour tone per activity type (matches the approved mockup). */
const ACTIVITY_VISUAL: Record<ActivityType, { icon: ComponentType<IconProps>; tone: string }> = {
  atendimento: { icon: IconMessage, tone: 'cyan' },
  lead: { icon: IconLeads, tone: 'blue' },
  agenda: { icon: IconAgenda, tone: 'magenta' },
  proposta: { icon: IconDocument, tone: 'violet' },
  negociacao: { icon: IconTrend, tone: 'amber' },
};

export function ActivityCard({ entries }: { entries: ActivityVM[] }) {
  return (
    <Card ariaLabel="Atividade recente">
      <CardHeader
        title="Atividade recente"
        actions={
          <Link href="/inbox">
            <Button variant="ghost" size="sm">
              Ver todas
            </Button>
          </Link>
        }
      />
      <CardBody flush>
        {entries.length === 0 ? (
          <EmptyState
            icon={<IconSparkles size={19} />}
            title="Nenhuma atividade ainda"
            description="Assim que as conversas começarem, os eventos aparecem aqui."
          />
        ) : (
          <ul className={styles.list}>
            {entries.map((entry) => {
              const visual = ACTIVITY_VISUAL[entry.type];
              const Icon = visual.icon;
              return (
                <li className={styles.row} key={entry.id}>
                  <span
                    className={styles.activityIcon}
                    data-tone={visual.tone}
                    aria-hidden="true"
                  >
                    <Icon size={16} />
                  </span>
                  <span className={styles.rowText}>
                    <span className={styles.rowTitle}>{entry.title}</span>
                    <span className={styles.rowSubtitle}>{entry.detail}</span>
                  </span>
                  <span className={styles.rowMeta}>{entry.time}</span>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
