'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { ActivityCard } from '@/components/dashboard/ActivityCard';
import { AgendaCard } from '@/components/dashboard/AgendaCard';
import { AiInsightCard } from '@/components/dashboard/AiInsightCard';
import { Banner } from '@/components/dashboard/Banner';
import { FollowupsCard } from '@/components/dashboard/FollowupsCard';
import { FunnelCard } from '@/components/dashboard/FunnelCard';
import { MetricsGrid } from '@/components/dashboard/MetricsGrid';
import styles from '@/components/dashboard/Dashboard.module.css';
import { greetingForHour } from '@/lib/auth/identity';
import { useAuth } from '@/lib/auth/auth-context';
import {
  DASHBOARD_METRICS,
  DASHBOARD_SUMMARY,
  FUNNEL_STAGES,
  RECENT_ACTIVITY,
  TODAY_AGENDA,
  TODAY_FOLLOWUPS,
} from '@/lib/mock/data';

export default function DashboardPage() {
  const { user } = useAuth();
  // Only the greeting is real (session + clock); every figure below is mocked.
  const firstName = user?.displayName.split(' ')[0] ?? 'bem-vindo';

  return (
    <>
      <PageHeader
        title={
          <>
            {greetingForHour(new Date().getHours())},{' '}
            <span className="brandGradientText">{firstName}.</span> 👋
          </>
        }
        subtitle="Atendimento, vendas e inteligência comercial em um só lugar."
      />

      <p className={styles.summaryLine}>
        Você tem <strong className={styles.sumLeads}>{DASHBOARD_SUMMARY.leads} novos leads</strong>,{' '}
        <strong className={styles.sumFollowups}>{DASHBOARD_SUMMARY.followups} follow-ups pendentes</strong>{' '}
        e <strong className={styles.sumMeetings}>{DASHBOARD_SUMMARY.meetings} reuniões</strong> hoje.
      </p>

      <MetricsGrid metrics={DASHBOARD_METRICS} />

      <div className={`${styles.grid} ${styles.columns}`}>
        <div className={styles.stack}>
          <FunnelCard stages={FUNNEL_STAGES} />
          <div className={`${styles.grid} ${styles.duo}`}>
            <FollowupsCard items={TODAY_FOLLOWUPS} />
            <AgendaCard entries={TODAY_AGENDA} />
          </div>
        </div>
        <div className={styles.stack}>
          <AiInsightCard />
          <ActivityCard entries={RECENT_ACTIVITY} />
        </div>
      </div>

      <Banner />
    </>
  );
}
