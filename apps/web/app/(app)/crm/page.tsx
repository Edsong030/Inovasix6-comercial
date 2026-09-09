import type { Metadata } from 'next';
import { CrmBoard } from '@/components/crm/CrmBoard';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconPlus } from '@/components/ui/icons';

export const metadata: Metadata = { title: 'CRM · Inovasix6 Comercial IA' };

export default function CrmPage() {
  return (
    <>
      <PageHeader
        title="CRM"
        subtitle="Acompanhe cada oportunidade da entrada do lead até o fechamento."
        actions={
          <Button variant="primary">
            <IconPlus size={16} />
            Nova oportunidade
          </Button>
        }
      />
      <CrmBoard />
    </>
  );
}
