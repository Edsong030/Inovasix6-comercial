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
