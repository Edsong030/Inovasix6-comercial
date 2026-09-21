import { Logger } from '@nestjs/common';
import { ConversationChannel } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AppConfigService } from '../../../config/app-config.service';
import { WhatsAppCloudAccount } from '../../../config/whatsapp-cloud';
import { OutboundDeliveryError, OutboundSendInput } from '../../delivery/outbound-channel-adapter';
import { WhatsAppAccountResolver } from '../whatsapp-account.resolver';
import { FetchLike, WhatsAppCloudAdapter } from './whatsapp-cloud.adapter';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const TOKEN_A = `EAAG${randomBytes(30).toString('hex')}`;
const TOKEN_B = `EAAG${randomBytes(30).toString('hex')}`;
const PHONE_ID_A = '100000000000001';
const PHONE_ID_B = '200000000000002';
const RECIPIENT = '5541999990000';
const BSUID = 'US.13491208655302741918';
const BODY = 'Texto sigiloso do cliente';
const WAMID = 'wamid.HBgLNTU0MTk5OTk5MDAwMBUCABEYEjEyMzQ1Njc4OQA=';

const json = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const accepted = (id: string = WAMID) => json(200, { messaging_product: 'whatsapp', contacts: [{ input: RECIPIENT, wa_id: RECIPIENT }], messages: [{ id }] });
const graphError = (status: number, code: number) => json(status, { error: { message: `secret provider text about ${RECIPIENT}`, type: 'OAuthException', code, fbtrace_id: 'abc' } });

describe('WhatsAppCloudAdapter', () => {
  const logs: unknown[] = [];
  let settings: { enabled: boolean; graphApiVersion: string; graphApiBaseUrl: string; httpTimeoutMs: number; accounts: WhatsAppCloudAccount[] };
  let fetchMock: jest.Mock;
  let adapter: WhatsAppCloudAdapter;

  const input = (over: Partial<OutboundSendInput> = {}): OutboundSendInput => ({
    idempotencyKey: 'msg-1',
    tenantId: TENANT_A,
    conversationId: 'conv-1',
    channel: ConversationChannel.WHATSAPP,
    recipient: { externalContactId: RECIPIENT, externalConversationId: null },
    body: BODY,
    signal: new AbortController().signal,
    ...over,
  });
  const build = () => {
    const config = { get whatsappCloud() { return settings; } } as unknown as AppConfigService;
    adapter = new WhatsAppCloudAdapter(config, new WhatsAppAccountResolver(config), fetchMock as unknown as FetchLike);
  };
  const failure = async (over: Partial<OutboundSendInput> = {}) => adapter.send(input(over)).then(() => null, (error: unknown) => error as OutboundDeliveryError);
  const requestOf = (call = 0) => {
    const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit];
    return { url, init, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
  };

  beforeEach(() => {
    logs.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug'] as const) jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logs.push(args[0]));
    settings = {
      enabled: true,
      graphApiVersion: 'v25.0',
      graphApiBaseUrl: 'https://graph.facebook.com',
      httpTimeoutMs: 5_000,
      accounts: [new WhatsAppCloudAccount(TENANT_A, PHONE_ID_A, TOKEN_A), new WhatsAppCloudAccount(TENANT_B, PHONE_ID_B, TOKEN_B)],
    };
    fetchMock = jest.fn().mockImplementation(async () => accepted()); // a fresh Response per call: a body can be read once
    build();
  });

  afterEach(() => jest.restoreAllMocks());

  it('is the WHATSAPP channel adapter of the delivery engine', () => {
    expect(adapter.channel).toBe(ConversationChannel.WHATSAPP);
  });

  describe('the outbound request (Graph API, text message)', () => {
    it('POSTs {base}/{version}/{phone_number_id}/messages with a Bearer token and the documented text payload', async () => {
      await adapter.send(input());

      const { url, init, headers, body } = requestOf();
      expect(url).toBe(`https://graph.facebook.com/v25.0/${PHONE_ID_A}/messages`);
      expect(init.method).toBe('POST');
      expect(headers).toMatchObject({ Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' });
      expect(body).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: RECIPIENT, type: 'text', text: { body: BODY } });
    });

    it('sends text only: no template, media, buttons, or link preview', async () => {
      await adapter.send(input());

      const { body } = requestOf();
      expect(Object.keys(body).sort()).toEqual(['messaging_product', 'recipient_type', 'text', 'to', 'type']);
      expect(Object.keys(body.text)).toEqual(['body']);
    });

    it('never follows a redirect (it would resend the Authorization header to another host)', async () => {
      await adapter.send(input());

      expect(requestOf().init.redirect).toBe('error');
    });

    it('sends to a business-scoped user id in `recipient` (no `to`, no recipient_type) when the phone was never shown to us', async () => {
      await adapter.send(input({ recipient: { externalContactId: BSUID, externalConversationId: null } }));

      const { body } = requestOf();
      expect(body).toEqual({ messaging_product: 'whatsapp', recipient: BSUID, type: 'text', text: { body: BODY } });
      expect(body).not.toHaveProperty('to');
    });

    it('uses the configured Graph API version and base URL (nothing hardcoded)', async () => {
      settings.graphApiVersion = 'v26.0';
      settings.graphApiBaseUrl = 'http://127.0.0.1:4010';

      await adapter.send(input());

      expect(requestOf().url).toBe(`http://127.0.0.1:4010/v26.0/${PHONE_ID_A}/messages`);
    });

    it('carries the body byte for byte (unicode, newlines, quotes)', async () => {
      const text = 'Olá! "Tudo bem?"\nLinha 2 — çãõ ✓ 😀 \\o/';

      await adapter.send(input({ body: text }));

      expect(requestOf().body.text.body).toBe(text);
    });
  });

  describe('success', () => {
    it('returns the wamid Meta gave, to be stored as Message.externalId', async () => {
      await expect(adapter.send(input())).resolves.toEqual({ externalMessageId: WAMID });
    });

    it.each([
      ['not JSON', '<html>ok</html>'],
      ['an empty body', ''],
      ['no messages array', { messaging_product: 'whatsapp' }],
      ['an empty messages array', { messages: [] }],
      ['a message without id', { messages: [{}] }],
      ['a blank id', { messages: [{ id: '   ' }] }],
      ['a non-string id', { messages: [{ id: 42 }] }],
      ['an oversized id', { messages: [{ id: 'w'.repeat(513) }] }],
    ])('a 200 with %s is a permanent WA_INVALID_RESPONSE (whether Meta accepted it is unknowable; resending to a customer is worse)', async (_name, body) => {
      fetchMock.mockResolvedValue(json(200, body));

      const error = await failure();

      expect(error).toMatchObject({ kind: 'permanent', code: 'WA_INVALID_RESPONSE' });
    });
  });

  describe('failures, classified for the delivery engine\'s retry policy', () => {
    it.each([
      [429, 130429, 'temporary'],
      [429, 131056, 'temporary'],
      [503, 2, 'temporary'],
      [500, 131000, 'temporary'],
      [400, 100, 'permanent'],
      [401, 190, 'permanent'],
      [403, 131047, 'permanent'],
      [400, 131026, 'permanent'],
      [400, 131062, 'permanent'],
    ])('HTTP %i, Meta code %i -> %s', async (status, code, kind) => {
      fetchMock.mockResolvedValue(graphError(status, code));

      expect(await failure()).toMatchObject({ kind, code: `WA_${code}` });
    });

    it.each([
      [502, '<html>Bad Gateway</html>', 'temporary'],
      [503, '', 'temporary'],
      [500, 'not json', 'temporary'],
      [429, '{}', 'temporary'],
      [404, '{"error":{}}', 'permanent'],
      [400, '<html>', 'permanent'],
    ])('HTTP %i with a non-Meta body (%p) falls back on the status -> %s', async (status, body, kind) => {
      fetchMock.mockResolvedValue(json(status, body));

      expect(await failure()).toMatchObject({ kind, code: `WA_HTTP_${status}` });
    });

    it('the error carries only a code: no provider text, recipient, body or token', async () => {
      fetchMock.mockResolvedValue(graphError(400, 131009));

      const error = (await failure()) as OutboundDeliveryError;

      expect(error).toBeInstanceOf(OutboundDeliveryError);
      expect(error.message).toBe('WA_131009');
      expect(JSON.stringify({ message: error.message, stack: error.stack?.split('\n')[0], code: error.code })).not.toMatch(new RegExp(`${RECIPIENT}|secret provider|${TOKEN_A}`));
    });

    it('a network failure is temporary WA_NETWORK, and the library message (which may hold the URL/headers) is dropped', async () => {
      fetchMock.mockRejectedValue(new TypeError(`fetch failed: ECONNRESET talking to graph.facebook.com with Bearer ${TOKEN_A}`));

      const error = (await failure()) as OutboundDeliveryError;

      expect(error).toMatchObject({ kind: 'temporary', code: 'WA_NETWORK' });
      expect(error.message).not.toContain(TOKEN_A);
    });

    it('its own timeout aborts the call and is temporary WA_TIMEOUT', async () => {
      settings.httpTimeoutMs = 40;
      fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));

      const started = Date.now();
      const error = await failure();

      expect(Date.now() - started).toBeLessThan(2_000);
      expect(error).toMatchObject({ kind: 'temporary', code: 'WA_TIMEOUT' });
    });

    it('every call is given an abort signal (there is no call without a timeout)', async () => {
      await adapter.send(input());

      const { init } = requestOf();
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect((init.signal as AbortSignal).aborted).toBe(false);
    });

    it('the engine aborting (its send timeout) cancels the HTTP call and is reported as TIMEOUT', async () => {
      const controller = new AbortController();
      fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));

      const pending = failure({ signal: controller.signal });
      controller.abort();

      expect(await pending).toMatchObject({ kind: 'temporary', code: 'TIMEOUT' });
    });

    it('a response body that is never fully delivered is bounded by the same timeout', async () => {
      settings.httpTimeoutMs = 40;
      fetchMock.mockImplementation((_url: string, init: RequestInit) => {
        const slow = { ok: true, status: 200, text: () => new Promise<string>((_r, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) };
        return Promise.resolve(slow);
      });

      expect(await failure()).toMatchObject({ kind: 'temporary', code: 'WA_TIMEOUT' });
    });

    it('a huge response body is not trusted', async () => {
      fetchMock.mockResolvedValue(json(200, `{"messages":[{"id":"${'x'.repeat(2_000_000)}"}]}`));

      expect(await failure()).toMatchObject({ kind: 'permanent', code: 'WA_INVALID_RESPONSE' });
    });
  });

  describe('tenant and recipient (nothing is borrowed from another tenant)', () => {
    it('sends from the tenant\'s OWN phone number with the tenant\'s OWN token', async () => {
      await adapter.send(input({ tenantId: TENANT_A }));
      await adapter.send(input({ tenantId: TENANT_B }));

      const a = requestOf(0);
      const b = requestOf(1);
      expect(a.url).toContain(`/${PHONE_ID_A}/`);
      expect(a.headers.Authorization).toBe(`Bearer ${TOKEN_A}`);
      expect(b.url).toContain(`/${PHONE_ID_B}/`);
      expect(b.headers.Authorization).toBe(`Bearer ${TOKEN_B}`);
      expect(JSON.stringify(a)).not.toContain(TOKEN_B);
      expect(JSON.stringify(b)).not.toContain(TOKEN_A);
    });

    it('a tenant with no WhatsApp configured fails permanently and calls nothing: it never falls back to another tenant\'s number', async () => {
      const error = await failure({ tenantId: randomUUID() });

      expect(error).toMatchObject({ kind: 'permanent', code: 'WA_NOT_CONFIGURED' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('with no accounts at all nothing is sent', async () => {
      settings.accounts = [];

      expect(await failure()).toMatchObject({ kind: 'permanent', code: 'WA_NOT_CONFIGURED' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('goes only to the recipient the engine resolved from the conversation, in the right field', async () => {
      await adapter.send(input({ recipient: { externalContactId: '5511777770000', externalConversationId: 'thread-9' } }));

      const { body } = requestOf();
      expect(body.to).toBe('5511777770000');
      expect(JSON.stringify(body)).not.toContain(RECIPIENT);
      expect(JSON.stringify(body)).not.toContain('thread-9');
    });

    it.each([[''], ['   '], ['+5541999990000'], ['5541 99999 0000'], ['ana@example.com'], ['us.13491208655302741918'], ['US.'], ['US.ENT.1181'], ['12'], ['1'.repeat(30)], [`${RECIPIENT}\n{"x":1}`]])('refuses the recipient %p without calling Meta', async (externalContactId) => {
      const error = await failure({ recipient: { externalContactId, externalConversationId: null } });

      expect(error).toMatchObject({ kind: 'permanent', code: 'WA_INVALID_RECIPIENT' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('logs', () => {
    it('log ids, status, duration and a numeric code; never the token, recipient, body or provider text', async () => {
      fetchMock.mockResolvedValueOnce(accepted()).mockResolvedValueOnce(graphError(400, 131009)).mockRejectedValueOnce(new Error(`socket ${TOKEN_A} ${RECIPIENT} ${BODY}`));

      await adapter.send(input());
      await failure();
      await failure();

      const lines = logs.filter((l) => (l as { event?: string })?.event === 'whatsapp.send');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatchObject({ tenantId: TENANT_A, phoneNumberId: PHONE_ID_A, messageId: 'msg-1', httpStatus: 200 });
      expect(lines[1]).toMatchObject({ httpStatus: 400, code: 'WA_131009' });
      expect(lines[2]).toMatchObject({ code: 'WA_NETWORK' });
      const everything = JSON.stringify(logs);
      for (const secret of [TOKEN_A, TOKEN_B, RECIPIENT, BODY, 'secret provider text']) expect(everything).not.toContain(secret);
    });
  });
});
