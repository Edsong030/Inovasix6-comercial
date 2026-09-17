jest.mock('@/lib/auth/api', () => ({ apiFetch: jest.fn() }));

import { apiFetch } from '@/lib/auth/api';
import {
  assignConversation,
  changeConversationState,
  createCalendarEvent,
  createFollowUp,
  listConversations,
  listFollowUps,
  listMessages,
  rescheduleFollowUp,
  sendMessage,
  unassignConversation,
} from './resources';

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

describe('Conversations/Messages request shape (STEP 3 — real Inbox API)', () => {
  beforeEach(() => mockedApiFetch.mockReset());

  it('listConversations encodes search/state/pageSize as query params', async () => {
    mockedApiFetch.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
    await listConversations({ search: 'maria', state: 'AGUARDANDO_HUMANO', pageSize: 50 });

    const [path] = mockedApiFetch.mock.calls[0];
    expect(path).toContain('/api/conversations?');
    expect(path).toContain('search=maria');
    expect(path).toContain('state=AGUARDANDO_HUMANO');
    expect(path).toContain('pageSize=50');
  });

  it('listMessages GETs /api/conversations/:id/messages with the cursor/limit params', async () => {
    mockedApiFetch.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
    await listMessages('conv-1', { before: 'msg-9', limit: 20 });

    const [path] = mockedApiFetch.mock.calls[0];
    expect(path).toBe('/api/conversations/conv-1/messages?before=msg-9&limit=20');
  });

  it('sendMessage POSTs only { body } — never a client-chosen sender/direction/tenantId', async () => {
    mockedApiFetch.mockResolvedValue({ id: 'msg-1' });
    await sendMessage('conv-1', 'Olá!');

    expect(mockedApiFetch).toHaveBeenCalledWith('/api/conversations/conv-1/messages', {
      method: 'POST',
      body: JSON.stringify({ body: 'Olá!' }),
    });
  });

  it('assignConversation PATCHes /assign with { userId }', async () => {
    mockedApiFetch.mockResolvedValue({ id: 'conv-1' });
    await assignConversation('conv-1', 'user-9');

    expect(mockedApiFetch).toHaveBeenCalledWith('/api/conversations/conv-1/assign', {
      method: 'PATCH',
      body: JSON.stringify({ userId: 'user-9' }),
    });
  });

  it('unassignConversation PATCHes /unassign with no body', async () => {
    mockedApiFetch.mockResolvedValue({ id: 'conv-1' });
    await unassignConversation('conv-1');

    expect(mockedApiFetch).toHaveBeenCalledWith('/api/conversations/conv-1/unassign', { method: 'PATCH' });
  });

  it('changeConversationState PATCHes /state with { state }', async () => {
    mockedApiFetch.mockResolvedValue({ id: 'conv-1' });
    await changeConversationState('conv-1', 'ENCERRADA');

    expect(mockedApiFetch).toHaveBeenCalledWith('/api/conversations/conv-1/state', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'ENCERRADA' }),
    });
  });
});
