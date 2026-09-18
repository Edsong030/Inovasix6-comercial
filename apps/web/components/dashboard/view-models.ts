/**
 * Presentational view-models for the dashboard cards. Kept separate from the
 * API DTOs so the cards stay purely visual: the dashboard page maps the API
 * response (lib/api/types) into these shapes. No mock data involved.
 */

export type MetricAccent = 'blue' | 'cyan' | 'violet' | 'magenta';

export interface MetricVM {
  id: string;
  label: string;
  value: string;
  delta: string;
  trend: 'up' | 'down' | 'flat';
  hint: string;
  accent: MetricAccent;
}

export interface FunnelStageVM {
  id: string;
  label: string;
  count: number;
  percent: number;
}

export type ActivityType = 'atendimento' | 'lead' | 'agenda' | 'proposta' | 'negociacao';

export interface ActivityVM {
  id: string;
  title: string;
  detail: string;
  time: string;
  type: ActivityType;
}

export type FollowupStatus = 'atrasado' | 'proximo' | 'agendado';

export interface FollowupVM {
  id: string;
  time: string;
  name: string;
  company: string | null;
  reason: string;
  statusLabel: string;
  status: FollowupStatus;
}

export interface AgendaVM {
  id: string;
  time: string;
  endTime?: string;
  title: string;
  platform?: 'meet' | 'teams' | 'zoom';
  kind: string;
}

export interface FunnelConversionVM {
  rate: number;
  deltaLabel: string;
  opportunities: string;
}

/** Renders a percentage with at most one decimal place, e.g. 14.285714 -> "14.3%", 20 -> "20%". */
export function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}
