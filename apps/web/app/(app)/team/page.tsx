import type { Metadata } from 'next';
import { PageHeader } from '@/components/layout/PageHeader';
import { TeamView } from '@/components/team/TeamView';
import { Button } from '@/components/ui/Button';
import { IconPlus } from '@/components/ui/icons';

export const metadata: Metadata = { title: 'Equipe · Inovasix6 Comercial IA' };

export default function TeamPage() {
  return (
    <>
      <PageHeader
        title="Equipe"
        subtitle="Quem tem acesso à operação e com qual nível de permissão."
        actions={
          <Button variant="primary">
            <IconPlus size={16} />
            Convidar usuário
          </Button>
        }
      />
      <TeamView />
    </>
  );
}
