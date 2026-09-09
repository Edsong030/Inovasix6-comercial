import type { Metadata } from 'next';
import { InboxView } from '@/components/inbox/InboxView';
import { PageHeader } from '@/components/layout/PageHeader';

export const metadata: Metadata = { title: 'Inbox · Inovasix6 Comercial IA' };

export default function InboxPage() {
  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle="Todas as conversas do WhatsApp, com IA e time humano no mesmo fluxo."
      />
      <InboxView />
    </>
  );
}
