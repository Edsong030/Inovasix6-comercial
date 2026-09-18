'use client';

import { useCallback } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { ErrorState, Skeleton } from '@/components/ui/States';
import { ActivityCard } from '@/components/dashboard/ActivityCard';
import { AgendaCard } from '@/components/dashboard/AgendaCard';
import { AiInsightCard } from '@/components/dashboard/AiInsightCard';
import { Banner } from '@/components/dashboard/Banner';
import { FollowupsCard } from '@/components/dashboard/FollowupsCard';
import { FunnelCard } from '@/components/dashboard/FunnelCard';
import { MetricsGrid } from '@/components/dashboard/MetricsGrid';
import styles from '@/components/dashboard/Dashboard.module.css';
import {
  formatPercent,
  type ActivityVM,
  type FollowupVM,
  type FunnelStageVM,
  type MetricVM,
} from '@/components/dashboard/view-models';
import { greetingForHour } from '@/lib/auth/identity';
import { useAuth } from '@/lib/auth/auth-context';
import { getDashboardSummary } from '@/lib/api/resources';
import type { DashboardSummary } from '@/lib/api/types';
import { useApiResource } from '@/lib/api/useApiResource';

const brl = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

const METRIC_META: Array<{ id: string; label: string; accent: MetricVM['accent']; money?: boolean }> = [
  { id: 'newLeads', label: 'Novos leads', accent: 'blue' },
  { id: 'pipelineValue', label: 'Em oportunidades', accent: 'cyan', money: true },
  { id: 'scheduledMeetings', label: 'Reuniões agendadas', accent: 'violet' },
  { id: 'monthlySales', label: 'Vendas no mês', accent: 'magenta', money: true },
];

function toMetrics(s: DashboardSummary): MetricVM[] {
  const m = s.metrics;
  const raw: Record<string, number> = {
    newLeads: m.newLeads,
    pipelineValue: m.pipelineValue,
    scheduledMeetings: m.scheduledMeetings,
    monthlySales: m.monthlySales,
  };
  return METRIC_META.map((meta) => ({
    id: meta.id,
    label: meta.label,
    value: meta.money ? brl(raw[meta.id]) : String(raw[meta.id]),
    delta: `${formatPercent(m.conversionRate)} conversão`,
    trend: 'up',
    hint: '',
    accent: meta.accent,
  }));
}

const ACTIVITY_TYPE: Record<string, ActivityVM['type']> = {
  LEAD_CREATED: 'lead',
  LEAD_STAGE_CHANGED: 'negociacao',
  LEAD_UPDATED: 'proposta',
};

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.round(h / 24)} d`;
}

function toActivity(s: DashboardSummary): ActivityVM[] {
  return s.recentActivity.map((a) => ({
    id: a.id,
    title: labelForAction(a.action),
    detail: a.entity,
    time: relativeTime(a.time),
    type: ACTIVITY_TYPE[a.action] ?? 'atendimento',
  }));
}

function labelForAction(action: string): string {
  switch (action) {
    case 'LEAD_CREATED':
      return 'Novo lead criado';
    case 'LEAD_STAGE_CHANGED':
      return 'Lead movido de etapa';
    case 'LEAD_UPDATED':
      return 'Lead atualizado';
    default:
      return action;
  }
}

function toFollowups(s: DashboardSummary): FollowupVM[] {
  return s.followUpsToday.map((f) => ({
    id: f.id,
    time: f.time,
    name: f.name,
    company: f.company,
    reason: f.reason,
    statusLabel: 'Hoje',
    status: 'proximo',
  }));
}

function toFunnel(s: DashboardSummary): FunnelStageVM[] {
  return s.funnel.map((stage) => ({
    id: stage.id,
    label: stage.label,
    count: stage.count,
    percent: stage.percent,
  }));
}

export default function DashboardPage() {
  const { user } = useAuth();
  const firstName = user?.displayName.split(' ')[0] ?? 'bem-vindo';

  const fetcher = useCallback((signal: AbortSignal) => getDashboardSummary(signal), []);
  const { data, state, error, reload } = useApiResource<DashboardSummary>(fetcher);

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

      {state === 'ready' && data ? (
        <p className={styles.summaryLine}>
          Você tem{' '}
          <strong className={styles.sumLeads}>{data.metrics.newLeads} novos leads</strong>,{' '}
          <strong className={styles.sumFollowups}>
            {data.followUpsToday.length} follow-ups pendentes
          </strong>{' '}
          e{' '}
          <strong className={styles.sumMeetings}>
            {data.metrics.scheduledMeetings} reuniões
          </strong>{' '}
          hoje.
        </p>
      ) : null}

      {state === 'error' ? (
        <ErrorState
          title="Não foi possível carregar o painel"
          description={error ?? undefined}
          action={
            <Button variant="secondary" size="sm" onClick={reload}>
              Tentar novamente
            </Button>
          }
        />
      ) : null}

      {state === 'loading' ? (
        <div className={`${styles.grid} ${styles.metrics}`} aria-hidden="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} height={92} radius={13} />
          ))}
        </div>
      ) : null}

      {state === 'ready' && data ? (
        <>
          <MetricsGrid metrics={toMetrics(data)} />

          <div className={`${styles.grid} ${styles.columns}`}>
            <div className={styles.stack}>
              <FunnelCard
                stages={toFunnel(data)}
                conversion={{
                  rate: data.metrics.conversionRate,
                  deltaLabel: 'no mês atual',
                  opportunities: brl(data.metrics.pipelineValue),
                }}
              />
              <div className={`${styles.grid} ${styles.duo}`}>
                <FollowupsCard items={toFollowups(data)} />
                <AgendaCard entries={data.agendaToday.map((a) => ({
                  id: a.id,
                  time: a.time,
                  title: a.name,
                  kind: 'Compromisso',
                }))} />
              </div>
            </div>
            <div className={styles.stack}>
              <AiInsightCard />
              <ActivityCard entries={toActivity(data)} />
            </div>
          </div>

          <Banner />
        </>
      ) : null}
    </>
  );
}
