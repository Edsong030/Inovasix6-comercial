'use client';

import { useCallback, useMemo, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { CardBody } from '@/components/ui/Card';
import { Card } from '@/components/ui/Card';
import { EmptyState, ErrorState, Spinner } from '@/components/ui/States';
import { IconLeads, IconSearch } from '@/components/ui/icons';
import tableStyles from '@/components/ui/Table.module.css';
import { listLeads } from '@/lib/api/resources';
import type { LeadItem, LeadListResult, LeadStatus } from '@/lib/api/types';
import { useApiResource } from '@/lib/api/useApiResource';

const initials = (name: string) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

const brl = (cents: number | null) =>
  cents == null ? '—' : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const STATUS_FILTERS: Array<{ label: string; value: LeadStatus | 'ALL' }> = [
  { label: 'Todos', value: 'ALL' },
  { label: 'Aberto', value: 'OPEN' },
  { label: 'Ganho', value: 'WON' },
  { label: 'Perdido', value: 'LOST' },
];

const STATUS_TONE: Record<LeadStatus, BadgeTone> = {
  OPEN: 'info',
  WON: 'success',
  LOST: 'danger',
};

const STATUS_LABEL: Record<LeadStatus, string> = {
  OPEN: 'Aberto',
  WON: 'Ganho',
  LOST: 'Perdido',
};

/** Leads list backed by GET /api/leads. Search + status filter hit the API. */
export function LeadsTable() {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<LeadStatus | 'ALL'>('ALL');

  const fetcher = useCallback(
    (signal: AbortSignal): Promise<LeadListResult> =>
      listLeads(
        {
          search: query.trim() || undefined,
          status: status === 'ALL' ? undefined : status,
          pageSize: 100,
        },
        signal,
      ),
    [query, status],
  );

  const { data, state, error, reload } = useApiResource<LeadListResult>(fetcher, [query, status]);
  const rows: LeadItem[] = useMemo(() => data?.items ?? [], [data]);

  return (
    <Card ariaLabel="Lista de leads">
      <div className={tableStyles.toolbar}>
        <div className={tableStyles.toolbarSearch}>
          <label className="srOnly" htmlFor="leads-search">
            Buscar leads
          </label>
          <span className={tableStyles.toolbarSearchIcon} aria-hidden="true">
            <IconSearch size={15} />
          </span>
          <input
            id="leads-search"
            type="search"
            className={tableStyles.toolbarInput}
            placeholder="Buscar por nome ou interesse…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className={tableStyles.chips} role="group" aria-label="Filtrar por status">
          {STATUS_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${tableStyles.chip} ${status === option.value ? tableStyles.chipActive : ''}`}
              aria-pressed={status === option.value}
              onClick={() => setStatus(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {state === 'loading' ? (
        <CardBody>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center', padding: 24 }} role="status">
            <Spinner size={20} />
            <span>Carregando leads…</span>
          </div>
        </CardBody>
      ) : state === 'error' ? (
        <CardBody>
          <ErrorState
            title="Não foi possível carregar os leads"
            description={error ?? undefined}
            action={
              <Button variant="secondary" size="sm" onClick={reload}>
                Tentar novamente
              </Button>
            }
          />
        </CardBody>
      ) : rows.length === 0 ? (
        <CardBody>
          <EmptyState
            icon={<IconLeads size={19} />}
            title="Nenhum lead encontrado"
            description="Ajuste a busca ou o filtro de status, ou crie um lead pelo CRM."
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setQuery('');
                  setStatus('ALL');
                }}
              >
                Limpar filtros
              </Button>
            }
          />
        </CardBody>
      ) : (
        <div className={tableStyles.scroll}>
          <table className={tableStyles.table}>
            <caption className="srOnly">
              Leads da operação com origem, valor, responsável, status e última interação
            </caption>
            <thead>
              <tr>
                <th scope="col">Nome</th>
                <th scope="col">Origem</th>
                <th scope="col">Interesse</th>
                <th scope="col">Valor</th>
                <th scope="col">Responsável</th>
                <th scope="col">Status</th>
                <th scope="col">Última interação</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <span className={tableStyles.identity}>
                      <Avatar initials={initials(row.name)} size="sm" />
                      <span className={tableStyles.identityName}>{row.name}</span>
                    </span>
                  </td>
                  <td className={tableStyles.nowrap}>{row.source ?? '—'}</td>
                  <td>{row.interest ?? '—'}</td>
                  <td className={tableStyles.nowrap}>{brl(row.amountCents)}</td>
                  <td className={tableStyles.nowrap}>{row.ownerName ?? 'Não atribuído'}</td>
                  <td>
                    <Badge tone={STATUS_TONE[row.status]} dot>
                      {STATUS_LABEL[row.status]}
                    </Badge>
                  </td>
                  <td className={tableStyles.nowrap}>
                    {new Date(row.lastInteractionAt).toLocaleDateString('pt-BR')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className={tableStyles.footer}>
        <span>{rows.length} leads</span>
        <span>Dados reais do tenant atual.</span>
      </div>
    </Card>
  );
}
