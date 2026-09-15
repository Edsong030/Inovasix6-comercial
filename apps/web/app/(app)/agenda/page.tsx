import type { Metadata } from 'next';
import { AgendaView } from '@/components/agenda/AgendaView';
import { PageHeader } from '@/components/layout/PageHeader';

export const metadata: Metadata = { title: 'Agenda · Inovasix6 Comercial IA' };

export default function AgendaPage() {
  return (
    <>
      <PageHeader
        title="Agenda"
        subtitle="Compromissos criados pela IA e pelo time comercial."
      />
      <AgendaView />
    </>
  );
}
