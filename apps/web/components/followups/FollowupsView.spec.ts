import { followupTabParams, statusBadge } from './FollowupsView';
import type { FollowUpItem } from '@/lib/api/types';

function makeItem(overrides: Partial<FollowUpItem>): FollowUpItem {
  return {
    id: 'fu-1',
    leadId: 'lead-1',
    leadName: 'Cliente',
    leadCompany: null,
    ownerUserId: null,
    ownerName: null,
    title: 'Título',
    description: null,
    type: 'OTHER',
    priority: 'MEDIUM',
    status: 'PENDING',
    scheduledAt: '2026-09-10T10:00:00.000Z',
    completedAt: null,
    canceledAt: null,
    overdue: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('statusBadge (tab/status mapping)', () => {
  it('COMPLETED renders success/"Concluído" regardless of overdue', () => {
    expect(statusBadge(makeItem({ status: 'COMPLETED', overdue: true }))).toEqual({
      tone: 'success',
      label: 'Concluído',
    });
  });

  it('CANCELED renders danger/"Cancelado"', () => {
    expect(statusBadge(makeItem({ status: 'CANCELED' }))).toEqual({ tone: 'danger', label: 'Cancelado' });
  });

  it('PENDING + overdue renders warning/"Atrasado"', () => {
    expect(statusBadge(makeItem({ status: 'PENDING', overdue: true }))).toEqual({
      tone: 'warning',
      label: 'Atrasado',
    });
  });

  it('PENDING + not overdue renders neutral/"Agendado"', () => {
    expect(statusBadge(makeItem({ status: 'PENDING', overdue: false }))).toEqual({
      tone: 'neutral',
      label: 'Agendado',
    });
  });
});

describe('followupTabParams (tab -> API filter mapping)', () => {
  const NOW = '2026-09-09T12:00:00.000Z';

  it('"ativos" maps to the overdue shortcut, ignoring status/from', () => {
    expect(followupTabParams('ativos', NOW)).toEqual({ overdue: true, pageSize: 50 });
  });

  it('"agendados" maps to status=PENDING with from=now (server-filtered future)', () => {
    expect(followupTabParams('agendados', NOW)).toEqual({ status: 'PENDING', from: NOW, pageSize: 50 });
  });

  it('"concluidos" maps to status=COMPLETED', () => {
    expect(followupTabParams('concluidos', NOW)).toEqual({ status: 'COMPLETED', pageSize: 50 });
  });
});
