import { BadRequestException, INestApplication, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Agent, createServer, IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as request from 'supertest';
import { createGlobalValidationPipe } from '../src/common/http/global-validation.pipe';
import { DEFAULT_FIRST_CONTACT_MESSAGE } from '../src/config/first-contact';
import { makeOwnerClient, runWithTenant } from './rls.helper';

/**
 * WhatsApp Cloud API over REAL HTTP: the signed webhook (GET handshake and POST
 * notifications), the whole first-contact flow through the delivery engine to a
 * local stand-in for the Graph API, the status callbacks, the human handoff
 * through the existing Inbox endpoints, and the security rules. Real Postgres.
 * No internet: "Meta" is a local HTTP server the adapter's real fetch talks to.
 *
 * Every secret is generated at run time. The application is bootstrapped exactly
 * like main.ts does for the webhook (raw-body parser before init).
 */
const tenantA = randomUUID();
const tenantB = randomUUID();
const userA = randomUUID();
const PHONE_ID_A = '100000000000001';
const PHONE_ID_B = '200000000000002';
const APP_SECRET = randomBytes(16).toString('hex');
const VERIFY_TOKEN = randomBytes(16).toString('hex');
const TOKEN_A = `EAAG${randomBytes(30).toString('hex')}`;
const TOKEN_B = `EAAG${randomBytes(30).toString('hex')}`;
const WA_ID = '5541999990000';
const BUSINESS_NUMBER = '15550001111';
const stageDCred = { keyId: 'wa-e2e-inbound', tenantId: tenantA, channel: 'WHATSAPP', secret: randomBytes(32).toString('hex') };

let AppModule: typeof import('../src/app.module').AppModule;
let configureWhatsAppWebhookBodyParser: typeof import('../src/modules/whatsapp/webhook/whatsapp-webhook.http').configureWhatsAppWebhookBodyParser;

// ---- fake Meta (Graph API) ---------------------------------------------------
interface RecordedRequest {
  url: string;
  authorization: string | undefined;
  body: any;
}
let meta: Server;
let received: RecordedRequest[] = [];
let metaResponse: () => { status: number; body: unknown } = () => ({ status: 200, body: {} });
let sequence = 0;
const acceptAll = () => {
  metaResponse = () => ({ status: 200, body: { messaging_product: 'whatsapp', messages: [{ id: `wamid.OUT${++sequence}` }] } });
};

beforeAll(async () => {
  meta = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ url: req.url ?? '', authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
      const { status, body } = metaResponse();
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => meta.listen(0, '127.0.0.1', resolve));
  const { port } = meta.address() as AddressInfo;

  process.env.LOG_LEVEL = 'silent';
  process.env.INBOUND_SERVICE_CREDENTIALS = JSON.stringify([stageDCred]);
  delete process.env.FIRST_CONTACT_MESSAGE;
  delete process.env.OUTBOUND_WORKER_ENABLED; // delivery is driven explicitly, scoped to this test's tenants
  process.env.WHATSAPP_CLOUD_ENABLED = 'true';
  process.env.WHATSAPP_META_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
  process.env.WHATSAPP_GRAPH_API_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.WHATSAPP_HTTP_TIMEOUT_MS = '3000';
  process.env.WHATSAPP_CLOUD_ACCOUNTS = JSON.stringify([
    { tenantId: tenantA, phoneNumberId: PHONE_ID_A, accessToken: TOKEN_A },
    { tenantId: tenantB, phoneNumberId: PHONE_ID_B, accessToken: TOKEN_B },
  ]);
  ({ AppModule } = await import('../src/app.module'));
  ({ configureWhatsAppWebhookBodyParser } = await import('../src/modules/whatsapp/webhook/whatsapp-webhook.http'));
});

afterAll(async () => {
  await new Promise<void>((resolve) => meta.close(() => resolve()));
});

describe('WhatsApp Cloud API (HTTP, real Postgres, fake Meta)', () => {
  let app: INestApplication;
  let owner: PrismaClient;
  let url: string;
  let userToken: string;
  let dispatch: (tenantId: string) => Promise<{ claimed: number; sent: number; retried: number; failed: number }>;
  /** Every response body and header the API produced, to prove no secret ever leaves. */
  const wire: string[] = [];

  const keepAlive = new Agent({ keepAlive: true, maxSockets: 16 });
  const sign = (raw: string | Buffer, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const post = (raw: string | Buffer, headers: Record<string, string> = {}, path = '/api/webhooks/whatsapp') => {
    let req = request(url).post(path).agent(keepAlive).set('Content-Type', 'application/json');
    for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
    return req.send(typeof raw === 'string' ? raw : raw.toString('utf8')).then((res) => (wire.push(res.text, JSON.stringify(res.headers)), res));
  };
  /** A correctly signed notification. */
  const signed = (raw: string | Buffer, extra: Record<string, string> = {}) => post(raw, { 'X-Hub-Signature-256': sign(raw), ...extra });
  const get = (query: string) => request(url).get(`/api/webhooks/whatsapp?${query}`).agent(keepAlive).then((res) => (wire.push(res.text, JSON.stringify(res.headers)), res));
  const asUser = (method: 'get' | 'post' | 'patch', path: string) => request(url)[method](path).agent(keepAlive).set('Authorization', `Bearer ${userToken}`);

  const change = (phoneNumberId: string, value: Record<string, unknown>, field = 'messages') => ({
    field,
    value: { messaging_product: 'whatsapp', metadata: { display_phone_number: BUSINESS_NUMBER, phone_number_id: phoneNumberId }, ...value },
  });
  const notification = (...changes: unknown[]) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes }] });
  const incoming = (over: Record<string, unknown> = {}, phoneNumberId = PHONE_ID_A) =>
    notification(change(phoneNumberId, { contacts: [{ wa_id: WA_ID, profile: { name: 'Ana Cliente' } }], messages: [{ id: `wamid.IN.${randomUUID()}`, from: WA_ID, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Oi' }, ...over }] }));
  const statusOf = (id: string, status: string, over: Record<string, unknown> = {}) =>
    notification(change(PHONE_ID_A, { statuses: [{ id, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: WA_ID, ...over }] }));

  const run = <T = any>(tenantId: string, work: (tx: any) => Promise<T>): Promise<T> => runWithTenant(owner, tenantId, work);
  const messagesOf = (tenantId: string, where: object = {}) => run<any[]>(tenantId, (tx) => tx.message.findMany({ where: { tenantId, ...where }, orderBy: { createdAt: 'asc' } }));
  const autoReplies = (tenantId = tenantA) => messagesOf(tenantId, { direction: 'OUTBOUND', senderType: 'SYSTEM', senderUserId: null });
  const inbounds = (tenantId = tenantA) => messagesOf(tenantId, { direction: 'INBOUND' });
  const conversationOf = async (tenantId = tenantA) => (await run<any[]>(tenantId, (tx) => tx.conversation.findMany({ where: { tenantId } })))[0];
  const totalMessages = async () => (await messagesOf(tenantA)).length + (await messagesOf(tenantB)).length;

  async function wipe(tenantId: string) {
    await run(tenantId, async (tx) => {
      await tx.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM messages WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM contact_channel_identities WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${tenantId}::uuid`;
    });
  }

  beforeAll(async () => {
    owner = makeOwnerClient();
    for (const [id, slug] of [
      [tenantA, 'wa-e2e-a'],
      [tenantB, 'wa-e2e-b'],
    ]) {
      await run(id, async (tx) => {
        await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${id}::uuid,${slug},${`${slug}-${id.slice(0, 8)}`},'America/Sao_Paulo',now(),now())`;
      });
    }
    await run(tenantA, async (tx) => {
      await tx.$executeRaw`INSERT INTO users (id,tenant_id,email,name,password_hash,status,created_at,updated_at) VALUES (${userA}::uuid,${tenantA}::uuid,'agent@wa-e2e.test','Ana Atendente','x','ACTIVE',now(),now())`;
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(createGlobalValidationPipe());
    configureWhatsAppWebhookBodyParser(app, true); // as main.ts does, before init
    await app.init();
    await app.listen(0);
    url = await app.getUrl();

    const { OutboundDispatcherService } = await import('../src/modules/delivery/outbound-dispatcher.service');
    dispatch = (tenantId) => app.get(OutboundDispatcherService).dispatchTenant(tenantId);
    const { TokenService } = await import('../src/modules/auth/token.service');
    userToken = await app.get(TokenService).signAccessToken({ sub: userA, tenantId: tenantA, roleCodes: ['ADMIN'], sessionId: randomUUID() });
  });

  beforeEach(() => {
    received = [];
    sequence = 0;
    acceptAll();
    for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await wipe(tenantA);
    await wipe(tenantB);
  });

  afterAll(async () => {
    keepAlive.destroy();
    await app.close();
    for (const tenantId of [tenantA, tenantB]) {
      await wipe(tenantId);
      await run(tenantId, async (tx) => {
        await tx.$executeRaw`DELETE FROM users WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`;
      });
    }
    await owner.$disconnect();
  });

  // ---------------------------------------------------------------------------
  describe('GET /api/webhooks/whatsapp (Meta verification handshake)', () => {
    it('the right verify token gets the challenge back, as plain text, byte for byte', async () => {
      const res = await get(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`);

      expect(res.status).toBe(200);
      expect(res.text).toBe('1158201444');
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
    });

    it('a wrong verify token is refused (403) and the challenge is NOT echoed', async () => {
      const res = await get(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}x&hub.challenge=1158201444`);

      expect(res.status).toBe(403);
      expect(res.text).not.toContain('1158201444');
    });

    it.each([
      ['no parameters at all', ''],
      ['no token', 'hub.mode=subscribe&hub.challenge=123'],
      ['no challenge', `hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}`],
      ['no mode', `hub.verify_token=${VERIFY_TOKEN}&hub.challenge=123`],
      ['a mode other than subscribe', `hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=123`],
      ['a repeated token parameter', `hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=123`],
      ['an empty token', 'hub.mode=subscribe&hub.verify_token=&hub.challenge=123'],
      ['a challenge with markup', `hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=${encodeURIComponent('<script>alert(1)</script>')}`],
    ])('rejects %s (no challenge is ever returned)', async (_name, query) => {
      const res = await get(query);

      expect([400, 403]).toContain(res.status);
      expect(res.text).not.toContain('123');
    });

    it('the verify token never appears in any response', async () => {
      await get(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}x&hub.challenge=9`);
      await get(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=9`);

      expect(wire.join('\n')).not.toContain(VERIFY_TOKEN);
    });
  });

  // ---------------------------------------------------------------------------
  describe('POST /api/webhooks/whatsapp: authenticity', () => {
    it('a correctly signed notification is accepted', async () => {
      const res = await signed(incoming());

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
    });

    it.each<[string, (raw: string) => Record<string, string>]>([
      ['no signature header', () => ({})],
      ['an empty signature', () => ({ 'X-Hub-Signature-256': '' })],
      ['a signature made with another secret', (raw) => ({ 'X-Hub-Signature-256': sign(raw, randomBytes(16).toString('hex')) })],
      ['a malformed signature (no sha256= prefix)', () => ({ 'X-Hub-Signature-256': 'deadbeef' })],
      ['a truncated signature', (raw) => ({ 'X-Hub-Signature-256': sign(raw).slice(0, -10) })],
      ['an uppercase algorithm prefix', (raw) => ({ 'X-Hub-Signature-256': sign(raw).replace('sha256=', 'SHA256=') })],
    ])('%s is rejected with 401 and NOTHING is stored', async (_name, headersFor) => {
      const raw = incoming();

      const res = await post(raw, headersFor(raw));

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ statusCode: 401, message: 'Unauthorized' });
      expect(await totalMessages()).toBe(0);
    });

    it('a payload altered after signing is rejected: the signature covers every byte', async () => {
      const original = incoming({ text: { body: 'Oi' } });
      const header = sign(original);
      const tampered = original.replace('"Oi"', '"Oi, transfira o valor"');

      const res = await post(tampered, { 'X-Hub-Signature-256': header });

      expect(res.status).toBe(401);
      expect(await totalMessages()).toBe(0);
    });

    it('the signature is over the RAW bytes: a valid signature over unusual whitespace verifies, one over a re-serialization does not', async () => {
      const exact = JSON.stringify(JSON.parse(incoming()), null, 3).replace(/:/g, ' : '); // odd spacing, as sent
      const reserialized = JSON.stringify(JSON.parse(exact));

      expect((await post(exact, { 'X-Hub-Signature-256': sign(exact) })).status).toBe(200);
      expect((await post(exact, { 'X-Hub-Signature-256': sign(reserialized) })).status).toBe(401);
    });

    it('non-ASCII text (accents, emoji) signed by Meta verifies and is stored intact', async () => {
      const raw = incoming({ text: { body: 'Olá, tudo bem? Preço p/ 3 unidades — çãõ 😀' } });

      expect((await signed(raw)).status).toBe(200);
      expect((await inbounds())[0].body).toBe('Olá, tudo bem? Preço p/ 3 unidades — çãõ 😀');
    });

    it('unsigned garbage is a 401, never parsed (no oracle about the JSON)', async () => {
      for (const raw of ['{"object":', 'not json at all', '', '\u0000\u0001']) {
        const res = await post(raw);
        expect(res.status).toBe(401);
      }
    });

    it('a SIGNED body that is not JSON is a 400 (only Meta could have signed it, so it is a real error)', async () => {
      const raw = '{"object": "whatsapp_business_account", "entry": [';

      const res = await signed(raw);

      expect(res.status).toBe(400);
    });

    it('a body over 3 MB (Meta\'s documented maximum) is refused with 413 and no stack trace', async () => {
      const huge = 'a'.repeat(3 * 1024 * 1024 + 1);

      const res = await post(huge, { 'X-Hub-Signature-256': sign(huge) });

      expect(res.status).toBe(413);
      expect(res.body).toEqual({ statusCode: 413, message: 'Payload too large' });
      expect(res.text).not.toMatch(/node_modules|PayloadTooLargeError/);
    });

    it('a compressed body is refused (no decompression)', async () => {
      const raw = incoming();

      const res = await post(raw, { 'X-Hub-Signature-256': sign(raw), 'Content-Encoding': 'gzip' });

      expect(res.status).toBe(415);
      expect(await totalMessages()).toBe(0);
    });

    it('neither the app secret nor a token appears in any response the API produced', () => {
      const everything = wire.join('\n');

      for (const secret of [APP_SECRET, VERIFY_TOKEN, TOKEN_A, TOKEN_B]) expect(everything).not.toContain(secret);
    });
  });

  // ---------------------------------------------------------------------------
  describe('POST /api/webhooks/whatsapp: tenant resolution', () => {
    it('the tenant comes from the phone_number_id in configuration: two tenants are fully isolated', async () => {
      await signed(incoming({ id: 'wamid.IN.a' }, PHONE_ID_A));
      await signed(incoming({ id: 'wamid.IN.b' }, PHONE_ID_B));

      expect((await inbounds(tenantA)).map((m) => m.externalId)).toEqual(['wamid.IN.a']);
      expect((await inbounds(tenantB)).map((m) => m.externalId)).toEqual(['wamid.IN.b']);
      expect(await autoReplies(tenantA)).toHaveLength(1);
      expect(await autoReplies(tenantB)).toHaveLength(1);
    });

    it('an unknown phone_number_id is acknowledged (200) and creates nothing in any tenant', async () => {
      const res = await signed(incoming({}, '999999999999999'));

      expect(res.status).toBe(200);
      expect(await totalMessages()).toBe(0);
    });

    it('a tenant id in the body, the query string or a header cannot redirect the message to another tenant', async () => {
      const raw = JSON.parse(incoming());
      raw.tenantId = tenantB;
      raw.entry[0].tenantId = tenantB;
      raw.entry[0].changes[0].value.metadata.tenant_id = tenantB;
      const body = JSON.stringify(raw);

      const res = await request(url)
        .post(`/api/webhooks/whatsapp?tenantId=${tenantB}&tenant_id=${tenantB}`)
        .agent(keepAlive)
        .set('Content-Type', 'application/json')
        .set('X-Tenant-Id', tenantB)
        .set('X-Hub-Signature-256', sign(body))
        .send(body);

      expect(res.status).toBe(200);
      expect(await inbounds(tenantA)).toHaveLength(1);
      expect(await messagesOf(tenantB)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('the first contact, end to end over HTTP', () => {
    it('"Oi" -> INBOUND -> automatic OUTBOUND/PENDING -> engine -> Meta -> SENT with Meta\'s id; conversation AGUARDANDO_HUMANO', async () => {
      const res = await signed(incoming({ id: 'wamid.IN.oi', text: { body: 'Oi' } }));
      expect(res.status).toBe(200);

      expect((await inbounds())[0]).toMatchObject({ status: 'DELIVERED', externalId: 'wamid.IN.oi', body: 'Oi' });
      expect((await autoReplies())[0]).toMatchObject({ direction: 'OUTBOUND', senderType: 'SYSTEM', status: 'PENDING', body: DEFAULT_FIRST_CONTACT_MESSAGE });
      expect(await conversationOf()).toMatchObject({ channel: 'WHATSAPP', state: 'AGUARDANDO_HUMANO', assignedUserId: null });
      expect(received).toHaveLength(0); // the ACK did not wait for, nor call, Meta

      expect(await dispatch(tenantA)).toMatchObject({ claimed: 1, sent: 1 });

      expect(received).toEqual([
        { url: `/v25.0/${PHONE_ID_A}/messages`, authorization: `Bearer ${TOKEN_A}`, body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: WA_ID, type: 'text', text: { body: DEFAULT_FIRST_CONTACT_MESSAGE } } },
      ]);
      expect((await autoReplies())[0]).toMatchObject({ status: 'SENT', externalId: 'wamid.OUT1' });
      expect(await conversationOf()).toMatchObject({ state: 'AGUARDANDO_HUMANO', assignedUserId: null });
    });

    it.each(['Oi', 'Bom dia', 'Quero informações', 'Quanto custa?', 'Preciso de orçamento'])('%p is enough: any first text gets the same single reply', async (text) => {
      await signed(incoming({ text: { body: text } }));

      expect(await autoReplies()).toHaveLength(1);
      await wipe(tenantA);
    });

    it('the Inbox (existing endpoints) shows the conversation, then the message statuses moving forward', async () => {
      const res = await signed(incoming({ text: { body: 'Preciso falar com alguém' } }));
      expect(res.status).toBe(200);
      const { id: conversationId } = await conversationOf();
      await dispatch(tenantA);

      let history = (await asUser('get', `/api/conversations/${conversationId}/messages`).expect(200)).body.items;
      expect(history.map((m: any) => [m.direction, m.senderType, m.status])).toEqual([
        ['INBOUND', 'CUSTOMER', 'DELIVERED'],
        ['OUTBOUND', 'SYSTEM', 'SENT'],
      ]);
      expect(history[1].externalId).toBe('wamid.OUT1');

      await signed(statusOf('wamid.OUT1', 'read'));

      history = (await asUser('get', `/api/conversations/${conversationId}/messages`).expect(200)).body.items;
      expect(history[1].status).toBe('READ');
      const list = (await asUser('get', '/api/conversations').expect(200)).body.items;
      expect(list.find((c: any) => c.id === conversationId)).toMatchObject({ channel: 'WHATSAPP', state: 'AGUARDANDO_HUMANO' });
    });

    it('a person takes over through the existing endpoints and continues through the same engine; the automation stays out', async () => {
      await signed(incoming());
      const { id: conversationId } = await conversationOf();
      await dispatch(tenantA);
      received.length = 0;

      const assigned = await asUser('patch', `/api/conversations/${conversationId}/assign`).send({ userId: userA }).expect(200);
      expect(assigned.body).toMatchObject({ state: 'HUMANO_ATENDENDO', assignedUserId: userA });
      const sent = await asUser('post', `/api/conversations/${conversationId}/messages`).send({ body: 'Oi! Aqui é a Ana.' }).expect(201);
      expect(sent.body).toMatchObject({ senderType: 'AGENT', status: 'PENDING' });
      await dispatch(tenantA);

      expect(received.map((r) => r.body.text.body)).toEqual(['Oi! Aqui é a Ana.']);
      expect((await messagesOf(tenantA, { id: sent.body.id }))[0]).toMatchObject({ status: 'SENT', externalId: 'wamid.OUT2' });

      await signed(incoming({ text: { body: 'Quero um orçamento' } }));
      await dispatch(tenantA);

      expect(await inbounds()).toHaveLength(2);
      expect(await autoReplies()).toHaveLength(1);
      expect(received).toHaveLength(1);
      expect(await conversationOf()).toMatchObject({ state: 'HUMANO_ATENDENDO', assignedUserId: userA });
    });

    it('Meta down: the customer\'s message is kept, the API still acknowledges with 200, and the reply is retried later', async () => {
      metaResponse = () => ({ status: 503, body: { error: { code: 2, message: 'down' } } });

      expect((await signed(incoming())).status).toBe(200);
      expect(await dispatch(tenantA)).toMatchObject({ claimed: 1, retried: 1 });

      expect(await inbounds()).toHaveLength(1);
      expect((await autoReplies())[0]).toMatchObject({ status: 'PENDING', deliveryAttempts: 1, lastErrorCode: 'WA_2' });
    });
  });

  // ---------------------------------------------------------------------------
  describe('Meta redelivers and races', () => {
    it('the same event 10 times: 200 every time, exactly 1 INBOUND, 1 automatic reply and 1 send', async () => {
      const raw = incoming({ id: 'wamid.IN.dup' });

      for (let i = 0; i < 10; i++) expect((await signed(raw)).status).toBe(200);
      await dispatch(tenantA);
      await dispatch(tenantA);

      expect(await inbounds()).toHaveLength(1);
      expect(await autoReplies()).toHaveLength(1);
      expect(received).toHaveLength(1);
    });

    it('the same event in 8 simultaneous requests: 200 for all, one of each, one send', async () => {
      const raw = incoming({ id: 'wamid.IN.race' });

      const responses = await Promise.all(Array.from({ length: 8 }, () => signed(raw)));
      await Promise.all([dispatch(tenantA), dispatch(tenantA)]);

      expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect(await inbounds()).toHaveLength(1);
      expect(await autoReplies()).toHaveLength(1);
      expect(received).toHaveLength(1);
    });

    it('a transient failure answers 503 (Meta redelivers), the redelivery then succeeds, and nothing is duplicated', async () => {
      const { ConversationIntakeService } = await import('../src/modules/conversations/conversation-intake.service');
      const receive = jest.spyOn(app.get(ConversationIntakeService), 'receive').mockRejectedValueOnce(new Error('database unavailable'));
      const raw = incoming({ id: 'wamid.IN.retry' });

      const first = await signed(raw);
      const second = await signed(raw);

      expect(first.status).toBe(503);
      expect(second.status).toBe(200);
      expect(receive).toHaveBeenCalledTimes(2);
      expect(await inbounds()).toHaveLength(1);
      expect(await autoReplies()).toHaveLength(1);
    });

    it('a problem the data itself causes is acknowledged (200), not retried for 7 days', async () => {
      const { ConversationIntakeService } = await import('../src/modules/conversations/conversation-intake.service');
      jest.spyOn(app.get(ConversationIntakeService), 'receive').mockRejectedValue(new BadRequestException('bad'));

      const res = await signed(incoming());

      expect(res.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  describe('status callbacks over HTTP', () => {
    it('delivered, then read, then late duplicates and out-of-order callbacks: only ever forward', async () => {
      await signed(incoming());
      await dispatch(tenantA);

      await signed(statusOf('wamid.OUT1', 'sent'));
      expect((await autoReplies())[0].status).toBe('SENT');
      await signed(statusOf('wamid.OUT1', 'delivered'));
      expect((await autoReplies())[0].status).toBe('DELIVERED');
      await signed(statusOf('wamid.OUT1', 'read'));
      expect((await autoReplies())[0].status).toBe('READ');
      await signed(statusOf('wamid.OUT1', 'delivered')); // out of order
      await signed(statusOf('wamid.OUT1', 'sent')); // out of order
      await signed(statusOf('wamid.OUT1', 'read')); // duplicate
      expect((await autoReplies())[0].status).toBe('READ');
    });

    it('READ arriving before DELIVERED still ends READ', async () => {
      await signed(incoming());
      await dispatch(tenantA);

      await signed(statusOf('wamid.OUT1', 'read'));
      await signed(statusOf('wamid.OUT1', 'delivered'));

      expect((await autoReplies())[0].status).toBe('READ');
    });

    it('failed keeps only the numeric code', async () => {
      await signed(incoming());
      await dispatch(tenantA);

      await signed(statusOf('wamid.OUT1', 'failed', { errors: [{ code: 131026, title: 'Undeliverable', message: `to ${WA_ID}` }] }));

      expect((await autoReplies())[0]).toMatchObject({ status: 'FAILED', lastErrorCode: 'WA_131026' });
    });

    it('a callback for an unknown message is acknowledged and changes nothing', async () => {
      await signed(incoming());

      expect((await signed(statusOf('wamid.NOBODY', 'read'))).status).toBe(200);
      expect((await autoReplies())[0].status).toBe('PENDING');
    });

    it('an unsigned status callback is rejected and changes nothing', async () => {
      await signed(incoming());
      await dispatch(tenantA);

      expect((await post(statusOf('wamid.OUT1', 'read'))).status).toBe(401);
      expect((await autoReplies())[0].status).toBe('SENT');
    });
  });

  // ---------------------------------------------------------------------------
  describe('events that are acknowledged and ignored', () => {
    it.each(['image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts', 'reaction'])('a %s message: 200, nothing stored, no reply', async (type) => {
      const res = await signed(incoming({ type, text: undefined, [type]: { id: 'x' } }));

      expect(res.status).toBe(200);
      expect(await totalMessages()).toBe(0);
      expect(received).toHaveLength(0);
    });

    it.each(['image', 'audio', 'video'])('a %s message with a text body is still ignored (the type decides)', async (type) => {
      const res = await signed(incoming({ type, text: { body: 'legenda' } }));

      expect(res.status).toBe(200);
      expect(await totalMessages()).toBe(0);
    });

    it('business-app echoes (smb_message_echoes) are never processed: no loop is possible', async () => {
      const raw = notification(change(PHONE_ID_A, { messages: [{ id: 'wamid.ECHO', from: '5511955550000', type: 'text', text: { body: 'enviado pelo app' } }] }, 'smb_message_echoes')); // a customer-like sender: only the field rule can stop it

      expect((await signed(raw)).status).toBe(200);
      expect(await totalMessages()).toBe(0);
    });

    it('other webhook fields and non-WhatsApp objects are acknowledged too', async () => {
      expect((await signed(notification(change(PHONE_ID_A, {}, 'message_template_status_update')))).status).toBe(200);
      expect((await signed('{"object":"instagram","entry":[]}')).status).toBe(200);
      expect(await totalMessages()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('regression: nothing else changed', () => {
    it('the Stage D inbound endpoint still works next to the webhook (same conversation model, same automatic reply)', async () => {
      const basic = `Basic ${Buffer.from(`${stageDCred.keyId}:${stageDCred.secret}`).toString('base64')}`;

      const res = await request(url).post('/api/conversations/inbound').agent(keepAlive).set('Authorization', basic).send({ externalContactId: '5511977770000', externalMessageId: 'stage-d-1', content: 'Oi' });

      expect(res.status).toBe(201);
      expect(await autoReplies()).toHaveLength(1);
    });

    it('other endpoints keep their own (default) JSON body limit and parser', async () => {
      const basic = `Basic ${Buffer.from(`${stageDCred.keyId}:${stageDCred.secret}`).toString('base64')}`;
      const tooBigForDefault = { externalContactId: 'x', externalMessageId: 'y', content: 'a'.repeat(200_000) };

      const res = await request(url).post('/api/conversations/inbound').agent(keepAlive).set('Authorization', basic).send(tooBigForDefault);

      expect(res.status).toBe(413); // the webhook's 3 MB allowance does not leak to other routes
    });

    it('the webhook is documented in Swagger without any secret', async () => {
      const { SwaggerModule: Swagger } = { SwaggerModule };
      const document = Swagger.createDocument(app, new DocumentBuilder().setTitle('t').build());

      const paths = document.paths['/api/webhooks/whatsapp'];
      expect(Object.keys(paths).sort()).toEqual(['get', 'post']);
      expect(JSON.stringify(document)).not.toMatch(new RegExp(`${APP_SECRET}|${VERIFY_TOKEN}|${TOKEN_A}|${TOKEN_B}`));
      expect(JSON.stringify(paths.post)).toContain('X-Hub-Signature-256');
    });
  });
});
