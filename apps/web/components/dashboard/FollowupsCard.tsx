import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/States';
import { IconCheck } from '@/components/ui/icons';
import type { FollowupStatus, FollowupVM } from './view-models';
import styles from './Dashboard.module.css';

const STATUS_CLASS: Record<FollowupStatus, string> = {
  atrasado: styles.fuLate,
  proximo: styles.fuSoon,
  agendado: styles.fuScheduled,
};

export function FollowupsCard({ items }: { items: FollowupVM[] }) {
  return (
    <Card ariaLabel="Follow-ups de hoje">
      <CardHeader
        title="Follow-ups de hoje"
        actions={
          <Link href="/followups">
            <Button variant="ghost" size="sm">
              Ver todos
            </Button>
          </Link>
        }
      />
      <CardBody flush>
        {items.length === 0 ? (
          <EmptyState
            icon={<IconCheck size={19} />}
            title="Nada pendente para hoje"
            description="Todos os follow-ups do dia foram concluídos."
          />
        ) : (
          <ul className={styles.list}>
            {items.map((item) => (
              <li className={styles.fuRow} key={item.id}>
                <span className={styles.fuCheck} aria-hidden="true">
                  <IconCheck size={13} />
                </span>
                <span className={styles.timeChip}>{item.time}</span>
                <span className={styles.rowText}>
                  <span className={styles.rowTitle}>
                    {item.name} · <span className={styles.fuCompany}>{item.company}</span>
                  </span>
                  <span className={styles.rowSubtitle}>{item.reason}</span>
                </span>
                <span className={`${styles.fuStatus} ${STATUS_CLASS[item.status]}`}>
                  {item.statusLabel}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
