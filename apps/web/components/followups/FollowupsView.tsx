'use client';

import { useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/States';
import { IconCheck } from '@/components/ui/icons';
import tableStyles from '@/components/ui/Table.module.css';
import { FOLLOWUPS, type FollowupTab } from '@/lib/mock/data';

const TABS: { id: FollowupTab; label: string }[] = [
  { id: 'ativos', label: 'Ativos' },
  { id: 'agendados', label: 'Agendados' },
  { id: 'concluidos', label: 'Concluídos' },
];

const initials = (name: string) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

/** Follow-up queues. Mocked — the follow-up engine has no API surface yet. */
export function FollowupsView() {
  const [tab, setTab] = useState<FollowupTab>('ativos');
  const rows = FOLLOWUPS[tab];

  return (
    <>
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
            {item.label} ({FOLLOWUPS[item.id].length})
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
                  Follow-ups com motivo, canal, responsável, prazo e situação
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Lead</th>
                    <th scope="col">Motivo</th>
                    <th scope="col">Canal</th>
                    <th scope="col">Responsável</th>
                    <th scope="col">Prazo</th>
                    <th scope="col">Status</th>
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
                      <td>{row.reason}</td>
                      <td className={tableStyles.nowrap}>{row.channel}</td>
                      <td className={tableStyles.nowrap}>{row.owner}</td>
                      <td className={tableStyles.nowrap}>{row.due}</td>
                      <td>
                        <Badge tone={row.statusTone} dot>
                          {row.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className={tableStyles.footer}>
            <span>{rows.length} follow-ups</span>
            <span>Dados de demonstração — motor de follow-up ainda não conectado.</span>
          </div>
        </Card>
      </div>
    </>
  );
}
