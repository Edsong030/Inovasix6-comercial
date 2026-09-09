import type { Metadata } from 'next';
import { PageHeader } from '@/components/layout/PageHeader';
import { SettingsView } from '@/components/settings/SettingsView';

export const metadata: Metadata = { title: 'Configurações · Inovasix6 Comercial IA' };

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Configurações"
        subtitle="Ajustes da empresa, do atendimento e das integrações."
      />
      <SettingsView />
    </>
  );
}
