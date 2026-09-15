import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/States';
import { IconAgenda, IconVideo } from '@/components/ui/icons';
import type { AgendaVM } from './view-models';
import styles from './Dashboard.module.css';

/** Left rail colour per meeting platform (mockup: Meet blue, Teams violet, Zoom cyan). */
const PLATFORM_TONE: Record<NonNullable<AgendaVM['platform']>, string> = {
  meet: styles.agMeet,
  teams: styles.agTeams,
  zoom: styles.agZoom,
};

export function AgendaCard({ entries }: { entries: AgendaVM[] }) {
  return (
    <Card ariaLabel="Agenda de hoje">
      <CardHeader
        title="Agenda de hoje"
        actions={
          <Link href="/agenda">
            <Button variant="ghost" size="sm">
              Ver agenda
            </Button>
          </Link>
        }
      />
      <CardBody flush>
        {entries.length === 0 ? (
          <EmptyState
            icon={<IconAgenda size={19} />}
            title="Agenda livre"
            description="Nenhum compromisso marcado para hoje."
          />
        ) : (
          <ul className={styles.list}>
            {entries.map((entry) => (
              <li className={styles.agRow} key={entry.id}>
                <span
                  className={`${styles.agRail} ${entry.platform ? PLATFORM_TONE[entry.platform] : ''}`}
                  aria-hidden="true"
                />
                <span className={styles.agTime}>
                  {entry.time}
                  {entry.endTime ? ` - ${entry.endTime}` : ''}
                </span>
                <span className={styles.rowText}>
                  <span className={styles.rowTitle}>{entry.title}</span>
                  <span className={styles.agPlatform}>
                    <IconVideo size={13} />
                    {entry.kind}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
