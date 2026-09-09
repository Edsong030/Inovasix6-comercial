'use client';

import { Avatar } from '@/components/ui/Avatar';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import tableStyles from '@/components/ui/Table.module.css';
import { TEAM_MEMBERS, type TeamMember } from '@/lib/mock/data';

const STATUS_TONE: Record<TeamMember['status'], BadgeTone> = {
  Ativo: 'success',
  Convidado: 'warning',
  Suspenso: 'danger',
};

/**
 * Team list. Mocked — there is no users endpoint yet, and role changes would
 * need the backend's tenant-scoped authorization anyway.
 */
export function TeamView() {
  return (
    <Card ariaLabel="Membros da equipe">
      <div className={tableStyles.scroll}>
        <table className={tableStyles.table}>
          <caption className="srOnly">
            Usuários da empresa com e-mail, papel, situação e último acesso
          </caption>
          <thead>
            <tr>
              <th scope="col">Nome</th>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col">Último acesso</th>
            </tr>
          </thead>
          <tbody>
            {TEAM_MEMBERS.map((member) => (
              <tr key={member.id}>
                <td>
                  <span className={tableStyles.identity}>
                    <Avatar initials={member.initials} size="sm" />
                    <span className={tableStyles.identityName}>{member.name}</span>
                  </span>
                </td>
                <td className={tableStyles.nowrap}>{member.email}</td>
                <td className={tableStyles.nowrap}>{member.role}</td>
                <td>
                  <Badge tone={STATUS_TONE[member.status]} dot>
                    {member.status}
                  </Badge>
                </td>
                <td className={tableStyles.nowrap}>{member.lastAccess}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={tableStyles.footer}>
        <span>{TEAM_MEMBERS.length} membros</span>
        <span>Dados de demonstração — gestão de usuários ainda não conectada.</span>
      </div>
    </Card>
  );
}
