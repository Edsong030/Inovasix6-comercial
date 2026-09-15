import type { Metadata } from 'next';
import { CrmBoard } from '@/components/crm/CrmBoard';
import { PageHeader } from '@/components/layout/PageHeader';

export const metadata: Metadata = { title: 'CRM · Inovasix6 Comercial IA' };

export default function CrmPage() {
  return (
    <>
      <PageHeader
        title="CRM"
        subtitle="Acompanhe cada oportunidade da entrada do lead até o fechamento."
      />
      <CrmBoard />
    </>
  );
}
