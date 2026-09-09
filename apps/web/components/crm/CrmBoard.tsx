'use client';

import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { CRM_COLUMNS } from '@/lib/mock/data';
import styles from './Crm.module.css';

const initials = (name: string) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

/**
 * Kanban board. Read-only: there is no pipeline backend yet, so cards are not
 * draggable and nothing persists.
 */
export function CrmBoard() {
  return (
    <>
      <div className={styles.board} aria-label="Funil de vendas por etapa" role="group">
        {CRM_COLUMNS.map((column) => (
          <section className={styles.column} key={column.id} aria-label={column.label}>
            <header className={styles.columnHeader}>
              <h2 className={styles.columnTitle}>
                <Badge tone={column.tone} dot>
                  {column.label}
                </Badge>
              </h2>
              <span className={styles.count}>{column.cards.length}</span>
            </header>
            <div className={styles.columnBody}>
              {column.cards.length === 0 ? (
                <p className={styles.emptyColumn}>Nenhum lead nesta etapa</p>
              ) : (
                column.cards.map((card) => (
                  <article className={styles.card} key={card.id}>
                    <div className={styles.cardTop}>
                      <div>
                        <p className={styles.cardName}>{card.name}</p>
                        <p className={styles.cardCompany}>{card.company}</p>
                      </div>
                      <Badge tone="neutral">{card.channel}</Badge>
                    </div>
                    <p className={styles.cardValue}>{card.value}</p>
                    <div className={styles.cardFoot}>
                      <span className={styles.owner}>
                        <Avatar initials={initials(card.owner)} size="sm" />
                        <span className={styles.ownerName}>{card.owner}</span>
                      </span>
                      <span>{card.age}</span>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
        ))}
      </div>
      <p className={styles.note}>
        Visualização somente leitura nesta versão — arrastar cards e persistir etapas
        depende do backend de pipelines.
      </p>
    </>
  );
}
