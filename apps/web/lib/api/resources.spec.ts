jest.mock('@/lib/auth/api', () => ({ apiFetch: jest.fn() }));

import { apiFetch } from '@/lib/auth/api';
import { createCalendarEvent, createFollowUp, listFollowUps, rescheduleFollowUp } from './resources';

const mockedApiFetch = apiFetch as jest.Mock;

/**
 * Covers "submit de create" and "submit de reschedule": the request-shaping
 * functions the drawers call on submit. Confirms method, path, and body —
 * in particular that tenantId is never part of the payload (the backend
 * would reject it anyway via forbidNonWhitelisted, but the client should
 * never attempt to send it either).
 */
describe('follow-up create/reschedule request shape', () => {
  beforeEach(() => mockedApiFetch.mockReset());

  it('createFollowUp POSTs to /api/follow-ups with exactly the given payload', async () => {
    mockedApiFetch.mockResolvedValue({ id: 'fu-1' });
    await createFollowUp({ leadId: 'lead-1', title: 'X', scheduledAt: '2026-09-10T10:00:00.000Z' });

    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    const [path, options] = mockedApiFetch.mock.calls[0];
    expect(path).toBe('/api/follow-ups');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body);
    expect(body).toEqual({ leadId: 'lead-1', title: 'X', scheduledAt: '2026-09-10T10:00:00.000Z' });
    expect(body).not.toHaveProperty('tenantId');
  });

  it('rescheduleFollowUp PATCHes /api/follow-ups/:id/reschedule with { scheduledAt }', async () => {
    mockedApiFetch.mockResolvedValue({ id: 'fu-1' });
    await rescheduleFollowUp('fu-1', '2026-09-20T09:00:00.000Z');

    expect(mockedApiFetch).toHaveBeenCalledWith('/api/follow-ups/fu-1/reschedule', {
      method: 'PATCH',
      body: JSON.stringify({ scheduledAt: '2026-09-20T09:00:00.000Z' }),
    });
  });

  it('listFollowUps encodes the overdue shortcut and pageSize as query params', async () => {
    mockedApiFetch.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
    await listFollowUps({ overdue: true, pageSize: 50 });

    const [path] = mockedApiFetch.mock.calls[0];
    expect(path).toContain('overdue=true');
    expect(path).toContain('pageSize=50');
  });
});

describe('calendar event create request shape', () => {
  beforeEach(() => mockedApiFetch.mockReset());

  it('createCalendarEvent POSTs to /api/calendar/events with only the provided fields (no tenantId, no status)', async () => {
    mockedApiFetch.mockResolvedValue({ id: 'ev-1' });
    await createCalendarEvent({ title: 'Reunião', startsAt: '2026-09-10T10:00:00.000Z' });

    const [path, options] = mockedApiFetch.mock.calls[0];
    expect(path).toBe('/api/calendar/events');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ title: 'Reunião', startsAt: '2026-09-10T10:00:00.000Z' });
  });
});
