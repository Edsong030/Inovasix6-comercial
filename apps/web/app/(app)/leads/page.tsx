import type { Metadata } from 'next';
import { PageHeader } from '@/components/layout/PageHeader';
import { LeadsTable } from '@/components/leads/LeadsTable';
import { Button } from '@/components/ui/Button';
import { IconPlus } from '@/components/ui/icons';

export const metadata: Metadata = { title: 'Leads · Inovasix6 Comercial IA' };

export default function LeadsPage() {
  return (
    <>
      <PageHeader
        title="Leads"
        subtitle="Base completa de contatos, com origem, responsável e próxima ação."
        actions={
          <Button variant="primary">
            <IconPlus size={16} />
            Novo lead
          </Button>
        }
      />
      <LeadsTable />
    </>
  );
}
