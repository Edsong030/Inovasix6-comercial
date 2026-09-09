import type { Metadata } from 'next';
import { AgendaView } from '@/components/agenda/AgendaView';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconPlus } from '@/components/ui/icons';

export const metadata: Metadata = { title: 'Agenda · Inovasix6 Comercial IA' };

export default function AgendaPage() {
  return (
    <>
      <PageHeader
        title="Agenda"
        subtitle="Compromissos criados pela IA e pelo time comercial."
        actions={
          <Button variant="primary">
            <IconPlus size={16} />
            Novo compromisso
          </Button>
        }
      />
      <AgendaView />
    </>
  );
}
