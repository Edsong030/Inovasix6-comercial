import type { Metadata } from 'next';
import { FollowupsView } from '@/components/followups/FollowupsView';
import { PageHeader } from '@/components/layout/PageHeader';

export const metadata: Metadata = { title: 'Follow-ups · Inovasix6 Comercial IA' };

export default function FollowupsPage() {
  return (
    <>
      <PageHeader
        title="Follow-ups"
        subtitle="Retomadas automáticas e manuais para não perder nenhuma oportunidade."
      />
      <FollowupsView />
    </>
  );
}
