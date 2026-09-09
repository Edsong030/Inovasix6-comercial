import type { Metadata } from 'next';
import { KnowledgeView } from '@/components/knowledge/KnowledgeView';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconPlus } from '@/components/ui/icons';

export const metadata: Metadata = { title: 'Base de IA · Inovasix6 Comercial IA' };

export default function KnowledgePage() {
  return (
    <>
      <PageHeader
        title="Base de IA"
        subtitle="O conhecimento que a inteligência artificial usa para atender seus leads."
        actions={
          <Button variant="primary">
            <IconPlus size={16} />
            Adicionar conhecimento
          </Button>
        }
      />
      <KnowledgeView />
    </>
  );
}
