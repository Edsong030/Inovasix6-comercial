'use client';

import { useMemo, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/States';
import { IconFilter, IconLeads, IconSearch } from '@/components/ui/icons';
import tableStyles from '@/components/ui/Table.module.css';
import { LEAD_ROWS, LEAD_STATUS_FILTERS } from '@/lib/mock/data';

const initials = (name: string) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

/** Leads list. Filtering runs entirely over the mock array — no leads API yet. */
export function LeadsTable() {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('Todos');

  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    return LEAD_ROWS.filter((row) => {
      const matchesStatus = status === 'Todos' || row.status === status;
      const matchesTerm =
        !term ||
        row.name.toLowerCase().includes(term) ||
        row.interest.toLowerCase().includes(term) ||
        row.owner.toLowerCase().includes(term);
      return matchesStatus && matchesTerm;
    });
  }, [query, status]);

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
            placeholder="Buscar por nome, interesse ou responsável…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className={tableStyles.chips} role="group" aria-label="Filtrar por status">
          {LEAD_STATUS_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              className={`${tableStyles.chip} ${status === option ? tableStyles.chipActive : ''}`}
              aria-pressed={status === option}
              onClick={() => setStatus(option)}
            >
              {option}
            </button>
          ))}
        </div>

        <div className={tableStyles.toolbarSpacer}>
          <Button variant="ghost" size="sm">
            <IconFilter size={15} />
            Filtros
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <CardBody>
          <EmptyState
            icon={<IconLeads size={19} />}
            title="Nenhum lead encontrado"
            description="Ajuste a busca ou o filtro de status para ver outros resultados."
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setQuery('');
                  setStatus('Todos');
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
              Leads da operação com origem, interesse, responsável, status e próxima ação
            </caption>
            <thead>
              <tr>
                <th scope="col">Nome</th>
                <th scope="col">Origem</th>
                <th scope="col">Interesse</th>
                <th scope="col">Responsável</th>
                <th scope="col">Status</th>
                <th scope="col">Última interação</th>
                <th scope="col">Próxima ação</th>
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
                  <td className={tableStyles.nowrap}>{row.origin}</td>
                  <td>{row.interest}</td>
                  <td className={tableStyles.nowrap}>{row.owner}</td>
                  <td>
                    <Badge tone={row.statusTone} dot>
                      {row.status}
                    </Badge>
                  </td>
                  <td className={tableStyles.nowrap}>{row.lastInteraction}</td>
                  <td>{row.nextAction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className={tableStyles.footer}>
        <span>
          {rows.length} de {LEAD_ROWS.length} leads
        </span>
        <span>Dados de demonstração — backend de leads ainda não conectado.</span>
      </div>
    </Card>
  );
}
