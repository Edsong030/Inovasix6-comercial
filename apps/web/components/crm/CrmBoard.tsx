'use client';

import { useCallback, useMemo, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorState, Spinner } from '@/components/ui/States';
import { IconPlus } from '@/components/ui/icons';
import { createLead, listLeads, listPipelines, moveLeadStage } from '@/lib/api/resources';
import type { LeadItem, PipelineView } from '@/lib/api/types';
import { useApiResource } from '@/lib/api/useApiResource';
import { NewLeadDrawer } from './NewLeadDrawer';
import styles from './Crm.module.css';

const initials = (name: string) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

const brl = (cents: number | null) =>
  cents == null
    ? '—'
    : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

interface BoardData {
  pipelines: PipelineView[];
  leads: LeadItem[];
}

export function CrmBoard() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [movingId, setMovingId] = useState<string | null>(null);

  const fetcher = useCallback(async (signal: AbortSignal): Promise<BoardData> => {
    const [pipelines, leadResult] = await Promise.all([
      listPipelines(signal),
      listLeads({ pageSize: 100 }, signal),
    ]);
    return { pipelines, leads: leadResult.items };
  }, []);

  const { data, state, error, reload } = useApiResource<BoardData>(fetcher);

  const stages = useMemo(() => {
    const def = data?.pipelines.find((p) => p.isDefault) ?? data?.pipelines[0];
    return def?.stages ?? [];
  }, [data]);

  const leadsByStage = useMemo(() => {
    const map = new Map<string, LeadItem[]>();
    for (const lead of data?.leads ?? []) {
      const list = map.get(lead.stageId) ?? [];
      list.push(lead);
      map.set(lead.stageId, list);
    }
    return map;
  }, [data]);

  const handleMove = useCallback(
    async (lead: LeadItem, direction: 1 | -1) => {
      const idx = stages.findIndex((s) => s.id === lead.stageId);
      const target = stages[idx + direction];
      if (!target) return;
      setMovingId(lead.id);
      try {
        await moveLeadStage(lead.id, target.id);
        reload();
      } finally {
        setMovingId(null);
      }
    },
    [stages, reload],
  );

  if (state === 'loading') {
    return (
      <div className={styles.loading} role="status">
        <Spinner size={22} />
        <span>Carregando funil…</span>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <ErrorState
        title="Não foi possível carregar o CRM"
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
        <Button variant="primary" onClick={() => setDrawerOpen(true)}>
          <IconPlus size={16} />
          Novo lead
        </Button>
      </div>

      <div className={styles.board} aria-label="Funil de vendas por etapa" role="group">
        {stages.map((stage) => {
          const cards = leadsByStage.get(stage.id) ?? [];
          return (
            <section className={styles.column} key={stage.id} aria-label={stage.name}>
              <header className={styles.columnHeader}>
                <h2 className={styles.columnTitle}>
                  <Badge tone="neutral">{stage.name}</Badge>
                </h2>
                <span className={styles.count}>{cards.length}</span>
              </header>
              <div className={styles.columnBody}>
                {cards.length === 0 ? (
                  <p className={styles.emptyColumn}>Nenhum lead nesta etapa</p>
                ) : (
                  cards.map((card) => (
                    <article className={styles.card} key={card.id}>
                      <div className={styles.cardTop}>
                        <div>
                          <p className={styles.cardName}>{card.name}</p>
                          <p className={styles.cardCompany}>{card.company ?? card.interest ?? '—'}</p>
                        </div>
                        {card.source ? <Badge tone="neutral">{card.source}</Badge> : null}
                      </div>
                      <p className={styles.cardValue}>{brl(card.amountCents)}</p>
                      <div className={styles.cardFoot}>
                        <span className={styles.owner}>
                          <Avatar initials={initials(card.ownerName ?? card.name)} size="sm" />
                          <span className={styles.ownerName}>{card.ownerName ?? 'Não atribuído'}</span>
                        </span>
                        <span className={styles.moveButtons}>
                          <button
                            type="button"
                            className={styles.moveBtn}
                            aria-label={`Mover ${card.name} para a etapa anterior`}
                            disabled={movingId === card.id || stages[0]?.id === card.stageId}
                            onClick={() => handleMove(card, -1)}
                          >
                            ‹
                          </button>
                          <button
                            type="button"
                            className={styles.moveBtn}
                            aria-label={`Mover ${card.name} para a próxima etapa`}
                            disabled={
                              movingId === card.id || stages[stages.length - 1]?.id === card.stageId
                            }
                            onClick={() => handleMove(card, 1)}
                          >
                            ›
                          </button>
                        </span>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>

      <NewLeadDrawer
        open={drawerOpen}
        stages={stages}
        onClose={() => setDrawerOpen(false)}
        onCreate={async (input) => {
          await createLead(input);
          setDrawerOpen(false);
          reload();
        }}
      />
    </>
  );
}
