import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConversationChannel, PrismaClient } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { Agent } from 'node:http';
import * as request from 'supertest';
import { createGlobalValidationPipe } from '../src/common/http/global-validation.pipe';
import { DEFAULT_FIRST_CONTACT_MESSAGE } from '../src/config/first-contact';
import { FakeOutboundChannelAdapter } from '../src/modules/delivery/fake-outbound-channel.adapter';
import { OUTBOUND_CHANNEL_ADAPTERS } from '../src/modules/delivery/outbound-adapter.registry';
import { OutboundDispatcherService } from '../src/modules/delivery/outbound-dispatcher.service';
import { OutboundWorker } from '../src/modules/delivery/outbound-worker.service';
import { makeOwnerClient, runWithTenant } from './rls.helper';

/**
 * The delivery engine over REAL HTTP: an inbound event creates the automatic
 * reply, the dispatcher delivers it through a fake adapter (no network), the
 * Inbox endpoints show the resulting status, a human takes over through the
 * existing endpoints and their message goes out through the SAME engine.
 *
 * The polling worker is OFF here (its default): delivery is driven explicitly
 * so every step is deterministic. Boot-time behaviour of the worker is checked
 * in outbound-worker.e2e-spec.ts.
 */
const tenantA = randomUUID();
const tenantB = randomUUID();
const userA = randomUUID();
const cred = (tenantId: string, keyId: string, channel: string) => ({ keyId, tenantId, channel, secret: randomBytes(32).toString('hex') });
const credWa = cred(tenantA, 'ob-a-whatsapp', 'WHATSAPP');
const credIg = cred(tenantA, 'ob-a-instagram', 'INSTAGRAM');
const credB = cred(tenantB, 'ob-b-whatsapp', 'WHATSAPP');
const basic = (c: { keyId: string; secret: string }) => `Basic ${Buffer.from(`${c.keyId}:${c.secret}`).toString('base64')}`;

let AppModule: typeof import('../src/app.module').AppModule;

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.INBOUND_SERVICE_CREDENTIALS = JSON.stringify([credWa, credIg, credB]);
  delete process.env.FIRST_CONTACT_MESSAGE;
  delete process.env.OUTBOUND_WORKER_ENABLED; // the default: off
  ({ AppModule } = await import('../src/app.module'));
});

describe('outbound delivery (HTTP, real Postgres, fake adapter)', () => {
  let app: INestApplication;
  let owner: PrismaClient;
  let dispatcher: OutboundDispatcherService;
  let url: string;
  let userToken: string;
  // WHATSAPP has a fake provider; INSTAGRAM deliberately has none.
  const whatsapp = new FakeOutboundChannelAdapter(ConversationChannel.WHATSAPP);

  const keepAlive = new Agent({ keepAlive: true, maxSockets: 16 });
  const inbound = (c: { keyId: string; secret: string }, body: Record<string, unknown>) =>
    request(url).post('/api/conversations/inbound').agent(keepAlive).set('Authorization', basic(c)).send(body);
  const asUser = (method: 'get' | 'post' | 'patch', path: string) => request(url)[method](path).agent(keepAlive).set('Authorization', `Bearer ${userToken}`);
  const event = (over: Record<string, unknown> = {}) => ({ externalContactId: 'wa-1', externalMessageId: `m-${randomUUID()}`, content: 'Oi', ...over });
  const run = <T = any>(tenantId: string, work: (tx: any) => Promise<T>): Promise<T> => runWithTenant(owner, tenantId, work);
  const history = async (conversationId: string) => (await asUser('get', `/api/conversations/${conversationId}/messages`).expect(200)).body.items as any[];

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
      [tenantA, 'outbound-e2e-a'],
      [tenantB, 'outbound-e2e-b'],
    ]) {
      await run(id, async (tx) => {
        await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${id}::uuid,${slug},${`${slug}-${id.slice(0, 8)}`},'America/Sao_Paulo',now(),now())`;
      });
    }
    await run(tenantA, async (tx) => {
      await tx.$executeRaw`INSERT INTO users (id,tenant_id,email,name,password_hash,status,created_at,updated_at) VALUES (${userA}::uuid,${tenantA}::uuid,'agent@outbound-e2e.test','Ana Atendente','x','ACTIVE',now(),now())`;
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OUTBOUND_CHANNEL_ADAPTERS)
      .useValue([whatsapp])
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
    dispatcher = app.get(OutboundDispatcherService);

    const { TokenService } = await import('../src/modules/auth/token.service');
    userToken = await app.get(TokenService).signAccessToken({ sub: userA, tenantId: tenantA, roleCodes: ['ADMIN'], sessionId: randomUUID() });
  });

  beforeEach(() => {
    whatsapp.calls.length = 0;
    whatsapp.accepted.length = 0;
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

  it('the business result: "Oi" -> INBOUND -> automatic OUTBOUND/PENDING -> engine -> adapter -> SENT; then a human continues through the same engine', async () => {
    // Client says "Oi"
    const first = await inbound(credWa, event({ externalContactId: 'wa-oi', content: 'Oi' })).expect(201);
    const conversationId = first.body.conversationId;

    // INBOUND stored; automation created OUTBOUND / SYSTEM / PENDING; conversation waits for a human
    let thread = await history(conversationId);
    expect(thread.map((m) => [m.direction, m.senderType, m.status, m.externalId === null ? 'no-ext' : 'ext'])).toEqual([
      ['INBOUND', 'CUSTOMER', 'DELIVERED', 'ext'],
      ['OUTBOUND', 'SYSTEM', 'PENDING', 'no-ext'],
    ]);
    expect((await asUser('get', `/api/conversations/${conversationId}`).expect(200)).body).toMatchObject({ state: 'AGUARDANDO_HUMANO', assignedUserId: null });

    // Nothing is sent by itself (no worker running): the message waits for the engine
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(whatsapp.calls).toHaveLength(0);

    // The engine claims it, the fake adapter receives it, the message becomes SENT with the provider id
    const summary = await dispatcher.dispatchTenant(tenantA);
    expect(summary).toMatchObject({ claimed: 1, sent: 1 });
    expect(whatsapp.calls).toEqual([
      expect.objectContaining({ tenantId: tenantA, conversationId, channel: 'WHATSAPP', body: DEFAULT_FIRST_CONTACT_MESSAGE, recipient: { externalContactId: 'wa-oi', externalConversationId: null } }),
    ]);
    thread = await history(conversationId);
    expect(thread[1]).toMatchObject({ direction: 'OUTBOUND', senderType: 'SYSTEM', status: 'SENT', externalId: whatsapp.accepted[0].externalMessageId });
    expect((await asUser('get', `/api/conversations/${conversationId}`).expect(200)).body).toMatchObject({ state: 'AGUARDANDO_HUMANO', assignedUserId: null });

    // An agent takes over -> HUMANO_ATENDENDO
    await asUser('patch', `/api/conversations/${conversationId}/assign`).send({ userId: userA }).expect(200);

    // ...and continues the conversation through the SAME mechanism
    const sent = await asUser('post', `/api/conversations/${conversationId}/messages`).send({ body: 'Oi! Aqui é a Ana, como posso ajudar?' }).expect(201);
    expect(sent.body).toMatchObject({ direction: 'OUTBOUND', senderType: 'AGENT', senderUserId: userA, status: 'PENDING', externalId: null });
    expect(await dispatcher.dispatchTenant(tenantA)).toMatchObject({ claimed: 1, sent: 1 });

    thread = await history(conversationId);
    expect(thread.map((m) => [m.direction, m.senderType, m.status])).toEqual([
      ['INBOUND', 'CUSTOMER', 'DELIVERED'],
      ['OUTBOUND', 'SYSTEM', 'SENT'],
      ['OUTBOUND', 'AGENT', 'SENT'],
    ]);
    expect(thread[2].externalId).toBe(whatsapp.accepted[1].externalMessageId);
    expect(whatsapp.accepted.map((a) => a.body)).toEqual([DEFAULT_FIRST_CONTACT_MESSAGE, 'Oi! Aqui é a Ana, como posso ajudar?']);
    expect((await asUser('get', `/api/conversations/${conversationId}`).expect(200)).body).toMatchObject({ state: 'HUMANO_ATENDENDO', assignedUserId: userA });
  });

  it('delivering again, or a redelivery of the customer message, never sends anything twice or creates a second automatic reply', async () => {
    const body = event({ externalMessageId: 'wamid-dup' });
    const first = await inbound(credWa, body).expect(201);
    await dispatcher.dispatchTenant(tenantA);

    await inbound(credWa, body).expect(200); // duplicate
    await inbound(credWa, event({ content: 'Tem alguém aí?' })).expect(201); // later message, same conversation
    for (let i = 0; i < 3; i++) await dispatcher.dispatchTenant(tenantA);

    expect(whatsapp.accepted).toHaveLength(1);
    const thread = await history(first.body.conversationId);
    expect(thread.filter((m) => m.senderType === 'SYSTEM')).toHaveLength(1);
    expect(thread.filter((m) => m.senderType === 'SYSTEM')[0].status).toBe('SENT');
  });

  it('the Inbox contract holds while delivery moves messages: statuses change, order and shape do not', async () => {
    const first = await inbound(credWa, event({ content: 'Quero saber o preço', contact: { name: 'Ana Cliente' } })).expect(201);
    const shape = (m: any) => Object.keys(m).sort();
    const before = await history(first.body.conversationId);

    await dispatcher.dispatchTenant(tenantA);
    const after = await history(first.body.conversationId);

    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
    expect(after.map(shape)).toEqual(before.map(shape));
    expect(after.map((m) => m.body)).toEqual(before.map((m) => m.body));
    expect(after.map((m) => m.status)).toEqual(['DELIVERED', 'SENT']);
    const list = await asUser('get', '/api/conversations').expect(200);
    expect(list.body.items.find((c: any) => c.id === first.body.conversationId)).toMatchObject({ contactName: 'Ana Cliente', channel: 'WHATSAPP', state: 'AGUARDANDO_HUMANO' });
  });

  it('MANUAL keeps its behaviour: a message in a MANUAL conversation is SENT at once, never queued, and nothing is delivered', async () => {
    const conversationId = await run(tenantA, async (tx) => {
      const contact = await tx.contact.create({ data: { tenantId: tenantA, name: 'Contato interno' } });
      const conversation = await tx.conversation.create({ data: { tenantId: tenantA, contactId: contact.id, channel: 'MANUAL', state: 'HUMANO_ATENDENDO', assignedUserId: userA } });
      return conversation.id as string;
    });

    const sent = await asUser('post', `/api/conversations/${conversationId}/messages`).send({ body: 'Nota do atendente' }).expect(201);
    const summary = await dispatcher.dispatchTenant(tenantA);

    expect(sent.body).toMatchObject({ direction: 'OUTBOUND', senderType: 'AGENT', status: 'SENT' });
    expect(summary.claimed).toBe(0);
    expect(whatsapp.calls).toHaveLength(0);
    const stored = await run(tenantA, (tx) => tx.message.findUniqueOrThrow({ where: { id: sent.body.id } }));
    expect(stored).toMatchObject({ status: 'SENT', nextAttemptAt: null, deliveryAttempts: 0 });
  });

  it('a channel with no adapter registered (INSTAGRAM here) is left PENDING: not sent, not marked SENT, no attempt burnt', async () => {
    const first = await inbound(credIg, event({ externalContactId: 'ig-user-1' })).expect(201);

    for (let i = 0; i < 5; i++) expect((await dispatcher.dispatchTenant(tenantA)).claimed).toBe(0);

    const thread = await history(first.body.conversationId);
    expect(thread[1]).toMatchObject({ senderType: 'SYSTEM', status: 'PENDING', externalId: null });
    const stored = await run(tenantA, (tx) => tx.message.findUniqueOrThrow({ where: { id: thread[1].id } }));
    expect(stored).toMatchObject({ deliveryAttempts: 0, leaseToken: null });
    expect(stored.nextAttemptAt).not.toBeNull(); // still waiting in the queue for an adapter
    expect(whatsapp.calls).toHaveLength(0);
  });

  it('a failing provider is retried with a persisted backoff and the Inbox shows the message as PENDING meanwhile; a permanent failure shows FAILED', async () => {
    const first = await inbound(credWa, event()).expect(201);
    whatsapp.enqueue({ kind: 'temporary', code: 'UPSTREAM_5XX' });

    expect(await dispatcher.dispatchTenant(tenantA)).toMatchObject({ claimed: 1, retried: 1 });
    let thread = await history(first.body.conversationId);
    expect(thread[1]).toMatchObject({ status: 'PENDING', externalId: null });
    expect((await dispatcher.dispatchTenant(tenantA)).claimed).toBe(0); // backing off

    await run(tenantA, (tx) => tx.$executeRawUnsafe(`UPDATE messages SET next_attempt_at = now() - interval '1 second' WHERE id = '${thread[1].id}'::uuid`));
    whatsapp.enqueue({ kind: 'permanent', code: 'RECIPIENT_BLOCKED' });
    expect(await dispatcher.dispatchTenant(tenantA)).toMatchObject({ claimed: 1, failed: 1 });

    thread = await history(first.body.conversationId);
    expect(thread[1]).toMatchObject({ status: 'FAILED' });
    expect((await dispatcher.dispatchTenant(tenantA)).claimed).toBe(0);
    // the customer's conversation is unaffected: still waiting for a human
    expect((await asUser('get', `/api/conversations/${first.body.conversationId}`).expect(200)).body.state).toBe('AGUARDANDO_HUMANO');
  });

  it('tenants stay isolated end to end: each tenant\'s reply goes out only for its own conversation', async () => {
    const a = await inbound(credWa, event({ externalMessageId: 'shared-wamid', externalContactId: 'contact-a' })).expect(201);
    const b = await inbound(credB, event({ externalMessageId: 'shared-wamid', externalContactId: 'contact-b' })).expect(201);

    await dispatcher.dispatchTenant(tenantA);
    await dispatcher.dispatchTenant(tenantB);

    expect(whatsapp.calls.map((c) => [c.tenantId, c.conversationId, c.recipient.externalContactId]).sort()).toEqual(
      [
        [tenantA, a.body.conversationId, 'contact-a'],
        [tenantB, b.body.conversationId, 'contact-b'],
      ].sort(),
    );
    for (const [tenantId, conversationId] of [
      [tenantA, a.body.conversationId],
      [tenantB, b.body.conversationId],
    ]) {
      const rows = await run<any[]>(tenantId, (tx) => tx.message.findMany({ where: { tenantId, conversationId, direction: 'OUTBOUND' } }));
      expect(rows.map((m) => m.status)).toEqual(['SENT']);
    }
  });

  it('8 simultaneous first messages and two dispatchers at once: still exactly one reply, sent exactly once', async () => {
    const body = event({ externalMessageId: 'wamid-parallel' });
    const responses = await Promise.all(Array.from({ length: 8 }, () => inbound(credWa, body)));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);

    await Promise.all([dispatcher.dispatchTenant(tenantA), dispatcher.dispatchTenant(tenantA)]);

    expect(whatsapp.accepted).toHaveLength(1);
    expect((await history(responses[0].body.conversationId)).filter((m) => m.senderType === 'SYSTEM')).toHaveLength(1);
  });

  it('the public inbound response and its security are unchanged by the delivery engine', async () => {
    const res = await inbound(credWa, event()).expect(201);

    expect(Object.keys(res.body).sort()).toEqual(['contactCreated', 'contactId', 'conversationCreated', 'conversationId', 'duplicate', 'identityCreated', 'messageCreated', 'messageId']);
    await request(url).post('/api/conversations/inbound').agent(keepAlive).send(event()).expect(401);
    await inbound(credWa, { ...event(), tenantId: tenantB }).expect(400);
  });

  it('the worker does not exist as a running loop by default: nothing runs at boot', () => {
    expect(app.get(OutboundWorker).isRunning).toBe(false);
  });
});
