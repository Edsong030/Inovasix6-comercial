import type { Metadata } from 'next';
import { FollowupsView } from '@/components/followups/FollowupsView';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconPlus } from '@/components/ui/icons';

export const metadata: Metadata = { title: 'Follow-ups · Inovasix6 Comercial IA' };

export default function FollowupsPage() {
  return (
    <>
      <PageHeader
        title="Follow-ups"
        subtitle="Retomadas automáticas e manuais para não perder nenhuma oportunidade."
        actions={
          <Button variant="primary">
            <IconPlus size={16} />
            Novo follow-up
          </Button>
        }
      />
      <FollowupsView />
    </>
  );
}
