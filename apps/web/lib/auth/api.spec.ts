import { apiFetch, GENERIC_CREDENTIALS_ERROR } from './api';

/**
 * Covers the "tratamento de erro" requirement: a 409 status-transition
 * conflict (or any other non-auth 4xx) must reach the UI with the backend's
 * own message, not a generic string — this is what makes FollowupsView's/
 * AgendaView's actionError readable ("Evento concluído não pode ser
 * cancelado.") instead of "algo deu errado".
 */
function mockFetchOnce(status: number, body: unknown): void {
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

describe('apiFetch error message surfacing', () => {
  afterEach(() => jest.restoreAllMocks());

  it('surfaces the backend ConflictException message verbatim for a 409', async () => {
    mockFetchOnce(409, { statusCode: 409, message: 'Evento concluído não pode ser cancelado.', error: 'Conflict' });
    await expect(
      apiFetch('/api/calendar/events/x/cancel', { method: 'PATCH' }, { retryOnUnauthorized: false }),
    ).rejects.toThrow('Evento concluído não pode ser cancelado.');
  });

  it('joins a class-validator array message into one string for a 400', async () => {
    mockFetchOnce(400, {
      statusCode: 400,
      message: ['title should not be empty', 'scheduledAt must be a valid ISO 8601 date string'],
      error: 'Bad Request',
    });
    await expect(apiFetch('/api/follow-ups', { method: 'POST' }, { retryOnUnauthorized: false })).rejects.toThrow(
      'title should not be empty scheduledAt must be a valid ISO 8601 date string',
    );
  });

  it('keeps the generic message for 401 — never leaks backend detail (anti-enumeration)', async () => {
    mockFetchOnce(401, { statusCode: 401, message: 'Unauthorized' });
    await expect(apiFetch('/api/follow-ups', { method: 'GET' }, { retryOnUnauthorized: false })).rejects.toThrow(
      GENERIC_CREDENTIALS_ERROR,
    );
  });

  it('falls back to the generic message when the body has no usable message field', async () => {
    mockFetchOnce(500, {});
    await expect(apiFetch('/api/follow-ups', { method: 'GET' }, { retryOnUnauthorized: false })).rejects.toThrow(
      'Não foi possível concluir a operação. Tente novamente.',
    );
  });
});

/**
 * DEMO_MODE gating (Inbox-on-GitHub-Pages work): `DEMO_MODE` is read once at
 * module load from NEXT_PUBLIC_DEMO_MODE, so each case here needs a FRESH
 * module instance (jest.resetModules + require) loaded under its own env var
 * value — a static import can't be re-evaluated with a different env.
 */
describe('DEMO_MODE gating — rawRequest routes to the demo layer only when NEXT_PUBLIC_DEMO_MODE=true', () => {
  const originalEnv = process.env.NEXT_PUBLIC_DEMO_MODE;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NEXT_PUBLIC_DEMO_MODE;
    else process.env.NEXT_PUBLIC_DEMO_MODE = originalEnv;
    jest.resetModules();
  });

  it('DEMO_MODE=false (default): the real API path is unchanged — apiFetch reaches the network via fetch', async () => {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    jest.resetModules();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ items: [] }) });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./api') as typeof import('./api');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const demo = require('../demo/api') as typeof import('../demo/api');
    expect(demo.DEMO_MODE).toBe(false);
    await mod.apiFetch('/api/conversations', { method: 'GET' }, { retryOnUnauthorized: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('DEMO_MODE=true: Inbox calls (conversations, messages, assignable users) never reach the network', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    jest.resetModules();
    const fetchMock = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./api') as typeof import('./api');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const demo = require('../demo/api') as typeof import('../demo/api');
    expect(demo.DEMO_MODE).toBe(true);

    await mod.apiFetch('/api/conversations', { method: 'GET' }, { retryOnUnauthorized: false });
    await mod.apiFetch('/api/conversations/demo-conv-1/messages', { method: 'GET' }, { retryOnUnauthorized: false });
    await mod.apiFetch('/api/users/assignable', { method: 'GET' }, { retryOnUnauthorized: false });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
